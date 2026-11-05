// WhatsApp placement guide: answer first, collect details only when they change
// the advice, then offer a relevant senior call with checked facts. The same
// chat engine as the website writes the answers (answerFirst mode); this file
// owns the deterministic parts: senior facts, booking, payment and consent.
// Off-topic requests are declined so the bot stays a career service, not a
// general-purpose chatbot (Meta policy).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import User from '../../models/User.js';
import Session from '../../models/Session.js';
import WaConversation from '../../models/WaConversation.js';
import AtyantConversation from '../../models/AtyantConversation.js';
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
const GREETING_RE = /^\s*(hi+|hello+|hey+|helo|yo|sup|namaste|ok+|okay|thanks?|thank you|gm|good (morning|evening|afternoon))\s*[!.]*\s*$/i;
const LEGACY_STATES = new Set(['email', 'college', 'branch', 'year', 'goal', 'ready']);
const INTRO = 'Hi, I\'m Atyant. I help engineering students with internships and placements, using advice from seniors who\'ve been there.';
const FEEDBACK_BUTTONS = [{ id: 'fb:up', title: '👍 Helpful' }, { id: 'fb:down', title: '👎 Not really' }];

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

async function classify(text) {
  try {
    const r = await groqJSON([
      {
        role: 'system',
        content: 'You route messages sent to Atyant on WhatsApp. Atyant helps Indian engineering students with internships, placements, jobs, interview prep, resumes, projects, skills, higher studies and booking calls with seniors. Return JSON {"type":"career"|"greeting"|"off_topic"}. career = any question or statement about those topics, including details about themselves (branch, college, year, skills). greeting = hi/thanks/ok with no question. off_topic = anything else, including writing essays or assignments, solving homework or code, general knowledge and chit-chat.',
      },
      { role: 'user', content: text.slice(0, 1000) },
    ], { maxTokens: 30, timeoutMs: 8000 });
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

// ─── Answering ───────────────────────────────────────────────

async function answerQuestion(conv, text, { firstContact = false } = {}) {
  let sessionId = await ensureChatSeeded(conv);
  const chat = await AtyantConversation.findOne({ sessionId }).select('phase pendingAsk messages').lean();
  const midIntake = chat?.phase === 'collecting' && !!chat?.pendingAsk; // answering our follow-up

  if (!midIntake) {
    const kind = await classify(text);
    if (kind === 'greeting') {
      return wa.sendText(conv.waId, firstContact || !chat?.messages?.length
        ? `${INTRO} What's the one thing you're stuck on?`
        : 'What would you like help with next?');
    }
    if (kind === 'off_topic') {
      return wa.sendText(conv.waId, 'I can only help with internships, placements and careers. What\'s the career question on your mind?');
    }
    if (firstContact) await wa.sendText(conv.waId, INTRO);
    if (chat?.phase === 'engine') {
      await AtyantConversation.deleteOne({ sessionId });
      sessionId = await ensureChatSeeded(conv);
    }
    conv.lastQuestion = text.slice(0, 1000);

    // A senior has already answered almost exactly this: send their own words, labelled as theirs.
    const { college, branch, year, goal } = conv.profile;
    const r = await atyantEngine.getClarity(conv.userId || null, text, { studentContext: { college, branch, year, goal }, mentorLimit: 3 });
    const card = r.answerCard;
    if (card && String(card.mentor?._id) !== String(conv.userId)) {
      const body = `*From ${displayName(card.mentor)}'s own experience* (their words, from a similar question):\n\n${formatCard(card.content)}`;
      conv.lastAnswer = body;
      conv.matchIds = [card.mentor?._id, ...(r.mentors || []).map(m => m._id)].filter(Boolean).map(String);
      logFunnel('wa_answer', { userId: conv.userId, props: { kind: 'card' } });
      return offerNext(conv, body);
    }
  }

  const res = await processAtyantMessage(sessionId, text, conv.userId || null, null, { answerFirst: true });
  syncProfile(conv, res.context);
  await saveProfileToUser(conv);
  conv.lastAnswer = res.reply;
  conv.matchIds = (res.matchedMentors || []).map(m => m.id).filter(id => id !== String(conv.userId));
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

// After an answer: feedback, plus a soft offer when a matching senior takes calls.
async function offerNext(conv, answer) {
  const seniors = await loadSeniors(conv.matchIds, conv.userId);
  if (!seniors.length) return sendWithButtons(conv.waId, answer, FEEDBACK_BUTTONS);
  return sendWithButtons(conv.waId,
    `${answer}\n\nWould it help to talk to a senior who's been on this path? I'll show what each one actually has in common with you before you choose.`,
    [...FEEDBACK_BUTTONS, { id: 'seniors', title: 'Show seniors' }],
    'Was this useful, or would a senior help?');
}

async function recordFeedback(conv, value) {
  await recordAtyantChatFeedback(chatSessionId(conv.waId), conv.lastAnswer, value).catch(() => null);
  logFunnel('wa_feedback', { userId: conv.userId, props: { value } });
  return wa.sendText(conv.waId, value === 'up'
    ? 'Glad that helped. Ask me anything else whenever you\'re ready.'
    : 'Thanks for telling me. What was missing? Tell me a bit more about your situation and I\'ll try again.');
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
  return askConsent(conv);
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
  return askConsent(conv);
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
  await wa.sendText(conv.waId,
    `✅ Booked: call with ${session.mentorName}\n${fmtWhen(session.scheduledAt)} IST\n\n${session.meetingLink ? `Join here: ${session.meetingLink}\n\n` : ''}Details are in your email too. Keep asking me anything here.`);
}

// ─── Entry point ─────────────────────────────────────────────

function readInput(msg) {
  const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
  if (reply) return { text: reply.title || '', replyId: reply.id };
  if (msg.type === 'button') return { text: msg.button?.text || '', replyId: msg.button?.payload || null };
  if (msg.type === 'text') return { text: (msg.text?.body || '').trim(), replyId: null };
  return { text: '', replyId: null, unsupported: true };
}

async function route(conv, msg, isFirstContact) {
  const { text, replyId, unsupported } = readInput(msg);
  if (LEGACY_STATES.has(conv.state)) conv.state = 'chat';

  // Existing account on this number: link quietly, no questions asked.
  if (!conv.userId) {
    const p10 = phone10(conv.waId);
    const user = p10 ? await User.findOne({ phone: p10 }).select('_id').lean() : null;
    if (user) conv.userId = user._id;
  }

  if (unsupported) return wa.sendText(conv.waId, 'I can only read text for now. Please type your message.');

  if (replyId === 'fb:up' || replyId === 'fb:down') return recordFeedback(conv, replyId === 'fb:up' ? 'up' : 'down');
  if (replyId === 'seniors') return showSeniors(conv);
  if (replyId?.startsWith('senior:') || replyId?.startsWith('book:')) return showBookingCard(conv, replyId.split(':')[1]);
  if (replyId?.startsWith('slot:')) {
    const [, mentorId, ms] = replyId.split(':');
    return chooseSlot(conv, mentorId, Number(ms));
  }
  if (replyId === 'confirm:yes') return createBooking(conv);
  if (replyId === 'confirm:no' || (/^cancel$/i.test(text) && ['booking_email', 'otp', 'confirm', 'pick_slot'].includes(conv.state))) {
    conv.state = 'chat';
    conv.pendingSlot = null;
    return wa.sendText(conv.waId, 'No problem. Nothing was booked or shared. Ask me anything else.');
  }
  if (replyId === 'ask') {
    conv.state = 'chat';
    return wa.sendText(conv.waId, 'What would you like help with?');
  }
  if (/^(cancel|stop)$/i.test(text)) return wa.sendText(conv.waId, 'Nothing is booked or pending. Ask me anything whenever you\'re ready.');

  if (conv.state === 'booking_email') return handleEmail(conv, text);
  if (conv.state === 'otp') return handleOtp(conv, text);

  if (!text) return wa.sendText(conv.waId, 'What would you like help with?');
  conv.state = 'chat';
  return answerQuestion(conv, text, { firstContact: isFirstContact });
}

export async function handleInbound(msg, contactName) {
  if (!msg?.id || !msg?.from) return;
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

  try {
    await route(doc, msg, isFirstContact);
  } catch (err) {
    console.error('WA route error:', err);
    await wa.sendText(doc.waId, 'Something went wrong on my side. Please send that again in a minute.').catch(() => null);
  } finally {
    await doc.save().catch(err => console.error('WA conversation save failed:', err.message));
  }
}
