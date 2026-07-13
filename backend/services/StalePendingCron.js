import cron from 'node-cron';
import Session from '../models/Session.js';

// How long an unpaid Razorpay order may hold its slot before we release it.
// Razorpay checkout normally resolves within a couple of minutes; 30 min leaves
// plenty of room for a slow payment/webhook while still freeing abandoned carts.
const STALE_MINUTES = Number(process.env.PENDING_SESSION_TTL_MIN ?? 30);

class StalePendingCron {
  start() {
    // Every 10 minutes: release slots held by abandoned, unpaid bookings.
    cron.schedule('*/10 * * * *', () => this.releaseStale());
    console.log('✅ Stale pending-session cron started');
  }

  async releaseStale() {
    try {
      const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
      // Only touch orders that were created but never paid. We cancel rather
      // than delete so a late "payment.captured" webhook can still revive the
      // session (the webhook re-sets it to upcoming/paid) — no lost bookings,
      // no charged-but-missing sessions.
      const res = await Session.updateMany(
        { status: 'pending', paymentStatus: 'created', createdAt: { $lt: cutoff } },
        { $set: { status: 'cancelled' } },
      );
      if (res.modifiedCount > 0) {
        console.log(`🧹 Released ${res.modifiedCount} stale pending session(s) older than ${STALE_MINUTES}m`);
      }
    } catch (err) {
      console.error('Stale pending cron error:', err.message);
    }
  }
}

export default new StalePendingCron();
