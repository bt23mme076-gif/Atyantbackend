import express from 'express';
import Roadmap from '../models/Roadmap.js';
import SessionRoadmap from '../models/SessionRoadmap.js';
import Session from '../models/Session.js';
import SessionInsight from '../models/SessionInsight.js';
import roadmapGenerator from '../services/RoadmapGenerator.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/roadmap/me — get current user's saved goal-based roadmap
router.get('/me', protect, async (req, res) => {
  try {
    const roadmap = await Roadmap.findOne({ userId: req.user.userId }).lean();
    res.json({ ok: true, roadmap: roadmap || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/roadmap/generate — AI-generate a personalized goal-based roadmap
// (public; saves only if logged in).
router.post('/generate', optionalAuth, async (req, res) => {
  try {
    const { goal, college, branch, year, cgpa } = req.body;
    const userId = req.user?.userId || req.user?._id;

    if (!goal || !goal.trim()) {
      return res.status(400).json({ ok: false, error: 'goal is required' });
    }

    const steps = await roadmapGenerator.fromGoal({ goal: goal.trim(), college, branch, year, cgpa });

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

// ─────────────────────────────────────────────────────────────────────────────
//  Per-session roadmaps (built from each session's summary/analysis)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/roadmap/sessions — list the logged-in student's session roadmaps.
// This is what the frontend uses to "ask which one" when there are 2+ sessions.
router.get('/sessions', protect, async (req, res) => {
  try {
    const list = await SessionRoadmap.find({ userId: req.user.userId })
      .sort({ generatedAt: -1 })
      .select('sessionId topic mentorName summary generatedAt steps')
      .lean();

    res.json({
      ok: true,
      count: list.length,
      sessions: list.map(r => ({
        sessionId:   r.sessionId,
        topic:       r.topic,
        mentorName:  r.mentorName,
        summary:     r.summary,
        generatedAt: r.generatedAt,
        stepCount:   (r.steps || []).length,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/roadmap/session/:sessionId — the roadmap built from one session.
router.get('/session/:sessionId', protect, async (req, res) => {
  try {
    const roadmap = await SessionRoadmap.findOne({
      sessionId: req.params.sessionId,
      userId:    req.user.userId,   // scope to owner
    }).lean();

    if (!roadmap) return res.status(404).json({ ok: false, error: 'No roadmap for this session yet' });
    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/roadmap/session/:sessionId/generate — (re)generate a session's
// roadmap on demand from its stored insights. Useful if it wasn't created at
// pipeline time, or the student wants a fresh take.
router.post('/session/:sessionId/generate', protect, async (req, res) => {
  try {
    const session = await Session.findOne({
      _id:    req.params.sessionId,
      userId: req.user.userId,        // only the session's own student
    }).lean();
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const insight = await SessionInsight.findOne({ sessionId: session._id }).lean();
    if (!insight) {
      return res.status(409).json({ ok: false, error: 'This session has no analysis yet — its recording may still be processing.' });
    }

    const topic = session.topic || 'Career Guidance';
    const steps = await roadmapGenerator.fromSession({ topic, insights: insight });
    if (!steps.length) {
      return res.status(422).json({ ok: false, error: 'Could not build a roadmap from this session.' });
    }

    const roadmap = await SessionRoadmap.findOneAndUpdate(
      { sessionId: session._id },
      {
        sessionId:  session._id,
        userId:     session.userId,
        mentorId:   session.mentorId,
        topic,
        mentorName: session.mentorName || 'Your Mentor',
        summary:    insight.detailedSummary || insight.summary || '',
        steps,
        generatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/roadmap/step/:index/status — update a phase's status (goal roadmap)
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
