import express from 'express';
import Roadmap from '../models/Roadmap.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

const FALLBACK_STEPS = (goal) => [
  {
    phase: 'Phase 1',
    title: 'Foundations',
    duration: '4–6 weeks',
    status: 'active',
    tasks: [
      'Learn core concepts and tools relevant to your goal',
      'Set up GitHub portfolio with a clean profile',
      'Complete 1 foundational course (Coursera / YouTube)',
    ],
  },
  {
    phase: 'Phase 2',
    title: 'Project Portfolio',
    duration: '6–8 weeks',
    status: 'upcoming',
    tasks: [
      'Build 2 end-to-end projects and deploy them',
      'Write a LinkedIn post about your learning journey',
      'Apply for 1 open-source contribution',
    ],
  },
  {
    phase: 'Phase 3',
    title: 'Application Strategy',
    duration: '2–3 weeks',
    status: 'upcoming',
    tasks: [
      'Tailor resume for target roles',
      'Apply to 50+ relevant openings on LinkedIn & company sites',
      'Reach out to 10 people from target companies on LinkedIn',
    ],
  },
  {
    phase: 'Phase 4',
    title: 'Interview Prep',
    duration: 'Ongoing',
    status: 'locked',
    tasks: [
      'Practice DSA on LeetCode (easy → medium)',
      'Do 5 mock interviews with peers or mentors',
      'Review common domain-specific interview questions',
    ],
  },
];

// GET /api/roadmap/me — get current user's saved roadmap
router.get('/me', protect, async (req, res) => {
  try {
    const roadmap = await Roadmap.findOne({ userId: req.user.userId }).lean();
    res.json({ ok: true, roadmap: roadmap || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/roadmap/generate — generate a personalized roadmap (public, saves only if logged in)
router.post('/generate', optionalAuth, async (req, res) => {
  try {
    const { goal, college, branch, year, cgpa } = req.body;
    const userId = req.user?.userId || req.user?._id;

    if (!goal || !goal.trim()) {
      return res.status(400).json({ ok: false, error: 'goal is required' });
    }

    // Use fallback steps directly (Gemini disabled to save quota)
    const steps = FALLBACK_STEPS(goal);

    // Only save to DB if user is logged in
    let roadmap;
    if (userId) {
      roadmap = await Roadmap.findOneAndUpdate(
        { userId },
        { userId, goal: goal.trim(), college, branch, steps, generatedAt: new Date() },
        { upsert: true, new: true }
      );
    } else {
      roadmap = { goal: goal.trim(), college, branch, steps, generatedAt: new Date() };
    }

    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/roadmap/step/:index/status — update a phase's status
// Body: { status: "active" | "upcoming" | "locked" | "completed" }
router.patch('/step/:index/status', protect, async (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const { status } = req.body;
    const allowed = ['active', 'upcoming', 'locked', 'completed'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: `status must be one of: ${allowed.join(', ')}` });
    }

    const roadmap = await Roadmap.findOne({ userId: req.user.userId });
    if (!roadmap) return res.status(404).json({ ok: false, error: 'Roadmap not found' });
    if (!roadmap.steps[idx]) return res.status(400).json({ ok: false, error: 'Step index out of range' });

    roadmap.steps[idx].status = status;
    roadmap.markModified('steps');
    await roadmap.save();

    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
