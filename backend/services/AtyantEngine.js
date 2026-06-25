import User from '../models/User.js';
import Question from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import MatchLog from '../models/MatchLog.js';
import { sendMentorNewQuestionNotification } from '../utils/emailNotifications.js';
import { getQuestionEmbedding } from './AIService.js';
import aiServiceInstance from './AIService.js';
import { normalizeCollege, isSameBranch, normalizeBranch } from '../utils/collegeNormalizer.js';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';

// ─────────────────────────────────────────────
//  DEV / DEBUG LOGGER
// ─────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';
const alwaysDebug = process.env.DEBUG_MATCHING === '1' || process.env.DEBUG_MATCHING === 'true';
function dlog(...args) { if (isDev || alwaysDebug) console.log(...args); }

// ─────────────────────────────────────────────
//  COMPANY CACHE
// ─────────────────────────────────────────────
let COMPANY_CACHE = null;
let COMPANY_CACHE_TIME = 0;
const COMPANY_TTL = 6 * 60 * 60 * 1000;
const COMPANY_LOOKUP = new Map();

// ─────────────────────────────────────────────
//  MENTOR CACHE + INVERTED INDEX  ← NEW
// ─────────────────────────────────────────────
let MENTOR_CACHE = null;
let MENTOR_CACHE_TIME = 0;
const MENTOR_TTL = 5 * 60 * 1000;

// Inverted index for O(1) candidate lookup
let MENTOR_INDEX = {
  byCompany: new Map(), // 'amazon'      → Set<mentorId>
  byDomain: new Map(), // 'internship'  → Set<mentorId>
  byTag: new Map(), // 'iit'         → Set<mentorId>
  byBranch: new Map(), // 'metallurgy'  → Set<mentorId>  (normalized)
  byCollege: new Map(), // 'nit nagpur'  → Set<mentorId>  (normalized, alias-aware)
};

// ─────────────────────────────────────────────
//  VECTOR RESULT CACHE
// ─────────────────────────────────────────────
const VECTOR_CACHE = new LRUCache({
  max: 1000,
  ttl: 10 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  SEMANTIC_FLOOR: 0.85,
  INSTANT_THRESHOLD: 0.88,
  VECTOR_CANDIDATES: 80,
  VECTOR_LIMIT: 25,
  LIVE_MATCH_THRESHOLD: 100,
  LOAD_PENALTY: 60,
  MAX_LOAD: 10,
  MIN_SCORE_GAP: 0.04,
  AMBIGUITY_THRESHOLD: 0.03,
  TOP_MATCH_CONFIDENCE: 0.92,
  MAX_RETRIES: 2,
  MIN_CANDIDATE_POOL: 5,   // ← if intersection too small, fallback to union

  WEIGHTS: {
    EXACT_COMPANY: 0.12,
    RELATED_COMPANY: 0.06,
    EXACT_DOMAIN: 0.08,
    PARTIAL_DOMAIN: 0.04,
    SPECIAL_TAG: 0.05,
    MILESTONE: 0.04,
    EXPERTISE: 0.06,
    BIO_DENSITY: 0.03,
    SAME_COLLEGE: 0.10,   // ← exact same college (alias-aware) — "exactly like you"
    COLLEGE_TYPE: 0.05,   // same tier (both NIT, both IIT, …)
    SAME_BRANCH: 0.08,    // ← branch drives field relevance (CSE≠EEE) — must rival college
    HIGH_RATING: 0.05,
    HIGH_RESPONSE: 0.04,
    RECENT_ACTIVE: 0.03,
    FEEDBACK_BONUS: 0.08,  // ← NEW: good feedback adds up to 8%
    OUTCOME: 0.08,         // ← verified outcome success rate (the moat signal)
  },

  LIVE_WEIGHTS: {
    EXACT_COMPANY: 700,
    RELATED_COMPANY: 350,
    SPECIAL_TAG: 500,
    EXACT_DOMAIN: 200,
    PARTIAL_DOMAIN: 150,
    MILESTONE: 200,
    EXPERTISE_EXACT: 250,
    EXPERTISE_PARTIAL: 125,
    BIO_KEYWORD: 60,
    SAME_COLLEGE: 400,    // ← exact same college (alias-aware) — strong "exactly like you" signal
    COLLEGE_TYPE: 120,    // same tier (both NIT, both IIT, …)
    SAME_BRANCH: 250,     // ← branch drives field relevance (CSE≠EEE) — must rival college
    HIGH_RATING: 120,
    HIGH_RESPONSE: 100,
    RECENT_ACTIVE: 70,
    PROVEN_MENTOR: 150,
    FEEDBACK_BONUS: 200, // ← NEW: good feedback adds points
    OUTCOME_PROVEN: 500, // ← scaled by outcomeScore: mentors whose advice verifiably WORKED
    COLD_START_BOOST: 100, // ← NEW: new mentors get a boost
    GOAL_MATCH: 700,    // ← NEW: mentor actually did the EXACT thing in the goal (e.g. IIM for an IIM goal)
  },
};

// Distinctive institution / path tokens that, when named in a student's GOAL,
// should decisively favour a mentor who actually did THAT specific thing — not a
// look-alike (an IIM goal must beat an IIT credential, not tie it).
const GOAL_SIGNAL_TAGS = [
  'iim', 'iit', 'iiit', 'bits', 'isb',
  'faang', 'maang', 'google', 'amazon', 'microsoft', 'meta', 'apple', 'netflix',
  'mba', 'mtech', 'phd', 'gate', 'gre', 'gmat', 'cat', 'upsc',
  'consulting', 'quant', 'trading', 'fintech', 'product',
  'research', 'startup', 'foreign', 'abroad', 'gsoc',
];

// Pull the distinctive goal tokens the student actually named in their GOAL text.
function extractGoalSignals(goalText) {
  if (!goalText) return [];
  const t = String(goalText).toLowerCase();
  return GOAL_SIGNAL_TAGS.filter(tag => new RegExp(`\\b${tag}\\b`, 'i').test(t) || t.includes(tag));
}

// ─────────────────────────────────────────────
//  COMPANY ALIASES
// ─────────────────────────────────────────────
const COMPANY_ALIASES = {
  google: ['google', 'alphabet', 'gcp', 'youtube'],
  microsoft: ['microsoft', 'msft', 'azure', 'linkedin'],
  amazon: ['amazon', 'aws', 'amzn', 'prime'],
  meta: ['meta', 'facebook', 'fb', 'instagram', 'whatsapp', 'ig'],
  apple: ['apple', 'aapl', 'iphone', 'mac'],
  netflix: ['netflix', 'nflx'],
  nvidia: ['nvidia', 'nvda'],
  tesla: ['tesla', 'tsla'],
  jpmorgan: ['jpmorgan', 'jp morgan', 'jpm', 'chase', 'jpmchase', 'j.p. morgan', 'jpmorgan chase'],
  goldmansachs: ['goldman sachs', 'goldman', 'gs'],
  morganstanley: ['morgan stanley', 'ms', 'morganstanley'],
  citadel: ['citadel', 'citadel securities'],
  janestreet: ['jane street', 'janestreet'],
  tower: ['tower research', 'tower'],
  uber: ['uber', 'uber technologies'],
  airbnb: ['airbnb'],
  snowflake: ['snowflake'],
  databricks: ['databricks'],
  stripe: ['stripe'],
  coinbase: ['coinbase'],
  flipkart: ['flipkart', 'walmart india'],
  swiggy: ['swiggy'],
  zomato: ['zomato'],
  paytm: ['paytm', 'one97'],
  ola: ['ola', 'ola electric', 'ola cabs'],
  cred: ['cred'],
  razorpay: ['razorpay'],
  phonepe: ['phonepe'],
  atlassian: ['atlassian', 'jira', 'confluence', 'trello'],
  adobe: ['adobe', 'adbe'],
  salesforce: ['salesforce', 'crm'],
  oracle: ['oracle', 'orcl'],
  sap: ['sap'],
  intuit: ['intuit', 'quickbooks', 'turbotax'],
  servicenow: ['servicenow', 'now'],
  cisco: ['cisco', 'csco'],
  vmware: ['vmware', 'broadcom'],
  redhat: ['redhat', 'red hat', 'ibm'],
  qualcomm: ['qualcomm', 'qcom'],
  intel: ['intel', 'intc'],
  amd: ['amd', 'advanced micro devices'],
  deshaw: ['de shaw', 'deshaw', 'd.e. shaw'],
  mckinsey: ['mckinsey', 'mckinsey & company'],
  bcg: ['bcg', 'boston consulting'],
  bain: ['bain', 'bain & company'],
};

const TECH_KEYWORDS = [
  'python', 'java', 'javascript', 'c++', 'cpp', 'golang', 'rust', 'kotlin',
  'swift', 'typescript', 'scala', 'ruby', 'php',
  'react', 'angular', 'vue', 'nextjs', 'django', 'flask', 'fastapi',
  'spring', 'springboot', 'nodejs', 'express', 'nestjs',
  'machine learning', 'ml', 'deep learning', 'dl', 'nlp', 'computer vision',
  'tensorflow', 'pytorch', 'keras', 'scikit', 'pandas', 'numpy',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform',
  'jenkins', 'ci/cd', 'devops', 'ansible',
  'sql', 'mysql', 'postgresql', 'mongodb', 'redis', 'cassandra',
  'dynamodb', 'elasticsearch',
  'dsa', 'data structures', 'algorithms', 'system design', 'hld', 'lld',
  'oops', 'dbms', 'operating system', 'os', 'networks', 'computer networks',
  'backend', 'frontend', 'fullstack', 'mobile', 'android', 'ios',
  'data science', 'data engineering', 'sde', 'swe', 'devops engineer',
  'quant', 'quantitative', 'trading', 'fintech',
];

const SPECIAL_TAGS = [
  'iit', 'nit', 'iiit', 'bits', 'iim', 'dtu', 'nsut', 'vit',
  'faang', 'maang', 'foreign', 'abroad', 'usa', 'europe', 'canada', 'germany',
  'startup', 'unicorn', 'series-a', 'early-stage',
  'on-campus', 'off-campus', 'ppo', 'pre-placement',
  'masters', 'ms', 'mtech', 'mba', 'phd', 'research',
  'gate', 'gre', 'gmat', 'cat', 'upsc',
  'consulting', 'product', 'quant', 'trading', 'fintech',
  'competitive programming', 'cp', 'hackathon', 'open source',
  'gsoc', 'leetcode', 'codeforces', 'kaggle',
  'career switch', 'domain switch', 'company switch',
];

// ─────────────────────────────────────────────
//  INTENT (internship vs placement)
//  Module-level so the live query analyzer AND the answer-card intent detector
//  share ONE source of truth — they must never drift apart.
// ─────────────────────────────────────────────
const INTERNSHIP_PATTERNS = ['internship', 'intern', 'summer internship', 'winter internship', 'intern offer', 'internship offer', 'intern prep'];
const PLACEMENT_PATTERNS = ['placement', 'job', 'full time', 'full-time', 'ft role', 'ft offer', 'job offer', 'campus placement', 'recruitment'];

function detectIntentFromText(text) {
  const t = String(text || '').toLowerCase();
  const internMatches = INTERNSHIP_PATTERNS.filter(p => t.includes(p)).length;
  const placeMatches = PLACEMENT_PATTERNS.filter(p => t.includes(p)).length;
  if (internMatches > placeMatches && internMatches > 0) return 'internship';
  if (placeMatches > 0) return 'placement';
  return 'general';
}

// An answer card's intent: prefer the stored domain, else derive from its text.
// Legacy cards (created before `domain` existed) default to 'general' in the DB,
// so we re-detect from the answer content — but a card that doesn't clearly read
// as the opposite intent stays 'general' and is never wrongly filtered out.
function cardIntent(card) {
  if (card?.domain && card.domain !== 'general') return card.domain;
  const ac = card?.answerContent || {};
  const text = [
    ac.mainAnswer, ac.situation, ac.firstAttempt, ac.whatWorked,
    ac.timeline, ac.differentApproach, ac.additionalNotes,
  ].filter(Boolean).join(' ');
  return detectIntentFromText(text);
}

// Hard intent gate. A CONFIDENT internship/placement query must NOT be served a
// card of the opposite intent — this is what served placement answers to interns.
// General queries never conflict; general/unknown cards never conflict.
function intentConflict(queryIntent, theCardIntent) {
  if (queryIntent !== 'internship' && queryIntent !== 'placement') return false;
  if (!theCardIntent || theCardIntent === 'general') return false;
  return theCardIntent !== queryIntent;
}

// ─────────────────────────────────────────────
//  UTILITY FUNCTIONS
// ─────────────────────────────────────────────
// Auto-generate lookup variants from a mentor-entered company name so new
// companies are routable WITHOUT editing the hardcoded alias dict:
//   "Tata Consultancy Services" → tataconsultancyservices, tcs (acronym),
//   "Zoho Corporation Pvt Ltd"  → zohocorporationpvtltd, zoho (suffix-stripped)
const COMPANY_SUFFIX_WORDS = new Set([
  'technologies', 'technology', 'tech', 'labs', 'lab', 'india', 'pvt', 'ltd',
  'limited', 'inc', 'llc', 'solutions', 'software', 'systems', 'services',
  'private', 'corp', 'corporation', 'company', 'co', 'group', 'global',
]);

function companyAliasVariants(raw) {
  const variants = new Set();
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return variants;
  const words = clean.split(' ');
  // Core name with generic suffix words stripped
  const core = words.filter(w => !COMPANY_SUFFIX_WORDS.has(w));
  if (core.length > 0 && core.length < words.length) variants.add(core.join(''));
  // Acronym for 3+ word names ("tata consultancy services" → "tcs")
  if (words.length >= 3) {
    const acro = words.map(w => w[0]).join('');
    if (acro.length >= 3) variants.add(acro);
  }
  return variants;
}

function normalizeCompany(company) {
  if (!company || typeof company !== 'string') return '';
  const clean = company.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
  for (const [key, aliases] of Object.entries(COMPANY_ALIASES)) {
    if (aliases.some(a => a.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '') === clean)) return key;
  }
  return clean;
}

function getCollegeType(collegeName) {
  if (!collegeName) return 'unknown';
  const n = collegeName.toLowerCase();
  if (n.includes('iit')) return 'iit';
  if (n.includes('nit')) return 'nit';
  if (n.includes('iiit')) return 'iiit';
  if (n.includes('bits')) return 'bits';
  if (n.includes('iim')) return 'iim';
  const tier1 = ['dtu', 'nsut', 'vit', 'manipal', 'thapar', 'rvce', 'pec', 'coep', 'vnit'];
  if (tier1.some(t => n.includes(t))) return 'tier1';
  return 'tier2';
}

// Generic / placeholder college values that must NOT count as a same-college match.
const GENERIC_COLLEGE = new Set(['', 'other', 'others', 'na', 'n/a', 'none', 'unknown']);

// EXACT same college (alias-aware via collegeNormalizer), not just same tier.
// "VNIT Nagpur" === "vnit" === "Visvesvaraya NIT" → true. "Other" === "Other" → false.
function isSameCollege(a, b) {
  if (!a || !b) return false;
  const ca = normalizeCollege(a).toLowerCase();
  const cb = normalizeCollege(b).toLowerCase();
  return ca === cb && !GENERIC_COLLEGE.has(ca);
}

// Resolve the student's education for scoring. Prefers the logged-in user's DB
// profile, but falls back to the context collected in the chat (college/branch/
// year) so same-college / same-branch are credited even for logged-out users.
// Without this, a guest's college/branch contributed ZERO to the match score.
async function resolveStudentEdu(studentId, studentContext = null) {
  let dbEdu = {};
  if (studentId) {
    try {
      const student = await User.findById(studentId).select('education').lean();
      dbEdu = student?.education?.[0] || {};
    } catch { /* fall back to context */ }
  }
  return {
    ...dbEdu,
    institutionName: dbEdu.institutionName || dbEdu.institution || studentContext?.college || null,
    field:           dbEdu.field           || studentContext?.branch  || null,
    year:            dbEdu.year             || studentContext?.year    || null,
  };
}

function extractSmartKeywords(text) {
  const stopwords = new Set([
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'as', 'are', 'was', 'were',
    'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'should', 'could', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for',
    'with', 'from', 'by', 'about', 'into', 'through', 'during', 'before',
    'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
    'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own',
    'same', 'than', 'too', 'very', 'just', 'but', 'what', 'get', 'got', 'help',
    'want', 'need', 'know', 'like', 'kaise', 'kya', 'hai', 'hain', 'mujhe',
    'bhai', 'yaar', 'bro', 'plz', 'pls',
  ]);
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w))
  )].slice(0, 25);
}

function isRecentlyActive(lastActive, days = 14) {
  if (!lastActive) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return new Date(lastActive) > cutoff;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fire-and-forget routing log — every match decision with its full candidate
// set becomes training data. Must NEVER slow down or fail a match.
function logMatch(entry) {
  MatchLog.create(entry).catch(err => dlog('MatchLog write failed:', err.message));
}

// ─────────────────────────────────────────────
//  INVERTED INDEX BUILDER  ← NEW
// ─────────────────────────────────────────────
function buildMentorIndex(mentors) {
  const byCompany = new Map();
  const byDomain = new Map();
  const byTag = new Map();
  const byBranch = new Map();
  const byCollege = new Map();

  for (const mentor of mentors) {
    const id = mentor._id.toString();

    // Company index
    for (const company of (mentor.topCompanies || [])) {
      const key = normalizeCompany(company);
      if (!key) continue;
      if (!byCompany.has(key)) byCompany.set(key, new Set());
      byCompany.get(key).add(id);
    }

    // Domain index — 'both' goes into internship AND placement
    const d = mentor.primaryDomain;
    if (d) {
      const domains = d === 'both' ? ['internship', 'placement', 'both'] : [d];
      for (const domain of domains) {
        if (!byDomain.has(domain)) byDomain.set(domain, new Set());
        byDomain.get(domain).add(id);
      }
    }

    // Tag index
    for (const tag of (mentor.specialTags || [])) {
      const key = tag.toLowerCase().trim();
      if (!byTag.has(key)) byTag.set(key, new Set());
      byTag.get(key).add(id);
    }

    const mEdu = mentor.education?.[0] || {};

    // Branch index — normalized so "MME" and "Metallurgy …" land in one bucket
    const branch = normalizeBranch(mEdu.field);
    if (branch) {
      if (!byBranch.has(branch)) byBranch.set(branch, new Set());
      byBranch.get(branch).add(id);
    }

    // College index — normalized/alias-aware ("vnit" === "nit nagpur")
    const college = normalizeCollege(mEdu.institutionName || mEdu.institution).toLowerCase();
    if (college && !GENERIC_COLLEGE.has(college)) {
      if (!byCollege.has(college)) byCollege.set(college, new Set());
      byCollege.get(college).add(id);
    }
  }

  dlog(`✅ Index built — Companies:${byCompany.size} Domains:${byDomain.size} Tags:${byTag.size} Branches:${byBranch.size} Colleges:${byCollege.size}`);
  return { byCompany, byDomain, byTag, byBranch, byCollege };
}

// ─────────────────────────────────────────────
//  CANDIDATE FILTER  ← NEW (replaces scoring all mentors)
//  "Amazon internship" → intersection of amazon ∩ internship
// ─────────────────────────────────────────────
function getCandidateMentors(allMentors, queryDetails, studentEdu = null) {
  const { intent, mentionedCompanies, relatedCompanies, foundTags } = queryDetails;
  const mentorMap = new Map(allMentors.map(m => [m._id.toString(), m]));

  // "Someone exactly like you" — same-college and same-branch mentors must ALWAYS
  // be candidates, even when the query has no company/domain/tag signal. Otherwise
  // a perfect background match could be filtered out before scoring ever runs.
  const identityIds = new Set();
  if (studentEdu) {
    const sCollege = normalizeCollege(studentEdu.institutionName || '').toLowerCase();
    if (sCollege && !GENERIC_COLLEGE.has(sCollege)) {
      (MENTOR_INDEX.byCollege.get(sCollege) || new Set()).forEach(id => identityIds.add(id));
    }
    const sBranch = normalizeBranch(studentEdu.field);
    if (sBranch) {
      (MENTOR_INDEX.byBranch.get(sBranch) || new Set()).forEach(id => identityIds.add(id));
    }
  }

  const companyIds = new Set();
  const domainIds = new Set();
  const tagIds = new Set();

  // Gather company candidates
  for (const company of [...mentionedCompanies, ...relatedCompanies]) {
    (MENTOR_INDEX.byCompany.get(company) || new Set()).forEach(id => companyIds.add(id));
  }

  // Gather domain candidates
  if (intent && intent !== 'general') {
    (MENTOR_INDEX.byDomain.get(intent) || new Set()).forEach(id => domainIds.add(id));
  }

  // Gather tag candidates
  for (const tag of foundTags) {
    (MENTOR_INDEX.byTag.get(tag) || new Set()).forEach(id => tagIds.add(id));
  }

  const hasCompany = companyIds.size > 0;
  const hasDomain = domainIds.size > 0;
  const hasTag = tagIds.size > 0;

  let candidateIds;
  let strategy;

  if (hasCompany && hasDomain) {
    // "Amazon internship" → INTERSECTION (most precise)
    candidateIds = new Set([...companyIds].filter(id => domainIds.has(id)));
    strategy = 'intersection';

    // If intersection too small, fall back to union
    if (candidateIds.size < CONFIG.MIN_CANDIDATE_POOL) {
      candidateIds = new Set([...companyIds, ...domainIds]);
      strategy = 'union-fallback';
    }
  } else if (hasCompany) {
    candidateIds = companyIds;
    strategy = 'company-only';
  } else if (hasDomain) {
    candidateIds = domainIds;
    strategy = 'domain-only';
  } else if (hasTag) {
    candidateIds = tagIds;
    strategy = 'tag-only';
  } else if (identityIds.size > 0) {
    // No query signal, but we know the student's college/branch → use those.
    candidateIds = new Set();
    strategy = 'identity-only';
  } else {
    // Fully general question, no identity → score everyone
    dlog(`⚠️ No signals — scoring all ${allMentors.length} mentors`);
    return allMentors;
  }

  // Always include tag matches as supplementary candidates
  if (hasTag && candidateIds.size < 20) {
    tagIds.forEach(id => candidateIds.add(id));
  }

  // ALWAYS fold in same-college / same-branch mentors so "someone exactly like
  // you" is never filtered out by the query-signal pre-filter.
  identityIds.forEach(id => candidateIds.add(id));

  const candidates = [...candidateIds].map(id => mentorMap.get(id)).filter(Boolean);

  dlog(`🎯 Candidates: ${allMentors.length} → ${candidates.length} [${strategy}${identityIds.size ? ` +${identityIds.size} identity` : ''}]`);
  return candidates;
}

// ─────────────────────────────────────────────
//  MATCH % CALIBRATION
//  Map raw points → a 1–99% confidence with diminishing returns. Tuned so a
//  same-college + same-branch ("exactly like you") match (~600 pts) reads ~70%,
//  a college-only match reads ~55%, and a full goal+company+college match
//  approaches the high 90s. K=500 controls the curve's steepness.
// ─────────────────────────────────────────────
function pointsToMatchPct(points) {
  if (!points || points <= 0) return 0;
  const pct = 99 * (1 - Math.exp(-points / 500));
  return Math.max(12, Math.min(99, Math.round(pct)));
}

// ─────────────────────────────────────────────
//  CORE MENTOR SCORER  ← NEW (DRY — used by both findBestMentor & findTopMentors)
// ─────────────────────────────────────────────
function scoreMentor(mentor, context) {
  const {
    questionCategory, mentionedCompanies, relatedCompanies,
    foundTags, mentionedTech, intent, confidence,
    keywords, studentCollegeType, sEdu, goalSignals = [],
  } = context;

  let points = 0;
  const breakdown = [];
  const LW = CONFIG.LIVE_WEIGHTS;

  // ── EXACT GOAL ALIGNMENT ── the single most important signal: did this mentor
  // actually do the specific thing the student's GOAL names? "IIM internship" must
  // reward a mentor whose tag/company IS IIM, and NOT an IIT/IISc look-alike.
  if (goalSignals.length) {
    const hay = [
      ...(mentor.specialTags || []),
      ...(mentor.topCompanies || []),
      ...(mentor.milestones || []),
      mentor.bio || '',
      mentor.companyDomain || '',
    ].join(' ').toLowerCase();
    const aligned = goalSignals.filter(g => new RegExp(`\\b${g}\\b`, 'i').test(hay) || hay.includes(g));
    if (aligned.length) {
      const p = LW.GOAL_MATCH * aligned.length;
      points += p; breakdown.push(`GoalMatch(${aligned.join(',')})+${p}`);
    }
  }

  // Company domain match
  if (questionCategory && mentor.companyDomain === questionCategory) {
    points += 800; breakdown.push(`ExactDomain(+800)`);
  }

  // Company matching
  const mentorCompanies = (mentor.topCompanies || []).map(normalizeCompany);
  const exactCount = mentorCompanies.filter(mc => mentionedCompanies.includes(mc)).length;
  const relatedCount = mentorCompanies.filter(mc => relatedCompanies.includes(mc)).length;

  if (exactCount > 0) { const p = LW.EXACT_COMPANY * exactCount; points += p; breakdown.push(`ExactCo(+${p})`); }
  else if (relatedCount > 0) { const p = LW.RELATED_COMPANY * relatedCount; points += p; breakdown.push(`RelatedCo(+${p})`); }

  // Special tags
  const tagCount = (mentor.specialTags || []).filter(
    tag => foundTags.some(ft => tag.toLowerCase().includes(ft))
  ).length;
  if (tagCount > 0) { const p = LW.SPECIAL_TAG * tagCount; points += p; breakdown.push(`Tags(+${p})`); }

  // Domain intent
  if (intent && intent !== 'general') {
    if (mentor.primaryDomain === intent) {
      const p = Math.round(LW.EXACT_DOMAIN * confidence); points += p; breakdown.push(`Domain(+${p})`);
    } else if (mentor.primaryDomain === 'both') {
      const p = Math.round(LW.PARTIAL_DOMAIN * confidence); points += p; breakdown.push(`BothDomain(+${p})`);
    }
  }

  // Milestones
  const milestoneCount = (mentor.milestones || []).filter(
    m => foundTags.some(ft => m.toLowerCase().includes(ft))
  ).length;
  if (milestoneCount > 0) { const p = LW.MILESTONE * milestoneCount; points += p; breakdown.push(`Milestones(+${p})`); }

  // Expertise
  const expExact = (mentor.expertise || []).filter(exp => mentionedTech.some(t => exp.toLowerCase() === t)).length;
  const expPartial = (mentor.expertise || []).filter(exp => mentionedTech.some(t => exp.toLowerCase().includes(t))).length - expExact;
  if (expExact > 0) { const p = LW.EXPERTISE_EXACT * expExact; points += p; breakdown.push(`ExactTech(+${p})`); }
  if (expPartial > 0) { const p = LW.EXPERTISE_PARTIAL * expPartial; points += p; breakdown.push(`PartialTech(+${p})`); }

  // Bio keywords — capped so a long, keyword-stuffed bio can't out-rank a precise
  // credential. Background/goal alignment should decide ranking, not bio verbosity.
  const bioCount = keywords.filter(kw => mentor.bio?.toLowerCase().includes(kw)).length;
  if (bioCount >= 3) { const p = LW.BIO_KEYWORD * Math.min(bioCount, 3); points += p; breakdown.push(`Bio(+${p})`); }

  // College — exact same college (strong) stacks on top of same tier
  const mEdu = mentor.education?.[0] || {};
  if (isSameCollege(sEdu.institutionName, mEdu.institutionName)) {
    points += LW.SAME_COLLEGE; breakdown.push(`SameCollege(+${LW.SAME_COLLEGE})`);
  }
  const mentorCollegeType = getCollegeType(mEdu.institutionName);
  if (studentCollegeType === mentorCollegeType && studentCollegeType !== 'unknown') {
    points += LW.COLLEGE_TYPE; breakdown.push(`${studentCollegeType.toUpperCase()}(+${LW.COLLEGE_TYPE})`);
  }

  // Same branch (alias-aware: "MME" === "Metallurgy and Materials Engineering")
  if (isSameBranch(sEdu.field, mEdu.field)) {
    points += LW.SAME_BRANCH; breakdown.push(`Branch(+${LW.SAME_BRANCH})`);
  }

  // Quality signals
  if (mentor.rating >= 4.5) { points += LW.HIGH_RATING; breakdown.push(`★${mentor.rating}(+${LW.HIGH_RATING})`); }
  if (mentor.responseRate >= 85) { points += LW.HIGH_RESPONSE; breakdown.push(`Response(+${LW.HIGH_RESPONSE})`); }
  if (isRecentlyActive(mentor.lastActive)) { points += LW.RECENT_ACTIVE; breakdown.push(`Active(+${LW.RECENT_ACTIVE})`); }

  // Proven track record
  if ((mentor.successfulMatches || 0) >= 10) {
    const bonus = Math.min(Math.floor(mentor.successfulMatches / 10), 5) * LW.PROVEN_MENTOR;
    points += bonus; breakdown.push(`Proven(+${bonus})`);
  }

  // ── FEEDBACK LOOP SCORING ← NEW ──────────────
  // feedbackScore is a float 0.0–1.0 stored on mentor after each answer
  // helpfulCount / totalAnswered = feedbackScore
  const feedbackScore = mentor.feedbackScore || 0;
  const totalAnswered = mentor.totalAnswered || 0;
  const ratedCount = mentor.feedbackCount || 0;

  if (ratedCount >= 3) {
    // Enough RATED answers to trust feedback (totalAnswered counts unrated ones too)
    if (feedbackScore >= 0.8) {
      const p = LW.FEEDBACK_BONUS; points += p; breakdown.push(`Feedback★(+${p})`);
    } else if (feedbackScore < 0.4) {
      // Bad feedback → heavy penalty
      const penalty = Math.round(LW.FEEDBACK_BONUS * 1.5);
      points -= penalty; breakdown.push(`FeedbackBad(-${penalty})`);
    }
  } else if (totalAnswered === 0) {
    // Brand new mentor — cold start boost so they get a chance
    points += LW.COLD_START_BOOST; breakdown.push(`ColdStart(+${LW.COLD_START_BOOST})`);
  }

  // ── VERIFIED OUTCOMES ── the moat signal: students who followed this mentor's
  // advice actually achieved the goal. Scaled by smoothed success rate, gated on
  // ≥3 reported outcomes so one lucky result can't dominate.
  if ((mentor.outcomeCount || 0) >= 3) {
    const p = Math.round(LW.OUTCOME_PROVEN * (mentor.outcomeScore || 0));
    if (p > 0) { points += p; breakdown.push(`Outcome(+${p})`); }
  }

  // Load penalty
  const load = mentor.activeQuestions || 0;
  if (load >= CONFIG.MAX_LOAD) {
    const oldPoints = points;
    points = Math.floor(points * 0.25);
    breakdown.push(`OVERLOADED(-${oldPoints - points},${load}Q)`);
  } else if (load > 0) {
    const penalty = load * CONFIG.LOAD_PENALTY;
    points -= penalty;
    breakdown.push(`Load(-${penalty},${load}Q)`);
  }

  return { mentor, points, logs: breakdown.join(' | '), load };
}

// ─────────────────────────────────────────────
//  COMPANY CACHE LOADER
// ─────────────────────────────────────────────
async function getAllTargetCompanies() {
  try {
    const now = Date.now();
    if (COMPANY_CACHE && (now - COMPANY_CACHE_TIME) < COMPANY_TTL) return COMPANY_CACHE;

    const mentors = await User.find({ role: 'mentor' }).select('topCompanies').lean();
    const allCompanies = mentors.flatMap(m =>
      Array.isArray(m.topCompanies) ? m.topCompanies.filter(c => typeof c === 'string') : []
    );

    COMPANY_CACHE = [...new Set(allCompanies.map(normalizeCompany))].filter(Boolean);
    COMPANY_CACHE_TIME = now;

    COMPANY_LOOKUP.clear();
    // 1. Hand-curated aliases win (set first, never overwritten)
    for (const c of COMPANY_CACHE) {
      const aliases = COMPANY_ALIASES[c] || [c];
      aliases.forEach(a => {
        COMPANY_LOOKUP.set(a.toLowerCase().replace(/[^a-z0-9]/g, ''), c);
      });
    }
    // 2. Auto-generated variants from raw mentor-entered names — makes a new
    //    company routable the moment one mentor lists it, no dict edit needed.
    for (const raw of new Set(allCompanies)) {
      const canonical = normalizeCompany(raw);
      if (!canonical) continue;
      for (const v of companyAliasVariants(raw)) {
        if (v.length >= 2 && !COMPANY_LOOKUP.has(v)) COMPANY_LOOKUP.set(v, canonical);
      }
    }

    dlog(`✅ Company cache rebuilt (${COMPANY_CACHE.length} companies)`);
    return COMPANY_CACHE;
  } catch (err) {
    console.error('getAllTargetCompanies error:', err);
    return [];
  }
}

// ─────────────────────────────────────────────
//  MENTOR CACHE LOADER (also rebuilds index)
// ─────────────────────────────────────────────
async function getActiveMentors() {
  try {
    const now = Date.now();
    if (MENTOR_CACHE && (now - MENTOR_CACHE_TIME) < MENTOR_TTL) {
      dlog(`💾 Mentor cache hit (${MENTOR_CACHE.length} mentors)`);
      return MENTOR_CACHE;
    }

    const mentors = await User.find({
      role: 'mentor',
      mentorListed: { $ne: false }, // exclude mentors still finishing onboarding
      $and: [
        {
          $or: [
            { activeQuestions: { $exists: false } },
            { activeQuestions: null },
            { activeQuestions: { $lt: CONFIG.MAX_LOAD + 2 } },
          ],
        },
        {
          $or: [
            { lastActive: { $exists: false } },
            { lastActive: null },
            { lastActive: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
          ],
        },
      ],
    })
      .select(
        'username name profilePicture avatar email education primaryDomain topCompanies milestones specialTags ' +
        'expertise bio activeQuestions rating responseRate lastActive successfulMatches ' +
        'companyDomain feedbackScore totalAnswered feedbackCount outcomeScore outcomeCount'
      )
      .lean();

    MENTOR_CACHE = mentors;
    MENTOR_CACHE_TIME = now;
    MENTOR_INDEX = buildMentorIndex(mentors); // ← rebuild index on every cache refresh

    dlog(`✅ Mentor cache + index rebuilt (${mentors.length} mentors)`);
    return mentors;
  } catch (err) {
    console.error('getActiveMentors error:', err);
    return [];
  }
}

function invalidateMentorCache() {
  MENTOR_CACHE = null;
  MENTOR_CACHE_TIME = 0;
}

// Patch a mentor's load in the cache instead of nuking it. A full invalidate on
// every assignment forced a mentor reload + index rebuild on the NEXT question,
// driving the cache hit rate to zero under load. Other stat drift (rating,
// feedbackScore) self-heals on the 5-min TTL refresh.
function adjustCachedMentorLoad(mentorId, delta) {
  if (!MENTOR_CACHE) return;
  const id = mentorId.toString();
  const m = MENTOR_CACHE.find(x => x._id.toString() === id);
  if (m) m.activeQuestions = Math.max(0, (m.activeQuestions || 0) + delta);
}

// ─────────────────────────────────────────────
//  EMBEDDED ANSWER-CARD EXISTENCE CHECK
//  Was a countDocuments on EVERY question — one extra DB roundtrip per ask.
//  Once true it stays true (cards are never bulk-deleted), so cache hard.
// ─────────────────────────────────────────────
let HAS_EMBEDDED_CARDS = false;
let HAS_EMBEDDED_CARDS_CHECKED = 0;
const EMBEDDED_CHECK_TTL = 10 * 60 * 1000;

async function hasEmbeddedAnswerCards() {
  if (HAS_EMBEDDED_CARDS) return true;
  const now = Date.now();
  if (now - HAS_EMBEDDED_CARDS_CHECKED < EMBEDDED_CHECK_TTL) return HAS_EMBEDDED_CARDS;
  HAS_EMBEDDED_CARDS_CHECKED = now;
  const one = await AnswerCard.exists({ embedding: { $exists: true, $ne: null, $not: { $size: 0 } } });
  HAS_EMBEDDED_CARDS = !!one;
  return HAS_EMBEDDED_CARDS;
}

// ─────────────────────────────────────────────
//  MAIN ENGINE CLASS
// ─────────────────────────────────────────────
class AtyantEngine {

  /* =============================================
      🧠 DEEP QUERY ANALYSIS
     ============================================= */
  async detectQueryDetails(text) {
    const t = text.toLowerCase();

    const internMatches = INTERNSHIP_PATTERNS.filter(p => t.includes(p)).length;
    const placeMatches = PLACEMENT_PATTERNS.filter(p => t.includes(p)).length;

    let intent, confidence;
    if (internMatches > placeMatches && internMatches > 0) {
      intent = 'internship'; confidence = Math.min(internMatches / INTERNSHIP_PATTERNS.length, 1);
    } else if (placeMatches > 0) {
      intent = 'placement'; confidence = Math.min(placeMatches / PLACEMENT_PATTERNS.length, 1);
    } else {
      intent = 'general'; confidence = 0.3;
    }

    const mentionedCompanies = [];
    const relatedCompanies = [];

    const tClean = t.replace(/[^a-z0-9\s]/g, '');
    const tokens = tClean.split(/\s+/);
    const tokenSet = new Set(tokens);

    for (const token of tokenSet) {
      const clean = token.replace(/[^a-z0-9]/g, '');
      if (COMPANY_LOOKUP.has(clean)) {
        const key = COMPANY_LOOKUP.get(clean);
        if (!mentionedCompanies.includes(key)) mentionedCompanies.push(key);
      }
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = (tokens[i] + tokens[i + 1]).replace(/[^a-z0-9]/g, '');
      const trigram = i < tokens.length - 2
        ? (tokens[i] + tokens[i + 1] + tokens[i + 2]).replace(/[^a-z0-9]/g, '')
        : null;

      for (const gram of [bigram, trigram].filter(Boolean)) {
        if (COMPANY_LOOKUP.has(gram)) {
          const key = COMPANY_LOOKUP.get(gram);
          if (!mentionedCompanies.includes(key) && !relatedCompanies.includes(key)) {
            relatedCompanies.push(key);
          }
        }
      }
    }

    const foundTags = SPECIAL_TAGS.filter(tag => t.includes(tag));
    const mentionedTech = TECH_KEYWORDS.filter(tech => t.includes(tech));

    return {
      intent, confidence, mentionedCompanies, relatedCompanies,
      foundTags, mentionedTech,
      isUrgent: /urgent|asap|immediate|quickly|fast/.test(t),
      isDetailOriented: text.length > 200,
      hasSpecifics: mentionedCompanies.length > 0 || mentionedTech.length > 2,
      questionLength: text.length,
    };
  }

  /* =============================================
      🔥 PATH A: VECTOR SEMANTIC MATCHING
     ============================================= */
  async findBestSemanticMatch(studentId, vector, questionText, studentContext = null, diag = null) {
    try {
      const sEdu = await resolveStudentEdu(studentId, studentContext);
      const studentCollegeType = getCollegeType(sEdu.institutionName);

      // Cache key MUST include the student's college/branch — the cached result
      // has same-college / same-branch bonuses baked in. Keying on question text
      // alone served Student A's personalized match to Student B.
      const cacheKey = crypto.createHash('sha1')
        .update(`${questionText}|${normalizeCollege(sEdu.institutionName || '').toLowerCase()}|${normalizeBranch(sEdu.field) || ''}`)
        .digest('hex');
      if (VECTOR_CACHE.has(cacheKey)) {
        dlog(`💾 VECTOR CACHE HIT`);
        return VECTOR_CACHE.get(cacheKey);
      }

      const queryDetails = await this.detectQueryDetails(questionText);
      const { intent, confidence, mentionedCompanies, relatedCompanies,
        foundTags, mentionedTech, isUrgent, hasSpecifics } = queryDetails;

      dlog(`\n🔎 ===== VECTOR SEMANTIC SEARCH =====`);
      dlog(`Intent: ${intent} | Companies: [${mentionedCompanies}] | Tags: [${foundTags.slice(0, 5)}]`);

      if (!(await hasEmbeddedAnswerCards())) {
        dlog(`❌ No AnswerCards with embeddings`);
        return null;
      }

      const dynamicCandidates = isUrgent ? 120 : hasSpecifics ? 80 : 50;

      const candidates = await AnswerCard.aggregate([
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'embedding',
            queryVector: vector,
            numCandidates: dynamicCandidates,
            limit: CONFIG.VECTOR_LIMIT,
            filter: {},
          },
        },
        {
          $project: {
            answerContent: 1,
            mentorId: 1,
            questionId: 1,
            domain: 1,
            createdAt: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ]);

      dlog(`Atlas returned ${candidates.length} candidates`);
      if (candidates.length === 0) return null;

      const mentorIds = [...new Set(candidates.map(c => c.mentorId.toString()))];
      const mentors = await User.find({ _id: { $in: mentorIds }, role: 'mentor' })
        .select('username avatar bio education primaryDomain topCompanies milestones ' +
          'specialTags expertise rating responseRate lastActive successfulMatches ' +
          'companyDomain feedbackScore totalAnswered feedbackCount outcomeScore outcomeCount')
        .lean();
      const mentorMap = new Map(mentors.map(m => [m._id.toString(), m]));

      const keywords = extractSmartKeywords(questionText);
      const W = CONFIG.WEIGHTS;
      const scoredMatches = [];

      for (const match of candidates) {
        if (match.score < CONFIG.SEMANTIC_FLOOR) continue;
        // HARD intent gate: never let a placement card answer an internship query
        // (or vice-versa). This is the fix for interns getting placement answers.
        if (intentConflict(intent, cardIntent(match))) {
          dlog(`⏭️  Skip card ${match._id} — intent conflict (q=${intent}, card=${cardIntent(match)})`);
          continue;
        }
        const mentor = mentorMap.get(match.mentorId.toString());
        if (!mentor) continue;

        let totalBonus = 0;
        const bonusLogs = [];

        const mentorCompanies = (mentor.topCompanies || []).map(normalizeCompany);
        const exactCo = mentorCompanies.filter(mc => mentionedCompanies.includes(mc)).length;
        const relatedCo = mentorCompanies.filter(mc => relatedCompanies.includes(mc)).length;

        if (exactCo > 0) { const b = W.EXACT_COMPANY * Math.min(exactCo, 3); totalBonus += b; bonusLogs.push(`ExactCo(+${(b * 100).toFixed(1)}%)`); }
        else if (relatedCo > 0) { const b = W.RELATED_COMPANY * Math.min(relatedCo, 2); totalBonus += b; bonusLogs.push(`RelatedCo(+${(b * 100).toFixed(1)}%)`); }

        if (mentor.primaryDomain === intent) { const b = W.EXACT_DOMAIN * confidence; totalBonus += b; bonusLogs.push(`Domain(+${(b * 100).toFixed(1)}%)`); }
        else if (mentor.primaryDomain === 'both') { const b = W.PARTIAL_DOMAIN * confidence; totalBonus += b; bonusLogs.push(`BothDomain(+${(b * 100).toFixed(1)}%)`); }

        const tagCount = (mentor.specialTags || []).filter(tag => foundTags.some(ft => tag.toLowerCase().includes(ft))).length;
        if (tagCount > 0) { const b = W.SPECIAL_TAG * Math.min(tagCount, 4); totalBonus += b; bonusLogs.push(`Tags(+${(b * 100).toFixed(1)}%)`); }

        const milestoneCount = (mentor.milestones || []).filter(m => foundTags.some(ft => m.toLowerCase().includes(ft))).length;
        if (milestoneCount > 0) { const b = W.MILESTONE * Math.min(milestoneCount, 3); totalBonus += b; bonusLogs.push(`Milestones(+${(b * 100).toFixed(1)}%)`); }

        const expertiseMatches = (mentor.expertise || []).filter(exp => mentionedTech.some(t => exp.toLowerCase().includes(t))).length;
        if (expertiseMatches > 0) { const b = W.EXPERTISE * Math.min(expertiseMatches, 5); totalBonus += b; bonusLogs.push(`Tech(+${(b * 100).toFixed(1)}%)`); }

        const bioMatches = keywords.filter(kw => mentor.bio?.toLowerCase().includes(kw)).length;
        if (bioMatches >= 5) { totalBonus += W.BIO_DENSITY; bonusLogs.push(`Bio(+${(W.BIO_DENSITY * 100).toFixed(1)}%)`); }

        const mEdu = mentor.education?.[0] || {};
        if (isSameCollege(sEdu.institutionName, mEdu.institutionName)) {
          totalBonus += W.SAME_COLLEGE; bonusLogs.push(`SameCollege(+${(W.SAME_COLLEGE * 100).toFixed(1)}%)`);
        }
        const mentorCollegeType = getCollegeType(mEdu.institutionName);
        if (studentCollegeType === mentorCollegeType && studentCollegeType !== 'unknown') {
          totalBonus += W.COLLEGE_TYPE; bonusLogs.push(`${studentCollegeType.toUpperCase()}(+${(W.COLLEGE_TYPE * 100).toFixed(1)}%)`);
        }
        if (isSameBranch(sEdu.field, mEdu.field)) {
          totalBonus += W.SAME_BRANCH; bonusLogs.push(`Branch(+${(W.SAME_BRANCH * 100).toFixed(1)}%)`);
        }
        if (mentor.rating >= 4.5) { totalBonus += W.HIGH_RATING; bonusLogs.push(`★${mentor.rating}`); }
        if (mentor.responseRate >= 85) { totalBonus += W.HIGH_RESPONSE; bonusLogs.push(`Response`); }
        if (isRecentlyActive(mentor.lastActive)) { totalBonus += W.RECENT_ACTIVE; bonusLogs.push(`Active`); }

        // Feedback bonus in vector path
        const feedbackScore = mentor.feedbackScore || 0;
        const totalAnswered = mentor.totalAnswered || 0;
        const ratedCount = mentor.feedbackCount || 0;
        if (ratedCount >= 3) {
          if (feedbackScore >= 0.8) { totalBonus += W.FEEDBACK_BONUS; bonusLogs.push(`Feedback★`); }
          else if (feedbackScore < 0.4) { totalBonus -= W.FEEDBACK_BONUS * 1.5; bonusLogs.push(`FeedbackBad`); }
        } else if (totalAnswered === 0) { totalBonus += 0.03; bonusLogs.push(`ColdStart(+3%)`); }

        // Verified outcome success rate (gated on ≥3 reported outcomes)
        if ((mentor.outcomeCount || 0) >= 3) {
          const b = W.OUTCOME * (mentor.outcomeScore || 0);
          if (b > 0) { totalBonus += b; bonusLogs.push(`Outcome(+${(b * 100).toFixed(1)}%)`); }
        }

        // ADDITIVE ranking — the old multiplicative form min(score*(1+bonus), 1.0)
        // saturated every decent match at 1.0, making ranking impossible and
        // constantly tripping the ambiguity gate. Relevance (semantic) and mentor
        // fit (bonus) are separate axes: 70/30 weighted sum, never capped away.
        const normBonus = Math.min(totalBonus, 0.35) / 0.35; // → [0, 1]
        const finalScore = 0.7 * match.score + 0.3 * normBonus;

        scoredMatches.push({
          ...match, finalScore, baseScore: match.score, bonusScore: totalBonus,
          mentorProfile: {
            _id: mentor._id, username: mentor.username, avatar: mentor.avatar,
            bio: mentor.bio, education: mEdu, rating: mentor.rating,
            responseRate: mentor.responseRate, topCompanies: mentor.topCompanies,
          },
          breakdown: bonusLogs.join(' | '),
        });
      }

      scoredMatches.sort((a, b) => b.finalScore - a.finalScore);

      if (diag) {
        diag.queryDetails = queryDetails;
        diag.candidates = scoredMatches.slice(0, 10).map(m => ({
          mentorId: m.mentorProfile._id, score: m.finalScore,
          baseScore: m.baseScore, breakdown: m.breakdown,
        }));
      }

      dlog(`\n--- TOP 5 VECTOR MATCHES ---`);
      scoredMatches.slice(0, 5).forEach((m, i) => {
        dlog(`#${i + 1}: ${m.mentorProfile.username} | ${(m.finalScore * 100).toFixed(2)}% | ${m.breakdown}`);
      });

      const best = scoredMatches[0];
      const second = scoredMatches[1];

      // GATE on the raw semantic score (is this answer actually about the question?),
      // RANK by finalScore (which answer + mentor combo is best). The thresholds were
      // tuned against the raw cosine score, so they keep their meaning here.
      if (!best || best.baseScore < CONFIG.INSTANT_THRESHOLD) {
        dlog(`⚠️ Below semantic threshold (base ${((best?.baseScore || 0) * 100).toFixed(2)}%)`);
        return null;
      }

      if (second) {
        const gap = best.finalScore - second.finalScore;
        if (best.baseScore < CONFIG.TOP_MATCH_CONFIDENCE && gap < CONFIG.AMBIGUITY_THRESHOLD) {
          dlog(`⚠️ AMBIGUOUS — routing live`);
          return null;
        }
      }

      dlog(`✅ INSTANT MATCH: ${best.mentorProfile.username} ${(best.finalScore * 100).toFixed(2)}%`);
      VECTOR_CACHE.set(cacheKey, best);
      return best;

    } catch (error) {
      console.error('🔥 Vector Search Error:', error);
      return null;
    }
  }

  /* =============================================
      🔥 PATH B: LIVE MENTOR ROUTING
     ============================================= */
  async findBestMentor(studentId, keywords, questionCategory = null, studentContext = null, diag = null) {
    try {
      const questionText = keywords.join(' ');
      const sEdu = await resolveStudentEdu(studentId, studentContext);

      const queryDetails = await this.detectQueryDetails(questionText);
      const { intent, confidence, mentionedCompanies, relatedCompanies, foundTags, mentionedTech } = queryDetails;

      dlog(`\n🤝 ===== LIVE MENTOR ROUTING =====`);

      const allMentors = await getActiveMentors();
      // ← INVERTED INDEX: score only relevant candidates, not all 1000
      const candidates = getCandidateMentors(allMentors, queryDetails, sEdu);

      const context = {
        questionCategory, mentionedCompanies, relatedCompanies,
        foundTags, mentionedTech, intent, confidence,
        keywords, studentCollegeType: getCollegeType(sEdu.institutionName), sEdu,
        goalSignals: extractGoalSignals(studentContext?.goal),
      };

      // ← DRY: use shared scoreMentor function
      const scored = candidates.map(mentor => scoreMentor(mentor, context));
      scored.sort((a, b) => b.points - a.points);

      if (diag) {
        diag.queryDetails = queryDetails;
        diag.candidates = scored.slice(0, 10).map(s => ({
          mentorId: s.mentor._id, score: s.points, breakdown: s.logs,
        }));
      }

      console.log('\n--- TOP 5 LIVE CANDIDATES ---');
      scored.slice(0, 5).forEach((item, i) => {
        console.log(`#${i + 1}: ${item.mentor.username} | ${item.points}pts (${item.load}Q)`);
        dlog('   └─', item.logs);
      });

      const best = scored[0];
      const second = scored[1];

      if (!best || best.points < CONFIG.LIVE_MATCH_THRESHOLD) {
        console.log(`❌ NO QUALIFYING MENTOR: best=${best?.points || 0}`);
        return null;
      }

      if (best.load >= CONFIG.MAX_LOAD) {
        const alt = scored.find(s => s.load < CONFIG.MAX_LOAD && s.points >= CONFIG.LIVE_MATCH_THRESHOLD);
        if (alt) { dlog(`⚠️ Best overloaded → ${alt.mentor.username}`); return alt.mentor; }
      }

      if (second && (best.points - second.points) / best.points < 0.20 && best.points < 1000) {
        if (second.mentor.rating > best.mentor.rating) return second.mentor;
        if (second.load < best.load) return second.mentor;
        if ((second.mentor.successfulMatches || 0) > (best.mentor.successfulMatches || 0)) return second.mentor;
      }

      dlog(`✅ MENTOR ASSIGNED: ${best.mentor.username} | ${best.points}pts`);
      return best.mentor;

    } catch (error) {
      console.error('❌ findBestMentor error:', error);
      return null;
    }
  }

  /* =============================================
      🔥 FIND TOP N MENTORS (carousel)
     ============================================= */
  async findTopMentors(studentId, keywords, questionCategory = null, limit = 3, studentContext = null, diag = null) {
    try {
      const questionText = keywords.join(' ');
      const sEdu = await resolveStudentEdu(studentId, studentContext);

      const queryDetails = await this.detectQueryDetails(questionText);

      dlog(`\n🤝 ===== FINDING TOP ${limit} MENTORS =====`);

      const allMentors = await getActiveMentors();
      const candidates = getCandidateMentors(allMentors, queryDetails, sEdu); // ← index filter + identity

      const context = {
        questionCategory,
        mentionedCompanies: queryDetails.mentionedCompanies,
        relatedCompanies: queryDetails.relatedCompanies,
        foundTags: queryDetails.foundTags,
        mentionedTech: queryDetails.mentionedTech,
        intent: queryDetails.intent,
        confidence: queryDetails.confidence,
        keywords,
        studentCollegeType: getCollegeType(sEdu.institutionName),
        sEdu,
        goalSignals: extractGoalSignals(studentContext?.goal),
      };

      // ← DRY: same scoreMentor function
      const scored = candidates.map(mentor => scoreMentor(mentor, context));
      scored.sort((a, b) => b.points - a.points);

      if (diag) {
        diag.queryDetails = queryDetails;
        diag.candidates = scored.slice(0, 10).map(s => ({
          mentorId: s.mentor._id, score: s.points, breakdown: s.logs,
        }));
      }

      const qualifiedMentors = scored
        .filter(s => s.points >= CONFIG.LIVE_MATCH_THRESHOLD)
        .slice(0, limit)
        .map(s => {
          s.mentor.matchScore = pointsToMatchPct(s.points);
          return s.mentor;
        });

      if (qualifiedMentors.length === 0) {
        console.log(`❌ NO QUALIFYING MENTORS`);
        return null;
      }

      return qualifiedMentors;

    } catch (error) {
      console.error('🔥 findTopMentors Error:', error);
      return null;
    }
  }

  /* =============================================
      🚀 MAIN ORCHESTRATOR
     ============================================= */
  async processQuestion(userId, questionText, options = {}) {
    const retryCount = options._retryCount || 0;

    // Direct mentor assignment — skip all matching when user explicitly chose a mentor
    if (options.preferredMentorId) {
      try {
        const mentor = await User.findById(options.preferredMentorId).lean();
        if (mentor) {
          const keywords = extractSmartKeywords(questionText);
          const question = new Question({
            userId, questionText, keywords,
            status: 'mentor_assigned',
            selectedMentorId: mentor._id,
            matchMethod: 'user_selected',
          });
          await question.save();
          await User.findByIdAndUpdate(mentor._id, { $inc: { activeQuestions: 1 } });
          sendMentorNewQuestionNotification(mentor.email, mentor.username, questionText)
            .catch(err => console.error(`⚠️ Email failed:`, err.message));
          return {
            success: true, questionId: question._id,
            message: `Question sent to ${mentor.username}`,
            mentorId: mentor._id, mentorUsername: mentor.username,
            matchMethod: 'user_selected',
          };
        }
      } catch (err) {
        console.error('preferredMentorId lookup failed, falling through to engine:', err.message);
      }
    }

    try {
      await Promise.all([getAllTargetCompanies(), getActiveMentors()]);

      dlog(`\n🚀 ========== ATYANT ENGINE START ==========`);
      dlog(`User: ${userId} | Q: "${questionText.substring(0, 100)}..."`);

      // ── FIX: detectQueryDetails ONCE at the top, inferredCategory defined here ──
      const queryDetails = await this.detectQueryDetails(questionText);
      const inferredCategory = queryDetails?.intent || null;

      let vector = null;
      try {
        vector = await getQuestionEmbedding(questionText);
        dlog(`✅ Embedding (${vector?.length || 0} dims)`);
      } catch (err) {
        dlog(`❌ Embedding failed: ${err.message}`);
      }

      const keywords = extractSmartKeywords(questionText);

      // ──────────────────────────────────────────
      //  PATH A: Vector semantic search
      // ──────────────────────────────────────────
      if (vector && !options.isFollowUp) {
        dlog(`\n🎯 Path A: Vector search...`);
        const diagA = {};
        const match = await this.findBestSemanticMatch(userId, vector, questionText, options.studentContext || null, diagA);

        if (match) {
          const q = new Question({
            userId, questionText, keywords,
            status: 'answered_instantly',
            answerCardId: match._id,
            selectedMentorId: match.mentorProfile._id,
            isInstant: true,
            matchScore: Math.round(match.finalScore * 100),
            matchMethod: 'vector_semantic',
          });
          await q.save();

          logMatch({
            questionId: q._id, studentId: userId, path: 'vector', questionText,
            queryDetails: diagA.queryDetails || queryDetails,
            studentContext: options.studentContext || null,
            candidates: diagA.candidates || [],
            selectedMentorId: match.mentorProfile._id, instant: true,
          });

          return {
            success: true,
            instantAnswer: true,
            questionId: q._id,
            answerCardId: match._id,
            answerContent: match.answerContent,
            mentor: match.mentorProfile,
            matchScore: match.finalScore,
            matchMethod: 'vector_semantic',
          };
        }
        dlog(`Path A: no match — proceeding to Path B`);
      }

      // ──────────────────────────────────────────
      //  PATH B: Live mentor routing
      //  FIX: inferredCategory is now properly defined above
      // ──────────────────────────────────────────
      dlog(`\n🎯 Path B: Live routing (inferred: ${inferredCategory})...`);
      const diagB = {};
      const bestMentor = await this.findBestMentor(userId, keywords, options.category || inferredCategory || null, options.studentContext || null, diagB);

      const question = new Question({
        userId, questionText, keywords,
        status: bestMentor ? 'mentor_assigned' : 'pending',
        matchMethod: 'live_routing',
        isFollowUp: options.isFollowUp || false,
      });

      if (bestMentor) {
        question.selectedMentorId = bestMentor._id;
        await question.save();

        const updated = await User.findOneAndUpdate(
          { _id: bestMentor._id, activeQuestions: { $lt: CONFIG.MAX_LOAD } },
          { $inc: { activeQuestions: 1 } },
          { new: true }
        );

        if (!updated) {
          if (retryCount >= CONFIG.MAX_RETRIES) {
            console.error(`❌ Max retries hit — global pool`);
            invalidateMentorCache();
            question.status = 'pending';
            question.selectedMentorId = undefined;
            await question.save();
            return { success: true, message: 'System is busy. Your question will be answered shortly.', questionId: question._id, pool: 'global', matchMethod: 'retry_exhausted' };
          }
          console.warn(`⚠️ Retry ${retryCount + 1}/${CONFIG.MAX_RETRIES}`);
          invalidateMentorCache();
          await sleep(200 * Math.pow(2, retryCount));
          return this.processQuestion(userId, questionText, { ...options, _retryCount: retryCount + 1 });
        }

        adjustCachedMentorLoad(bestMentor._id, +1);

        logMatch({
          questionId: question._id, studentId: userId, path: 'live', questionText,
          queryDetails: diagB.queryDetails || queryDetails,
          studentContext: options.studentContext || null,
          candidates: diagB.candidates || [],
          selectedMentorId: bestMentor._id, instant: false,
        });

        sendMentorNewQuestionNotification(bestMentor.email, bestMentor.username, questionText)
          .then(() => dlog(`📧 Email → ${bestMentor.username}`))
          .catch(err => console.error(`⚠️ Email failed:`, err.message));

        return {
          success: true, questionId: question._id,
          message: `Matching with ${bestMentor.username}...`,
          mentorId: bestMentor._id, mentorUsername: bestMentor.username,
          matchMethod: 'live_routing',
        };
      }

      // No qualifying mentor — log the miss too: failed matches show exactly
      // where mentor supply doesn't cover demand.
      logMatch({
        questionId: question._id, studentId: userId, path: 'live', questionText,
        queryDetails: diagB.queryDetails || queryDetails,
        studentContext: options.studentContext || null,
        candidates: diagB.candidates || [],
        selectedMentorId: null, instant: false,
      });

      // Fallback: Atyant Engine user
      const engineUser = await User.findOne({ username: 'Atyant Engine', email: 'atyant.in@gmail.com' }).lean();
      if (engineUser) {
        question.selectedMentorId = engineUser._id;
        question.status = 'mentor_assigned';
        await question.save();
        return { success: true, questionId: question._id, message: 'Connecting to Atyant Engine...', mentorId: engineUser._id, mentorUsername: engineUser.username, matchMethod: 'atyant_engine_fallback' };
      }

      await question.save();
      return { success: true, message: 'Looking for a senior mentor...', questionId: question._id, pool: 'global', matchMethod: 'pending_assignment' };

    } catch (error) {
      console.error('\n🔥 ENGINE CRITICAL ERROR\n', error);
      return { success: false, message: 'Failed to submit question. Please try again.' };
    }
  }

  /* =============================================
      🎯 CLARITY MODE  ← dual output, runs simultaneously
      Returns the best AnswerCard AND the matched mentors together.
      Read-only: no Question is created, no mentor load is touched.
      The student "asks" later by picking a mentor on the clarity page.
     ============================================= */
  async getClarity(userId, questionText, options = {}) {
    try {
      await Promise.all([getAllTargetCompanies(), getActiveMentors()]);

      const limit = options.mentorLimit || 3;
      const studentContext = options.studentContext || null; // {college, branch, year} from chat
      const queryDetails = await this.detectQueryDetails(questionText);
      const inferredCategory = options.category || queryDetails?.intent || null;
      const keywords = extractSmartKeywords(questionText);

      // Embedding is only needed for the AnswerCard (vector) path.
      let vector = null;
      try {
        vector = await getQuestionEmbedding(questionText);
      } catch (err) {
        dlog(`Clarity embedding failed: ${err.message}`);
      }

      // ── Run BOTH paths simultaneously ──
      const diagC = {};
      const [answerMatch, mentors] = await Promise.all([
        vector
          ? this.findBestSemanticMatch(userId, vector, questionText, studentContext).catch(e => {
              console.error('Clarity vector path error:', e.message);
              return null;
            })
          : Promise.resolve(null),
        this.findTopMentors(userId, keywords, inferredCategory, limit, studentContext, diagC).catch(e => {
          console.error('Clarity mentor path error:', e.message);
          return null;
        }),
      ]);

      logMatch({
        questionId: null, studentId: userId, path: 'clarity', questionText,
        queryDetails: diagC.queryDetails || queryDetails,
        studentContext,
        candidates: diagC.candidates || [],
        selectedMentorId: null, instant: !!answerMatch,
      });

      const answerCard = answerMatch
        ? {
            id: answerMatch._id,
            content: answerMatch.answerContent,
            mentor: answerMatch.mentorProfile,
            matchScore: Math.round((answerMatch.finalScore || 0) * 100),
            isInstant: true,
          }
        : null;

      // Scrollable feed: top N answer cards (one per senior who solved a similar problem)
      let answerCards = [];
      if (vector) {
        try { answerCards = await this.getTopAnswerCards(vector, options.answerLimit || 4, studentContext, queryDetails?.intent || 'general'); }
        catch (e) { console.error('getTopAnswerCards error:', e.message); }
      }

      return {
        success: true,
        answerCard,                 // best single match (full-scored) — kept for compat
        answerCards,                // feed of top matches (one per mentor)
        mentors: mentors || [],     // may be empty — answer cards still returned
        hasInstantAnswer: !!answerCard || answerCards.length > 0,
        mentorCount: (mentors || []).length,
      };
    } catch (error) {
      console.error('🔥 getClarity error:', error);
      return { success: false, answerCard: null, answerCards: [], mentors: [], hasInstantAnswer: false, mentorCount: 0 };
    }
  }

  /* =============================================
      📚 TOP ANSWER CARDS (scrollable Clarity feed)
      Returns up to `n` distinct seniors' answer cards,
      ranked by semantic similarity to the question.
     ============================================= */
  async getTopAnswerCards(vector, n = 4, studentContext = null, intent = 'general') {
    const candidates = await AnswerCard.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: vector,
          numCandidates: 80,
          limit: 20,
          filter: {},
        },
      },
      { $project: { answerContent: 1, mentorId: 1, domain: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);

    // Feed is lenient (surfaces relevant journeys for free insight) — unlike the
    // strict instant-answer floor used for the single auto-answer. Intent still
    // gates hard: an internship query never shows placement journeys here either.
    const FEED_FLOOR = 0.45;
    const passing = candidates
      .filter(c => (c.score || 0) >= FEED_FLOOR)
      .filter(c => !intentConflict(intent, cardIntent(c)));
    if (passing.length === 0) return [];

    // #4 — exclude the "Atyant Engine" fallback/seed account so it never shows as
    // a real senior in the student-facing feed.
    const mentorIds = [...new Set(passing.map(c => String(c.mentorId)))];
    const mentors = await User.find({
      _id: { $in: mentorIds },
      role: 'mentor',
      username: { $ne: 'Atyant Engine' },
      email: { $ne: 'atyant.in@gmail.com' },
    })
      .select('name username profilePicture education topCompanies expertise specialTags rating successfulMatches')
      .lean();
    const mmap = new Map(mentors.map(m => [String(m._id), m]));

    // #1 — re-rank by BOTH axes, not just semantics: relevance (vector score) +
    // who-they-are fit (same branch / college / tier). Branch matters because a
    // CSE student needs CSE journeys, not the semantically-closest EEE one.
    const W = CONFIG.WEIGHTS;
    const sCollege = studentContext?.college || null;
    const sBranch  = studentContext?.branch || null;
    const sType = getCollegeType(sCollege);

    const seen = new Set();
    const scored = [];
    for (const c of passing) {
      const m = mmap.get(String(c.mentorId));
      if (!m || seen.has(String(m._id))) continue;   // one card per mentor (best semantic kept)
      seen.add(String(m._id));

      const mEdu = m.education?.[0] || {};
      const mCollege = mEdu.institutionName || mEdu.institution;
      let bonus = 0, sameCollege = false, sameBranch = false;
      if (isSameCollege(sCollege, mCollege)) { bonus += W.SAME_COLLEGE; sameCollege = true; }
      if (sType !== 'unknown' && sType === getCollegeType(mCollege)) bonus += W.COLLEGE_TYPE;
      if (isSameBranch(sBranch, mEdu.field)) { bonus += W.SAME_BRANCH; sameBranch = true; }

      // ADDITIVE boost (not a weighted average): identity fit stacks ON TOP of the
      // raw relevance, so a same-branch senior reads as a HIGH match instead of a
      // deflated one. Branch (W.SAME_BRANCH) alone outweighs a few points of raw
      // semantic edge — exactly what lifts a CSE journey above a closer EEE one.
      const finalScore = Math.min(0.99, (c.score || 0) + Math.min(bonus, 0.25));

      // #4 — honest label so the UI can say "Same branch" vs just "closest match".
      const matchLabel = sameCollege && sameBranch ? 'Same college & branch'
        : sameBranch ? 'Same branch'
        : sameCollege ? 'Same college'
        : 'Closest match';

      scored.push({
        finalScore, sameBranch, sameCollege, matchLabel,
        card: {
          id: c._id,
          content: c.answerContent,
          matchScore: Math.round(finalScore * 100),
          matchLabel,
          sameBranch,
          sameCollege,
          mentor: {
            _id: m._id,
            username: m.username,
            name: m.name,
            profilePicture: m.profilePicture || null,
            education: mEdu,
            topCompanies: m.topCompanies || [],
            expertise: m.expertise || [],
            specialTags: m.specialTags || [],
            rating: m.rating || null,
            successfulMatches: m.successfulMatches || 0,
          },
        },
      });
    }

    // Highest blended score first → same-branch seniors rise above a closer-but-
    // unrelated EEE/Civil card.
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, n).map(s => s.card);
  }

  /* =============================================
      🔄 ANSWER CARD TRANSFORMATION
     ============================================= */
  async transformToAnswerCard(mentorExperience, question) {
    try {
      const { mentorId, _id: mentorExperienceId, rawExperience: rawData } = mentorExperience;
      const questionId = question._id;

      console.log(`\n✨ Transforming → AnswerCard`);

      let polishedContent;
      try {
        polishedContent = await aiServiceInstance.refineExperience(rawData);
      } catch (err) {
        console.warn(`⚠️ AI unavailable — using raw`);
        polishedContent = rawData;
      }

      if (polishedContent) {
        if (typeof polishedContent.keyMistakes === 'string') {
          polishedContent.keyMistakes = polishedContent.keyMistakes.split(/[\n,;]/).map(s => s.trim()).filter(Boolean);
        }
        if (!Array.isArray(polishedContent.keyMistakes)) polishedContent.keyMistakes = [];

        if (polishedContent.actionableSteps && typeof polishedContent.actionableSteps === 'string') {
          polishedContent.actionableSteps = polishedContent.actionableSteps
            .split(/\n/)
            .map((line, idx) => ({ step: `Step ${idx + 1}`, description: line.trim() }))
            .filter(s => s.description);
        }
        if (!Array.isArray(polishedContent.actionableSteps)) polishedContent.actionableSteps = [];
        if (!polishedContent.differentApproach && rawData?.differentApproach) polishedContent.differentApproach = rawData.differentApproach;
      }

      let embedding = null;
      try {
        const embeddingText = [
          polishedContent?.situation, polishedContent?.context, polishedContent?.outcome,
          Array.isArray(polishedContent?.keyMistakes) ? polishedContent.keyMistakes.join(' ') : '',
          Array.isArray(polishedContent?.actionableSteps) ? polishedContent.actionableSteps.map(s => s.description).join(' ') : '',
        ].filter(Boolean).join(' ');

        embedding = await getQuestionEmbedding(embeddingText);
      } catch (embErr) {
        console.error(`⚠️ Embedding failed — card saves without vector:`, embErr.message);
      }

      // Stamp the card's intent from its source question so future internship vs
      // placement gating is exact (no runtime re-derivation needed).
      const cardDomain = detectIntentFromText(
        [question?.questionText, ...(question?.keywords || [])].filter(Boolean).join(' ')
      );

      const newCard = new AnswerCard({
        mentorId, questionId, mentorExperienceId,
        answerContent: polishedContent,
        domain: cardDomain,
        ...(embedding ? { embedding } : {}),
      });
      await newCard.save();

      await User.findByIdAndUpdate(mentorId, {
        $inc: { activeQuestions: -1, successfulMatches: 1, totalAnswered: 1 }, // ← totalAnswered tracked
      });
      adjustCachedMentorLoad(mentorId, -1);

      return newCard;
    } catch (error) {
      console.error('🔥 Transform Error:', error);
      throw error;
    }
  }

  /* =============================================
      ⭐ FEEDBACK HANDLER  ← NEW
      Call this from your answer feedback route
     ============================================= */
  async recordFeedback(questionId, studentId, isHelpful) {
    try {
      // CLAIM the question first, atomically — only succeeds if no feedback was
      // recorded yet (and, when studentId is known, only for the question owner).
      // This makes feedback idempotent: double-taps can't double-count votes.
      const question = await Question.findOneAndUpdate(
        {
          _id: questionId,
          studentFeedback: null,
          ...(studentId ? { userId: studentId } : {}),
        },
        { $set: { studentFeedback: isHelpful ? 'helpful' : 'not_helpful', feedbackAt: new Date() } },
        { new: true }
      ).lean();

      if (!question) {
        return { success: false, message: 'Question not found, not yours, or feedback already recorded' };
      }
      if (!question.selectedMentorId) {
        return { success: false, message: 'No mentor on this question' };
      }

      const mentorId = question.selectedMentorId;

      // Atomic increment FIRST, then recompute score from the returned doc —
      // the old read-then-write pattern lost votes under concurrent feedback.
      const mentor = await User.findByIdAndUpdate(
        mentorId,
        { $inc: { feedbackCount: 1, helpfulCount: isHelpful ? 1 : 0 } },
        { new: true, select: 'helpfulCount feedbackCount' }
      ).lean();
      if (!mentor) return { success: false, message: 'Mentor not found' };

      // Denominator = RATED answers only (feedbackCount), not totalAnswered —
      // unrated answers are silence, not a downvote. Laplace smoothing (+1/+2)
      // keeps a single rating from swinging the score to 0.0 or 1.0.
      const helpful = mentor.helpfulCount || 0;
      const rated = mentor.feedbackCount || 1;
      const newFeedbackScore = (helpful + 1) / (rated + 2);

      await User.findByIdAndUpdate(mentorId, {
        $set: { feedbackScore: newFeedbackScore },
      });

      // Label the routing log — this is what turns logs into training data.
      MatchLog.updateMany(
        { questionId: question._id },
        { $set: { feedback: isHelpful ? 'helpful' : 'not_helpful' } }
      ).catch(err => dlog('MatchLog feedback label failed:', err.message));

      // Invalidate mentor cache so next question uses fresh feedbackScore
      invalidateMentorCache();

      dlog(`✅ Feedback recorded — Mentor: ${mentorId} | Helpful: ${isHelpful} | New score: ${newFeedbackScore.toFixed(2)}`);

      return { success: true, feedbackScore: newFeedbackScore };

    } catch (error) {
      console.error('🔥 recordFeedback error:', error);
      return { success: false, message: 'Failed to record feedback' };
    }
  }

  /* =============================================
      🏆 OUTCOME HANDLER — the moat loop
      Called when a student reports (via 30/60/90-day follow-up) whether they
      actually achieved the goal after following the mentor's advice.
     ============================================= */
  async recordOutcome(questionId, studentId, achieved, note = '') {
    try {
      // Atomic claim — one outcome per question, owner only (when known).
      const question = await Question.findOneAndUpdate(
        {
          _id: questionId,
          'outcome.recordedAt': null,
          ...(studentId ? { userId: studentId } : {}),
        },
        {
          $set: {
            'outcome.status': achieved ? 'achieved' : 'not_achieved',
            'outcome.note': String(note || '').slice(0, 500),
            'outcome.recordedAt': new Date(),
          },
        },
        { new: true }
      ).lean();

      if (!question) {
        return { success: false, message: 'Question not found, not yours, or outcome already recorded' };
      }
      if (!question.selectedMentorId) {
        return { success: false, message: 'No mentor on this question' };
      }

      const mentorId = question.selectedMentorId;

      const mentor = await User.findByIdAndUpdate(
        mentorId,
        { $inc: { outcomeCount: 1, outcomeSuccessCount: achieved ? 1 : 0 } },
        { new: true, select: 'outcomeCount outcomeSuccessCount' }
      ).lean();
      if (!mentor) return { success: false, message: 'Mentor not found' };

      // Laplace-smoothed success rate, same scheme as feedbackScore.
      const newOutcomeScore = ((mentor.outcomeSuccessCount || 0) + 1) / ((mentor.outcomeCount || 1) + 2);
      await User.findByIdAndUpdate(mentorId, { $set: { outcomeScore: newOutcomeScore } });

      MatchLog.updateMany(
        { questionId: question._id },
        { $set: { outcome: achieved ? 'achieved' : 'not_achieved' } }
      ).catch(err => dlog('MatchLog outcome label failed:', err.message));

      invalidateMentorCache();

      dlog(`🏆 Outcome recorded — Mentor: ${mentorId} | Achieved: ${achieved} | Score: ${newOutcomeScore.toFixed(2)}`);
      return { success: true, outcomeScore: newOutcomeScore };
    } catch (error) {
      console.error('🔥 recordOutcome error:', error);
      return { success: false, message: 'Failed to record outcome' };
    }
  }

  extractBetterKeywords(text) {
    try { return extractSmartKeywords(text || ''); }
    catch { return []; }
  }

  flushAllCaches() {
    COMPANY_CACHE = null;
    COMPANY_CACHE_TIME = 0;
    invalidateMentorCache();
    VECTOR_CACHE.clear();
    console.log('🗑️  All AtyantEngine caches flushed');
  }
}

export default new AtyantEngine();