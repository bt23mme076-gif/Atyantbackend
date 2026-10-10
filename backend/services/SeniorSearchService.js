// Finds real seniors on the public web (LinkedIn profiles via Google, through
// Serper.dev) when we have no mentor in our own pool for a student. Results are
// only shown to the student so they can invite the senior themselves — we never
// contact these people and never persist them beyond a short in-memory cache.

const SERPER_URL = 'https://google.serper.dev/search';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // query -> { at, results }

const LINKEDIN_PROFILE = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i;

export function linkedinSlug(url = '') {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

export function isLinkedinProfileUrl(url = '') {
  return LINKEDIN_PROFILE.test(String(url));
}

// "Priya Sharma - SDE II - Amazon | LinkedIn" -> { name, headline }
function parseResult({ title = '', link = '', snippet = '' }) {
  if (!isLinkedinProfileUrl(link)) return null;
  const clean = title.replace(/\s*[|·]\s*LinkedIn.*$/i, '').trim();
  const [name, ...rest] = clean.split(/\s+[-–—]\s+/);
  if (!name || name.length > 60) return null;
  return {
    name: name.trim(),
    headline: rest.join(' · ').trim().slice(0, 160),
    linkedinUrl: link.match(LINKEDIN_PROFILE)[0],
    snippet: snippet.slice(0, 240),
  };
}

const q = (s) => `"${String(s).replace(/"/g, '').trim()}"`;

// Most specific first; we fall back only while results are thin.
function buildQueries(context = {}) {
  const id = context.identity || {};
  const company = (context.targetCompanies || [])[0];
  const college = id.college;
  const branch = id.branch;
  const goal = context.target;
  const base = 'site:linkedin.com/in';
  const out = [];
  if (college && company && branch) out.push(`${base} ${q(college)} ${q(company)} ${branch}`);
  if (college && company) out.push(`${base} ${q(college)} ${q(company)}`);
  if (college && goal) out.push(`${base} ${q(college)} ${goal}`);
  if (company && branch) out.push(`${base} ${q(company)} ${branch}`);
  return [...new Set(out)];
}

async function serperSearch(query) {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

  const res = await fetch(SERPER_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'in', num: 10 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  const results = (data.organic || []).map(parseResult).filter(Boolean);

  if (cache.size > 2000) cache.clear();
  cache.set(query, { at: Date.now(), results });
  return results;
}

export async function findSeniors(context = {}, limit = 6) {
  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY not set');
  const queries = buildQueries(context);
  const seen = new Set();
  const seniors = [];
  let usedQuery = null;

  for (const query of queries) {
    const results = await serperSearch(query);
    for (const r of results) {
      const slug = linkedinSlug(r.linkedinUrl);
      if (seen.has(slug)) continue;
      seen.add(slug);
      seniors.push(r);
    }
    usedQuery = usedQuery || (results.length ? query : null);
    if (seniors.length >= limit) break;
  }

  return { seniors: seniors.slice(0, limit), query: usedQuery };
}
