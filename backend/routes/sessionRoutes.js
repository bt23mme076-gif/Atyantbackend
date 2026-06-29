import express from 'express';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import SessionInsight from '../models/SessionInsight.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';
import { localizeMeetLink } from '../utils/frontendUrl.js';

const router = express.Router();

// GET /api/sessions/my — returns empty list for guests, real data for logged-in users
router.get('/my', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    if (!userId) {
      return res.json({ ok: true, upcoming: [], past: [] });
    }
    const uidStr = String(userId);
    const now = new Date();
    // Return sessions where the viewer is EITHER the student (userId) or the
    // mentor (mentorId) — so mentors see their booked sessions + meet links too.
    const sessions = await Session.find({ $or: [{ userId }, { mentorId: userId }] })
      .sort({ scheduledAt: -1 })
      .populate('userId', 'name username profilePicture')
      .lean();

    for (const s of sessions) {
      // Who is the OTHER party from the viewer's perspective?
      const isMentorView = s.mentorId && String(s.mentorId) === uidStr;
      s.viewerRole = isMentorView ? 'mentor' : 'student';
      if (isMentorView) {
        const student = s.userId || {};
        s.counterpartName = student.name || student.username || 'Student';
        s.counterpartPicture = student.profilePicture || '';
        s.counterpartId = student._id ? String(student._id) : (s.userId ? String(s.userId) : null);
      } else {
        s.counterpartName = s.mentorName || 'Your Mentor';
        s.counterpartPicture = s.mentorProfilePicture || '';
        s.counterpartId = s.mentorId ? String(s.mentorId) : null;
      }
      // userId was populated to an object for the lookup above; collapse it back
      // to a plain id so existing consumers that expect a string keep working.
      s.userId = s.userId?._id ? String(s.userId._id) : s.userId;

      // The DB is shared across environments, so a session created on production
      // stores an atyant.in meet link. In dev, re-point it at the local frontend
      // so "Join Session" opens on localhost. (No-op in production.)
      if (process.env.NODE_ENV !== 'production' && s.meetingLink) {
        s.meetingLink = localizeMeetLink(s.meetingLink);
      }
    }

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
      userId: req.user.userId,
      mentorId: resolvedMentorId,
      mentorName,
      mentorInitials,
      topic: topic || 'Career Guidance Session',
      scheduledAt,
      status: 'upcoming',
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

// POST /api/sessions/:id/review — student submits star rating + comment.
// Updates mentor's rolling average rating and successfulMatches count.
router.post('/:id/review', protect, async (req, res) => {
  try {
    const numRating = Number(req.body.rating);
    if (!numRating || numRating < 1 || numRating > 5) {
      return res.status(400).json({ ok: false, error: 'Rating must be 1–5' });
    }
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (session.review?.submittedAt) return res.status(409).json({ ok: false, error: 'Already reviewed' });

    session.review = {
      rating: numRating,
      comment: (req.body.comment || '').trim().slice(0, 300),
      submittedAt: new Date(),
    };
    await session.save();

    if (session.mentorId) {
      const mentor = await User.findById(session.mentorId);
      if (mentor) {
        const prev = mentor.feedbackCount || 0;
        mentor.rating = ((mentor.rating || 0) * prev + numRating) / (prev + 1);
        mentor.feedbackCount = prev + 1;
        mentor.successfulMatches = (mentor.successfulMatches || 0) + 1;
        await mentor.save();
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Shared guard — only the session's two participants (student or mentor) may
// read its post-session artifacts. Returns the session (id-only) or null after
// already sending the error response.
async function loadParticipantSession(req, res) {
  const session = await Session.findById(req.params.id)
    .select('userId mentorId pipelineStatus')
    .lean();
  if (!session) {
    res.status(404).json({ ok: false, error: 'Session not found' });
    return null;
  }
  const uid = String(req.user.userId);
  const isParticipant =
    String(session.userId) === uid || String(session.mentorId || '') === uid;
  if (!isParticipant) {
    res.status(403).json({ ok: false, error: 'Not a participant of this session' });
    return null;
  }
  return session;
}

// GET /api/sessions/:id/transcript — full discussion (text + timestamped
// segments) from the recording pipeline. Participants only.
router.get('/:id/transcript', protect, async (req, res) => {
  try {
    const session = await loadParticipantSession(req, res);
    if (!session) return;

    const transcript = await SessionTranscript.findOne({ sessionId: req.params.id }).lean();
    if (!transcript) {
      return res.status(404).json({
        ok: false,
        error: 'Transcript not ready',
        pipelineStatus: session.pipelineStatus || 'none',
      });
    }
    res.json({ ok: true, transcript });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sessions/:id/insight — AI summary, action items and scores from the
// recording pipeline. Participants only.
router.get('/:id/insight', protect, async (req, res) => {
  try {
    const session = await loadParticipantSession(req, res);
    if (!session) return;

    const insight = await SessionInsight.findOne({ sessionId: req.params.id }).lean();
    if (!insight) {
      return res.status(404).json({
        ok: false,
        error: 'Insight not ready',
        pipelineStatus: session.pipelineStatus || 'none',
      });
    }
    res.json({ ok: true, insight });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
