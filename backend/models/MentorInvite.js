import mongoose from 'mongoose';

// A student inviting a senior they found via web search (no mentor in our pool).
// sent -> opened (landing page visited) -> signed_up (senior claimed it) ->
// onboarded (listed mentor, inviter rewarded) | needs_review (onboarded, but the
// mentor's LinkedIn doesn't match the invited profile — reward held for a human).
const mentorInviteSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true },
  inviterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, default: null },
  senior: {
    name:        { type: String, required: true },
    headline:    { type: String, default: '' },
    linkedinUrl: { type: String, required: true },
    slug:        { type: String, required: true },
  },
  question:  { type: String, default: '' },
  status: {
    type: String,
    enum: ['sent', 'opened', 'signed_up', 'onboarded', 'needs_review'],
    default: 'sent',
    index: true,
  },
  openCount:     { type: Number, default: 0 },
  mentorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  rewardCredits: { type: Number, default: 0 },
  rewardedAt:    { type: Date, default: null },
}, { timestamps: true });

// One invite per student per senior.
mentorInviteSchema.index({ inviterId: 1, 'senior.slug': 1 }, { unique: true });

const MentorInvite = mongoose.model('MentorInvite', mentorInviteSchema);
export default MentorInvite;
