import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from './models/User.js';
import Message from './models/Message.js';

dotenv.config();

async function testStats() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all mentors
    const mentors = await User.find({ role: 'mentor' }).select('username profileViews totalChats');
    
    console.log('📊 MENTOR STATISTICS:\n');
    console.log('='.repeat(60));
    
    for (const mentor of mentors) {
      console.log(`\n👤 Mentor: ${mentor.username}`);
      console.log(`   Profile Views: ${mentor.profileViews || 0}`);
      console.log(`   Total Chats: ${mentor.totalChats || 0}`);
      
      // Count actual unique conversations
      const uniqueConversations = await Message.aggregate([
        {
          $match: {
            $or: [
              { sender: mentor._id },
              { receiver: mentor._id }
            ]
          }
        },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ['$sender', mentor._id] },
                '$receiver',
                '$sender'
              ]
            }
          }
        }
      ]);
      
      console.log(`   Actual Unique Conversations: ${uniqueConversations.length}`);
      
      // Count last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const recentConversations = await Message.aggregate([
        {
          $match: {
            $or: [
              { sender: mentor._id, createdAt: { $gte: sevenDaysAgo } },
              { receiver: mentor._id, createdAt: { $gte: sevenDaysAgo } }
            ]
          }
        },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ['$sender', mentor._id] },
                '$receiver',
                '$sender'
              ]
            }
          }
        }
      ]);
      
      console.log(`   Active Chats (Last 7 Days): ${recentConversations.length}`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Test Complete!');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

testStats();
