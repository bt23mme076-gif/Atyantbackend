import express from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET)
  ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
  : null;

// Subscription pricing (INR) - override with env vars
const PRICING = {
  clarity: {
    monthly: Number(process.env.CLARITY_MONTHLY_PRICE) || 299,
    yearly: Number(process.env.CLARITY_YEARLY_PRICE) || 2390,
  },
  pro: {
    monthly: Number(process.env.PRO_MONTHLY_PRICE) || 699,
    yearly: Number(process.env.PRO_YEARLY_PRICE) || 5590,
  },
};

// Credits per plan per month
const CREDITS_PER_MONTH = {
  clarity: 1,
  pro: 3,
};

// Verify Razorpay HMAC signature with timing-safe comparison
function verifySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac('sha256', RZP_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// Calculate expiry date based on billing cycle
function calculateExpiry(billing) {
  const now = new Date();
  if (billing === 'yearly') {
    now.setFullYear(now.getFullYear() + 1);
  } else {
    now.setMonth(now.getMonth() + 1);
  }
  return now;
}

// ─────────────────────────────────────────────────────────────
//  POST /api/subscriptions/create
//  Body: { plan, billing }
//  Creates Razorpay order for subscription purchase
// ─────────────────────────────────────────────────────────────
router.post('/create', protect, async (req, res) => {
  try {
    const { plan, billing } = req.body;
    
    if (!plan || !billing) {
      return res.status(400).json({ ok: false, error: 'plan and billing are required' });
    }

    if (!['clarity', 'pro'].includes(plan)) {
      return res.status(400).json({ ok: false, error: 'Invalid plan' });
    }

    if (!['monthly', 'yearly'].includes(billing)) {
      return res.status(400).json({ ok: false, error: 'Invalid billing cycle' });
    }

    if (!razorpay) {
      return res.status(500).json({ ok: false, error: 'Payments not configured' });
    }

    const amount = PRICING[plan][billing];
    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: 'INR',
      receipt: `sub_${plan}_${billing}_${Date.now()}`,
      notes: {
        userId: String(req.user.userId),
        plan,
        billing,
      },
    });

    res.json({
      ok: true,
      keyId: RZP_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan,
      billing,
    });
  } catch (err) {
    console.error('POST /subscriptions/create error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/subscriptions/verify
//  Body: { plan, billing, razorpay_order_id, razorpay_payment_id, razorpay_signature }
//  Verifies payment and activates subscription
// ─────────────────────────────────────────────────────────────
router.post('/verify', protect, async (req, res) => {
  try {
    const { plan, billing, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!plan || !billing || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing verification fields' });
    }

    // Verify signature
    if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ ok: false, error: 'Payment signature verification failed' });
    }

    // Confirm payment with Razorpay
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.status !== 'captured') {
        return res.status(400).json({ ok: false, error: `Payment not captured (status: ${payment.status})` });
      }
    } catch (e) {
      console.error('razorpay.payments.fetch failed:', e.message);
      return res.status(502).json({ ok: false, error: 'Could not confirm payment with Razorpay' });
    }

    // Update user subscription
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const expiry = calculateExpiry(billing);
    const credits = CREDITS_PER_MONTH[plan];

    user.subscriptionPlan = plan;
    user.subscriptionStatus = 'active';
    user.subscriptionExpiry = expiry;
    user.razorpaySubscriptionId = razorpay_order_id;
    user.subscriptionCredits = (user.subscriptionCredits || 0) + credits;
    
    await user.save();

    res.json({
      ok: true,
      subscription: {
        plan: user.subscriptionPlan,
        status: user.subscriptionStatus,
        expiry: user.subscriptionExpiry,
        credits: user.subscriptionCredits,
      },
    });
  } catch (err) {
    console.error('POST /subscriptions/verify error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/subscriptions/status
//  Returns current subscription status for logged-in user
// ─────────────────────────────────────────────────────────────
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      'subscriptionPlan subscriptionStatus subscriptionExpiry subscriptionCredits'
    );

    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Check if subscription has expired
    let isActive = user.subscriptionStatus === 'active';
    if (user.subscriptionExpiry && new Date() > user.subscriptionExpiry) {
      isActive = false;
      user.subscriptionStatus = 'expired';
      await user.save();
    }

    res.json({
      ok: true,
      subscription: {
        plan: user.subscriptionPlan,
        status: isActive ? 'active' : user.subscriptionStatus,
        expiry: user.subscriptionExpiry,
        credits: user.subscriptionCredits,
        isExpired: !isActive,
      },
    });
  } catch (err) {
    console.error('GET /subscriptions/status error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/subscriptions/cancel
//  Cancels active subscription (stops auto-renewal)
// ─────────────────────────────────────────────────────────────
router.post('/cancel', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    if (user.subscriptionPlan === 'free') {
      return res.status(400).json({ ok: false, error: 'No active subscription to cancel' });
    }

    // Cancel Razorpay subscription if exists
    if (user.razorpaySubscriptionId && razorpay) {
      try {
        await razorpay.subscriptions.cancel(user.razorpaySubscriptionId);
      } catch (e) {
        console.error('Razorpay subscription cancel failed:', e.message);
        // Continue anyway - we'll mark as cancelled locally
      }
    }

    user.subscriptionStatus = 'cancelled';
    await user.save();

    res.json({
      ok: true,
      subscription: {
        plan: user.subscriptionPlan,
        status: user.subscriptionStatus,
        expiry: user.subscriptionExpiry,
        credits: user.subscriptionCredits,
      },
    });
  } catch (err) {
    console.error('POST /subscriptions/cancel error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/subscriptions/webhook
//  Razorpay webhook handler for subscription events
// ─────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    const signature = req.headers['x-razorpay-signature'];
    const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    
    if (digest !== signature) {
      console.error('❌ Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(req.body.toString());
    const entity = body.payload?.payment?.entity;

    if (body.event === 'payment.captured' && entity) {
      const userId = entity.notes?.userId;
      const plan = entity.notes?.plan;
      const billing = entity.notes?.billing;

      if (userId && plan && billing) {
        const user = await User.findById(userId);
        if (user && user.razorpaySubscriptionId !== entity.order_id) {
          const expiry = calculateExpiry(billing);
          const credits = CREDITS_PER_MONTH[plan];

          user.subscriptionPlan = plan;
          user.subscriptionStatus = 'active';
          user.subscriptionExpiry = expiry;
          user.razorpaySubscriptionId = entity.order_id;
          user.subscriptionCredits = (user.subscriptionCredits || 0) + credits;
          
          await user.save();
          console.log(`✅ Webhook activated subscription for user ${userId}`);
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
