// Mock interview preparation: parse JD + resume, then build and check the
// question plan.
//
//   prepareInterview(id)
//     parseInterview  draft  → parsing  → parsed   (JD parse, resume parse, gap)
//     planInterview   parsed → planning → planned  (bank, planner, validator, critic, revise)
//
// Each step claims its status with an atomic update, so a double click or a
// retry can't run the same step twice at once.
import MockInterview from '../../models/MockInterview.js';
import InterviewBankEntry from '../../models/InterviewBankEntry.js';
import { groqJSON } from '../../utils/groqClient.js';
import { SUPPORTED_ROLE_FAMILIES, CORE_TOPICS, getRoleFamilySheet } from '../../config/mockInterviewTopics.js';
import { buildJdParseMessages, buildResumeParseMessages } from './parserPrompts.js';
import { validateJdParse, validateResumeParse } from './parseValidator.js';
import { buildPlannerInput, buildPlannerMessages, buildCriticMessages, buildReviseMessages, mergeRevision } from './plannerPrompts.js';
import { validatePlan } from './planValidator.js';
import { weakAreas } from './retake.js';
import { pickCodingProblem } from '../../config/codingProblems.js';
import { pickSqlProblem } from '../../config/sqlProblems.js';

const PARSER_MODEL  = process.env.MOCK_PARSER_MODEL  || 'openai/gpt-oss-120b';
const PLANNER_MODEL = process.env.MOCK_PLANNER_MODEL || 'openai/gpt-oss-120b';

// Groq's current tier caps each org at 8000 tokens per minute, and a single
// request over that fails outright (413). Keep every prep request under it.
const REQUEST_TOKEN_BUDGET = Number(process.env.MOCK_PREP_REQUEST_BUDGET) || 7000;
const PLANNER_MAX_TOKENS   = 5000;
const CRITIC_MAX_TOKENS    = 1200;
const REVISE_MAX_TOKENS    = 2500;

// Waits after each rate-limited attempt: ~90s total before giving up.
const RETRY_DELAYS_MS = [15000, 30000, 45000];
const RETRY_JITTER_MS = 5000;
const MAX_BAD_JSON_RETRIES = 2;

const MAX_REVISIONS   = 2;
const MAX_RETEST_TOPICS      = 3;
const MAX_PREVIOUS_QUESTIONS = 40;
const BANK_CANDIDATES = 15;
const MIN_CLAIMS      = 3;

const COMPANY_SUFFIXES = /\b(private|pvt|limited|ltd|inc|llc|llp|corp|corporation|technologies|technology|tech|solutions|india|labs|software|services)\b\.?/g;

export function normalizeCompany(name) {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function claimStatus(interviewId, from, to) {
  const doc = await MockInterview.findOneAndUpdate(
    { _id: interviewId, status: from },
    { $set: { status: to, failureReason: '' } },
    { new: true }
  );
  if (!doc) throw new Error(`Interview ${interviewId} is not in status "${from}"`);
  return doc;
}

async function fail(interviewId, reason) {
  await MockInterview.updateOne({ _id: interviewId }, { $set: { status: 'failed', failureReason: reason } });
}

// groqClient already rotates across keys; a 429 reaching here means every key
// is rate-limited. Groq's limit is per minute, so waiting it out usually works.
// Prep runs before the interview, so the student only sees a longer loader.
// Anything other than 429 (including 413, request too large) is not retried.
// Also retries Groq's json_validate_failed (a 400 when the model's JSON-mode
// output doesn't parse): the same request usually succeeds on a second try.
export async function withRateLimitRetry(label, fn, log = [], delaysMs = RETRY_DELAYS_MS) {
  let badJsonRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (/json_validate_failed/.test(err.message || '') && badJsonRetries < MAX_BAD_JSON_RETRIES) {
        badJsonRetries++;
        log.push(`${label}: model returned invalid JSON, retry ${badJsonRetries}/${MAX_BAD_JSON_RETRIES}`);
        continue;
      }
      if ((err.status || err.response?.status) !== 429 || attempt >= delaysMs.length) throw err;
      const wait = delaysMs[attempt] + Math.floor(Math.random() * RETRY_JITTER_MS);
      log.push(`${label}: rate limited, retry ${attempt + 1}/${delaysMs.length} in ${Math.round(wait / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

// ── Parse ────────────────────────────────────────────────────────────────────

export async function parseInterview(interviewId) {
  const interview = await claimStatus(interviewId, 'draft', 'parsing');
  const { jdText, resumeText } = interview.inputs;
  const log = [];

  try {
    if (!jdText?.trim() || !resumeText?.trim()) throw new Error('JD text and resume text are both required');

    const jdRaw = await withRateLimitRetry('jd parse', () => groqJSON(
      buildJdParseMessages({ jdText, company: interview.company, role: interview.role, supportedRoleFamilies: SUPPORTED_ROLE_FAMILIES }),
      { model: PARSER_MODEL, maxTokens: 3000, timeoutMs: 60000 }
    ), log);
    const jd = validateJdParse(jdRaw, { jdText, supportedRoleFamilies: SUPPORTED_ROLE_FAMILIES });
    const jdSkills = [...jd.jd.requiredSkills, ...jd.jd.niceToHave];
    if (!jdSkills.length) {
      // No skills extracted — log it and continue. The planner falls back to a
      // resume-only interview (same path as "unsupported" role family) rather
      // than failing the whole interview.
      log.push(`JD parse: 0 skills extracted (model returned ${(jdRaw?.requiredSkills?.length || 0) + (jdRaw?.niceToHave?.length || 0)}; dropped: ${jd.dropped.slice(0, 5).join(' | ') || 'none'}). Falling back to resume-only interview.`);
      jd.meta.roleFamily = 'unsupported';
    }

    const resumeRaw = await withRateLimitRetry('resume parse', () => groqJSON(
      buildResumeParseMessages({ resumeText, jdSkills }),
      { model: PARSER_MODEL, maxTokens: 6000, timeoutMs: 90000 }
    ), log);
    const resume = validateResumeParse(resumeRaw, { resumeText, jdSkills });
    if (resume.resume.claims.length < MIN_CLAIMS) {
      // Fewer claims than ideal — log and continue rather than failing. The
      // planner will use whatever claims exist; the interview may be shorter
      // on the resume phase but will still run.
      log.push(`Resume parse: only ${resume.resume.claims.length} claim(s) found (model returned ${resumeRaw?.claims?.length || 0}; dropped: ${resume.dropped.slice(0, 5).join(' | ') || 'none'}). Proceeding with available claims.`);
    }

    // The candidate explicitly asked for a "tech"/"analytics" interview, but the
    // JD didn't parse into a role family with a technical phase (unrelated JD
    // wording, or 0 skills extracted). Force one so there's still a technical
    // slot to put the mandatory DSA/SQL exercise into — the category the
    // candidate picked should win over a JD that didn't say much.
    if (!SUPPORTED_ROLE_FAMILIES.includes(jd.meta.roleFamily)) {
      if (interview.interviewCategory === 'tech') {
        log.push(`roleFamily was "${jd.meta.roleFamily}"; forced to "sde" because the candidate picked the Tech category`);
        jd.meta.roleFamily = 'sde';
      } else if (interview.interviewCategory === 'analytics') {
        log.push(`roleFamily was "${jd.meta.roleFamily}"; forced to "data" because the candidate picked the Analytics category`);
        jd.meta.roleFamily = 'data';
      }
    }

    interview.company    = jd.meta.company || interview.company;
    interview.role       = jd.meta.role || interview.role;
    interview.seniority  = jd.meta.seniority;
    interview.roleFamily = jd.meta.roleFamily;
    interview.parsed     = { jd: jd.jd, resume: resume.resume, gap: resume.gap, log: [...log, ...jd.dropped, ...resume.dropped] };
    interview.status     = 'parsed';
    await interview.save();
    return interview;
  } catch (err) {
    await MockInterview.updateOne({ _id: interviewId }, { $set: { 'parsed.log': log } });
    await fail(interviewId, `parse: ${err.message}`);
    throw err;
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

async function loadBankCandidates(interview) {
  const companyNormalized = normalizeCompany(interview.company);
  if (!companyNormalized) return [];

  const supported = SUPPORTED_ROLE_FAMILIES.includes(interview.roleFamily);
  const filter = { companyNormalized, status: 'approved' };
  filter.$or = supported
    ? [{ roleFamily: interview.roleFamily }, { roundType: { $in: ['hr', 'managerial'] } }]
    : [{ roundType: { $in: ['hr', 'managerial'] } }];

  const entries = await InterviewBankEntry.find(filter)
    .sort({ reportCount: -1, updatedAt: -1 })
    .limit(BANK_CANDIDATES)
    .lean();

  return entries.map((e, i) => ({ ...e, planId: `b${i + 1}` }));
}

// A retake re-tests what the previous attempt was weak on: weak resume claims
// go first in the resume phase (via resumeClaimIds), weak topics must reappear.
// No question from any earlier attempt in the chain may be repeated.
async function loadRetake(interview) {
  if (!interview.parentInterviewId) return null;
  const parent = await MockInterview.findById(interview.parentInterviewId).select('plan evaluation').lean();
  if (!parent) return null;

  const rootId = interview.rootInterviewId || interview.parentInterviewId;
  const chain = await MockInterview.find({ $or: [{ _id: rootId }, { rootInterviewId: rootId }], _id: { $ne: interview._id } })
    .select('plan.questions.text createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const weak = weakAreas(parent);
  return {
    retestTopics     : [...new Set(weak.filter(q => q.ref?.type !== 'claim').map(q => q.topic))].slice(0, MAX_RETEST_TOPICS),
    retestClaimIds   : weak.filter(q => q.ref?.type === 'claim').map(q => q.ref.id),
    previousQuestions: chain.flatMap(i => (i.plan?.questions || []).map(q => q.text)).slice(0, MAX_PREVIOUS_QUESTIONS)
  };
}

function buildBlueprint(interview, questions) {
  const skillName = new Map(
    [...interview.parsed.jd.requiredSkills, ...interview.parsed.jd.niceToHave].map(s => [s.id, s.name])
  );
  const bankHits = questions.filter(q => q.source === 'bank').length;
  const supported = SUPPORTED_ROLE_FAMILIES.includes(interview.roleFamily);

  const notes = [];
  notes.push(bankHits
    ? `${bankHits} question${bankHits > 1 ? 's' : ''} in this interview ${bankHits > 1 ? 'were' : 'was'} reported by seniors who interviewed at ${interview.company}.`
    : `No senior-reported questions exist yet for ${interview.company || 'this company'}. This interview is built from your JD and resume.`);
  if (!supported) notes.push('Technical questions for this role are not available yet, so this interview goes deeper into your own projects instead.');

  return {
    strengths: interview.parsed.gap.matches.map(id => skillName.get(id)).filter(Boolean),
    weakSpots: [
      ...interview.parsed.gap.gaps.map(id => `${skillName.get(id)} is in the JD but not on your resume`),
      ...interview.parsed.resume.claims
        .filter(c => c.defensibilityRisk === 'high')
        .map(c => `Be ready to defend: "${c.claim}"`)
    ],
    bankHits,
    coverageNote: notes.join(' ')
  };
}

// Rough prompt-token estimate (~3.5 chars per token for JSON-heavy prompts).
const estimateTokens = messages => Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5);

async function callBudgeted(label, messages, maxTokens, log) {
  const estimate = estimateTokens(messages);
  if (estimate > REQUEST_TOKEN_BUDGET) log.push(`${label}: ~${estimate} prompt tokens, over the ${REQUEST_TOKEN_BUDGET} budget`);
  return withRateLimitRetry(label, () => groqJSON(messages, { model: PLANNER_MODEL, maxTokens, timeoutMs: 120000 }), log);
}

// Draft → validator + critic → targeted revisions. No DB access, so it can be
// exercised directly with a hand-built plannerInput.
export async function generatePlan(context, log = []) {
  const { plannerInput } = context;

  let plan = await callBudgeted('planner', buildPlannerMessages(plannerInput), PLANNER_MAX_TOKENS, log);
  let result = validatePlan(plan, context);

  // The critic is the optional step: skipped when its request wouldn't fit the budget.
  let criticRounds = 0;
  let criticIssues = [];
  const criticMessages = buildCriticMessages(plannerInput, plan);
  if (estimateTokens(criticMessages) + CRITIC_MAX_TOKENS <= REQUEST_TOKEN_BUDGET) {
    const critic = await callBudgeted('critic', criticMessages, CRITIC_MAX_TOKENS, log);
    criticRounds = 1;
    if (critic?.pass === false && Array.isArray(critic.issues)) criticIssues = critic.issues;
  } else {
    log.push('critic skipped: request over budget');
  }
  log.push(`draft: ${result.errors.length} validator errors, ${result.warnings.length} warnings, ${criticIssues.length} critic issues`,
    ...result.errors, ...result.warnings, ...criticIssues.map(i => `critic ${i.qid}/${i.check}: ${i.problem}`));

  // Warnings ride along with the first revision only; errors keep revising.
  const asIssues = (list, check) => list.map(problem => ({ check, problem }));
  let issues = [...asIssues(result.errors, 'validator'), ...asIssues(result.warnings, 'validator-soft'), ...criticIssues];
  for (let round = 1; issues.length && round <= MAX_REVISIONS; round++) {
    const revision = await callBudgeted(`revision ${round}`, buildReviseMessages(plannerInput, plan, issues), REVISE_MAX_TOKENS, log);
    plan = mergeRevision(plan, revision);
    result = validatePlan(plan, context);
    log.push(`revision ${round}: changed ${revision?.questions?.length || 0}, removed ${revision?.remove?.length || 0}, ${result.errors.length} validator errors, ${result.warnings.length} warnings`);
    issues = asIssues(result.errors, 'validator');
  }

  if (result.errors.length) {
    log.push(...result.errors);
    throw new Error(`Plan still invalid after ${MAX_REVISIONS} revisions: ${result.errors.slice(0, 3).join('; ')}`);
  }
  if (result.warnings.length) log.push('accepted with warnings:', ...result.warnings);
  return { result, criticRounds };
}

const SENIORITY_DIFFICULTY = { intern: 2, fresher: 2, experienced: 3 };

// Turns a curated bank problem into a plan question shaped like validator
// output, reusing the slot (qid/order/phase) of the technical question it
// replaces. Grading happens through the code/SQL panel, not the voice judge,
// so follow-ups are empty and the interviewer just reads the prompt aloud.
function toInjectedQuestion(slot, { type, problem }) {
  return {
    ...slot,
    source        : type,
    ref           : { type, id: problem.id },
    bankEntryId   : null,
    confidenceTier: null,
    companyContextIds: [],
    topic         : problem.topics[0],
    intent        : type === 'coding' ? 'Tests DSA problem-solving with runnable code, not just talking through it.' : 'Tests hands-on SQL, not just talking through it.',
    difficulty    : problem.difficulty,
    text          : `${problem.title}. ${problem.prompt} Use the code editor that just opened — run it, and either submit once it passes or let me know if you'd like to move on.`,
    expectedPoints: [
      { id: 'p1', point: 'Arrives at a solution that passes the test cases.', weight: 3 },
      { id: 'p2', point: 'Explains the approach and its complexity/trade-offs if asked.', weight: 2 }
    ],
    followUps   : { shallow: '', wrong: '', strongDeeper: '' },
    maxFollowUps: 0
  };
}

// If the interview's category mandates a coding or SQL exercise and the LLM
// plan doesn't already have one (it never will — planner prompts forbid code),
// swap the last technical-phase question for one pulled from the curated
// bank. Done in code so test cases are always real and runnable.
export function injectCodingExercise(questions, { interviewCategory, seniority, excludeIds = {} }) {
  const wantsCoding = interviewCategory === 'tech';
  const wantsSql = interviewCategory === 'analytics';
  if (!wantsCoding && !wantsSql) return questions;

  const technicalIdx = [...questions.keys()].filter(i => questions[i].phase === 'technical');
  if (!technicalIdx.length) return questions;
  const difficulty = SENIORITY_DIFFICULTY[seniority] ?? 2;
  let out = [...questions];
  let injectedQid = null;

  if (wantsCoding && !out.some(q => q.ref?.type === 'coding')) {
    const problem = pickCodingProblem({ difficulty, excludeIds: excludeIds.coding });
    if (problem) {
      const slotIdx = technicalIdx[0];
      out[slotIdx] = toInjectedQuestion(out[slotIdx], { type: 'coding', problem });
      injectedQid = out[slotIdx].qid;
    }
  }
  if (wantsSql && !out.some(q => q.ref?.type === 'sql_exercise')) {
    const problem = pickSqlProblem({ difficulty, excludeIds: excludeIds.sql });
    if (problem) {
      const slotIdx = technicalIdx[0];
      out[slotIdx] = toInjectedQuestion(out[slotIdx], { type: 'sql_exercise', problem });
      injectedQid = out[slotIdx].qid;
    }
  }
  // A "tech"/"analytics" candidate expects the coding challenge to show up
  // early, not after a full resume deep-dive — move it to right after intro
  // (before the resume phase) instead of leaving it at the end of technical.
  if (injectedQid) out = moveRightAfterIntro(out, injectedQid);
  return out;
}

function moveRightAfterIntro(questions, qid) {
  const idx = questions.findIndex(q => q.qid === qid);
  if (idx === -1) return questions;
  const [moved] = questions.splice(idx, 1);
  const introEnd = questions.reduce((last, q, i) => (q.phase === 'intro' ? i + 1 : last), 0);
  questions.splice(introEnd, 0, moved);
  return questions.map((q, i) => ({ ...q, order: i + 1 }));
}

export async function planInterview(interviewId) {
  const interview = await claimStatus(interviewId, 'parsed', 'planning');
  const log = [];

  try {
    const bankCandidates = await loadBankCandidates(interview);
    const retake = await loadRetake(interview);

    const plannerInput = buildPlannerInput({
      interview,
      roleFamilySheet: getRoleFamilySheet(interview.roleFamily),
      coreTopics: CORE_TOPICS,
      bankCandidates,
      bankSlots: 0,
      retake
    });
    const { technical, behavioral } = plannerInput.interview.perPhase;
    plannerInput.bank.bankSlots = Math.min(bankCandidates.length, Math.floor((technical + behavioral) / 2));

    const context = { plannerInput, bankCandidates, company: interview.company };
    const { result, criticRounds } = await generatePlan(context, log);

    const questions = injectCodingExercise(result.questions, {
      interviewCategory: interview.interviewCategory, seniority: interview.seniority
    });
    if (questions !== result.questions) log.push(`injected a curated ${interview.interviewCategory} exercise into the technical phase`);

    interview.plan = {
      questions,
      plannerModel : PLANNER_MODEL,
      criticRounds,
      validationLog: log,
      plannedAt    : new Date()
    };
    if (retake) interview.retestTopics = retake.retestTopics;
    interview.blueprint = buildBlueprint(interview, questions);
    interview.status = 'planned';
    await interview.save();
    return interview;
  } catch (err) {
    await MockInterview.updateOne({ _id: interviewId }, { $set: { 'plan.validationLog': log } });
    await fail(interviewId, `plan: ${err.message}`);
    throw err;
  }
}

export async function prepareInterview(interviewId) {
  await parseInterview(interviewId);
  return planInterview(interviewId);
}
