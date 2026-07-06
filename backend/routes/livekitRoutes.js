import express from 'express';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import liveKitService from '../services/LiveKitService.js';
import sessionPipelineService from '../services/SessionPipelineService.js';

const router = express.Router();

// Egress start attempts are capped so a persistent LiveKit-side failure can't
// loop forever. 3 covers the real triggers: page join, mic publish, one
// mid-call restart after an abort.
const MAX_EGRESS_ATTEMPTS = 3;

// Start (or retry) the audio recording for a session — safe to call from every
// join/webhook event. The findOneAndUpdate filter makes the claim atomic: when
// join + track_published race, exactly one caller wins; the rest no-op because
// egressId is already set or the attempt budget is spent.
// The July-6 pilot lost 2 sessions because egress start failed once at join
// time and was never retried — mic-publish/participant webhooks now re-trigger it.
async function ensureEgress(sessionId) {
  const session = await Session.findOneAndUpdate(
    {
      _id: sessionId,
      egressId: null, // matches null AND missing
      $or: [{ egressAttempts: { $lt: MAX_EGRESS_ATTEMPTS } }, { egressAttempts: { $exists: false } }],
    },
    { $inc: { egressAttempts: 1 } },
    { new: true }
  );
  if (!session) return null; // already recording, attempts exhausted, or bad id

  try {
    const { egressId } = await liveKitService.startAudioEgress(
      session.livekitRoomName || `session_${session._id}`,
      session._id
    );
    session.egressId = egressId;
    await session.save();
    console.log(`🎙️ Egress started for session ${session._id} (attempt ${session.egressAttempts}): ${egressId}`);
    return egressId;
  } catch (err) {
    // Non-fatal — the session still works; the next join/publish event retries.
    console.error(`Egress start failed for session ${session._id} (attempt ${session.egressAttempts}):`, err.message);
    return null;
  }
}

// LiveKit EgressInfo.status arrives as an enum number (or string, depending on
// serialization path). 3 = EGRESS_COMPLETE.
function egressCompleted(status) {
  return status === 3 || String(status) === '3' || String(status) === 'EGRESS_COMPLETE';
}

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

    // Start egress on first join (atomic + capped; retried again from the
    // participant/track webhooks if this attempt fails)
    await ensureEgress(session._id);

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

    // Someone joined / published their mic → make sure a recording is running.
    // This is the retry path for sessions whose egress failed to start at join
    // time (July-6 pilot: 2 of 5 sessions were never recorded because of this).
    if (eventName === 'participant_joined' || eventName === 'track_published') {
      const roomName = event.room?.name;
      if (roomName?.startsWith('session_')) {
        const sessionId = roomName.replace('session_', '');
        ensureEgress(sessionId).catch(err =>
          console.error('ensureEgress webhook error:', err.message)
        );
      }
    }

    // Someone left → if NO real (non-hidden) participant remains, end the call
    // now instead of letting an empty room (kept alive by the hidden egress
    // participant) linger and record silence. deleteRoom disconnects everyone,
    // stops egress, and fires room_finished + egress_ended, which run the
    // pipeline on whatever was captured.
    if (eventName === 'participant_left') {
      const roomName = event.room?.name;
      if (roomName?.startsWith('session_')) {
        // The departing participant is already gone from the roster by the time
        // this fires, so a false result means the room is truly empty of humans.
        const stillActive = await liveKitService.roomHasParticipants(roomName);
        if (!stillActive) {
          console.log(`👋 Last participant left ${roomName} → ending call`);
          await liveKitService.deleteRoom(roomName);
        }
      }
    }

    if (eventName === 'room_finished') {
      const roomName = event.room?.name;
      if (roomName?.startsWith('session_')) {
        const sessionId = roomName.replace('session_', '');
        const session = await Session.findByIdAndUpdate(sessionId, { status: 'completed' });
        // Belt & suspenders: room-composite egress normally auto-stops when the
        // room closes, but a stuck job would otherwise record silence for hours
        // and hog the egress worker's CPU budget (blocking overlapping sessions).
        if (session?.egressId) await liveKitService.stopEgress(session.egressId);
        console.log(`Room finished → session ${sessionId} marked completed`);
      }
    }

    if (eventName === 'egress_ended') {
      const info = event.egressInfo;
      const roomName = info?.roomName;
      if (roomName?.startsWith('session_')) {
        const sessionId = roomName.replace('session_', '');
        const fileRes  = info?.fileResults?.[0] || info?.file;
        const fileSize = Number(fileRes?.size ?? 0);

        if (egressCompleted(info?.status) && fileSize > 0) {
          // Prefer the actual filename egress reported; fall back to the path we
          // asked for. Must match LiveKitService (RECORDINGS_PATH) so the file is
          // found — egress and backend share this directory via a Docker volume.
          const audioPath = fileRes?.filename
            || `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${sessionId}.ogg`;
          // Run pipeline async — do not block webhook response
          sessionPipelineService.processSession(sessionId, audioPath).catch(err =>
            console.error('Pipeline async error:', err.message)
          );
        } else {
          // Aborted/failed egress (e.g. "Start signal not received" when the
          // egress worker had no CPU budget) or a 0-byte file — nothing to
          // transcribe. Record WHY on the session so failures are debuggable
          // from the DB, then, if the call is still live, start a fresh
          // recording: partial audio of the remainder beats losing the session.
          const reason = info?.error || `egress ended without a usable file (status=${info?.status}, size=${fileSize} bytes)`;
          console.error(`❌ Egress ${info?.egressId} for session ${sessionId}: ${reason}`);
          await Session.findByIdAndUpdate(sessionId, {
            pipelineStatus: 'failed',
            pipelineError: `Recording failed: ${reason}`.slice(0, 500),
          });
          if (await liveKitService.roomHasParticipants(roomName)) {
            await Session.findByIdAndUpdate(sessionId, { egressId: null });
            ensureEgress(sessionId).catch(err =>
              console.error('Egress restart error:', err.message)
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('LiveKit webhook error:', err);
    res.sendStatus(500);
  }
});

export default router;
