import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Session from './models/Session.js';
import SessionTranscript from './models/SessionTranscript.js';
import SessionInsight from './models/SessionInsight.js';

dotenv.config();

/**
 * Test script to verify transcript saving works in all scenarios
 */
async function testTranscriptGuarantee() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    console.log('🧪 === TRANSCRIPT GUARANTEE TEST ===\n');
    
    // Get last 30 completed sessions
    const sessions = await Session.find({ status: 'completed' })
      .sort({ scheduledAt: -1 })
      .limit(30)
      .lean();
    
    console.log(`Testing ${sessions.length} completed sessions...\n`);
    
    let results = {
      total: sessions.length,
      transcriptSaved: 0,
      transcriptMissing: 0,
      insightSaved: 0,
      insightMissing: 0,
      statusBreakdown: {
        completed: 0,
        no_audio: 0,
        failed: 0,
        pending: 0,
      },
      guaranteePass: true,
    };
    
    const missing = [];
    
    for (const session of sessions) {
      const transcript = await SessionTranscript.findOne({ sessionId: session._id }).lean();
      const insight = await SessionInsight.findOne({ sessionId: session._id }).lean();
      
      const status = session.pipelineStatus || 'unknown';
      
      // Count status
      if (results.statusBreakdown[status] !== undefined) {
        results.statusBreakdown[status]++;
      }
      
      // Check transcript
      if (transcript) {
        results.transcriptSaved++;
      } else {
        results.transcriptMissing++;
        results.guaranteePass = false;
        missing.push({
          sessionId: session._id,
          status: status,
          error: session.pipelineError,
          date: session.scheduledAt,
        });
      }
      
      // Check insight
      if (insight) {
        results.insightSaved++;
      } else {
        results.insightMissing++;
      }
    }
    
    console.log('📊 === RESULTS ===\n');
    
    console.log('Transcript Guarantee:');
    console.log(`  ✅ Saved: ${results.transcriptSaved}/${results.total} (${(results.transcriptSaved/results.total*100).toFixed(1)}%)`);
    console.log(`  ❌ Missing: ${results.transcriptMissing}/${results.total}`);
    
    console.log('\nInsight Coverage:');
    console.log(`  ✅ Saved: ${results.insightSaved}/${results.total} (${(results.insightSaved/results.total*100).toFixed(1)}%)`);
    console.log(`  ❌ Missing: ${results.insightMissing}/${results.total}`);
    
    console.log('\nStatus Breakdown:');
    console.log(`  ✅ Completed: ${results.statusBreakdown.completed}`);
    console.log(`  ⚠️  No Audio: ${results.statusBreakdown.no_audio}`);
    console.log(`  ❌ Failed: ${results.statusBreakdown.failed}`);
    console.log(`  ⏳ Pending: ${results.statusBreakdown.pending}`);
    
    console.log('\n🎯 === VERDICT ===');
    
    if (results.guaranteePass && results.transcriptSaved === results.total) {
      console.log('✅ PERFECT - All completed sessions have transcripts!');
      console.log('   Transcript guarantee is working 100%');
    } else if (results.transcriptSaved / results.total >= 0.95) {
      console.log('✅ EXCELLENT - 95%+ sessions have transcripts');
      console.log('   A few edge cases but overall system is solid');
    } else if (results.transcriptSaved / results.total >= 0.90) {
      console.log('✅ GOOD - 90%+ sessions have transcripts');
      console.log('   Room for improvement but acceptable');
    } else if (results.transcriptSaved / results.total >= 0.80) {
      console.log('⚠️  OKAY - 80-90% sessions have transcripts');
      console.log('   Some issues need attention');
    } else {
      console.log('❌ PROBLEM - <80% sessions have transcripts');
      console.log('   System needs debugging');
    }
    
    if (missing.length > 0) {
      console.log(`\n⚠️  ${missing.length} sessions are missing transcripts:`);
      missing.forEach((s, idx) => {
        console.log(`\n${idx + 1}. Session: ${s.sessionId}`);
        console.log(`   Status: ${s.status}`);
        console.log(`   Error: ${s.error || 'None'}`);
        console.log(`   Date: ${new Date(s.date).toLocaleDateString('en-IN')}`);
      });
      
      console.log('\n💡 To fix these, try reprocessing:');
      console.log(`curl -X POST http://localhost:5000/api/sessions/SESSION_ID/reprocess \\`);
      console.log(`  -H "Authorization: Bearer ADMIN_TOKEN"`);
    }
    
    // Check mic failure handling
    const noAudioSessions = await Session.find({ pipelineStatus: 'no_audio' })
      .limit(5)
      .lean();
    
    if (noAudioSessions.length > 0) {
      console.log(`\n🎤 === MIC FAILURE HANDLING ===`);
      console.log(`Found ${noAudioSessions.length} sessions with mic issues\n`);
      
      for (const session of noAudioSessions) {
        const transcript = await SessionTranscript.findOne({ sessionId: session._id }).lean();
        const insight = await SessionInsight.findOne({ sessionId: session._id }).lean();
        
        console.log(`Session: ${session._id}`);
        console.log(`  Transcript: ${transcript ? '✅ SAVED' : '❌ MISSING'}`);
        console.log(`  Insight: ${insight ? '✅ SAVED' : '❌ MISSING'}`);
        
        if (insight) {
          const summary = insight.summary || '';
          if (summary.includes('Audio recording issue') || summary.includes('microphone')) {
            console.log(`  Message: ✅ Proper error message shown to user`);
          } else {
            console.log(`  Message: ⚠️ Generic message (should be specific)`);
          }
        }
        console.log('');
      }
    }
    
    console.log('\n📝 === RECOMMENDATIONS ===');
    
    if (results.statusBreakdown.no_audio > 0) {
      console.log(`⚠️  ${results.statusBreakdown.no_audio} sessions had mic issues`);
      console.log('   → Deploy frontend mic detection to prevent this!');
      console.log('   → Files ready: C:\\Atyantbackend\\COPY_TO_FRONTEND\\');
    }
    
    if (results.statusBreakdown.failed > 0) {
      console.log(`❌ ${results.statusBreakdown.failed} sessions failed pipeline`);
      console.log('   → Check logs for specific errors');
      console.log('   → Try reprocessing these sessions');
    }
    
    if (results.transcriptMissing === 0 && results.insightSaved === results.total) {
      console.log('🎉 Everything is working perfectly!');
      console.log('   All sessions have both transcripts and insights');
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Test Error:', err.message);
    process.exit(1);
  }
}

testTranscriptGuarantee();
