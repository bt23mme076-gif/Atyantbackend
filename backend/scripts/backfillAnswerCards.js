// ─────────────────────────────────────────────────────────────────────────────
//  Backfill: re-structure + re-embed existing AnswerCards
//
//  WHY: cards created before the Groq model fix (decommissioned llama3-70b-8192)
//  fell back to dumping the raw story into every field. This script re-runs the
//  AI structuring (refineExperience) on those cards and rebuilds their vector
//  embedding so matching is accurate again.
//
//  USAGE (from backend/ folder):
//    node scripts/backfillAnswerCards.js                # fix only broken cards
//    node scripts/backfillAnswerCards.js --all          # re-process every card
//    node scripts/backfillAnswerCards.js --dry-run      # show what would change
//    node scripts/backfillAnswerCards.js --limit=20     # cap how many to process
//    node scripts/backfillAnswerCards.js --mentor=<id>  # one mentor's cards only
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ Must load env BEFORE importing AIService — its constructor reads
// process.env.GROQ_API_KEY at import time. A side-effect import guarantees
// dotenv runs before any other import below is evaluated.
import 'dotenv/config';
import mongoose from 'mongoose';
import AnswerCard from '../models/AnswerCard.js';
import User from '../models/User.js';
import aiService, { getQuestionEmbedding } from '../services/AIService.js';

// ── CLI flags ──
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val  = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const DRY_RUN   = flag('dry-run');
const ALL       = flag('all');
const LIMIT     = val('limit') ? parseInt(val('limit'), 10) : 0;
const MENTOR_ID = val('mentor');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A card looks "broken" if the AI never structured it — i.e. the headline and
// situation are identical (the raw-story fallback), or there are no steps.
function looksBroken(ac = {}) {
  const main = (ac.mainAnswer || '').trim();
  const sit  = (ac.situation || '').trim();
  const noSteps = !Array.isArray(ac.actionableSteps) || ac.actionableSteps.length === 0;
  const dup = main && sit && (main === sit || sit.startsWith(main) || main.startsWith(sit));
  return dup || noSteps;
}

function buildEmbeddingText(ac, mentor) {
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
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const query = {};
  if (MENTOR_ID) query.mentorId = MENTOR_ID;

  let cursor = AnswerCard.find(query).populate('mentorId', 'bio topCompanies expertise specialTags education username');
  const cards = await cursor.lean();
  console.log(`📦 Found ${cards.length} answer card(s)${MENTOR_ID ? ` for mentor ${MENTOR_ID}` : ''}.`);

  let processed = 0, updated = 0, skipped = 0, failed = 0;

  for (const card of cards) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    const ac = card.answerContent || {};
    const mentor = card.mentorId || {};

    if (!ALL && !looksBroken(ac)) {
      skipped++;
      continue;
    }

    // Reconstruct the raw story from whatever content the card already holds.
    const edu = mentor.education?.[0] || {};
    const story = [ac.situation, ac.mainAnswer, ac.whatWorked]
      .filter(Boolean)
      .reduce((a, b) => (b.length > a.length ? b : a), ''); // pick the longest blob
    const rawData = {
      story: story || mentor.bio || '',
      bio: mentor.bio || '',
      college: edu.institutionName || edu.institution || '',
      branch: edu.field || '',
      companies: mentor.topCompanies || [],
      expertise: mentor.expertise || [],
      achievements: mentor.specialTags || [],
    };

    if (!rawData.story && rawData.companies.length === 0) {
      console.log(`  ⏭️  ${card._id} — no source text, skipping`);
      skipped++;
      continue;
    }

    let refined;
    try {
      refined = await aiService.refineExperience(rawData);
    } catch (e) {
      console.log(`  ❌ ${card._id} — refine failed: ${e.message}`);
      failed++;
      await sleep(1200);
      continue;
    }

    // If the AI was unavailable, refineExperience returns rawData (no mainAnswer
    // key) — don't clobber the card with that. Treat as failure to retry later.
    if (!refined || (!refined.mainAnswer && !refined.situation)) {
      console.log(`  ⚠️  ${card._id} — AI returned no structure (model/key issue?), skipping`);
      failed++;
      await sleep(1200);
      continue;
    }

    const newContent = {
      mainAnswer:        (refined.mainAnswer || '').slice(0, 2000),
      situation:         (refined.situation || '').slice(0, 2000),
      firstAttempt:      (refined.firstAttempt || ''),
      whatWorked:        (refined.whatWorked || '').slice(0, 2000),
      timeline:          (refined.timeline || '').slice(0, 500),
      differentApproach: (refined.differentApproach || '').slice(0, 2000),
      additionalNotes:   (refined.additionalNotes || ''),
      keyMistakes:       Array.isArray(refined.keyMistakes)
        ? refined.keyMistakes.map(s => String(s).trim()).filter(Boolean).slice(0, 10) : [],
      actionableSteps:   Array.isArray(refined.actionableSteps)
        ? refined.actionableSteps
            .map(s => ({ step: String(s?.step || '').trim(), description: String(s?.description || '').trim() }))
            .filter(s => s.description).slice(0, 10)
        : [],
    };

    console.log(`  ✏️  ${card._id} (${mentor.username || 'mentor'})`);
    console.log(`       headline: ${newContent.mainAnswer.slice(0, 70)}…`);
    console.log(`       steps: ${newContent.actionableSteps.length}, mistakes: ${newContent.keyMistakes.length}`);

    if (DRY_RUN) { updated++; await sleep(300); continue; }

    // Re-embed from the new content.
    let embedding = null;
    try {
      embedding = await getQuestionEmbedding(buildEmbeddingText(newContent, mentor));
    } catch (e) {
      console.log(`       ⚠️ embedding failed (saving content without new vector): ${e.message}`);
    }

    try {
      await AnswerCard.updateOne(
        { _id: card._id },
        { $set: { answerContent: newContent, ...(embedding ? { embedding } : {}) } }
      );
      updated++;
    } catch (e) {
      console.log(`       ❌ save failed: ${e.message}`);
      failed++;
    }

    await sleep(1200); // be gentle with Groq rate limits
  }

  console.log('\n──────── Backfill summary ────────');
  console.log(`  processed: ${processed}`);
  console.log(`  updated:   ${updated}${DRY_RUN ? ' (dry-run, not saved)' : ''}`);
  console.log(`  skipped:   ${skipped}`);
  console.log(`  failed:    ${failed}`);
  console.log('──────────────────────────────────\n');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Backfill crashed:', err);
  process.exit(1);
});
