import axios from 'axios';

/**
 * Fetch open jobs for one company from Greenhouse's public job-board API.
 * No auth required — this is a public, ToS-safe endpoint (not scraping).
 */
export async function fetchGreenhouseJobs(boardToken) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`;

  let res;
  try {
    res = await axios.get(url, { params: { content: true }, timeout: 15_000 });
  } catch (err) {
    if (err.response?.status === 404) {
      console.warn(`Greenhouse: unknown board token "${boardToken}"`);
      return [];
    }
    throw new Error(`Greenhouse fetch failed for "${boardToken}": ${err.message}`);
  }

  const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
  return jobs.map((job) => normalize(job, boardToken));
}

function normalize(job, boardToken) {
  return {
    source: 'greenhouse',
    sourceJobId: String(job.id),
    company: boardToken,
    title: job.title || '',
    location: job.location?.name || '',
    department: job.departments?.[0]?.name || '',
    descriptionText: stripHtml(job.content || ''),
    applyUrl: job.absolute_url || '',
    postedAt: job.updated_at ? new Date(job.updated_at) : null,
  };
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", nbsp: ' ' };

function stripHtml(html) {
  const decoded = html
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
