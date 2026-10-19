import Application from '../../models/Application.js';
import { hasActivePlan } from '../../middleware/subscriptionMiddleware.js';

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

// Without a plan or pass, every student gets this many auto-applies in total
// to try it; after that it's the ₹49 Auto-Apply pass (30 days, PASS_DAILY_LIMIT a day).
export const FREE_TRIAL_APPLIES = 5;
export const PASS_DAILY_LIMIT = 10;

export const hasActivePass = (user) =>
  !!user?.autoApply?.passExpiry && new Date(user.autoApply.passExpiry) > new Date();

async function dailyAllowance(user, limit) {
  const used = await autoAppliesToday(user._id);
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt: nextResetIST() };
}

/**
 * Which allowance the student is on and what's left of it:
 *   plan  — Clarity/Pro, per-day limit
 *   pass  — ₹49 Auto-Apply pass, per-day limit until passExpiry
 *   trial — free, FREE_TRIAL_APPLIES in total (resetsAt: null)
 *   none  — trial used up, needs the pass or a plan
 * Needs subscriptionPlan/Status/Expiry and autoApply.passExpiry on `user`.
 */
export async function autoApplyUsage(user) {
  if (hasActivePlan(user, 'clarity')) return { mode: 'plan', ...(await dailyAllowance(user, dailyLimitFor(user))) };
  if (hasActivePass(user)) return { mode: 'pass', passExpiry: user.autoApply.passExpiry, ...(await dailyAllowance(user, PASS_DAILY_LIMIT)) };

  const used = await Application.countDocuments({ user: user._id, mode: 'auto', status: { $in: ['queued', 'submitted'] } });
  const remaining = Math.max(0, FREE_TRIAL_APPLIES - used);
  return { mode: remaining > 0 ? 'trial' : 'none', limit: FREE_TRIAL_APPLIES, used, remaining, resetsAt: null };
}
