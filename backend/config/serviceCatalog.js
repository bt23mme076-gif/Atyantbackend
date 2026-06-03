/**
 * Platform service catalog — the SINGLE source of truth for what mentors can
 * offer and how much each costs. Prices are set by Atyant (the platform);
 * mentors only choose WHICH of these they offer (User.servicesOffered).
 *
 * 👉 Edit labels / prices / durations here. `id` must stay stable once live
 *    (it's stored on mentors and bookings).
 */
export const SERVICE_CATALOG = [
  { id: 'quick-chat',     label: '1:1 Chat',          description: 'Async/text guidance on a focused question', durationMin: 20, price: 149 },
  { id: 'video-call',     label: '1:1 Video Call',    description: '30-min live video mentorship session',      durationMin: 30, price: 399 },
  { id: 'resume-review',  label: 'Resume / LinkedIn Review', description: 'Detailed written feedback on your profile', durationMin: 30, price: 249 },
  { id: 'mock-interview', label: 'Mock Interview',    description: '45-min mock interview + feedback',          durationMin: 45, price: 599 },
  { id: 'roadmap',        label: 'Personalized Roadmap', description: 'A step-by-step plan for your goal',       durationMin: 30, price: 499 },
];

const byId = new Map(SERVICE_CATALOG.map(s => [s.id, s]));

/** Look up a service by id, or null. */
export const getService = (id) => byId.get(id) || null;

/** Keep only valid catalog ids (dedup, preserve catalog order). */
export const sanitizeServiceIds = (ids) => {
  if (!Array.isArray(ids)) return [];
  const set = new Set(ids.filter(id => byId.has(id)));
  return SERVICE_CATALOG.filter(s => set.has(s.id)).map(s => s.id);
};
