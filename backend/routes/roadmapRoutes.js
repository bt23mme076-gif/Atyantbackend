import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

    const prompt = `You are a career advisor for Indian Tier-2/3 engineering students.

Student: ${college || 'NIT'}, ${branch || 'Engineering'}, Year ${year || '3'}, CGPA ${cgpa || '7.5'}
Goal: ${goal}

Generate a 4-phase personalized roadmap. Return ONLY valid JSON, no markdown:
{
  "steps": [
    {
      "phase": "Phase 1",
      "title": "Short title (3–5 words)",
      "duration": "X–Y weeks",
      "status": "active",
      "tasks": ["specific task 1", "specific task 2", "specific task 3"]
    }
  ]
}

Rules:
- Phase 1 status must be "active", Phase 2–3 "upcoming", Phase 4 "locked"
- Exactly 3 tasks per phase — specific, actionable, realistic for the goal
- Titles must be short (3–5 words)
- Phases must build logically toward the goal`;

    let steps = null;
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.steps) && parsed.steps.length === 4) {
          steps = parsed.steps;
        }
      }
    } catch (aiErr) {
      console.error('Roadmap AI error:', aiErr.message);
    }

    if (!steps) steps = FALLBACK_STEPS(goal);

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
