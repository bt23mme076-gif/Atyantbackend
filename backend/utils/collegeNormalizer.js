/**
 * College Normalizer
 * Maps all known aliases/variations of a college to one canonical name.
 * Used for matching students and mentors from the same college
 * regardless of how they typed the name.
 */

export const COLLEGE_ALIASES = {
  // ── NITs ──────────────────────────────────────────────────────────────────
  'nit nagpur': [
    'vnit', 'vnit nagpur', 'visvesvaraya nit', 'visvesvaraya national institute',
    'visvesvaraya national institute of technology',
    'visvessariya national institute technology',
    'visvesvaraya national institute of technology nagpur',
    'national institute of technology nagpur',
    'nit nagpur', 'nitngp', 'vnit nagpur'
  ],
  'nit warangal': [
    'nitw', 'nit warangal', 'national institute of technology warangal',
    'national institute of technology, warangal'
  ],
  'nit trichy': [
    'nitt', 'nit tiruchirappalli', 'national institute of technology tiruchirappalli',
    'national institute of technology trichy', 'nit trichy'
  ],
  'nit surathkal': [
    'nitk', 'nit karnataka', 'national institute of technology surathkal',
    'national institute of technology karnataka', 'nitk surathkal'
  ],
  'nit calicut': [
    'nitc', 'nit kozhikode', 'national institute of technology calicut',
    'national institute of technology kozhikode'
  ],
  'nit rourkela': [
    'nitr', 'national institute of technology rourkela',
    'national institute of technology, rourkela'
  ],
  'nit allahabad': [
    'mnnit', 'mnnit allahabad', 'motilal nehru national institute of technology',
    'motilal nehru nit', 'mnnit prayagraj'
  ],
  'nit jaipur': [
    'mnit', 'mnit jaipur', 'malaviya national institute of technology',
    'malaviya nit', 'malaviya national institute of technology jaipur'
  ],
  'nit surat': [
    'svnit', 'svnit surat', 'sardar vallabhbhai national institute of technology',
    'svnit gujarat'
  ],
  'nit kurukshetra': [
    'nitkkr', 'nit kkr', 'national institute of technology kurukshetra'
  ],
  'nit durgapur': [
    'nitdgp', 'national institute of technology durgapur'
  ],
  'nit patna': [
    'nitp', 'national institute of technology patna'
  ],
  'nit silchar': [
    'nits', 'national institute of technology silchar'
  ],
  'nit hamirpur': [
    'nith', 'national institute of technology hamirpur'
  ],
  'nit jalandhar': [
    'nitj', 'dr br ambedkar nit', 'dr. b.r. ambedkar national institute of technology'
  ],
  'nit bhopal': [
    'manit', 'manit bhopal', 'maulana azad national institute of technology',
    'maulana azad nit'
  ],
  'nit raipur': [
    'nitrr', 'national institute of technology raipur'
  ],
  'nit agartala': [
    'nita', 'national institute of technology agartala'
  ],
  'nit meghalaya': ['national institute of technology meghalaya'],
  'nit manipur': ['national institute of technology manipur'],
  'nit mizoram': ['national institute of technology mizoram'],
  'nit sikkim': ['national institute of technology sikkim'],
  'nit arunachal': ['national institute of technology arunachal pradesh'],
  'nit goa': ['national institute of technology goa'],
  'nit delhi': ['national institute of technology delhi'],
  'nit puducherry': ['national institute of technology puducherry'],
  'nit andhra': ['national institute of technology andhra pradesh'],
  'nit uttarakhand': ['national institute of technology uttarakhand'],

  // ── IITs ──────────────────────────────────────────────────────────────────
  'iit bombay': ['iitb', 'iit mumbai', 'indian institute of technology bombay', 'indian institute of technology mumbai'],
  'iit delhi': ['iitd', 'indian institute of technology delhi'],
  'iit madras': ['iitm', 'iit chennai', 'indian institute of technology madras', 'indian institute of technology chennai'],
  'iit kanpur': ['iitk', 'indian institute of technology kanpur'],
  'iit kharagpur': ['iitkgp', 'iit kgp', 'indian institute of technology kharagpur'],
  'iit roorkee': ['iitr', 'iit roorkee', 'indian institute of technology roorkee'],
  'iit guwahati': ['iitg', 'indian institute of technology guwahati'],
  'iit hyderabad': ['iith', 'indian institute of technology hyderabad'],
  'iit bhubaneswar': ['iitbbs', 'indian institute of technology bhubaneswar'],
  'iit gandhinagar': ['iitgn', 'indian institute of technology gandhinagar'],
  'iit jodhpur': ['iitj', 'indian institute of technology jodhpur'],
  'iit mandi': ['iitmandi', 'indian institute of technology mandi'],
  'iit patna': ['iitp', 'indian institute of technology patna'],
  'iit ropar': ['iitrpr', 'indian institute of technology ropar'],
  'iit indore': ['iiti', 'indian institute of technology indore'],
  'iit varanasi': ['iit bhu', 'iitbhu', 'bhu iit', 'indian institute of technology bhu', 'indian institute of technology varanasi'],
  'iit tirupati': ['indian institute of technology tirupati'],
  'iit palakkad': ['indian institute of technology palakkad'],
  'iit dharwad': ['indian institute of technology dharwad'],
  'iit jammu': ['indian institute of technology jammu'],
  'iit bhilai': ['indian institute of technology bhilai'],
  'iit goa': ['indian institute of technology goa'],

  // ── IIITs ─────────────────────────────────────────────────────────────────
  'iiit hyderabad': ['iiith', 'iiit-h', 'international institute of information technology hyderabad'],
  'iiit allahabad': ['iiita', 'iiit-a', 'indian institute of information technology allahabad'],
  'iiit bangalore': ['iiitb', 'iiit-b', 'international institute of information technology bangalore'],
  'iiit delhi': ['iiitd', 'iiit-d', 'indraprastha institute of information technology'],

  // ── Other popular colleges ─────────────────────────────────────────────────
  'bits pilani': ['bits', 'birla institute of technology and science', 'birla institute of technology and science pilani', 'bits-pilani'],
  'bits goa': ['bits goa campus', 'birla institute of technology and science goa'],
  'bits hyderabad': ['bits hyderabad campus', 'birla institute of technology and science hyderabad'],
  'vit vellore': ['vit', 'vellore institute of technology', 'vit university'],
  'srm': ['srm university', 'srm institute of science and technology'],
  'manipal': ['manipal institute of technology', 'mit manipal', 'manipal university'],
  'coep': ['college of engineering pune', 'coep technological university'],
  'vjti': ['veermata jijabai technological institute', 'vjti mumbai'],
};

// Build reverse lookup: alias → canonical
const aliasToCanonical = new Map();
for (const [canonical, aliases] of Object.entries(COLLEGE_ALIASES)) {
  // canonical itself
  aliasToCanonical.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    aliasToCanonical.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalize a college name to its canonical form.
 * Returns the canonical name if found, otherwise returns the input trimmed.
 * @param {string} name
 * @returns {string} canonical college name
 */
export function normalizeCollege(name) {
  if (!name) return '';
  const key = name.trim().toLowerCase();
  return aliasToCanonical.get(key) || name.trim();
}

/**
 * Get all known aliases for a college (including canonical).
 * Useful for building a MongoDB $or / $regex query.
 * @param {string} name
 * @returns {string[]} array of all known names for this college
 */
export function getCollegeAliases(name) {
  if (!name) return [];
  const canonical = normalizeCollege(name);
  const canonicalKey = canonical.toLowerCase();

  // Find the entry in COLLEGE_ALIASES
  const aliases = COLLEGE_ALIASES[canonicalKey] || [];
  return [canonical, ...aliases];
}

/**
 * Normalize an engineering branch/department to a canonical code so that
 * "MME", "Metallurgy", and "Metallurgy and Materials Engineering" all match.
 * Pattern-based (most specific first) to survive free-text variations.
 * @param {string} name
 * @returns {string} canonical branch code, or '' when unknown
 */
export function normalizeBranch(name) {
  if (!name) return '';
  const n = String(name).toLowerCase();

  if (/metall|materials|\bmme\b|\bmet\b/.test(n)) return 'metallurgy';
  if (/mining/.test(n)) return 'mining';
  if (/comput|\bcse\b|\bcs\b|software|computer science/.test(n)) return 'cse';
  if (/information tech|\bit\b/.test(n)) return 'it';
  if (/data science|\bds\b|machine learning|\bai\b|artificial intelligence/.test(n)) return 'ai-ds';
  if (/communication|\bece\b|electronics and comm/.test(n)) return 'ece';
  if (/electrical|\beee\b|\bee\b/.test(n)) return 'eee';
  if (/electronic/.test(n)) return 'ece';
  if (/mechanical|\bme\b|\bmech\b/.test(n)) return 'mechanical';
  if (/civil|\bce\b/.test(n)) return 'civil';
  if (/chemical|\bche\b|\bchem\b/.test(n)) return 'chemical';
  if (/aero|aeronaut|avionic/.test(n)) return 'aerospace';
  if (/bio/.test(n)) return 'biotech';
  if (/instrument/.test(n)) return 'instrumentation';
  if (/production|industrial/.test(n)) return 'production';
  if (/petro/.test(n)) return 'petroleum';
  if (/textile/.test(n)) return 'textile';
  if (/automobile|automotive/.test(n)) return 'automobile';
  if (/architect/.test(n)) return 'architecture';

  // Fallback: strip boilerplate words and punctuation so loose strings still compare.
  return n
    .replace(/engineering|technology|department|dept|branch|\bin\b|\bof\b|\band\b/g, '')
    .replace(/[^a-z]/g, '')
    .trim();
}

/**
 * True when two branch strings refer to the same engineering branch,
 * alias/abbreviation-aware. "MME" === "Metallurgy and Materials Engineering".
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameBranch(a, b) {
  if (!a || !b) return false;
  const na = normalizeBranch(a);
  const nb = normalizeBranch(b);
  return !!na && na === nb;
}

/**
 * Build a MongoDB regex condition that matches any known alias of a college.
 * @param {string} name
 * @returns {RegExp}
 */
export function buildCollegeRegex(name) {
  if (!name) return new RegExp('(?!)', 'i'); // matches nothing (never matches everything)
  const allNames = getCollegeAliases(name);
  // Escape special regex chars in each alias
  const escaped = allNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Word-boundary wrap so "vnit" can't match "SVNIT", "iit" can't match "IIIT", etc.
  // Longest-first so multi-word aliases win over their shorter prefixes.
  escaped.sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}
