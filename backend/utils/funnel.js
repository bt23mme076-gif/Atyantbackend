import FunnelEvent from '../models/FunnelEvent.js';

// Funnel steps, in order. Server-side steps are logged where they happen;
// client-side ones arrive through POST /api/events (routes/eventRoutes.js).
export const FUNNEL_STEPS = [
  'chat_started', 'handoff_shown', 'chat_mentor_clicked', 'clarity_opened',
  'mentor_profile_opened', 'booking_started', 'purchase',
];
export const CLIENT_EVENTS = ['page_view', 'chat_mentor_clicked', 'clarity_opened', 'mentor_profile_opened', 'booking_started'];

// Fire-and-forget: analytics must never slow down or break the request it rides on.
export function logFunnel(event, { funnelId = null, visitorId = null, userId = null, props = {} } = {}) {
  FunnelEvent.create({ event, funnelId, visitorId, userId, props })
    .catch(err => console.error(`funnel(${event}) failed:`, err.message));
}
