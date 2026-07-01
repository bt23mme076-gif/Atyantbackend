import express from 'express';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import liveKitService from '../services/LiveKitService.js';
import sessionPipelineService from '../services/SessionPipelineService.js';

const router = express.Router();

// POST /api/livekit/join/:sessionId
// Authenticated — returns a LiveKit token for student or mentor to join
router.post('/join/:sessionId', protect, async (req, res) => {
  try {
    if (!liveKitService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'LiveKit not configured on this server' });
    }

    const session = await Session.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const userId = req.user.userId;
    const isStudent = session.userId.toString() === userId;
    const isMentor  = session.mentorId?.toString() === userId;

    if (!isStudent && !isMentor) {
      return res.status(403).json({ ok: false, error: 'Not a participant of this session' });
    }

    // Re-ensure the room exists on the LiveKit server. Rooms are reclaimed after
    // emptyTimeout, so a session booked earlier may no longer have a live room —
    // that's why egress was failing with "requested room does not exist".
    // createRoom is idempotent, so this is safe whether or not the room survives.
    const roomName = await liveKitService.createRoom(session._id);
    if (session.livekitRoomName !== roomName) {
      session.livekitRoomName = roomName;
      await session.save();
    }

    const user = await User.findById(userId).select('name username').lean();
    const participantName = user?.name || user?.username || userId;
    const role = isMentor ? 'admin' : 'participant';

    const token = await liveKitService.generateToken(
      session.livekitRoomName,
      userId,
      participantName,
      role
    );

    // Start egress on first join (only once per session)
    if (!session.egressId) {
      try {
        const { egressId } = await liveKitService.startAudioEgress(
          session.livekitRoomName,
          session._id
        );
        session.egressId = egressId;
        await session.save();
      } catch (err) {
        // Non-fatal — session still works, just won't be recorded
        console.error('Egress start failed (non-fatal):', err.message);
      }
    }

    res.json({
      ok: true,
      token,
      roomName: session.livekitRoomName,
      livekitUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_HOST?.replace('http', 'ws'),
    });
  } catch (err) {
    console.error('LiveKit join error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/livekit/webhook
// LiveKit server → this endpoint on room_finished / egress_ended events
// Raw body required for signature verification. LiveKit sends these with
// Content-Type `application/webhook+json`, so we must accept ANY type here —
// `type: 'application/json'` would skip the body and break the sha256 check.
router.post('/webhook', express.raw({ type: () => true }), async (req, res) => {
  try {
    if (!liveKitService.isConfigured()) return res.sendStatus(200);

    let event;
    try {
      // receive() is async — it MUST be awaited. Without await the rejection
      // escapes this try/catch and crashes the process as an unhandled rejection
      // ("sha256 checksum of body does not match"), and `event` would be a Promise.
      event = await liveKitService.receiveWebhook(
        req.body.toString(),
        req.headers.authorization
      );
    } catch (err) {
      console.error('LiveKit webhook signature invalid:', err.message);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const eventName = event.event;

    if (eventName === 'room_finished') {
      const roomName = event.room?.name;
      if (roomName?.startsWith('session_')) {
        const sessionId = roomName.replace('session_', '');
        await Session.findByIdAndUpdate(sessionId, { status: 'completed' });
        console.log(`Room finished → session ${sessionId} marked completed`);
      }
    }

    if (eventName === 'egress_ended') {
      const info = event.egressInfo;
      const roomName = info?.roomName;
      if (roomName?.startsWith('session_')) {
        const sessionId = roomName.replace('session_', '');
        // Prefer the actual filename egress reported; fall back to the path we
        // asked for. Must match LiveKitService (RECORDINGS_PATH) so the file is
        // found — egress and backend share this directory via a Docker volume.
        const reported = info?.fileResults?.[0]?.filename || info?.file?.filename;
        const audioPath = reported
          || `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${sessionId}.ogg`;
        // Run pipeline async — do not block webhook response
        sessionPipelineService.processSession(sessionId, audioPath).catch(err =>
          console.error('Pipeline async error:', err.message)
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('LiveKit webhook error:', err);
    res.sendStatus(500);
  }
});

export default router;
