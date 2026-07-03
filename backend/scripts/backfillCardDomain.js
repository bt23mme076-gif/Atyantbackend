// ─────────────────────────────────────────────────────────────────────────────
//  BACKFILL: AnswerCard.domain  (the UNIVERSAL fix)
//
//  WHY: the Clarity feed surfaces AnswerCards. The role-domain gate only fires
//  when it knows a card's domain. 68% of mentor PROFILES have no companyDomain,
//  so gating on the profile leaks off-domain cards (e.g. an IIM/management
//  journey for an SDE query). Every card, however, HAS content — so we classify
//  each card's domain from its own content, once, and store it on the card.
//
//  Scope is tiny (all cards that can ever surface), so this is a one-time pass.
//  Groq's llama-3.1-8b-instant has a 6000 TPM limit, so calls are throttled and
//  retried on 429.
//
//  USAGE (from backend/):
//    node scripts/backfillCardDomain.js            # DRY RUN — prints only
//    node scripts/backfillCardDomain.js --apply    # writes domain to each card
//    node scripts/backfillCardDomain.js --apply --all   # re-classify ALL (incl. set)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import AnswerCard from '../models/AnswerCard.js';
import aiService from '../services/AIService.js';

const APPLY = process.argv.includes('--apply');
const ALL   = process.argv.includes('--all');
const SLEEP_MS = 6000; // ~10 calls/min → under the 6000 TPM limit

const sleep = ms => new Promise(r => setTimeout(r, ms));

// classifyCardDomain with a retry on Groq 429 (rate limit) so the whole batch
// never dies just because a minute's token budget was hit.
async function classifyWithRetry(content, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const before = console.warn;
    let hit429 = false;
    console.warn = (...a) => { if (String(a[0]).includes('429')) hit429 = true; before(...a); };
    const domain = await aiService.classifyCardDomain(content);
    console.warn = before;
    if (domain || !hit429) return domain;
    const wait = 15000 * (i + 1);
    console.log(`   …429, waiting ${wait / 1000}s then retrying`);
    await sleep(wait);
  }
  return null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL);

  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  const query = ALL ? {} : { $or: [{ domain: null }, { domain: { $exists: false } }] };
  let q = AnswerCard.find(query).select('answerContent domain mentorId');
  if (LIMIT) q = q.limit(LIMIT);
  const cards = await q.lean();

  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'} | scope: ${ALL ? 'ALL cards' : 'unset only'} | count: ${cards.length}\n`);

  const tally = {};
  let updated = 0;

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const domain = await classifyWithRetry(c.answerContent);
    tally[domain ?? 'null'] = (tally[domain ?? 'null'] || 0) + 1;

    const situ = (c.answerContent?.situation || c.answerContent?.mainAnswer || '').slice(0, 55);
    console.log(`[${i + 1}/${cards.length}] ${domain ? '✓ ' + domain.padEnd(16) : '· null           '} | "${situ}"`);

    if (APPLY && domain) {
      await AnswerCard.updateOne({ _id: c._id }, { $set: { domain } });
      updated++;
    }
    if (i < cards.length - 1) await sleep(SLEEP_MS);
  }

  console.log(`\n──────── SUMMARY ────────`);
  console.log('Tally:', JSON.stringify(tally));
  console.log(APPLY ? `Written: ${updated} | left null: ${cards.length - updated}` : 'DRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
  process.exit(0);
})();
