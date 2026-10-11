// Finds real seniors on the public web (LinkedIn profiles via Google, through
// Serper.dev) when we have no mentor in our own pool for a student. Results are
// only shown to the student so they can invite the senior themselves — we never
// contact these people and never persist them beyond a short in-memory cache.

import { getCollegeAliases, buildCollegeRegex } from '../utils/collegeNormalizer.js';

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
const anyOf = (terms) => (terms.length > 1 ? `(${terms.map(q).join(' OR ')})` : q(terms[0]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Goal text -> the job titles seniors on that path actually put in their headline.
const ROLE_TITLES = [
  { re: /product|\bapm\b|\bpm\b/i, label: 'Product', titles: ['Product Manager', 'Associate Product Manager', 'APM'] },
  { re: /\bsde\b|software|developer|\bswe\b|coding|full.?stack|backend|frontend/i, label: 'Software', titles: ['Software Engineer', 'SDE', 'Software Developer'] },
  { re: /data scien|machine learning|\bml\b|\bai\b/i, label: 'Data Science', titles: ['Data Scientist', 'ML Engineer'] },
  { re: /analyst|analytics|\bdata\b/i, label: 'Analytics', titles: ['Data Analyst', 'Business Analyst', 'Analyst'] },
  { re: /consult/i, label: 'Consulting', titles: ['Consultant', 'Associate Consultant'] },
  { re: /design|\bux\b|\bui\b/i, label: 'Design', titles: ['Product Designer', 'UX Designer'] },
  { re: /finance|banking|\bib\b|investment/i, label: 'Finance', titles: ['Investment Banking', 'Analyst'] },
];

function roleFor(goal = '') {
  return ROLE_TITLES.find(r => r.re.test(goal)) || null;
}

// "Mittal Institute of Technology, Nagpur" -> ["Mittal Institute of Technology", "MIT Nagpur", ...]
function collegeNames(college) {
  const names = getCollegeAliases(college.split(',')[0]).filter(n => n && n.length >= 3);
  return [...new Set(names)].slice(0, 4);
}

const GENERIC_WORDS = new Set(['institute', 'of', 'technology', 'college', 'engineering', 'university', 'and', 'the', 'national', 'school', 'science', 'sciences', 'research']);

// Seniors must be from the student's own college — the whole point of the invite.
// Alias-aware first ("VNIT" == "Visvesvaraya NIT"), then the college's distinctive
// words all present ("Mittal" for "Mittal Institute of Technology").
function fromCollege(text, college) {
  if (buildCollegeRegex(college.split(',')[0]).test(text)) return true;
  const words = college.split(',')[0].toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
  return words.length > 0 && words.every(w => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(text));
}

// Every query carries the college; most specific first, we fall back only while results are thin.
function buildQueries(context = {}) {
  const id = context.identity || {};
  if (!id.college) return [];
  const company = (context.targetCompanies || [])[0];
  const role = roleFor(context.target);
  const college = anyOf(collegeNames(id.college));
  const base = 'site:linkedin.com/in';
  const out = [];
  if (company && role) out.push(`${base} ${college} ${q(company)} ${anyOf(role.titles)}`);
  if (company) out.push(`${base} ${college} ${q(company)}`);
  if (role) out.push(`${base} ${college} ${anyOf(role.titles)}`);
  if (id.branch) out.push(`${base} ${college} ${q(id.branch)}`);
  return [...new Set(out)];
}

// Why this senior is relevant, strongest first; also drives ranking.
function scoreSenior(r, context) {
  const text = `${r.headline} ${r.snippet}`;
  const company = (context.targetCompanies || [])[0];
  const role = roleFor(context.target);
  const matchedOn = ['Your college'];
  let score = 0;
  if (company && new RegExp(`\\b${escapeRe(company)}\\b`, 'i').test(text)) { matchedOn.push(company); score += 3; }
  if (role && role.titles.some(t => new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(text))) { matchedOn.push(role.label); score += 2; }
  const branch = context.identity?.branch;
  if (branch?.length >= 4 && new RegExp(`\\b${escapeRe(branch)}\\b`, 'i').test(text)) { matchedOn.push(branch); score += 1; }
  // Current students/aspirants can't tell the junior how they got there.
  if (/\b(student|aspiring|pursuing|undergrad)\b/i.test(r.headline)) score -= 2;
  return { score, matchedOn };
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
  const college = context.identity?.college;
  const seen = new Set();
  const seniors = [];
  let usedQuery = null;

  for (const query of queries) {
    const results = await serperSearch(query);
    let added = 0;
    for (const r of results) {
      const slug = linkedinSlug(r.linkedinUrl);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      if (!fromCollege(`${r.name} ${r.headline} ${r.snippet}`, college)) continue;
      seniors.push({ ...r, ...scoreSenior(r, context) });
      added++;
    }
    usedQuery = usedQuery || (added ? query : null);
    if (seniors.length >= limit) break;
  }

  seniors.sort((a, b) => b.score - a.score);
  return {
    seniors: seniors.slice(0, limit).map(({ score, ...s }) => s),
    query: usedQuery,
  };
}
