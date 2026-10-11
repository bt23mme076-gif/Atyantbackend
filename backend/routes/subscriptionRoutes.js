import express from 'express';
import crypto from 'crypto';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import {
  razorpay, PRICING, CREDITS_PER_MONTH, SUBSCRIPTION_RECEIPT_PREFIX,
  fetchSubscriptionOrder, activateSubscription, subscriptionSummary,
} from '../services/SubscriptionService.js';
import { AUTO_APPLY_DAILY_LIMIT } from '../services/autoapply/limits.js';

const router = express.Router();

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

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

// ─────────────────────────────────────────────────────────────
//  GET /api/subscriptions/pricing  (public)
//  The exact amounts /create charges, so the pricing page never drifts from them.
// ─────────────────────────────────────────────────────────────
router.get('/pricing', (req, res) => {
  res.json({ ok: true, pricing: PRICING, credits: CREDITS_PER_MONTH, autoApplyDaily: AUTO_APPLY_DAILY_LIMIT });
});

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
      receipt: `${SUBSCRIPTION_RECEIPT_PREFIX}${plan}_${billing}_${Date.now()}`,
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
//  Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//  Verifies payment and activates subscription. Plan + billing are read from
//  our own Razorpay order, not the request body.
// ─────────────────────────────────────────────────────────────
router.post('/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing verification fields' });
    }
    if (!razorpay) {
      return res.status(500).json({ ok: false, error: 'Payments not configured' });
    }

    // Verify signature
    if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ ok: false, error: 'Payment signature verification failed' });
    }

    // Confirm payment + order with Razorpay
    let sub;
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.status !== 'captured') {
        return res.status(400).json({ ok: false, error: `Payment not captured (status: ${payment.status})` });
      }
      if (payment.order_id !== razorpay_order_id) {
        return res.status(400).json({ ok: false, error: 'Payment does not belong to this order' });
      }
      sub = await fetchSubscriptionOrder(razorpay_order_id);
    } catch (e) {
      console.error('Razorpay payment/order fetch failed:', e.message);
      return res.status(502).json({ ok: false, error: 'Could not confirm payment with Razorpay' });
    }

    if (!sub) {
      return res.status(400).json({ ok: false, error: 'Not a subscription order' });
    }
    if (sub.userId !== String(req.user.userId)) {
      return res.status(403).json({ ok: false, error: 'This payment belongs to a different account' });
    }

    const { user } = await activateSubscription({
      userId: sub.userId, plan: sub.plan, billing: sub.billing, orderId: razorpay_order_id, source: 'verify',
    });
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    res.json({ ok: true, subscription: subscriptionSummary(user) });
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

    // Raw body (server.js skips JSON parsing for this path) — HMAC must cover the exact bytes.
    const signature = req.headers['x-razorpay-signature'];
    const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');

    if (digest !== signature) {
      console.error('❌ Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(req.body.toString());
    const entity = body.payload?.payment?.entity;

    if (body.event === 'payment.captured' && entity?.order_id && razorpay) {
      const sub = await fetchSubscriptionOrder(entity.order_id);
      if (sub) {
        const { activated } = await activateSubscription({
          userId: sub.userId, plan: sub.plan, billing: sub.billing, orderId: entity.order_id, source: 'webhook',
        });
        if (activated) console.log(`✅ Webhook activated ${sub.plan} for user ${sub.userId}`);
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
