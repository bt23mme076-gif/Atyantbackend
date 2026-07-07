import dotenv from 'dotenv';
import mongoose from 'mongoose';
import SessionTranscript from './models/SessionTranscript.js';
import Session from './models/Session.js';
import fs from 'fs';

dotenv.config();

async function quickCheck() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    // Known Rishu session IDs from context
    const sessionIds = [
      '6a4c9ebcdc3d8217db451a5f',
      '6a4c8a80f5c7aed996155026', 
      '6a4c9ea390bbba302021a94e'
    ];
    
    console.log('🔍 Checking Rishu\'s Sessions...\n');
    
    for (const id of sessionIds) {
      console.log(`Session: ${id}`);
      
      const session = await Session.findById(id).lean();
      const transcript = await SessionTranscript.findOne({ sessionId: id }).lean();
      const audioPath = `/tmp/recordings/${id}.ogg`;
      
      console.log(`  Status: ${session?.pipelineStatus || 'NOT FOUND'}`);
      console.log(`  Transcript: ${transcript ? '✅ SAVED' : '❌ NO'}`);
      
      if (transcript) {
        const len = (transcript.rawText || '').length;
        console.log(`    Length: ${len} chars`);
        console.log(`    Preview: "${(transcript.rawText || '').slice(0, 100)}..."`);
      }
      
      console.log(`  Audio: ${audioPath}`);
      console.log(`    (Check VPS - can't access from Windows)\n`);
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

quickCheck();
