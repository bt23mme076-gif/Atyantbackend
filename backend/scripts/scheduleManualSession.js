// ─────────────────────────────────────────────────────────────────────────────
//  Manually schedule a mentor↔student session (in-house LiveKit meet)
//
//  Creates a Session doc directly in Mongo, pre-creates the LiveKit room,
//  builds the meet link, and emails both parties a confirmation.
//
//  USAGE (from backend/ folder):
//    node scripts/scheduleManualSession.js \
//      --mentor=mentor@email.com \
//      --student=student@email.com \
//      --at="2026-07-03 14:10"            # local time; "2:10 PM" also works
//      [--topic="Mock Interview"] [--duration=30]
//      [--base=https://atyant.in/atyantEngine]  # meet-link base (origin + optional sub-path)
//
//  NOTE on --base: the origin AND any sub-path are preserved, so
//  --base=https://atyant.in/atyantEngine yields
//  https://atyant.in/atyantEngine/?meet=<id>. Pass the exact (case-sensitive)
//  path the product app is served under; omit the path for a root-served app.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import User from '../models/User.js';
import liveKitService from '../services/LiveKitService.js';
import { sendSessionConfirmationEmails } from '../utils/emailService.js';
import { meetLinkFor } from '../utils/frontendUrl.js';

// ── CLI args (--key=value) ──
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'YM';

// Accepts "2026-07-03 14:10", "2026-07-03 2:10 PM", or full ISO. Local time.
function parseAt(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Build the meet link from --base, preserving any sub-path the product app is
// served under (e.g. https://atyant.in/atyantEngine → .../atyantEngine/?meet=<id>).
// Falls back to FRONTEND_URL (utils/frontendUrl.js) when --base is absent/invalid.
function meetLinkFromBase(base, sessionId) {
  if (!base) return meetLinkFor(sessionId);
  try {
    const u = new URL(base);
    const path = u.pathname.replace(/\/+$/, ''); // keep sub-path; drop trailing slash(es), '' for root
    return `${u.origin}${path}/?meet=${sessionId}`;
  } catch {
    console.warn(`⚠️  Invalid --base "${base}" — falling back to FRONTEND_URL.`);
    return meetLinkFor(sessionId);
  }
}

async function main() {
  const { mentor: mentorEmail, student: studentEmail, at, topic, duration, base } = args;

  if (!mentorEmail || !studentEmail || !at) {
    console.error('Usage: node scripts/scheduleManualSession.js --mentor=<email> --student=<email> --at="YYYY-MM-DD HH:mm" [--topic=...] [--duration=30] [--base=https://atyant.in]');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in environment variables.');
    process.exit(1);
  }

  const scheduledAt = parseAt(at);
  if (!scheduledAt) {
    console.error(`❌ Could not parse --at="${at}". Use "YYYY-MM-DD HH:mm" (24h) or add AM/PM.`);
    process.exit(1);
  }
  if (scheduledAt < new Date()) {
    console.warn(`⚠️  Scheduled time ${scheduledAt.toLocaleString()} is in the past — creating anyway (manual override).`);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connected');

  const findByEmail = (email) =>
    User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
      .select('name username email');

  const [mentor, student] = await Promise.all([findByEmail(mentorEmail), findByEmail(studentEmail)]);
  if (!mentor) { console.error(`❌ Mentor not found: ${mentorEmail}`); process.exit(1); }
  if (!student) { console.error(`❌ Student not found: ${studentEmail}`); process.exit(1); }

  const mentorName = mentor.name || mentor.username || 'Your Mentor';
  console.log(`🔎 Mentor : ${mentorName} <${mentor.email}> (${mentor._id})`);
  console.log(`🔎 Student: ${student.name || student.username} <${student.email}> (${student._id})`);

  const session = await Session.create({
    userId: student._id,
    mentorId: mentor._id,
    mentorName,
    mentorInitials: initials(mentorName),
    topic: topic || 'Career Guidance Session',
    scheduledAt,
    durationMin: Number(duration) || 30,
    status: 'upcoming',
    paymentStatus: 'free',
  });

  session.meetingLink = meetLinkFromBase(base, session._id);

  // Pre-create the LiveKit room (non-fatal — /api/livekit/join re-creates it
  // idempotently on first join, so a failure here doesn't break the meet).
  try {
    if (liveKitService.isConfigured()) {
      session.livekitRoomName = await liveKitService.createRoom(session._id);
      console.log(`✅ LiveKit room created: ${session.livekitRoomName}`);
    } else {
      console.warn('⚠️  LiveKit not configured in this env — room will be created on first join.');
    }
  } catch (err) {
    console.error('LiveKit room creation failed (non-fatal):', err.message);
  }
  await session.save();

  // Confirmation emails to both parties
  try {
    const res = await sendSessionConfirmationEmails({
      studentEmail: student.email, studentName: student.name || student.username,
      mentorEmail: mentor.email, mentorName,
      scheduledAt: session.scheduledAt, durationMin: session.durationMin,
      topic: session.topic, meetLink: session.meetingLink, amount: 0,
    });
    console.log(res?.success === false ? `⚠️  Emails skipped: ${res.error}` : '📧 Confirmation emails sent to both parties.');
  } catch (err) {
    console.error('Email send failed (non-fatal):', err.message);
  }

  console.log('\n────────── SESSION CREATED ──────────');
  console.log(`Session ID : ${session._id}`);
  console.log(`Topic      : ${session.topic}`);
  console.log(`When       : ${session.scheduledAt.toLocaleString()} (${session.durationMin} min)`);
  console.log(`Meet link  : ${session.meetingLink}`);
  console.log('─────────────────────────────────────');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ scheduleManualSession failed:', err);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
