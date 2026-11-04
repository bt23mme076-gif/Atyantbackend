// WhatsApp conversion loop: onboard → ask → instant AnswerCard or senior match
// → ₹99 audio call via Razorpay Payment Link. Deterministic state machine; the
// LLM only routes messages (career / greeting / off-topic) so the bot stays a
// career-guidance service, not a general-purpose chatbot (Meta policy).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import User from '../../models/User.js';
import Session from '../../models/Session.js';
import WaConversation from '../../models/WaConversation.js';
import atyantEngine from '../AtyantEngine.js';
import { groqJSON } from '../../utils/groqClient.js';
import { sendSignupOTPEmail } from '../../utils/emailService.js';
import { getService } from '../../config/serviceCatalog.js';
import { logFunnel } from '../../utils/funnel.js';
import * as wa from './WhatsAppClient.js';

const SERVICE_ID = 'audio-call';
const LINK_TTL_MIN = 20;            // < StalePendingCron's 30 min, so a link never outlives its slot hold
const SLOT_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

const YEARS = [
  { id: 'year:1', title: '1st year' }, { id: 'year:2', title: '2nd year' },
  { id: 'year:3', title: '3rd year' }, { id: 'year:4', title: '4th year' },
  { id: 'year:grad', title: 'Graduated' },
];

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'YM';
const phone10 = (waId) => (waId.startsWith('91') && waId.length === 12 ? waId.slice(2) : null);
const fmtWhen = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

function mentorLabel(m = {}) {
  const edu = Array.isArray(m.education) ? m.education[0] : m.education;
  const college = edu?.institutionName || edu?.institution;
  const company = m.topCompanies?.[0];
  return [m.name || m.username || 'A senior', college, company].filter(Boolean).join(' · ');
}

function formatCard(content = {}, mentor) {
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
  parts.push(`— ${mentorLabel(mentor)}`);
  return parts.join('\n\n');
}

const studentContext = (conv) => ({
  college: conv.profile.college, branch: conv.profile.branch, year: conv.profile.year, goal: conv.profile.goal,
});

async function classify(text) {
  try {
    const r = await groqJSON([
      {
        role: 'system',
        content: 'You route messages sent to Atyant on WhatsApp. Atyant helps Indian engineering students with internships, placements, jobs, interview prep, resumes, skills, higher studies and booking calls with seniors. Return JSON {"type":"career"|"greeting"|"off_topic"}. career = any question about those topics. greeting = hi/thanks/ok with no question. off_topic = anything else, including writing essays or assignments, solving homework or code, general knowledge and chit-chat.',
      },
      { role: 'user', content: text.slice(0, 1000) },
    ], { maxTokens: 30, timeoutMs: 8000 });
    return ['career', 'greeting', 'off_topic'].includes(r?.type) ? r.type : 'career';
  } catch {
    return 'career';
  }
}

// ─── Onboarding ──────────────────────────────────────────────

async function uniqueUsername(seed) {
  const base = (String(seed || 'student').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'student').padEnd(3, '0');
  for (let i = 0; i < 6; i++) {
    const candidate = `${base}_${crypto.randomInt(1000, 99999)}`;
    if (!(await User.exists({ username: candidate }))) return candidate;
  }
  return `student_${crypto.randomBytes(5).toString('hex')}`;
}

// After a user is linked: skip profile questions the account already answers.
async function continueProfile(conv) {
  const user = await User.findById(conv.userId).select('education').lean();
  const edu = user?.education?.[0] || {};
  conv.profile.college ||= edu.institutionName || edu.institution || '';
  conv.profile.branch  ||= edu.field || '';
  conv.profile.year    ||= edu.year || '';
  if (!conv.profile.college) return askStep(conv, 'college');
  if (!conv.profile.branch)  return askStep(conv, 'branch');
  if (!conv.profile.year)    return askStep(conv, 'year');
  if (!conv.profile.goal)    return askStep(conv, 'goal');
  conv.state = 'ready';
  return wa.sendText(conv.waId, 'You\'re all set. Type your question, e.g. "How do I prepare for the Amazon SDE internship from 2nd year?"');
}

async function askStep(conv, step) {
  conv.state = step;
  if (step === 'college') return wa.sendText(conv.waId, 'Which college are you in? (e.g. VNIT Nagpur)');
  if (step === 'branch')  return wa.sendText(conv.waId, 'Your branch? (e.g. Mechanical, CSE, Metallurgy)');
  if (step === 'year')    return wa.sendList(conv.waId, 'Which year are you in?', 'Pick year', YEARS);
  if (step === 'goal')    return wa.sendText(conv.waId, 'What are you aiming for? (e.g. "SDE internship at Amazon", "core job in automobile", "consulting placement")');
}

async function saveProfileToUser(conv) {
  const user = await User.findById(conv.userId).select('education');
  if (!user) return;
  const { college, branch, year } = conv.profile;
  if (user.education?.length) {
    const e = user.education[0];
    if (!e.institutionName && !e.institution) e.institutionName = college;
    if (!e.field) e.field = branch;
    if (!e.year) e.year = year;
  } else {
    user.education = [{ institutionName: college, field: branch, year }];
  }
  user.markModified('education');
  await user.save();
}

async function handleEmail(conv, text, isFirstContact) {
  const email = text.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    const hello = isFirstContact
      ? `Hi${conv.name ? ` ${conv.name.split(' ')[0]}` : ''} 👋 This is Atyant. Ask any internship or placement question and get answers from seniors who were in your exact spot: same college type, same branch.\n\n`
      : '';
    return wa.sendText(conv.waId, `${hello}First, your email? Session links and answers are sent there too.`);
  }

  const existing = await User.findOne({ email }).select('_id').lean();
  if (existing) {
    const otp = crypto.randomInt(100000, 1000000);
    conv.pendingEmail = email;
    conv.otpHash = hashOtp(otp);
    conv.otpExpires = new Date(Date.now() + 10 * 60_000);
    conv.otpAttempts = 0;
    conv.state = 'otp';
    await sendSignupOTPEmail(email, otp);
    return wa.sendText(conv.waId, `That email already has an Atyant account. I've sent a 6-digit code to ${email}. Type it here to link this WhatsApp number.\n\n(Wrong email? Type *change*)`);
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
  logFunnel('wa_signup', { userId: user._id, props: { source: 'whatsapp' } });
  return continueProfile(conv);
}

async function handleOtp(conv, text) {
  if (/^change$/i.test(text)) {
    conv.state = 'email';
    conv.pendingEmail = conv.otpHash = null;
    return wa.sendText(conv.waId, 'Okay, type your email.');
  }
  const code = text.replace(/\D/g, '');
  if (!conv.otpExpires || conv.otpExpires < new Date() || conv.otpAttempts >= 5) {
    conv.state = 'email';
    conv.pendingEmail = conv.otpHash = null;
    return wa.sendText(conv.waId, 'That code expired. Type your email again and I\'ll send a new one.');
  }
  if (code.length !== 6 || hashOtp(code) !== conv.otpHash) {
    conv.otpAttempts += 1;
    return wa.sendText(conv.waId, 'That code doesn\'t match. Try again, or type *change* to use another email.');
  }

  const user = await User.findOne({ email: conv.pendingEmail });
  if (!user) {
    conv.state = 'email';
    return wa.sendText(conv.waId, 'Couldn\'t find that account any more. Type your email again.');
  }
  const p10 = phone10(conv.waId);
  if (p10 && !user.phone && !(await User.exists({ phone: p10 }))) {
    user.phone = p10;
    await user.save();
  }
  conv.userId = user._id;
  conv.pendingEmail = conv.otpHash = conv.otpExpires = null;
  return continueProfile(conv);
}

// ─── Questions ───────────────────────────────────────────────

// First mentor (in ranking order) who sells the ₹99 call.
async function firstBookableMentor(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return null;
  const rows = await User.find({ _id: { $in: uniq }, role: 'mentor', servicesOffered: SERVICE_ID })
    .select('name username education topCompanies').lean();
  const byId = new Map(rows.map(r => [String(r._id), r]));
  return uniq.map(id => byId.get(id)).find(Boolean) || null;
}

async function offerCall(conv, mentor, lead) {
  const service = getService(SERVICE_ID);
  return wa.sendButtons(conv.waId,
    `${lead}\n\nTalk to ${mentorLabel(mentor)} directly: ${service.duration} call, ₹${service.price}.`,
    [{ id: `book:${mentor._id}`, title: `Book call ₹${service.price}` }, { id: 'ask', title: 'Ask another' }]);
}

async function answerQuestion(conv, text) {
  const kind = await classify(text);
  if (kind === 'greeting') {
    return wa.sendText(conv.waId, 'Hi! Type any internship, placement or career question and I\'ll find seniors from your background.');
  }
  if (kind === 'off_topic') {
    return wa.sendText(conv.waId, 'I can only help with internships, placements and careers: questions for seniors, and booking calls with them. What would you like to know about your career?');
  }

  conv.lastQuestion = text.slice(0, 1000);
  await wa.sendText(conv.waId, 'Checking what seniors from your background did…');

  const ctx = studentContext(conv);
  const r = await atyantEngine.getClarity(conv.userId, text, { studentContext: ctx, mentorLimit: 3 });
  const card = r.answerCard;
  const mentorIds = [card?.mentor?._id, ...(r.mentors || []).map(m => m._id)];
  logFunnel('wa_question', { userId: conv.userId, props: { instant: !!card, mentors: (r.mentors || []).length } });

  if (card) {
    await wa.sendText(conv.waId, formatCard(card.content, card.mentor));
    const mentor = await firstBookableMentor(mentorIds);
    if (mentor) return offerCall(conv, mentor, 'Want to go deeper on your own situation?');
    return wa.sendText(conv.waId, 'Ask another question anytime.');
  }

  // No ready answer: hand the question to the top senior (existing Path B flow:
  // they're emailed and answer on the dashboard), and offer a call meanwhile.
  const top = r.mentors?.[0];
  const q = await atyantEngine.processQuestion(conv.userId, text, {
    studentContext: ctx, ...(top ? { preferredMentorId: top._id } : {}),
  });
  if (!q?.success) return wa.sendText(conv.waId, 'Something went wrong on my side. Please send that again in a minute.');

  const user = await User.findById(conv.userId).select('email').lean();
  const sent = top
    ? `No ready answer for this yet, so I've sent it to ${mentorLabel(top)}. Their answer will reach ${user?.email} and your atyant.in dashboard.`
    : `No senior from your exact background has answered this yet. I've posted it, and the answer will reach ${user?.email}.`;
  const mentor = await firstBookableMentor(mentorIds);
  if (mentor) return offerCall(conv, mentor, sent);
  return wa.sendText(conv.waId, sent);
}

// ─── Booking ─────────────────────────────────────────────────

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

async function loadBookableMentor(mentorId) {
  return User.findOne({ _id: mentorId, role: 'mentor', servicesOffered: SERVICE_ID })
    .select('name username education topCompanies availability').lean();
}

async function offerSlots(conv, mentorId) {
  const mentor = await loadBookableMentor(mentorId).catch(() => null);
  if (!mentor) return wa.sendText(conv.waId, 'That senior isn\'t taking calls right now. Ask another question and I\'ll find someone else.');
  const slots = await freeSlots(mentor);
  if (!slots.length) {
    return wa.sendText(conv.waId, `${mentor.name || mentor.username} has no free slots in the next ${SLOT_DAYS} days. Ask another question and I'll find someone else.`);
  }
  conv.state = 'pick_slot';
  conv.mentorId = mentor._id;
  return wa.sendList(conv.waId, `Pick a time for your call with ${mentorLabel(mentor)} (IST):`, 'See slots',
    slots.map(t => ({ id: `slot:${mentor._id}:${t}`, title: fmtWhen(t) })));
}

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

async function createBooking(conv, mentorId, ms) {
  const mentor = await loadBookableMentor(mentorId).catch(() => null);
  if (!mentor) return wa.sendText(conv.waId, 'That senior isn\'t taking calls right now. Ask another question and I\'ll find someone else.');
  const slots = await freeSlots(mentor);
  if (!slots.includes(ms)) {
    await wa.sendText(conv.waId, 'That slot was just taken. Pick another:');
    return offerSlots(conv, mentor._id);
  }
  if (!razorpay) return wa.sendText(conv.waId, 'Payments are down for a moment. Please try again shortly.');

  await cancelPending(conv);

  const service = getService(SERVICE_ID);
  const mentorName = mentor.name || mentor.username || 'Your Mentor';
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
    return wa.sendText(conv.waId, 'Couldn\'t create the payment link. Please pick the slot again in a minute.');
  }

  session.razorpayPaymentLinkId = link.id;
  await session.save();
  conv.state = 'payment_pending';
  conv.sessionId = session._id;
  logFunnel('wa_payment_link', { userId: conv.userId, props: { sessionId: String(session._id) } });

  return wa.sendText(conv.waId,
    `*${service.duration} call with ${mentorName}*\n${fmtWhen(ms)} IST\n\nPay ₹${service.price} here (valid ${LINK_TTL_MIN} min):\n${link.short_url}\n\nYour call link comes here right after you pay.`);
}

// Called from the Razorpay webhook once a WhatsApp booking is paid.
export async function notifyBookingConfirmed(session) {
  const conv = await WaConversation.findOne({ sessionId: session._id });
  if (!conv) return;
  conv.state = 'ready';
  await conv.save();
  await wa.sendText(conv.waId,
    `✅ Booked: call with ${session.mentorName}\n${fmtWhen(session.scheduledAt)} IST\n\n${session.meetingLink ? `Join here: ${session.meetingLink}\n\n` : ''}Details are in your email too. Ask another question anytime.`);
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

  if (!conv.userId) {
    const p10 = phone10(conv.waId);
    const user = p10 ? await User.findOne({ phone: p10 }).select('_id').lean() : null;
    if (user) {
      conv.userId = user._id;
      await wa.sendText(conv.waId, `Hi${conv.name ? ` ${conv.name.split(' ')[0]}` : ''} 👋 Found your Atyant account from this number.`);
      return continueProfile(conv);
    }
  }

  if (unsupported) return wa.sendText(conv.waId, 'I can only read text for now. Please type your message.');

  switch (conv.state) {
    case 'email': return handleEmail(conv, text, isFirstContact);
    case 'otp':   return handleOtp(conv, text);
    case 'college':
      if (!text) return askStep(conv, 'college');
      conv.profile.college = text.slice(0, 120);
      return askStep(conv, 'branch');
    case 'branch':
      if (!text) return askStep(conv, 'branch');
      conv.profile.branch = text.slice(0, 80);
      return askStep(conv, 'year');
    case 'year': {
      const picked = YEARS.find(y => y.id === replyId)?.title || text.slice(0, 20);
      if (!picked) return askStep(conv, 'year');
      conv.profile.year = picked;
      return askStep(conv, 'goal');
    }
    case 'goal':
      if (!text) return askStep(conv, 'goal');
      conv.profile.goal = text.slice(0, 200);
      await saveProfileToUser(conv);
      conv.state = 'ready';
      return wa.sendText(conv.waId, 'Done. Now type your question, e.g. "Which skills got seniors from my branch into core companies?"');
    default: break;
  }

  // ready / pick_slot / payment_pending
  if (replyId === 'ask') {
    conv.state = 'ready';
    return wa.sendText(conv.waId, 'Type your question.');
  }
  if (replyId?.startsWith('book:')) return offerSlots(conv, replyId.slice(5));
  if (replyId?.startsWith('slot:')) {
    const [, mentorId, ms] = replyId.split(':');
    return createBooking(conv, mentorId, Number(ms));
  }
  if (!text) return wa.sendText(conv.waId, 'Type your question.');
  conv.state = 'ready';
  return answerQuestion(conv, text);
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
