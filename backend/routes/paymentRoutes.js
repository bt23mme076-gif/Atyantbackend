import express from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import liveKitService from '../services/LiveKitService.js';
import { sendSessionConfirmationEmails } from '../utils/emailService.js';
import { getService } from '../config/serviceCatalog.js';

const router = express.Router();

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET)
  ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
  : null;

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'YM';

// Platform's cut (%). Mentors keep the rest. Override with PLATFORM_FEE_PCT.
const PLATFORM_FEE_PCT = Math.min(100, Math.max(0, Number(process.env.PLATFORM_FEE_PCT ?? 17)));

// Record what the mentor is owed for a just-paid session, queued for the monthly payout.
function applyMentorShare(session) {
  session.platformFeePct = PLATFORM_FEE_PCT;
  session.mentorShare = Math.round((session.amount || 0) * (100 - PLATFORM_FEE_PCT) / 100);
  session.payoutStatus = session.mentorShare > 0 ? 'pending' : 'na';
}

// Verify Razorpay HMAC signature with a timing-safe comparison.
function verifySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac('sha256', RZP_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false; // length mismatch / malformed signature
  }
}

// Parse "May 26, 2026" + "9:00 AM" (or ISO) into a Date.
const parseSchedule = (date, time) => {
  const d = new Date(`${date} ${time}`);
  return isNaN(d.getTime()) ? null : d;
};

// Create LiveKit room + email both parties. Used by free and paid paths.
async function finalizeSession(session, student, mentor) {
  try {
    if (liveKitService.isConfigured()) {
      const roomName = await liveKitService.createRoom(session._id);
      session.livekitRoomName = roomName;
      session.meetingLink = `${process.env.FRONTEND_URL}/session/meet/${session._id}`;
      await session.save();
      console.log(`✅ LiveKit room created: ${roomName}`);
    }
  } catch (err) {
    console.error('LiveKit room creation failed (non-fatal):', err.message);
  }

  // Confirmation emails to both (non-blocking)
  sendSessionConfirmationEmails({
    studentEmail: student?.email, studentName: student?.name || student?.username,
    mentorEmail:  mentor?.email,  mentorName:  mentor?.name  || mentor?.username,
    scheduledAt: session.scheduledAt, durationMin: session.durationMin,
    topic: session.topic, meetLink: session.meetingLink, amount: session.amount,
  }).catch(err => console.error('Session emails failed (non-fatal):', err.message));
}

// ─────────────────────────────────────────────────────────────
//  POST /api/payments/order
//  Body: { mentorId, date, time, topic?, durationMin? }
//  Free mentor (price 0) → confirms immediately. Paid → returns Razorpay order.
// ─────────────────────────────────────────────────────────────
// Server-side coupon catalog — must match frontend VALID_COUPONS
const COUPONS = {
  FIRST50:   { type: 'fixed',   value: 50,  desc: '₹50 off for first-time students' },
  CAREER20:  { type: 'percent', value: 20,  desc: '20% off on any session' },
  SUMMER15:  { type: 'percent', value: 15,  desc: 'Summer special discount' },
};

function applyCoupon(price, code) {
  const c = COUPONS[String(code || '').toUpperCase()];
  if (!c) return { discount: 0, valid: false };
  const discount = c.type === 'fixed'
    ? Math.min(c.value, price)                        // cap fixed discount at price
    : Math.round(price * c.value / 100);
  return { discount, valid: true, desc: c.desc };
}

router.post('/order', protect, async (req, res) => {
  try {
    const { mentorId, date, time, topic, durationMin, serviceId, couponCode } = req.body;
    if (!mentorId || !date || !time) {
      return res.status(400).json({ ok: false, error: 'mentorId, date and time are required' });
    }

    const scheduledAt = parseSchedule(date, time);
    if (!scheduledAt) return res.status(400).json({ ok: false, error: 'Invalid date/time' });
    if (scheduledAt < new Date()) return res.status(400).json({ ok: false, error: 'Cannot book a session in the past' });

    const mentor = await User.findById(mentorId).select('name username email price servicesOffered').lean();
    if (!mentor) return res.status(404).json({ ok: false, error: 'Mentor not found' });

    // Resolve the platform service (price is fixed server-side, never trusted from client)
    let service = null;
    if (serviceId) {
      service = getService(serviceId);
      if (!service) return res.status(400).json({ ok: false, error: 'Unknown service' });
      if (!(mentor.servicesOffered || []).includes(serviceId)) {
        return res.status(400).json({ ok: false, error: 'This mentor does not offer that service' });
      }
    }

    const mentorName = mentor.name || mentor.username || 'Your Mentor';
    const baseAmount = service ? Math.max(0, service.price) : Math.max(0, Number(mentor.price) || 0); // rupees
    const dur        = service ? service.durationMin : (Number(durationMin) || 30);
    const sessTopic  = topic || service?.label || 'Career Guidance Session';

    // Apply coupon server-side
    const coupon   = applyCoupon(baseAmount, couponCode);
    const amount   = Math.max(0, baseAmount - coupon.discount);

    // ── Free (or fully discounted) → confirm right away ──
    if (amount === 0) {
      const session = await Session.create({
        userId: req.user.userId, mentorId, mentorName, mentorInitials: initials(mentorName),
        topic: sessTopic, serviceId: serviceId || undefined, scheduledAt, durationMin: dur,
        status: 'upcoming', amount: 0, paymentStatus: 'free',
        ...(coupon.valid ? { couponCode: couponCode.toUpperCase(), couponDiscount: coupon.discount } : {}),
      });
      const [student, mentorFull] = await Promise.all([
        User.findById(req.user.userId).select('name username email refreshToken accessToken').lean(),
        User.findById(mentorId).select('name username email refreshToken accessToken').lean(),
      ]);
      await finalizeSession(session, student, mentorFull);
      return res.json({ ok: true, free: true, session });
    }

    // ── Paid → create Razorpay order at the discounted amount ──
    if (!razorpay) return res.status(500).json({ ok: false, error: 'Payments not configured' });

    const order = await razorpay.orders.create({
      amount: amount * 100,        // paise — already after coupon deduction
      currency: 'INR',
      receipt: `sess_${Date.now()}`,
      notes: {
        mentorId: String(mentorId), userId: String(req.user.userId),
        serviceId: serviceId || '',
        couponCode: coupon.valid ? couponCode.toUpperCase() : '',
      },
    });

    const session = await Session.create({
      userId: req.user.userId, mentorId, mentorName, mentorInitials: initials(mentorName),
      topic: sessTopic, serviceId: serviceId || undefined, scheduledAt, durationMin: dur,
      status: 'pending', amount, currency: 'INR',
      paymentStatus: 'created', razorpayOrderId: order.id,
      ...(coupon.valid ? { couponCode: couponCode.toUpperCase(), couponDiscount: coupon.discount } : {}),
    });

    return res.json({
      ok: true,
      free: false,
      keyId: RZP_KEY_ID,
      orderId: order.id,
      amount: order.amount,       // paise (Razorpay checkout expects paise)
      currency: order.currency,
      sessionId: session._id,
      mentorName,
      topic: session.topic,
      couponApplied: coupon.valid,
      couponDiscount: coupon.discount,
    });
  } catch (err) {
    console.error('POST /payments/order error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/payments/verify
//  Body: { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
//  Verifies signature → confirms session → Meet link + emails.
// ─────────────────────────────────────────────────────────────
router.post('/verify', protect, async (req, res) => {
  try {
    const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!sessionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing payment verification fields' });
    }

    const session = await Session.findOne({
      _id: sessionId, userId: req.user.userId, razorpayOrderId: razorpay_order_id,
    });
    if (!session) return res.status(404).json({ ok: false, error: 'Session/order not found' });

    // Idempotent: already confirmed
    if (session.paymentStatus === 'paid') {
      return res.json({ ok: true, alreadyConfirmed: true, session });
    }

    // 1) Verify HMAC signature (timing-safe)
    if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      session.paymentStatus = 'failed';
      await session.save();
      return res.status(400).json({ ok: false, error: 'Payment signature verification failed' });
    }

    // 2) Confirm with Razorpay that the payment was actually captured
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.status !== 'captured') {
        return res.status(400).json({ ok: false, error: `Payment not captured (status: ${payment.status})` });
      }
    } catch (e) {
      console.error('razorpay.payments.fetch failed:', e.message);
      return res.status(502).json({ ok: false, error: 'Could not confirm payment with Razorpay' });
    }

    session.paymentStatus = 'paid';
    session.status = 'upcoming';
    session.razorpayPaymentId = razorpay_payment_id;
    applyMentorShare(session);            // queue the mentor's share for the monthly payout
    await session.save();

    const [student, mentor] = await Promise.all([
      User.findById(session.userId).select('name username email refreshToken accessToken').lean(),
      User.findById(session.mentorId).select('name username email refreshToken accessToken').lean(),
    ]);
    await finalizeSession(session, student, mentor);

    res.json({ ok: true, session });
  } catch (err) {
    console.error('POST /payments/verify error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/payments/webhook  (Razorpay → server, no auth)
//  Safety net: confirms a session even if the user closed the tab
//  before /verify ran. Requires RAZORPAY_WEBHOOK_SECRET + raw body.
// ─────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(400).json({ error: 'Webhook secret not configured' });

    const signature = req.headers['x-razorpay-signature'];
    const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (digest !== signature) {
      console.error('❌ Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(req.body.toString());
    const entity = body.payload?.payment?.entity;

    if (body.event === 'payment.captured' && entity) {
      const session = await Session.findOne({ razorpayOrderId: entity.order_id });
      if (session && session.paymentStatus !== 'paid') {
        session.paymentStatus = 'paid';
        session.status = 'upcoming';
        session.razorpayPaymentId = entity.id;
        applyMentorShare(session);        // queue the mentor's share for the monthly payout
        await session.save();

        const [student, mentor] = await Promise.all([
          User.findById(session.userId).select('name username email refreshToken accessToken').lean(),
          User.findById(session.mentorId).select('name username email refreshToken accessToken').lean(),
        ]);
        await finalizeSession(session, student, mentor);
        console.log(`✅ Webhook confirmed session ${session._id}`);
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/payments/mentor-earnings  — mentor's paid sessions + payout breakdown
//  Shows NET (the mentor's share), split into what's still pending vs already paid.
// ─────────────────────────────────────────────────────────────
router.get('/mentor-earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ ok: false, error: 'Only mentors can view earnings' });
    }
    const sessions = await Session.find({ mentorId: req.user.userId, paymentStatus: 'paid' })
      .populate('userId', 'name username')
      .select('topic amount mentorShare payoutStatus paidOutAt scheduledAt status userId createdAt')
      .sort({ scheduledAt: -1 })
      .lean();

    const shareOf = (s) => (s.mentorShare || 0);
    const pendingPayout = sessions.filter(s => s.payoutStatus === 'pending').reduce((sum, s) => sum + shareOf(s), 0);
    const paidOut       = sessions.filter(s => s.payoutStatus === 'paid').reduce((sum, s) => sum + shareOf(s), 0);

    res.json({
      ok: true,
      totalSessions: sessions.length,
      grossCollected: sessions.reduce((sum, s) => sum + (s.amount || 0), 0), // what students paid
      netEarnings: pendingPayout + paidOut,   // mentor's share across all paid sessions
      pendingPayout,                          // owed, not yet credited
      paidOut,                                // already credited
      sessions,
    });
  } catch (err) {
    console.error('GET /payments/mentor-earnings error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  ADMIN — monthly payout run
//
//  GET  /api/payments/payouts/pending   — what we owe each mentor right now
//  POST /api/payments/payouts/settle    — mark a mentor's pending sessions as paid
//                                          Body: { mentorId, reference? }
// ─────────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }
  next();
};

router.get('/payouts/pending', protect, requireAdmin, async (req, res) => {
  try {
    const rows = await Session.aggregate([
      { $match: { paymentStatus: 'paid', payoutStatus: 'pending', mentorShare: { $gt: 0 } } },
      { $group: {
          _id: '$mentorId',
          mentorName: { $first: '$mentorName' },
          sessions: { $sum: 1 },
          amountOwed: { $sum: '$mentorShare' },
          grossCollected: { $sum: '$amount' },
          oldest: { $min: '$scheduledAt' },
      } },
      { $sort: { amountOwed: -1 } },
    ]);

    const totalOwed = rows.reduce((sum, r) => sum + (r.amountOwed || 0), 0);
    res.json({
      ok: true,
      mentors: rows.map(r => ({ mentorId: r._id, mentorName: r.mentorName, sessions: r.sessions, amountOwed: r.amountOwed, grossCollected: r.grossCollected, oldest: r.oldest })),
      totalOwed,
      mentorCount: rows.length,
    });
  } catch (err) {
    console.error('GET /payments/payouts/pending error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/payouts/settle', protect, requireAdmin, async (req, res) => {
  try {
    const { mentorId, reference } = req.body;
    if (!mentorId) return res.status(400).json({ ok: false, error: 'mentorId is required' });

    const batchId = reference || `payout_${new Date().toISOString().slice(0, 10)}_${String(mentorId).slice(-6)}`;
    const result = await Session.updateMany(
      { mentorId, paymentStatus: 'paid', payoutStatus: 'pending' },
      { $set: { payoutStatus: 'paid', payoutBatchId: batchId, paidOutAt: new Date() } },
    );

    // Re-read the just-settled total for confirmation.
    const settled = await Session.find({ mentorId, payoutBatchId: batchId }).select('mentorShare').lean();
    const amountPaid = settled.reduce((sum, s) => sum + (s.mentorShare || 0), 0);

    res.json({ ok: true, mentorId, batchId, sessionsSettled: result.modifiedCount, amountPaid });
  } catch (err) {
    console.error('POST /payments/payouts/settle error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
