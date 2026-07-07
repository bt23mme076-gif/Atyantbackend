import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Session from './models/Session.js';
import SessionTranscript from './models/SessionTranscript.js';
import fs from 'fs';

dotenv.config();

async function diagnoseRishuAudio() {
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
    
    console.log('🔍 === RISHU RAJ AUDIO DIAGNOSTIC ===\n');
    
    for (const session of sessions) {
      console.log(`📅 Session: ${session._id}`);
      console.log(`   Scheduled: ${session.scheduledAt}`);
      console.log(`   Status: ${session.status}`);
      console.log(`   Room: ${session.livekitRoomName || 'N/A'}`);
      console.log(`   Egress ID: ${session.egressId || 'N/A'}`);
      console.log(`   Egress Attempts: ${session.egressAttempts || 0}`);
      console.log(`   Pipeline Status: ${session.pipelineStatus || 'pending'}`);
      
      if (session.pipelineError) {
        console.log(`   ❌ Pipeline Error: ${session.pipelineError}`);
      }
      
      // Check if transcript exists
      const transcript = await SessionTranscript.findOne({ sessionId: session._id }).lean();
      if (transcript) {
        const textLength = (transcript.rawText || '').length;
        const preview = (transcript.rawText || '').slice(0, 200);
        console.log(`   📝 Transcript Length: ${textLength} chars`);
        console.log(`   📄 Preview: "${preview}..."`);
        
        // Check for filler word dominance
        const fillerWords = ['you', 'thank', 'hello', 'hi', 'yeah', 'um', 'hmm'];
        const lowerText = (transcript.rawText || '').toLowerCase();
        const fillerCount = fillerWords.reduce((count, word) => 
          count + (lowerText.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length, 0
        );
        const totalWords = (transcript.rawText || '').split(/\s+/).filter(Boolean).length;
        const fillerRatio = totalWords > 0 ? (fillerCount / totalWords * 100).toFixed(1) : 0;
        
        console.log(`   🎤 Total Words: ${totalWords}`);
        console.log(`   🔇 Filler Words: ${fillerCount} (${fillerRatio}% of transcript)`);
        
        if (fillerRatio > 30) {
          console.log(`   ⚠️  HIGH FILLER RATIO - Likely mic was OFF or not capturing`);
        }
      } else {
        console.log(`   ❌ No transcript found`);
      }
      
      // Check if audio file exists on disk
      const audioPath = `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${session._id}.ogg`;
      const audioExists = fs.existsSync(audioPath);
      console.log(`   🎧 Audio File: ${audioExists ? '✅ EXISTS' : '❌ NOT FOUND'} at ${audioPath}`);
      
      if (audioExists) {
        const stats = fs.statSync(audioPath);
        console.log(`   📦 File Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`   📅 Created: ${stats.birthtime}`);
      }
      
      console.log('---\n');
    }
    
    await mongoose.disconnect();
    console.log('\n💡 DIAGNOSIS TIPS:');
    console.log('   1. If audio file exists but transcript is filler → Mic was muted/blocked');
    console.log('   2. If no audio file → Egress failed to record (check LiveKit logs)');
    console.log('   3. If file size < 100KB for >5min call → Connection dropped audio');
    console.log('   4. High filler ratio (>30%) = Whisper hallucinated over silence\n');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

diagnoseRishuAudio();
