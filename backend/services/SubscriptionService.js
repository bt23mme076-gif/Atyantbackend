import Razorpay from 'razorpay';
import User from '../models/User.js';
import { trackEvent } from './email/EmailPipeline.js';
import { logFunnel } from '../utils/funnel.js';

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
export const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET)
  ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
  : null;

// Subscription pricing (INR) - override with env vars. Yearly = 20% off 12 months.
export const PRICING = {
  clarity: {
    monthly: Number(process.env.CLARITY_MONTHLY_PRICE) || 299,
    yearly: Number(process.env.CLARITY_YEARLY_PRICE) || 2868,
  },
  pro: {
    monthly: Number(process.env.PRO_MONTHLY_PRICE) || 699,
    yearly: Number(process.env.PRO_YEARLY_PRICE) || 6708,
  },
  // Auto-Apply pass: 30 days of auto-apply only. `listPrice` is the struck-through price shown next to the offer.
  autoapply: {
    monthly: Number(process.env.AUTOAPPLY_PASS_PRICE) || 49,
    listPrice: 99,
    days: 30,
  },
};

export const AUTOAPPLY_PASS = 'autoapply';

// Session credits per plan per purchase
export const CREDITS_PER_MONTH = {
  clarity: 1,
  pro: 3,
};

export const SUBSCRIPTION_RECEIPT_PREFIX = 'sub_';

// Paying again while a plan is still running extends it instead of throwing
// away the days already paid for.
function calculateExpiry(billing, currentExpiry) {
  const base = currentExpiry && new Date(currentExpiry) > new Date() ? new Date(currentExpiry) : new Date();
  if (billing === 'yearly') base.setFullYear(base.getFullYear() + 1);
  else base.setMonth(base.getMonth() + 1);
  return base;
}

// The plan/billing/user a payment is for come from OUR order (set server-side
// at /create), never from the browser — otherwise a ₹299 payment could be
// verified as "pro yearly".
export async function fetchSubscriptionOrder(orderId) {
  const order = await razorpay.orders.fetch(orderId);
  const { userId, plan, billing } = order.notes || {};
  if (!String(order.receipt || '').startsWith(SUBSCRIPTION_RECEIPT_PREFIX)) return null;
  if (!userId || !PRICING[plan] || !['monthly', 'yearly'].includes(billing)) return null;
  if (plan === AUTOAPPLY_PASS && billing !== 'monthly') return null;
  return { order, userId: String(userId), plan, billing };
}

// Extends the pass from its current expiry when still running, same as plans.
async function activateAutoApplyPass({ userId, orderId, source }) {
  const current = await User.findById(userId).select('autoApply.passExpiry');
  if (!current) return { user: null, activated: false };

  const running = current.autoApply?.passExpiry && new Date(current.autoApply.passExpiry) > new Date();
  const expiry = new Date(running ? current.autoApply.passExpiry : Date.now());
  expiry.setDate(expiry.getDate() + PRICING[AUTOAPPLY_PASS].days);

  const user = await User.findOneAndUpdate(
    { _id: userId, processedSubscriptionOrders: { $ne: orderId } },
    { $set: { 'autoApply.passExpiry': expiry }, $addToSet: { processedSubscriptionOrders: orderId } },
    { new: true },
  );
  if (!user) return { user: await User.findById(userId), activated: false };

  trackEvent(user._id, 'purchase', { kind: 'subscription', plan: 'Auto-Apply', refId: orderId });
  logFunnel('purchase', { userId: user._id, props: { kind: 'autoapply_pass', plan: AUTOAPPLY_PASS, refId: orderId, source } });
  return { user, activated: true };
}

// Idempotent: the same order activates a plan exactly once, however many
// times verify/webhook run (atomic $ne guard on processedSubscriptionOrders).
export async function activateSubscription({ userId, plan, billing, orderId, source }) {
  if (plan === AUTOAPPLY_PASS) return activateAutoApplyPass({ userId, orderId, source });

  const current = await User.findById(userId).select('subscriptionExpiry subscriptionPlan subscriptionStatus');
  if (!current) return { user: null, activated: false };

  const keepRunning = current.subscriptionStatus === 'active' || current.subscriptionStatus === 'cancelled';
  const expiry = calculateExpiry(billing, keepRunning ? current.subscriptionExpiry : null);
  const user = await User.findOneAndUpdate(
    { _id: userId, processedSubscriptionOrders: { $ne: orderId } },
    {
      $set: {
        subscriptionPlan: plan,
        subscriptionStatus: 'active',
        subscriptionExpiry: expiry,
        razorpaySubscriptionId: orderId,
      },
      $inc: { subscriptionCredits: CREDITS_PER_MONTH[plan] },
      $addToSet: { processedSubscriptionOrders: orderId },
    },
    { new: true },
  );

  if (!user) {
    // Already activated by the other path (verify vs webhook) — report current state.
    return { user: await User.findById(userId), activated: false };
  }

  trackEvent(user._id, 'purchase', { kind: 'subscription', plan, refId: orderId });
  logFunnel('purchase', { userId: user._id, props: { kind: 'subscription', plan, refId: orderId, source } });
  return { user, activated: true };
}

export const subscriptionSummary = (user) => ({
  plan: user.subscriptionPlan,
  status: user.subscriptionStatus,
  expiry: user.subscriptionExpiry,
  credits: user.subscriptionCredits,
  autoApplyPassExpiry: user.autoApply?.passExpiry || null,
});
