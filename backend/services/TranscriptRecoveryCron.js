import fs from 'fs';
import cron from 'node-cron';
import Session from '../models/Session.js';
import SessionTranscript from '../models/SessionTranscript.js';
import sessionPipelineService from './SessionPipelineService.js';

const RECORDINGS_PATH = process.env.RECORDINGS_PATH || '/tmp/recordings';

// Sessions stuck in 'processing' for longer than this are assumed crashed.
// A 30-min session takes ~5-10 min through the pipeline — 45 min gives enough
// headroom for Groq retries without waiting ages to recover a crashed run.
const STUCK_PROCESSING_MS = 45 * 60 * 1000; // 45 min

// Sessions completed but never entered the pipeline (egress_ended webhook missed).
// We wait 10 min after completion before attempting recovery so a slow-but-running
// pipeline isn't double-fired.
const WEBHOOK_GRACE_MS = 10 * 60 * 1000; // 10 min

class TranscriptRecoveryCron {
  start() {
    // Run once at startup to catch sessions missed while the backend was down.
    this._recover().catch(err => console.error('Startup transcript recovery error:', err.message));

    // Then every 30 minutes.
    cron.schedule('*/30 * * * *', () => {
      this._recover().catch(err => console.error('Transcript recovery cron error:', err.message));
    });

    console.log('✅ Transcript recovery cron started');
  }

  async _recover() {
    const now = Date.now();

    // Case 1: completed sessions that never entered the pipeline —
    // egress_ended webhook was missed (backend was restarting / network blip).
    // NOTE: the Session schema defaults pipelineStatus to the STRING 'none', so a
    // never-processed session sits at 'none', NOT null/undefined. Matching only
    // null/undefined here silently skipped every missed-webhook session (they
    // stayed 'none' forever and their transcript was never recovered). 'none'
    // MUST be in this list for the safety net to work.
    const neverProcessed = await Session.find({
      status: 'completed',
      pipelineStatus: { $in: [null, undefined, 'none'] },
      updatedAt: { $lt: new Date(now - WEBHOOK_GRACE_MS) },
    }).lean();

    // Case 2: sessions stuck in 'processing' — pipeline process crashed mid-run.
    const stuckProcessing = await Session.find({
      status: 'completed',
      pipelineStatus: 'processing',
      updatedAt: { $lt: new Date(now - STUCK_PROCESSING_MS) },
    }).lean();

    const targets = [...neverProcessed, ...stuckProcessing];
    if (!targets.length) return;

    console.log(`🔄 Transcript recovery: ${targets.length} session(s) to recover (${neverProcessed.length} missed, ${stuckProcessing.length} stuck)`);

    for (const session of targets) {
      await this._recoverOne(session).catch(err =>
        console.error(`Recovery failed for session ${session._id}:`, err.message)
      );
    }
  }

  async _recoverOne(session) {
    const sessionId = String(session._id);

    // Check if a transcript already exists (a previous partial run may have saved it).
    const existingTranscript = await SessionTranscript.findOne({ sessionId }).lean();
    if (existingTranscript?.rawText?.length > 100) {
      // Transcript is there but insights/dashboard may be missing — reprocess from it.
      console.log(`🔄 Session ${sessionId}: transcript exists (${existingTranscript.rawText.length} chars) — re-running insights`);
      sessionPipelineService.processSession(sessionId, null).catch(err =>
        console.error(`Recovery reprocess error for ${sessionId}:`, err.message)
      );
      return;
    }

    // Look for the audio file on disk.
    const audioPath = `${RECORDINGS_PATH}/${sessionId}.ogg`;
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
      console.log(`🔄 Session ${sessionId}: audio file found (${(fs.statSync(audioPath).size / 1024).toFixed(0)} KB) — re-running full pipeline`);
      sessionPipelineService.processSession(sessionId, audioPath).catch(err =>
        console.error(`Recovery pipeline error for ${sessionId}:`, err.message)
      );
      return;
    }

    // Neither audio nor transcript — mark permanently failed with a clear reason.
    const reason = `Transcript recovery: audio file not found at ${audioPath} and no stored transcript exists. The egress_ended webhook was likely missed while the backend was down, and the 48h audio retention window has passed.`;
    console.error(`❌ Session ${sessionId}: unrecoverable — ${reason}`);
    await Session.findByIdAndUpdate(sessionId, {
      pipelineStatus: 'failed',
      pipelineError: reason.slice(0, 500),
    });
  }
}

export default new TranscriptRecoveryCron();
