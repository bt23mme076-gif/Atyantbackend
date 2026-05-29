import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from './models/User.js';

dotenv.config();

async function testIncrement() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find the mentor user
    const mentorUsername = 'mentor'; // Change this to your mentor username
    const mentor = await User.findOne({ username: mentorUsername, role: 'mentor' });
    
    if (!mentor) {
      console.log('❌ Mentor not found. Available mentors:');
      const allMentors = await User.find({ role: 'mentor' }).select('username email');
      allMentors.forEach(m => console.log(`  - ${m.username} (${m.email})`));
      return;
    }

    console.log(`\n📊 Before increment:`);
    console.log(`   Mentor: ${mentor.username}`);
    console.log(`   Profile Views: ${mentor.profileViews || 0}`);
    console.log(`   Total Chats: ${mentor.totalChats || 0}`);

    // Test increment profile views
    await User.findByIdAndUpdate(mentor._id, { $inc: { profileViews: 1 } });
    console.log('\n✅ Incremented profileViews by 1');

    // Test increment total chats
    await User.findByIdAndUpdate(mentor._id, { $inc: { totalChats: 1 } });
    console.log('✅ Incremented totalChats by 1');

    // Fetch updated values
    const updatedMentor = await User.findById(mentor._id);
    
    console.log(`\n📊 After increment:`);
    console.log(`   Mentor: ${updatedMentor.username}`);
    console.log(`   Profile Views: ${updatedMentor.profileViews || 0}`);
    console.log(`   Total Chats: ${updatedMentor.totalChats || 0}`);
    
    console.log('\n✅ Test successful! Now refresh the dashboard to see updated stats.');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

testIncrement();
