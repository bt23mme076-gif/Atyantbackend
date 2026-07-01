// ─────────────────────────────────────────────────────────────────────────────
//  READ-ONLY analysis: how well are mentors tagged for GOAL_MATCH?
//
//  GOAL_MATCH (700 pts, the strongest signal in scoreMentor) only fires when a
//  goal token like "iim"/"iit"/"faang" is found in a mentor's specialTags,
//  topCompanies, milestones, bio or companyDomain. This script measures coverage:
//  how many mentors COULD be matched on those tokens, and how many are silently
//  invisible because the token lives only in their college name (full or short).
//
//  Writes nothing. Safe to run anytime.
//    node scripts/analyzeMentorTags.js
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';

// Same distinctive tokens scoreMentor's extractGoalSignals looks for.
const GOAL_SIGNAL_TAGS = [
  'iim', 'iit', 'iiit', 'bits', 'isb',
  'faang', 'maang', 'google', 'amazon', 'microsoft', 'meta', 'apple', 'netflix',
  'mba', 'mtech', 'phd', 'gate', 'gre', 'gmat', 'cat', 'upsc',
  'consulting', 'quant', 'trading', 'fintech', 'product',
  'research', 'startup', 'foreign', 'abroad', 'gsoc',
];

// Full-name → token, so "Indian Institute of Management" counts as iim coverage
// the regex token-match currently MISSES.
const FULLNAME_HINTS = [
  [/indian institute of management/i, 'iim'],
  [/indian institute of technology/i, 'iit'],
  [/international institute of information technology|institute of information technology/i, 'iiit'],
  [/birla institute|bits pilani/i, 'bits'],
  [/indian school of business/i, 'isb'],
];

const hasToken = (hay, tok) => new RegExp(`\\b${tok}\\b`, 'i').test(hay) || hay.toLowerCase().includes(tok);

async function run() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const mentors = await User.find({ role: 'mentor' })
    .select('username specialTags topCompanies milestones bio companyDomain education expertise primaryDomain')
    .lean();

  console.log(`\n📊 Total mentors: ${mentors.length}\n`);

  // ── Field-fill coverage ──
  const filled = { specialTags: 0, topCompanies: 0, milestones: 0, bio: 0, expertise: 0, primaryDomain: 0, education: 0 };
  for (const m of mentors) {
    if ((m.specialTags || []).length) filled.specialTags++;
    if ((m.topCompanies || []).length) filled.topCompanies++;
    if ((m.milestones || []).length) filled.milestones++;
    if (m.bio && m.bio.trim()) filled.bio++;
    if ((m.expertise || []).length) filled.expertise++;
    if (m.primaryDomain) filled.primaryDomain++;
    const edu = m.education?.[0] || {};
    if (edu.institutionName || edu.institution) filled.education++;
  }
  const pct = n => `${n} (${Math.round((n / mentors.length) * 100)}%)`;
  console.log('── Field fill rates ──');
  for (const [k, v] of Object.entries(filled)) console.log(`  ${k.padEnd(14)} ${pct(v)}`);

  // ── GOAL_MATCH coverage per token ──
  // "matchable"   = token appears where extractGoalSignals/scoreMentor look today.
  // "collegeOnly" = token is NOT in those fields but IS in the college name
  //                 (incl. full-name form) → currently MISSED, recoverable by backfill.
  console.log('\n── GOAL_MATCH token coverage (the signal that ranks IIM/IIT goals) ──');
  console.log('  token        matchable   collegeOnly(missed)');

  const recoverable = []; // mentors we could fix
  for (const tok of GOAL_SIGNAL_TAGS) {
    let matchable = 0, collegeOnly = 0;
    for (const m of mentors) {
      const scoredHay = [
        ...(m.specialTags || []), ...(m.topCompanies || []), ...(m.milestones || []),
        m.bio || '', m.companyDomain || '',
      ].join(' ');
      const edu = m.education?.[0] || {};
      const college = `${edu.institutionName || ''} ${edu.institution || ''}`;
      const collegeToken = hasToken(college, tok) || FULLNAME_HINTS.some(([re, t]) => t === tok && re.test(college));

      if (hasToken(scoredHay, tok)) matchable++;
      else if (collegeToken) { collegeOnly++; recoverable.push({ username: m.username, tok, college: college.trim() }); }
    }
    if (matchable || collegeOnly) {
      console.log(`  ${tok.padEnd(12)} ${String(matchable).padEnd(11)} ${collegeOnly}`);
    }
  }

  // ── Mentors with ZERO matchable signal at all ──
  let zero = 0;
  for (const m of mentors) {
    const scoredHay = [
      ...(m.specialTags || []), ...(m.topCompanies || []), ...(m.milestones || []),
      m.bio || '', m.companyDomain || '',
    ].join(' ');
    if (!GOAL_SIGNAL_TAGS.some(t => hasToken(scoredHay, t))) zero++;
  }

  console.log(`\n── Summary ──`);
  console.log(`  Mentors with NO goal-signal token in scored fields: ${pct(zero)}`);
  console.log(`  Recoverable (token sits only in college name): ${recoverable.length} mentor-token pairs`);

  if (recoverable.length) {
    console.log('\n  Sample recoverable mentors (first 15):');
    recoverable.slice(0, 15).forEach(r => console.log(`    ${r.username || '(no name)'} → +${r.tok}   [${r.college}]`));
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Analysis crashed:', err);
  process.exit(1);
});
