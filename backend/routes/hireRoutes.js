// Atyant Hire: a startup posts a JD, shares one link, and every candidate who
// opens it takes the AI screening interview. Results land on the founder's
// dashboard, ranked.
//
//   Founder (JWT)                       Candidate (no account, access token)
//   GET    /me                          GET  /p/:slug              job page
//   PUT    /company                     POST /p/:slug/apply        → { token }
//   POST   /jobs                        GET  /a/:token             status
//   GET    /jobs                        POST /a/:token/prepare     retry failed prep
//   GET    /jobs/:id                    POST /a/:token/join        LiveKit token
//   PATCH  /jobs/:id                    POST /a/:token/integrity   tab switch etc.
//   DELETE /jobs/:id
//   POST   /jobs/:id/publish
//   GET    /jobs/:id/applications
//   GET    /jobs/:id/export.csv
//   GET    /applications/:id
//   PATCH  /applications/:id
//   DELETE /applications/:id
import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/authMiddleware.js';
import User from '../models/User.js';
import HireCompany from '../models/HireCompany.js';
import HireJob from '../models/HireJob.js';
import HireApplication from '../models/HireApplication.js';
import MockInterview from '../models/MockInterview.js';
import liveKitService from '../services/LiveKitService.js';
import { MOCK_AGENT_NAME, mockRoomName, hireParticipantIdentity } from '../services/mockInterview/liveConfig.js';
import { pdfToText, normalizeDocText } from '../services/mockInterview/documentText.js';
import { makeSlug, prepareJob, expandMustAsk, openCandidateInterview, runCandidatePrep, MAX_MUST_ASK } from '../services/hire/HireJobService.js';
import { publicJobLink } from '../services/hire/HireNotify.js';
import { startVoicing, deleteAudioFolders } from '../services/voice/VoiceService.js';

const router = express.Router();

const MIN_JD_CHARS     = 200;
const MIN_RESUME_CHARS = 300;
const MAX_JOBS_PER_DAY = Number(process.env.HIRE_JOBS_PER_DAY) || 10;
// Live interviews across Atyant (mock + hiring) that may run at once. Groq
// TTS/STT/LLM quotas are shared by every session, so this is a global cap.
const MAX_CONCURRENT   = Number(process.env.HIRE_MAX_CONCURRENT) || 8;
const DISPATCH_RETRY_MS = 60 * 1000;
const MAX_PREP_ATTEMPTS = 3;
const STUCK_PREP_MS    = 5 * 60 * 1000;
const PREP_STATUSES    = ['draft', 'parsing', 'planning', 'voicing'];
const RETRYABLE_FAILURE = /^(parse|plan|voice):/;
const CATEGORIES = ['tech', 'analytics', 'core', 'business', 'product', 'hr'];
const MIN_DURATION = 5, MAX_DURATION = 15;
const MIN_QUESTIONS = 3, MAX_QUESTIONS = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    req.rejectedFile = file.fieldname;
    cb(null, false);
  },
});
const single = field => (req, res, next) => upload.single(field)(req, res, err => {
  if (err) return res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'The file must be under 5 MB' : err.message });
  if (req.rejectedFile) return res.status(400).json({ ok: false, error: `${req.rejectedFile} must be a PDF` });
  next();
});

const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { ok: false, error: 'Too many applications from this network. Try again in an hour.' } });

const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
const oid = id => mongoose.isValidObjectId(id);
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function readPdf(file, label) {
  try {
    return await pdfToText(file.buffer);
  } catch {
    const err = new Error(`We couldn't open the ${label} PDF. It may be corrupted or password-protected.`);
    err.status = 400;
    throw err;
  }
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status && err.status < 500) return fail(res, err.status, err.message);
      console.error(`Hire ${req.method} ${req.path} error:`, err);
      fail(res, 500, 'Something went wrong. Please try again.');
    }
  };
}

// Founder routes are for startup accounts only; student and mentor accounts get
// NOT_STARTUP. A 'user' account that already created a company (before startup
// accounts existed) is moved to 'startup' the first time it comes back.
async function requireStartup(req, res, next) {
  try {
    const user = await User.findById(req.user.userId).select('role').lean();
    if (!user) return fail(res, 401, 'Account not found. Sign in again.');
    if (user.role === 'startup' || user.role === 'admin') return next();
    if (user.role === 'user' && await HireCompany.exists({ ownerUserId: req.user.userId })) {
      await User.updateOne({ _id: req.user.userId }, { $set: { role: 'startup' } });
      return next();
    }
    return fail(res, 403, 'This is a student or mentor account. Atyant Hire needs a separate startup account: sign up with your work email.', { code: 'NOT_STARTUP' });
  } catch (err) {
    console.error('Hire requireStartup error:', err);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

// Candidate-facing state, derived from the interview while it is in flight.
function applicationState(app, interview) {
  if (['completed', 'failed'].includes(app.status)) return app.status;
  switch (interview?.status) {
    case 'ready'     : return 'ready';
    case 'live'      : return 'in_progress';
    case 'evaluating':
    case 'completed' : return 'evaluating';
    case 'failed'    : return 'failed';
    default          : return 'applied';
  }
}

const badRequest = message => Object.assign(new Error(message), { status: 400 });
const given = v => v !== undefined && v !== null && v !== '';
const maxQuestionsFor = durationMin => Math.min(MAX_QUESTIONS, durationMin);
const defaultQuestionsFor = durationMin => Math.min(maxQuestionsFor(durationMin), Math.max(MIN_QUESTIONS, Math.round(durationMin * 2 / 3)));

// Founder-chosen interview length: 5-15 minutes and 3-10 questions (about a
// minute per question at least). Questions include the intro and must-ask
// ones; every must-ask leaves room for the intro and one generated question.
// Changing only the duration keeps the question count, trimmed to fit.
function interviewLength(body, current, mustAskCount) {
  const durationMin = given(body.durationMin) ? Math.round(Number(body.durationMin)) : current.durationMin;
  if (!(durationMin >= MIN_DURATION && durationMin <= MAX_DURATION)) {
    throw badRequest(`Interview length must be ${MIN_DURATION} to ${MAX_DURATION} minutes`);
  }
  const max = maxQuestionsFor(durationMin);
  let questionCount;
  if (given(body.questionCount)) {
    questionCount = Math.round(Number(body.questionCount));
    if (!(questionCount >= MIN_QUESTIONS && questionCount <= max)) {
      throw badRequest(`A ${durationMin}-minute interview can have ${MIN_QUESTIONS} to ${max} questions`);
    }
  } else {
    questionCount = Math.min(max, current.questionCount ?? defaultQuestionsFor(durationMin));
  }
  if (mustAskCount > questionCount - 2) {
    throw badRequest(`With ${questionCount} questions you can add up to ${Math.max(0, questionCount - 2)} must-ask questions`);
  }
  return { durationMin, questionCount };
}

function acceptingCandidates(job, company) {
  if (job.status !== 'live') return { ok: false, reason: 'This role is not accepting interviews right now.' };
  if (job.settings.deadline && job.settings.deadline < new Date()) return { ok: false, reason: 'Applications for this role have closed.' };
  if (job.stats.applied >= job.settings.maxCandidates) return { ok: false, reason: 'This role has reached its application limit.' };
  return { ok: true };
}

// ══ Founder ═════════════════════════════════════════════════════════════════

async function ownCompany(req) {
  return HireCompany.findOne({ ownerUserId: req.user.userId });
}

async function ownJob(req, res, select) {
  if (!oid(req.params.id)) { fail(res, 404, 'Job not found'); return null; }
  const query = HireJob.findOne({ _id: req.params.id, ownerUserId: req.user.userId });
  const job = await (select ? query.select(select) : query);
  if (!job) fail(res, 404, 'Job not found');
  return job;
}

const companyView = c => c && ({
  id: c._id, name: c.name, website: c.website, logoUrl: c.logoUrl, about: c.about, notifyPhone: c.notifyPhone
});

const jobView = j => ({
  id: j._id, title: j.title, slug: j.slug, status: j.status, link: publicJobLink(j.slug),
  interviewCategory: j.interviewCategory,
  failureReason: j.status === 'failed' ? "We couldn't read this job description. Edit it and try again." : null,
  skills: j.parsed?.jd ? {
    required  : j.parsed.jd.requiredSkills.map(s => s.name),
    niceToHave: j.parsed.jd.niceToHave.map(s => s.name)
  } : null,
  seniority: j.parsed?.seniority,
  settings: {
    mustAsk      : (j.settings.mustAsk || []).map(m => m.text),
    maxCandidates: j.settings.maxCandidates,
    deadline     : j.settings.deadline,
    requireCamera: j.settings.requireCamera,
    durationMin  : j.settings.durationMin ?? 15,
    questionCount: j.settings.questionCount ?? 10
  },
  stats: j.stats, publishedAt: j.publishedAt, createdAt: j.createdAt
});

// GET /api/hire/me
router.get('/me', protect, requireStartup, handle(async (req, res) => {
  const company = await ownCompany(req);
  res.json({ ok: true, company: companyView(company) });
}));

// PUT /api/hire/company   { name, website?, logoUrl?, about?, notifyPhone? }
router.put('/company', protect, requireStartup, express.json(), handle(async (req, res) => {
  const name = str(req.body.name, 120);
  if (!name) return fail(res, 400, 'Company name is required');
  const set = {
    name,
    website: str(req.body.website, 200),
    logoUrl: /^https:\/\//.test(req.body.logoUrl || '') ? str(req.body.logoUrl, 500) : '',
    about  : str(req.body.about, 1000),
    ...(typeof req.body.notifyPhone === 'boolean' ? { notifyPhone: req.body.notifyPhone } : {})
  };
  const company = await HireCompany.findOneAndUpdate(
    { ownerUserId: req.user.userId },
    { $set: set, $setOnInsert: { ownerUserId: req.user.userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true, company: companyView(company) });
}));

// POST /api/hire/jobs   multipart: title, jdText | jdFile, interviewCategory?,
// mustAsk (JSON array of up to 3 strings)?, maxCandidates?, deadline?, requireCamera?,
// durationMin (5-15, default 15)?, questionCount (3-10, default from duration)?
router.post('/jobs', protect, requireStartup, single('jdFile'), handle(async (req, res) => {
  const company = await ownCompany(req);
  if (!company) return fail(res, 409, 'Set up your company first');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (await HireJob.countDocuments({ ownerUserId: req.user.userId, createdAt: { $gte: since } }) >= MAX_JOBS_PER_DAY) {
    return fail(res, 429, `You can create up to ${MAX_JOBS_PER_DAY} jobs a day.`);
  }

  const title = str(req.body.title, 120);
  if (!title) return fail(res, 400, 'Job title is required');
  const jdText = req.file ? await readPdf(req.file, 'job description') : normalizeDocText(req.body.jdText);
  if (jdText.length < MIN_JD_CHARS) return fail(res, 400, 'The job description is too short. Paste the full JD or upload it as a PDF.');

  let mustAsk = [];
  try { mustAsk = JSON.parse(req.body.mustAsk || '[]'); } catch { return fail(res, 400, 'mustAsk must be a JSON array'); }
  if (!Array.isArray(mustAsk) || mustAsk.length > MAX_MUST_ASK) return fail(res, 400, `Add up to ${MAX_MUST_ASK} must-ask questions`);
  const mustAskCount = mustAsk.filter(t => str(t, 400)).length;
  const length = interviewLength(req.body, { durationMin: MAX_DURATION }, mustAskCount);

  const job = await HireJob.create({
    companyId: company._id,
    ownerUserId: req.user.userId,
    title,
    slug: makeSlug(title),
    jdText,
    interviewCategory: CATEGORIES.includes(req.body.interviewCategory) ? req.body.interviewCategory : null,
    settings: {
      maxCandidates: Math.min(5000, Math.max(1, Number(req.body.maxCandidates) || 200)),
      deadline     : req.body.deadline && !isNaN(Date.parse(req.body.deadline)) ? new Date(req.body.deadline) : null,
      requireCamera: req.body.requireCamera !== 'false',
      ...length
    }
  });
  prepareJob(job._id, mustAsk);
  res.status(201).json({ ok: true, job: jobView(job) });
}));

// GET /api/hire/jobs
router.get('/jobs', protect, requireStartup, handle(async (req, res) => {
  const jobs = await HireJob.find({ ownerUserId: req.user.userId })
    .select('-jdText -parsed.log -parsed.jd.companyContext')
    .sort({ createdAt: -1 }).limit(100);
  res.json({ ok: true, jobs: jobs.map(jobView) });
}));

// GET /api/hire/jobs/:id
router.get('/jobs/:id', protect, requireStartup, handle(async (req, res) => {
  const job = await ownJob(req, res);
  if (!job) return;
  res.json({ ok: true, job: { ...jobView(job), jdText: job.jdText } });
}));

// PATCH /api/hire/jobs/:id   { title?, status: live|paused|closed?, mustAsk?, maxCandidates?, deadline?, requireCamera?,
//                              durationMin?, questionCount? }
// Changes apply to candidates who apply after the change.
router.patch('/jobs/:id', protect, requireStartup, express.json(), handle(async (req, res) => {
  const job = await ownJob(req, res);
  if (!job) return;
  const b = req.body || {};

  if (b.title !== undefined) {
    const title = str(b.title, 120);
    if (!title) return fail(res, 400, 'Job title is required');
    job.title = title;
  }
  if (b.status !== undefined) {
    const allowed = { live: ['ready', 'paused'], paused: ['live'], closed: ['ready', 'live', 'paused', 'failed'] };
    if (!allowed[b.status]?.includes(job.status)) return fail(res, 409, `A ${job.status} job can't be set to ${b.status}`);
    job.status = b.status;
    if (b.status === 'live' && !job.publishedAt) job.publishedAt = new Date();
  }
  if (b.mustAsk !== undefined && (!Array.isArray(b.mustAsk) || b.mustAsk.length > MAX_MUST_ASK)) {
    return fail(res, 400, `Add up to ${MAX_MUST_ASK} must-ask questions`);
  }
  const nextMustAsk = b.mustAsk !== undefined ? b.mustAsk.map(t => str(t, 400)).filter(Boolean) : null;
  const length = interviewLength(b, {
    durationMin  : job.settings.durationMin ?? MAX_DURATION,
    questionCount: job.settings.questionCount ?? MAX_QUESTIONS
  }, nextMustAsk ? nextMustAsk.length : job.settings.mustAsk.length);
  job.settings.durationMin = length.durationMin;
  job.settings.questionCount = length.questionCount;

  if (nextMustAsk) {
    const current = job.settings.mustAsk.map(m => m.text);
    const next = nextMustAsk;
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      job.settings.mustAsk = await expandMustAsk(next, { role: job.title, seniority: job.parsed?.seniority });
    }
  }
  if (b.maxCandidates !== undefined) job.settings.maxCandidates = Math.min(5000, Math.max(1, Number(b.maxCandidates) || 1));
  if (b.deadline !== undefined) job.settings.deadline = b.deadline && !isNaN(Date.parse(b.deadline)) ? new Date(b.deadline) : null;
  if (typeof b.requireCamera === 'boolean') job.settings.requireCamera = b.requireCamera;

  await job.save();
  res.json({ ok: true, job: jobView(job) });
}));

// DELETE /api/hire/jobs/:id   removes the job, every candidate and their
// interviews and reports. The job is closed first so nobody new can join; if a
// candidate is mid-interview, the delete is refused until they finish.
router.delete('/jobs/:id', protect, requireStartup, handle(async (req, res) => {
  const job = await ownJob(req, res, '_id status');
  if (!job) return;
  if (job.status !== 'closed') await HireJob.updateOne({ _id: job._id }, { $set: { status: 'closed' } });

  const apps = await HireApplication.find({ jobId: job._id }).select('interviewId').lean();
  const interviewIds = apps.map(a => a.interviewId).filter(Boolean);
  if (await MockInterview.exists({ _id: { $in: interviewIds }, ...inInterviewNow() })) {
    return fail(res, 409, 'A candidate is in their interview right now. We closed the job so no one new can start. Delete it again once they finish.', { code: 'INTERVIEW_LIVE' });
  }
  const withAudio = await MockInterview.find({ _id: { $in: interviewIds }, 'voice.folder': { $nin: ['', null] } }).select('voice.folder').lean();
  await deleteAudioFolders(withAudio.map(iv => iv.voice.folder));
  await MockInterview.deleteMany({ _id: { $in: interviewIds }, mode: 'hiring' });
  await HireApplication.deleteMany({ jobId: job._id });
  await HireJob.deleteOne({ _id: job._id });
  res.json({ ok: true, deletedCandidates: apps.length });
}));

// POST /api/hire/jobs/:id/publish   ready → live
router.post('/jobs/:id/publish', protect, requireStartup, handle(async (req, res) => {
  const job = await ownJob(req, res);
  if (!job) return;
  if (job.status === 'parsing') return fail(res, 409, 'Still reading your job description. Try again in a minute.');
  if (job.status === 'failed') return fail(res, 409, "This job description couldn't be read. Create the job again with the full JD.");
  if (!['ready', 'paused'].includes(job.status)) return fail(res, 409, `Job is ${job.status}`);
  job.status = 'live';
  job.publishedAt = job.publishedAt || new Date();
  await job.save();
  res.json({ ok: true, job: jobView(job) });
}));

const listItem = (a, state) => ({
  id: a._id,
  name: a.candidate.name, email: a.candidate.email, phone: a.candidate.phone,
  status: state, decision: a.decision,
  overall: a.result?.overall ?? null, verdict: a.result?.verdict ?? null, coveragePct: a.result?.coveragePct ?? null,
  redFlags: a.result?.redFlags?.length || 0,
  integrity: a.integrity,
  appliedAt: a.createdAt, completedAt: a.result?.completedAt ?? null
});

async function withStates(apps) {
  const interviews = await MockInterview.find({ _id: { $in: apps.map(a => a.interviewId).filter(Boolean) } }).select('status').lean();
  const statusById = new Map(interviews.map(i => [String(i._id), i]));
  return apps.map(a => listItem(a, applicationState(a, statusById.get(String(a.interviewId)))));
}

// GET /api/hire/jobs/:id/applications?status=&decision=&sort=score|recent
// Completed candidates ranked by score first, then everyone still in progress.
router.get('/jobs/:id/applications', protect, requireStartup, handle(async (req, res) => {
  const job = await ownJob(req, res, '_id');
  if (!job) return;
  const filter = { jobId: job._id };
  if (['shortlisted', 'rejected'].includes(req.query.decision)) filter.decision = req.query.decision;
  if (req.query.decision === 'none') filter.decision = null;
  if (['completed', 'failed'].includes(req.query.status)) filter.status = req.query.status;
  const sort = req.query.sort === 'recent' ? { createdAt: -1 } : { 'result.overall': -1, createdAt: -1 };

  const apps = await HireApplication.find(filter).select('-tokenHash -result.skillFit -result.claims -result.nextRoundQuestions')
    .sort(sort).limit(1000).lean();
  const items = await withStates(apps);
  const ranked = items.filter(i => i.status === 'completed' && i.overall != null);
  ranked.forEach((i, idx) => { i.rank = idx + 1; i.percentile = Math.round(((ranked.length - idx) / ranked.length) * 100); });

  const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }), {});
  res.json({ ok: true, counts, applications: items });
}));

// GET /api/hire/jobs/:id/export.csv
router.get('/jobs/:id/export.csv', protect, requireStartup, handle(async (req, res) => {
  const job = await ownJob(req, res, '_id title slug');
  if (!job) return;
  const apps = await HireApplication.find({ jobId: job._id }).sort({ 'result.overall': -1, createdAt: -1 }).lean();
  const items = await withStates(apps);
  // Leading =, +, -, @ would run as a formula in Excel/Sheets.
  const cell = v => {
    const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Name', 'Email', 'Phone', 'Status', 'Score', 'Verdict', 'Questions reached %', 'Red flags', 'Tab switches', 'Decision', 'Summary', 'Applied at'];
  const rows = items.map((i, idx) => [
    i.name, i.email, i.phone, i.status, i.overall, i.verdict, i.coveragePct, i.redFlags,
    i.integrity?.tabSwitches ?? 0, i.decision, apps[idx].result?.summary, new Date(i.appliedAt).toISOString()
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${job.slug}-candidates.csv"`);
  res.send([header, ...rows].map(r => r.map(cell).join(',')).join('\n'));
}));

async function ownApplication(req, res) {
  if (!oid(req.params.id)) { fail(res, 404, 'Candidate not found'); return null; }
  const app = await HireApplication.findById(req.params.id).select('-tokenHash');
  if (!app) { fail(res, 404, 'Candidate not found'); return null; }
  const job = await HireJob.findOne({ _id: app.jobId, ownerUserId: req.user.userId }).select('title').lean();
  if (!job) { fail(res, 404, 'Candidate not found'); return null; }
  return { app, job };
}

// GET /api/hire/applications/:id   full founder report
router.get('/applications/:id', protect, requireStartup, handle(async (req, res) => {
  const owned = await ownApplication(req, res);
  if (!owned) return;
  const { app, job } = owned;
  const interview = app.interviewId
    ? await MockInterview.findById(app.interviewId).select('status seniority plan.questions turns evaluation.perAnswer evaluation.dimensions live').lean()
    : null;

  const evalByQid = new Map((interview?.evaluation?.perAnswer || []).map(a => [a.qid, a]));
  const questions = (interview?.plan?.questions || [])
    .filter(q => q.phase !== 'closing')
    .map(q => {
      const a = evalByQid.get(q.qid);
      const exchange = interview.turns.filter(t => t.qid === q.qid)
        .map(t => ({ interviewer: t.text, candidate: t.answer, followUp: t.kind === 'follow_up' }));
      return {
        qid: q.qid, phase: q.phase, topic: q.topic, question: q.text, fromEmployer: q.source === 'employer',
        reached: exchange.length > 0, score: a?.reached ? a.score : null, missing: a?.missing || [], exchange
      };
    });

  res.json({
    ok: true,
    application: {
      ...listItem(app, applicationState(app, interview)),
      jobTitle: job.title,
      notes: app.notes,
      result: app.result,
      dimensions: interview?.evaluation?.dimensions || null,
      endReason: interview?.live?.endReason || null,
      durationSec: interview?.live?.startedAt && interview?.live?.endedAt
        ? Math.round((new Date(interview.live.endedAt) - new Date(interview.live.startedAt)) / 1000) : null,
      questions
    }
  });
}));

// PATCH /api/hire/applications/:id   { decision?: shortlisted|rejected|null, notes? }
router.patch('/applications/:id', protect, requireStartup, express.json(), handle(async (req, res) => {
  const owned = await ownApplication(req, res);
  if (!owned) return;
  const { app } = owned;
  if (req.body.decision !== undefined) {
    if (![null, 'shortlisted', 'rejected'].includes(req.body.decision)) return fail(res, 400, 'Invalid decision');
    app.decision = req.body.decision;
  }
  if (req.body.notes !== undefined) app.notes = str(req.body.notes, 2000);
  await app.save();
  res.json({ ok: true, decision: app.decision, notes: app.notes });
}));

// DELETE /api/hire/applications/:id   removes the candidate, their interview and
// report. Frees their slot, so the same email/phone can apply again.
router.delete('/applications/:id', protect, requireStartup, handle(async (req, res) => {
  const owned = await ownApplication(req, res);
  if (!owned) return;
  const { app } = owned;
  if (app.interviewId) {
    if (await MockInterview.exists({ _id: app.interviewId, ...inInterviewNow() })) {
      return fail(res, 409, 'This candidate is in their interview right now. Delete it once they finish.', { code: 'INTERVIEW_LIVE' });
    }
    const iv = await MockInterview.findById(app.interviewId).select('voice.folder').lean();
    await deleteAudioFolders([iv?.voice?.folder]);
    await MockInterview.deleteOne({ _id: app.interviewId, mode: 'hiring' });
  }
  await HireApplication.deleteOne({ _id: app._id });
  await HireJob.updateOne({ _id: app.jobId }, {
    $inc: { 'stats.applied': -1, ...(app.status === 'completed' ? { 'stats.completed': -1 } : {}) }
  });
  res.json({ ok: true });
}));

// ══ Candidate (public) ══════════════════════════════════════════════════════

async function liveJobBySlug(slug) {
  const job = await HireJob.findOne({ slug: String(slug) });
  if (!job) return {};
  const company = await HireCompany.findById(job.companyId);
  return { job, company };
}

// GET /api/hire/p/:slug   public job page
router.get('/p/:slug', handle(async (req, res) => {
  const { job, company } = await liveJobBySlug(req.params.slug);
  if (!job || !company || !['live', 'paused', 'closed'].includes(job.status)) return fail(res, 404, 'This interview link is not valid.');
  const open = acceptingCandidates(job, company);
  res.json({
    ok: true,
    job: {
      title: job.title,
      company: { name: company.name, logoUrl: company.logoUrl, website: company.website, about: company.about },
      skills: job.parsed.jd.requiredSkills.map(s => s.name),
      durationMin: job.settings.durationMin ?? 15,
      questionCount: job.settings.questionCount ?? 10,
      requireCamera: job.settings.requireCamera,
      deadline: job.settings.deadline,
      accepting: open.ok,
      closedReason: open.ok ? null : open.reason
    }
  });
}));

const normalizePhone = p => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  return d.length >= 10 && d.length <= 15 ? d : null;
};

// POST /api/hire/p/:slug/apply   multipart: name, email, phone, consent=true, resume (PDF) | resumeText
// Returns the candidate's access token. Applying again before the interview
// has started (same email AND phone) issues a fresh token for the same application.
router.post('/p/:slug/apply', applyLimiter, single('resume'), handle(async (req, res) => {
  const { job, company } = await liveJobBySlug(req.params.slug);
  if (!job || !company) return fail(res, 404, 'This interview link is not valid.');

  const name  = str(req.body.name, 120);
  const email = str(req.body.email, 200).toLowerCase();
  const phone = normalizePhone(req.body.phone);
  if (!name) return fail(res, 400, 'Enter your name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email');
  if (!phone) return fail(res, 400, 'Enter a valid phone number');
  if (req.body.consent !== 'true') return fail(res, 400, 'Please accept the consent to continue');

  const token = crypto.randomBytes(24).toString('base64url');

  const existing = await HireApplication.findOne({ jobId: job._id, $or: [{ 'candidate.email': email }, { 'candidate.phone': phone }] });
  if (existing) {
    const interview = existing.interviewId ? await MockInterview.findById(existing.interviewId).select('status live.startedAt').lean() : null;
    const notStarted = !interview?.live?.startedAt && !['live', 'evaluating', 'completed'].includes(interview?.status);
    if (existing.candidate.email === email && existing.candidate.phone === phone && notStarted) {
      existing.tokenHash = hashToken(token);
      await existing.save();
      return res.json({ ok: true, token, resumed: true });
    }
    return fail(res, 409, 'You have already applied for this role. Each candidate gets one interview.');
  }

  const open = acceptingCandidates(job, company);
  if (!open.ok) return fail(res, 409, open.reason);

  let resumeText = '';
  if (req.file) resumeText = await readPdf(req.file, 'resume');
  else resumeText = normalizeDocText(req.body.resumeText);
  if (resumeText.length < MIN_RESUME_CHARS) {
    return fail(res, 400, req.file
      ? "We couldn't read enough text from your resume. If it's a scanned image, export it from Word or Google Docs as a PDF instead."
      : 'Upload your resume as a PDF.');
  }

  // Reserve a candidate slot atomically so maxCandidates can't be overshot by a burst.
  const reserved = await HireJob.updateOne(
    { _id: job._id, status: 'live', 'stats.applied': { $lt: job.settings.maxCandidates } },
    { $inc: { 'stats.applied': 1 } }
  );
  if (!reserved.modifiedCount) return fail(res, 409, 'This role has reached its application limit.');

  let application;
  try {
    application = await HireApplication.create({
      jobId: job._id, companyId: company._id,
      candidate: { name, email, phone },
      tokenHash: hashToken(token),
      consentAt: new Date()
    });
  } catch (err) {
    await HireJob.updateOne({ _id: job._id }, { $inc: { 'stats.applied': -1 } });
    if (err.code === 11000) return fail(res, 409, 'You have already applied for this role. Each candidate gets one interview.');
    throw err;
  }

  const interview = await openCandidateInterview({ job, company, application, resumeText });
  application.interviewId = interview._id;
  await application.save();

  res.status(201).json({ ok: true, token });
}));

async function candidateByToken(req, res) {
  const token = String(req.params.token || '');
  if (token.length < 20) { fail(res, 404, 'Interview not found'); return null; }
  const app = await HireApplication.findOne({ tokenHash: hashToken(token) });
  if (!app) { fail(res, 404, 'Interview not found'); return null; }
  const [job, interview] = await Promise.all([
    HireJob.findById(app.jobId).select('title status companyId settings.requireCamera settings.deadline').lean(),
    app.interviewId ? MockInterview.findById(app.interviewId).select('status failureReason prepAttempts updatedAt live parsed.resume.claims hire.durationMin').lean() : null
  ]);
  return { app, job, interview };
}

// GET /api/hire/a/:token
router.get('/a/:token', handle(async (req, res) => {
  const found = await candidateByToken(req, res);
  if (!found) return;
  const { app, job, interview } = found;
  const company = await HireCompany.findById(job.companyId).select('name logoUrl').lean();
  // Planned without audio (prepared before pre-made audio): record it now.
  if (interview?.status === 'planned') {
    startVoicing(interview._id);
    interview.status = 'voicing';
  }
  const state = applicationState(app, interview);
  const prepFailed = interview?.status === 'failed' && RETRYABLE_FAILURE.test(interview.failureReason || '');
  const stuck = PREP_STATUSES.includes(interview?.status) && interview.updatedAt < new Date(Date.now() - STUCK_PREP_MS);
  res.json({
    ok: true,
    interview: {
      name: app.candidate.name,
      jobTitle: job.title,
      company: { name: company?.name, logoUrl: company?.logoUrl },
      state,
      durationMin: interview?.hire?.durationMin || 15,
      requireCamera: job.settings.requireCamera,
      canRetryPrep: (prepFailed || stuck) && (interview?.prepAttempts || 0) < MAX_PREP_ATTEMPTS
    }
  });
}));

// POST /api/hire/a/:token/prepare   retry a failed or stuck prep
router.post('/a/:token/prepare', handle(async (req, res) => {
  const found = await candidateByToken(req, res);
  if (!found) return;
  const { interview } = found;
  if (!interview) return fail(res, 409, 'Nothing to prepare');
  const { status } = interview;
  const stuck = PREP_STATUSES.includes(status) && interview.updatedAt < new Date(Date.now() - STUCK_PREP_MS);
  const retryable = status === 'failed' && RETRYABLE_FAILURE.test(interview.failureReason || '');
  if (!(stuck || retryable)) return fail(res, 409, `Interview is ${status}`);
  if (interview.prepAttempts >= MAX_PREP_ATTEMPTS) return fail(res, 429, 'We could not prepare your interview. Please contact the company.');

  // A voice failure keeps the plan and only records the audio again.
  const resetTo = status === 'voicing' || /^voice:/.test(interview.failureReason || '') ? 'planned' : 'draft';
  const claimed = await MockInterview.updateOne(
    { _id: interview._id, status, updatedAt: interview.updatedAt },
    { $set: { status: resetTo, failureReason: '' }, $inc: { prepAttempts: 1 } }
  );
  if (!claimed.modifiedCount) return fail(res, 409, 'Already restarting');
  runCandidatePrep(interview._id, resetTo);
  res.status(202).json({ ok: true, state: 'applied' });
}));

// Live interviews right now, plus ones dispatched in the last minute that
// haven't gone live yet (their agent is still joining).
function inInterviewNow() {
  return {
    $or: [
      { status: 'live' },
      { status: { $in: ['ready', 'planned'] }, 'live.dispatchedAt': { $gte: new Date(Date.now() - DISPATCH_RETRY_MS) } }
    ]
  };
}

async function liveInterviewCount() {
  return MockInterview.countDocuments(inInterviewNow());
}

// POST /api/hire/a/:token/join
router.post('/a/:token/join', handle(async (req, res) => {
  if (!liveKitService.isConfigured()) return fail(res, 503, 'Interviews are temporarily unavailable.');
  const found = await candidateByToken(req, res);
  if (!found) return;
  const { app, job, interview } = found;
  if (!interview) return fail(res, 409, 'Your interview is still being prepared.');
  if (interview.status === 'planned') {
    startVoicing(interview._id);
    return fail(res, 409, 'Your interview is still being prepared.', { state: 'applied' });
  }
  if (!['ready', 'live'].includes(interview.status)) {
    return fail(res, 409, interview.status === 'evaluating' || interview.status === 'completed'
      ? 'You have already completed this interview.' : 'Your interview is still being prepared.', { state: applicationState(app, interview) });
  }
  if (job.status === 'closed') return fail(res, 409, 'This role is no longer accepting interviews.');

  const rejoin = interview.status === 'live' || !!interview.live?.startedAt;
  if (!rejoin) {
    if (await liveInterviewCount() >= MAX_CONCURRENT) {
      return fail(res, 503, 'All interviewers are busy right now. Please try again in a few minutes.', { code: 'SLOTS_FULL', retryAfterSec: 120 });
    }
  }

  const roomName = mockRoomName(interview._id);
  await liveKitService.createMockRoom(roomName);
  if (!(await liveKitService.roomHasAgent(roomName))) {
    const claim = await MockInterview.updateOne(
      { _id: interview._id, $or: [{ 'live.dispatchedAt': null }, { 'live.dispatchedAt': { $lt: new Date(Date.now() - DISPATCH_RETRY_MS) } }] },
      { $set: { 'live.dispatchedAt': new Date(), 'live.roomName': roomName } }
    );
    if (claim.modifiedCount) await liveKitService.dispatchAgent(roomName, MOCK_AGENT_NAME, { interviewId: String(interview._id) });
  }

  const identity = hireParticipantIdentity(app._id);
  const lkToken = await liveKitService.generateToken(roomName, identity, app.candidate.name, 'participant');
  res.json({
    ok: true,
    token: lkToken,
    roomName,
    livekitUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_HOST?.replace('http', 'ws')
  });
}));

// POST /api/hire/a/:token/integrity   { type: tab_hidden|fullscreen_exit|camera_off, seconds? }
// Sent by the interview page; shown to the founder next to the score.
router.post('/a/:token/integrity', express.json(), handle(async (req, res) => {
  const found = await candidateByToken(req, res);
  if (!found) return;
  const { app, interview } = found;
  if (interview?.status !== 'live') return res.json({ ok: true, ignored: true });
  const inc = {
    tab_hidden     : { 'integrity.tabSwitches': 1 },
    fullscreen_exit: { 'integrity.fullscreenExits': 1 },
    camera_off     : { 'integrity.cameraOffSec': Math.min(900, Math.max(0, Math.round(Number(req.body.seconds) || 0))) }
  }[req.body.type];
  if (!inc) return fail(res, 400, 'Unknown event');
  await HireApplication.updateOne({ _id: app._id }, { $inc: inc });
  res.json({ ok: true });
}));

export default router;
