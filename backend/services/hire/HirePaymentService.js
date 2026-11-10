// Atyant Hire credits: ₹49 per completed interview, bought in packs through
// Razorpay (order → checkout → verify, with the shared webhook as a safety net).
import crypto from 'crypto';
import Razorpay from 'razorpay';
import HireCompany from '../../models/HireCompany.js';

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = (RZP_KEY_ID && RZP_KEY_SECRET) ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET }) : null;

export const HIRE_PRICE_INR = Number(process.env.HIRE_INTERVIEW_PRICE_INR) || 49;
export const MIN_PACK = 10;
export const MAX_PACK = 1000;

export class HirePaymentError extends Error {
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

export async function createCreditOrder(company, quantity) {
  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < MIN_PACK || qty > MAX_PACK) {
    throw new HirePaymentError(400, `Buy between ${MIN_PACK} and ${MAX_PACK} interviews at a time.`);
  }
  if (!razorpay) throw new HirePaymentError(503, 'Payments not configured');

  const amount = qty * HIRE_PRICE_INR;
  const order = await razorpay.orders.create({
    amount  : amount * 100,
    currency: 'INR',
    receipt : `hire_${company._id}_${Date.now()}`.slice(0, 40),
    notes   : { kind: 'hire_credits', companyId: String(company._id), quantity: String(qty) }
  });
  await HireCompany.updateOne({ _id: company._id }, {
    $push: { orders: { orderId: order.id, quantity: qty, amount, status: 'created', createdAt: new Date() } }
  });
  return {
    keyId: RZP_KEY_ID, orderId: order.id, amount: amount * 100, currency: 'INR',
    description: `Atyant Hire: ${qty} AI interviews`
  };
}

// Idempotent: /verify and the webhook may both confirm the same order.
async function confirmOrder(orderId, paymentId) {
  const company = await HireCompany.findOne({ 'orders.orderId': orderId }).select('orders').lean();
  if (!company) return false;
  const order = company.orders.find(o => o.orderId === orderId);
  if (order.status === 'paid') return true;

  const payment = await razorpay.payments.fetch(paymentId);
  if (payment.status !== 'captured') throw new HirePaymentError(400, `Payment not captured (status: ${payment.status})`);
  if (payment.order_id !== orderId || payment.amount !== order.amount * 100) {
    throw new HirePaymentError(400, 'Payment does not match this order');
  }
  // Only the request that flips created → paid adds the credits.
  await HireCompany.updateOne(
    { _id: company._id, orders: { $elemMatch: { orderId, status: 'created' } } },
    {
      $set: { 'orders.$.status': 'paid', 'orders.$.paymentId': paymentId, 'orders.$.paidAt': new Date() },
      $inc: { 'credits.purchased': order.quantity }
    }
  );
  return true;
}

export async function verifyCreditOrder(company, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new HirePaymentError(400, 'Missing payment verification fields');
  }
  if (!company.orders.some(o => o.orderId === razorpay_order_id)) throw new HirePaymentError(404, 'Order not found');
  if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    throw new HirePaymentError(400, 'Payment signature verification failed');
  }
  return confirmOrder(razorpay_order_id, razorpay_payment_id);
}

// Shared Razorpay webhook. Returns false when the order isn't a credit pack.
export const confirmHireFromWebhook = (orderId, paymentId) => (razorpay ? confirmOrder(orderId, paymentId) : false);
