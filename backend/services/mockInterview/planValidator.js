import { CLAIM_QUOTA } from './plannerPrompts.js';

const PHASES = ['intro', 'resume', 'technical', 'behavioral', 'closing'];
const SOURCE_BY_REF ={ bank: 'bank', claim: 'resume', jd_skill: 'jd', core: 'core' };

const COMPANY_HEARSAY = /\b(usually|typically|often|always|known (to|for)|famous for|likes to|tends to)\b[^.?!]{0,60}\b(ask|asks|asked|interview|interviews|hire|hires|test|tests)\b/i;

const STOPWORDS = new Set(('a an the and or of to in on for with your you did do how what why which when that this is are was were ' +
  'can could would about it its as at by from be have has had any me us our we i').split(' '));
const stem = w => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/s$/, '') : w);
const contentWords = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .filter(w => w && !STOPWORDS.has(w)).map(stem));
const jaccard = (a, b) => {
  const shared = [...a].filter(w => b.has(w)).length;
  return shared / (a.size + b.size - shared || 1);
};
// Share of content words two questions must have in common to count as a
// light rephrase of each other.
const NEAR_DUPLICATE = 0.6;

// Hard checks on planner output. Returns normalized questions ready for
// MockInterview.plan.questions, errors (the plan can't be used) and warnings
// (worth one revision, but never fail the plan).
export function validatePlan(plan, { plannerInput, bankCandidates, company }) {
  const errors = [];
  const warnings = [];
  const questions = Array.isArray(plan?.questions) ? plan.questions : [];
  if (!questions.length) return { questions: [], errors: ['Plan has no questions'], warnings };

  const ids = {
    bank    : new Map(bankCandidates.map(b => [b.planId, b])),
    claim   : new Set(plannerInput.resume.claims.map(c => c.id)),
    jd_skill: new Set([...plannerInput.jd.requiredSkills, ...plannerInput.jd.niceToHave].map(s => s.id)),
    core    : new Set(plannerInput.coreTopics.map(t => t.id))
  };
  const contextIds = new Set(plannerInput.jd.companyContext.map(c => c.id));
  const companyRe  = company ? new RegExp(`\\b${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;

  const out = questions.map((q, i) => {
    const tag = q.qid || `#${i + 1}`;
    const refType = q.ref?.type;
    const refId   = q.ref?.id;

    if (!PHASES.includes(q.phase)) errors.push(`${tag}: invalid phase "${q.phase}"`);
    if (!q.text || !q.intent || !q.topic) errors.push(`${tag}: missing text, intent or topic`);
    if (!SOURCE_BY_REF[refType]) errors.push(`${tag}: invalid ref.type "${refType}"`);
    else if (refType === 'bank' ? !ids.bank.has(refId) : !ids[refType].has(refId)) {
      errors.push(`${tag}: ref id "${refId}" does not exist in input ${refType} items`);
    }

    for (const cc of q.companyContextIds || []) {
      if (!contextIds.has(cc)) errors.push(`${tag}: companyContextId "${cc}" does not exist`);
    }

    if (refType !== 'bank') {
      if (COMPANY_HEARSAY.test(q.text || '')) errors.push(`${tag}: implies how the company interviews; only bank questions may do that`);
      if (companyRe && refId !== 'core.why_company' && companyRe.test(q.text || '')) {
        errors.push(`${tag}: names the company in a non-bank question`);
      }
    }

    const bookend = q.phase === 'intro' || q.phase === 'closing';
    const points = q.expectedPoints || [];
    const minPoints = bookend ? 2 : 3;
    if (points.length < minPoints || points.length > 5) errors.push(`${tag}: needs ${minPoints}-5 expected points, has ${points.length}`);
    if (!(q.difficulty >= 1 && q.difficulty <= 5)) errors.push(`${tag}: difficulty must be 1-5`);
    if (!bookend && (!q.followUps?.shallow || !q.followUps?.wrong || !q.followUps?.strongDeeper)) {
      errors.push(`${tag}: missing follow-ups`);
    }
    if ((q.text || '').split(/\s+/).length > 35) errors.push(`${tag}: question longer than 35 words`);

    const bank = refType === 'bank' ? ids.bank.get(refId) : null;
    return {
      qid              : q.qid || `q${i + 1}`,
      order            : i + 1,
      phase            : q.phase,
      source           : SOURCE_BY_REF[refType],
      ref              : { type: refType, id: refId },
      bankEntryId      : bank?._id || null,
      confidenceTier   : bank ? (bank.reportCount >= 2 ? 'commonly_asked' : 'reported_once') : null,
      companyContextIds: q.companyContextIds || [],
      topic            : q.topic,
      intent           : q.intent,
      difficulty       : q.difficulty,
      text             : q.text,
      expectedPoints   : points,
      followUps        : {
        shallow     : q.followUps?.shallow || '',
        wrong       : bookend ? '' : q.followUps?.wrong || '',
        strongDeeper: bookend ? '' : q.followUps?.strongDeeper || ''
      },
      maxFollowUps     : bookend ? 1 : 2
    };
  });

  const perPhase = plannerInput.interview.perPhase;
  for (const [phase, count] of Object.entries(perPhase)) {
    const got = out.filter(q => q.phase === phase).length;
    if (got !== count) errors.push(`phase ${phase}: expected ${count} questions, got ${got}`);
  }

  const probing = out.filter(q => q.phase === 'resume' || q.phase === 'technical');
  if (probing.length) {
    const claimShare = probing.filter(q => q.ref.type === 'claim').length / probing.length;
    if (claimShare < CLAIM_QUOTA) errors.push(`only ${Math.round(claimShare * 100)}% of resume+technical questions target claims, need ${CLAIM_QUOTA * 100}%`);
  }
  for (const q of out.filter(q => q.phase === 'resume' && q.ref.type !== 'claim')) {
    errors.push(`${q.qid}: resume-phase questions must target a claim`);
  }

  const wantedClaims = plannerInput.interview.resumeClaimIds || [];
  const resumeClaims = out.filter(q => q.phase === 'resume' && q.ref.type === 'claim').map(q => q.ref.id);
  const missingClaims = wantedClaims.filter(id => !resumeClaims.includes(id));
  if (missingClaims.length) errors.push(`resume phase must ask about claims ${missingClaims.join(', ')} (one question each)`);
  const usedClaims = new Set(out.filter(q => q.ref.type === 'claim').map(q => q.ref.id));
  const claimRepeats = out.filter(q => q.ref.type === 'claim').length - usedClaims.size;
  if (claimRepeats > 0) errors.push(`${claimRepeats} claim(s) asked about more than once`);

  const bankUsed =out.filter(q => q.source === 'bank').length;
  if (bankUsed > plannerInput.bank.bankSlots) errors.push(`uses ${bankUsed} bank questions, limit is ${plannerInput.bank.bankSlots}`);

  const gaps = new Set(plannerInput.gap.gaps);
  if (gaps.size && perPhase.technical > 0 && !out.some(q => q.ref.type === 'jd_skill' && gaps.has(q.ref.id))) {
    errors.push('no technical question targets a JD gap skill');
  }

  const retest = new Set(plannerInput.retake?.retestTopics || []);
  const seenTopics = new Map();
  for (const q of out) {
    if (seenTopics.has(q.topic) && !retest.has(q.topic)) errors.push(`${q.qid}: repeats topic "${q.topic}" from ${seenTopics.get(q.topic)}`);
    else seenTopics.set(q.topic, q.qid);
  }

  if (plannerInput.retake) {
    for (const t of [...retest].slice(0, 3)) {
      if (!out.some(q => q.topic === t)) errors.push(`retake: retest topic "${t}" not covered`);
    }
    // Intro and closing are the same every time by nature; everything else must be new.
    const previous = plannerInput.retake.previousQuestions.map(contentWords);
    for (const q of out.filter(q => q.phase !== 'intro' && q.phase !== 'closing')) {
      const words = contentWords(q.text);
      const match = previous.findIndex(p => jaccard(words, p) >= NEAR_DUPLICATE);
      if (match !== -1) {
        warnings.push(`${q.qid}: too close to an earlier attempt's question ("${plannerInput.retake.previousQuestions[match]}"); ask from a different angle`);
      }
    }
  }

  return { questions: out, errors, warnings };
}
