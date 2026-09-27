import cron from 'node-cron';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import EmailJob from '../../models/EmailJob.js';
import User from '../../models/User.js';
import Session from '../../models/Session.js';
import {
  FLOWS, CANCELS, FLOW_FOR_EVENT,
  CAP_PER_DAY, CAP_PER_WEEK, QUIET_START_IST, QUIET_END_IST,
} from './flows.js';
import { TEMPLATES, renderEmail } from './templates.js';

const H = 60 * 60 * 1000;
const D = 24 * H;
const IST_OFFSET = 5.5 * H;
const BATCH = 200;

let _resend = null;
function getResend() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) return null;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

// ─────────────────────────────────────────────────────────────
//  Tracking — call from routes. Never throws, never blocks the request.
// ─────────────────────────────────────────────────────────────
export function trackEvent(userId, event, data = {}) {
  if (!userId) return; // anonymous visitors can't be emailed
  enqueue(String(userId), event, data)
    .catch(err => console.error(`📧 trackEvent(${event}) failed:`, err.message));
}

async function enqueue(userId, event, data) {
  // 1) Cancel flows this event makes pointless.
  for (const target of CANCELS[event] || []) {
    const [flow, step] = target.split(':');
    await EmailJob.updateMany(
      { userId, flow, ...(step && { step }), status: 'pending' },
      { $set: { status: 'cancelled', reason: `event:${event}` } }
    );
  }

  const flowName = FLOW_FOR_EVENT[event];
  if (!flowName) return;
  const flow = FLOWS[flowName];

  const user = await User.findById(userId).select('role emailPrefs').lean();
  if (!user || user.role === 'mentor' || user.emailPrefs?.marketing === false) return;

  // 2) Latest intent wins: refresh data on an already-running flow instead of restarting it.
  if (flow.cooldownDays > 0) {
    const refreshed = await EmailJob.updateMany(
      { userId, flow: flowName, status: 'pending' },
      { $set: { data } }
    );
    if (refreshed.matchedCount > 0) return;

    const recent = await EmailJob.exists({
      userId, flow: flowName, createdAt: { $gte: new Date(Date.now() - flow.cooldownDays * D) },
    });
    if (recent) return;
  }

  // 3) Schedule every step. The bucket in the dedupe key guards against double-enrolling on races.
  const anchor = anchorFor(flowName, data);
  const bucket = flow.cooldownDays > 0
    ? Math.floor(Date.now() / (flow.cooldownDays * D))
    : (data.refId || Date.now());
  const docs = flow.steps.map(s => ({
    userId, flow: flowName, step: s.step, priority: s.priority,
    sendAt: new Date(anchor + s.delay), data,
    dedupeKey: `${userId}:${flowName}:${s.step}:${bucket}`,
  }));
  await EmailJob.insertMany(docs, { ordered: false }).catch(err => {
    if (err.code !== 11000 && !err.writeErrors?.every(e => e.code === 11000)) throw err;
  });
}

// Session follow-ups are timed from when the session ends, not from payment.
function anchorFor(flowName, data) {
  if (flowName === 'purchase' && data.kind === 'session' && data.scheduledAt) {
    return new Date(data.scheduledAt).getTime() + (data.durationMin || 60) * 60 * 1000;
  }
  return Date.now();
}

// ─────────────────────────────────────────────────────────────
//  Unsubscribe tokens (no expiry — links in old emails must keep working)
// ─────────────────────────────────────────────────────────────
export const unsubscribeToken = (userId) =>
  jwt.sign({ u: String(userId), p: 'unsub' }, process.env.JWT_SECRET);

export function verifyUnsubscribeToken(token) {
  const d = jwt.verify(token, process.env.JWT_SECRET);
  if (d.p !== 'unsub') throw new Error('bad token');
  return d.u;
}

function unsubscribeUrl(userId) {
  const base = (process.env.BACKEND_URL || process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return `${base}/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`;
}

// ─────────────────────────────────────────────────────────────
//  Sender — every 5 minutes
// ─────────────────────────────────────────────────────────────
function inQuietHours(now = Date.now()) {
  const h = new Date(now + IST_OFFSET).getUTCHours();
  return h >= QUIET_START_IST || h < QUIET_END_IST;
}

// Next 09:00 IST (+ a few minutes of jitter so we don't burst Resend).
function nextSendWindow(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET);
  ist.setUTCHours(QUIET_END_IST, Math.floor(Math.random() * 30), 0, 0);
  let t = ist.getTime() - IST_OFFSET;
  if (t <= now) t += D;
  return new Date(t);
}

async function hasPurchased(user) {
  if (user.subscriptionStatus === 'active') return true;
  return !!(await Session.exists({ userId: user._id, paymentStatus: 'paid' }));
}

class EmailPipeline {
  start() {
    cron.schedule('*/5 * * * *', () => this.run());
    console.log('✅ Email pipeline cron started');
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      if (inQuietHours()) return;
      if (!getResend()) return;

      const due = await EmailJob.find({ status: 'pending', sendAt: { $lte: new Date() } })
        .sort({ sendAt: 1 }).limit(BATCH).lean();
      if (!due.length) return;

      // Merge: one email per user per run.
      const byUser = new Map();
      for (const j of due) {
        const k = String(j.userId);
        if (!byUser.has(k)) byUser.set(k, []);
        byUser.get(k).push(j);
      }

      let sent = 0;
      for (const [userId, jobs] of byUser) {
        if (await this.sendForUser(userId, jobs)) sent++;
      }
      console.log(`📧 Email pipeline: ${due.length} due jobs → ${sent} emails`);
    } catch (err) {
      console.error('📧 Email pipeline error:', err);
    } finally {
      this.running = false;
    }
  }

  async sendForUser(userId, jobs) {
    const ids = jobs.map(j => j._id);
    const cancel = (jobIds, reason) => EmailJob.updateMany(
      { _id: { $in: jobIds } }, { $set: { status: 'cancelled', reason } }
    );

    const user = await User.findById(userId)
      .select('email name username role emailPrefs subscriptionStatus isVerified').lean();
    if (!user?.email) return cancel(ids, 'no_user').then(() => false);
    if (user.emailPrefs?.marketing === false) return cancel(ids, 'unsubscribed').then(() => false);

    // Drop sales steps for people who already paid.
    const salesIds = jobs.filter(j => FLOWS[j.flow]?.steps.find(s => s.step === j.step)?.stopIfPurchased).map(j => j._id);
    if (salesIds.length && await hasPurchased(user)) {
      await cancel(salesIds, 'purchased');
      jobs = jobs.filter(j => !salesIds.some(id => id.equals(j._id)));
      if (!jobs.length) return false;
    }

    // Frequency cap: defer the whole bundle rather than drop it.
    const now = Date.now();
    const recent = await EmailJob.distinct('messageId', {
      userId, status: 'sent', sentAt: { $gte: new Date(now - 7 * D) },
    });
    const sentToday = await EmailJob.distinct('messageId', {
      userId, status: 'sent', sentAt: { $gte: new Date(now - D) },
    });
    if (sentToday.length >= CAP_PER_DAY || recent.length >= CAP_PER_WEEK) {
      const lastSend = await EmailJob.findOne({ userId, status: 'sent' }).sort({ sentAt: -1 }).select('sentAt').lean();
      const earliest = Math.max(now + H, (lastSend?.sentAt?.getTime() || now) + D);
      const retryAt = inQuietHours(earliest) ? nextSendWindow(earliest) : new Date(earliest);
      await EmailJob.updateMany({ _id: { $in: jobs.map(j => j._id) } }, { $set: { sendAt: retryAt } });
      return false;
    }

    // Highest-priority job is the email; the rest ride along as "Also for you".
    jobs.sort((a, b) => b.priority - a.priority);
    const name = (user.name || user.username || 'there').split(' ')[0];
    const rendered = jobs.map(j => ({ job: j, t: TEMPLATES[j.step]?.({ name, data: j.data || {} }) }))
      .filter(r => r.t);
    if (!rendered.length) return cancel(jobs.map(j => j._id), 'no_template').then(() => false);

    const [primary, ...rest] = rendered;
    const teasers = rest.map(r => r.t.teaser && { ...r.t.teaser, url: r.t.cta.url });
    // Steps without a teaser (personal notes) stay pending for their own send.
    const merged = [primary, ...rest.filter(r => r.t.teaser)];
    const unsub = unsubscribeUrl(userId);

    const mergedIds = merged.map(r => r.job._id);
    try {
      const { data, error } = await getResend().emails.send({
        from: 'Atyant <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [user.email],
        subject: primary.t.subject,
        html: renderEmail(primary.t, teasers, unsub),
        headers: {
          'List-Unsubscribe': `<${unsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: [{ name: 'flow', value: primary.job.flow }, { name: 'step', value: primary.job.step }],
      });
      if (error) throw new Error(error.message || JSON.stringify(error));

      await EmailJob.updateMany(
        { _id: { $in: mergedIds } },
        { $set: { status: 'sent', sentAt: new Date(), messageId: data?.id || `local-${Date.now()}` } }
      );
      return true;
    } catch (err) {
      console.error(`📧 Lifecycle send failed for ${user.email}:`, err.message);
      // Retry in 30 min, give up after 3 attempts.
      await EmailJob.updateMany({ _id: { $in: mergedIds }, attempts: { $gte: 2 } },
        { $set: { status: 'failed', reason: err.message.slice(0, 200) }, $inc: { attempts: 1 } });
      await EmailJob.updateMany({ _id: { $in: mergedIds }, status: 'pending' },
        { $set: { sendAt: new Date(Date.now() + 30 * 60 * 1000) }, $inc: { attempts: 1 } });
      return false;
    }
  }
}

export default new EmailPipeline();
