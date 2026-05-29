import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'YOUR_MONGODB_ATLAS_URI_HERE';

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: undefined });
  
  const mentorSchema = new mongoose.Schema({
    ratings: [{
        rating: Number,
        review: String
    }]
  }, { strict: false });

  const Mentor = mongoose.model('MentorTemp', mentorSchema, 'mentors');

  const mentors = await Mentor.find({}).lean();
  
  let totalMentors = mentors.length;
  let mentorsWithRatings = mentors.filter(m => m.ratings && m.ratings.length > 0);
  
  let totalScore = 0;
  let totalRatings = 0;
  
  for (const m of mentorsWithRatings) {
    for (const r of m.ratings) {
        totalScore += r.rating || 0;
        totalRatings++;
    }
  }
  
  console.log(`Total Mentors (in mentors collection): ${totalMentors}`);
  console.log(`Mentors with Ratings: ${mentorsWithRatings.length}`);
  console.log(`Total Ratings: ${totalRatings}`);
  if (totalRatings > 0) {
    console.log(`Global Average Rating: ${(totalScore / totalRatings).toFixed(2)}`);
  }

  await mongoose.disconnect();
}

main().catch(console.error);
