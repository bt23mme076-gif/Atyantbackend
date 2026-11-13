// Mock interview payments (Razorpay: order → checkout → verify, with the shared
// /api/payments/webhook as a safety net). Prices are server-side only.
//
//   Every interview is ₹10: 15 minutes, full report included.
//   Accounts on the free list (MOCK_FREE_EMAILS) pay nothing.
//
// Two independent orders per interview, tracked separately:
//   entryPayment  the ₹10 needed before the interview can start
//   payment       the ₹49 report add-on (only for older interviews bought
//                 without the report)
import crypto from 'crypto';
import Razorpay from 'razorpay';
import MockInterview from '../../models/MockInterview.js';
import User from '../../models/User.js';

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET)
  ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
  : null;

export const INTERVIEW_PRICE_INR = Number(process.env.MOCK_INTERVIEW_PRICE_INR) || 10;
export const REPORT_PRICE_INR    = Number(process.env.MOCK_REPORT_PRICE_INR) || 49;

// The report add-on can be bought once the interview itself is over.
const REPORT_BUYABLE_STATUSES = ['evaluating', 'completed'];

// Accounts that never pay (founders, partner colleges, testers). Comma-separated emails.
const FREE_EMAILS = new Set(
  (process.env.MOCK_FREE_EMAILS ?? 'bt23mme076@students.vnit.ac.in')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

export async function isFreeUser(userId) {
  if (!FREE_EMAILS.size) return false;
  const user = await User.findById(userId).select('email').lean();
  return !!user?.email && FREE_EMAILS.has(user.email.toLowerCase());
}

export const isUnlocked  = interview => ['free_trial', 'paid'].includes(interview.access?.plan);
export const isEntryPaid = interview => interview.entryPayment?.status === 'paid';

// Test seam: Razorpay test mode can't create a captured payment without a real
// checkout, so tests swap this to simulate one.
let fetchPayment = paymentId => razorpay.payments.fetch(paymentId);
export const __testing = { setFetchPayment: fn => { fetchPayment = fn; } };

class PaymentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function verifySignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex'));
  } catch {
    return false;
  }
}

// Prices and what is already paid, for the interview page.
export async function getPricing(interview) {
  return {
    entryPaid : isEntryPaid(interview),
    free      : await isFreeUser(interview.userId),
    interview : INTERVIEW_PRICE_INR,
    durationMin: 15,
    includesReport: true,                         // every interview includes the full report
    bundle    : null,
    report    : REPORT_PRICE_INR,                 // add-on, only for older interviews without the report
    reportUnlocked: isUnlocked(interview)
  };
}

// Free accounts: the interview starts and the report opens without any payment.
async function waiveEntry(interviewId) {
  const now = new Date();
  await MockInterview.updateOne(
    { _id: interviewId, 'entryPayment.status': { $ne: 'paid' } },
    { $set: {
      entryPayment: { orderId: null, paymentId: null, amount: 0, status: 'paid', reportIncluded: true, waived: true, paidAt: now },
      'access.plan': 'paid', 'access.unlockedAt': now
    } }
  );
}

export async function grantFreeReport(interviewId) {
  await MockInterview.updateOne({ _id: interviewId, 'access.plan': { $nin: ['paid', 'free_trial'] } },
    { $set: { 'access.plan': 'paid', 'access.unlockedAt': new Date() } });
}

async function loadOwned(interviewId, userId, fields) {
  const interview = await MockInterview.findById(interviewId).select(fields).lean();
  if (!interview || interview.userId?.toString() !== String(userId)) throw new PaymentError(404, 'Interview not found');
  return interview;
}

// Creates (or reuses) a Razorpay order stored under `path` ('entryPayment' or 'payment').
async function ensureOrder(interview, path, amount, extra, receiptTag, notes) {
  const existing = interview[path];
  const reusable = existing?.status === 'created' && existing.amount === amount
    && Object.entries(extra).every(([k, v]) => existing[k] === v);
  if (reusable) return existing.orderId;

  const order = await razorpay.orders.create({
    amount  : amount * 100,
    currency: 'INR',
    receipt : `${receiptTag}_${interview._id}_${Date.now()}`.slice(0, 40),
    notes   : { interviewId: String(interview._id), userId: String(interview.userId), ...notes }
  });
  await MockInterview.updateOne(
    { _id: interview._id },
    { $set: { [path]: { orderId: order.id, amount, status: 'created', paymentId: null, paidAt: null, createdAt: new Date(), ...extra } } }
  );
  return order.id;
}

const checkoutPayload = (orderId, amount, description) => ({
  keyId   : RZP_KEY_ID,
  orderId,
  amount  : amount * 100, // paise, as Razorpay checkout expects
  currency: 'INR',
  description
});

const label = interview => [interview.role, interview.company].filter(Boolean).join(' at ') || 'mock interview';

// ── ₹10 to start the interview ───────────────────────────────────────────────

export async function createEntryOrder(interviewId, userId) {
  const interview = await loadOwned(interviewId, userId, 'userId status entryPayment access company role attempt');
  if (isEntryPaid(interview)) return { paid: true };
  // Payable once the plan exists; the audio may still be recording.
  const prepared = ['planned', 'voicing', 'ready'].includes(interview.status);
  if (prepared && await isFreeUser(interview.userId)) {
    await waiveEntry(interview._id);
    return { paid: true, free: true };
  }
  if (!prepared) {
    throw new PaymentError(409, interview.status === 'live'
      ? 'This interview is already running.'
      : 'Your interview is still being prepared. You can pay once it is ready.');
  }
  if (!razorpay) throw new PaymentError(503, 'Payments not configured');

  // One price, one plan: ₹10 for a 15-minute interview with the full report.
  // `starter` tells the interview agent to run the 15-minute clock.
  const amount = INTERVIEW_PRICE_INR;
  const orderId = await ensureOrder(interview, 'entryPayment', amount, { reportIncluded: true, starter: true }, 'mockint',
    { kind: 'mock_interview_entry', reportIncluded: 'true' });

  return {
    paid: false,
    reportIncluded: true,
    ...checkoutPayload(orderId, amount, `Mock interview: ${label(interview)} + full report`)
  };
}

// ── ₹49 full report ──────────────────────────────────────────────────────────

// Returns checkout details, or { unlocked: true } if nothing needs paying.
export async function createUnlockOrder(interviewId, userId) {
  const interview = await loadOwned(interviewId, userId, 'userId status parentInterviewId attempt company role access payment entryPayment');
  if (isUnlocked(interview)) return { unlocked: true };
  if (await isFreeUser(interview.userId)) {
    await grantFreeReport(interview._id);
    return { unlocked: true, free: true };
  }
  if (!REPORT_BUYABLE_STATUSES.includes(interview.status)) {
    throw new PaymentError(409, 'You can unlock the report once the interview is finished.');
  }
  if (!razorpay) throw new PaymentError(503, 'Payments not configured');

  const orderId = await ensureOrder(interview, 'payment', REPORT_PRICE_INR, {}, 'mockrep', { kind: 'mock_interview_report' });
  return {
    unlocked: false,
    ...checkoutPayload(orderId, REPORT_PRICE_INR,
      `Interview report: ${label(interview)}${interview.attempt > 1 ? ` (attempt ${interview.attempt})` : ''}`)
  };
}

// ── Confirmation (shared by /verify and the webhook) ─────────────────────────

// Marks an order paid once Razorpay confirms a captured payment of exactly the
// expected order and amount. Idempotent: /verify and the webhook can both call it.
async function confirmOrder(kind, interview, paymentId) {
  const path = kind === 'entry' ? 'entryPayment' : 'payment';
  const record = interview[path];
  if (record?.status === 'paid') return true;

  const payment = await fetchPayment(paymentId);
  if (payment.status !== 'captured') throw new PaymentError(400, `Payment not captured (status: ${payment.status})`);
  if (payment.order_id !== record.orderId || payment.amount !== record.amount * 100) {
    throw new PaymentError(400, 'Payment does not match this order');
  }

  const now = new Date();
  const set = {
    [`${path}.status`]   : 'paid',
    [`${path}.paymentId`]: paymentId,
    [`${path}.paidAt`]   : now
  };
  // Entry orders include the full report (older ones only when the bundle was bought).
  if ((kind === 'report' || record.reportIncluded) && !isUnlocked(interview)) {
    set['access.plan'] = 'paid';
    set['access.unlockedAt'] = now;
  }
  await MockInterview.updateOne({ _id: interview._id, [`${path}.orderId`]: record.orderId }, { $set: set });
  return true;
}

async function verify(kind, interviewId, userId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new PaymentError(400, 'Missing payment verification fields');
  }
  const path = kind === 'entry' ? 'entryPayment' : 'payment';
  const interview = await MockInterview.findOne({ _id: interviewId, userId, [`${path}.orderId`]: razorpay_order_id })
    .select('entryPayment payment access')
    .lean();
  if (!interview) throw new PaymentError(404, 'Order not found');
  if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    throw new PaymentError(400, 'Payment signature verification failed');
  }
  return confirmOrder(kind, interview, razorpay_payment_id);
}

export const verifyEntryPayment  = (interviewId, userId, body) => verify('entry', interviewId, userId, body);
export const verifyUnlockPayment = (interviewId, userId, body) => verify('report', interviewId, userId, body);

// Called from the shared Razorpay webhook for orders that aren't mentor
// sessions. Returns false when the order isn't a mock interview's.
export async function confirmFromWebhook(orderId, paymentId) {
  const entry = await MockInterview.findOne({ 'entryPayment.orderId': orderId }).select('entryPayment payment access').lean();
  if (entry) { await confirmOrder('entry', entry, paymentId); return true; }
  const report = await MockInterview.findOne({ 'payment.orderId': orderId }).select('entryPayment payment access').lean();
  if (report) { await confirmOrder('report', report, paymentId); return true; }
  return false;
}

export { PaymentError };
