import MentorInvite from '../models/MentorInvite.js';
import User from '../models/User.js';
import { linkedinSlug } from './SeniorSearchService.js';
import { logFunnel } from '../utils/funnel.js';

const REWARD_CREDITS = Number(process.env.INVITE_REWARD_CREDITS) || 1;

// Called when a mentor becomes listed. If they came in through a student's
// invite, credit that student — but only when the mentor's LinkedIn is the
// profile that was invited; otherwise hold it for manual review (stops students
// onboarding a fake second account to farm credits).
export async function rewardInviteFor(mentor) {
  const invite = await MentorInvite.findOne({ mentorId: mentor._id, status: 'signed_up' });
  if (!invite) return;

  const matches = linkedinSlug(mentor.linkedinProfile) === invite.senior.slug;
  const claimed = await MentorInvite.findOneAndUpdate(
    { _id: invite._id, status: 'signed_up' },
    matches
      ? { $set: { status: 'onboarded', rewardCredits: REWARD_CREDITS, rewardedAt: new Date() } }
      : { $set: { status: 'needs_review' } },
  );
  if (!claimed) return; // another request got here first

  if (matches) {
    await User.updateOne({ _id: invite.inviterId }, { $inc: { credits: REWARD_CREDITS } });
  }
  logFunnel(matches ? 'invite_rewarded' : 'invite_needs_review', {
    funnelId: invite.sessionId, userId: invite.inviterId, props: { code: invite.code, mentorId: String(mentor._id) },
  });
}
