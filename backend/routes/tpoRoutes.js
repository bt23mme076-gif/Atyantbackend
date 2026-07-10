import express from 'express';
import User from '../models/User.js';
import Session from '../models/Session.js';
import SessionInsight from '../models/SessionInsight.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

const TPO_EMAIL = 'atyant.in@gmail.com';

// Middleware: verify caller is the TPO account
async function tpoOnly(req, res, next) {
  try {
    const caller = await User.findById(req.user.userId).select('email').lean();
    if (!caller || caller.email !== TPO_EMAIL) {
      return res.status(403).json({ ok: false, error: 'TPO access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Auth check failed' });
  }
}

// ─── GET /api/tpo/students ────────────────────────────────────────────────────
// Returns all non-mentor users with VNIT education (or all users as fallback).
router.get('/students', protect, tpoOnly, async (req, res) => {
  try {
    const VNIT_REGEX = /vnit/i;
    const users = await User.find({
      role: 'user',
      $or: [
        { email: { $regex: /@(students\.)?vnit\.ac\.in$/i } },
        { 'education.institutionName': VNIT_REGEX },
        { 'education.institution': VNIT_REGEX },
      ],
    })
      .select('name username email education skills interests')
      .lean();

    const students = users.map(u => {
      const edu = u.education?.[0] || {};
      return {
        _id: u._id,
        name: u.name || u.username || u.email?.split('@')[0] || 'Student',
        email: u.email,
        branch: edu.field || edu.degree || '',
        year: edu.year || '',
        cgpa: edu.cgpa || null,
        targetCompany: u.interests?.[0] || '',
      };
    });

    res.json({ ok: true, students });
  } catch (err) {
    console.error('TPO /students error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/tpo/mentors ─────────────────────────────────────────────────────
// Returns all active mentors.
router.get('/mentors', protect, tpoOnly, async (req, res) => {
  try {
    const users = await User.find({ role: 'mentor', mentorListed: { $ne: false } })
      .select('name username currentRole currentCompany topCompanies companyDomain education expertise')
      .lean();

    const mentors = users.map(m => {
      const edu = m.education?.[0] || {};
      return {
        _id: m._id,
        name: m.name || m.username,
        currentRole: m.currentRole || m.companyDomain || 'Mentor',
        currentCompany: m.currentCompany || m.topCompanies?.[0] || '',
        // Branch signal for TPO matching: education field/degree or expertise tags
        branch: edu.field || edu.degree || (m.expertise || []).join(' '),
      };
    });

    res.json({ ok: true, mentors });
  } catch (err) {
    console.error('TPO /mentors error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/tpo/sessions ────────────────────────────────────────────────────
// Upcoming sessions are limited to the recent window; completed sessions are
// always returned so the TPO's history never silently drops off.
router.get('/sessions', protect, tpoOnly, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sessions = await Session.find({
      $or: [
        { status: 'completed' },
        { status: { $in: ['upcoming', 'pending'] }, scheduledAt: { $gte: since } },
      ],
    })
      .sort({ scheduledAt: -1 })
      .populate('userId', 'name email')
      .populate('mentorId', 'name username currentCompany currentRole')
      .lean();

    // Which of these have an AI insight the TPO can open?
    const insightIds = await SessionInsight
      .find({ sessionId: { $in: sessions.map(s => s._id) } })
      .select('sessionId')
      .lean();
    const withInsight = new Set(insightIds.map(i => String(i.sessionId)));

    const enriched = sessions.map(s => ({
      ...s,
      mentorCompany: s.mentorId?.currentCompany || '',
      mentorRole:    s.mentorId?.currentRole || '',
      rating:        s.review?.rating || 0,
      hasInsight:    withInsight.has(String(s._id)),
    }));

    res.json({ ok: true, sessions: enriched });
  } catch (err) {
    console.error('TPO /sessions error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/tpo/sessions/:sessionId/insight ────────────────────────────────
// What actually happened in the interview: AI summary + the mentor's notes.
// Declared before '/sessions/book' so the literal path is never shadowed.
router.get('/sessions/:sessionId/insight', protect, tpoOnly, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const [session, insight] = await Promise.all([
      Session.findById(sessionId)
        .select('topic scheduledAt status notes review mentorName pipelineStatus')
        .populate('userId', 'name email')
        .populate('mentorId', 'name username currentCompany')
        .lean(),
      SessionInsight.findOne({ sessionId }).lean(),
    ]);

    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    res.json({ ok: true, session, insight: insight || null });
  } catch (err) {
    console.error('TPO /sessions/:id/insight error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/tpo/sessions/book ─────────────────────────────────────────────
// Book a session on behalf of a student (TPO-initiated).
// Body: { studentId, mentorId, scheduledAt, topic, serviceId, durationMin }
router.post('/sessions/book', protect, tpoOnly, async (req, res) => {
  try {
    const { studentId, mentorId, scheduledAt, topic, serviceId, durationMin } = req.body;

    if (!studentId || !mentorId || !scheduledAt) {
      return res.status(400).json({ ok: false, error: 'studentId, mentorId, and scheduledAt are required' });
    }

    const [student, mentor] = await Promise.all([
      User.findById(studentId).select('name').lean(),
      User.findById(mentorId).select('name username').lean(),
    ]);

    if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
    if (!mentor)  return res.status(404).json({ ok: false, error: 'Mentor not found' });

    const mentorName = mentor.name || mentor.username || 'Mentor';
    const mentorInitials = mentorName
      .split(' ')
      .map(w => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    const session = await Session.create({
      userId: studentId,
      mentorId,
      mentorName,
      mentorInitials,
      topic: topic || 'Mock Interview · TPO',
      serviceId: serviceId || 'video-call',
      scheduledAt: new Date(scheduledAt),
      durationMin: durationMin || 30,
      status: 'upcoming',
      paymentStatus: 'free',
    });

    res.status(201).json({ ok: true, session });
  } catch (err) {
    console.error('TPO /sessions/book error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
