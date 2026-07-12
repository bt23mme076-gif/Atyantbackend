import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from './models/User.js';
import Session from './models/Session.js';
import SessionTranscript from './models/SessionTranscript.js';

dotenv.config();

const nameQuery = process.argv[2];
if (!nameQuery) { console.error('Usage: node find_student_sessions.mjs <name>'); process.exit(1); }

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({ name: { $regex: nameQuery, $options: 'i' } })
    .select('_id name email role')
    .lean();

  console.log(`=== USERS MATCHING "${nameQuery}" ===\n`);
  if (!users.length) {
    console.log('No matching users found.');
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const u of users) {
    console.log(`User: ${u.name} (${u.role}) — ${u._id} — ${u.email}`);
  }
  console.log('');

  const ids = users.map(u => String(u._id));
  const sessions = await Session.find({
    $or: [{ userId: { $in: ids } }, { mentorId: { $in: ids } }],
  })
    .sort({ scheduledAt: -1 })
    .limit(10)
    .lean();

  console.log(`=== SESSIONS (${sessions.length}) ===\n`);
  for (const s of sessions) {
    console.log(`Session: ${s._id}`);
    console.log(`  Room: ${s.livekitRoomName || 'N/A'}`);
    console.log(`  Status: ${s.status}`);
    console.log(`  Scheduled: ${s.scheduledAt}`);
    console.log(`  Pipeline Status: ${s.pipelineStatus || 'N/A'}`);
    console.log(`  Egress ID: ${s.egressId || 'N/A'}`);
    console.log(`  Egress Attempts: ${s.egressAttempts || 0}`);
    console.log(`  Pipeline Error: ${s.pipelineError || 'None'}`);
    const t = await SessionTranscript.findOne({ sessionId: s._id }).lean();
    console.log(`  Transcript: ${t ? `EXISTS (${(t.rawText || '').length} chars)` : 'NOT FOUND'}`);
    console.log('---');
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
