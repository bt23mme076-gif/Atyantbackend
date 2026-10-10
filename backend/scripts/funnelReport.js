// ─────────────────────────────────────────────────────────────────────────────
//  Funnel report: how many students reach each step, and where they drop.
//
//  USAGE (from backend/ folder):
//    node scripts/funnelReport.js            # last 30 days
//    node scripts/funnelReport.js --days=7
//
//  Steps are counted per unique chat session (funnelId), so one student
//  refreshing or re-sending doesn't inflate a step. Purchases are counted per
//  unique payment (refId); "after chat" ones are by students who also chatted.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import FunnelEvent from '../models/FunnelEvent.js';
import { FUNNEL_STEPS } from '../utils/funnel.js';

const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  const counts = {};
  for (const step of FUNNEL_STEPS.filter(s => s !== 'purchase')) {
    counts[step] = (await FunnelEvent.distinct('funnelId', {
      event: step, createdAt: { $gte: since }, funnelId: { $ne: null },
    })).length;
  }

  const purchases = await FunnelEvent.find({ event: 'purchase', createdAt: { $gte: since } })
    .select('userId props').lean();
  const uniquePurchases = new Map(purchases.map(p => [p.props?.refId || String(p._id), p]));
  const chatUsers = new Set((await FunnelEvent.distinct('userId', {
    event: 'chat_started', createdAt: { $gte: since }, userId: { $ne: null },
  })).map(String));
  const afterChat = [...uniquePurchases.values()].filter(p => p.userId && chatUsers.has(String(p.userId))).length;

  console.log(`\nFunnel — last ${DAYS} days (unique chat sessions)\n`);
  const first = counts.chat_started || 0;
  let prev = null;
  for (const step of Object.keys(counts)) {
    const n = counts[step];
    const ofStart = first ? `${((n / first) * 100).toFixed(1)}% of chats` : '';
    const fromPrev = prev ? `${prev ? ((n / prev) * 100).toFixed(1) : '0'}% of previous step` : '';
    console.log(`  ${step.padEnd(22)} ${String(n).padStart(6)}   ${ofStart.padEnd(16)} ${fromPrev}`);
    prev = n || null;
  }
  console.log(`  ${'purchase'.padEnd(22)} ${String(uniquePurchases.size).padStart(6)}   (${afterChat} by students who chatted)`);

  const handoffs = await FunnelEvent.find({ event: 'handoff_shown', createdAt: { $gte: since } })
    .select('props').lean();
  if (handoffs.length) {
    const avg = (k) => (handoffs.reduce((s, h) => s + (h.props?.[k] || 0), 0) / handoffs.length).toFixed(1);
    const noCampus = handoffs.filter(h => !(h.props?.sameCollege > 0)).length;
    console.log(`\nHandoffs: ${handoffs.length} | avg ${avg('mentors')} seniors shown | avg ${avg('assistantTurns')} AI replies before mentors`);
    console.log(`          ${((noCampus / handoffs.length) * 100).toFixed(0)}% showed no senior from the student's own college`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
