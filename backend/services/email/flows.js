// ─────────────────────────────────────────────────────────────
//  Lifecycle email flows
//
//  event  → which flow it enrolls the user in
//  steps  → emails of that flow, each `delay` after the event
//  cancels→ pending flows this event makes irrelevant
//  stopIfPurchased → sales steps are dropped at send time if the user has paid
//  cooldownDays → a flow can't restart for the same user within this window;
//                 a repeat event inside the window just refreshes pending data
//                 ("latest intent wins").
// ─────────────────────────────────────────────────────────────

const H = 60 * 60 * 1000;
const D = 24 * H;

export const FLOWS = {
  signup: {
    event: 'signup',
    cooldownDays: 3650, // once per account
    steps: [
      { step: 'signup_day1', delay: 1 * D, priority: 2, stopIfPurchased: true },
      { step: 'signup_day3', delay: 3 * D, priority: 1, stopIfPurchased: true },
      { step: 'signup_day7', delay: 7 * D, priority: 1, stopIfPurchased: true },
    ],
  },

  // Searched / asked a question but hasn't booked.
  search: {
    event: 'search',
    cooldownDays: 7,
    steps: [
      { step: 'search_mentors', delay: 2 * H,  priority: 4, stopIfPurchased: true },
      { step: 'search_mock',    delay: 48 * H, priority: 3, stopIfPurchased: true },
    ],
  },

  // Viewed pricing / a mentor profile / mock-interview page, didn't buy.
  intent: {
    event: 'page_view',
    cooldownDays: 7,
    steps: [
      { step: 'intent_reminder',  delay: 3 * H,  priority: 5, stopIfPurchased: true },
      { step: 'intent_objection', delay: 24 * H, priority: 4, stopIfPurchased: true },
      { step: 'intent_help',      delay: 72 * H, priority: 3, stopIfPurchased: true },
    ],
  },

  // Post-purchase: feedback + cross-sell. Receipts are sent immediately elsewhere.
  purchase: {
    event: 'purchase',
    cooldownDays: 0, // every purchase gets its own follow-ups
    steps: [
      // Session follow-ups are anchored to the session end (see anchorFor), not the payment time.
      { step: 'purchase_feedback',  delay: 1 * D, priority: 6 },
      { step: 'purchase_crosssell', delay: 3 * D, priority: 2 },
    ],
  },
};

// Pending flows an event makes pointless.
export const CANCELS = {
  search:   ['signup:signup_day1'],        // day-1 email = "ask your first question"
  purchase: ['signup', 'search', 'intent'],
};

// Pages the frontend may report for the intent flow.
export const INTENT_PAGES = new Set(['pricing', 'mentor_profile', 'mock_interview', 'auto_apply']);

// Marketing guardrails.
export const CAP_PER_DAY = 1;
export const CAP_PER_WEEK = 3;
export const QUIET_START_IST = 21; // no marketing mail 21:00–09:00 IST
export const QUIET_END_IST = 9;

export const FLOW_FOR_EVENT = Object.fromEntries(
  Object.entries(FLOWS).map(([name, f]) => [f.event, name])
);
