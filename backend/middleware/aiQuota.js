import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import AiUsage from '../models/AiUsage.js';

// Daily AI-chat limits. Counted per user (logged in) or per IP (guest) —
// never per sessionId, which the client mints and can rotate freely.
const LIMITS = {
  guest: { msg: Number(process.env.AI_LIMIT_GUEST || 5),   resume: 1 },
  free:  { msg: Number(process.env.AI_LIMIT_FREE  || 30),  resume: 3 },
  paid:  { msg: Number(process.env.AI_LIMIT_PAID  || 200), resume: 10 },
};
// Whole-platform daily cap — stops a botnet spread over many IPs. Only guests are cut off by it.
const GLOBAL_DAILY_CAP = Number(process.env.AI_GLOBAL_DAILY_CAP || 3000);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDay(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Next IST midnight, as a UTC Date.
function nextReset(now = Date.now()) {
  const d = new Date(now + IST_OFFSET_MS);
  d.setUTCHours(24, 0, 0, 0);
  return new Date(d.getTime() - IST_OFFSET_MS);
}

function tierOf(user) {
  if (!user) return 'guest';
  if (user.role === 'admin' || user.role === 'mentor') return 'unlimited';
  const paid = user.subscriptionPlan && user.subscriptionPlan !== 'free'
    && user.subscriptionStatus === 'active'
    && (!user.subscriptionExpiry || new Date(user.subscriptionExpiry) > new Date());
  return paid ? 'paid' : 'free';
}

const keyOf = (req) => (req.user?._id ? `u:${req.user._id}` : `ip:${ipKeyGenerator(req.ip)}`);

async function bump(key, day, kind, by = 1) {
  const doc = await AiUsage.findOneAndUpdate(
    { key, day, kind },
    { $inc: { count: by }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86400000) } },
    { upsert: true, new: true }
  ).lean();
  return doc.count;
}

// Short-window burst guard: 6 AI turns per minute per user/IP.
export const aiBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  keyGenerator: keyOf,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    ok: false, code: 'BURST', error: "You're sending messages too fast — wait a few seconds and try again.",
  }),
});

// kind: 'msg' | 'resume'. Must run before any SSE headers are written so a 429 is plain JSON.
// Sets req.aiQuota = { remaining, limit, refund() } — call refund() when the turn fails.
export function aiDailyQuota(kind = 'msg') {
  return async (req, res, next) => {
    const tier = tierOf(req.user);
    if (tier === 'unlimited') {
      req.aiQuota = { remaining: null, limit: null, refund: async () => {} };
      return next();
    }

    try {
      const day = istDay();
      const key = keyOf(req);
      const limit = LIMITS[tier][kind];

      if (tier === 'guest') {
        const global = await AiUsage.findOne({ key: 'global', day, kind: 'msg' }).lean();
        if ((global?.count || 0) >= GLOBAL_DAILY_CAP) {
          return res.status(429).json({
            ok: false, code: 'GUEST_LIMIT', remaining: 0, resetsAt: nextReset(),
            error: 'Atyant is very busy today. Log in to keep chatting.',
          });
        }
      }

      const used = await bump(key, day, kind);
      if (used > limit) {
        await bump(key, day, kind, -1);
        const code = tier === 'guest' ? 'GUEST_LIMIT' : 'USER_LIMIT';
        return res.status(429).json({
          ok: false, code, tier, limit, remaining: 0, resetsAt: nextReset(),
          error: tier === 'guest'
            ? `You've used your ${limit} free messages for today. Log in to keep chatting.`
            : `You've used all ${limit} messages for today. Upgrade for more, or come back tomorrow.`,
        });
      }
      if (kind === 'msg') bump('global', day, 'msg').catch(() => {});

      let refunded = false;
      req.aiQuota = {
        limit,
        remaining: limit - used,
        refund: async () => {
          if (refunded) return;
          refunded = true;
          await bump(key, day, kind, -1).catch(() => {});
          if (kind === 'msg') await bump('global', day, 'msg', -1).catch(() => {});
        },
      };
      next();
    } catch (err) {
      // Quota store down — fail open rather than take chat offline.
      console.error('AI quota error:', err.message);
      req.aiQuota = { remaining: null, limit: null, refund: async () => {} };
      next();
    }
  };
}
