// Script to fix AnswerCard followUpCount and deduplicate followUpAnswers
import mongoose from 'mongoose';
import AnswerCard from './models/AnswerCard.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/atyant';

async function fixFollowUpCounts() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const cards = await AnswerCard.find({ followUpCount: { $gt: 2 } });
  for (const card of cards) {
    // Deduplicate followUpAnswers by questionId
    const seen = new Set();
    card.followUpAnswers = card.followUpAnswers.filter(fu => {
      if (!fu.questionId) return false;
      const id = fu.questionId.toString();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    // Set followUpCount to actual unique count, capped at 2
    card.followUpCount = Math.min(card.followUpAnswers.length, 2);
    await card.save();
    console.log(`Fixed card ${card._id}: followUpCount=${card.followUpCount}`);
  }
  await mongoose.disconnect();
  console.log('Cleanup complete!');
}

fixFollowUpCounts().catch(e => { console.error(e); process.exit(1); });
