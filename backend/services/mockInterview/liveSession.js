// The interview agent's database and judge steps, kept free of LiveKit so the
// same code runs in the agent and in local text-mode tests.
import MockInterview from '../../models/MockInterview.js';
import { groqJSON } from '../../utils/groqClient.js';
import { buildDirectorMessages, normalizeDirection } from './directorPrompts.js';

// The quality model writes what the interviewer says; the smaller one takes over
// if it is rate-limited or down, so a busy moment never leaves a silent interviewer.
const DIRECTOR_MODEL    = process.env.MOCK_DIRECTOR_MODEL || 'openai/gpt-oss-120b';
const DIRECTOR_FALLBACK = process.env.MOCK_DIRECTOR_FALLBACK || 'openai/gpt-oss-20b';

// Reads the candidate's answer and returns { verdict, reaction, followUp, rephrase }.
export async function judge(args) {
  const messages = buildDirectorMessages(args);
  const opts = { allowFollowUp: args.allowFollowUp, isFollowUp: args.isFollowUp };
  let lastError;
  for (const model of [DIRECTOR_MODEL, DIRECTOR_FALLBACK]) {
    try {
      const direction = normalizeDirection(await groqJSON(messages, { model, maxTokens: 700, timeoutMs: 5000 }), opts);
      if (direction.verdict) return direction;
      lastError = new Error('Director returned no verdict');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Whisper spelling hints: skills, company, role and project names.
export function sttPrompt(interview) {
  const { jd, resume } = interview.parsed;
  const terms = [
    interview.company,
    interview.role,
    ...jd.requiredSkills.map(s => s.name),
    ...jd.niceToHave.map(s => s.name),
    ...resume.projects.flatMap(p => [p.name, ...(p.tech || [])])
  ].filter(Boolean);
  return `Job interview. Terms: ${[...new Set(terms)].join(', ')}.`;
}

// Resume after an agent restart at the planned question after the last one answered.
export function resumeIndex(interview) {
  const last = interview.turns.at(-1);
  if (!last) return 0;
  return interview.plan.questions.findIndex(q => q.qid === last.qid) + 1;
}

// Claims the interview for a live session. Returns null if it isn't startable.
export async function startLiveInterview(interviewId) {
  const interview = await MockInterview.findOneAndUpdate(
    { _id: interviewId, status: { $in: ['planned', 'live'] } },
    { $set: { status: 'live' } },
    { new: true }
  ).lean();
  if (!interview) return null;

  const startedAt = interview.live?.startedAt ? new Date(interview.live.startedAt) : new Date();
  if (!interview.live?.startedAt) {
    await MockInterview.updateOne({ _id: interviewId }, { $set: { 'live.startedAt': startedAt } });
  }
  return { interview, startedAt, resuming: interview.turns.length > 0 && !!interview.live?.startedAt };
}

export function saveTurn(interviewId, turn) {
  return MockInterview.updateOne({ _id: interviewId }, { $push: { turns: turn } });
}

// Nothing answered (dropped during the greeting): leave it startable again.
// Otherwise hand it to the evaluation cron.
export async function endLiveInterview(interviewId, reason) {
  const answered = await MockInterview.exists({ _id: interviewId, 'turns.0': { $exists: true } });
  const update = answered
    ? { status: 'evaluating', 'live.endedAt': new Date(), 'live.endReason': reason }
    : { status: 'planned', 'live.startedAt': null, 'live.dispatchedAt': null, 'live.endReason': reason };
  await MockInterview.updateOne({ _id: interviewId }, { $set: update });
}
