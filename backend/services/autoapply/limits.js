import Application from '../../models/Application.js';

// Auto-applies per day by plan. Pro also jumps the submit queue (AutoApplyCron).
export const AUTO_APPLY_DAILY_LIMIT = { clarity: 10, pro: 25 };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Days roll over at midnight IST, not UTC — that's the student's "today".
export function startOfTodayIST(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export const nextResetIST = () => new Date(startOfTodayIST().getTime() + 24 * 60 * 60 * 1000);

export const dailyLimitFor = (user) => AUTO_APPLY_DAILY_LIMIT[user?.subscriptionPlan] || 0;

// Counts applications sent (or waiting to send) today. Forms left for the
// student to finish ("needs_manual_action") or that failed don't use quota.
export function autoAppliesToday(userId) {
  return Application.countDocuments({
    user: userId,
    mode: 'auto',
    status: { $in: ['queued', 'submitted'] },
    updatedAt: { $gte: startOfTodayIST() },
  });
}

export async function autoApplyUsage(user) {
  const limit = dailyLimitFor(user);
  const used = limit ? await autoAppliesToday(user._id) : 0;
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt: nextResetIST() };
}
