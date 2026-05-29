import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'YOUR_MONGODB_ATLAS_URI_HERE';

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: undefined });
  
  const userSchema = new mongoose.Schema({
    role: String,
    feedbackScore: Number,
    helpfulCount: Number,
    totalAnswered: Number,
  }, { strict: false });

  const User = mongoose.model('UserTemp', userSchema, 'users');

  const mentors = await User.find({ role: 'mentor' }).lean();
  
  let totalMentors = mentors.length;
  let mentorsWithFeedback = mentors.filter(m => m.feedbackScore > 0 || m.totalAnswered > 0);
  
  let totalScore = 0;
  let totalHelpful = 0;
  let totalAnswered = 0;
  
  for (const m of mentorsWithFeedback) {
    totalScore += m.feedbackScore || 0;
    totalHelpful += m.helpfulCount || 0;
    totalAnswered += m.totalAnswered || 0;
  }
  
  console.log(`Total Mentors: ${totalMentors}`);
  console.log(`Mentors with Activity: ${mentorsWithFeedback.length}`);
  if (mentorsWithFeedback.length > 0) {
    console.log(`Average Feedback Score (per active mentor): ${(totalScore / mentorsWithFeedback.length).toFixed(2)}`);
  } else {
    console.log(`Average Feedback Score (per active mentor): N/A`);
  }
  console.log(`Total Helpful Count: ${totalHelpful}`);
  console.log(`Total Answered: ${totalAnswered}`);
  if (totalAnswered > 0) {
    console.log(`Global Feedback Score (Total Helpful / Total Answered): ${(totalHelpful / totalAnswered).toFixed(2)}`);
  } else {
    console.log(`Global Feedback Score: N/A`);
  }

  // Also an aggregation for score buckets
  const buckets = {
    '0.8 - 1.0 (Excellent)': 0,
    '0.4 - 0.79 (Average)': 0,
    '0.0 - 0.39 (Needs Improvement)': 0,
    'No Data (0)': 0
  };
  
  for (const m of mentors) {
    const score = m.feedbackScore || 0;
    if (score === 0 && (m.totalAnswered || 0) === 0) {
        buckets['No Data (0)']++;
    } else if (score >= 0.8) {
        buckets['0.8 - 1.0 (Excellent)']++;
    } else if (score >= 0.4) {
        buckets['0.4 - 0.79 (Average)']++;
    } else {
        buckets['0.0 - 0.39 (Needs Improvement)']++;
    }
  }
  console.log('--- Score Buckets ---');
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`${k}: ${v}`);
  }

  await mongoose.disconnect();
}

main().catch(console.error);
