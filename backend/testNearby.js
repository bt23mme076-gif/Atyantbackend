import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';

dotenv.config();

const testNearby = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoURI);
    console.log('✅ Connected\n');

    // Find mentors with location
    const mentors = await User.find({
      role: 'mentor',
      'location.coordinates': { $exists: true, $ne: null }
    }).select('username email location');

    console.log(`📊 Total mentors with location: ${mentors.length}\n`);

    if (mentors.length === 0) {
      console.log('❌ No mentors have location!');
      console.log('💡 Run: node fixMentorLocations.js');
    } else {
      console.log('✅ Mentors:');
      mentors.forEach(m => {
        console.log(`  - ${m.username}: [${m.location.coordinates}]`);
      });

      // Test geospatial query
      console.log('\n🔍 Testing geospatial query...');
      
      const nearby = await User.find({
        role: 'mentor',
        'location.coordinates': { $exists: true },
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [75.8577, 22.7196]
            },
            $maxDistance: 100000
          }
        }
      }).limit(10);

      console.log(`✅ Found ${nearby.length} nearby mentors`);
      nearby.forEach(m => {
        console.log(`  - ${m.username}: [${m.location.coordinates}]`);
      });
    }

    await mongoose.connection.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('2dsphere')) {
      console.log('\n💡 Index missing! Run: node cleanLocationData.js');
    }
    process.exit(1);
  }
};

testNearby();