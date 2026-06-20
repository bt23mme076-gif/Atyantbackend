import axios from 'axios';

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
// harvestapi/linkedin-profile-scraper — 99.6% success, no cookies needed
const ACTOR_ID = 'harvestapi~linkedin-profile-scraper';

/**
 * Scrape a LinkedIn profile via Apify and return structured mentor fields.
 * Runs synchronously (waits for result, max 60s).
 */
export async function extractLinkedInProfile(linkedinUrl) {
  if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not set in environment');

  // Normalize URL — strip query params, trailing slashes, force clean profile URL
  let url;
  try {
    const parsed = new URL(linkedinUrl.trim());
    url = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    url = linkedinUrl.trim().split('?')[0].replace(/\/$/, '');
  }
  if (!url.includes('linkedin.com/in/')) {
    throw new Error('Invalid LinkedIn profile URL. Must be a linkedin.com/in/ profile link.');
  }

  // Run actor and wait synchronously (Apify returns when run finishes)
  let runRes;
  try {
    runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`,
      { urls: [url], maxItems: 1 },
      {
        params: { token: APIFY_TOKEN, memory: 256 },
        timeout: 90_000,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (axiosErr) {
    const apifyMsg = axiosErr.response?.data?.error?.message
      || axiosErr.response?.data?.message
      || JSON.stringify(axiosErr.response?.data)
      || axiosErr.message;
    console.error('Apify API error:', axiosErr.response?.status, apifyMsg);
    throw new Error(`Apify error (${axiosErr.response?.status || 'network'}): ${apifyMsg}`);
  }

  const items = runRes.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('LinkedIn profile not found or scraper returned no data. The profile may be private.');
  }

  return mapToMentorFields(items[0]);
}

function mapToMentorFields(p) {
  // harvestapi returns: fullName, headline, summary, location, profileUrl,
  // positions (array), educations (array), skills (array of strings or objects)

  // ── Education: pick the most recent entry ──
  const edus = Array.isArray(p.educations) ? p.educations
    : Array.isArray(p.education) ? p.education : [];
  const edu = edus.sort((a, b) => (b.endYear || b.end?.year || 9999) - (a.endYear || a.end?.year || 9999))[0] || null;

  // ── Experience: unique company names, most recent first ──
  const positions = Array.isArray(p.positions) ? p.positions
    : Array.isArray(p.experiences) ? p.experiences
    : Array.isArray(p.workExperience) ? p.workExperience : [];

  const topCompanies = [...new Set(
    positions
      .sort((a, b) => (b.startYear || b.start?.year || 0) - (a.startYear || a.start?.year || 0))
      .map(e => e.companyName || e.company || e.organization)
      .filter(Boolean)
  )].slice(0, 5);

  // ── Skills — top 5 only ──
  const rawSkills = Array.isArray(p.skills) ? p.skills : [];
  const expertise = rawSkills
    .map(s => (typeof s === 'string' ? s : s?.name || s?.skill))
    .filter(Boolean).slice(0, 5);

  // ── Location ──
  const city = extractCity(p.location || p.geoLocation || p.locationName || '');

  // ── Graduation year ──
  const year = String(edu?.endYear || edu?.end?.year || '');

  // ── Degree ──
  const degree = normalizeDegree(edu?.degree || edu?.degreeName || edu?.fieldOfStudy || '');

  // ── Branch ──
  const branch = edu?.fieldOfStudy || edu?.field || edu?.specialization || '';

  // ── College ──
  const college = edu?.schoolName || edu?.school || edu?.institutionName || '';

  // ── Story / bio ──
  const story = p.summary || p.about || p.description || '';
  const bio = (p.headline || story).slice(0, 500);

  return {
    username: p.fullName || p.name || p.firstName && p.lastName ? `${p.firstName} ${p.lastName}`.trim() : (p.firstName || p.lastName || ''),
    college,
    branch,
    year,
    degree,
    topCompanies,
    expertise,
    bio,
    city,
    story,
    linkedinProfile: p.profileUrl || p.linkedInUrl || p.url || '',
  };
}

function extractCity(location) {
  if (!location) return '';
  // Apify may return a string or an object like { city, country, ... }
  if (typeof location === 'object') {
    return String(location.city || location.name || location.localizedName || Object.values(location)[0] || '').trim();
  }
  return String(location).split(',')[0].trim();
}

function normalizeDegree(raw) {
  if (!raw) return 'B.Tech';
  const r = raw.toLowerCase();
  if (r.includes('b.tech') || r.includes('btech') || r.includes('bachelor of technology')) return 'B.Tech';
  if (r.includes('b.e') || r.includes('be ') || r.includes('bachelor of engineering')) return 'B.E';
  if (r.includes('m.tech') || r.includes('mtech')) return 'M.Tech';
  if (r.includes('mba')) return 'MBA';
  if (r.includes('bsc') || r.includes('b.sc')) return 'B.Sc';
  if (r.includes('msc') || r.includes('m.sc')) return 'M.Sc';
  return raw.slice(0, 50);
}
