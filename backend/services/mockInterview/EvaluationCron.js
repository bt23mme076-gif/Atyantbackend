import cron from 'node-cron';
import MockInterview from '../../models/MockInterview.js';
import { evaluateInterview } from './EvaluationService.js';
import { endLiveInterview } from './liveSession.js';
import { INTERVIEW_DURATION_MS } from './liveConfig.js';
import liveKitService from '../LiveKitService.js';

// An agent ends its interview by 15 min + 2 min grace + 1 min hard stop. An
// interview still "live" well past that lost its agent (crash, redeploy) and
// would otherwise hold its room and a Hire concurrency slot forever.
const STALE_LIVE_MS = INTERVIEW_DURATION_MS + 10 * 60 * 1000;

// The interview agent ends an interview by setting status 'evaluating'; this
// picks those up. One at a time, so evaluations don't compete for Groq quota.
class MockEvaluationCron {
  running = false;

  start() {
    this._tick();
    cron.schedule('* * * * *', () => this._tick());
    console.log('✅ Mock interview evaluation cron started');
  }

  async _tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this._endStale();
      const pending = await MockInterview.find({ status: 'evaluating' })
        .select('_id')
        .sort({ 'live.endedAt': 1 })
        .limit(5)
        .lean();
      for (const { _id } of pending) {
        try {
          await evaluateInterview(_id);
        } catch (err) {
          console.error(`Mock interview ${_id} evaluation failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('Mock evaluation cron error:', err.message);
    } finally {
      this.running = false;
    }
  }

  async _endStale() {
    const stale = await MockInterview.find({ status: 'live', 'live.startedAt': { $lt: new Date(Date.now() - STALE_LIVE_MS) } })
      .select('_id live.roomName')
      .limit(20)
      .lean();
    for (const iv of stale) {
      try {
        await endLiveInterview(iv._id, 'stale');
        if (iv.live?.roomName) await liveKitService.deleteRoom(iv.live.roomName);
        console.warn(`Mock interview ${iv._id} was still live after its time limit; ended it`);
      } catch (err) {
        console.error(`Mock interview ${iv._id} stale cleanup failed:`, err.message);
      }
    }
  }
}

export default new MockEvaluationCron();
