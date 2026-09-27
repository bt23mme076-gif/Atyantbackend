import express from 'express';
import User from '../models/User.js';
import EmailJob from '../models/EmailJob.js';
import protect from '../middleware/authMiddleware.js';
import { trackEvent, verifyUnsubscribeToken } from '../services/email/EmailPipeline.js';
import { INTENT_PAGES } from '../services/email/flows.js';

const router = express.Router();

// POST /api/email/track  { page: 'pricing' | 'mentor_profile' | 'mock_interview' | 'auto_apply', label? }
// Frontend beacon for logged-in page views that should start the intent flow.
router.post('/track', protect, (req, res) => {
  const { page, label } = req.body || {};
  if (!INTENT_PAGES.has(page)) return res.status(400).json({ ok: false, error: 'Unknown page' });
  trackEvent(req.user.userId, 'page_view', {
    page,
    label: typeof label === 'string' ? label.slice(0, 120) : undefined,
  });
  res.json({ ok: true });
});

async function unsubscribe(token) {
  const userId = verifyUnsubscribeToken(token);
  await User.updateOne({ _id: userId }, {
    $set: { 'emailPrefs.marketing': false, 'emailPrefs.unsubscribedAt': new Date() },
  });
  await EmailJob.updateMany({ userId, status: 'pending' }, { $set: { status: 'cancelled', reason: 'unsubscribed' } });
}

const page = (msg) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atyant</title></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;">
<div style="max-width:420px;background:#fff;padding:32px;border-radius:10px;border-left:4px solid #4F46E5;text-align:center;">
<h2 style="color:#4F46E5;margin-top:0;">Atyant</h2><p style="color:#4b5563;line-height:1.6;">${msg}</p></div></body></html>`;

// GET — link in the email footer.
router.get('/unsubscribe', async (req, res) => {
  try {
    await unsubscribe(String(req.query.token || ''));
    res.send(page('You\'re unsubscribed from Atyant tips and reminders. You\'ll still get receipts, OTPs and session reminders.'));
  } catch {
    res.status(400).send(page('This unsubscribe link is invalid. Reply to any of our emails and we\'ll remove you manually.'));
  }
});

// POST — RFC 8058 one-click unsubscribe (Gmail / Yahoo "Unsubscribe" button).
router.post('/unsubscribe', async (req, res) => {
  try {
    await unsubscribe(String(req.query.token || ''));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ ok: false });
  }
});

export default router;
