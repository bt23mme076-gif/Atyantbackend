/**
 * 🔥 MIGRATION SCRIPT: Add Embeddings to Existing AnswerCards
 * 
 * This script generates embeddings for all AnswerCards that don't have one yet.
 * Run this once to enable instant answers for historical data.
 * 
 * Usage: node addEmbeddingsToAnswerCards.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import AnswerCard from './models/AnswerCard.js';
import { getQuestionEmbedding } from './services/AIService.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const BATCH_SIZE = 10; // Process 10 at a time to avoid rate limits

async function addEmbeddings() {
  try {
    console.log('🚀 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Count total and without embeddings
    const total = await AnswerCard.countDocuments();
    const withoutEmbedding = await AnswerCard.countDocuments({
      $or: [
        { embedding: { $exists: false } },
        { embedding: null },
        { embedding: { $size: 0 } }
      ]
    });

    console.log(`📊 AnswerCard Statistics:`);
    console.log(`   Total: ${total}`);
    console.log(`   Without embeddings: ${withoutEmbedding}`);
    console.log(`   With embeddings: ${total - withoutEmbedding}\n`);

    if (withoutEmbedding === 0) {
      console.log('✨ All AnswerCards already have embeddings!');
      process.exit(0);
    }

    console.log(`🔄 Processing ${withoutEmbedding} AnswerCards in batches of ${BATCH_SIZE}...\n`);

    // Fetch AnswerCards without embeddings
    const answerCards = await AnswerCard.find({
      $or: [
        { embedding: { $exists: false } },
        { embedding: null },
        { embedding: { $size: 0 } }
      ]
    }).select('_id answerContent');

    let processed = 0;
    let success = 0;
    let failed = 0;

    // Process in batches
    for (let i = 0; i < answerCards.length; i += BATCH_SIZE) {
      const batch = answerCards.slice(i, i + BATCH_SIZE);
      
      console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(answerCards.length / BATCH_SIZE)}...`);
      
      const promises = batch.map(async (card) => {
        try {
          // Extract text from answer content
          const content = card.answerContent;
          const embeddingText = [
            content?.mainAnswer,
            content?.situation,
            content?.firstAttempt,
            content?.whatWorked,
            content?.differentApproach,
            content?.additionalNotes
          ].filter(Boolean).join(' ');

          if (embeddingText.length < 20) {
            console.log(`⚠️  Skipped ${card._id} - content too short`);
            return { success: false, reason: 'short' };
          }

          // Generate embedding
          const embedding = await getQuestionEmbedding(embeddingText);
          
          if (!embedding || embedding.length === 0) {
            console.log(`❌ Failed ${card._id} - embedding generation failed`);
            return { success: false, reason: 'generation_failed' };
          }

          // Update the card
          await AnswerCard.updateOne(
            { _id: card._id },
            { $set: { embedding } }
          );

          console.log(`✅ Updated ${card._id} - ${embedding.length} dimensions`);
          return { success: true };
        } catch (err) {
          console.log(`❌ Error on ${card._id}: ${err.message}`);
          return { success: false, reason: err.message };
        }
      });

      const results = await Promise.all(promises);
      
      results.forEach(r => {
        processed++;
        if (r.success) success++;
        else failed++;
      });

      console.log(`   Progress: ${processed}/${answerCards.length} (${success} success, ${failed} failed)`);
      
      // Small delay between batches to avoid overwhelming the API
      if (i + BATCH_SIZE < answerCards.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n\n🎉 Migration Complete!`);
    console.log(`   ✅ Successfully updated: ${success}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log(`   📊 Total processed: ${processed}\n`);

    // Verify
    const finalWithEmbedding = await AnswerCard.countDocuments({
      embedding: { $exists: true, $ne: null, $not: { $size: 0 } }
    });
    console.log(`✨ Final count: ${finalWithEmbedding} AnswerCards with embeddings`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n👋 Disconnected from MongoDB');
    process.exit(0);
  }
}

addEmbeddings();
