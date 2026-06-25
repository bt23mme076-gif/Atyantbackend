// ─────────────────────────────────────────────────────────────────────────────
//  Backfill: stamp `domain` (internship / placement / general) on existing
//  AnswerCards.
//
//  WHY: `domain` was added so the matcher can refuse to serve a placement journey
//  to an internship query (and vice-versa). New cards get it at creation; older
//  cards default to 'general'. At query time the engine re-derives intent from a
//  card's text, but that's weaker than the original question. This script sets the
//  field exactly — from each card's linked Question — so the gate is precise for
//  the whole back catalogue.
//
//  Fast & cheap: no AI, no re-embedding. Safe to run anytime.
//
//  USAGE (from backend/ folder):
//    node scripts/backfillAnswerCardDomain.js              # set domain on cards still 'general'
//    node scripts/backfillAnswerCardDomain.js --all        # recompute for every card
//    node scripts/backfillAnswerCardDomain.js --dry-run    # show what would change
//    node scripts/backfillAnswerCardDomain.js --limit=100  # cap how many to process
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import mongoose from 'mongoose';
import AnswerCard from '../models/AnswerCard.js';
import Question from '../models/Question.js';

// ── CLI flags ──
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val  = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const DRY_RUN = flag('dry-run');
const ALL     = flag('all');
const LIMIT   = val('limit') ? parseInt(val('limit'), 10) : 0;

// ── Intent detection — kept in sync with AtyantEngine.js ──
const INTERNSHIP_PATTERNS = ['internship', 'intern', 'summer internship', 'winter internship', 'intern offer', 'internship offer', 'intern prep'];
const PLACEMENT_PATTERNS = ['placement', 'job', 'full time', 'full-time', 'ft role', 'ft offer', 'job offer', 'campus placement', 'recruitment'];

function detectIntentFromText(text) {
  const t = String(text || '').toLowerCase();
  const internMatches = INTERNSHIP_PATTERNS.filter(p => t.includes(p)).length;
  const placeMatches = PLACEMENT_PATTERNS.filter(p => t.includes(p)).length;
  if (internMatches > placeMatches && internMatches > 0) return 'internship';
  if (placeMatches > 0) return 'placement';
  return 'general';
}

// Best-effort intent for a card: prefer the source question (most accurate), then
// fall back to the card's own answer text (same as the runtime derivation).
function deriveDomain(card, question) {
  const fromQuestion = detectIntentFromText(
    [question?.questionText, ...(question?.keywords || [])].filter(Boolean).join(' ')
  );
  if (fromQuestion !== 'general') return fromQuestion;

  const ac = card.answerContent || {};
  return detectIntentFromText([
    ac.mainAnswer, ac.situation, ac.firstAttempt, ac.whatWorked,
    ac.timeline, ac.differentApproach, ac.additionalNotes,
  ].filter(Boolean).join(' '));
}

async function run() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  // Default run only touches cards whose domain is still the 'general' default;
  // --all recomputes everything.
  const query = ALL ? {} : { $or: [{ domain: { $exists: false } }, { domain: 'general' }] };
  const cards = await AnswerCard.find(query)
    .select('answerContent domain questionId')
    .lean();
  console.log(`📦 Found ${cards.length} answer card(s) to evaluate${ALL ? ' (--all)' : ''}.`);

  // One batched lookup of all linked questions instead of one query per card.
  const questionIds = [...new Set(cards.map(c => c.questionId).filter(Boolean).map(String))];
  const questions = await Question.find({ _id: { $in: questionIds } })
    .select('questionText keywords')
    .lean();
  const qmap = new Map(questions.map(q => [String(q._id), q]));

  let processed = 0, updated = 0, unchanged = 0;
  const counts = { internship: 0, placement: 0, general: 0 };

  for (const card of cards) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    const question = card.questionId ? qmap.get(String(card.questionId)) : null;
    const domain = deriveDomain(card, question);
    counts[domain]++;

    if (domain === (card.domain || 'general')) {
      unchanged++;
      continue;
    }

    console.log(`  ✏️  ${card._id}: ${card.domain || 'general'} → ${domain}`);
    if (DRY_RUN) { updated++; continue; }

    await AnswerCard.updateOne({ _id: card._id }, { $set: { domain } });
    updated++;
  }

  console.log('\n──────── Domain backfill summary ────────');
  console.log(`  processed: ${processed}`);
  console.log(`  updated:   ${updated}${DRY_RUN ? ' (dry-run, not saved)' : ''}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  intents →  internship: ${counts.internship} | placement: ${counts.placement} | general: ${counts.general}`);
  console.log('─────────────────────────────────────────\n');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Domain backfill crashed:', err);
  process.exit(1);
});
