// Scores a finished mock interview and builds the report.
//
// Per planned question (follow-ups included): the model marks each expected
// point full/partial/none with an exact quote; code rejects hits whose quote
// isn't in the transcript and computes the 0-5 score from the hits. Each
// question is graded EVAL_RUNS times, plus one more when runs disagree by more
// than a point, and the run nearest the mean is kept. Then one synthesis call
// writes the summary and prep path.
import MockInterview from '../../models/MockInterview.js';
import { groqJSON } from '../../utils/groqClient.js';
import { withRateLimitRetry } from './PlannerService.js';
import { buildAnswerEvalMessages, buildSynthesisMessages, buildSampleRepairMessages } from './evaluationPrompts.js';
import { retestKey, weakAreas, areaLabel } from './retake.js';

const EVAL_MODEL   = process.env.MOCK_EVAL_MODEL || 'openai/gpt-oss-120b';
// Grading runs at temperature 0, and repeat runs gave identical scores in
// testing, so one run is the default. Raise it if scores start to drift.
const EVAL_RUNS    = Number(process.env.MOCK_EVAL_RUNS) || 1;
const DISAGREEMENT = 1;
const MAX_ATTEMPTS = 3;
const STALE_MS     = 20 * 60 * 1000;

const HIT_VALUE    = { full: 1, partial: 0.5, none: 0 };
const PHASE_WEIGHT = { intro: 0.5, resume: 1, technical: 1, behavioral: 1 };

const round1 = n => Math.round(n * 10) / 10;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
// gpt-oss writes non-breaking hyphens ("well‑structured") and narrow spaces.
const clean = s => (typeof s === 'string' ? s.replace(/[‐‑]/g, '-').replace(/[  ]/g, ' ').trim() : '');
const words = s => (s || '').toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter(Boolean);

export function scoreFromPoints(expectedPoints, points) {
  const hitById = new Map(points.map(p => [p.pointId, p.hit]));
  const total = expectedPoints.reduce((sum, p) => sum + (p.weight || 1), 0);
  if (!total) return 0;
  const earned = expectedPoints.reduce((sum, p) => sum + (p.weight || 1) * (HIT_VALUE[hitById.get(p.id)] ?? 0), 0);
  return round1((earned / total) * 5);
}

// Quotes are compared against the transcript loosely: Whisper output and the
// model's copy can differ in punctuation, casing and the odd word.
export function evidenceSupported(evidence, answerText) {
  const quote = words(evidence);
  if (quote.length < 3) return false;
  const answer = words(answerText);
  if (answer.join(' ').includes(quote.join(' '))) return true;
  const vocabulary = new Set(answer);
  return quote.filter(w => vocabulary.has(w)).length / quote.length >= 0.8;
}

function normalizeRun(raw, question, answerText, qid, log) {
  const points = question.expectedPoints.map(p => {
    const got = (raw?.points || []).find(x => x.id === p.id);
    let hit = HIT_VALUE[got?.hit] !== undefined ? got.hit : 'none';
    let evidence = hit === 'none' ? '' : got?.evidence || '';
    if (hit !== 'none' && !evidenceSupported(evidence, answerText)) {
      log.push(`${qid}/${p.id}: "${hit}" dropped, quote not in transcript`);
      hit = 'none';
      evidence = '';
    }
    return { pointId: p.id, hit, evidence };
  });
  const rating = r => (Number.isFinite(r) ? Math.min(5, Math.max(1, Math.round(r))) : null);
  return {
    points,
    score        : scoreFromPoints(question.expectedPoints, points),
    communication: rating(raw?.communication),
    confidence   : rating(raw?.confidence),
    whatWentWell : clean(raw?.whatWentWell),
    missing      : Array.isArray(raw?.missing) ? raw.missing.map(clean).filter(Boolean) : [],
    feedback     : clean(raw?.feedback),
    sampleAnswer : clean(raw?.sampleAnswer)
  };
}

// Phases whose sample answer speaks about the student's own work. Technical
// answers legitimately contain numbers the student never said (0.75, O(n)).
const PERSONAL_PHASES = new Set(['intro', 'resume', 'behavioral']);

const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'million', 'lakh', 'crore'];
const NUMBER_RE = new RegExp(`\\d+(?:\\.\\d+)?|\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'gi');
const numbersIn = text => (text.replace(/\[[^\]]*\]/g, '').match(NUMBER_RE) || []).map(n => n.toLowerCase());

// Sentences in the sample answer carrying a number the student never said,
// with the offending values.
export function inventedFacts(sampleAnswer, knownText) {
  const known = new Set(numbersIn(knownText));
  return sampleAnswer.split(/(?<=[.!?])\s+/)
    .map(sentence => ({ sentence, inventedValues: [...new Set(numbersIn(sentence).filter(n => !known.has(n)))] }))
    .filter(f => f.inventedValues.length);
}

async function repairSampleAnswer(sampleAnswer, knownText, qid, log) {
  const facts = inventedFacts(sampleAnswer, knownText);
  if (!facts.length) return sampleAnswer;
  log.push(`${qid}: sample answer had ${facts.length} invented fact sentence(s), repairing`);
  try {
    const raw = await withRateLimitRetry(`repair ${qid}`, () =>
      groqJSON(buildSampleRepairMessages({ sampleAnswer, inventedFacts: facts }), { model: EVAL_MODEL, maxTokens: 1500, timeoutMs: 60000 }), log);
    const repaired = clean(raw?.sampleAnswer);
    if (repaired && !inventedFacts(repaired, knownText).length) return repaired;
  } catch (err) {
    log.push(`${qid}: repair failed: ${err.message}`);
  }
  // Still invented after repair: drop those sentences rather than show them.
  const bad = new Set(inventedFacts(sampleAnswer, knownText).map(f => f.sentence));
  log.push(`${qid}: dropped ${bad.size} unrepaired sentence(s) from sample answer`);
  return sampleAnswer.split(/(?<=[.!?])\s+/).filter(s => !bad.has(s)).join(' ');
}

async function evaluateQuestion(question, turns, { seniority, claim, log }) {
  const exchange = turns.map(t => ({
    interviewer: t.text,
    candidate  : t.answer?.trim() || '(no answer)',
    ...(t.kind === 'follow_up' ? { followUp: true } : {})
  }));
  const answerText = turns.map(t => t.answer || '').join(' ');
  const messages = buildAnswerEvalMessages({ question, exchange, seniority, claim });

  const gradeOnce = async () => normalizeRun(
    await withRateLimitRetry(`eval ${question.qid}`, () =>
      groqJSON(messages, { model: EVAL_MODEL, maxTokens: 3000, timeoutMs: 90000 }), log),
    question, answerText, question.qid, log
  );

  const runs = [];
  for (let i = 0; i < EVAL_RUNS; i++) runs.push(await gradeOnce());
  const scores = runs.map(r => r.score);
  if (runs.length > 1 && Math.max(...scores) - Math.min(...scores) > DISAGREEMENT) {
    log.push(`${question.qid}: runs disagree (${scores.join(', ')}), grading a third time`);
    runs.push(await gradeOnce());
  }

  const target = mean(runs.map(r => r.score));
  const chosen = runs.reduce((best, r) => (Math.abs(r.score - target) < Math.abs(best.score - target) ? r : best));
  const ratings = key => {
    const m = median(runs.map(r => r[key]).filter(v => v != null));
    return m == null ? null : Math.round(m);
  };

  const knownText = [answerText, claim?.claim, question.text, ...turns.map(t => t.text)].filter(Boolean).join(' ');
  const sampleAnswer = PERSONAL_PHASES.has(question.phase)
    ? await repairSampleAnswer(chosen.sampleAnswer, knownText, question.qid, log)
    : chosen.sampleAnswer;

  return {
    qid          : question.qid,
    reached      : true,
    pointsHit    : chosen.points,
    runScores    : runs.map(r => r.score),
    score        : chosen.score,
    communication: ratings('communication'),
    confidence   : ratings('confidence'),
    whatWentWell : chosen.whatWentWell,
    missing      : chosen.missing,
    feedback     : chosen.feedback,
    sampleAnswer
  };
}

export function computeDimensions(questions, perAnswer) {
  const phaseOf = new Map(questions.map(q => [q.qid, q.phase]));
  const reached = perAnswer.filter(a => a.reached && a.score != null);
  const pct = x => (x == null ? null : Math.round((x / 5) * 100));
  const ratingPct = x => (x == null ? null : Math.round(((x - 1) / 4) * 100));
  const phaseMean = phase => mean(reached.filter(a => phaseOf.get(a.qid) === phase).map(a => a.score));

  const weighted = reached
    .map(a => ({ score: a.score, weight: PHASE_WEIGHT[phaseOf.get(a.qid)] ?? 0 }))
    .filter(x => x.weight > 0);
  const weightSum = weighted.reduce((s, x) => s + x.weight, 0);

  return {
    dimensions: {
      technicalDepth   : pct(phaseMean('technical')),
      resumeCredibility: pct(phaseMean('resume')),
      behavioral       : pct(phaseMean('behavioral')),
      communication    : ratingPct(mean(reached.map(a => a.communication).filter(v => v != null))),
      confidence       : ratingPct(mean(reached.map(a => a.confidence).filter(v => v != null)))
    },
    overall: weightSum ? pct(weighted.reduce((s, x) => s + x.score * x.weight, 0) / weightSum) : null
  };
}

// Used when the synthesis call fails, so the report still ships.
function fallbackPrepPath(questions, perAnswer) {
  const byQid = new Map(questions.map(q => [q.qid, q]));
  return perAnswer
    .filter(a => a.reached && a.score != null && a.score < 3 && byQid.get(a.qid)?.phase !== 'intro')
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map(a => ({
      topic  : byQid.get(a.qid).topic,
      why    : `You scored ${a.score}/5 on: "${byQid.get(a.qid).text}"`,
      action : a.missing[0] ? `Practice explaining: ${a.missing[0]}` : 'Practice answering this out loud with a concrete example.',
      basedOn: [a.qid]
    }));
}

async function synthesize(interview, perAnswer, scores, log) {
  const byQid = new Map(perAnswer.map(a => [a.qid, a]));
  // "Skipped" comes from what the student did live, not from a zero score:
  // a confidently wrong answer also scores zero.
  const skipped = new Set();
  for (const q of interview.plan.questions) {
    const turns = interview.turns.filter(t => t.qid === q.qid);
    if (turns.length && turns.every(t => t.verdict === 'skip' || !t.answer?.trim())) skipped.add(q.qid);
  }
  const skillName = new Map(
    [...interview.parsed.jd.requiredSkills, ...interview.parsed.jd.niceToHave].map(s => [s.id, s.name])
  );
  const input = {
    role     : interview.role,
    seniority: interview.seniority,
    endReason: interview.live?.endReason,
    overall  : scores.overall,
    dimensions: scores.dimensions,
    jdSkillsMissingFromResume: interview.parsed.gap.gaps.map(id => skillName.get(id)).filter(Boolean),
    questions: interview.plan.questions
      .filter(q => q.phase !== 'closing')
      .map(q => {
        const a = byQid.get(q.qid);
        return a?.reached
          ? { qid: q.qid, phase: q.phase, topic: q.topic, question: q.text, tests: q.intent, score: a.score, missing: a.missing, skipped: skipped.has(q.qid) }
          : { qid: q.qid, phase: q.phase, topic: q.topic, question: q.text, notReached: true };
      })
  };

  const raw = await withRateLimitRetry('synthesis', () =>
    groqJSON(buildSynthesisMessages(input), { model: EVAL_MODEL, maxTokens: 3000, timeoutMs: 90000 }), log);

  const qids = new Set(interview.plan.questions.map(q => q.qid));
  const prepPath = (raw?.prepPath || [])
    .filter(p => p?.topic && p?.action)
    .map(p => ({ topic: p.topic, why: p.why || '', action: p.action, basedOn: (p.basedOn || []).filter(id => qids.has(id)) }))
    .slice(0, 6);

  if (!raw?.summary || !prepPath.length) throw new Error('synthesis returned no summary or prep path');
  return {
    summary     : clean(raw.summary),
    strengths   : (raw.strengths || []).map(clean).filter(Boolean).slice(0, 3),
    improvements: (raw.improvements || []).map(clean).filter(Boolean).slice(0, 3),
    prepPath    : prepPath.map(p => ({ ...p, topic: clean(p.topic), why: clean(p.why), action: clean(p.action) }))
  };
}

// No DB access: takes a lean interview, returns the evaluation fields.
export async function runEvaluation(interview) {
  const log = [];
  const claims = new Map(interview.parsed.resume.claims.map(c => [c.id, c]));
  const turnsByQid = new Map();
  for (const t of interview.turns) {
    if (!turnsByQid.has(t.qid)) turnsByQid.set(t.qid, []);
    turnsByQid.get(t.qid).push(t);
  }

  const perAnswer = [];
  for (const q of interview.plan.questions) {
    if (q.phase === 'closing') continue;
    const turns = turnsByQid.get(q.qid);
    if (!turns?.length) {
      perAnswer.push({ qid: q.qid, reached: false });
      continue;
    }
    perAnswer.push(await evaluateQuestion(q, turns, {
      seniority: interview.seniority,
      claim    : q.ref?.type === 'claim' ? claims.get(q.ref.id) : null,
      log
    }));
  }

  if (!perAnswer.some(a => a.reached)) throw new Error('no answered questions to evaluate');
  const scores = computeDimensions(interview.plan.questions, perAnswer);

  let synthesis;
  try {
    synthesis = await synthesize(interview, perAnswer, scores, log);
  } catch (err) {
    log.push(`synthesis failed, using fallback prep path: ${err.message}`);
    synthesis = { summary: '', strengths: [], improvements: [], prepPath: fallbackPrepPath(interview.plan.questions, perAnswer) };
  }

  return { perAnswer, ...scores, ...synthesis, log };
}

// Claims one interview in `evaluating` and scores it. Returns null when there
// is nothing to claim (already being evaluated, or out of attempts).
export async function evaluateInterview(interviewId) {
  const interview = await MockInterview.findOneAndUpdate(
    {
      _id: interviewId,
      status: 'evaluating',
      'evaluation.attempts': { $lt: MAX_ATTEMPTS },
      $or: [{ 'evaluation.startedAt': null }, { 'evaluation.startedAt': { $lt: new Date(Date.now() - STALE_MS) } }]
    },
    { $set: { 'evaluation.startedAt': new Date() }, $inc: { 'evaluation.attempts': 1 } },
    { new: true }
  ).lean();
  if (!interview) return null;

  try {
    const result = await runEvaluation(interview);
    await MockInterview.updateOne({ _id: interviewId }, {
      $set: {
        status                    : 'completed',
        'evaluation.perAnswer'    : result.perAnswer,
        'evaluation.dimensions'   : result.dimensions,
        'evaluation.overall'      : result.overall,
        'evaluation.summary'      : result.summary,
        'evaluation.strengths'    : result.strengths,
        'evaluation.improvements' : result.improvements,
        'evaluation.prepPath'     : result.prepPath,
        'evaluation.evaluatorModel': EVAL_MODEL,
        'evaluation.log'          : result.log,
        'evaluation.completedAt'  : new Date()
      }
    });
    return result;
  } catch (err) {
    const outOfAttempts = interview.evaluation.attempts >= MAX_ATTEMPTS;
    await MockInterview.updateOne({ _id: interviewId }, {
      $set: outOfAttempts
        ? { status: 'failed', failureReason: `evaluate: ${err.message}` }
        : { 'evaluation.startedAt': null },
      $push: { 'evaluation.log': `attempt ${interview.evaluation.attempts} failed: ${err.message}` }
    });
    throw err;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

export function sourceLabel(question, company) {
  switch (question.source) {
    case 'bank':
      return question.confidenceTier === 'commonly_asked'
        ? `Commonly asked at ${company}, reported by seniors`
        : `Asked at ${company}, reported by a senior`;
    case 'resume': return 'From your resume';
    case 'jd':     return 'From the job description';
    default:       return 'Standard interview question';
  }
}

// Retake progress against the previous attempt: score deltas, and before/after
// for each area the previous attempt was weak on and this one re-tested.
export function buildProgress(interview, parent) {
  if (!parent?.evaluation) return null;
  const delta = (now, before) => (now == null || before == null ? null : now - before);

  const scoresByKey = source => {
    const questionByQid = new Map(source.plan.questions.map(q => [q.qid, q]));
    const byKey = new Map();
    for (const a of source.evaluation.perAnswer || []) {
      const q = questionByQid.get(a.qid);
      if (!q || !a.reached || a.score == null) continue;
      const key = retestKey(q);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a.score);
    }
    return byKey;
  };
  const now = scoresByKey(interview);
  const before = scoresByKey(parent);

  const retested = weakAreas(parent)
    .filter(q => now.has(retestKey(q)))
    .map(q => {
      const key = retestKey(q);
      return {
        area  : areaLabel(q, interview),
        before: round1(mean(before.get(key))),
        after : round1(mean(now.get(key)))
      };
    });

  const dims = interview.evaluation.dimensions || {};
  const parentDims = parent.evaluation.dimensions || {};
  return {
    previousAttempt : parent.attempt,
    previousOverall : parent.evaluation.overall,
    overallDelta    : delta(interview.evaluation.overall, parent.evaluation.overall),
    dimensionDeltas : Object.fromEntries(Object.keys(dims).map(k => [k, delta(dims[k], parentDims[k])])),
    retested
  };
}

// What a locked report shows: scores and structure, enough to see where you
// stand. The summary, per-question feedback, sample answers, transcript and
// prep path are what paying unlocks.
export function buildReportPreview(report) {
  return {
    locked      : true,
    interviewId : report.interviewId,
    company     : report.company,
    role        : report.role,
    attempt     : report.attempt,
    completedAt : report.completedAt,
    endReason   : report.endReason,
    coverage    : report.coverage,
    overall     : report.overall,
    dimensions  : report.dimensions,
    seniorQuestions: report.seniorQuestions,
    progress    : report.progress && {
      previousAttempt: report.progress.previousAttempt,
      previousOverall: report.progress.previousOverall,
      overallDelta   : report.progress.overallDelta,
      dimensionDeltas: report.progress.dimensionDeltas
    },
    questions   : report.questions.map(q => ({
      qid: q.qid, phase: q.phase, question: q.question, sourceLabel: q.sourceLabel, reached: q.reached, score: q.score ?? null
    })),
    lockedSections: ['summary', 'strengths', 'improvements', 'prepPath', 'feedback', 'sampleAnswers', 'transcript']
  };
}

export function buildReport(interview, parent = null) {
  const evalByQid = new Map(interview.evaluation.perAnswer.map(a => [a.qid, a]));
  const turnsByQid = new Map();
  for (const t of interview.turns) {
    if (!turnsByQid.has(t.qid)) turnsByQid.set(t.qid, []);
    turnsByQid.get(t.qid).push({ interviewer: t.text, candidate: t.answer, followUp: t.kind === 'follow_up' });
  }

  const questions = interview.plan.questions.map(q => {
    const a = evalByQid.get(q.qid);
    const pointText = new Map(q.expectedPoints.map(p => [p.id, p.point]));
    return {
      qid        : q.qid,
      phase      : q.phase,
      topic      : q.topic,
      question   : q.text,
      sourceLabel: sourceLabel(q, interview.company),
      reached    : turnsByQid.has(q.qid),
      exchange   : turnsByQid.get(q.qid) || [],
      ...(a?.reached ? {
        score       : a.score,
        points      : a.pointsHit.map(p => ({ point: pointText.get(p.pointId), hit: p.hit, evidence: p.evidence })),
        whatWentWell: a.whatWentWell,
        missing     : a.missing,
        feedback    : a.feedback,
        sampleAnswer: a.sampleAnswer
      } : {})
    };
  });

  const scored = questions.filter(q => q.phase !== 'closing');
  return {
    interviewId : interview._id,
    company     : interview.company,
    role        : interview.role,
    attempt     : interview.attempt,
    completedAt : interview.evaluation.completedAt,
    endReason   : interview.live?.endReason,
    coverage    : { reached: scored.filter(q => q.reached).length, planned: scored.length },
    overall     : interview.evaluation.overall,
    dimensions  : interview.evaluation.dimensions,
    summary     : interview.evaluation.summary,
    strengths   : interview.evaluation.strengths,
    improvements: interview.evaluation.improvements,
    prepPath    : interview.evaluation.prepPath,
    coverageNote: interview.blueprint?.coverageNote || '',
    seniorQuestions: interview.plan.questions.filter(q => q.source === 'bank').length,
    progress    : buildProgress(interview, parent),
    questions
  };
}
