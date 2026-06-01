/**
 * College Resolver — self-learning canonical normalizer (Gemini-backed).
 *
 * Layered resolution (fast → smart):
 *   1. In-memory LRU      (instant, hot keys)
 *   2. Mongo cache        (fast, persistent, self-growing — REPLACES the hardcoded map)
 *   3. Fuzzy match        (free, catches typos of known names)
 *   4. Gemini LLM fallback (resolves acronyms/aliases never seen before)
 *
 * The Mongo cache IS your alias map — but you never hand-write it again.
 * Seeded once from COLLEGE_ALIASES so your core colleges are rock-solid from day one.
 */

import * as fuzz from 'fuzzball';
import { COLLEGE_ALIASES } from './collegeNormalizer.js';

// ── Config ────────────────────────────────────────────────────────────────
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const FUZZY_ACCEPT_SCORE = 88;   // accept a fuzzy match (typo correction) at/above this
const LLM_SNAP_SCORE     = 90;   // snap LLM output onto an existing canonical at/above this
const LLM_MIN_CONFIDENCE = 0.6;  // below this, flag for human review
const LRU_MAX            = 2000; // hot keys held in memory
const LLM_TIMEOUT_MS     = 8000; // hard ceiling per Gemini call

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalize raw user input into a stable lookup key. */
function makeKey(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[.,'"`]/g, '')      // drop punctuation
    .replace(/\s+/g, ' ');        // collapse whitespace
}

/** Tiny dependency-free LRU. */
class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v); // bump recency
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// ── Fuzzy corpus (built once at module load) ─────────────────────────────────
// text(makeKey'd) -> canonical. Both canonical and aliases are normalized the
// same way, and a Map dedupes collisions cleanly (no index gymnastics).
const FUZZY_MAP = new Map();
for (const [canonical, aliases] of Object.entries(COLLEGE_ALIASES)) {
  FUZZY_MAP.set(makeKey(canonical), canonical);
  for (const a of aliases) FUZZY_MAP.set(makeKey(a), canonical);
}
const FUZZY_TEXTS = [...FUZZY_MAP.keys()];

function fuzzyBest(key) {
  const [match] = fuzz.extract(key, FUZZY_TEXTS, {
    scorer: fuzz.token_set_ratio,
    returnObjects: true,
    limit: 1,
  });
  if (!match) return { canonical: null, score: 0 };
  return { canonical: FUZZY_MAP.get(match.choice) ?? null, score: match.score };
}

// ── Gemini LLM normalization (timeout + exponential backoff) ──────────────────
async function llmNormalize(rawInput, geminiApiKey, { retries = 3 } = {}) {
  if (!geminiApiKey) return null;

  const systemText =
    'You normalize Indian college/university names. The input may be an acronym ' +
    '(e.g. "VNIT", "MNIT"), an abbreviation, a misspelling, or a partial name. ' +
    'canonical = the full official institution name, properly capitalized. ' +
    'If the input is not a real institution, set isInstitution=false and echo the ' +
    'cleaned input as canonical. confidence is 0-1.';

  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: `Normalize: "${rawInput}"` }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          confidence: { type: 'number' },
          isInstitution: { type: 'boolean' },
        },
        required: ['canonical', 'confidence', 'isInstitution'],
      },
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS), // hung socket now throws → falls through
      });

      if (res.status === 429 || res.status >= 500) throw new Error(`retryable ${res.status}`);
      if (!res.ok) return null; // non-retryable (e.g. 400/401) — give up cleanly

      const data = await res.json();
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return null; // empty or safety-blocked response

      const parsed = JSON.parse(content);
      if (!parsed?.canonical) return null;
      return {
        canonical: String(parsed.canonical).trim(),
        confidence: Number(parsed.confidence) || 0,
        isInstitution: parsed.isInstitution !== false,
      };
    } catch {
      if (attempt === retries) return null;
      await sleep(250 * 2 ** attempt + Math.random() * 100); // backoff + jitter
    }
  }
  return null;
}

// ── Factory ───────────────────────────────────────────────────────────────
/**
 * Create a college resolver bound to your existing Mongo db + Gemini key.
 * @param {object}   opts
 * @param {import('mongodb').Db} opts.db        your existing Mongo db handle
 * @param {string}   opts.geminiApiKey          process.env.GEMINI_API_KEY
 * @param {string}  [opts.collection='collegeCache']
 */
export function createCollegeResolver({ db, geminiApiKey, collection = 'collegeCache' }) {
  const cache = db.collection(collection);
  const lru = new LRU(LRU_MAX);

  /** Ensure index + seed the cache from COLLEGE_ALIASES (run once at boot). */
  async function init() {
    await cache.createIndex({ key: 1 }, { unique: true });

    const ops = [];
    for (const [canonical, aliases] of Object.entries(COLLEGE_ALIASES)) {
      const all = [canonical, ...aliases];
      for (const name of all) {
        ops.push({
          updateOne: {
            filter: { key: makeKey(name) },
            update: {
              $setOnInsert: {
                key: makeKey(name),
                canonical,
                source: 'seed',
                needsReview: false,
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }
    if (ops.length) await cache.bulkWrite(ops, { ordered: false });
    return ops.length;
  }

  /** Resolve a single college name to its canonical form. */
  async function resolve(rawInput) {
    if (!rawInput) return '';
    const key = makeKey(rawInput);
    if (!key) return '';

    // 1. in-memory
    const hot = lru.get(key);
    if (hot) return hot;

    // 2. mongo cache
    const cached = await cache.findOne({ key });
    if (cached) { lru.set(key, cached.canonical); return cached.canonical; }

    // 3. fuzzy (typo correction against known names)
    const f = fuzzyBest(key);
    if (f.canonical && f.score >= FUZZY_ACCEPT_SCORE) {
      await persist(key, f.canonical, { source: 'fuzzy', needsReview: false });
      return f.canonical;
    }

    // 4. LLM fallback (acronyms / never-seen aliases)
    const llm = await llmNormalize(rawInput, geminiApiKey);
    if (llm && llm.isInstitution) {
      // snap LLM's full name onto an existing canonical if it's clearly the same place
      const snap = fuzzyBest(makeKey(llm.canonical));
      const canonical =
        snap.canonical && snap.score >= LLM_SNAP_SCORE ? snap.canonical : llm.canonical;
      await persist(key, canonical, {
        source: 'llm',
        needsReview: llm.confidence < LLM_MIN_CONFIDENCE,
        confidence: llm.confidence,
      });
      return canonical;
    }

    // 5. give up gracefully — store the trimmed (original-cased) input, flag for review
    const fallback = String(rawInput).trim();
    await persist(key, fallback, { source: 'unresolved', needsReview: true });
    return fallback;
  }

  /** Resolve many names; de-dupes identical keys so each unique value resolves once. */
  async function resolveBatch(names) {
    // key -> first original raw value (preserves casing for the unresolved fallback)
    const firstRawByKey = new Map();
    for (const n of names) {
      const k = makeKey(n);
      if (k && !firstRawByKey.has(k)) firstRawByKey.set(k, String(n).trim());
    }
    const unique = [...firstRawByKey.keys()];
    const resultByKey = new Map();

    // small concurrency cap to stay within Gemini rate limits
    const POOL = 5;
    for (let i = 0; i < unique.length; i += POOL) {
      const slice = unique.slice(i, i + POOL);
      const resolved = await Promise.all(slice.map((k) => resolve(firstRawByKey.get(k))));
      slice.forEach((k, idx) => resultByKey.set(k, resolved[idx]));
    }
    return names.map((n) => resultByKey.get(makeKey(n)) ?? String(n || '').trim());
  }

  async function persist(key, canonical, meta) {
    lru.set(key, canonical);
    await cache.updateOne(
      { key },
      { $setOnInsert: { key, canonical, ...meta, createdAt: new Date() } },
      { upsert: true }
    );
  }

  /** Rows needing a human eye (low-confidence LLM or unresolved). */
  function reviewQueue(limit = 100) {
    return cache.find({ needsReview: true }).limit(limit).toArray();
  }

  return { init, resolve, resolveBatch, reviewQueue };
}
