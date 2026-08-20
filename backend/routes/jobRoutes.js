import express from 'express';
import Job from '../models/Job.js';
import User from '../models/User.js';
import Application from '../models/Application.js';
import ApplicationAnswer, { normalizeQuestionKey, getAnswerMap } from '../models/ApplicationAnswer.js';
import protect from '../middleware/authMiddleware.js';
import JobSyncCron from '../services/JobSyncCron.js';
import AutoApplyCron from '../services/AutoApplyCron.js';
import { matchJobsForUser } from '../services/MatchingEngine.js';
import { generateCoverLetter } from '../services/CoverLetterService.js';
import { downloadFileBuffer } from '../services/autoapply/PlaywrightRunner.js';
import { applyGreenhouse } from '../services/autoapply/GreenhouseApplyAdapter.js';
import { applyLever } from '../services/autoapply/LeverApplyAdapter.js';

const AUTO_APPLY_ADAPTERS = { greenhouse: applyGreenhouse, lever: applyLever };

const router = express.Router();

// ─────────────────────────────────────────────
//  GET /  — list open jobs (filters: company, source, location, q)
//  Public: browsing the board is the top-of-funnel hook, so it must work
//  before sign-in. Everything that acts on a job (cover letter, auto-apply,
//  marking applied, resume matching) still requires auth below.
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { company, source, location, q, remote, page = 1, limit = 20 } = req.query;

    const filter = { status: 'open' };
    if (company) filter.company = company;
    if (source) filter.source = source;
    // "Remote only" is a distinct signal from free-text location — most remote
    // postings are tagged like "Remote - US"/"Remote, France" in the location
    // field, so an explicit toggle just filters on that word rather than
    // fighting with whatever the user typed in the location box.
    if (remote === 'true') filter.location = /remote/i;
    else if (location) filter.location = new RegExp(location, 'i');
    if (q) filter.title = new RegExp(q, 'i');

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .sort({ postedAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Job.countDocuments(filter),
    ]);

    res.json({ jobs, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error('GET /api/jobs error:', error);
    res.status(500).json({ message: 'Failed to fetch jobs', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /companies  — distinct companies with open postings, for the filter dropdown
// ─────────────────────────────────────────────
router.get('/companies', async (req, res) => {
  try {
    const companies = await Job.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: '$company', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, company: '$_id', count: 1 } },
    ]);
    res.json({ companies });
  } catch (error) {
    console.error('GET /api/jobs/companies error:', error);
    res.status(500).json({ message: 'Failed to fetch companies', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /matches  — open jobs scored against the current user's profile
// ─────────────────────────────────────────────
router.get('/matches', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('skills projects preferredRoles')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const hasSignal = (user.skills?.length || 0) > 0 || (user.projects?.length || 0) > 0;
    if (!hasSignal) {
      return res.status(400).json({
        message: 'No skills or projects on file yet — extract your resume first (POST /api/profile/extract-skills, then save via PUT /api/profile/me).',
      });
    }

    const { page = 1, limit = 20, minScore = 0 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const jobs = await Job.find({ status: 'open' }).lean();
    const ranked = matchJobsForUser(user, jobs, { minScore: Number(minScore) || 0 });

    const total = ranked.length;
    const pageItems = ranked.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      matches: pageItems.map(({ job, score, matchedSkills }) => ({
        job: {
          _id: job._id,
          company: job.company,
          title: job.title,
          location: job.location,
          source: job.source,
          applyUrl: job.applyUrl,
          autoApplySupported: job.autoApplySupported,
        },
        score,
        matchedSkills,
      })),
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (error) {
    console.error('GET /api/jobs/matches error:', error);
    res.status(500).json({ message: 'Failed to compute matches', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /:jobId/cover-letter  — generate a tailored cover letter for one job
// ─────────────────────────────────────────────
router.post('/:jobId/cover-letter', protect, async (req, res) => {
  try {
    const [user, job] = await Promise.all([
      User.findById(req.user.userId).select('name skills projects education').lean(),
      Job.findById(req.params.jobId).lean(),
    ]);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const coverLetter = await generateCoverLetter({ user, job });
    res.json({ coverLetter });
  } catch (error) {
    console.error('POST /api/jobs/:jobId/cover-letter error:', error);
    res.status(500).json({ message: 'Failed to generate cover letter', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  PUT /auto-apply/settings  — opt in/out of auto-apply (Greenhouse/Lever only)
//  Enabling requires an explicit confirm:true — this is the consent checkbox,
//  not a default-on toggle.
// ─────────────────────────────────────────────
router.put('/auto-apply/settings', protect, async (req, res) => {
  try {
    const { enabled, minMatchScore, excludedCompanies, phone, confirm } = req.body;

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (enabled === true) {
      if (confirm !== true) {
        return res.status(400).json({
          message: 'Enabling auto-apply requires confirm:true — this authorizes Atyant to submit applications to Greenhouse/Lever job forms on your behalf using your resume and profile data.',
        });
      }
      if (!user.resumeUrl) {
        return res.status(400).json({ message: 'Upload a resume first (POST /api/profile/upload-resume)' });
      }
      user.autoApply.consentedAt = new Date();
    }

    if (enabled !== undefined) user.autoApply.enabled = Boolean(enabled);
    if (minMatchScore !== undefined) user.autoApply.minMatchScore = Math.min(100, Math.max(0, Number(minMatchScore)));
    if (excludedCompanies !== undefined) {
      user.autoApply.excludedCompanies = Array.isArray(excludedCompanies) ? excludedCompanies.map(String) : [];
    }
    if (phone !== undefined) user.autoApply.phone = String(phone).trim();

    await user.save();

    res.json({ message: 'Auto-apply settings updated', autoApply: user.autoApply });
  } catch (error) {
    console.error('PUT /api/jobs/auto-apply/settings error:', error);
    res.status(500).json({ message: 'Failed to update settings', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /:jobId/mark-applied  — self-report a manual (assisted) application
// ─────────────────────────────────────────────
router.post('/:jobId/mark-applied', protect, async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const application = await Application.findOneAndUpdate(
      { user: req.user.userId, job: job._id },
      { mode: 'manual', status: 'submitted', submittedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ message: 'Marked as applied', application });
  } catch (error) {
    console.error('POST /api/jobs/:jobId/mark-applied error:', error);
    res.status(500).json({ message: 'Failed to mark as applied', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /:jobId/auto-apply-now  — run the real auto-apply engine on one job,
//  immediately, instead of waiting for the 30-min background cron.
//  Requires the same consent as the passive engine (autoApply.enabled) —
//  this is the same action, just triggered on demand instead of by schedule.
// ─────────────────────────────────────────────
router.post('/:jobId/auto-apply-now', protect, async (req, res) => {
  try {
    const [user, job] = await Promise.all([
      User.findById(req.user.userId).lean(),
      Job.findById(req.params.jobId).lean(),
    ]);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!user.autoApply?.enabled) {
      return res.status(400).json({ message: 'Enable Auto-Apply in settings first — this authorizes Atyant to submit on your behalf.' });
    }
    if (!user.resumeUrl) {
      return res.status(400).json({ message: 'Upload a resume first (POST /api/profile/upload-resume)' });
    }

    const adapter = AUTO_APPLY_ADAPTERS[job.source];
    if (!adapter) {
      return res.status(400).json({ message: `Auto-apply isn't supported for "${job.source}" jobs` });
    }
    if (!job.autoApplySupported) {
      return res.status(400).json({ message: `${job.company} hosts its own application form, so it has to be filled in by hand — use Apply instead.` });
    }

    let resumeBuffer;
    try {
      resumeBuffer = await downloadFileBuffer(user.resumeUrl);
    } catch (err) {
      return res.status(502).json({ message: `Could not fetch resume: ${err.message}` });
    }

    let coverLetterText = '';
    if (job.source === 'greenhouse') {
      try {
        coverLetterText = await generateCoverLetter({ user, job });
      } catch (err) {
        console.error(`Cover letter generation failed for on-demand auto-apply (job ${job._id}):`, err.message);
      }
    }

    const savedAnswers = await getAnswerMap(user._id);
    const result = await adapter({ job, user, resumeBuffer, resumeFilename: 'resume.pdf', coverLetterText, savedAnswers });

    const application = await Application.findOneAndUpdate(
      { user: user._id, job: job._id },
      {
        mode: 'auto',
        status: result.status,
        reason: result.reason || '',
        confirmationText: result.confirmationText || '',
        resumeUrlUsed: user.resumeUrl,
        coverLetterText,
        unansweredQuestions: result.unansweredQuestions || [],
        submittedAt: result.status === 'submitted' ? new Date() : null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ application });
  } catch (error) {
    console.error('POST /api/jobs/:jobId/auto-apply-now error:', error);
    res.status(500).json({ message: 'Auto-apply failed', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /application-answers  — the student's saved answer bank
// ─────────────────────────────────────────────
router.get('/application-answers', protect, async (req, res) => {
  try {
    const answers = await ApplicationAnswer.find({ user: req.user.userId }).sort({ questionText: 1 }).lean();
    res.json({ answers });
  } catch (error) {
    console.error('GET /api/jobs/application-answers error:', error);
    res.status(500).json({ message: 'Failed to fetch saved answers', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /application-answers  — save one or more answers, keyed by normalized
//  question text so the same answer applies across every company that asks
//  the same/similar question. Body: { answers: [{ questionText, answerText }] }
// ─────────────────────────────────────────────
router.post('/application-answers', protect, async (req, res) => {
  try {
    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ message: 'answers must be a non-empty array of { questionText, answerText }' });
    }

    const saved = [];
    for (const { questionText, answerText } of answers) {
      if (!questionText || !answerText) continue;
      const questionKey = normalizeQuestionKey(questionText);
      if (!questionKey) continue;

      const doc = await ApplicationAnswer.findOneAndUpdate(
        { user: req.user.userId, questionKey },
        { questionText: String(questionText).trim(), answerText: String(answerText).trim() },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      saved.push(doc);
    }

    res.json({ answers: saved });
  } catch (error) {
    console.error('POST /api/jobs/application-answers error:', error);
    res.status(500).json({ message: 'Failed to save answers', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  DELETE /application-answers/:id  — remove a saved answer
// ─────────────────────────────────────────────
router.delete('/application-answers/:id', protect, async (req, res) => {
  try {
    await ApplicationAnswer.deleteOne({ _id: req.params.id, user: req.user.userId });
    res.json({ message: 'Deleted' });
  } catch (error) {
    console.error('DELETE /api/jobs/application-answers/:id error:', error);
    res.status(500).json({ message: 'Failed to delete answer', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /applications  — the current user's own application audit trail
// ─────────────────────────────────────────────
router.get('/applications', protect, async (req, res) => {
  try {
    const applications = await Application.find({ user: req.user.userId })
      .populate('job', 'company title location source applyUrl')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ applications });
  } catch (error) {
    console.error('GET /api/jobs/applications error:', error);
    res.status(500).json({ message: 'Failed to fetch applications', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /auto-apply/run  — admin-only manual trigger (for testing)
// ─────────────────────────────────────────────
router.post('/auto-apply/run', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    await AutoApplyCron.runCycle();
    res.json({ message: 'Auto-apply cycle completed' });
  } catch (error) {
    console.error('POST /api/jobs/auto-apply/run error:', error);
    res.status(500).json({ message: 'Auto-apply run failed', error: error.message });
  }
});

// ─────────────────────────────────────────────
//  POST /sync  — admin-only manual trigger (for testing / on-demand refresh)
// ─────────────────────────────────────────────
router.post('/sync', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    await JobSyncCron.syncNow();
    res.json({ message: 'Job sync completed' });
  } catch (error) {
    console.error('POST /api/jobs/sync error:', error);
    res.status(500).json({ message: 'Sync failed', error: error.message });
  }
});

export default router;
