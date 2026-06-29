import cron from 'node-cron';
import Session from '../models/Session.js';
import liveKitService from './LiveKitService.js';

// How long past a session's scheduled end we let a room keep running before we
// force-close it. Covers legitimate overruns while capping runaway recordings
// (e.g. a participant who left a tab open and never clicked Leave).
const OVERRUN_MIN = Math.max(0, Number(process.env.MEET_OVERRUN_MIN ?? 30));

class SessionAutoCloseCron {
  start() {
    // Every 5 minutes — sweep for sessions that are overdue to end.
    cron.schedule('*/5 * * * *', async () => {
      await this.closeOverdue();
    });
    console.log(`✅ Session auto-close cron started (overrun grace: ${OVERRUN_MIN} min)`);
  }

  async closeOverdue() {
    try {
      const now = new Date();

      // Still-active sessions that have a LiveKit room and whose
      // (scheduledAt + durationMin + OVERRUN_MIN) is already in the past.
      const overdue = await Session.find({
        status: 'upcoming',
        livekitRoomName: { $exists: true, $ne: null },
        $expr: {
          $lt: [
            {
              $add: [
                '$scheduledAt',
                { $multiply: [{ $add: ['$durationMin', OVERRUN_MIN] }, 60000] },
              ],
            },
            now,
          ],
        },
      }).lean();

      for (const s of overdue) await this.closeOne(s);

      if (overdue.length) {
        console.log(`⏹️ Auto-closed ${overdue.length} overdue session(s)`);
      }
    } catch (err) {
      console.error('Session auto-close cron error:', err.message);
    }
  }

  // Stop the recording first (finalizes the .ogg → egress_ended → pipeline),
  // then delete the room to disconnect anyone still connected. Both calls are
  // non-fatal and idempotent, so this is safe even if the room already closed
  // on its own via emptyTimeout.
  async closeOne(session) {
    try {
      if (liveKitService.isConfigured()) {
        if (session.egressId) await liveKitService.stopEgress(session.egressId);
        if (session.livekitRoomName) await liveKitService.deleteRoom(session.livekitRoomName);
      }
      // Mark completed now so the next sweep doesn't reprocess it (the
      // room_finished webhook also sets this — the update is idempotent).
      await Session.findByIdAndUpdate(session._id, { status: 'completed' });
      console.log(`⏹️ Auto-closed overdue session ${session._id} (room ${session.livekitRoomName})`);
    } catch (err) {
      console.error(`Auto-close error for session ${session?._id}:`, err.message);
    }
  }
}

export default new SessionAutoCloseCron();
