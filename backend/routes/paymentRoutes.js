import express from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import { createMeetEvent } from '../utils/googleMeet.js';
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

// Generate the Meet link + email both parties. Used by free and paid paths.
async function finalizeSession(session, student, mentor) {
  try {
    const meet = await createMeetEvent({
      mentor:  { email: mentor?.email,  name: mentor?.name  || mentor?.username,  refreshToken: mentor?.refreshToken,  accessToken: mentor?.accessToken },
      student: { email: student?.email, name: student?.name || student?.username, refreshToken: student?.refreshToken, accessToken: student?.accessToken },
      topic: session.topic,
      startTime: session.scheduledAt,
      durationMin: session.durationMin,
    });
    if (meet?.meetLink) {
      session.meetingLink = meet.meetLink;
      session.calendarEventId = meet.eventId;
      await session.save();
    }
  } catch (err) {
    console.error('Meet generation failed (non-fatal):', err.message);
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
router.post('/order', protect, async (req, res) => {
  try {
    const { mentorId, date, time, topic, durationMin, serviceId } = req.body;
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
    const amount = service ? Math.max(0, service.price) : Math.max(0, Number(mentor.price) || 0); // rupees
    const dur = service ? service.durationMin : (Number(durationMin) || 30);
    const sessTopic = topic || service?.label || 'Career Guidance Session';

    // ── Free service → confirm right away (no Razorpay) ──
    if (amount === 0) {
      const session = await Session.create({
        userId: req.user.userId, mentorId, mentorName, mentorInitials: initials(mentorName),
        topic: sessTopic, serviceId: serviceId || undefined, scheduledAt, durationMin: dur,
        status: 'upcoming', amount: 0, paymentStatus: 'free',
      });
      const [student, mentorFull] = await Promise.all([
        User.findById(req.user.userId).select('name username email refreshToken accessToken').lean(),
        User.findById(mentorId).select('name username email refreshToken accessToken').lean(),
      ]);
      await finalizeSession(session, student, mentorFull);
      return res.json({ ok: true, free: true, session });
    }

    // ── Paid service → create Razorpay order + pending session ──
    if (!razorpay) return res.status(500).json({ ok: false, error: 'Payments not configured' });

    const order = await razorpay.orders.create({
      amount: amount * 100,        // paise
      currency: 'INR',
      receipt: `sess_${Date.now()}`,
      notes: { mentorId: String(mentorId), userId: String(req.user.userId), serviceId: serviceId || '' },
    });

    const session = await Session.create({
      userId: req.user.userId, mentorId, mentorName, mentorInitials: initials(mentorName),
      topic: sessTopic, serviceId: serviceId || undefined, scheduledAt, durationMin: dur,
      status: 'pending', amount, currency: 'INR',
      paymentStatus: 'created', razorpayOrderId: order.id,
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
//  GET /api/payments/mentor-earnings  — mentor's paid sessions + totals
// ─────────────────────────────────────────────────────────────
router.get('/mentor-earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ ok: false, error: 'Only mentors can view earnings' });
    }
    const sessions = await Session.find({ mentorId: req.user.userId, paymentStatus: 'paid' })
      .populate('userId', 'name username')
      .select('topic amount scheduledAt status userId createdAt')
      .sort({ scheduledAt: -1 })
      .lean();

    const totalEarnings = sessions.reduce((sum, s) => sum + (s.amount || 0), 0);
    res.json({ ok: true, totalEarnings, totalSessions: sessions.length, sessions });
  } catch (err) {
    console.error('GET /payments/mentor-earnings error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
