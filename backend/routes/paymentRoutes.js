import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import protect from '../middleware/authMiddleware.js';
import User from '../models/User.js';
import Payment from '../models/Payment.js';
import Question from '../models/Question.js';
import { sendMentorPaymentNotification } from '../utils/emailService.js';


const router = express.Router();

// ─────────────────────────────────────────────
//  RAZORPAY INIT  (fail fast if keys missing)
// ─────────────────────────────────────────────
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('❌ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing in .env');
  // Don't crash server — routes will return 503 if called
}

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function razorpayReady(res) {
  if (!razorpay) {
    res.status(503).json({ success: false, error: 'Payment service not configured' });
    return false;
  }
  return true;
}

function isValidObjectId(id) {
  return id && /^[a-f\d]{24}$/i.test(id);
}

/** Verify Razorpay HMAC signature — returns boolean */
function verifySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  // 🔴 FIX: Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature,  'hex')
  );
}

// ─────────────────────────────────────────────
//  1. CREATE ORDER  (credits purchase)
// ─────────────────────────────────────────────
router.post('/create-order', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const { amount = 1, credits = 5 } = req.body;

    if (amount <= 0 || credits <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount or credits' });
    }

    const order = await razorpay.orders.create({
      amount  : Math.round(amount * 100),  // paise
      currency: 'INR',
      receipt : `cr_${Date.now().toString().slice(-10)}`,
      notes   : { credits: String(credits), userId: req.user.userId }
    });

    res.json({ ...order, creditsToAdd: credits });
  } catch (error) {
    console.error('create-order error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
});

// ─────────────────────────────────────────────
//  2. VERIFY PAYMENT  (credits)
//  🔴 FIX: Use $inc instead of read-modify-write
//          to prevent race condition on concurrent payments
// ─────────────────────────────────────────────
router.post('/verify-payment', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment fields' });
    }

    // 🔴 FIX: signature lengths must match before timingSafeEqual
    let valid = false;
    try { valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature); }
    catch { valid = false; }

    if (!valid) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    const order        = await razorpay.orders.fetch(razorpay_order_id);
    const creditsToAdd = parseInt(order.notes?.credits) || 5;

    // 🔴 FIX: atomic update — no race condition
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $inc: { messageCredits: creditsToAdd, credits: creditsToAdd } },
      { new: true, select: 'username messageCredits credits' }
    );

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    console.log(`✅ +${creditsToAdd} credits → ${user.username} | msg:${user.messageCredits} q:${user.credits}`);

    res.json({
      success        : true,
      message        : 'Payment verified successfully',
      creditsAdded   : creditsToAdd,
      messageCredits : user.messageCredits,
      questionCredits: user.credits
    });
  } catch (error) {
    console.error('verify-payment error:', error.message);
    res.status(500).json({ success: false, error: 'Payment verification error' });
  }
});

// ─────────────────────────────────────────────
//  3. CREATE MENTORSHIP ORDER
// ─────────────────────────────────────────────
router.post('/create-mentorship-order', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const { amount, mentorshipType, questionId } = req.body;

    if (!amount || !mentorshipType || !questionId) {
      return res.status(400).json({ success: false, error: 'amount, mentorshipType, questionId required' });
    }
    if (!isValidObjectId(questionId)) {
      return res.status(400).json({ success: false, error: 'Invalid questionId' });
    }
    if (!['chat', 'video', 'roadmap'].includes(mentorshipType)) {
      return res.status(400).json({ success: false, error: 'Invalid mentorshipType' });
    }

    const order = await razorpay.orders.create({
      amount  : Math.round(amount * 100),
      currency: 'INR',
      receipt : `M${Date.now().toString().slice(-8)}`,   // max 40 chars
      notes   : {
        questionId    : questionId.toString(),
        mentorshipType,
        userId        : req.user.userId.toString()
      }
    });

    res.json({ success: true, order, razorpayKeyId: RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('create-mentorship-order error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Failed to create order' });
  }
});

// ─────────────────────────────────────────────
//  4. VERIFY MENTORSHIP PAYMENT
//  🔴 FIX: Idempotent — check duplicate payment before saving
// ─────────────────────────────────────────────
router.post('/verify-mentorship', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      questionId,
      mentorshipType
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !questionId || !mentorshipType) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!isValidObjectId(questionId)) {
      return res.status(400).json({ success: false, error: 'Invalid questionId' });
    }

    // Signature check
    let valid = false;
    try { valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature); }
    catch { valid = false; }
    if (!valid) return res.status(400).json({ success: false, error: 'Invalid payment signature' });

    // 🔴 FIX: Idempotency — don't create duplicate Payment records
    const existing = await Payment.findOne({ razorpayPaymentId: razorpay_payment_id });
    if (existing) {
      return res.json({ success: true, message: 'Already verified', payment: existing, mentorId: existing.mentorId });
    }

    // Verify with Razorpay that payment is actually captured
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.status !== 'captured') {
      return res.status(400).json({ success: false, error: `Payment not captured (status: ${payment.status})` });
    }

    const question = await Question.findById(questionId).lean();
    if (!question)                  return res.status(404).json({ success: false, error: 'Question not found' });
    if (!question.selectedMentorId) return res.status(400).json({ success: false, error: 'No mentor assigned' });

    // Save payment record
    const paymentRecord = await Payment.create({
      razorpayPaymentId: razorpay_payment_id,
      questionId,
      userId        : req.user.userId,
      mentorId      : question.selectedMentorId,
      mentorshipType,
      amount        : payment.amount / 100,
      currency      : payment.currency,
      status        : 'captured',
      razorpayData  : payment
    });

    // Update question (non-blocking ok here since payment already saved)
    await Question.findByIdAndUpdate(questionId, {
      isPaid            : true,
      paidMentorshipType: mentorshipType,
      paidAt            : new Date()
    });

    // Email mentor — non-blocking
    Promise.all([
      User.findById(question.selectedMentorId).select('name email').lean(),
      User.findById(req.user.userId).select('name').lean()
    ]).then(([mentor, student]) => {
      if (mentor?.email && student) {
        sendMentorPaymentNotification(
          mentor.email, mentor.name, student.name,
          mentorshipType, paymentRecord.amount, question.questionText
        ).catch(err => console.error('Payment email failed:', err.message));
      }
    }).catch(err => console.error('Mentor/student lookup failed:', err.message));

    console.log(`✅ Mentorship payment: ${mentorshipType} | ₹${paymentRecord.amount} | Q:${questionId}`);

    res.json({
      success : true,
      message : 'Payment verified successfully',
      payment : paymentRecord,
      mentorId: question.selectedMentorId
    });
  } catch (error) {
    console.error('verify-mentorship error:', error.message);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ─────────────────────────────────────────────
//  5. RAZORPAY WEBHOOK
//  🔴 FIX: express.raw() needed for webhook signature verification
//          (register raw body parser in server.js for /api/payment/webhook)
// ─────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret    = RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET not set — webhook unverified');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    const signature = req.headers['x-razorpay-signature'];
    const digest    = crypto
      .createHmac('sha256', secret)
      .update(req.body)   // raw Buffer — not parsed JSON
      .digest('hex');

    if (digest !== signature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const body        = JSON.parse(req.body.toString());
    const event       = body.event;
    const paymentData = body.payload?.payment?.entity;

    console.log(`📥 Webhook: ${event}`);

    if (event === 'payment.captured' && paymentData) {
      // Idempotency — skip if already processed
      const exists = await Payment.findOne({ razorpayPaymentId: paymentData.id });
      if (exists) {
        console.log(`⏭️ Webhook: already processed ${paymentData.id}`);
        return res.json({ status: 'ok' });
      }

      const { questionId, mentorshipType, userId } = paymentData.notes || {};
      if (!questionId || !mentorshipType || !userId) {
        console.error('❌ Webhook: missing metadata');
        return res.status(400).json({ error: 'Missing metadata' });
      }

      const question = await Question.findById(questionId).lean();

      await Payment.create({
        razorpayPaymentId: paymentData.id,
        questionId,
        userId,
        mentorId      : question?.selectedMentorId,
        mentorshipType,
        amount        : paymentData.amount / 100,
        currency      : paymentData.currency,
        status        : 'captured',
        razorpayData  : paymentData
      });

      if (questionId) {
        await Question.findByIdAndUpdate(questionId, {
          isPaid            : true,
          paidMentorshipType: mentorshipType,
          paidAt            : new Date()
        });
      }

      console.log(`✅ Webhook processed: ${mentorshipType} | ₹${paymentData.amount / 100}`);
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────
//  6. PAYMENT STATUS  (by questionId)
// ─────────────────────────────────────────────
router.get('/status/:questionId', protect, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.questionId)) {
      return res.status(400).json({ error: 'Invalid question ID' });
    }

    const payment = await Payment.findOne({
      questionId: req.params.questionId,
      status    : 'captured'
    })
      .select('mentorshipType amount createdAt')
      .sort({ createdAt: -1 })
      .lean();

    if (payment) {
      res.json({ isPaid: true, mentorshipType: payment.mentorshipType, amount: payment.amount, paidAt: payment.createdAt });
    } else {
      res.json({ isPaid: false });
    }
  } catch (error) {
    console.error('payment status error:', error.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ─────────────────────────────────────────────
//  7. MY PAYMENTS  (student)
// ─────────────────────────────────────────────
router.get('/my-payments', protect, async (req, res) => {
  try {
    const payments = await Payment.find({ userId: req.user.userId, status: 'captured' })
      .populate('questionId', 'questionText')
      .populate('mentorId',   'name username')
      .select('-razorpayData')   // 🔴 FIX: don't leak raw Razorpay payload to client
      .sort({ createdAt: -1 })
      .lean();

    res.json(payments);
  } catch (error) {
    console.error('my-payments error:', error.message);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ─────────────────────────────────────────────
//  8. MENTOR EARNINGS
// ─────────────────────────────────────────────
router.get('/mentor-earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ error: 'Only mentors can access this' });
    }

    const payments = await Payment.find({ mentorId: req.user.userId, status: 'captured' })
      .populate('userId',     'name username email')
      .populate('questionId', 'questionText')
      .select('-razorpayData')   // 🔴 FIX: don't leak raw payload
      .sort({ createdAt: -1 })
      .lean();

    const totalEarnings = payments.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      payments,
      totalEarnings,
      totalSessions: payments.length
    });
  } catch (error) {
    console.error('mentor-earnings error:', error.message);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ─────────────────────────────────────────────
//  9. CREATE SERVICE BOOKING ORDER
// ─────────────────────────────────────────────
router.post('/create-booking-order', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const { amount, serviceId, mentorId, scheduledAt, notes } = req.body;

    if (!amount || !serviceId || !mentorId) {
      return res.status(400).json({ success: false, error: 'amount, serviceId, and mentorId required' });
    }

    const order = await razorpay.orders.create({
      amount  : Math.round(amount * 100),  // paise
      currency: 'INR',
      receipt : `booking_${Date.now().toString().slice(-10)}`,
      notes   : {
        serviceId: serviceId.toString(),
        mentorId: mentorId.toString(),
        userId: req.user.userId.toString(),
        scheduledAt: scheduledAt || '',
        notes: notes || ''
      }
    });

    res.json({ success: true, order, razorpayKeyId: RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('create-booking-order error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create booking order' });
  }
});

// ─────────────────────────────────────────────
//  10. VERIFY SERVICE BOOKING PAYMENT
// ─────────────────────────────────────────────
router.post('/verify-booking', protect, async (req, res) => {
  if (!razorpayReady(res)) return;
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      serviceId,
      mentorId,
      scheduledAt,
      notes
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment fields' });
    }

    if (!isValidObjectId(serviceId) || !isValidObjectId(mentorId)) {
      return res.status(400).json({ success: false, error: 'Invalid serviceId or mentorId' });
    }

    // Verify signature
    let valid = false;
    try { valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature); }
    catch (err) { 
      console.error('Signature verification error:', err);
      valid = false; 
    }

    if (!valid) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    // Fetch payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.status !== 'captured') {
      return res.status(400).json({ success: false, error: `Payment not captured (status: ${payment.status})` });
    }

    const Booking = (await import('../models/Booking.js')).default;
    const Service = (await import('../models/Service.js')).default;

    const existingBooking = await Booking.findOne({ 
      'razorpayPaymentId': razorpay_payment_id 
    });

    if (existingBooking) {
      console.log('⏭️ Booking already exists for payment:', razorpay_payment_id);
      return res.json({ 
        success: true, 
        message: 'Booking already confirmed', 
        booking: existingBooking 
      });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    const BookingService = (await import('../services/BookingService.js')).default;

    const booking = await BookingService.createBooking({
      userId: req.user.userId,
      mentorId,
      serviceId,
      scheduledAt,
      notes,
      amount: payment.amount / 100,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id
    });

    console.log(`✅ Service booking payment: ₹${payment.amount / 100} | Service:${serviceId}`);

    // Meeting link is already generated inside BookingService.createBooking
    // for both video-call and audio-call types.
    
    res.json({
      success: true,
      message: 'Booking confirmed successfully',
      booking,
      meetingLink: booking.meetingLink || null
    });
  } catch (error) {
    console.error('verify-booking error:', error);
    res.status(500).json({ success: false, error: error.message || 'Booking verification failed' });
  }
});

export default router;
