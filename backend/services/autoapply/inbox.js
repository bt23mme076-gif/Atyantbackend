import crypto from 'crypto';
import User from '../../models/User.js';
import InboundEmail from '../../models/InboundEmail.js';

// Each student applies with their own alias on a receiving-only domain, so the
// robot can read Greenhouse's emailed security code and Atyant can forward
// employer replies. Off until APPLY_INBOX_DOMAIN is set (the domain's MX record
// and the Resend inbound webhook must be live first) — then the real email is used.
const domain = () => (process.env.APPLY_INBOX_DOMAIN || '').trim().toLowerCase();

export const inboxEnabled = () => !!domain();

const slug = (s = '') => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 20) || 'student';

/** Address to put on application forms: the student's alias when enabled, else their real email. */
export async function applyEmailFor(user) {
  if (!inboxEnabled()) return user.email || '';
  if (user.autoApply?.inboxAlias) return user.autoApply.inboxAlias;

  for (let i = 0; i < 5; i++) {
    const alias = `${slug(user.name)}.${crypto.randomBytes(3).toString('hex')}@${domain()}`;
    try {
      const res = await User.updateOne(
        { _id: user._id, 'autoApply.inboxAlias': { $in: [null, ''] } },
        { $set: { 'autoApply.inboxAlias': alias } },
      );
      if (res.modifiedCount) return alias;
      const fresh = await User.findById(user._id).select('autoApply.inboxAlias').lean();
      if (fresh?.autoApply?.inboxAlias) return fresh.autoApply.inboxAlias;
    } catch (err) {
      if (err.code !== 11000) throw err; // alias collision — try another suffix
    }
  }
  return user.email || '';
}

// Greenhouse sends HTML only (no text part): "...field on your application: </p> <h1>N6VeJ9qG</h1>".
export function htmlToText(html = '') {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Copy and paste this code into the security code field on your application:  N6VeJ9qG"
export function extractSecurityCode(text = '') {
  const m = /security code field[^:]*:\s*([A-Za-z0-9]{6,12})\b/i.exec(text)
    || /(?:security|verification) code[^A-Za-z0-9]{1,12}([A-Za-z0-9]{6,12})\b/i.exec(text);
  return m ? m[1] : '';
}

/** Waits for a security-code email newer than `since` on this alias. Returns '' on timeout. */
export async function waitForSecurityCode(alias, since, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await InboundEmail.findOne({ alias: alias.toLowerCase(), code: { $ne: '' }, receivedAt: { $gte: since } })
      .sort({ receivedAt: -1 }).lean();
    if (msg) return msg.code;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return '';
}
