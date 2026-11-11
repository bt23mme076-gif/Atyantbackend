// Job setup for Atyant Hire: parse the JD once, expand the founder's must-ask
// questions into gradable questions, and open candidate interviews from it.
import crypto from 'crypto';
import HireJob from '../../models/HireJob.js';
import MockInterview from '../../models/MockInterview.js';
import { groqJSON } from '../../utils/groqClient.js';
import { parseJd, withRateLimitRetry, prepareInterview } from '../mockInterview/PlannerService.js';
import { buildMustAskMessages } from './hiringPrompts.js';

const MODEL = process.env.MOCK_PARSER_MODEL || 'openai/gpt-oss-120b';
export const MAX_MUST_ASK = 3;

export function makeSlug(title) {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

// Founder text → mustAsk entries with expected points. Falls back to bare
// questions (graded against a generic point) if the model call fails.
export async function expandMustAsk(texts, { role, seniority }, log = []) {
  const questions = texts.map(t => String(t).trim().slice(0, 400)).filter(Boolean).slice(0, MAX_MUST_ASK);
  if (!questions.length) return [];
  try {
    const raw = await withRateLimitRetry('must-ask', () =>
      groqJSON(buildMustAskMessages({ role, seniority, questions }), { model: MODEL, maxTokens: 2000, timeoutMs: 60000 }), log);
    return questions.map((text, i) => {
      const q = raw?.questions?.[i] || {};
      const points = (q.expectedPoints || [])
        .filter(p => p?.point)
        .slice(0, 5)
        .map((p, j) => ({ id: `p${j + 1}`, point: String(p.point), weight: Math.min(3, Math.max(1, Number(p.weight) || 1)) }));
      return {
        text,
        topic : String(q.topic || '').slice(0, 60),
        intent: String(q.intent || '').slice(0, 200),
        expectedPoints: points,
        followUps: {
          shallow     : String(q.followUps?.shallow || ''),
          wrong       : String(q.followUps?.wrong || ''),
          strongDeeper: String(q.followUps?.strongDeeper || '')
        }
      };
    });
  } catch (err) {
    log.push(`must-ask expansion failed: ${err.message}`);
    return questions.map(text => ({ text, expectedPoints: [] }));
  }
}

// parsing → ready, or failed. Runs in the background after the job is created.
export async function prepareJob(jobId, mustAskTexts = []) {
  const job = await HireJob.findOne({ _id: jobId, status: 'parsing' });
  if (!job) return;
  const log = [];
  try {
    const jd = await parseJd({ jdText: job.jdText, company: '', role: job.title }, log);
    job.parsed = {
      company   : jd.meta.company || '',
      role      : jd.meta.role || job.title,
      seniority : jd.meta.seniority || 'fresher',
      roleFamily: jd.meta.roleFamily,
      jd        : jd.jd,
      log       : [...log, ...jd.dropped].slice(0, 50)
    };
    job.settings.mustAsk = await expandMustAsk(mustAskTexts, { role: job.title, seniority: job.parsed.seniority }, log);
    job.status = 'ready';
    job.failureReason = '';
    await job.save();
  } catch (err) {
    console.error(`Hire job ${jobId} prep failed:`, err.message);
    await HireJob.updateOne({ _id: jobId }, { $set: { status: 'failed', failureReason: err.message, 'parsed.log': log } });
  }
}

// Creates the candidate's MockInterview from the job (JD parse reused) and
// starts resume parse + planning in the background.
export async function openCandidateInterview({ job, company, application, resumeText }) {
  const interview = await MockInterview.create({
    mode      : 'hiring',
    userId    : null,
    company   : company.name,
    role      : job.title,
    seniority : job.parsed.seniority,
    roleFamily: job.parsed.roleFamily,
    interviewCategory: job.interviewCategory,
    inputs    : { jdText: job.jdText, jdSource: 'text', resumeText, resumeSource: 'upload' },
    parsed    : { jd: job.parsed.jd },
    hire      : {
      jobId        : job._id,
      applicationId: application._id,
      candidateName: application.candidate.name,
      mustAsk      : job.settings.mustAsk
    },
    // Hire is free: nothing is charged to the candidate or the company.
    entryPayment: { status: 'paid', waived: true, amount: 0, paidAt: new Date(), reportIncluded: true },
    access      : { plan: 'paid', unlockedAt: new Date() },
    prepAttempts: 1
  });
  runCandidatePrep(interview._id);
  return interview;
}

export function runCandidatePrep(interviewId) {
  prepareInterview(interviewId).catch(err => console.error(`Hire interview ${interviewId} prep failed:`, err.message));
}
