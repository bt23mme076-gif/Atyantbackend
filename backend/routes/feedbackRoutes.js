import express from 'express';
import auth from '../middleware/auth.js';
import atyantEngine from '../services/AtyantEngine.js';

const router = express.Router();

// POST /api/feedback/questions/:id/feedback  { helpful: true|false }
// Was this answer helpful? Feeds mentor feedbackScore + labels the MatchLog.
router.post('/questions/:id/feedback', auth, async (req, res) => {
  try {
    const { helpful } = req.body;
    if (typeof helpful !== 'boolean') {
      return res.status(400).json({ success: false, message: '`helpful` must be true or false' });
    }
    const studentId = req.user?.userId || req.user?._id || null;
    const result = await atyantEngine.recordFeedback(req.params.id, studentId, helpful);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('feedback route error:', err);
    res.status(500).json({ success: false, message: 'Failed to record feedback' });
  }
});

// POST /api/feedback/questions/:id/outcome  { achieved: true|false, note?: string }
// 30/60/90-day follow-up: did the student actually get the internship/placement?
// This is the outcome graph — Atyant's defensible dataset.
router.post('/questions/:id/outcome', auth, async (req, res) => {
  try {
    const { achieved, note } = req.body;
    if (typeof achieved !== 'boolean') {
      return res.status(400).json({ success: false, message: '`achieved` must be true or false' });
    }
    const studentId = req.user?.userId || req.user?._id || null;
    const result = await atyantEngine.recordOutcome(req.params.id, studentId, achieved, note);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('outcome route error:', err);
    res.status(500).json({ success: false, message: 'Failed to record outcome' });
  }
});

export default router;
