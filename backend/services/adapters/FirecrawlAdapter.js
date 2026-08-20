import axios from 'axios';
import crypto from 'crypto';

// Companies outside Greenhouse/Lever's public board APIs (custom career sites,
// Workday, Darwinbox, Keka, etc.) have no structured API to poll — firecrawl
// scrapes the rendered page and an LLM extracts the listings against this
// schema instead.
const JOB_LIST_SCHEMA = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          location: { type: 'string' },
          applyUrl: { type: 'string', description: 'Absolute URL to apply or view the posting' },
        },
        required: ['title', 'applyUrl'],
      },
    },
  },
  required: ['jobs'],
};

const EXTRACT_PROMPT = 'Extract every open job posting listed on this careers page: its title, ' +
  'location if shown, and the absolute URL to apply or view the posting. Skip anything that is ' +
  'not an actual job listing (e.g. department headers, "life at company" content).';

/**
 * Scrape one company's career page via a self-hosted firecrawl instance and
 * return jobs normalized to the same shape GreenhouseAdapter/LeverAdapter
 * produce. Scrape-only — there is no form-driving adapter for arbitrary
 * career sites, so callers must mark these autoApplySupported: false.
 */
export async function fetchFirecrawlJobs(company, careerPageUrl) {
  const baseUrl = process.env.FIRECRAWL_BASE_URL;
  if (!baseUrl) {
    console.warn('FIRECRAWL_BASE_URL not set — skipping firecrawl sync');
    return [];
  }

  let res;
  try {
    res = await axios.post(
      `${baseUrl.replace(/\/$/, '')}/v1/scrape`,
      {
        url: careerPageUrl,
        formats: ['extract'],
        extract: { schema: JOB_LIST_SCHEMA, prompt: EXTRACT_PROMPT },
      },
      {
        headers: process.env.FIRECRAWL_API_KEY
          ? { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` }
          : {},
        timeout: 60_000,
      },
    );
  } catch (err) {
    throw new Error(`Firecrawl scrape failed for "${company}" (${careerPageUrl}): ${err.message}`);
  }

  const jobs = res.data?.data?.extract?.jobs || [];
  return jobs
    .filter((j) => j.title && j.applyUrl)
    .map((job) => normalize(job, company, careerPageUrl));
}

function normalize(job, company, careerPageUrl) {
  const applyUrl = absoluteUrl(job.applyUrl, careerPageUrl);
  return {
    source: 'firecrawl',
    // No stable ID from the source site, so hash the (company, applyUrl) pair —
    // deterministic across syncs, changes only if the posting's URL changes.
    sourceJobId: crypto.createHash('sha1').update(`${company}:${applyUrl}`).digest('hex'),
    company,
    title: job.title,
    location: job.location || '',
    department: '',
    descriptionText: '',
    applyUrl,
    postedAt: null,
  };
}

function absoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}
