import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import AnswerCard from './models/AnswerCard.js';
// 🚀 FIX: Question model ko register karna zaroori hai populate ke liye
import Question from './models/Question.js'; 
import { getQuestionEmbedding } from './services/AIService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

async function startMigration() {
  try {
    console.log("🔍 Checking Environment Variables...");
    const connectionString = process.env.MONGO_URI;

    if (!connectionString) {
      console.error("❌ ERROR: MONGO_URI missing in .env!");
      process.exit(1);
    }
    
    console.log("🔗 Connecting to MongoDB Atlas...");
    await mongoose.connect(connectionString);
    console.log("✅ Connected Successfully!");

    // Ab Question model register ho chuka hai, toh populate error nahi dega
    const cards = await AnswerCard.find({
      $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }]
    }).populate('questionId');

    if (cards.length === 0) {
      console.log("ℹ️ No cards need vectorization. Database is already AI-Ready!");
      process.exit(0);
    }

    console.log(`🚀 Found ${cards.length} cards. Starting AI Vectorization...`);

    for (let card of cards) {
      if (card.questionId && card.questionId.questionText) {
        console.log(`🔄 Vectorizing: "${card.questionId.questionText.substring(0, 35)}..."`);
        
        const vector = await getQuestionEmbedding(card.questionId.questionText);
        
        if (vector) {
          card.embedding = vector;
          await card.save();
          console.log("   ✅ Vector Saved!");
        } else {
          console.log("   ❌ Failed to get vector from Python.");
        }
      }
    }

    console.log("\n✨ MUBARAK HO! Mission Successful. Data is AI-Ready.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal Error:", err.message);
    process.exit(1);
  }
}

startMigration();