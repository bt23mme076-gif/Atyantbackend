import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/authMiddleware.js';
import AtyantConversation from '../models/AtyantConversation.js';
import MentorInvite from '../models/MentorInvite.js';
import User from '../models/User.js';
import { findSeniors, isLinkedinProfileUrl, linkedinSlug } from '../services/SeniorSearchService.js';
import { frontendBase } from '../utils/frontendUrl.js';
import { logFunnel } from '../utils/funnel.js';

const router = express.Router();

const DAILY_INVITE_CAP = 10;

// Each search costs real money (Serper), so cap per user, not per IP.
const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => String(req.user.userId), // runs after protect
  message: { message: 'Too many searches — try again in a bit.' },
});

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function defaultQuestion(ctx = {}) {
  const id = ctx.identity || {};
  const who = [id.year, id.branch, 'student', id.college && `from ${id.college}`].filter(Boolean).join(' ');
  const company = (ctx.targetCompanies || [])[0];
  const goal = ctx.target || 'their placement';
  return `A ${who} wants to know how you got to ${company || 'where you are'} — they're aiming for ${goal} and would love 10 minutes of honest advice.`;
}

function inviteMessage(senior, inviterName, link) {
  const first = senior.name.split(' ')[0];
  return `Hi ${first}, I'm ${inviterName}, a junior from your background. I saw your journey and had one question about how you got there — I've posted it on Atyant, where seniors answer juniors from the same background. Would really appreciate your take: ${link}`;
}

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
    const senior = req.body.senior || {};
    const name = str(senior.name, 60);
    const linkedinUrl = str(senior.linkedinUrl, 300);
    if (!name || !isLinkedinProfileUrl(linkedinUrl)) {
      return res.status(400).json({ message: 'A name and LinkedIn profile URL are required' });
    }
    const slug = linkedinSlug(linkedinUrl);

    const inviter = await User.findById(inviterId).select('name username').lean();
    const inviterName = inviter?.name || inviter?.username || 'a junior';

    let invite = await MentorInvite.findOne({ inviterId, 'senior.slug': slug });
    if (!invite) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const today = await MentorInvite.countDocuments({ inviterId, createdAt: { $gte: since } });
      if (today >= DAILY_INVITE_CAP) {
        return res.status(429).json({ message: `You can invite up to ${DAILY_INVITE_CAP} seniors a day` });
      }
      const sessionId = str(req.body.sessionId, 100);
      const conv = await ownConversation(sessionId, inviterId);
      invite = await MentorInvite.create({
        code: crypto.randomBytes(6).toString('base64url'),
        inviterId,
        sessionId: conv ? sessionId : null,
        senior: { name, headline: str(senior.headline, 160), linkedinUrl, slug },
        question: str(req.body.question, 300) || defaultQuestion(conv?.context),
      });
      logFunnel('invite_created', { funnelId: invite.sessionId, userId: inviterId, props: { code: invite.code } });
    }

    const link = `${frontendBase()}/?invite=${invite.code}`;
    res.status(201).json({
      code: invite.code,
      link,
      linkedinUrl: invite.senior.linkedinUrl,
      message: inviteMessage(invite.senior, inviterName, link),
      status: invite.status,
    });
  } catch (err) {
    console.error('Create invite failed:', err.message);
    res.status(500).json({ message: 'Could not create invite' });
  }
});

// GET /api/invites/mine — the student's invites and where each one stands.
router.get('/mine', protect, async (req, res) => {
  const invites = await MentorInvite.find({ inviterId: req.user.userId })
    .sort({ createdAt: -1 })
    .select('code senior.name senior.headline status rewardCredits createdAt')
    .lean();
  res.json({ invites });
});

// GET /api/invites/:code — public landing page data for the invited senior.
router.get('/:code', async (req, res) => {
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
});

// POST /api/invites/:code/claim — the senior, once signed in, attaches the invite to their account.
router.post('/:code/claim', protect, async (req, res) => {
  const userId = req.user.userId;
  const invite = await MentorInvite.findOneAndUpdate(
    { code: str(req.params.code, 20), mentorId: null, inviterId: { $ne: userId } },
    { $set: { mentorId: userId, status: 'signed_up' } },
    { new: true },
  );
  if (!invite) return res.status(409).json({ message: 'Invite already claimed or invalid' });

  logFunnel('invite_claimed', { funnelId: invite.sessionId, userId, props: { code: invite.code } });
  res.json({ ok: true });
});

export default router;
