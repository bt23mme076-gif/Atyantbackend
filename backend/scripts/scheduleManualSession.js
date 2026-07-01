/**
 * Manually schedule a 1:1 session between a mentor and a student — no booking
 * flow, no payment. Used for B2B college pilots where ops pairs people directly.
 *
 * Creates a free Session, generates the LiveKit meet link, and (unless
 * --no-email) emails both parties — identical to a real free booking.
 *
 * Usage:
 *   node scripts/scheduleManualSession.js \
 *     --mentor=mentor@email.com \
 *     --student=student@email.com \
 *     --at="2026-07-02 15:00" \
 *     --topic="Mock Interview" \
 *     --duration=30
 *
 *   --mentor / --student : email, username, or Mongo _id
 *   --at                 : "YYYY-MM-DD HH:mm" or any Date-parseable string (must be future)
 *   --topic              : optional, defaults to "Mock Interview"
 *   --duration           : optional minutes, defaults to 30
 *   --base               : optional frontend base for the meet link, e.g.
 *                          https://atyant.in — overrides the env default so a
 *                          local run still produces a real production link
 *   --no-email           : create the session + link but don't email anyone
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Session from '../models/Session.js';
import liveKitService from '../services/LiveKitService.js';
import { sendSessionConfirmationEmails } from '../utils/emailService.js';
import { meetLinkFor } from '../utils/frontendUrl.js';

// ── Parse --key=value flags ──
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
);

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'YM';

// Resolve a person by email (case-insensitive), username, or _id.
async function resolveUser(idr, label) {
  if (!idr) throw new Error(`Missing --${label}`);
  let user = null;
  if (mongoose.isValidObjectId(idr)) user = await User.findById(idr);
  if (!user) user = await User.findOne({ email: new RegExp(`^${idr}$`, 'i') });
  if (!user) user = await User.findOne({ username: new RegExp(`^${idr}$`, 'i') });
  if (!user) throw new Error(`No user found for --${label}="${idr}"`);
  return user;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set in env');
  await mongoose.connect(process.env.MONGO_URI);

  const mentor  = await resolveUser(args.mentor, 'mentor');
  const student = await resolveUser(args.student, 'student');

  if (String(mentor._id) === String(student._id)) {
    throw new Error('Mentor and student cannot be the same user');
  }
  if (mentor.role !== 'mentor') {
    console.warn(`⚠️  ${mentor.email} has role "${mentor.role || 'student'}", not "mentor" — proceeding anyway.`);
  }

  const scheduledAt = new Date(args.at);
  if (isNaN(scheduledAt.getTime())) throw new Error(`Invalid --at="${args.at}" (use "YYYY-MM-DD HH:mm")`);
  if (scheduledAt < new Date()) throw new Error('--at is in the past');

  const durationMin = Number(args.duration) || 30;
  const topic       = args.topic || 'Mock Interview';
  const mentorName  = mentor.name || mentor.username || 'Your Mentor';

  const session = await Session.create({
    userId: student._id,
    mentorId: mentor._id,
    mentorName,
    mentorInitials: initials(mentorName),
    topic,
    scheduledAt,
    durationMin,
    status: 'upcoming',
    amount: 0,
    paymentStatus: 'free',
  });

  // Build the meet link (independent of LiveKit being reachable from here — the
  // join route re-creates the room idempotently on first join). --base lets a
  // local run emit a real production link instead of localhost.
  session.meetingLink = args.base
    ? `${String(args.base).replace(/\/+$/, '')}/?meet=${session._id}`
    : meetLinkFor(session._id);

  try {
    if (liveKitService.isConfigured()) {
      session.livekitRoomName = await liveKitService.createRoom(session._id);
    }
  } catch (err) {
    console.warn('LiveKit room pre-creation skipped (non-fatal):', err.message);
  }
  await session.save();

  if (!args['no-email']) {
    await sendSessionConfirmationEmails({
      studentEmail: student.email, studentName: student.name || student.username,
      mentorEmail:  mentor.email,  mentorName,
      scheduledAt, durationMin, topic, meetLink: session.meetingLink, amount: 0,
    }).catch(err => console.error('Email send failed (non-fatal):', err.message));
  }

  console.log('\n✅ Session scheduled');
  console.log('   Session ID :', String(session._id));
  console.log('   Mentor     :', mentorName, `<${mentor.email}>`);
  console.log('   Student    :', student.name || student.username, `<${student.email}>`);
  console.log('   When       :', scheduledAt.toLocaleString('en-IN'), `(${durationMin} min)`);
  console.log('   Meet link  :', session.meetingLink);
  console.log('   Emailed    :', args['no-email'] ? 'no (--no-email)' : 'both parties');
  console.log('\n   Both must log in to their Atyant account to join.\n');
}

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('\n❌', err.message, '\n');
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
