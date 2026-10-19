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
import { autoApplyUsage, FREE_TRIAL_APPLIES } from './autoapply/limits.js';

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
      // Free trial, the ₹49 pass, or a plan. Once the trial is used up (or a pass/plan
      // lapses) the setting stays on but nothing more is applied.
      const usage = await autoApplyUsage(user);
      if (usage.mode === 'none') continue;
      try {
        const jobs = await Job.find({
          status: 'open',
          source: { $in: ['greenhouse', 'lever'] },
          autoApplySupported: true,
          company: { $nin: user.autoApply?.excludedCompanies || [] },
        }).lean();

        const ranked = matchJobsForUser(user, jobs, { minScore: user.autoApply?.minMatchScore ?? 70 });

        const cap = Math.min(MAX_NEW_APPLICATIONS_PER_USER_PER_RUN, usage.remaining);

        let queued = 0;
        for (const { job, score } of ranked) {
          if (queued >= cap) break;

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
    // Pro applications go out first when the queue is longer than one batch.
    const waiting = await Application.find({ status: 'queued' }).sort({ createdAt: 1 }).limit(200).lean();
    const proIds = new Set((await User.find({
      _id: { $in: [...new Set(waiting.map(a => String(a.user)))] },
      subscriptionPlan: 'pro',
    }).select('_id').lean()).map(u => String(u._id)));
    const queued = [
      ...waiting.filter(a => proIds.has(String(a.user))),
      ...waiting.filter(a => !proIds.has(String(a.user))),
    ].slice(0, 20);

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
      // This queued application is already counted in `used`, so a trial user on their
      // last free slot still shows mode "none" — only fail when they're past the trial.
      const usage = await autoApplyUsage(user);
      if (usage.mode === 'none' && usage.used > FREE_TRIAL_APPLIES) {
        await Application.updateOne({ _id: appDoc._id }, { status: 'failed', reason: 'Free auto-applies used up — get the Auto-Apply pass to continue' });
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
