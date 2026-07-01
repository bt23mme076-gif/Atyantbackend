// One-off finder: locate AnswerCard(s) from mentor "Aryan" matching the
// Atyant.in journey, so we can confirm before deleting. Read-only.
//
//   node scripts/findAryanAnswerCard.js
import 'dotenv/config';
import mongoose from 'mongoose';
import AnswerCard from '../models/AnswerCard.js';
import User from '../models/User.js';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const mentors = await User.find({ name: /aryan/i })
    .select('_id name email username slug role')
    .lean();
  console.log(`👤 Matching mentors (name ~ /aryan/i): ${mentors.length}`);
  mentors.forEach(m => console.log('   ', m._id, '|', m.name, '|', m.email, '|', m.role));

  const ids = mentors.map(m => m._id);
  const cards = await AnswerCard.find({ mentorId: { $in: ids } })
    .select('mentorId domain createdAt answerContent.mainAnswer answerContent.situation')
    .lean();

  console.log(`\n📦 Answer cards by these mentor(s): ${cards.length}`);
  for (const c of cards) {
    const ac = c.answerContent || {};
    const snippet = (ac.mainAnswer || ac.situation || '').slice(0, 120).replace(/\s+/g, ' ');
    console.log(`   ${c._id} | mentor ${c.mentorId} | ${c.domain} | ${c.createdAt?.toISOString?.() || c.createdAt}`);
    console.log(`        ↳ ${snippet}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}
run().catch(e => { console.error('❌', e); process.exit(1); });
