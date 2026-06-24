import express from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import Session from '../models/Session.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import liveKitService from '../services/LiveKitService.js';
import { sendSessionConfirmationEmails } from '../utils/emailService.js';
import { sendMentorChatRequestNotificationWithDetails, sendTextQaPurchaseNotification } from '../utils/emailNotifications.js';
import { getService } from '../config/serviceCatalog.js';
import { meetLinkFor, chatLinkFor } from '../utils/frontendUrl.js';
import { sendChatKickoff } from '../controllers/messageController.js';
import { CHAT_SERVICE_ID } from '../utils/chatEntitlement.js';

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

// ─────────────────────────────────────────────────────────────────────────────
//  finalizeSession — called after payment is confirmed.
//
//  Uses ATOMIC DB updates ($set with $exists:false guards) to guarantee that
//  each email/kickoff fires EXACTLY ONCE, even when /verify and the Razorpay
//  webhook both call this function concurrently.
//
//  • Text Q&A  → chat kickoff message + mentor chat-request email + student
//                purchase email. NO Google Meet / LiveKit. NO session-
//                confirmation emails.
//  • Everything else → LiveKit room + session-confirmation emails to both.
// ─────────────────────────────────────────────────────────────────────────────
async function finalizeSession(sessionId, student, mentor, io = null) {
  console.log('===== FINALIZE SESSION =====', sessionId);

  // Atomically claim the "kickoff" work so only one concurrent caller does it.
  // findOneAndUpdate returns null if the flag was already true → skip.
  const sessionForKickoff = await Session.findOneAndUpdate(
    { _id: sessionId, serviceId: CHAT_SERVICE_ID, chatKickoffSent: { $ne: true } },
    { $set: { chatKickoffSent: true } },
    { new: true }
  );

  if (sessionForKickoff) {
    // We won the race — send the kickoff message.
    try {
      await sendChatKickoff(io, sessionForKickoff.userId, sessionForKickoff.mentorId, {
        username: mentor?.name || mentor?.username,
      });
    } catch (err) {
      console.error('Chat kickoff failed (non-fatal):', err.message);
      // Roll back the flag so it can be retried.
      await Session.findByIdAndUpdate(sessionId, { $set: { chatKickoffSent: false } });
    }
  }

  // ── Mentor chat-request email (Text Q&A only) ──
  const sessionForMentorEmail = await Session.findOneAndUpdate(
    { _id: sessionId, serviceId: CHAT_SERVICE_ID, chatMentorEmailSent: { $ne: true } },
    { $set: { chatMentorEmailSent: true } },
    { new: true }
  );

  if (sessionForMentorEmail) {
    try {
      const mentorChatUrl = chatLinkFor(sessionForMentorEmail.userId);
      const result = await sendMentorChatRequestNotificationWithDetails(
        mentor?.email,
        mentor?.name || mentor?.username,
        student?.name || student?.username || 'A student',
        mentorChatUrl,
        {
          scheduledAt: sessionForMentorEmail.scheduledAt,
          topic: sessionForMentorEmail.topic,
          amount: sessionForMentorEmail.amount,
        },
      );
      if (!result?.success) {
        // Roll back so it can be retried.
        await Session.findByIdAndUpdate(sessionId, { $set: { chatMentorEmailSent: false } });
      }
    } catch (err) {
      console.error('Mentor chat-request email failed (non-fatal):', err.message);
      await Session.findByIdAndUpdate(sessionId, { $set: { chatMentorEmailSent: false } });
    }
  }

  // ── Student purchase-confirmation email (Text Q&A only) ──
  const sessionForStudentEmail = await Session.findOneAndUpdate(
    { _id: sessionId, serviceId: CHAT_SERVICE_ID, chatStudentEmailSent: { $ne: true } },
    { $set: { chatStudentEmailSent: true } },
    { new: true }
  );

  if (sessionForStudentEmail) {
    try {
      const studentChatUrl = chatLinkFor(sessionForStudentEmail.mentorId);
      const result = await sendTextQaPurchaseNotification({
        studentEmail: student?.email,
        studentName: student?.name || student?.username || 'there',
        mentorName: mentor?.name || mentor?.username || 'your mentor',
        openChatUrl: studentChatUrl,
        sessionDetails: {
          scheduledAt: sessionForStudentEmail.scheduledAt,
          topic: sessionForStudentEmail.topic,
          amount: sessionForStudentEmail.amount,
        },
      });
      if (!result?.success) {
        await Session.findByIdAndUpdate(sessionId, { $set: { chatStudentEmailSent: false } });
      }
    } catch (err) {
      console.error('Student chat purchase email failed (non-fatal):', err.message);
      await Session.findByIdAndUpdate(sessionId, { $set: { chatStudentEmailSent: false } });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  NON-CHAT SERVICES (audio call, video call, resume review, etc.)
  //  Only runs if the session is NOT a Text Q&A.
  //  The atomic findOneAndUpdate above already returned null for non-chat
  //  sessions (serviceId !== CHAT_SERVICE_ID), so we check the session type
  //  here before doing LiveKit / confirmation emails.
  // ─────────────────────────────────────────────────────────────────────────
  const session = await Session.findById(sessionId).lean();
  if (!session) {
    console.error('finalizeSession: session not found:', sessionId);
    return;
  }

  // ⛔ Text Q&A is fully handled above — never create a meet link or send
  //    session-confirmation emails for it.
  if (session.serviceId === CHAT_SERVICE_ID) {
    console.log('✅ Text Q&A finalize complete — chat-only, no meet link.');
    return;
  }

  // ── LiveKit room (non-chat) ──
  const sessionForRoom = await Session.findOneAndUpdate(
    { _id: sessionId, meetingLink: { $exists: false } },
    { $set: { meetingLink: '__creating__' } }, // placeholder to prevent double-create
    { new: false }
  );

  if (sessionForRoom && liveKitService.isConfigured()) {
    try {
      const roomName = await liveKitService.createRoom(sessionId);
      const meetLink = meetLinkFor(sessionId);
      await Session.findByIdAndUpdate(sessionId, {
        $set: { livekitRoomName: roomName, meetingLink: meetLink },
      });
      console.log(`✅ LiveKit room created: ${roomName}`);
    } catch (err) {
      console.error('LiveKit room creation failed (non-fatal):', err.message);
      // Clear placeholder so next call can retry.
      await Session.findByIdAndUpdate(sessionId, { $unset: { meetingLink: '' } });
    }
  }

  // ── Session-confirmation emails to both parties (non-chat) ──
  const sessionForConfirmEmail = await Session.findOneAndUpdate(
    { _id: sessionId, confirmationEmailsSent: { $ne: true } },
    { $set: { confirmationEmailsSent: true } },
    { new: true }
  );

  if (sessionForConfirmEmail) {
    // Get the freshest meetingLink (might have just been written above).
    const fresh = await Session.findById(sessionId).lean();
    const meetLink = fresh?.meetingLink && fresh.meetingLink !== '__creating__'
      ? fresh.meetingLink
      : null;

    sendSessionConfirmationEmails({
      studentEmail: student?.email, studentName: student?.name || student?.username,
      mentorEmail: mentor?.email, mentorName: mentor?.name || mentor?.username,
      scheduledAt: session.scheduledAt, durationMin: session.durationMin,
      topic: session.topic, meetLink, amount: session.amount,
    }).catch(err => {
      console.error('Session confirmation emails failed (non-fatal):', err.message);
      // Roll back so it can be retried.
      Session.findByIdAndUpdate(sessionId, { $set: { confirmationEmailsSent: false } })
        .catch(() => {});
    });
  }
}

// ─────────────────────────────────────────────
//  Server-side coupon catalog — must match frontend VALID_COUPONS
// ─────────────────────────────────────────────
const COUPONS = {
  FIRST50: { type: 'fixed', value: 50, desc: '₹50 off for first-time students' },
  CAREER20: { type: 'percent', value: 20, desc: '20% off on any session' },
  SUMMER15: { type: 'percent', value: 15, desc: 'Summer special discount' },
};

function applyCoupon(price, code) {
  const c = COUPONS[String(code || '').toUpperCase()];
  if (!c) return { discount: 0, valid: false };
  const discount = c.type === 'fixed'
    ? Math.min(c.value, price)
    : Math.round(price * c.value / 100);
  return { discount, valid: true, desc: c.desc };
}

// ─────────────────────────────────────────────────────────────
//  POST /api/payments/order
//  Body: { mentorId, date, time, topic?, durationMin? }
//  Free mentor (price 0) → confirms immediately. Paid → returns Razorpay order.
// ─────────────────────────────────────────────────────────────
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
    const baseAmount = service ? Math.max(0, service.price) : Math.max(0, Number(mentor.price) || 0);
    const dur = service ? service.durationMin : (Number(durationMin) || 30);
    const sessTopic = topic || service?.label || 'Career Guidance Session';

    // Apply coupon server-side
    const coupon = applyCoupon(baseAmount, couponCode);
    const amount = Math.max(0, baseAmount - coupon.discount);

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
      await finalizeSession(session._id, student, mentorFull, req.app.get('io'));

      return res.json({ ok: true, free: true, session });
    }

    // ── Paid → create Razorpay order at the discounted amount ──
    if (!razorpay) return res.status(500).json({ ok: false, error: 'Payments not configured' });

    const order = await razorpay.orders.create({
      amount: amount * 100,
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
      amount: order.amount,
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
  console.log('🔥 VERIFY ROUTE HIT');
  try {
    const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!sessionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing payment verification fields' });
    }

    const session = await Session.findOne({
      _id: sessionId, userId: req.user.userId, razorpayOrderId: razorpay_order_id,
    });
    console.log('Found session:', session?._id, '| serviceId:', session?.serviceId, '| paymentStatus:', session?.paymentStatus);
    if (!session) return res.status(404).json({ ok: false, error: 'Session/order not found' });

    const [student, mentor] = await Promise.all([
      User.findById(session.userId).select('name username email refreshToken accessToken').lean(),
      User.findById(session.mentorId).select('name username email refreshToken accessToken').lean(),
    ]);

    // If already paid (webhook beat us here), just run finalizeSession to catch
    // anything still pending — atomic guards inside prevent double-sending.
    if (session.paymentStatus === 'paid') {
      console.log('⚡ Already paid — running finalizeSession for any pending work');
      await finalizeSession(session._id, student, mentor, req.app.get('io'));
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

    // Atomically mark as paid (only if not already paid — prevents double-processing
    // if /verify and the webhook race here at the same time).
    const updatedSession = await Session.findOneAndUpdate(
      { _id: session._id, paymentStatus: { $ne: 'paid' } },
      {
        $set: {
          paymentStatus: 'paid',
          status: 'upcoming',
          razorpayPaymentId: razorpay_payment_id,
          platformFeePct: PLATFORM_FEE_PCT,
          mentorShare: Math.round((session.amount || 0) * (100 - PLATFORM_FEE_PCT) / 100),
          payoutStatus: session.amount > 0 ? 'pending' : 'na',
        },
      },
      { new: true }
    );

    if (!updatedSession) {
      // Another process (webhook) already marked it paid — still finalize.
      console.log('⚡ Race: session already marked paid by another process');
    }

    await finalizeSession(session._id, student, mentor, req.app.get('io'));
    console.log('✅ FINALIZE SESSION FINISHED');

    res.json({ ok: true, session: updatedSession || session });
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
  console.log('🌐 WEBHOOK HIT');
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
      console.log('💰 PAYMENT CAPTURED EVENT');
      const session = await Session.findOne({ razorpayOrderId: entity.order_id });
      if (session) {
        const [student, mentor] = await Promise.all([
          User.findById(session.userId).select('name username email refreshToken accessToken').lean(),
          User.findById(session.mentorId).select('name username email refreshToken accessToken').lean(),
        ]);

        // Atomically mark paid — no-op if /verify already did it.
        await Session.findOneAndUpdate(
          { _id: session._id, paymentStatus: { $ne: 'paid' } },
          {
            $set: {
              paymentStatus: 'paid',
              status: 'upcoming',
              razorpayPaymentId: entity.id,
              platformFeePct: PLATFORM_FEE_PCT,
              mentorShare: Math.round((session.amount || 0) * (100 - PLATFORM_FEE_PCT) / 100),
              payoutStatus: session.amount > 0 ? 'pending' : 'na',
            },
          }
        );

        console.log('🚀 WEBHOOK CALLING FINALIZE SESSION');
        await finalizeSession(session._id, student, mentor, req.app.get('io'));
        console.log('✅ WEBHOOK FINALIZE COMPLETE');
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
//  GET /api/payments/mentor-earnings
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
    const paidOut = sessions.filter(s => s.payoutStatus === 'paid').reduce((sum, s) => sum + shareOf(s), 0);

    res.json({
      ok: true,
      totalSessions: sessions.length,
      grossCollected: sessions.reduce((sum, s) => sum + (s.amount || 0), 0),
      netEarnings: pendingPayout + paidOut,
      pendingPayout,
      paidOut,
      sessions,
    });
  } catch (err) {
    console.error('GET /payments/mentor-earnings error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  ADMIN — monthly payout run
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
      {
        $group: {
          _id: '$mentorId',
          mentorName: { $first: '$mentorName' },
          sessions: { $sum: 1 },
          amountOwed: { $sum: '$mentorShare' },
          grossCollected: { $sum: '$amount' },
          oldest: { $min: '$scheduledAt' },
        }
      },
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

    const settled = await Session.find({ mentorId, payoutBatchId: batchId }).select('mentorShare').lean();
    const amountPaid = settled.reduce((sum, s) => sum + (s.mentorShare || 0), 0);

    res.json({ ok: true, mentorId, batchId, sessionsSettled: result.modifiedCount, amountPaid });
  } catch (err) {
    console.error('POST /payments/payouts/settle error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;