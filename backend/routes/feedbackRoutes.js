// routes/feedback.js
// POST /api/feedback/:questionId
// Body: { isHelpful: true/false }

import express from 'express';
import { protect } from '../middleware/authMiddleware.js'; // your existing auth middleware
import AtyantEngine from '../services/AtyantEngine.js';

const router = express.Router();

router.post('/:questionId', protect, async (req, res) => {
  try {
    const { questionId } = req.params;
    const { isHelpful } = req.body;
    const studentId = req.user._id;

    if (typeof isHelpful !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isHelpful must be true or false' });
    }

    const result = await AtyantEngine.recordFeedback(questionId, studentId, isHelpful);
    return res.status(result.success ? 200 : 404).json(result);

  } catch (err) {
    console.error('Feedback route error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;