import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Session from './models/Session.js';

dotenv.config();

async function checkRishuSessions() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    // Rishu's userId
    const rishuId = '6a43ae2ab1dbdcfede8556bf';
    
    const sessions = await Session.find({
      $or: [
        { userId: rishuId },
        { mentorId: rishuId }
      ]
    })
    .sort({ scheduledAt: -1 })
    .limit(5)
    .lean();
    
    console.log('=== RISHU RAJ SESSIONS ===\n');
    
    sessions.forEach((s, idx) => {
      console.log(`Session ${idx + 1}:`);
      console.log(`  ID: ${s._id}`);
      console.log(`  Room: ${s.livekitRoomName || 'N/A'}`);
      console.log(`  Status: ${s.status}`);
      console.log(`  Pipeline Status: ${s.pipelineStatus || 'N/A'}`);
      console.log(`  Egress ID: ${s.egressId || 'N/A'}`);
      console.log(`  Egress Attempts: ${s.egressAttempts || 0}`);
      console.log(`  Pipeline Error: ${s.pipelineError || 'None'}`);
      console.log(`  Scheduled At: ${s.scheduledAt}`);
      console.log('---\n');
    });
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkRishuSessions();
