import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Session from './models/Session.js';
import SessionTranscript from './models/SessionTranscript.js';

dotenv.config();

async function checkAllTranscripts() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    console.log('📊 === SESSION TRANSCRIPT STATUS ===\n');
    
    // Last 20 completed sessions
    const sessions = await Session.find({ status: 'completed' })
      .sort({ scheduledAt: -1 })
      .limit(20)
      .lean();
    
    console.log(`Total completed sessions checked: ${sessions.length}\n`);
    
    let stats = {
      total: sessions.length,
      hasTranscript: 0,
      noTranscript: 0,
      noAudio: 0,
      failed: 0,
      pending: 0,
      success: 0,
    };
    
    for (const session of sessions) {
      const transcript = await SessionTranscript.findOne({ sessionId: session._id }).lean();
      
      if (transcript) {
        stats.hasTranscript++;
        
        const textLength = (transcript.rawText || '').length;
        const status = session.pipelineStatus || 'unknown';
        
        // Status breakdown
        if (status === 'no_audio') stats.noAudio++;
        else if (status === 'failed') stats.failed++;
        else if (status === 'completed') stats.success++;
        else stats.pending++;
        
        console.log(`✅ ${session._id}`);
        console.log(`   Status: ${status}`);
        console.log(`   Length: ${textLength} chars`);
        console.log(`   Date: ${new Date(session.scheduledAt).toLocaleDateString('en-IN')}`);
        
        // Show preview for problematic ones
        if (status === 'no_audio' || textLength < 500) {
          console.log(`   Preview: "${(transcript.rawText || '').slice(0, 100)}..."`);
        }
        console.log('');
      } else {
        stats.noTranscript++;
        console.log(`❌ ${session._id}`);
        console.log(`   NO TRANSCRIPT SAVED`);
        console.log(`   Pipeline Status: ${session.pipelineStatus || 'pending'}`);
        console.log(`   Pipeline Error: ${session.pipelineError || 'None'}`);
        console.log(`   Date: ${new Date(session.scheduledAt).toLocaleDateString('en-IN')}`);
        console.log('');
      }
    }
    
    console.log('\n📈 === SUMMARY ===');
    console.log(`Total Sessions: ${stats.total}`);
    console.log(`Has Transcript: ${stats.hasTranscript} (${(stats.hasTranscript/stats.total*100).toFixed(1)}%)`);
    console.log(`No Transcript: ${stats.noTranscript} (${(stats.noTranscript/stats.total*100).toFixed(1)}%)`);
    console.log('');
    console.log('Transcript Quality:');
    console.log(`  ✅ Success: ${stats.success} (real conversation captured)`);
    console.log(`  ⚠️  No Audio: ${stats.noAudio} (mic issue - filler words only)`);
    console.log(`  ❌ Failed: ${stats.failed} (pipeline error)`);
    console.log(`  ⏳ Pending: ${stats.pending} (processing or unknown)`);
    
    console.log('\n💡 INTERPRETATION:');
    if (stats.hasTranscript === stats.total) {
      console.log('   ✅ PERFECT - All completed sessions have transcripts saved');
    } else if (stats.hasTranscript / stats.total > 0.9) {
      console.log('   ✅ GOOD - Most sessions have transcripts (>90%)');
    } else if (stats.hasTranscript / stats.total > 0.7) {
      console.log('   ⚠️  OKAY - Some sessions missing transcripts (70-90%)');
    } else {
      console.log('   ❌ PROBLEM - Many sessions missing transcripts (<70%)');
    }
    
    if (stats.noAudio > 0) {
      console.log(`   ⚠️  ${stats.noAudio} session(s) had mic issues (no real audio captured)`);
      console.log('   → Deploy frontend mic detection to prevent this!');
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkAllTranscripts();
