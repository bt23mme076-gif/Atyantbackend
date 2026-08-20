import cron from 'node-cron';
import Job from '../models/Job.js';
import { fetchGreenhouseJobs } from './adapters/GreenhouseAdapter.js';
import { fetchLeverJobs } from './adapters/LeverAdapter.js';
import { fetchFirecrawlJobs } from './adapters/FirecrawlAdapter.js';
import { GREENHOUSE_BOARD_TOKENS, LEVER_COMPANY_SLUGS, FIRECRAWL_CAREER_PAGES } from '../config/atsCompanies.js';

// Only ATS-hosted forms can be driven by the auto-apply adapters. A company
// embedding Greenhouse behind careers.acme.com serves its own page there, so
// the form fields simply aren't present at that URL.
function isAtsHostedUrl(url = '') {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith('greenhouse.io') || hostname.endsWith('lever.co');
  } catch {
    return false;
  }
}

class JobSyncCron {
  start() {
    // Every 6 hours — matches how often these boards actually change.
    cron.schedule('0 */6 * * *', async () => {
      console.log('🧭 Running job sync...');
      await this.syncNow();
    });

    console.log('✅ Job sync cron started');
  }

  async syncNow() {
    const runStartedAt = new Date();

    for (const token of GREENHOUSE_BOARD_TOKENS) {
      await this.syncOne('greenhouse', token, () => fetchGreenhouseJobs(token), runStartedAt);
    }
    for (const slug of LEVER_COMPANY_SLUGS) {
      await this.syncOne('lever', slug, () => fetchLeverJobs(slug), runStartedAt);
    }
    for (const { company, url } of FIRECRAWL_CAREER_PAGES) {
      await this.syncOne('firecrawl', company, () => fetchFirecrawlJobs(company, url), runStartedAt);
    }
  }

  async syncOne(source, companyKey, fetchFn, runStartedAt) {
    try {
      const jobs = await fetchFn();

      for (const job of jobs) {
        await Job.findOneAndUpdate(
          { source: job.source, sourceJobId: job.sourceJobId },
          {
            ...job,
            status: 'open',
            lastSeenAt: runStartedAt,
            autoApplySupported: isAtsHostedUrl(job.applyUrl),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }

      // Postings that existed before this run but weren't seen this time are gone
      // from the board — most likely filled or pulled. Mark them closed rather
      // than deleting, so match history / application tracking stays intact.
      const closedRes = await Job.updateMany(
        { source, company: companyKey, status: 'open', lastSeenAt: { $lt: runStartedAt } },
        { $set: { status: 'closed' } },
      );

      console.log(`  ${source}/${companyKey}: ${jobs.length} open, ${closedRes.modifiedCount} closed`);
    } catch (err) {
      console.error(`Job sync error (${source}/${companyKey}):`, err.message);
    }
  }
}

export default new JobSyncCron();
