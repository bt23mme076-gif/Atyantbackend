import express from 'express';
import SavedAnswer from '../models/SavedAnswer.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/saved-answers — all saved answers for logged-in user
router.get('/', protect, async (req, res) => {
  try {
    const { search } = req.query;
    const filter = { userId: req.user.userId };

    if (search) {
      filter.$or = [
        { question: { $regex: search, $options: 'i' } },
        { tags:     { $elemMatch: { $regex: search, $options: 'i' } } },
      ];
    }

    const answers = await SavedAnswer.find(filter)
      .sort({ savedAt: -1 })
      .lean();

    res.json({ ok: true, answers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/saved-answers — save a Q&A entry
// Body: { question, tags?, sourceType?, answerCardId?, mentorId? }
router.post('/', protect, async (req, res) => {
  try {
    const { question, tags, sourceType, answerCardId, mentorId } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ ok: false, error: 'question is required' });
    }

    const existing = await SavedAnswer.findOne({
      userId:   req.user.userId,
      question: question.trim(),
    });
    if (existing) {
      return res.json({ ok: true, answer: existing, alreadySaved: true });
    }

    const answer = await SavedAnswer.create({
      userId:      req.user.userId,
      question:    question.trim(),
      tags:        Array.isArray(tags) ? tags : [],
      sourceType:  sourceType || 'mentor',
      answerCardId: answerCardId || undefined,
      mentorId:    mentorId || undefined,
    });

    res.status(201).json({ ok: true, answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/saved-answers/:id — remove a saved answer
router.delete('/:id', protect, async (req, res) => {
  try {
    const deleted = await SavedAnswer.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user.userId,
    });
    if (!deleted) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
