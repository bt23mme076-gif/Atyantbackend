import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';

dotenv.config();

const fixMentorLocations = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB\n');

    // Find ALL mentors (even those with partial location data)
    const allMentors = await User.find({ role: 'mentor' });
    console.log(`📊 Total mentors found: ${allMentors.length}\n`);

    let updated = 0;
    
    for (const mentor of allMentors) {
      // Check if coordinates are missing or invalid
      const hasValidLocation = mentor.location?.coordinates && 
                               Array.isArray(mentor.location.coordinates) && 
                               mentor.location.coordinates.length === 2;

      if (!hasValidLocation) {
        console.log(`🔧 Fixing: ${mentor.username} (${mentor.email})`);
        
        // Set location to Indore
        mentor.location = {
          type: 'Point',
          coordinates: [75.8577, 22.7196], // [longitude, latitude]
          city: mentor.city || 'Indore',
          state: 'Madhya Pradesh',
          country: 'India',
          lastUpdated: new Date()
        };
        
        mentor.locationVisibility = 'city';
        mentor.availableForOfflineMeet = true;
        mentor.maxTravelDistance = 15;

        await mentor.save();
        updated++;
        
        console.log(`   ✅ Added location: [${mentor.location.coordinates}]\n`);
      } else {
        console.log(`✓ ${mentor.username} already has location: [${mentor.location.coordinates}]`);
      }
    }

    console.log(`\n✅ Updated ${updated} mentors`);
    console.log(`✓ ${allMentors.length - updated} mentors already had location`);
    console.log('\n💡 Now test /nearby-mentors page!');

    await mongoose.connection.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
};

fixMentorLocations();