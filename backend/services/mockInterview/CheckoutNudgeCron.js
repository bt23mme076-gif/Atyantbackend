import cron from 'node-cron';
import MockInterview from '../../models/MockInterview.js';
import { notifyCheckoutPending } from './MockNotify.js';

// One WhatsApp nudge per interview, about an hour after a student opened the
// payment for it and didn't finish. Older than a day is left alone: by then a
// message reads as spam rather than a reminder.
const AFTER_MS = 60 * 60 * 1000;
const UNTIL_MS = 24 * 60 * 60 * 1000;

class CheckoutNudgeCron {
  running = false;

  start() {
    cron.schedule('*/10 * * * *', () => this._tick());
    console.log('✅ Mock interview checkout nudge cron started');
  }

  async _tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = await MockInterview.find({
        status: { $in: ['planned', 'voicing', 'ready'] },
        'entryPayment.status': 'created',
        'entryPayment.nudgedAt': null,
        'entryPayment.createdAt': { $gte: new Date(now - UNTIL_MS), $lte: new Date(now - AFTER_MS) },
      }).select('_id userId company role entryPayment').limit(50).lean();

      for (const iv of due) {
        // Claim first so a slow send can't produce a second nudge on the next tick.
        const claimed = await MockInterview.updateOne(
          { _id: iv._id, 'entryPayment.nudgedAt': null, 'entryPayment.status': 'created' },
          { $set: { 'entryPayment.nudgedAt': new Date() } },
        );
        if (!claimed.modifiedCount) continue;
        // They already paid for a different interview since: they moved on, don't nag.
        const movedOn = await MockInterview.exists({
          userId: iv.userId, _id: { $ne: iv._id },
          'entryPayment.status': 'paid', 'entryPayment.paidAt': { $gte: iv.entryPayment.createdAt },
        });
        if (!movedOn) await notifyCheckoutPending(iv);
      }
    } catch (err) {
      console.error('Checkout nudge cron error:', err.message);
    } finally {
      this.running = false;
    }
  }
}

export default new CheckoutNudgeCron();
