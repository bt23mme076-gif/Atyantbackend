import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from './models/User.js';

dotenv.config();

async function initializeStats() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Initialize stats for all mentors if they don't have them
    const result = await User.updateMany(
      { role: 'mentor' },
      { 
        $setOnInsert: { 
          profileViews: 0,
          totalChats: 0
        }
      },
      { upsert: false }
    );

    // Set to 0 for all mentors that have undefined
    await User.updateMany(
      { 
        role: 'mentor',
        profileViews: { $exists: false }
      },
      { 
        $set: { profileViews: 0 }
      }
    );

    await User.updateMany(
      { 
        role: 'mentor',
        totalChats: { $exists: false }
      },
      { 
        $set: { totalChats: 0 }
      }
    );

    console.log('✅ Stats initialized for all mentors');
    
    // Show all mentors
    const mentors = await User.find({ role: 'mentor' }).select('username email profileViews totalChats');
    
    console.log('\n📊 Current Mentor Stats:');
    console.log('='.repeat(60));
    mentors.forEach(m => {
      console.log(`\n${m.username} (${m.email})`);
      console.log(`  Profile Views: ${m.profileViews || 0}`);
      console.log(`  Total Chats: ${m.totalChats || 0}`);
    });
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Done!');
    process.exit(0);
  }
}

initializeStats();
