import express from 'express';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/sessions/my — upcoming + past sessions for logged-in user
router.get('/my', protect, async (req, res) => {
  try {
    const now = new Date();
    const sessions = await Session.find({ userId: req.user.userId })
      .sort({ scheduledAt: -1 })
      .lean();

    const upcoming = sessions.filter(
      s => new Date(s.scheduledAt) > now && s.status !== 'cancelled'
    );
    const past = sessions.filter(
      s => new Date(s.scheduledAt) <= now || s.status === 'completed'
    );

    res.json({ ok: true, upcoming, past });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/sessions/book — book a new session
// Body: { mentorId?, date, time, topic? }
// date format: "May 26, 2026" or "2026-05-26"
// time format: "9:00 AM" or "09:00"
router.post('/book', protect, async (req, res) => {
  try {
    const { mentorId, date, time, topic } = req.body;

    if (!date || !time) {
      return res.status(400).json({ ok: false, error: 'date and time are required' });
    }

    const scheduledAt = new Date(`${date} ${time}`);
    if (isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid date/time — use format "May 26, 2026" and "9:00 AM"' });
    }

    if (scheduledAt < new Date()) {
      return res.status(400).json({ ok: false, error: 'Cannot book a session in the past' });
    }

    let mentorName = 'Your Mentor';
    let mentorInitials = 'YM';
    let resolvedMentorId = null;

    if (mentorId) {
      const mentor = await User.findById(mentorId).select('name username').lean();
      if (mentor) {
        resolvedMentorId = mentor._id;
        mentorName = mentor.name || mentor.username;
        mentorInitials = mentorName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);
      }
    }

    const session = await Session.create({
      userId:         req.user.userId,
      mentorId:       resolvedMentorId,
      mentorName,
      mentorInitials,
      topic:          topic || 'Career Guidance Session',
      scheduledAt,
      status:         'upcoming',
    });

    res.status(201).json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/sessions/:id/cancel — cancel a session
router.patch('/:id/cancel', protect, async (req, res) => {
  try {
    const session = await Session.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { status: 'cancelled' },
      { new: true }
    );
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/sessions/:id/complete — mark a session complete (mentor/admin)
router.patch('/:id/complete', protect, async (req, res) => {
  try {
    const session = await Session.findOneAndUpdate(
      { _id: req.params.id },
      { status: 'completed' },
      { new: true }
    );
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
