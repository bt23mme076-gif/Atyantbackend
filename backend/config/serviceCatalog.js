/**
 * Platform service catalog — the SINGLE source of truth for what mentors can
 * offer and how much each costs. Prices are set by Atyant (the platform);
 * mentors only choose WHICH of these they offer (User.servicesOffered).
 *
 * 👉 Edit labels / prices / durations here. `id` must stay stable once live
 *    (it's stored on mentors and bookings).
 */
export const SERVICE_CATALOG = [
  { id: 'text-qa',        label: 'Text Q&A',          description: 'Quick doubt, one specific question',        durationMin: 30, duration: '48hr async', price: 49 },
  { id: 'audio-call',     label: 'Audio Call',        description: 'Resume talk, strategy, no video needed',   durationMin: 25, duration: '25 min',     price: 99 },
  { id: 'video-call',     label: 'Video Call',        description: 'Mock interview, screen share, deep dive',   durationMin: 45, duration: '45 min',     price: 299 },
  { id: 'resume-review',  label: 'Resume Review',     description: 'Written feedback on PDF, no call needed',  durationMin: 30, duration: '48hr async', price: 199 },
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
