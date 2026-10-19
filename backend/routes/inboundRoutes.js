import express from 'express';
import crypto from 'crypto';
import { Resend } from 'resend';
import User from '../models/User.js';
import InboundEmail from '../models/InboundEmail.js';
import { extractSecurityCode, htmlToText } from '../services/autoapply/inbox.js';
import { esc } from '../services/email/layout.js';

const router = express.Router();

// Resend signs webhooks with Svix: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`,
// keyed with the base64 part of the whsec_ secret.
function verifySignature(req, raw) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) return false; // fail closed
  const id = req.get('svix-id');
  const ts = req.get('svix-timestamp');
  const sigHeader = req.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  return sigHeader.split(' ').some((part) => {
    const sig = Buffer.from(part.split(',')[1] || '', 'base64');
    return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  });
}

const bareAddress = (s = '') => (/<([^>]+)>/.exec(s)?.[1] || s).trim().toLowerCase();

async function fetchReceived(id) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${id}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Resend receiving API ${r.status}`);
  return r.json();
}

async function handleReceived(data) {
  const domain = (process.env.APPLY_INBOX_DOMAIN || '').toLowerCase();
  const recipients = [...(data.to || []), ...(data.received_for || [])].map(bareAddress);
  const alias = recipients.find((a) => domain && a.endsWith(`@${domain}`));
  if (!alias) return;
  if (await InboundEmail.exists({ resendId: data.email_id })) return; // webhook retry

  const user = await User.findOne({ 'autoApply.inboxAlias': alias }).select('name email').lean();
  if (!user) return;

  const mail = await fetchReceived(data.email_id);
  const body = mail.text || '';
  const code = /security code/i.test(mail.subject || '') ? extractSecurityCode(body || htmlToText(mail.html)) : '';

  const record = await InboundEmail.create({
    resendId: data.email_id, alias, user: user._id,
    from: mail.from || data.from || '', subject: mail.subject || '', code,
  });

  if (code || !user.email) return; // codes are for the robot only

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: 'Atyant <notifications@atyant.in>',
    to: [user.email],
    replyTo: bareAddress(mail.reply_to?.[0] || mail.from || data.from),
    subject: `Fwd: ${mail.subject || '(no subject)'}`,
    html: `<p style="font:13px Arial;color:#5A5470;margin:0 0 12px;">Forwarded by Atyant from <b>${esc(mail.from || '')}</b>, sent to your application address. Reply goes straight to them.</p>${mail.html || `<pre>${esc(body)}</pre>`}`,
    text: `Forwarded by Atyant from ${mail.from}\n\n${body}`,
  });
  if (error) throw new Error(`forward failed: ${error.message}`);
  await InboundEmail.updateOne({ _id: record._id }, { $set: { forwarded: true } });
}

// POST /api/email/inbound — Resend `email.received` webhook (raw body for signature check).
router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body?.toString('utf8') || '';
  if (!verifySignature(req, raw)) return res.status(401).json({ ok: false });

  try {
    const event = JSON.parse(raw);
    if (event.type === 'email.received') await handleReceived(event.data || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('📥 inbound email error:', err.message);
    res.status(500).json({ ok: false }); // Resend retries
  }
});

export default router;
