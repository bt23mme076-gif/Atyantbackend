// ─────────────────────────────────────────────────────────────────────────────
//  CHAT ENTITLEMENT
//
//  A student may only send chat messages to a mentor if they have an ACTIVE
//  "Text Q&A" purchase with that mentor.
//
//  Window of access (per the product spec):
//    • Opens the moment the session is purchased  (Session.createdAt)
//    • Stays open through the WHOLE booked day     (end of Session.scheduledAt, IST)
//    • Closes after the booked day ends — the student must purchase again.
//
//  Mentors are never gated here — they can always reply to a student who has
//  (or has had) an entitlement. Viewing past messages is also never gated;
//  only SENDING is restricted. This module is the single source of truth used
//  by both the REST API and the Socket.IO layer so the rule can't be bypassed.
// ─────────────────────────────────────────────────────────────────────────────
import Session from '../models/Session.js';

// The Text Q&A catalog id (config/serviceCatalog.js). Kept here as a constant
// so the entitlement rule has one obvious knob.
export const CHAT_SERVICE_ID = 'text-qa';

// IST has no DST, so a fixed +5:30 offset is safe. Returns the UTC instant of
// 23:59:59.999 IST on the same calendar day as `date`.
function endOfBookingDayIST(date) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(23, 59, 59, 999);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * Resolve a student's chat entitlement for a given mentor.
 *
 * @param {string} studentId
 * @param {string} mentorId
 * @returns {Promise<{
 *   allowed: boolean,
 *   session: object|null,
 *   expiresAt: Date|null,
 *   expired: boolean,        // had a purchase but the window has passed
 *   serviceLabel: string
 * }>}
 */
export async function getChatEntitlement(studentId, mentorId) {
  const base = { allowed: false, session: null, expiresAt: null, expired: false, serviceLabel: 'Text Q&A' };
  if (!studentId || !mentorId) return base;

  const now = new Date();

  // All non-cancelled, paid/free Text Q&A purchases for this student↔mentor pair,
  // newest booked slot first.
  const sessions = await Session.find({
    userId: studentId,
    mentorId,
    serviceId: CHAT_SERVICE_ID,
    paymentStatus: { $in: ['paid', 'free'] },
    status: { $ne: 'cancelled' },
  }).sort({ scheduledAt: -1 }).lean();

  if (!sessions.length) return base;

  // Active = now between purchase time and end of the booked day.
  for (const s of sessions) {
    const opensAt = new Date(s.createdAt);
    const closesAt = endOfBookingDayIST(new Date(s.scheduledAt));
    if (now >= opensAt && now <= closesAt) {
      return { allowed: true, session: s, expiresAt: closesAt, expired: false, serviceLabel: 'Text Q&A' };
    }
  }

  // Had a purchase, but every window has closed → expired (can still VIEW history).
  const latest = sessions[0];
  return {
    allowed: false,
    session: latest,
    expiresAt: endOfBookingDayIST(new Date(latest.scheduledAt)),
    expired: true,
    serviceLabel: 'Text Q&A',
  };
}

/** Convenience boolean wrapper. */
export async function canStudentChat(studentId, mentorId) {
  const e = await getChatEntitlement(studentId, mentorId);
  return e.allowed;
}
