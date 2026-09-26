import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import MockInterview from '../models/MockInterview.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import liveKitService from '../services/LiveKitService.js';
import { MOCK_AGENT_NAME, mockRoomName } from '../services/mockInterview/liveConfig.js';
import { buildReport, buildReportPreview } from '../services/mockInterview/EvaluationService.js';
import {
  createEntryOrder, verifyEntryPayment, createUnlockOrder, verifyUnlockPayment,
  isUnlocked, isEntryPaid, isFreeUser, grantFreeReport, getPricing, REPORT_PRICE_INR
} from '../services/mockInterview/MockPaymentService.js';
import { prepareInterview, planInterview } from '../services/mockInterview/PlannerService.js';
import { pdfToText, fetchProfileResumeText, normalizeDocText } from '../services/mockInterview/documentText.js';

const router = express.Router();

const MIN_JD_CHARS     = 200;
const MIN_RESUME_CHARS = 300;
// Until payments exist, this caps how much Groq quota one student can spend.
const DAILY_LIMIT       = Number(process.env.MOCK_DAILY_LIMIT) || 10;
const MAX_PREP_ATTEMPTS = 3;
// Prep normally finishes in 1-2 min; a parsing/planning status older than
// this means the server restarted mid-prep.
const STUCK_PREP_MS     = 5 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    req.rejectedFile = file.fieldname;
    cb(null, false);
  },
}).fields([{ name: 'resume', maxCount: 1 }, { name: 'jdFile', maxCount: 1 }]);

const uploadMiddleware = (req, res, next) => upload(req, res, err => {
  if (err) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 5 MB' : err.message;
    return res.status(400).json({ ok: false, error: message });
  }
  if (req.rejectedFile) return res.status(400).json({ ok: false, error: `${req.rejectedFile} must be a PDF` });
  next();
});

// Prep failures carry internal detail; only known input problems are shown to the student.
function userFacingFailure(reason = '') {
  if (/No skills could be extracted/.test(reason)) {
    return "We couldn't find any skills in this job description. Paste the full JD, including the requirements section.";
  }
  if (/checkable claims/.test(reason)) {
    return 'Your resume needs more specific detail (projects, internships, results) to build a resume round. Add more detail and try again.';
  }
  return 'Something went wrong while preparing your interview. Please try again.';
}

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return res.status(404).json({ ok: false, error: 'Interview not found' });
  next();
});

async function readPdf(file, label) {
  try {
    return await pdfToText(file.buffer);
  } catch {
    const err = new Error(`We couldn't open your ${label} PDF. It may be corrupted or password-protected.`);
    err.status = 400;
    throw err;
  }
}

// New interviews and retakes share the daily cap and the one-prep-at-a-time rule.
async function creationBlocked(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [createdToday, preparing] = await Promise.all([
    MockInterview.countDocuments({ userId, createdAt: { $gte: since } }),
    MockInterview.exists({
      userId,
      status: { $in: ['draft', 'parsing', 'parsed', 'planning'] },
      updatedAt: { $gte: new Date(Date.now() - STUCK_PREP_MS) }
    })
  ]);
  if (createdToday >= DAILY_LIMIT && !(await isFreeUser(userId))) {
    return { status: 429, error: `You can create up to ${DAILY_LIMIT} interviews a day. Try again tomorrow.` };
  }
  if (preparing) {
    return { status: 409, error: 'Another interview is still being prepared. Wait for it to finish.' };
  }
  return null;
}

function runPrep(interviewId, fromStatus) {
  const run = fromStatus === 'parsed' ? planInterview : prepareInterview;
  run(interviewId).catch(err => console.error(`Mock interview ${interviewId} prep failed:`, err.message));
}

const PREPARED_STATUSES = ['planned', 'live', 'evaluating', 'completed'];

// POST /api/mock-interviews   (multipart/form-data)
// Fields: jdText or jdFile (PDF); resume (PDF) or useProfileResume=true;
// optional company, role. Creates the interview and starts prep.
router.post('/', protect, uploadMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const blocked = await creationBlocked(userId);
    if (blocked) return res.status(blocked.status).json({ ok: false, error: blocked.error });

    const jdFile = req.files?.jdFile?.[0];
    const jdText = jdFile ? await readPdf(jdFile, 'job description') : normalizeDocText(req.body.jdText);
    if (jdText.length < MIN_JD_CHARS) {
      return res.status(400).json({ ok: false, error: 'The job description is too short. Paste the full JD or upload it as a PDF.' });
    }

    const resumeFile = req.files?.resume?.[0];
    let resumeText = '';
    if (resumeFile) {
      resumeText = await readPdf(resumeFile, 'resume');
    } else if (req.body.resumeText?.trim()) {
      resumeText = normalizeDocText(req.body.resumeText);
    } else if (req.body.useProfileResume === 'true') {
      const user = await User.findById(userId).select('resumeUrl').lean();
      if (!user?.resumeUrl) return res.status(400).json({ ok: false, error: 'No resume on your profile. Upload one instead.' });
      resumeText = await fetchProfileResumeText(user.resumeUrl).catch(() => '') || '';
      if (resumeText.length < MIN_RESUME_CHARS) {
        return res.status(400).json({
          ok: false,
          error: "We couldn't read the resume on your profile (it may be a scanned image or unavailable). Upload a PDF or paste the text instead."
        });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Upload your resume as a PDF or paste its text.' });
    }
    if (resumeText.length < MIN_RESUME_CHARS) {
      return res.status(400).json({
        ok: false,
        error: "We couldn't read enough text from your resume. If it's a scanned image, export it from Word or Google Docs as a PDF instead."
      });
    }

    const interview = await MockInterview.create({
      userId,
      company: String(req.body.company || '').trim().slice(0, 120),
      role   : String(req.body.role || '').trim().slice(0, 120),
      inputs : {
        jdText,
        jdSource    : jdFile ? 'pdf' : 'text',
        resumeText,
        resumeSource: resumeFile ? 'upload' : req.body.resumeText?.trim() ? 'text' : 'profile'
      },
      prepAttempts: 1
    });
    runPrep(interview._id, 'draft');

    res.status(201).json({ ok: true, id: interview._id, status: interview.status });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    console.error('Mock interview create error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mock-interviews/:id/retake
// Next attempt of a completed interview: same JD and resume (parsing is
// reused), a new plan that re-tests the weak areas and repeats no question
// from any earlier attempt.
router.post('/:id/retake', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const parent = await MockInterview.findById(req.params.id)
      .select('userId status company role roleFamily seniority inputs parsed rootInterviewId')
      .lean();
    if (!parent || parent.userId.toString() !== userId) {
      return res.status(404).json({ ok: false, error: 'Interview not found' });
    }
    if (parent.status !== 'completed') {
      return res.status(409).json({ ok: false, error: 'You can retake an interview once its report is ready.', status: parent.status });
    }

    const blocked = await creationBlocked(userId);
    if (blocked) return res.status(blocked.status).json({ ok: false, error: blocked.error });

    const rootInterviewId = parent.rootInterviewId || parent._id;
    const attemptsSoFar = await MockInterview.countDocuments({ $or: [{ _id: rootInterviewId }, { rootInterviewId }] });

    const retake = await MockInterview.create({
      userId,
      status    : 'parsed',
      company   : parent.company,
      role      : parent.role,
      roleFamily: parent.roleFamily,
      seniority : parent.seniority,
      inputs    : parent.inputs,
      parsed    : parent.parsed,
      attempt   : attemptsSoFar + 1,
      parentInterviewId: parent._id,
      rootInterviewId,
      prepAttempts: 1
    });
    runPrep(retake._id, 'parsed');

    res.status(201).json({ ok: true, id: retake._id, status: retake.status, attempt: retake.attempt });
  } catch (err) {
    console.error('Mock interview retake error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/mock-interviews
router.get('/', protect, async (req, res) => {
  try {
    const interviews = await MockInterview.find({ userId: req.user.userId })
      .select('company role status attempt parentInterviewId access entryPayment.status evaluation.overall createdAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({
      ok: true,
      interviews: interviews.map(i => ({
        id: i._id, company: i.company, role: i.role, status: i.status,
        attempt: i.attempt, overall: i.evaluation?.overall ?? null, createdAt: i.createdAt,
        entryPaid: isEntryPaid(i), reportUnlocked: isUnlocked(i)
      }))
    });
  } catch (err) {
    console.error('Mock interview list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/mock-interviews/:id
// Status and blueprint. Never returns the planned questions: that would
// spoil the interview.
router.get('/:id', protect, async (req, res) => {
  try {
    const interview = await MockInterview.findById(req.params.id)
      .select('userId company role roleFamily seniority status failureReason blueprint attempt parentInterviewId prepAttempts access entryPayment createdAt plan.questions.phase')
      .lean();
    if (!interview || interview.userId.toString() !== req.user.userId) {
      return res.status(404).json({ ok: false, error: 'Interview not found' });
    }
    res.json({
      ok: true,
      interview: {
        id        : interview._id,
        company   : interview.company,
        role      : interview.role,
        seniority : interview.seniority,
        status    : interview.status,
        attempt   : interview.attempt,
        parentInterviewId: interview.parentInterviewId,
        canRetake : interview.status === 'completed',
        reportUnlocked: isUnlocked(interview),
        reportAccess  : interview.access?.plan || 'locked',
        pricing       : await getPricing({ ...interview, _id: interview._id }),
        // Shape of the interview without the questions themselves.
        questionCount : interview.plan?.questions?.length || 0,
        phases        : (interview.plan?.questions || []).reduce((acc, q) => ({ ...acc, [q.phase]: (acc[q.phase] || 0) + 1 }), {}),
        createdAt : interview.createdAt,
        blueprint : PREPARED_STATUSES.includes(interview.status) ? interview.blueprint : null,
        error     : interview.status === 'failed' ? userFacingFailure(interview.failureReason) : null,
        canRetryPrep: interview.status === 'failed'
          && /^(parse|plan):/.test(interview.failureReason || '')
          && interview.prepAttempts < MAX_PREP_ATTEMPTS
      }
    });
  } catch (err) {
    console.error('Mock interview get error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mock-interviews/:id/prepare
// Retries a failed prep, or restarts one stuck after a server restart. Resumes
// from the plan step when parsing already succeeded.
router.post('/:id/prepare', protect, async (req, res) => {
  try {
    const interview = await MockInterview.findById(req.params.id)
      .select('userId status failureReason prepAttempts updatedAt parsed.resume.claims')
      .lean();
    if (!interview || interview.userId.toString() !== req.user.userId) {
      return res.status(404).json({ ok: false, error: 'Interview not found' });
    }

    const { status } = interview;
    const stuck = ['parsing', 'planning'].includes(status) && interview.updatedAt < new Date(Date.now() - STUCK_PREP_MS);
    const retryableFailure = status === 'failed' && /^(parse|plan):/.test(interview.failureReason || '');
    if (!(status === 'draft' || stuck || retryableFailure)) {
      return res.status(409).json({ ok: false, error: `Interview is ${status}`, status });
    }
    if (interview.prepAttempts >= MAX_PREP_ATTEMPTS) {
      return res.status(429).json({ ok: false, error: 'This interview failed to prepare too many times. Create a new one.' });
    }

    const parsedOk = interview.parsed?.resume?.claims?.length > 0
      && (status === 'planning' || /^plan:/.test(interview.failureReason || ''));
    const resetTo = parsedOk ? 'parsed' : 'draft';

    // Atomic on the status we just read, so two clicks can't start two preps.
    const claimed = await MockInterview.updateOne(
      { _id: interview._id, status, updatedAt: interview.updatedAt },
      { $set: { status: resetTo, failureReason: '' }, $inc: { prepAttempts: 1 } }
    );
    if (!claimed.modifiedCount) {
      return res.status(409).json({ ok: false, error: 'Prep is already being restarted' });
    }
    runPrep(interview._id, resetTo);

    res.status(202).json({ ok: true, status: resetTo });
  } catch (err) {
    console.error('Mock interview prepare error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// A dispatch that hasn't produced an agent in the room within this window is
// assumed lost, and the next join may dispatch again.
const DISPATCH_RETRY_MS = 60 * 1000;

// POST /api/mock-interviews/:id/join
// Returns a LiveKit token for the student and makes sure the AI interviewer
// is dispatched to the room exactly once. Also used to rejoin after a drop.
router.post('/:id/join', protect, async (req, res) => {
  try {
    if (!liveKitService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'LiveKit not configured on this server' });
    }

    const userId = req.user.userId;
    const interview = await MockInterview.findById(req.params.id).select('userId status entryPayment').lean();
    if (!interview || interview.userId.toString() !== userId) {
      return res.status(404).json({ ok: false, error: 'Interview not found' });
    }
    if (!['planned', 'live'].includes(interview.status)) {
      return res.status(409).json({ ok: false, error: `Interview is ${interview.status}`, status: interview.status });
    }
    // Nothing joins (and no interviewer is dispatched) until the interview is paid for.
    if (!isEntryPaid(interview)) {
      return res.status(402).json({ ok: false, code: 'PAYMENT_REQUIRED', error: 'Pay to start your interview.' });
    }

    const roomName = mockRoomName(interview._id);
    await liveKitService.createMockRoom(roomName);

    if (!(await liveKitService.roomHasAgent(roomName))) {
      // Atomic claim so two quick joins (double click, two tabs) can't put two interviewers in the room.
      const claim = await MockInterview.updateOne(
        {
          _id: interview._id,
          $or: [{ 'live.dispatchedAt': null }, { 'live.dispatchedAt': { $lt: new Date(Date.now() - DISPATCH_RETRY_MS) } }]
        },
        { $set: { 'live.dispatchedAt': new Date(), 'live.roomName': roomName } }
      );
      if (claim.modifiedCount) {
        await liveKitService.dispatchAgent(roomName, MOCK_AGENT_NAME, { interviewId: String(interview._id) });
      }
    }

    const user = await User.findById(userId).select('name username').lean();
    const token = await liveKitService.generateToken(roomName, userId, user?.name || user?.username || userId, 'participant');

    res.json({
      ok: true,
      token,
      roomName,
      livekitUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_HOST?.replace('http', 'ws'),
    });
  } catch (err) {
    console.error('Mock interview join error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/mock-interviews/:id/report
router.get('/:id/report', protect, async (req, res) => {
  try {
    const interview = await MockInterview.findById(req.params.id).lean();
    if (!interview || interview.userId.toString() !== req.user.userId) {
      return res.status(404).json({ ok: false, error: 'Interview not found' });
    }
    if (interview.status === 'evaluating') {
      return res.status(202).json({ ok: true, status: 'evaluating' });
    }
    if (interview.status !== 'completed') {
      return res.status(409).json({ ok: false, error: `Interview is ${interview.status}`, status: interview.status });
    }
    const parent = interview.parentInterviewId
      ? await MockInterview.findById(interview.parentInterviewId).select('attempt plan.questions evaluation').lean()
      : null;
    const report = buildReport(interview, parent);
    // Free accounts always see the full report, including interviews paid for before they were on the list.
    if (!isUnlocked(interview) && await isFreeUser(interview.userId)) {
      await grantFreeReport(interview._id);
      interview.access = { ...interview.access, plan: 'paid' };
    }
    if (!isUnlocked(interview)) {
      return res.json({ ok: true, status: 'completed', locked: true, price: REPORT_PRICE_INR, report: buildReportPreview(report) });
    }
    res.json({ ok: true, status: 'completed', locked: false, report });
  } catch (err) {
    console.error('Mock interview report error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mock-interviews/:id/checkout   Body: { bundle?: boolean }
// Razorpay order to start the interview: ₹99, or ₹149 with the full report
// (first interview only). Returns { paid: true } when already paid.
router.post('/:id/checkout', protect, async (req, res) => {
  try {
    res.json({ ok: true, ...(await createEntryOrder(req.params.id, req.user.userId, { bundle: !!req.body?.bundle })) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('Mock interview checkout error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mock-interviews/:id/checkout/verify   Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/:id/checkout/verify', protect, express.json(), async (req, res) => {
  try {
    await verifyEntryPayment(req.params.id, req.user.userId, req.body || {});
    res.json({ ok: true, paid: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('Mock interview checkout verify error:', err);
    res.status(502).json({ ok: false, error: 'Could not confirm payment with Razorpay' });
  }
});

// POST /api/mock-interviews/:id/unlock
// Razorpay order for the full report. Returns { unlocked: true } instead when
// nothing is owed (already paid, or the free first report applies).
router.post('/:id/unlock', protect, async (req, res) => {
  try {
    res.json({ ok: true, ...(await createUnlockOrder(req.params.id, req.user.userId)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('Mock interview unlock error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mock-interviews/:id/unlock/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature } from checkout.
router.post('/:id/unlock/verify', protect, express.json(), async (req, res) => {
  try {
    await verifyUnlockPayment(req.params.id, req.user.userId, req.body || {});
    res.json({ ok: true, unlocked: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('Mock interview verify error:', err);
    res.status(502).json({ ok: false, error: 'Could not confirm payment with Razorpay' });
  }
});

export default router;
