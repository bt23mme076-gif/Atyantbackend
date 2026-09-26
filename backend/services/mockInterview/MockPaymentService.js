// Mock interview payments (Razorpay: order → checkout → verify, with the shared
// /api/payments/webhook as a safety net). Prices are server-side only.
//
//   Starting an interview costs ₹99. A student's FIRST interview includes the
//   full report free. From the second interview on, ₹99 buys the interview
//   with a score preview, or ₹149 buys it together with the full report (the
//   report can also be added later for ₹49, any time after the interview ends).
//   Accounts on the free list (MOCK_FREE_EMAILS) pay nothing.
//
// Two independent orders per interview, tracked separately:
//   entryPayment  the ₹99 / ₹149 needed before the interview can start
//   payment       the ₹49 report add-on
import crypto from 'crypto';
import Razorpay from 'razorpay';
import MockInterview from '../../models/MockInterview.js';
import User from '../../models/User.js';

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET)
  ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
  : null;

export const INTERVIEW_PRICE_INR = Number(process.env.MOCK_INTERVIEW_PRICE_INR) || 99;
export const BUNDLE_PRICE_INR    = Number(process.env.MOCK_BUNDLE_PRICE_INR) || 149;
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

// A student's first interview is the first one they have paid to start.
async function isFirstInterview(userId, interviewId) {
  return !(await MockInterview.exists({ userId, _id: { $ne: interviewId }, 'entryPayment.status': 'paid' }));
}

// Prices and what is already paid, for the interview page.
export async function getPricing(interview) {
  const [first, free] = await Promise.all([isFirstInterview(interview.userId, interview._id), isFreeUser(interview.userId)]);
  return {
    entryPaid : isEntryPaid(interview),
    free,
    first,
    interview : INTERVIEW_PRICE_INR,
    includesReport: first,                        // first interview: full report included free
    bundle    : first ? null : BUNDLE_PRICE_INR,  // later: ₹149 for interview + report
    report    : REPORT_PRICE_INR,                 // report add-on after a ₹99 interview
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
  if (!interview || interview.userId.toString() !== String(userId)) throw new PaymentError(404, 'Interview not found');
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
    { $set: { [path]: { orderId: order.id, amount, status: 'created', paymentId: null, paidAt: null, ...extra } } }
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

// ── ₹99 / ₹149 to start the interview ────────────────────────────────────────

export async function createEntryOrder(interviewId, userId, { bundle = false } = {}) {
  const interview = await loadOwned(interviewId, userId, 'userId status entryPayment access company role attempt');
  if (isEntryPaid(interview)) return { paid: true };
  if (interview.status === 'planned' && await isFreeUser(interview.userId)) {
    await waiveEntry(interview._id);
    return { paid: true, free: true };
  }
  if (interview.status !== 'planned') {
    throw new PaymentError(409, interview.status === 'live'
      ? 'This interview is already running.'
      : 'Your interview is still being prepared. You can pay once it is ready.');
  }
  if (!razorpay) throw new PaymentError(503, 'Payments not configured');

  // First interview: ₹99 with the report included, so there is nothing to choose.
  // Later: ₹99 (interview) or ₹149 (interview + report).
  const first = await isFirstInterview(interview.userId, interview._id);
  const reportIncluded = first || !!bundle;
  const amount = first || !bundle ? INTERVIEW_PRICE_INR : BUNDLE_PRICE_INR;
  const orderId = await ensureOrder(interview, 'entryPayment', amount, { reportIncluded }, 'mockint',
    { kind: 'mock_interview_entry', reportIncluded: String(reportIncluded) });

  return {
    paid: false,
    reportIncluded,
    ...checkoutPayload(orderId, amount,
      `Mock interview: ${label(interview)}${reportIncluded ? ' + full report' : ''}`)
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
  // The first interview and the ₹149 bundle include the full report.
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
