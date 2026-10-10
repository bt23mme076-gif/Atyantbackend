// ─────────────────────────────────────────────────────────────────────────────
//  Embed AnswerCards that have NO vector (saved while the embedding service was
//  down). Only fills `embedding` — card content is untouched, unlike
//  backfillAnswerCards.js which also re-structures the card with the LLM.
//
//  USAGE (from backend/ folder):
//    node scripts/embedMissingAnswerCards.js            # embed every card missing a vector
//    node scripts/embedMissingAnswerCards.js --dry-run  # list them, change nothing
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import AnswerCard from '../models/AnswerCard.js';
import User from '../models/User.js';
import { getQuestionEmbedding } from '../services/AIService.js';

const DRY_RUN = process.argv.includes('--dry-run');
const MIN_CONTENT_CHARS = 150;

// Same text the onboarding path embeds: card content + mentor profile signals.
function buildEmbeddingText(ac = {}, mentor) {
  return [
    ac.mainAnswer, ac.situation, ac.whatWorked, ac.timeline, ac.differentApproach,
    Array.isArray(ac.keyMistakes) ? ac.keyMistakes.join(' ') : '',
    Array.isArray(ac.actionableSteps) ? ac.actionableSteps.map(s => s.description).join(' ') : '',
    (mentor?.topCompanies || []).join(' '),
    (mentor?.specialTags || []).join(' '),
    (mentor?.expertise || []).join(' '),
  ].filter(Boolean).join(' ');
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Embedding service: ${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:8000'}`);

  const cards = await AnswerCard.find({
    $or: [{ embedding: { $exists: false } }, { embedding: null }, { embedding: { $size: 0 } }],
  }).select('answerContent mentorId createdAt').lean();
  console.log(`${cards.length} card(s) without an embedding${DRY_RUN ? ' (dry run)' : ''}`);

  let done = 0, failed = 0;
  for (const card of cards) {
    const label = `${card._id} | ${(card.answerContent?.mainAnswer || '').slice(0, 60)}`;
    // Near-empty / test cards would surface as blank results — never embed them.
    // Cards with a story but no headline belong to backfillAnswerCards.js.
    if (buildEmbeddingText(card.answerContent).trim().length < MIN_CONTENT_CHARS) {
      console.log(`  skip (too little content): ${label}`); continue;
    }
    if (!card.answerContent?.mainAnswer?.trim()) {
      console.log(`  skip (no headline — use backfillAnswerCards.js): ${label}`); continue;
    }
    const text = buildEmbeddingText(card.answerContent, await User.findById(card.mentorId)
      .select('topCompanies specialTags expertise').lean());
    if (DRY_RUN) { console.log(`  would embed: ${label}`); continue; }

    const embedding = await getQuestionEmbedding(text);
    if (!Array.isArray(embedding) || embedding.length !== 384) {
      failed++; console.log(`  FAILED: ${label}`); continue;
    }
    await AnswerCard.updateOne({ _id: card._id }, { $set: { embedding } });
    done++; console.log(`  embedded: ${label}`);
  }

  console.log(`Done — embedded ${done}, failed ${failed}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
