import express from 'express';
import FunnelEvent from '../models/FunnelEvent.js';
import { optionalAuth } from '../middleware/auth.js';
import { logFunnel, CLIENT_EVENTS } from '../utils/funnel.js';

const router = express.Router();

const cleanId = (v) => (typeof v === 'string' && v.length <= 100 ? v : null);

// Visitors whose anonymous history this process already linked to their account.
const linked = new Set();

// Once a visitor is signed in, give their earlier anonymous events (same browser
// visitorId, or the same chat session) their userId, so the journey report shows
// the whole path — home → chat → clarity → booking — under one person.
function linkAnonymousHistory(userId, visitorId, funnelId) {
  const key = `${userId}|${visitorId}|${funnelId}`;
  if (linked.has(key)) return;
  if (linked.size > 50000) linked.clear();
  linked.add(key);
  const or = [visitorId && { visitorId }, funnelId && { funnelId }].filter(Boolean);
  if (!or.length) return;
  FunnelEvent.updateMany({ userId: null, $or: or }, { $set: { userId } })
    .catch(err => console.error('funnel identity link failed:', err.message));
}

// POST /api/events  { event, funnelId?, visitorId?, props? } — client-side steps.
// Only known step names are accepted and props are size-capped, so this can't
// be used to dump arbitrary data into the collection.
router.post('/', optionalAuth, (req, res) => {
  const { event, funnelId, visitorId, props } = req.body || {};
  if (!CLIENT_EVENTS.includes(event)) {
    return res.status(400).json({ ok: false, error: 'Unknown event' });
  }
  const safeProps = props && typeof props === 'object' && !Array.isArray(props)
    && JSON.stringify(props).length <= 1000 ? props : {};
  const userId = req.user?._id || null;
  const fid = cleanId(funnelId);
  const vid = cleanId(visitorId);

  logFunnel(event, { funnelId: fid, visitorId: vid, userId, props: safeProps });
  if (userId) linkAnonymousHistory(userId, vid, fid);
  res.json({ ok: true });
});

export default router;
