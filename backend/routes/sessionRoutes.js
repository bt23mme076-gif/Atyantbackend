import express from 'express';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import SessionInsight from '../models/SessionInsight.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';
import { localizeMeetLink } from '../utils/frontendUrl.js';
import sessionPipelineService from '../services/SessionPipelineService.js';

const router = express.Router();

// GET /api/sessions/user/:userId/diagnostic (admin only)
// Get diagnostic info for all sessions of a specific user
router.get('/user/:userId/diagnostic', protect, async (req, res) => {
  try {
    // Admin only
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const user = await User.findById(req.params.userId).select('name username email').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sessions = await Session.find({
      $or: [
        { userId: req.params.userId },
        { mentorId: req.params.userId }
      ]
    })
    .sort({ scheduledAt: -1 })
    .limit(10)
    .lean();

    const diagnostics = [];

    for (const session of sessions) {
      const transcript = await SessionTranscript.findOne({ sessionId: session._id }).lean();
      
      const diag = {
        sessionId: session._id,
        scheduledAt: session.scheduledAt,
        status: session.status,
        pipelineStatus: session.pipelineStatus,
        pipelineError: session.pipelineError,
        egressAttempts: session.egressAttempts,
        transcript: {
          exists: !!transcript,
          length: transcript?.rawText?.length || 0,
          preview: transcript?.rawText?.slice(0, 150) || null,
        },
      };

      // Calculate filler ratio
      if (transcript?.rawText) {
        const text = transcript.rawText.toLowerCase();
        const fillerWords = ['you', 'thank', 'thanks', 'hello', 'hi', 'yeah', 'um', 'hmm'];
        const totalWords = transcript.rawText.split(/\s+/).filter(Boolean).length;
        const fillerCount = fillerWords.reduce((count, word) => {
          const regex = new RegExp(`\\b${word}\\b`, 'g');
          return count + (text.match(regex) || []).length;
        }, 0);
        
        diag.transcript.fillerRatio = totalWords > 0 ? (fillerCount / totalWords * 100).toFixed(1) + '%' : '0%';
        diag.micIssue = (fillerCount / totalWords) > 0.3;
      }

      diagnostics.push(diag);
    }

    res.json({
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
      },
      totalSessions: sessions.length,
      sessions: diagnostics,
      summary: {
        noAudio: diagnostics.filter(d => d.pipelineStatus === 'no_audio').length,
        failed: diagnostics.filter(d => d.pipelineStatus === 'failed').length,
        completed: diagnostics.filter(d => d.pipelineStatus === 'completed').length,
        micIssues: diagnostics.filter(d => d.micIssue).length,
      }
    });
  } catch (err) {
    console.error('User diagnostic error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/mentor/:mentorId/stats — dashboard stats for the mentor overview page
router.get('/mentor/:mentorId/stats', protect, async (req, res) => {
  try {
    const { mentorId } = req.params;

    // Only the mentor themselves (or admin) can view their stats
    if (req.user.userId !== mentorId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const allSessions = await Session.find({ mentorId }).select('status serviceId scheduledAt amount paymentStatus userId').lean();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const completed  = allSessions.filter(s => s.status === 'completed');
    const pending    = allSessions.filter(s => s.status === 'upcoming' || s.status === 'pending');
    const bookedToday = allSessions.filter(s => {
      const d = new Date(s.scheduledAt);
      return d >= today && d < tomorrow;
    });

    const totalEarnings = completed
      .filter(s => s.paymentStatus === 'paid')
      .reduce((sum, s) => sum + (s.amount || 0), 0);

    const uniqueStudents = new Set(allSessions.map(s => s.userId?.toString())).size;

    res.json({
      totalEarnings,
      bookedToday: bookedToday.length,
      pending: pending.length,
      completed: completed.length,
      totalStudents: uniqueStudents,
      chatSessions:   allSessions.filter(s => s.serviceId === 'text-qa').length,
      audioSessions:  allSessions.filter(s => s.serviceId === 'audio-call').length,
      videoSessions:  allSessions.filter(s => s.serviceId === 'video-call').length,
      resumeReviews:  allSessions.filter(s => s.serviceId === 'resume-review').length,
    });
  } catch (err) {
    console.error('Mentor stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
        s.counterpartName    = student.name || student.username || 'Student';
        s.counterpartPicture = student.profilePicture || '';
      } else {
        s.counterpartName    = s.mentorName || 'Your Mentor';
        s.counterpartPicture = s.mentorProfilePicture || '';
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
      rating:      numRating,
      comment:     (req.body.comment || '').trim().slice(0, 300),
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

// POST /api/sessions/:id/reprocess — admin-only. Re-runs the transcription
// pipeline against the recording still on disk at RECORDINGS_PATH/<id>.ogg.
// Recovers a session whose egress completed but whose pipeline failed
// (transient transcription/insight error). Safe to call repeatedly — the
// pipeline no longer deletes the source file, so the recording survives retries.
router.post('/:id/reprocess', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }
    const session = await Session.findById(req.params.id).select('_id pipelineStatus').lean();
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    // Reset no_audio status so _isLowContent doesn't short-circuit on a second
    // attempt after the student re-records or admin wants to force insight re-gen
    // from the stored transcript.
    if (session.pipelineStatus === 'no_audio') {
      await Session.findByIdAndUpdate(session._id, { pipelineStatus: 'none', pipelineError: null });
    }

    const audioPath = `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${session._id}.ogg`;
    sessionPipelineService.processSession(session._id, audioPath).catch(err =>
      console.error('Manual reprocess error:', err.message)
    );
    res.json({ ok: true, message: 'Reprocessing started', audioPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sessions/:id/transcript — get transcript + insights for a session
// Only the student or mentor of that session can access it
router.get('/:id/transcript', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const session = await Session.findById(req.params.id)
      .populate('userId',   'name username profilePicture')
      .populate('mentorId', 'name username profilePicture')
      .lean();

    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    // Only participants can view transcript
    const isStudent = String(session.userId?._id || session.userId) === String(userId);
    const isMentor  = String(session.mentorId?._id || session.mentorId) === String(userId);
    const isAdmin   = req.user.role === 'admin';

    if (!isStudent && !isMentor && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const [transcript, insight] = await Promise.all([
      SessionTranscript.findOne({ sessionId: session._id }).lean(),
      SessionInsight.findOne({ sessionId: session._id }).lean()
    ]);

    if (!transcript) {
      return res.status(404).json({
        ok: false,
        error: session.pipelineStatus === 'processing'
          ? 'Transcript is still being processed. Check back in a minute.'
          : session.pipelineStatus === 'failed'
          ? 'Transcript generation failed for this session.'
          : 'No transcript available for this session.'
      });
    }

    res.json({
      ok: true,
      session: {
        id:          session._id,
        topic:       session.topic,
        scheduledAt: session.scheduledAt,
        duration:    transcript.duration,
        student: {
          id:             String(session.userId?._id || session.userId),
          name:           session.userId?.name || session.userId?.username || 'Student',
          profilePicture: session.userId?.profilePicture || null
        },
        mentor: {
          id:             String(session.mentorId?._id || session.mentorId),
          name:           session.mentorId?.name || session.mentorId?.username || session.mentorName || 'Mentor',
          profilePicture: session.mentorId?.profilePicture || null
        }
      },
      transcript: {
        rawText:  transcript.rawText,
        segments: transcript.segments || [],
        language: transcript.language
      },
      insight: insight ? {
        summary:              insight.summary,
        detailedSummary:      insight.detailedSummary,
        topics:               insight.topics,
        actionItems:          insight.actionItems,
        studentPainPoints:    insight.studentPainPoints,
        keyDiscussionPoints:  insight.keyDiscussionPoints,
        strengths:            insight.strengths,
        areasToImprove:       insight.areasToImprove,
        recommendedResources: insight.recommendedResources,
        nextSessionFocus:     insight.nextSessionFocus,
        mentorQualityScore:   insight.mentorQualityScore,
        studentSentiment:     insight.studentSentiment
      } : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/sessions/:id/manual-transcript — admin manually enters transcript when audio failed
// Body: { text: "full conversation text..." }
// Re-runs insight extraction from the provided text and marks session completed.
router.patch('/:id/manual-transcript', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }

    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return res.status(400).json({ ok: false, error: 'text is required (min 10 chars)' });
    }

    const session = await Session.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    // Save the manually entered transcript
    await SessionTranscript.findOneAndUpdate(
      { sessionId: session._id },
      {
        sessionId:  session._id,
        rawText:    text.trim(),
        segments:   [],
        language:   'en',
        duration:   null,
      },
      { upsert: true, new: true }
    );

    // Reset pipeline status so processSession runs insights extraction
    await Session.findByIdAndUpdate(session._id, {
      pipelineStatus: 'none',
      pipelineError:  null,
    });

    // Run pipeline with null audioPath — it will find the saved transcript and
    // generate insights from it (the "stored transcript fallback" path in _process)
    sessionPipelineService.processSession(session._id, null).catch(err =>
      console.error('Manual transcript pipeline error:', err.message)
    );

    res.json({ ok: true, message: 'Transcript saved and insight extraction started' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sessions/between/:userA/:userB — find last session between two users and return transcript
// Admin only (for support/review purposes)
router.get('/between/:userA/:userB', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }

    const { userA, userB } = req.params;

    const isObjectId = (s) => /^[a-f\d]{24}$/i.test(s);
    const [a, b] = await Promise.all([
      User.findOne(isObjectId(userA) ? { _id: userA } : { username: userA }).select('_id name username').lean(),
      User.findOne(isObjectId(userB) ? { _id: userB } : { username: userB }).select('_id name username').lean(),
    ]);

    if (!a) return res.status(404).json({ ok: false, error: `User "${userA}" not found` });
    if (!b) return res.status(404).json({ ok: false, error: `User "${userB}" not found` });

    // Find most recent session between them (either as student/mentor)
    const session = await Session.findOne({
      $or: [
        { userId: a._id, mentorId: b._id },
        { userId: b._id, mentorId: a._id }
      ],
      status: 'completed'
    }).sort({ scheduledAt: -1 }).lean();

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: `No completed session found between ${a.name || a.username} and ${b.name || b.username}`
      });
    }

    const [transcript, insight] = await Promise.all([
      SessionTranscript.findOne({ sessionId: session._id }).lean(),
      SessionInsight.findOne({ sessionId: session._id }).lean()
    ]);

    res.json({
      ok: true,
      session: {
        id:          session._id,
        topic:       session.topic,
        scheduledAt: session.scheduledAt,
        student:     { id: String(a._id), name: a.name || a.username },
        mentor:      { id: String(b._id), name: b.name || b.username }
      },
      transcript: transcript ? {
        rawText:  transcript.rawText,
        segments: transcript.segments || [],
        language: transcript.language,
        duration: transcript.duration
      } : null,
      insight: insight ? {
        summary:             insight.summary,
        detailedSummary:     insight.detailedSummary,
        topics:              insight.topics,
        actionItems:         insight.actionItems,
        studentPainPoints:   insight.studentPainPoints,
        keyDiscussionPoints: insight.keyDiscussionPoints,
        areasToImprove:      insight.areasToImprove,
        nextSessionFocus:    insight.nextSessionFocus
      } : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sessions/:id/diagnostic (admin only)
// Check if transcript and audio file exist for a session
router.get('/:id/diagnostic', protect, async (req, res) => {
  try {
    const session = await Session.findById(req.params.id).lean();
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only admin, student, or mentor can view
    const isAdmin = req.user.role === 'admin';
    const isStudent = session.userId?.toString() === req.user.userId;
    const isMentor = session.mentorId?.toString() === req.user.userId;

    if (!isAdmin && !isStudent && !isMentor) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const transcript = await SessionTranscript.findOne({ sessionId: req.params.id }).lean();
    
    const diagnostic = {
      sessionId: session._id,
      status: session.status,
      pipelineStatus: session.pipelineStatus,
      pipelineError: session.pipelineError,
      egressId: session.egressId,
      egressAttempts: session.egressAttempts,
      livekitRoomName: session.livekitRoomName,
      scheduledAt: session.scheduledAt,
      transcript: {
        exists: !!transcript,
        length: transcript?.rawText?.length || 0,
        preview: transcript?.rawText?.slice(0, 200) || null,
        segments: transcript?.segments?.length || 0,
        language: transcript?.language || null,
        duration: transcript?.duration || null,
      },
      audio: {
        expectedPath: `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${req.params.id}.ogg`,
        note: 'Audio files are stored on VPS and auto-deleted after 48h. Check VPS directly.',
      },
      diagnosis: null,
    };

    // Auto-diagnose common issues
    if (session.pipelineStatus === 'no_audio') {
      diagnostic.diagnosis = 'Microphone was muted or not capturing audio during the call. Transcript contains only silence-filler words from Whisper hallucination.';
    } else if (session.pipelineStatus === 'failed') {
      diagnostic.diagnosis = session.pipelineError || 'Pipeline failed - check error message';
    } else if (!transcript) {
      diagnostic.diagnosis = 'No transcript found - session may not have completed or pipeline pending';
    } else if (transcript.rawText?.length < 500) {
      diagnostic.diagnosis = 'Very short transcript - possible connection issue or brief call';
    } else {
      diagnostic.diagnosis = 'Session processed successfully';
    }

    // Calculate filler word ratio for audio quality assessment
    if (transcript?.rawText) {
      const text = transcript.rawText.toLowerCase();
      const fillerWords = ['you', 'thank', 'thanks', 'hello', 'hi', 'yeah', 'um', 'hmm'];
      const totalWords = transcript.rawText.split(/\s+/).filter(Boolean).length;
      const fillerCount = fillerWords.reduce((count, word) => {
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        return count + (text.match(regex) || []).length;
      }, 0);
      
      diagnostic.transcript.totalWords = totalWords;
      diagnostic.transcript.fillerWords = fillerCount;
      diagnostic.transcript.fillerRatio = totalWords > 0 ? (fillerCount / totalWords * 100).toFixed(1) + '%' : '0%';
      
      if (fillerCount / totalWords > 0.3) {
        diagnostic.diagnosis += ' [HIGH FILLER RATIO - likely mic was not capturing real speech]';
      }
    }

    res.json(diagnostic);
  } catch (err) {
    console.error('Session diagnostic error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
