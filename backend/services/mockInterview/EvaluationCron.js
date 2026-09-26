import cron from 'node-cron';
import MockInterview from '../../models/MockInterview.js';
import { evaluateInterview } from './EvaluationService.js';

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
}

export default new MockEvaluationCron();
