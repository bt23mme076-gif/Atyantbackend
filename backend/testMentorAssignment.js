// Quick Test Script - Run this to check mentor assignments
// Run: node backend/testMentorAssignment.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://atyantuser:qf5CWLbdoKKzQlpL@cluster0.vutlgpa.mongodb.net/atyant?retryWrites=true&w=majority";

async function checkMentorAssignments() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Get all questions
    const Question = mongoose.model('Question', new mongoose.Schema({}, { strict: false }));
    const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));

    const allQuestions = await Question.find({});
    console.log('\n📊 Total Questions:', allQuestions.length);

    // Find mentor4
    const mentor4 = await User.findOne({ username: 'mentor4' });
    if (!mentor4) {
      console.log('❌ mentor4 not found!');
      return;
    }

    console.log('✅ Found mentor4:');
    console.log('   - ID:', mentor4._id);
    console.log('   - Username:', mentor4.username);
    console.log('   - Role:', mentor4.role);

    // Check questions assigned to mentor4
    const assignedQuestions = await Question.find({ 
      selectedMentorId: mentor4._id 
    });

    console.log('\n📋 Questions assigned to mentor4:', assignedQuestions.length);

    if (assignedQuestions.length > 0) {
      assignedQuestions.forEach((q, idx) => {
        console.log(`\n   Question ${idx + 1}:`);
        console.log('   - ID:', q._id);
        console.log('   - Text:', q.questionText?.substring(0, 60) + '...');
        console.log('   - Status:', q.status);
        console.log('   - Mentor ID:', q.selectedMentorId);
        console.log('   - Created:', q.createdAt);
      });
    }

    // Check pending questions specifically
    const pendingQuestions = await Question.find({
      selectedMentorId: mentor4._id,
      status: { $in: ['mentor_assigned', 'awaiting_experience'] }
    });

    console.log('\n✨ PENDING questions for mentor4:', pendingQuestions.length);

    if (pendingQuestions.length > 0) {
      pendingQuestions.forEach((q, idx) => {
        console.log(`\n   Pending ${idx + 1}:`);
        console.log('   - Text:', q.questionText);
        console.log('   - Status:', q.status);
      });
    } else {
      console.log('   ❌ No pending questions found!');
      console.log('   Possible reasons:');
      console.log('   1. Questions have different status');
      console.log('   2. selectedMentorId type mismatch');
      console.log('   3. Questions not yet assigned');
    }

    // Check all questions with their statuses
    console.log('\n📊 All Questions by Status:');
    const statuses = await Question.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    statuses.forEach(s => {
      console.log(`   - ${s._id}: ${s.count}`);
    });

    mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    mongoose.disconnect();
  }
}

checkMentorAssignments();
