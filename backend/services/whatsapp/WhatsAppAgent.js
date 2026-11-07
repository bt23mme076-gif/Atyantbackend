// WhatsApp placement guide: answer first, collect details only when they change
// the advice, then offer a relevant senior call with checked facts. The same
// chat engine as the website writes the answers (answerFirst mode); this file
// owns the deterministic parts: senior facts, booking, payment and consent.
// Off-topic requests are declined so the bot stays a career service, not a
// general-purpose chatbot (Meta policy).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import User from '../../models/User.js';
import Session from '../../models/Session.js';
import WaConversation from '../../models/WaConversation.js';
import AtyantConversation from '../../models/AtyantConversation.js';
import MentorInvite from '../../models/MentorInvite.js';
import { findSeniors } from '../SeniorSearchService.js';
import { createInvite, InviteError, INVITE_REWARD_CREDITS } from '../MentorInviteService.js';
import atyantEngine, { isSameCollege } from '../AtyantEngine.js';
import { processAtyantMessage, recordAtyantChatFeedback } from '../AtyantEngineService.js';
import { isSameBranch } from '../../utils/collegeNormalizer.js';
import { groqJSON } from '../../utils/groqClient.js';
import { sendSignupOTPEmail } from '../../utils/emailService.js';
import { getService } from '../../config/serviceCatalog.js';
import { logFunnel } from '../../utils/funnel.js';
import * as wa from './WhatsAppClient.js';

const SERVICE_ID = 'audio-call';
const LINK_TTL_MIN = 20;            // < StalePendingCron's 30 min, so a link never outlives its slot hold
const SLOT_DAYS = 7;
const SUPPORT_EMAIL = 'nitin@atyant.in';
const REFUND_TERMS = `If the senior doesn't join or cancels, you get a full refund or a free reschedule (email ${SUPPORT_EMAIL}).`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEGACY_STATES = new Set(['email', 'college', 'branch', 'year', 'goal', 'ready']);
const INTRO = 'Hi, I\'m Atyant. I help engineering students with internships and placements, using advice from seniors who\'ve been there.';
const CHAT_BUTTONS = [{ id: 'chat:new', title: 'New chat' }, { id: 'chat:end', title: 'End chat' }];

// Stickers: 512×512 WebP files in backend/assets/stickers, served publicly by
// GET /api/whatsapp/stickers/<name>.webp (Meta fetches them by URL). A missing
// file is simply skipped, so text replies never depend on a sticker.
const STICKER_DIR = fileURLToPath(new URL('../../assets/stickers/', import.meta.url));
const PUBLIC_BASE = (process.env.WA_PUBLIC_BASE_URL || 'https://api.product.atyant.in').replace(/\/+$/, '');
export const stickerFile = (name) => (/^[a-z-]+$/.test(name) ? path.join(STICKER_DIR, `${name}.webp`) : null);
async function sendSticker(to, name) {
  const file = stickerFile(name);
  if (file && fs.existsSync(file)) await wa.sendSticker(to, `${PUBLIC_BASE}/api/whatsapp/stickers/${name}.webp`);
}

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'YM';
const phone10 = (waId) => (waId.startsWith('91') && waId.length === 12 ? waId.slice(2) : null);
const fmtWhen = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const chatSessionId = (waId) => `wa:${waId}`;
const displayName = (m = {}) => m.name || m.username || 'A senior';
const eduOf = (m = {}) => (Array.isArray(m.education) ? m.education[0] : m.education) || {};

// Interactive bodies are capped at 1024 chars: send a long answer as text first.
// "typing…" lasts ~25 s and vanishes on our first outbound message, so a long
// answer or an intro sent ahead of it would leave the chat silent. Re-show it.
const typingFor = new Map(); // waId → id of the message being answered
const keepTyping = (waId) => { const id = typingFor.get(waId); if (id) wa.showTyping(id); };

// One message at a time per student: parallel turns raced on the same
// conversation doc (last save wins) and produced duplicate/out-of-order replies.
const chains = new Map();
function serialize(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

async function sendWithButtons(to, text, buttons, shortPrompt = 'Was this useful?') {
  if (text.length <= 1000) return wa.sendButtons(to, text, buttons);
  await wa.sendText(to, text);
  return wa.sendButtons(to, shortPrompt, buttons);
}

function formatCard(content = {}) {
  const parts = [];
  if (content.mainAnswer) parts.push(`*${content.mainAnswer}*`);
  if (content.situation) parts.push(content.situation);
  if (content.keyMistakes?.length) {
    parts.push(`*Mistakes to avoid*\n${content.keyMistakes.slice(0, 4).map(m => `• ${m}`).join('\n')}`);
  }
  if (content.actionableSteps?.length) {
    parts.push(`*What to do*\n${content.actionableSteps.slice(0, 5).map((s, i) => `${i + 1}. ${s.description || s.step}`).join('\n')}`);
  }
  if (content.whatWorked) parts.push(`*What worked*\n${content.whatWorked}`);
  if (content.timeline) parts.push(`*Timeline:* ${content.timeline}`);
  return parts.join('\n\n');
}

// Obvious cases skip the LLM round-trip (~0.5 s saved on most messages).
const GREETING_RE = /^(hi+|hii+|hey+|hel+o+|hola|namaste( ?ji)?|yo|hm+|ok(ay)?|k|sure|thanks?( you| u)?|thanku|thnx|thx|tq|ty|great|nice|cool|good (morning|afternoon|evening|night)|gm|gn)[\s!.,🙏👋😊🙂❤️]*$/i;
const CAREER_RE = /intern|placement|job|resume|cv\b|interview|career|compan|college|branch|cgpa|backlog|gate\b|cat\b|m\.?tech|ms abroad|higher stud|off.?campus|on.?campus|dsa|dev|aptitude|coding|skill|project|salary|ctc|stipend|offer|referral|linkedin|hackathon|certif|sem(ester)?\b|year (student|btech)|b\.?tech|fresher/i;

async function classify(text) {
  const t = text.trim();
  if (GREETING_RE.test(t)) return 'greeting';
  if (CAREER_RE.test(t)) return 'career';
  try {
    const r = await groqJSON([
      {
        role: 'system',
        content: 'You route messages sent to Atyant on WhatsApp. Atyant helps Indian engineering students with internships, placements, jobs, interview prep, resumes, projects, skills, higher studies and booking calls with seniors. Return JSON {"type":"career"|"greeting"|"off_topic"}. career = any question or statement about those topics, including details about themselves (branch, college, year, skills). greeting = hi/thanks/ok with no question. off_topic = anything else, including writing essays or assignments, solving homework or code, general knowledge and chit-chat.',
      },
      { role: 'user', content: text.slice(0, 1000) },
    ], { maxTokens: 200, timeoutMs: 8000 }); // reasoning model: 30 tokens truncated mid-thought → 400
    return ['career', 'greeting', 'off_topic'].includes(r?.type) ? r.type : 'career';
  } catch {
    return 'career';
  }
}

// ─── Profile (single source: the latest chat context) ─────────

function syncProfile(conv, context = {}) {
  const id = context.identity || {};
  if (id.college) conv.profile.college = id.college;
  if (id.branch) conv.profile.branch = id.branch;
  if (id.year) conv.profile.year = id.year;
  if (context.target) conv.profile.goal = context.target;
  if (Array.isArray(context.targetCompanies)) conv.profile.companies = context.targetCompanies.slice(0, 5);
}

// Fills only empty fields on the account, so the website profile is never overwritten.
async function saveProfileToUser(conv) {
  if (!conv.userId) return;
  const { college, branch, year } = conv.profile;
  if (!college && !branch && !year) return;
  const user = await User.findById(conv.userId).select('education');
  if (!user) return;
  if (user.education?.length) {
    const e = user.education[0];
    if (!e.institutionName && !e.institution && college) e.institutionName = college;
    if (!e.field && branch) e.field = branch;
    if (!e.year && year) e.year = year;
  } else {
    user.education = [{ institutionName: college, field: branch, year }];
  }
  user.markModified('education');
  await user.save();
}

// Each new question gets a fresh chat seeded with the latest known profile,
// so matching follows the new topic but corrections are never lost.
async function ensureChatSeeded(conv) {
  const sessionId = chatSessionId(conv.waId);
  if (await AtyantConversation.exists({ sessionId })) return sessionId;
  const p = conv.profile;
  await AtyantConversation.create({
    sessionId,
    userId: conv.userId || null,
    context: {
      identity: { college: p.college || null, branch: p.branch || null, year: p.year || null },
      targetCompanies: p.companies || [],
    },
  });
  return sessionId;
}

// ─── Senior facts (checked against profiles, never invented) ──

async function loadSeniors(ids, selfId) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))].filter(id => id !== String(selfId));
  if (!uniq.length) return [];
  const rows = await User.find({ _id: { $in: uniq }, role: 'mentor', servicesOffered: SERVICE_ID })
    .select('name username education topCompanies companyDomain availability').lean();
  const byId = new Map(rows.map(r => [String(r._id), r]));
  return uniq.map(id => byId.get(id)).filter(Boolean);
}

// "Why this senior": what matches, what differs, what isn't listed.
function fitLine(m, profile) {
  const edu = eduOf(m);
  const mCollege = edu.institutionName || edu.institution;
  const mBranch = edu.field;
  const facts = [];
  const gaps = [];

  if (mCollege) facts.push(profile.college && isSameCollege(profile.college, mCollege) ? `same college (${mCollege})` : `studied at ${mCollege}`);
  else gaps.push('college');

  if (mBranch) {
    if (profile.branch && isSameBranch(profile.branch, mBranch)) facts.push(`same branch (${mBranch})`);
    else facts.push(profile.branch ? `${mBranch} branch, not yours (${profile.branch})` : `${mBranch} branch`);
  } else gaps.push('branch');

  if (m.companyDomain) facts.push(`${m.companyDomain} career path`);
  const companies = (m.topCompanies || []).slice(0, 3);
  if (companies.length) facts.push(`profile lists ${companies.join(', ')}`);

  const wanted = (profile.companies || []).filter(c =>
    !companies.some(x => x.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(x.toLowerCase())));
  if (wanted.length) gaps.push(`experience at ${wanted.join(', ')}`);

  return `${facts.join('; ')}${gaps.length ? `. Not listed: ${gaps.join(', ')}` : ''}.`;
}

async function freeSlots(mentor) {
  const av = mentor.availability || {};
  const now = Date.now();
  const cutoff = now + (av.advanceNoticeHours ?? 2) * 3600_000;
  const booked = await Session.find({
    mentorId: mentor._id,
    scheduledAt: { $gte: new Date(now), $lte: new Date(now + (SLOT_DAYS + 1) * 86400_000) },
    status: { $nin: ['cancelled'] },
  }).select('scheduledAt').lean();
  const taken = new Set(booked.map(s => new Date(s.scheduledAt).getTime()));

  const out = [];
  for (let i = 0; i < SLOT_DAYS && out.length < 10; i++) {
    const date = new Date(now + 5.5 * 3600_000 + i * 86400_000).toISOString().slice(0, 10); // IST date
    if ((av.exceptions || []).includes(date)) continue;
    const [y, mo, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const day = (av.dateOverrides || []).find(o => o.date === date) || (av.weekly || []).find(w => w.day === dow);
    for (const slot of [...(day?.slots || [])].sort()) {
      const t = new Date(`${date}T${slot}:00+05:30`).getTime();
      if (t > cutoff && !taken.has(t)) out.push(t);
      if (out.length >= 10) break;
    }
  }
  return out;
}

// The closest real senior answer (not the student's own), as a story for the reply.
function seniorExample(cards = [], selfId) {
  const c = cards.find(x => x?.mentor?._id && String(x.mentor._id) !== String(selfId));
  if (!c) return null;
  const edu = eduOf(c.mentor);
  const who = [displayName(c.mentor).split(' ')[0], edu.institutionName || edu.institution, edu.field && `${edu.field} branch`]
    .filter(Boolean).join(', ');
  const ct = c.content || {};
  const story = [ct.situation, ct.whatWorked, ct.mainAnswer].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 600);
  return story ? { text: `${who}: ${story}`, mentorId: String(c.mentor._id) } : null;
}

// ─── Answering ───────────────────────────────────────────────

async function answerQuestion(conv, text, { firstContact = false } = {}) {
  const sessionId = await ensureChatSeeded(conv);
  const chat = await AtyantConversation.findOne({ sessionId }).select('phase pendingAsk messages').lean();
  const midIntake = chat?.phase === 'collecting' && !!chat?.pendingAsk; // answering our follow-up
  let example = null;

  if (!midIntake) {
    // getClarity is DB + embeddings only (no Groq), so run it alongside the classifier.
    const { college, branch, year, goal } = conv.profile;
    const clarity = atyantEngine.getClarity(conv.userId || null, text, { studentContext: { college, branch, year, goal }, mentorLimit: 3 });
    clarity.catch(() => null);
    const kind = await classify(text);
    if (kind === 'greeting') {
      if (firstContact) await sendSticker(conv.waId, 'welcome');
      return wa.sendText(conv.waId, firstContact || !chat?.messages?.length
        ? `${INTRO} What's the one thing you're stuck on?`
        : 'What would you like help with next?');
    }
    if (kind === 'off_topic') {
      return wa.sendText(conv.waId, 'I can only help with internships, placements and careers. What\'s the career question on your mind?');
    }
    if (firstContact) {
      await sendSticker(conv.waId, 'welcome');
      await wa.sendText(conv.waId, INTRO);
      keepTyping(conv.waId); // sending the intro cleared "typing…"
    }
    conv.lastQuestion = text.slice(0, 1000);

    // A senior has already answered almost exactly this: send their own words, labelled as theirs.
    const r = await clarity;
    const card = r.answerCard;
    if (card && String(card.mentor?._id) !== String(conv.userId)) {
      const body = `*From ${displayName(card.mentor)}'s own experience* (their words, from a similar question):\n\n${formatCard(card.content)}`;
      conv.lastAnswer = body;
      conv.matchIds = [card.mentor?._id, ...(r.mentors || []).map(m => m._id)].filter(Boolean).map(String);
      logFunnel('wa_answer', { userId: conv.userId, props: { kind: 'card' } });
      return offerNext(conv, body);
    }
    example = seniorExample(r.answerCards, conv.userId);
  }

  const res = await processAtyantMessage(sessionId, text, conv.userId || null, null, { answerFirst: true, example: example?.text });
  syncProfile(conv, res.context);
  await saveProfileToUser(conv);
  conv.lastAnswer = res.reply;
  conv.matchIds = [example?.mentorId, ...(res.matchedMentors || []).map(m => m.id)]
    .filter(id => id && id !== String(conv.userId));
  logFunnel('wa_answer', { userId: conv.userId, props: { kind: res.phase, matches: conv.matchIds.length } });

  if (res.phase !== 'engine') return wa.sendText(conv.waId, res.reply);

  // The top matches often don't sell calls; look further down the same ranking.
  if (!(await loadSeniors(conv.matchIds, conv.userId)).length) {
    const { college, branch, year, goal } = conv.profile;
    const more = await atyantEngine.matchMentorsForChat(conv.userId || null,
      [conv.lastQuestion, goal].filter(Boolean).join('\n'), { college, branch, year, goal }, 15).catch(() => ({ mentors: [] }));
    conv.matchIds = [...conv.matchIds, ...(more.mentors || []).map(m => String(m._id))];
  }
  return offerNext(conv, res.reply);
}

// Invite is worth offering when we know their college and no matched senior is from it.
async function inviteWorthOffering(conv) {
  if (!conv.profile.college) return false;
  if (!conv.matchIds.length) return true;
  const rows = await User.find({ _id: { $in: conv.matchIds.slice(0, 15) } }).select('education').lean();
  return !rows.some(m => isSameCollege(conv.profile.college, eduOf(m).institutionName || eduOf(m).institution));
}

// After an answer: a soft senior offer (only if one takes calls), an invite
// offer when no senior from their college is on Atyant, then New chat / End chat.
async function offerNext(conv, answer) {
  const seniors = await loadSeniors(conv.matchIds, conv.userId);
  const canInvite = await inviteWorthOffering(conv);
  const buttons = [];
  if (seniors.length) buttons.push({ id: 'seniors', title: 'Show seniors' });
  if (canInvite) buttons.push({ id: 'invite', title: 'Invite a senior' });
  for (const b of CHAT_BUTTONS) if (buttons.length < 3) buttons.push(b);

  const parts = [answer];
  if (seniors.length) parts.push('Want to hear it from a senior who\'s been on this path? I\'ll show what each one has in common with you first.');
  if (canInvite) parts.push(`No senior from ${conv.profile.college} is on Atyant for this yet. I can find some on LinkedIn and write the invite for you. You earn a free credit once they join and help a student.`);
  if (!buttons.some(b => b.id === 'chat:new')) parts.push('_Type *new chat* anytime to switch topics._');
  return sendWithButtons(conv.waId, parts.join('\n\n'), buttons, 'Keep going, or:');
}

// ─── Invite a senior (shared rules with the website: MentorInviteService) ─

const INVITE_STATUS = {
  sent: 'invite ready, not opened yet',
  opened: 'opened your link',
  signed_up: 'joined Atyant 🎉',
  onboarded: 'now a mentor on Atyant',
  rewarded: 'credit earned 🎉',
  needs_review: 'being reviewed',
};

async function startInvite(conv) {
  if (!conv.userId) {
    conv.pendingAction = 'invite';
    conv.state = 'booking_email';
    return wa.sendText(conv.waId, 'To make your invite link, I need your email, so we can tell you when your senior joins. What\'s your email?');
  }
  if (!conv.profile.college) {
    conv.state = 'invite_college';
    return wa.sendText(conv.waId, 'Which college are you from? I\'ll look for seniors from there.');
  }
  return showInviteCandidates(conv);
}

async function showInviteCandidates(conv) {
  const { college, branch, year, goal, companies } = conv.profile;
  let seniors = conv.inviteCandidates || [];
  if (!seniors.length) {
    const recent = (conv.inviteSearches || []).filter(d => Date.now() - new Date(d).getTime() < 3600_000);
    if (recent.length >= 5) return wa.sendText(conv.waId, 'You\'ve run a lot of searches this hour. Try again in a little while.');
    conv.inviteSearches = [...recent, new Date()];
    const { seniors: found = [] } = await findSeniors(
      { identity: { college, branch, year }, target: goal || null, targetCompanies: companies || [] }, 6,
    ).catch(err => { console.error('WA senior search failed:', err.message); return {}; });
    seniors = found.map(s => ({ name: s.name, headline: s.headline, linkedinUrl: s.linkedinUrl }));
    conv.inviteCandidates = seniors;
    logFunnel('invite_seniors_shown', { funnelId: chatSessionId(conv.waId), userId: conv.userId, props: { count: seniors.length, via: 'whatsapp' } });
  }
  if (!seniors.length) {
    return wa.sendText(conv.waId, `I couldn't find seniors from ${college} on LinkedIn for this right now. Ask me another question, or try again later.`);
  }
  const lines = seniors.map((s, i) => `${i + 1}. *${s.name}*${s.headline ? `: ${s.headline}` : ''}`).join('\n');
  await wa.sendText(conv.waId, `*Seniors from ${college} on LinkedIn*\nThey aren't on Atyant yet. These are public LinkedIn profiles I haven't verified.\n\n${lines}`);
  return wa.sendList(conv.waId, 'Pick one and I\'ll write a short invite you can send them.', 'Choose senior',
    seniors.map((s, i) => ({ id: `inv:${i}`, title: s.name, description: s.headline || 'LinkedIn profile' })));
}

async function pickInvite(conv, index) {
  const senior = (conv.inviteCandidates || [])[index];
  if (!senior) return wa.sendText(conv.waId, 'That list expired. Tap *Invite a senior* again.');
  const sessionId = chatSessionId(conv.waId);
  const chat = await AtyantConversation.findOne({ sessionId }).select('context userId').lean();
  const ownChat = chat && String(chat.userId) === String(conv.userId);

  let result;
  try {
    result = await createInvite({
      inviterId: conv.userId,
      sessionId: ownChat ? sessionId : null,
      context: ownChat ? chat.context : null,
      senior,
    });
  } catch (err) {
    if (err instanceof InviteError) return wa.sendText(conv.waId, `${err.message}.`);
    throw err;
  }
  logFunnel('wa_invite_created', { userId: conv.userId, props: { code: result.invite.code } });

  const first = senior.name.split(' ')[0];
  const credits = `${INVITE_REWARD_CREDITS} free Atyant credit${INVITE_REWARD_CREDITS === 1 ? '' : 's'}`;
  await wa.sendText(conv.waId,
    `Invite ready for *${senior.name}* ✅\n\n1. Open their LinkedIn: ${senior.linkedinUrl}\n2. Tap *Connect*, then *Add a note*, and paste the note I'm sending next.\n\nWhen ${first} joins Atyant and finishes a first session with a student, you get ${credits}. Type *my invites* anytime to check.`);
  await wa.sendText(conv.waId, result.note);
  return wa.sendButtons(conv.waId, 'Want to invite another senior?',
    [{ id: 'invite', title: 'Invite another' }, { id: 'invites:mine', title: 'My invites' }, { id: 'chat:end', title: 'End chat' }]);
}

async function showMyInvites(conv) {
  const list = conv.userId
    ? await MentorInvite.find({ inviterId: conv.userId }).sort({ createdAt: -1 }).limit(10).select('senior.name status').lean()
    : [];
  if (!list.length) return wa.sendText(conv.waId, 'You haven\'t invited any seniors yet. Type *invite a senior* to start.');
  const lines = list.map(i => `• *${i.senior.name}*: ${INVITE_STATUS[i.status] || i.status}`).join('\n');
  return wa.sendText(conv.waId, `*Your invites*\n${lines}`);
}

// After email/OTP: carry on with whatever the student was doing.
async function resumeAfterAccount(conv) {
  const action = conv.pendingAction;
  conv.pendingAction = null;
  if (action === 'invite') {
    conv.state = 'chat';
    return startInvite(conv);
  }
  return askConsent(conv);
}

// Old answers still carry 👍/👎 buttons.
async function recordFeedback(conv, value) {
  await recordAtyantChatFeedback(chatSessionId(conv.waId), conv.lastAnswer, value).catch(() => null);
  logFunnel('wa_feedback', { userId: conv.userId, props: { value } });
  return wa.sendText(conv.waId, value === 'up'
    ? 'Glad that helped. Ask me anything else whenever you\'re ready.'
    : 'Thanks for telling me. What was missing? Tell me a bit more and I\'ll try again.');
}

// New chat: fresh topic, but remembered facts stay (and we say which).
async function startNewChat(conv) {
  await AtyantConversation.deleteOne({ sessionId: chatSessionId(conv.waId) });
  conv.lastAnswer = '';
  conv.matchIds = [];
  conv.inviteCandidates = [];
  const known = [conv.profile.branch, conv.profile.college].filter(Boolean).join(' at ');
  logFunnel('wa_new_chat', { userId: conv.userId });
  return wa.sendText(conv.waId, `Fresh start.${known ? ` I still remember you're ${known} (tell me if that's changed).` : ''} What do you want help with?`);
}

async function askEndFeedback(conv) {
  return wa.sendButtons(conv.waId, 'Before you go: was this chat useful?',
    [{ id: 'end:up', title: '👍 Useful' }, { id: 'end:down', title: '👎 Not useful' }]);
}

async function endChat(conv, value) {
  await recordAtyantChatFeedback(chatSessionId(conv.waId), conv.lastAnswer, value).catch(() => null);
  logFunnel('wa_feedback', { userId: conv.userId, props: { value, at: 'end' } });
  await AtyantConversation.deleteOne({ sessionId: chatSessionId(conv.waId) });
  conv.lastAnswer = '';
  conv.matchIds = [];
  conv.state = 'chat';
  if (value === 'up') await sendSticker(conv.waId, 'bye');
  return wa.sendText(conv.waId, value === 'up'
    ? 'Chat closed. All the best! Message me anytime to start a new one.'
    : 'Chat closed. Sorry it missed the mark. Next time, tell me a bit more about your situation and I\'ll do better. Message me anytime.');
}

// ─── Seniors → booking ───────────────────────────────────────

async function showSeniors(conv) {
  const seniors = await loadSeniors(conv.matchIds, conv.userId);
  const withSlots = [];
  for (const m of seniors.slice(0, 5)) {
    const slots = await freeSlots(m);
    if (slots.length) withSlots.push({ m, next: slots[0] });
    if (withSlots.length === 3) break;
  }
  if (!withSlots.length) {
    return wa.sendText(conv.waId, 'None of the seniors who match you have free slots this week. Keep asking me here, and check back in a few days.');
  }
  const lines = withSlots.map(({ m }, i) => `${i + 1}. *${displayName(m)}*: ${fitLine(m, conv.profile)}`).join('\n\n');
  await wa.sendText(conv.waId, `*Seniors you can talk to*\n\n${lines}\n\nThese details come from each senior's Atyant profile.`);
  return wa.sendList(conv.waId, 'Pick a senior to see the call details. Nothing is booked yet.', 'Choose senior',
    withSlots.map(({ m, next }) => ({ id: `senior:${m._id}`, title: displayName(m), description: `25-min call · ₹99 · next ${fmtWhen(next)}` })));
}

async function showBookingCard(conv, mentorId) {
  const [mentor] = await loadSeniors([mentorId], conv.userId);
  if (!mentor) return wa.sendText(conv.waId, 'That senior isn\'t taking calls right now. Ask me anything else.');
  const slots = await freeSlots(mentor);
  if (!slots.length) return wa.sendText(conv.waId, `${displayName(mentor)} has no free slots in the next ${SLOT_DAYS} days.`);

  const service = getService(SERVICE_ID);
  conv.state = 'pick_slot';
  conv.mentorId = mentor._id;
  const topic = conv.lastQuestion ? `your question ("${conv.lastQuestion.slice(0, 140)}")` : 'your question';
  await wa.sendText(conv.waId, [
    `*${service.duration} audio call with ${displayName(mentor)}*`,
    `*Why them:* ${fitLine(mentor, conv.profile)}`,
    `*What you'll cover:* ${topic}, plus your resume and next steps. Audio only, no video.`,
    `*Price:* ₹${service.price}, paid by UPI or card through Razorpay.`,
    `*Refunds:* ${REFUND_TERMS}`,
  ].join('\n\n'));
  return wa.sendList(conv.waId, 'Pick a time (IST). You\'ll confirm before anything is booked.', 'See times',
    slots.map(t => ({ id: `slot:${mentor._id}:${t}`, title: fmtWhen(t) })));
}

async function chooseSlot(conv, mentorId, ms) {
  const [mentor] = await loadSeniors([mentorId], conv.userId);
  if (!mentor) return wa.sendText(conv.waId, 'That senior isn\'t taking calls right now. Ask me anything else.');
  if (!(await freeSlots(mentor)).includes(ms)) {
    await wa.sendText(conv.waId, 'That time was just taken. Here are the others:');
    return showBookingCard(conv, mentor._id);
  }
  conv.mentorId = mentor._id;
  conv.pendingSlot = ms;
  if (!conv.userId) {
    conv.pendingAction = 'book';
    conv.state = 'booking_email';
    return wa.sendText(conv.waId, 'To book, I need your email for the confirmation and the call link. What\'s your email?');
  }
  return askConsent(conv);
}

async function askConsent(conv) {
  const mentor = await User.findById(conv.mentorId).select('name username').lean();
  conv.state = 'confirm';
  const service = getService(SERVICE_ID);
  return wa.sendButtons(conv.waId,
    `Before I book: I'll share your name, email and question with ${displayName(mentor)} so they can prepare. Your phone number stays private.\n\n${fmtWhen(conv.pendingSlot)} IST · ${service.duration} · ₹${service.price}`,
    [{ id: 'confirm:yes', title: 'Yes, book it' }, { id: 'confirm:no', title: 'Cancel' }]);
}

// ─── Account (only when booking) ─────────────────────────────

async function uniqueUsername(seed) {
  const base = (String(seed || 'student').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'student').padEnd(3, '0');
  for (let i = 0; i < 6; i++) {
    const candidate = `${base}_${crypto.randomInt(1000, 99999)}`;
    if (!(await User.exists({ username: candidate }))) return candidate;
  }
  return `student_${crypto.randomBytes(5).toString('hex')}`;
}

async function handleEmail(conv, text) {
  const email = text.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return wa.sendText(conv.waId, 'That doesn\'t look like an email. Please type it like name@example.com, or type *cancel* to stop booking.');

  if (await User.exists({ email })) {
    const otp = crypto.randomInt(100000, 1000000);
    conv.pendingEmail = email;
    conv.otpHash = hashOtp(otp);
    conv.otpExpires = new Date(Date.now() + 10 * 60_000);
    conv.otpAttempts = 0;
    conv.state = 'otp';
    await sendSignupOTPEmail(email, otp);
    return wa.sendText(conv.waId, `That email already has an Atyant account. I've sent a 6-digit code to ${email}. Type it here to continue.\n\n(Wrong email? Type *change*.)`);
  }

  const p10 = phone10(conv.waId);
  const user = await User.create({
    username: await uniqueUsername(conv.name || email.split('@')[0]),
    name: conv.name || null,
    email,
    password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
    ...(p10 && !(await User.exists({ phone: p10 })) ? { phone: p10 } : {}),
    role: 'user',
  });
  conv.userId = user._id;
  await AtyantConversation.updateOne({ sessionId: chatSessionId(conv.waId) }, { $set: { userId: user._id } });
  await saveProfileToUser(conv);
  logFunnel('wa_signup', { userId: user._id, props: { source: 'whatsapp' } });
  return resumeAfterAccount(conv);
}

async function handleOtp(conv, text) {
  if (/^change$/i.test(text)) {
    conv.state = 'booking_email';
    conv.pendingEmail = conv.otpHash = null;
    return wa.sendText(conv.waId, 'Okay, type your email.');
  }
  const code = text.replace(/\D/g, '');
  if (!conv.otpExpires || conv.otpExpires < new Date() || conv.otpAttempts >= 5) {
    conv.state = 'booking_email';
    conv.pendingEmail = conv.otpHash = null;
    return wa.sendText(conv.waId, 'That code expired. Type your email again and I\'ll send a new one.');
  }
  if (code.length !== 6 || hashOtp(code) !== conv.otpHash) {
    conv.otpAttempts += 1;
    return wa.sendText(conv.waId, 'That code doesn\'t match. Try again, or type *change* to use another email.');
  }
  const user = await User.findOne({ email: conv.pendingEmail });
  if (!user) {
    conv.state = 'booking_email';
    return wa.sendText(conv.waId, 'Couldn\'t find that account any more. Type your email again.');
  }
  const p10 = phone10(conv.waId);
  if (p10 && !user.phone && !(await User.exists({ phone: p10 }))) {
    user.phone = p10;
    await user.save();
  }
  conv.userId = user._id;
  conv.pendingEmail = conv.otpHash = conv.otpExpires = null;
  await AtyantConversation.updateOne({ sessionId: chatSessionId(conv.waId) }, { $set: { userId: user._id } });
  await saveProfileToUser(conv);
  return resumeAfterAccount(conv);
}

// ─── Payment ─────────────────────────────────────────────────

async function cancelPending(conv) {
  if (!conv.sessionId) return;
  const old = await Session.findOne({ _id: conv.sessionId, status: 'pending', paymentStatus: 'created' });
  if (!old) return;
  old.status = 'cancelled';
  await old.save();
  if (old.razorpayPaymentLinkId && razorpay) {
    await razorpay.paymentLink.cancel(old.razorpayPaymentLinkId).catch(() => null);
  }
}

async function createBooking(conv) {
  const ms = conv.pendingSlot;
  const [mentor] = await loadSeniors([conv.mentorId], conv.userId);
  if (!mentor || !ms) {
    conv.state = 'chat';
    return wa.sendText(conv.waId, 'That booking expired. Tap *Show seniors* under an answer to start again.');
  }
  if (!(await freeSlots(mentor)).includes(ms)) {
    await wa.sendText(conv.waId, 'That time was just taken. Here are the others:');
    return showBookingCard(conv, mentor._id);
  }
  if (!razorpay) return wa.sendText(conv.waId, 'Payments are down for a moment. Please try again shortly.');

  await cancelPending(conv);

  const service = getService(SERVICE_ID);
  const mentorName = displayName(mentor);
  const user = await User.findById(conv.userId).select('name username email').lean();
  const session = await Session.create({
    userId: conv.userId, mentorId: mentor._id, mentorName, mentorInitials: initials(mentorName),
    topic: (conv.lastQuestion || service.label).slice(0, 200), serviceId: SERVICE_ID,
    scheduledAt: new Date(ms), durationMin: service.durationMin,
    status: 'pending', amount: service.price, currency: 'INR', paymentStatus: 'created',
  });

  let link;
  try {
    link = await razorpay.paymentLink.create({
      amount: service.price * 100,
      currency: 'INR',
      accept_partial: false,
      description: `${service.label} with ${mentorName}`.slice(0, 2048),
      reference_id: String(session._id),
      expire_by: Math.floor(Date.now() / 1000) + LINK_TTL_MIN * 60,
      customer: { name: user?.name || user?.username || conv.name || 'Student', email: user?.email, contact: `+${conv.waId}` },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { sessionId: String(session._id), source: 'whatsapp' },
    });
  } catch (err) {
    console.error('WA payment link failed:', err?.error?.description || err.message);
    session.status = 'cancelled';
    await session.save();
    return wa.sendText(conv.waId, 'Couldn\'t create the payment link. Please pick the time again in a minute.');
  }

  session.razorpayPaymentLinkId = link.id;
  await session.save();
  conv.state = 'payment_pending';
  conv.sessionId = session._id;
  conv.pendingSlot = null;
  logFunnel('wa_payment_link', { userId: conv.userId, props: { sessionId: String(session._id) } });

  return wa.sendText(conv.waId,
    `*${service.duration} call with ${mentorName}*\n${fmtWhen(ms)} IST\n\nPay ₹${service.price} here (valid ${LINK_TTL_MIN} min):\n${link.short_url}\n\nYour call link comes here right after you pay. ${REFUND_TERMS}`);
}

// Called from the Razorpay webhook once a WhatsApp booking is paid.
export async function notifyBookingConfirmed(session) {
  const conv = await WaConversation.findOne({ sessionId: session._id });
  if (!conv) return;
  conv.state = 'chat';
  await conv.save();
  await sendSticker(conv.waId, 'celebrate');
  await wa.sendText(conv.waId,
    `✅ Booked: call with ${session.mentorName}\n${fmtWhen(session.scheduledAt)} IST\n\n${session.meetingLink ? `Join here: ${session.meetingLink}\n\n` : ''}Details are in your email too. Keep asking me anything here.`);
}

// ─── Entry point ─────────────────────────────────────────────

function readInput(msg) {
  const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
  if (reply) return { text: reply.title || '', replyId: reply.id };
  if (msg.type === 'button') return { text: msg.button?.text || '', replyId: msg.button?.payload || null };
  if (msg.type === 'text') return { text: (msg.text?.body || '').trim(), replyId: null };
  if (msg.type === 'sticker') return { text: '', replyId: null, sticker: true };
  if (msg.type === 'reaction') return { text: '', replyId: null, reaction: true };
  return { text: '', replyId: null, unsupported: true };
}

async function route(conv, msg, isFirstContact) {
  const { text, replyId, unsupported, sticker, reaction } = readInput(msg);
  if (LEGACY_STATES.has(conv.state)) conv.state = 'chat';

  // Existing account on this number: link quietly, no questions asked.
  if (!conv.userId) {
    const p10 = phone10(conv.waId);
    const user = p10 ? await User.findOne({ phone: p10 }).select('_id').lean() : null;
    if (user) conv.userId = user._id;
  }

  if (reaction) return null; // a 👍 on our message needs no reply
  if (sticker) {
    await sendSticker(conv.waId, 'reply');
    return wa.sendText(conv.waId, isFirstContact
      ? `😄 Love the sticker! ${INTRO} What's the one thing you're stuck on?`
      : '😄 Got your sticker! What can I help with: internships, placements, your resume?');
  }
  if (unsupported) return wa.sendText(conv.waId, 'I can read text and stickers for now. Please type your message.');

  if (replyId === 'fb:up' || replyId === 'fb:down') return recordFeedback(conv, replyId === 'fb:up' ? 'up' : 'down');
  if (replyId === 'invite') return startInvite(conv);
  if (replyId?.startsWith('inv:')) return pickInvite(conv, Number(replyId.slice(4)));
  if (replyId === 'invites:mine') return showMyInvites(conv);
  if (replyId === 'chat:new') return startNewChat(conv);
  if (replyId === 'chat:end') return askEndFeedback(conv);
  if (replyId === 'end:up' || replyId === 'end:down') return endChat(conv, replyId === 'end:up' ? 'up' : 'down');
  if (replyId === 'seniors') return showSeniors(conv);
  if (replyId?.startsWith('senior:') || replyId?.startsWith('book:')) return showBookingCard(conv, replyId.split(':')[1]);
  if (replyId?.startsWith('slot:')) {
    const [, mentorId, ms] = replyId.split(':');
    return chooseSlot(conv, mentorId, Number(ms));
  }
  if (replyId === 'confirm:yes') return createBooking(conv);
  if (replyId === 'confirm:no' || (/^cancel$/i.test(text) && ['booking_email', 'otp', 'confirm', 'pick_slot', 'invite_college'].includes(conv.state))) {
    conv.state = 'chat';
    conv.pendingSlot = null;
    conv.pendingAction = null;
    return wa.sendText(conv.waId, 'No problem. Nothing was booked or shared. Ask me anything else.');
  }
  if (replyId === 'ask') {
    conv.state = 'chat';
    return wa.sendText(conv.waId, 'What would you like help with?');
  }
  if (/^(cancel|stop)$/i.test(text)) return wa.sendText(conv.waId, 'Nothing is booked or pending. Ask me anything whenever you\'re ready.');

  if (conv.state === 'booking_email') return handleEmail(conv, text);
  if (conv.state === 'otp') return handleOtp(conv, text);
  if (conv.state === 'invite_college') {
    if (!text) return wa.sendText(conv.waId, 'Which college are you from?');
    conv.profile.college = text.slice(0, 120);
    conv.state = 'chat';
    return startInvite(conv);
  }

  // Typed shortcuts, same as the buttons.
  const cmd = text.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (cmd === 'new chat') return startNewChat(conv);
  if (cmd === 'end chat') return askEndFeedback(conv);
  if (/^my invites?$/.test(cmd)) return showMyInvites(conv);
  if (/^invite( a)?( my)? (senior|seniors|mentor|mentors)$/.test(cmd)) return startInvite(conv);

  if (!text) return wa.sendText(conv.waId, 'What would you like help with?');
  conv.state = 'chat';
  return answerQuestion(conv, text, { firstContact: isFirstContact });
}

export async function handleInbound(msg, contactName) {
  if (!msg?.id || !msg?.from) return;
  if (msg.type !== 'reaction') wa.showTyping(msg.id); // first thing, before DB or AI work
  return serialize(msg.from, () => handleOne(msg, contactName));
}

async function handleOne(msg, contactName) {
  let conv;
  try {
    // Atomic dedupe: WhatsApp retries deliveries, so each message id is handled once.
    conv = await WaConversation.findOneAndUpdate(
      { waId: msg.from, seenIds: { $ne: msg.id } },
      {
        $push: { seenIds: { $each: [msg.id], $slice: -20 } },
        $set: { lastInboundAt: new Date() },
        $setOnInsert: { name: contactName || '' },
      },
      { new: true, upsert: true, includeResultMetadata: true },
    );
  } catch (err) {
    if (err?.code === 11000) return; // duplicate delivery of a message we already handled
    throw err;
  }
  const isFirstContact = !conv.lastErrorObject?.updatedExisting;
  const doc = conv.value;
  let refresh = null;
  if (msg.type !== 'reaction') {
    typingFor.set(doc.waId, msg.id);
    keepTyping(doc.waId); // a reply to an earlier queued message may have cleared it
    refresh = setInterval(() => keepTyping(doc.waId), 20000);
  }

  try {
    await route(doc, msg, isFirstContact);
  } catch (err) {
    console.error('WA route error:', err);
    const busy = (err?.status || err?.response?.status) === 429;
    await wa.sendText(doc.waId, busy
      ? 'A lot of students are messaging me right now 😅 Give me a minute, then send that again — I\'ll answer properly.'
      : 'Something went wrong on my side. Please send that again in a minute.').catch(() => null);
  } finally {
    clearInterval(refresh);
    if (typingFor.get(doc.waId) === msg.id) typingFor.delete(doc.waId);
    await doc.save().catch(err => console.error('WA conversation save failed:', err.message));
  }
}
