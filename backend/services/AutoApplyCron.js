import cron from 'node-cron';
import User from '../models/User.js';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import { matchJobsForUser } from './MatchingEngine.js';
import { downloadFileBuffer } from './autoapply/PlaywrightRunner.js';
import { applyGreenhouse } from './autoapply/GreenhouseApplyAdapter.js';
import { applyLever } from './autoapply/LeverApplyAdapter.js';
import { generateCoverLetter } from './CoverLetterService.js';
import { getAnswerMap } from '../models/ApplicationAnswer.js';

const MAX_NEW_APPLICATIONS_PER_USER_PER_RUN = 3;

const ADAPTERS = {
  greenhouse: applyGreenhouse,
  lever: applyLever,
};

class AutoApplyCron {
  start() {
    // Every 30 minutes — enqueue new matches, then work through the queue.
    cron.schedule('*/30 * * * *', async () => {
      console.log('🤖 Running auto-apply cycle...');
      await this.runCycle();
    });

    console.log('✅ Auto-apply cron started');
  }

  async runCycle() {
    await this.enqueueMatches();
    await this.processQueue();
  }

  async enqueueMatches() {
    const users = await User.find({ 'autoApply.enabled': true }).lean();

    for (const user of users) {
      try {
        const jobs = await Job.find({
          status: 'open',
          source: { $in: ['greenhouse', 'lever'] },
          autoApplySupported: true,
          company: { $nin: user.autoApply?.excludedCompanies || [] },
        }).lean();

        const ranked = matchJobsForUser(user, jobs, { minScore: user.autoApply?.minMatchScore ?? 70 });

        let queued = 0;
        for (const { job, score } of ranked) {
          if (queued >= MAX_NEW_APPLICATIONS_PER_USER_PER_RUN) break;

          try {
            await Application.create({
              user: user._id,
              job: job._id,
              status: 'queued',
              matchScoreAtQueue: score,
            });
            queued += 1;
          } catch (err) {
            // Duplicate key = already applied/queued for this job. Expected, not an error.
            if (err.code !== 11000) console.error(`Enqueue error for user ${user._id}, job ${job._id}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Auto-apply enqueue error for user ${user._id}:`, err.message);
      }
    }
  }

  async processQueue() {
    const queued = await Application.find({ status: 'queued' }).limit(20).lean();

    for (const appDoc of queued) {
      await this.processOne(appDoc);
    }
  }

  async processOne(appDoc) {
    try {
      const [user, job] = await Promise.all([
        User.findById(appDoc.user).lean(),
        Job.findById(appDoc.job).lean(),
      ]);

      if (!user || !job) {
        await Application.updateOne({ _id: appDoc._id }, { status: 'failed', reason: 'User or job no longer exists' });
        return;
      }
      if (!user.autoApply?.enabled) {
        await Application.updateOne({ _id: appDoc._id }, { status: 'failed', reason: 'Auto-apply disabled by user before processing' });
        return;
      }

      const adapter = ADAPTERS[job.source];
      if (!adapter) {
        await Application.updateOne({ _id: appDoc._id }, { status: 'failed', reason: `No adapter for source "${job.source}"` });
        return;
      }

      let resumeBuffer = null;
      if (user.resumeUrl) {
        try {
          resumeBuffer = await downloadFileBuffer(user.resumeUrl);
        } catch (err) {
          await Application.updateOne({ _id: appDoc._id }, { status: 'needs_manual_action', reason: `Could not fetch resume: ${err.message}` });
          return;
        }
      }

      // Only Greenhouse forms have a cover-letter field — skip the Groq call for Lever.
      let coverLetterText = '';
      if (job.source === 'greenhouse') {
        try {
          coverLetterText = await generateCoverLetter({ user, job });
        } catch (err) {
          console.error(`Cover letter generation failed for application ${appDoc._id}:`, err.message);
        }
      }

      const savedAnswers = await getAnswerMap(user._id);
      const result = await adapter({ job, user, resumeBuffer, resumeFilename: 'resume.pdf', coverLetterText, savedAnswers });

      await Application.updateOne(
        { _id: appDoc._id },
        {
          status: result.status,
          reason: result.reason || '',
          confirmationText: result.confirmationText || '',
          resumeUrlUsed: user.resumeUrl || '',
          coverLetterText,
          unansweredQuestions: result.unansweredQuestions || [],
          submittedAt: result.status === 'submitted' ? new Date() : null,
        },
      );

      console.log(`  application ${appDoc._id} (${job.source}/${job.company}): ${result.status}${result.reason ? ' — ' + result.reason : ''}`);
    } catch (err) {
      console.error(`Auto-apply process error for application ${appDoc._id}:`, err.message);
      await Application.updateOne({ _id: appDoc._id }, { status: 'failed', reason: err.message }).catch(() => {});
    }
  }
}

export default new AutoApplyCron();
