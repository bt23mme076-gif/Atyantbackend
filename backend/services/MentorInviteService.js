// Shared by the website (routes/inviteRoutes.js) and WhatsApp: a student
// invites a senior from their college (found on LinkedIn) to join Atyant.
import crypto from 'crypto';
import MentorInvite from '../models/MentorInvite.js';
import User from '../models/User.js';
import { isLinkedinProfileUrl, linkedinSlug } from './SeniorSearchService.js';
import { frontendBase } from '../utils/frontendUrl.js';
import { logFunnel } from '../utils/funnel.js';

export const DAILY_INVITE_CAP = 10;
export const INVITE_REWARD_CREDITS = Number(process.env.INVITE_REWARD_CREDITS) || 1;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function defaultQuestion(ctx = {}) {
  const id = ctx.identity || {};
  const who = [id.year, id.branch, 'student', id.college && `from ${id.college}`].filter(Boolean).join(' ');
  const company = (ctx.targetCompanies || [])[0];
  const goal = ctx.target || 'their placement';
  return `A ${who} wants to know how you got to ${company || 'where you are'} — they're aiming for ${goal} and would love 10 minutes of honest advice.`;
}

export function inviteMessage(senior, inviterName, link) {
  const first = senior.name.split(' ')[0];
  return `Hi ${first}, I'm ${inviterName}, a junior from your background. I saw your journey and had one question about how you got there — I've posted it on Atyant, where seniors answer juniors from the same background. Would really appreciate your take: ${link}`;
}

// LinkedIn connection notes are capped (~200 chars on free accounts), so the
// note must fit with the link intact.
const NOTE_LIMIT = 200;
export function inviteNote(senior, inviterName, link) {
  const first = senior.name.split(' ')[0];
  const me = inviterName.split(' ')[0];
  const note = `Hi ${first}, I'm ${me}, a junior from your college — one quick question about your journey. Would love your take: ${link}`;
  return note.length <= NOTE_LIMIT ? note : `Hi! Junior from your college — one quick question about your journey: ${link}`;
}

export class InviteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Creates (or returns the existing) invite from this student to this senior.
// `context` is the chat context used for the default question; sessionId is
// stored only when the caller has verified the chat belongs to the inviter.
export async function createInvite({ inviterId, inviterIp = null, sessionId = null, context = null, senior = {}, question = '' }) {
  const name = str(senior.name, 60);
  const linkedinUrl = str(senior.linkedinUrl, 300);
  if (!name || !isLinkedinProfileUrl(linkedinUrl)) {
    throw new InviteError(400, 'A name and LinkedIn profile URL are required');
  }
  const slug = linkedinSlug(linkedinUrl);

  const inviter = await User.findById(inviterId).select('name username').lean();
  const inviterName = inviter?.name || inviter?.username || 'a junior';

  let invite = await MentorInvite.findOne({ inviterId, 'senior.slug': slug });
  if (!invite) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const today = await MentorInvite.countDocuments({ inviterId, createdAt: { $gte: since } });
    if (today >= DAILY_INVITE_CAP) {
      throw new InviteError(429, `You can invite up to ${DAILY_INVITE_CAP} seniors a day`);
    }
    try {
      invite = await MentorInvite.create({
        code: crypto.randomBytes(6).toString('base64url'),
        inviterId,
        inviterIp,
        sessionId,
        senior: { name, headline: str(senior.headline, 160), linkedinUrl, slug },
        question: str(question, 300) || defaultQuestion(context || {}),
      });
      logFunnel('invite_created', { funnelId: invite.sessionId, userId: inviterId, props: { code: invite.code } });
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Concurrent request created it first (unique inviter + senior).
      invite = await MentorInvite.findOne({ inviterId, 'senior.slug': slug });
      if (!invite) throw err;
    }
  }

  const link = `${frontendBase()}/?invite=${invite.code}`;
  return {
    invite,
    link,
    message: inviteMessage(invite.senior, inviterName, link),
    note: inviteNote(invite.senior, inviterName, link),
  };
}
