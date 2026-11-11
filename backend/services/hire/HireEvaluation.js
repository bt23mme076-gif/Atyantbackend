// Turns a scored hiring interview into the founder's report, bills it, and
// tells the founder. Per-question scoring is shared with mock interviews
// (EvaluationService); only the synthesis and what happens after differ.
import HireApplication from '../../models/HireApplication.js';
import HireJob from '../../models/HireJob.js';
import { groqJSON } from '../../utils/groqClient.js';
import { withRateLimitRetry } from '../mockInterview/PlannerService.js';
import { buildHiringSynthesisMessages } from './hiringPrompts.js';
import { notifyFounderReportReady } from './HireNotify.js';

const EVAL_MODEL = process.env.MOCK_EVAL_MODEL || 'openai/gpt-oss-120b';
const VERDICTS = ['no', 'maybe', 'yes', 'strong_yes'];
// The model's verdict can't be better than the scores support.
const verdictCap = overall => (overall >= 75 ? 'strong_yes' : overall >= 60 ? 'yes' : overall >= 40 ? 'maybe' : 'no');
const MAX_ANSWER_CHARS = 900;

const clean = s => (typeof s === 'string' ? s.replace(/[‐‑]/g, '-').trim() : '');

function quoteOk(evidence, transcript, evidenceSupported) {
  return !!evidence && evidenceSupported(evidence, transcript);
}

// Resume claims probed in the interview: held up, shaky, or collapsed.
function claimOutcomes(interview, perAnswer) {
  const claims = new Map(interview.parsed.resume.claims.map(c => [c.id, c]));
  const scoreByQid = new Map(perAnswer.filter(a => a.reached && a.score != null).map(a => [a.qid, a.score]));
  return interview.plan.questions
    .filter(q => q.ref?.type === 'claim' && scoreByQid.has(q.qid) && claims.has(q.ref.id))
    .map(q => {
      const score = scoreByQid.get(q.qid);
      return { claim: claims.get(q.ref.id).claim, score, outcome: score >= 3.5 ? 'held' : score >= 2 ? 'shaky' : 'collapsed' };
    });
}

// Returns the hiring fields stored on the interview's evaluation. Never throws:
// a failed synthesis still produces a report from the scores.
export async function synthesizeHiring(interview, perAnswer, scores, log, evidenceSupported) {
  const byQid = new Map(perAnswer.map(a => [a.qid, a]));
  const turnsByQid = new Map();
  for (const t of interview.turns) {
    if (!turnsByQid.has(t.qid)) turnsByQid.set(t.qid, []);
    turnsByQid.get(t.qid).push(t.answer || '');
  }
  const transcript = interview.turns.map(t => t.answer || '').join(' ');
  const scored = interview.plan.questions.filter(q => q.phase !== 'closing');
  const reached = scored.filter(q => byQid.get(q.qid)?.reached).length;
  const coveragePct = scored.length ? Math.round((reached / scored.length) * 100) : 0;
  const requiredSkills = interview.parsed.jd.requiredSkills.map(s => s.name);

  const base = {
    overall: scores.overall,
    coveragePct,
    claims : claimOutcomes(interview, perAnswer)
  };

  let raw = null;
  try {
    raw = await withRateLimitRetry('hiring synthesis', () => groqJSON(buildHiringSynthesisMessages({
      role: interview.role,
      company: interview.company,
      seniority: interview.seniority,
      requiredSkills,
      overall: scores.overall,
      coveragePct,
      questions: scored.map(q => {
        const a = byQid.get(q.qid);
        if (!a?.reached) return { phase: q.phase, topic: q.topic, question: q.text, notReached: true };
        return {
          phase: q.phase, topic: q.topic, question: q.text,
          fromEmployer: q.source === 'employer' || undefined,
          score: a.score, missing: a.missing,
          answers: (turnsByQid.get(q.qid) || []).join(' / ').slice(0, MAX_ANSWER_CHARS)
        };
      })
    }), { model: EVAL_MODEL, maxTokens: 3000, timeoutMs: 90000 }), log);
  } catch (err) {
    log.push(`hiring synthesis failed: ${err.message}`);
  }

  const evidenced = (list, max) => (Array.isArray(list) ? list : [])
    .map(x => ({ point: clean(x?.point), evidence: clean(x?.evidence) }))
    .filter(x => {
      if (!x.point) return false;
      if (quoteOk(x.evidence, transcript, evidenceSupported)) return true;
      log.push(`hiring: dropped "${x.point}", quote not in transcript`);
      return false;
    })
    .slice(0, max);

  const cap = verdictCap(scores.overall ?? 0);
  const llmVerdict = VERDICTS.includes(raw?.verdict) ? raw.verdict : cap;
  const verdict = VERDICTS[Math.min(VERDICTS.indexOf(llmVerdict), VERDICTS.indexOf(cap))];

  const skillFit = requiredSkills.map(skill => {
    const got = (raw?.skillFit || []).find(s => clean(s?.skill).toLowerCase() === skill.toLowerCase());
    const evidence = clean(got?.evidence);
    const level = ['strong', 'adequate', 'weak'].includes(got?.level) && quoteOk(evidence, transcript, evidenceSupported)
      ? got.level : 'not_assessed';
    return { skill, level, evidence: level === 'not_assessed' ? '' : evidence };
  });

  return {
    ...base,
    verdict,
    summary  : clean(raw?.summary),
    strengths: evidenced(raw?.strengths, 3),
    concerns : evidenced(raw?.concerns, 3),
    redFlags : evidenced(raw?.redFlags, 2),
    skillFit,
    nextRoundQuestions: (raw?.nextRoundQuestions || []).map(clean).filter(Boolean).slice(0, 3)
  };
}

// After a hiring interview is scored: store the result on the application,
// and notify the founder.
export async function onHiringEvaluated(interview, hiring) {
  const applicationId = interview.hire?.applicationId;
  if (!applicationId) return;
  const app = await HireApplication.findOneAndUpdate(
    { _id: applicationId },
    { $set: { status: 'completed', result: { ...hiring, completedAt: new Date() } } },
    { new: true }
  );
  if (!app) return;

  await HireJob.updateOne({ _id: app.jobId }, { $inc: { 'stats.completed': 1 } });
  notifyFounderReportReady(app); // not awaited: never delays evaluation
}

export async function onHiringEvaluationFailed(interview) {
  if (!interview.hire?.applicationId) return;
  await HireApplication.updateOne({ _id: interview.hire.applicationId }, { $set: { status: 'failed' } });
}
