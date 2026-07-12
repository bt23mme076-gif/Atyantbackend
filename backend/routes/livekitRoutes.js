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

// After the LiveKit server ACCEPTS an egress (returns an egressId), the egress
// WORKER still has to boot its pipeline and report "started". Under CPU pressure
// that signal never arrives ("Start signal not received") and the job dies
// ABORTED — the single biggest cause of real sessions ending with no recording
// (23% of sessions in the July pilot). Waiting for the egress_ended webhook to
// tell us is too slow and unreliable (a dead worker may never send it), so we
// proactively confirm the egress reaches ACTIVE within this window. If it
// doesn't, we kill the dead job and free the slot so a fresh recording starts
// while the call is still live — partial audio beats losing the whole session.
const EGRESS_VERIFY_DELAY_MS = 20000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Grace period after the LAST real participant leaves before we force-close the
// room. A weak-network drop fires participant_left even though the student is
// about to reconnect; closing instantly destroyed the room and orphaned the
// egress, which fragmented recordings (only the first ~30 s survived). We now
// wait this out and re-check — a reconnecting user rejoins the SAME room instance
// so egress keeps recording. Matches the room's departureTimeout (LiveKitService)
// so both agree on 5 min. roomHasParticipants excludes the hidden egress, so this
// is still the reliable closer for a genuinely-abandoned room (no stuck egress).
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;

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
    // Detached — never blocks the join response. Confirms the worker actually
    // starts recording and self-heals (fresh attempt) if it died on start.
    const roomName = session.livekitRoomName || `session_${session._id}`;
    verifyEgressStarted(session._id, roomName, egressId).catch(err =>
      console.error(`Egress verification error for session ${session._id}:`, err.message)
    );
    return egressId;
  } catch (err) {
    // Non-fatal — the session still works; the next join/publish event retries.
    console.error(`Egress start failed for session ${session._id} (attempt ${session.egressAttempts}):`, err.message);
    return null;
  }
}

// Confirm a freshly-started egress actually reaches ACTIVE; if it silently died
// on start (the "Start signal not received" failure), kill the dead job and let
// the capped attempt budget start a fresh recording while the call is still
// live. Detached and bounded: each restart re-enters ensureEgress, which stops
// claiming once egressAttempts hits MAX_EGRESS_ATTEMPTS — so this can retry at
// most a few times per session, never in an unbounded loop.
async function verifyEgressStarted(sessionId, roomName, egressId) {
  await sleep(EGRESS_VERIFY_DELAY_MS);
  let status = await liveKitService.getEgressStatus(egressId);

  // Still STARTING (0) → a slow, not necessarily dead, worker. Give it one more
  // window before giving up so we don't kill a recording that's about to run.
  if (status === 0) {
    await sleep(EGRESS_VERIFY_DELAY_MS);
    status = await liveKitService.getEgressStatus(egressId);
  }

  // ACTIVE (1) / ENDING (2) / COMPLETE (3) → the recording ran. Nothing to do.
  if (status === 1 || status === 2 || status === 3) return;

  // FAILED (4) / ABORTED (5) / LIMIT_REACHED (6) / stuck-STARTING / gone (null):
  // this egress will never produce audio. Kill it, free the slot, and — only if
  // someone is still on the call — start a fresh one (bounded by the cap).
  console.error(`⚠️ Egress ${egressId} for session ${sessionId} never went ACTIVE (status=${status}) — restarting recording`);
  await liveKitService.stopEgress(egressId).catch(() => {});
  await Session.findByIdAndUpdate(sessionId, { egressId: null });
  if (await liveKitService.roomHasParticipants(roomName)) {
    await ensureEgress(sessionId);
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

// GET /api/livekit/session/:sessionId/resume
// Returns the STUDENT's resume for a session — visible to both the student
// and the mentor of that session (not "my own resume", which only ever
// showed the viewer's own upload and left the mentor with nothing to see).
router.get('/session/:sessionId/resume', protect, async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const userId = req.user.userId;
    const isStudent = session.userId.toString() === userId;
    const isMentor  = session.mentorId?.toString() === userId;
    if (!isStudent && !isMentor) {
      return res.status(403).json({ ok: false, error: 'Not a participant of this session' });
    }

    const student = await User.findById(session.userId).select('resumeUrl').lean();
    res.json({ ok: true, resumeUrl: student?.resumeUrl || null });
  } catch (err) {
    console.error('GET /livekit/session/:sessionId/resume error:', err);
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
        // this fires, so a false result means the room is empty of humans RIGHT
        // NOW — but on a weak network that's usually a drop, not a real leave, and
        // the user is about to reconnect. Don't kill the room instantly (that
        // orphaned the egress and fragmented the recording). Wait out the grace
        // period, then force-close only if the room is STILL empty of real
        // participants. Detached so it never blocks the webhook response.
        if (!(await liveKitService.roomHasParticipants(roomName))) {
          setTimeout(async () => {
            try {
              if (!(await liveKitService.roomHasParticipants(roomName))) {
                console.log(`👋 ${roomName} still empty after grace → ending call`);
                await liveKitService.deleteRoom(roomName);
              } else {
                console.log(`↩️ ${roomName} re-occupied within grace → keeping call alive`);
              }
            } catch (err) {
              console.error('Delayed room-close error:', err.message);
            }
          }, EMPTY_ROOM_GRACE_MS);
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
