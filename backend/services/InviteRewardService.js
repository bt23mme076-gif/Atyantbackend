import MentorInvite from '../models/MentorInvite.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { linkedinSlug } from './SeniorSearchService.js';
import { logFunnel } from '../utils/funnel.js';

const REWARD_CREDITS = Number(process.env.INVITE_REWARD_CREDITS) || 1;

// LinkedIn can't prove a mentor owns the profile URL they typed, so listing
// alone never pays out — a student could onboard a fake second account with the
// senior's URL. Listing only moves the invite to 'onboarded' (or 'needs_review'
// on a fraud signal); the reward waits for real value, see rewardInviteForSession.
export async function rewardInviteFor(mentor) {
  const invite = await MentorInvite.findOne({ mentorId: mentor._id, status: 'signed_up' });
  if (!invite) return;

  const reviewReason = linkedinSlug(mentor.linkedinProfile) !== invite.senior.slug
    ? 'linkedin_mismatch'
    : invite.claimIp && invite.claimIp === invite.inviterIp
      ? 'same_ip_as_inviter'
      : null;

  const moved = await MentorInvite.findOneAndUpdate(
    { _id: invite._id, status: 'signed_up' },
    { $set: reviewReason ? { status: 'needs_review', reviewReason } : { status: 'onboarded' } },
  );
  if (!moved) return; // another request got here first

  logFunnel(reviewReason ? 'invite_needs_review' : 'invite_onboarded', {
    funnelId: invite.sessionId, userId: invite.inviterId,
    props: { code: invite.code, mentorId: String(mentor._id), ...(reviewReason && { reviewReason }) },
  });
}

// Called when a session is marked completed. Pays the inviter once the invited
// mentor completes a PAID session with a student other than the inviter — faking
// that costs real money (the platform fee alone exceeds the reward).
export async function rewardInviteForSession(sessionId) {
  const session = await Session.findById(sessionId).select('mentorId userId status paymentStatus').lean();
  if (!session?.mentorId || session.status !== 'completed' || session.paymentStatus !== 'paid') return;

  const invite = await MentorInvite.findOneAndUpdate(
    { mentorId: session.mentorId, status: 'onboarded', rewardedAt: null, inviterId: { $ne: session.userId } },
    { $set: { status: 'rewarded', rewardCredits: REWARD_CREDITS, rewardedAt: new Date() } },
    { new: true },
  );
  if (!invite) return;

  await User.updateOne({ _id: invite.inviterId }, { $inc: { subscriptionCredits: REWARD_CREDITS } });
  logFunnel('invite_rewarded', {
    funnelId: invite.sessionId, userId: invite.inviterId,
    props: { code: invite.code, mentorId: String(session.mentorId), rewardSessionId: String(sessionId) },
  });
}
