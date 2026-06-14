// ─────────────────────────────────────────────────────────────────────────────
//  Clean-up: wipe Atyant Engine mentor meets + all buy/service history
//
//  WHAT IT DOES:
//   1. Deletes every Session (and legacy Booking) assigned to the Atyant Engine
//      mentor (User { username:'Atyant Engine', email:'atyant.in@gmail.com' }).
//   2. Deletes ALL "buy service history" — Session/Booking docs that carry payment
//      info (a Razorpay order/payment, or paymentStatus created/paid/failed).
//
//  This is destructive and irreversible. Defaults to a DRY RUN that only reports
//  counts; pass --confirm to actually delete.
//
//  USAGE (from backend/ folder):
//    node scripts/cleanAtyantEngineMeets.js            # dry run — show what would go
//    node scripts/cleanAtyantEngineMeets.js --confirm  # actually delete
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Booking from '../models/Booking.js';
import User from '../models/User.js';

const CONFIRM = process.argv.slice(2).includes('--confirm');

// "Buy service history" = anything that represents a purchase.
const paidSessionFilter = {
  $or: [
    { paymentStatus: { $in: ['created', 'paid', 'failed'] } },
    { razorpayOrderId: { $exists: true, $ne: null } },
    { razorpayPaymentId: { $exists: true, $ne: null } },
  ],
};
const paidBookingFilter = {
  $or: [
    { paymentId: { $exists: true, $ne: null } },
    { amount: { $gt: 0 } },
  ],
};

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in environment variables.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connected\n');

  // ── Resolve the Atyant Engine mentor ──
  const engine = await User.findOne({
    $or: [{ username: 'Atyant Engine' }, { email: 'atyant.in@gmail.com' }],
  }).select('_id username email').lean();

  if (!engine) {
    console.warn('⚠️  Atyant Engine mentor user not found — skipping mentor-scoped delete.');
  } else {
    console.log(`🔎 Atyant Engine mentor: ${engine.username} <${engine.email}> (${engine._id})`);
  }

  const engineSessionFilter = engine ? { mentorId: engine._id } : null;
  const engineBookingFilter = engine ? { mentorId: engine._id } : null;

  // ── Count what will be removed ──
  const counts = {
    engineSessions: engineSessionFilter ? await Session.countDocuments(engineSessionFilter) : 0,
    engineBookings: engineBookingFilter ? await Booking.countDocuments(engineBookingFilter) : 0,
    paidSessions: await Session.countDocuments(paidSessionFilter),
    paidBookings: await Booking.countDocuments(paidBookingFilter),
  };

  console.log('\n────────── PLAN ──────────');
  console.log(`Atyant Engine sessions to delete : ${counts.engineSessions}`);
  console.log(`Atyant Engine bookings to delete : ${counts.engineBookings}`);
  console.log(`Paid/buy-history sessions to delete (global) : ${counts.paidSessions}`);
  console.log(`Paid/buy-history bookings to delete (global) : ${counts.paidBookings}`);
  console.log('──────────────────────────\n');

  if (!CONFIRM) {
    console.log('💡 DRY RUN — nothing deleted. Re-run with --confirm to apply.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Delete ──
  const results = {};
  if (engineSessionFilter) results.engineSessions = (await Session.deleteMany(engineSessionFilter)).deletedCount;
  if (engineBookingFilter) results.engineBookings = (await Booking.deleteMany(engineBookingFilter)).deletedCount;
  results.paidSessions = (await Session.deleteMany(paidSessionFilter)).deletedCount;
  results.paidBookings = (await Booking.deleteMany(paidBookingFilter)).deletedCount;

  console.log('🗑️  DELETED:');
  console.log(`   Atyant Engine sessions : ${results.engineSessions ?? 0}`);
  console.log(`   Atyant Engine bookings : ${results.engineBookings ?? 0}`);
  console.log(`   Paid sessions          : ${results.paidSessions}`);
  console.log(`   Paid bookings          : ${results.paidBookings}`);
  console.log('\n✅ Clean-up complete — meets & buy-service history are fresh.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ Clean-up failed:', err);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
