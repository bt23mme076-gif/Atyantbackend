import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/authMiddleware.js';
import AtyantConversation from '../models/AtyantConversation.js';
import MentorInvite from '../models/MentorInvite.js';
import User from '../models/User.js';
import { findSeniors } from '../services/SeniorSearchService.js';
import { createInvite, InviteError } from '../services/MentorInviteService.js';
import { logFunnel } from '../utils/funnel.js';
import { rewardInviteFor } from '../services/InviteRewardService.js';

const router = express.Router();

// Each search costs real money (Serper), so cap per user, not per IP.
const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => String(req.user.userId), // runs after protect
  message: { message: 'Too many searches — try again in a bit.' },
});

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function ownConversation(sessionId, userId) {
  if (!sessionId) return null;
  const conv = await AtyantConversation.findOne({ sessionId }).lean();
  return conv && String(conv.userId) === String(userId) ? conv : null;
}

// GET /api/invites/seniors?sessionId= — seniors on the web matching the student's context.
router.get('/seniors', protect, searchLimiter, async (req, res) => {
  try {
    const conv = await ownConversation(str(req.query.sessionId, 100), req.user.userId);
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    const { seniors, query } = await findSeniors(conv.context);
    logFunnel('invite_seniors_shown', {
      funnelId: conv.sessionId, userId: req.user.userId, props: { count: seniors.length, query },
    });
    res.json({ seniors });
  } catch (err) {
    console.error('Senior search failed:', err.message);
    res.status(502).json({ message: 'Could not search right now' });
  }
});

// POST /api/invites { sessionId, senior: { name, headline, linkedinUrl }, question? }
router.post('/', protect, async (req, res) => {
  try {
    const inviterId = req.user.userId;
    const sessionId = str(req.body.sessionId, 100);
    const conv = await ownConversation(sessionId, inviterId);
    const { invite, link, message, note } = await createInvite({
      inviterId,
      inviterIp: req.ip || null,
      sessionId: conv ? sessionId : null,
      context: conv?.context,
      senior: req.body.senior || {},
      question: req.body.question,
    });
    res.status(201).json({
      code: invite.code,
      link,
      linkedinUrl: invite.senior.linkedinUrl,
      message,
      note,
      status: invite.status,
    });
  } catch (err) {
    if (err instanceof InviteError) return res.status(err.status).json({ message: err.message });
    console.error('Create invite failed:', err.message);
    res.status(500).json({ message: 'Could not create invite' });
  }
});

// GET /api/invites/mine — the student's invites and where each one stands.
router.get('/mine', protect, async (req, res) => {
  try {
    const invites = await MentorInvite.find({ inviterId: req.user.userId })
      .sort({ createdAt: -1 })
      .select('code senior.name senior.headline status rewardCredits createdAt')
      .lean();
    res.json({ invites });
  } catch (err) {
    console.error('List invites failed:', err.message);
    res.status(500).json({ message: 'Could not load invites' });
  }
});

// GET /api/invites/:code — public landing page data for the invited senior.
router.get('/:code', async (req, res) => {
  try {
    const code = str(req.params.code, 20);
    const invite = await MentorInvite.findOneAndUpdate(
      { code },
      { $inc: { openCount: 1 } },
      { new: true },
    ).populate('inviterId', 'name username').lean();
    if (!invite) return res.status(404).json({ message: 'Invite not found' });

    if (invite.status === 'sent') {
      MentorInvite.updateOne({ _id: invite._id, status: 'sent' }, { $set: { status: 'opened' } }).catch(() => {});
      logFunnel('invite_opened', { funnelId: invite.sessionId, props: { code } });
    }

    const inviter = invite.inviterId || {};
    res.json({
      seniorName: invite.senior.name,
      inviterName: (inviter.name || inviter.username || 'A junior').split(' ')[0],
      question: invite.question,
      claimed: !!invite.mentorId,
    });
  } catch (err) {
    console.error('Load invite failed:', err.message);
    res.status(500).json({ message: 'Could not load invite' });
  }
});

// POST /api/invites/:code/claim — the senior, once signed in, attaches the invite to their account.
router.post('/:code/claim', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const invite = await MentorInvite.findOneAndUpdate(
      { code: str(req.params.code, 20), mentorId: null, inviterId: { $ne: userId } },
      { $set: { mentorId: userId, status: 'signed_up', claimIp: req.ip || null } },
      { new: true },
    );
    if (!invite) return res.status(409).json({ message: 'Invite already claimed or invalid' });

    logFunnel('invite_claimed', { funnelId: invite.sessionId, userId, props: { code: invite.code } });

    // Already a listed mentor → onboarding won't run again, so move it along now.
    const claimant = await User.findById(userId).select('mentorListed linkedinProfile').lean();
    if (claimant?.mentorListed) {
      rewardInviteFor(claimant).catch(err => console.error('Invite onboard check failed (non-fatal):', err.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Claim invite failed:', err.message);
    res.status(500).json({ message: 'Could not claim invite' });
  }
});

export default router;
