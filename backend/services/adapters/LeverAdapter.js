import axios from 'axios';

/**
 * Fetch open jobs for one company from Lever's public postings API.
 * No auth required — this is a public, ToS-safe endpoint (not scraping).
 */
export async function fetchLeverJobs(companySlug) {
  const url = `https://api.lever.co/v0/postings/${companySlug}`;

  let res;
  try {
    res = await axios.get(url, { params: { mode: 'json' }, timeout: 15_000 });
  } catch (err) {
    if (err.response?.status === 404) {
      console.warn(`Lever: unknown company slug "${companySlug}"`);
      return [];
    }
    throw new Error(`Lever fetch failed for "${companySlug}": ${err.message}`);
  }

  const postings = Array.isArray(res.data) ? res.data : [];
  return postings.map((posting) => normalize(posting, companySlug));
}

function normalize(posting, companySlug) {
  return {
    source: 'lever',
    sourceJobId: String(posting.id),
    company: companySlug,
    title: posting.text || '',
    location: posting.categories?.location || '',
    department: posting.categories?.team || '',
    descriptionText: stripHtml(posting.descriptionPlain || posting.description || ''),
    applyUrl: posting.applyUrl || posting.hostedUrl || '',
    postedAt: posting.createdAt ? new Date(posting.createdAt) : null,
  };
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", nbsp: ' ' };

function stripHtml(html) {
  const decoded = html
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
