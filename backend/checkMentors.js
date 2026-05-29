import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const checkMentors = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    const users = db.collection('users');

    // Count total mentors
    const totalMentors = await users.countDocuments({ role: 'mentor' });
    console.log('📊 Total mentors:', totalMentors);

    // Count mentors with location
    const mentorsWithLocation = await users.countDocuments({
      role: 'mentor',
      'location.coordinates': { $exists: true, $type: 'array', $size: 2 }
    });
    console.log('📍 Mentors with location:', mentorsWithLocation);

    // Show all mentors with location details
    if (mentorsWithLocation > 0) {
      console.log('\n✅ Mentors with location:');
      const mentors = await users.find({
        role: 'mentor',
        'location.coordinates': { $exists: true }
      }).toArray();

      mentors.forEach(m => {
        console.log(`\n  Username: ${m.username}`);
        console.log(`  Email: ${m.email}`);
        console.log(`  Location: ${m.location?.coordinates}`);
        console.log(`  City: ${m.location?.city}`);
      });
    } else {
      console.log('\n❌ No mentors have location set!');
      console.log('💡 Run: node addTestMentor.js');
    }

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

checkMentors();