// ─────────────────────────────────────────────────────────────────────────────
//  User journeys: who came, what they did, in order, and where they left.
//
//  USAGE (from backend/ folder):
//    node scripts/userJourneys.js                    # last 7 days, 30 most recent people
//    node scripts/userJourneys.js --days=30 --limit=100
//    node scripts/userJourneys.js --user=someone@gmail.com   # one person's full journey
//
//  A "person" is a signed-in user, or for guests the browser's visitorId. A
//  guest's earlier events are linked to their account once they sign in
//  (routes/eventRoutes.js), so they appear here under their name from then on.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import FunnelEvent from '../models/FunnelEvent.js';
import User from '../models/User.js';

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const DAYS = parseInt(arg('days') || '7', 10);
const LIMIT = parseInt(arg('limit') || '30', 10);
const USER_EMAIL = arg('user');

const PAGE_NAMES = {
  ask: 'Ask Atyant (chat)', clarity: 'Clarity results', book: 'Book a session', sessions: 'My sessions',
  jobs: 'Jobs', roadmap: 'Roadmap', saved: 'Saved answers', profile: 'Profile', upgrade: 'Upgrade',
  chat: 'Messages', track: 'Track', tpo: 'TPO',
};
const label = (e) => {
  switch (e.event) {
    case 'page_view': return `opened ${PAGE_NAMES[e.props?.page] || e.props?.page || 'a page'}`;
    case 'chat_started': return 'started a chat';
    case 'handoff_shown': return `was shown ${e.props?.mentors ?? '?'} seniors`;
    case 'chat_mentor_clicked': return `tapped senior #${e.props?.position ?? '?'} in chat`;
    case 'clarity_opened': return null; // same moment as the clarity page_view — funnelReport uses it
    case 'mentor_profile_opened': return 'viewed a senior\'s profile';
    case 'booking_started': return 'started booking';
    case 'purchase': return `PAID (${e.props?.kind || 'purchase'})`;
    default: return e.event;
  }
};
const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  const query = { createdAt: { $gte: since } };
  if (USER_EMAIL) {
    const u = await User.findOne({ email: USER_EMAIL.toLowerCase() }).select('_id').lean();
    if (!u) { console.log(`No user with email ${USER_EMAIL}`); return mongoose.disconnect(); }
    query.userId = u._id;
  }
  const events = await FunnelEvent.find(query).sort({ createdAt: 1 }).lean();

  // Server-side chat events only carry the chat session id; borrow the visitor
  // id from any client event in the same chat session so they group together.
  const visitorForFunnel = new Map();
  for (const e of events) if (e.funnelId && e.visitorId) visitorForFunnel.set(e.funnelId, e.visitorId);
  const userForVisitor = new Map();
  for (const e of events) if (e.userId && e.visitorId) userForVisitor.set(e.visitorId, String(e.userId));

  const people = new Map();
  for (const e of events) {
    const vid = e.visitorId || visitorForFunnel.get(e.funnelId) || null;
    const key = e.userId ? `u:${e.userId}` : (vid && userForVisitor.get(vid)) ? `u:${userForVisitor.get(vid)}`
      : vid ? `v:${vid}` : e.funnelId ? `f:${e.funnelId}` : null;
    if (!key) continue;
    if (!people.has(key)) people.set(key, []);
    const steps = people.get(key);
    const text = label(e);
    if (!text) continue;
    if (steps.length && steps[steps.length - 1].text === text) continue; // collapse repeats
    steps.push({ text, at: e.createdAt, event: e.event });
  }

  const userIds = [...people.keys()].filter(k => k.startsWith('u:')).map(k => k.slice(2));
  const users = new Map((await User.find({ _id: { $in: userIds } }).select('name username email phone').lean())
    .map(u => [String(u._id), u]));
  const who = (key) => {
    if (!key.startsWith('u:')) return `Guest (${key.slice(2, 12)}…)`;
    const u = users.get(key.slice(2)) || {};
    return [u.name || u.username || 'User', u.email, u.phone].filter(Boolean).join(' · ');
  };

  const list = [...people.entries()]
    .map(([key, steps]) => ({ key, steps, last: steps[steps.length - 1] }))
    .sort((a, b) => b.last.at - a.last.at);

  // Where people left: the last thing each person did.
  const leftAt = new Map();
  for (const p of list) {
    const k = p.steps.some(s => s.event === 'purchase') ? 'PAID' : p.last.text;
    leftAt.set(k, (leftAt.get(k) || 0) + 1);
  }
  console.log(`\nLast ${DAYS} days — ${list.length} people (${userIds.length} signed in, ${list.length - userIds.length} guests)`);
  console.log('\nWhere people left (their last step):');
  for (const [k, n] of [...leftAt.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

  const followUp = list.filter(p => p.key.startsWith('u:')
    && p.steps.some(s => s.event === 'booking_started') && !p.steps.some(s => s.event === 'purchase'));
  console.log(`\nFollow up — signed in, started booking, didn't pay (${followUp.length}):`);
  for (const p of followUp) console.log(`  • ${who(p.key)}  — last seen ${fmt(p.last.at)}`);

  console.log(`\nJourneys (most recent ${Math.min(LIMIT, list.length)}):`);
  for (const p of list.slice(0, LIMIT)) {
    console.log(`\n  ${who(p.key)}`);
    for (const s of p.steps) console.log(`    ${fmt(s.at)}  ${s.text}`);
    if (!p.steps.some(s => s.event === 'purchase')) console.log(`    → left after: ${p.last.text}`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
