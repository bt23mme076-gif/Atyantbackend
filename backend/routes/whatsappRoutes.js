import express from 'express';
import crypto from 'crypto';
import { handleInbound } from '../services/whatsapp/WhatsAppAgent.js';

const router = express.Router();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Meta signs with the app secret (X-Hub-Signature-256). If a BSP forwards
// without Meta's signature, set WA_WEBHOOK_KEY and append ?key=… to the URL.
function authorized(req) {
  const appSecret = process.env.WA_APP_SECRET;
  if (appSecret) {
    const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(req.body).digest('hex')}`;
    return safeEqual(expected, req.headers['x-hub-signature-256']);
  }
  const key = process.env.WA_WEBHOOK_KEY;
  return !!key && safeEqual(key, req.query.key);
}

// GET /api/whatsapp/health — which settings are present (true/false only, never values)
router.get('/health', (req, res) => {
  const has = (k) => !!process.env[k];
  const sending = has('WA_PHONE_NUMBER_ID') && has('WA_ACCESS_TOKEN');
  const receiving = has('WA_VERIFY_TOKEN') && (has('WA_APP_SECRET') || has('WA_WEBHOOK_KEY'));
  res.json({
    ok: sending && receiving && has('RAZORPAY_KEY_ID') && has('RAZORPAY_WEBHOOK_SECRET'),
    sending, receiving,
    signature: has('WA_APP_SECRET') ? 'meta' : has('WA_WEBHOOK_KEY') ? 'url_key' : 'none',
    apiBase: has('WA_API_BASE') ? 'custom' : 'meta_graph',
    payments: has('RAZORPAY_KEY_ID') && has('RAZORPAY_KEY_SECRET'),
    paymentWebhook: has('RAZORPAY_WEBHOOK_SECRET'),
  });
});

// GET /api/whatsapp/webhook — Meta's one-time subscription handshake
router.get('/webhook', (req, res) => {
  const token = process.env.WA_VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && token && safeEqual(token, req.query['hub.verify_token'])) {
    return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

// POST /api/whatsapp/webhook — inbound messages (raw body for the signature)
router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !authorized(req)) return res.sendStatus(401);

  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }

  // Ack immediately: WhatsApp retries if we take too long. Dedupe happens per message id.
  res.sendStatus(200);

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = new Map((v.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const msg of v.messages || []) {
        handleInbound(msg, names.get(msg.from)).catch(err => console.error('WA inbound error:', err));
      }
    }
  }
});

export default router;
