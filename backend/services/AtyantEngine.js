import User from '../models/User.js';
import Question from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import { sendMentorNewQuestionNotification } from '../utils/emailNotifications.js';
import { getQuestionEmbedding } from './AIService.js';
import aiServiceInstance from './AIService.js';
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
  byBranch: new Map(), // 'cse'         → Set<mentorId>
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
    COLLEGE_TYPE: 0.05,
    SAME_BRANCH: 0.03,
    HIGH_RATING: 0.05,
    HIGH_RESPONSE: 0.04,
    RECENT_ACTIVE: 0.03,
    FEEDBACK_BONUS: 0.08,  // ← NEW: good feedback adds up to 8%
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
    COLLEGE_TYPE: 120,
    SAME_BRANCH: 80,
    HIGH_RATING: 120,
    HIGH_RESPONSE: 100,
    RECENT_ACTIVE: 70,
    PROVEN_MENTOR: 150,
    FEEDBACK_BONUS: 200, // ← NEW: good feedback adds points
    COLD_START_BOOST: 100, // ← NEW: new mentors get a boost
  },
};

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
//  UTILITY FUNCTIONS
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  INVERTED INDEX BUILDER  ← NEW
// ─────────────────────────────────────────────
function buildMentorIndex(mentors) {
  const byCompany = new Map();
  const byDomain = new Map();
  const byTag = new Map();
  const byBranch = new Map();

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

    // Branch index
    const branch = mentor.education?.[0]?.field?.toLowerCase();
    if (branch) {
      if (!byBranch.has(branch)) byBranch.set(branch, new Set());
      byBranch.get(branch).add(id);
    }
  }

  dlog(`✅ Index built — Companies:${byCompany.size} Domains:${byDomain.size} Tags:${byTag.size}`);
  return { byCompany, byDomain, byTag, byBranch };
}

// ─────────────────────────────────────────────
//  CANDIDATE FILTER  ← NEW (replaces scoring all mentors)
//  "Amazon internship" → intersection of amazon ∩ internship
// ─────────────────────────────────────────────
function getCandidateMentors(allMentors, queryDetails) {
  const { intent, mentionedCompanies, relatedCompanies, foundTags } = queryDetails;
  const mentorMap = new Map(allMentors.map(m => [m._id.toString(), m]));

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
  } else {
    // Fully general question — score everyone
    dlog(`⚠️ No signals — scoring all ${allMentors.length} mentors`);
    return allMentors;
  }

  // Always include tag matches as supplementary candidates
  if (hasTag && candidateIds.size < 20) {
    tagIds.forEach(id => candidateIds.add(id));
  }

  const candidates = [...candidateIds].map(id => mentorMap.get(id)).filter(Boolean);

  dlog(`🎯 Candidates: ${allMentors.length} → ${candidates.length} [${strategy}]`);
  return candidates;
}

// ─────────────────────────────────────────────
//  CORE MENTOR SCORER  ← NEW (DRY — used by both findBestMentor & findTopMentors)
// ─────────────────────────────────────────────
function scoreMentor(mentor, context) {
  const {
    questionCategory, mentionedCompanies, relatedCompanies,
    foundTags, mentionedTech, intent, confidence,
    keywords, studentCollegeType, sEdu,
  } = context;

  let points = 0;
  const breakdown = [];
  const LW = CONFIG.LIVE_WEIGHTS;

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

  // Bio keywords
  const bioCount = keywords.filter(kw => mentor.bio?.toLowerCase().includes(kw)).length;
  if (bioCount >= 3) { const p = LW.BIO_KEYWORD * bioCount; points += p; breakdown.push(`Bio(+${p})`); }

  // College type
  const mEdu = mentor.education?.[0] || {};
  const mentorCollegeType = getCollegeType(mEdu.institutionName);
  if (studentCollegeType === mentorCollegeType && studentCollegeType !== 'unknown') {
    points += LW.COLLEGE_TYPE; breakdown.push(`${studentCollegeType.toUpperCase()}(+${LW.COLLEGE_TYPE})`);
  }

  // Same branch
  if (sEdu.field && mEdu.field && sEdu.field.toLowerCase() === mEdu.field.toLowerCase()) {
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

  if (totalAnswered >= 3) {
    // Enough data to trust feedback
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
    for (const c of COMPANY_CACHE) {
      const aliases = COMPANY_ALIASES[c] || [c];
      aliases.forEach(a => {
        COMPANY_LOOKUP.set(a.toLowerCase().replace(/[^a-z0-9]/g, ''), c);
      });
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
        'username email education primaryDomain topCompanies milestones specialTags ' +
        'expertise bio activeQuestions rating responseRate lastActive successfulMatches ' +
        'companyDomain feedbackScore totalAnswered'  // ← feedbackScore, totalAnswered added
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

// ─────────────────────────────────────────────
//  MAIN ENGINE CLASS
// ─────────────────────────────────────────────
class AtyantEngine {

  /* =============================================
      🧠 DEEP QUERY ANALYSIS
     ============================================= */
  async detectQueryDetails(text) {
    const t = text.toLowerCase();

    const internshipPatterns = ['internship', 'intern', 'summer internship', 'winter internship', 'intern offer', 'internship offer', 'intern prep'];
    const placementPatterns = ['placement', 'job', 'full time', 'full-time', 'ft role', 'ft offer', 'job offer', 'campus placement', 'recruitment'];

    const internMatches = internshipPatterns.filter(p => t.includes(p)).length;
    const placeMatches = placementPatterns.filter(p => t.includes(p)).length;

    let intent, confidence;
    if (internMatches > placeMatches && internMatches > 0) {
      intent = 'internship'; confidence = Math.min(internMatches / internshipPatterns.length, 1);
    } else if (placeMatches > 0) {
      intent = 'placement'; confidence = Math.min(placeMatches / placementPatterns.length, 1);
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
  async findBestSemanticMatch(studentId, vector, questionText) {
    try {
      const cacheKey = crypto.createHash('sha1').update(questionText).digest('hex');
      if (VECTOR_CACHE.has(cacheKey)) {
        dlog(`💾 VECTOR CACHE HIT`);
        return VECTOR_CACHE.get(cacheKey);
      }

      const student = await User.findById(studentId).select('education').lean();
      const sEdu = student?.education?.[0] || {};
      const studentCollegeType = getCollegeType(sEdu.institutionName);

      const queryDetails = await this.detectQueryDetails(questionText);
      const { intent, confidence, mentionedCompanies, relatedCompanies,
        foundTags, mentionedTech, isUrgent, hasSpecifics } = queryDetails;

      dlog(`\n🔎 ===== VECTOR SEMANTIC SEARCH =====`);
      dlog(`Intent: ${intent} | Companies: [${mentionedCompanies}] | Tags: [${foundTags.slice(0, 5)}]`);

      const answerCardsWithEmbeddings = await AnswerCard.countDocuments({
        embedding: { $exists: true, $ne: null, $not: { $size: 0 } },
      });
      if (answerCardsWithEmbeddings === 0) {
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
          'companyDomain feedbackScore totalAnswered')
        .lean();
      const mentorMap = new Map(mentors.map(m => [m._id.toString(), m]));

      const keywords = extractSmartKeywords(questionText);
      const W = CONFIG.WEIGHTS;
      const scoredMatches = [];

      for (const match of candidates) {
        if (match.score < CONFIG.SEMANTIC_FLOOR) continue;
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
        const mentorCollegeType = getCollegeType(mEdu.institutionName);
        if (studentCollegeType === mentorCollegeType && studentCollegeType !== 'unknown') {
          totalBonus += W.COLLEGE_TYPE; bonusLogs.push(`${studentCollegeType.toUpperCase()}(+${(W.COLLEGE_TYPE * 100).toFixed(1)}%)`);
        }
        if (sEdu.field && mEdu.field && sEdu.field.toLowerCase() === mEdu.field.toLowerCase()) {
          totalBonus += W.SAME_BRANCH; bonusLogs.push(`Branch(+${(W.SAME_BRANCH * 100).toFixed(1)}%)`);
        }
        if (mentor.rating >= 4.5) { totalBonus += W.HIGH_RATING; bonusLogs.push(`★${mentor.rating}`); }
        if (mentor.responseRate >= 85) { totalBonus += W.HIGH_RESPONSE; bonusLogs.push(`Response`); }
        if (isRecentlyActive(mentor.lastActive)) { totalBonus += W.RECENT_ACTIVE; bonusLogs.push(`Active`); }

        // Feedback bonus in vector path
        const feedbackScore = mentor.feedbackScore || 0;
        const totalAnswered = mentor.totalAnswered || 0;
        if (totalAnswered >= 3) {
          if (feedbackScore >= 0.8) { totalBonus += W.FEEDBACK_BONUS; bonusLogs.push(`Feedback★`); }
          else if (feedbackScore < 0.4) { totalBonus -= W.FEEDBACK_BONUS * 1.5; bonusLogs.push(`FeedbackBad`); }
        } else if (totalAnswered === 0) { totalBonus += 0.03; bonusLogs.push(`ColdStart(+3%)`); }

        const cappedBonus = Math.min(totalBonus, 0.35);
        const finalScore = Math.min(match.score * (1 + cappedBonus), 1.0);

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

      dlog(`\n--- TOP 5 VECTOR MATCHES ---`);
      scoredMatches.slice(0, 5).forEach((m, i) => {
        dlog(`#${i + 1}: ${m.mentorProfile.username} | ${(m.finalScore * 100).toFixed(2)}% | ${m.breakdown}`);
      });

      const best = scoredMatches[0];
      const second = scoredMatches[1];

      if (!best || best.finalScore < CONFIG.INSTANT_THRESHOLD) {
        dlog(`⚠️ Below threshold (${((best?.finalScore || 0) * 100).toFixed(2)}%)`);
        return null;
      }

      if (second) {
        const gap = best.finalScore - second.finalScore;
        if (best.finalScore < CONFIG.TOP_MATCH_CONFIDENCE && gap < CONFIG.AMBIGUITY_THRESHOLD) {
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
  async findBestMentor(studentId, keywords, questionCategory = null) {
    try {
      const questionText = keywords.join(' ');
      const student = await User.findById(studentId).select('education').lean();
      const sEdu = student?.education?.[0] || {};

      const queryDetails = await this.detectQueryDetails(questionText);
      const { intent, confidence, mentionedCompanies, relatedCompanies, foundTags, mentionedTech } = queryDetails;

      dlog(`\n🤝 ===== LIVE MENTOR ROUTING =====`);

      const allMentors = await getActiveMentors();
      // ← INVERTED INDEX: score only relevant candidates, not all 1000
      const candidates = getCandidateMentors(allMentors, queryDetails);

      const context = {
        questionCategory, mentionedCompanies, relatedCompanies,
        foundTags, mentionedTech, intent, confidence,
        keywords, studentCollegeType: getCollegeType(sEdu.institutionName), sEdu,
      };

      // ← DRY: use shared scoreMentor function
      const scored = candidates.map(mentor => scoreMentor(mentor, context));
      scored.sort((a, b) => b.points - a.points);

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
  async findTopMentors(studentId, keywords, questionCategory = null, limit = 3) {
    try {
      const questionText = keywords.join(' ');
      const student = await User.findById(studentId).select('education').lean();
      const sEdu = student?.education?.[0] || {};

      const queryDetails = await this.detectQueryDetails(questionText);

      dlog(`\n🤝 ===== FINDING TOP ${limit} MENTORS =====`);

      const allMentors = await getActiveMentors();
      const candidates = getCandidateMentors(allMentors, queryDetails); // ← index filter

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
      };

      // ← DRY: same scoreMentor function
      const scored = candidates.map(mentor => scoreMentor(mentor, context));
      scored.sort((a, b) => b.points - a.points);

      const qualifiedMentors = scored
        .filter(s => s.points >= CONFIG.LIVE_MATCH_THRESHOLD)
        .slice(0, limit)
        .map(s => {
          s.mentor.matchScore = Math.min(Math.round((s.points / 2000) * 100), 99);
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
        const match = await this.findBestSemanticMatch(userId, vector, questionText);

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
      const bestMentor = await this.findBestMentor(userId, keywords, options.category || inferredCategory || null);

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

        invalidateMentorCache();

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

      const newCard = new AnswerCard({
        mentorId, questionId, mentorExperienceId,
        answerContent: polishedContent,
        ...(embedding ? { embedding } : {}),
      });
      await newCard.save();

      await User.findByIdAndUpdate(mentorId, {
        $inc: { activeQuestions: -1, successfulMatches: 1, totalAnswered: 1 }, // ← totalAnswered tracked
      });
      invalidateMentorCache();

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
      const question = await Question.findById(questionId).lean();
      if (!question || !question.selectedMentorId) {
        return { success: false, message: 'Question or mentor not found' };
      }

      const mentorId = question.selectedMentorId;

      // Fetch current mentor stats
      const mentor = await User.findById(mentorId).select('feedbackScore totalAnswered helpfulCount').lean();
      if (!mentor) return { success: false, message: 'Mentor not found' };

      const currentHelpful = mentor.helpfulCount || 0;
      const currentTotal = mentor.totalAnswered || 0;

      const newHelpful = isHelpful ? currentHelpful + 1 : currentHelpful;
      const newTotal = currentTotal; // totalAnswered already incremented on transformToAnswerCard

      // feedbackScore = helpfulCount / totalAnswered (0.0 to 1.0)
      const newFeedbackScore = newTotal > 0 ? newHelpful / newTotal : 0;

      await User.findByIdAndUpdate(mentorId, {
        $set: { feedbackScore: newFeedbackScore },
        $inc: { helpfulCount: isHelpful ? 1 : 0 },
      });

      // Save feedback on the question too
      await Question.findByIdAndUpdate(questionId, {
        $set: { studentFeedback: isHelpful ? 'helpful' : 'not_helpful', feedbackAt: new Date() },
      });

      // Invalidate mentor cache so next question uses fresh feedbackScore
      invalidateMentorCache();

      dlog(`✅ Feedback recorded — Mentor: ${mentorId} | Helpful: ${isHelpful} | New score: ${newFeedbackScore.toFixed(2)}`);

      return { success: true, feedbackScore: newFeedbackScore };

    } catch (error) {
      console.error('🔥 recordFeedback error:', error);
      return { success: false, message: 'Failed to record feedback' };
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