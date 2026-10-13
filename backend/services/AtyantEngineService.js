import AtyantConversation from '../models/AtyantConversation.js';
import User from '../models/User.js';
// ─── Groq — shared rotating client ───────────────────────────────────────────
// All Groq traffic in the backend flows through utils/groqClient.js, which does
// multi-key round-robin + cooldown failover (see that file). Add GROQ_API_KEY_2
// / _3 from SEPARATE Groq accounts in .env to multiply throughput.
import { groqChat, groqJSON, groqChatStream } from '../utils/groqClient.js';
import { claudeChatStream } from '../utils/claudeClient.js';
import atyantEngine, { isSameCollege } from './AtyantEngine.js';
import { isSameBranch } from '../utils/collegeNormalizer.js';
import { logFunnel } from '../utils/funnel.js';
import { extractResumeFromImage } from '../utils/geminiVision.js';

// Chat reply. A touch of warmth without rambling — too high and it produces
// run-on, broken sentences instead of one clean question.
const callGroq = (messages, opts = {}) => groqChat(messages, { temperature: 0.75, ...opts });

// Streaming variant — same call, but each token lands on the client as it's
// generated instead of the whole reply arriving at once at the end. `emit` is
// the same progress callback finishTurn/processResumeUpload already thread
// through everywhere else, so a `token` event flows out over the existing SSE
// connection with no route changes needed.
// Reasoning replies (the final mentor-match wrap-up) run on Claude
// (utils/claudeClient.js). Everyday intake chat runs on the free Groq tier and
// falls back to Claude if Groq is down — but only before any token has been
// shown, so a half-streamed reply is never duplicated.
const callClaudeStream = (messages, emit, opts = {}) =>
  claudeChatStream(messages, { ...opts, onToken: (text) => emit({ type: 'token', text }) });

const callChatStream = async (messages, emit, { reminder, ...opts } = {}) => {
  let streamed = false;
  const onToken = (text) => { streamed = true; emit({ type: 'token', text }); };
  // Reminder goes last, after the student's latest turn, where the model weighs it most.
  const withReminder = reminder ? [...messages, { role: 'system', content: reminder }] : messages;
  try {
    return await groqChatStream(withReminder, { maxTokens: 300, ...opts, onToken });
  } catch (err) {
    if (streamed) throw err;
    console.error('Groq chat failed, falling back to Claude:', err.message);
    return claudeChatStream(messages, { reminder, ...opts, onToken });
  }
};

// ─── Dedicated context extractor ──────────────────────────────────────────────
// A small, fast, deterministic model with JSON mode. This is the SOURCE OF TRUTH
// for the 5-layer context — it does not depend on the chat model emitting tags.
const callGroqJSON = (messages, opts = {}) => groqJSON(messages, { maxTokens: 400, ...opts });

const EXTRACTION_PROMPT = `You extract structured profile data for an Indian engineering student career platform.

CRITICAL RULES — follow exactly:
- The input contains ONLY the student's own messages. Use ONLY facts explicitly written there.
- If a field was not explicitly stated by the student, its value MUST be null (or [] for arrays).
- NEVER guess, infer, assume, or copy any example. NEVER invent a college name. NEVER invent a CGPA or any number.
- If the messages contain no factual profile info at all, return every field as null/[].
- The comments below describe the TYPE of each field. They are NOT defaults and must never be used as values.

Return ONLY a JSON object with these keys:
{
  "college": null,        // exact college/institute name the student stated; else null
  "collegeType": null,    // only if a college was stated: one of IIT, NIT-top, NIT-other, IIIT, BITS, Tier-2, Tier-3, private; else null
  "branch": null,         // the student's stated branch/department; else null
  "year": null,           // "1","2","3","4" or "final" if stated; else null
  "cgpa": null,           // the student's stated CGPA as a string; else null
  "target": null,         // the student's stated goal, INCLUDING any field/domain/role they named in ANY message (e.g. "internship" then later "core, power systems" → "core electrical internship (power systems)"). Never fold their BRANCH into the goal — "internship" from an electrical student stays "internship"; else null
  "targetCompanies": [],   // companies the student said they're aiming for; [] if none, "not sure" or "any"
  "timeline": null,       // the student's stated timeframe; else null
  "gap": [],               // blockers the student stated, as short strings
  "constraint": []         // hard limits the student stated, as short strings
}
Output ONLY the JSON object, nothing else.`;

// Small models occasionally return the wrong shape (a number for cgpa, an array
// for a scalar field). Coerce defensively so the problem statement never breaks.
function toScalarString(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) v = v.filter(x => x !== null && x !== undefined).join(' ');
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}
function toStringArray(v) {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => (x === null || x === undefined ? '' : String(x).trim())).filter(Boolean);
}

// Map the extractor's flat output → the conversation context schema mergeContext expects.
function extractionToContext(parsed = {}) {
  return {
    identity: {
      college:     toScalarString(parsed.college),
      collegeType: toScalarString(parsed.collegeType),
      branch:      toScalarString(parsed.branch),
      year:        toScalarString(parsed.year),
      cgpa:        toScalarString(parsed.cgpa),
    },
    target:     toScalarString(parsed.target),
    targetCompanies: toStringArray(parsed.targetCompanies),
    timeline:   toScalarString(parsed.timeline),
    gap:        toStringArray(parsed.gap),
    constraint: toStringArray(parsed.constraint),
  };
}

async function extractStudentContext(messages) {
  try {
    // STUDENT MESSAGES ONLY. Assistant turns mention college names constantly
    // (the greeting example, "At VNIT, Metallurgy folks usually…") and the small
    // extractor model was lifting those as the student's real profile —
    // fabricated college/branch/CGPA that then drove completely wrong matching.
    const convoText = messages
      .filter(m => m.role === 'user')
      .slice(-8)
      .map(m => `student: ${m.content}`)
      .join('\n');
    if (!convoText.trim()) return null;

    const parsed = await callGroqJSON([
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: `Student's messages (nothing else exists):\n${convoText}\n\nExtract the JSON now.` },
    ]);

    return extractionToContext(parsed);
  } catch (err) {
    console.error('extractStudentContext failed (non-fatal):', err.message);
    return null; // fall back to whatever context we already had
  }
}

const RESUME_EXTRACTION_PROMPT = `You extract structured profile data from an Indian engineering student's résumé/CV text for a career-matching platform.

CRITICAL RULES — follow exactly:
- Use ONLY facts explicitly present in the résumé text.
- If a field isn't stated, its value MUST be null (or [] for arrays). NEVER guess, infer, or invent a college, CGPA, or number.
- Most résumés do NOT state a career goal, timeline, or constraints directly — leave those null/[] unless genuinely present (e.g. an explicit "Objective" line).

Return ONLY a JSON object with these keys:
{
  "college": null,        // their current/most recent college or institute name; else null
  "collegeType": null,    // one of IIT, NIT-top, NIT-other, IIIT, BITS, Tier-2, Tier-3, private; else null
  "branch": null,         // their branch/department; else null
  "year": null,           // "1","2","3","4" or "final" if inferable from graduation year; else null
  "cgpa": null,           // their stated CGPA/GPA as a string; else null
  "target": null,         // an explicit stated career goal/objective, if present; else null
  "timeline": null,       // an explicit stated timeframe, if present; else null
  "gap": [],               // explicit stated blockers, if any
  "constraint": []         // explicit stated hard limits, if any
}
Output ONLY the JSON object, nothing else.`;

// Résumé (PDF text) → same context shape as extractStudentContext, so it can
// merge straight into the conversation and drive the same routing/reply logic.
export async function extractContextFromResumeText(resumeText) {
  try {
    const parsed = await callGroqJSON([
      { role: 'system', content: RESUME_EXTRACTION_PROMPT },
      { role: 'user', content: `Résumé text:\n${String(resumeText).slice(0, 9000)}\n\nExtract the JSON now.` },
    ]);
    return extractionToContext(parsed);
  } catch (err) {
    console.error('extractContextFromResumeText failed (non-fatal):', err.message);
    return null;
  }
}

// Photo of a résumé — Gemini reads it directly (no separate OCR step) and
// returns the same flat shape, mapped through the same context schema.
export async function extractContextFromResumeImage(base64Data, mimeType) {
  try {
    const parsed = await extractResumeFromImage(base64Data, mimeType);
    return parsed ? extractionToContext(parsed) : null;
  } catch (err) {
    console.error('extractContextFromResumeImage failed (non-fatal):', err.message);
    return null;
  }
}

// Build Groq/OpenAI messages: system + recent turns.
// conv.messages already includes the current user turn, so no re-append needed.
function toGroqMessages(systemText, messages) {
  const recent = messages.slice(-10); // last 5 turns only — saves input tokens
  return [
    { role: 'system', content: systemText },
    ...recent.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];
}

// ─── Prompts ────────────────────────────────────────────────────────────────

// Human base voice. A bit longer than the old lean prompt, but the extra rules
// (react first, never repeat yourself) are what make it stop sounding like a bot.
const MASTER_SYSTEM_PROMPT = `You are Atyant — a career guide for Indian engineering students, built by VNIT students. You talk like a sharp, friendly senior from their own college texting them — never a corporate bot or an "AI assistant".

Voice:
- Warm, real, direct. Someone who's actually been where they are and wants to help.
- Use contractions and everyday words. Short sentences. The odd fragment is fine.
- React to what they JUST said before moving on — a few words that show you actually read it.
- Read their mood: stressed → steady them; casual → be casual. If they write in Hindi, reply in light Hinglish.

Never sound scripted:
- NEVER repeat a question, sentence, or framing you've already used in this chat. If your last try didn't land, come at it a new way or just ask simpler.
- Don't open with an acknowledgement word. Banned openers: "Got it", "Understood", "Okay", "Sure", "Great question", "Certainly", "As an AI".
- No corporate filler: "leverage", "empower", "delve", "unlock", "journey", "I'd be happy to", "Let me help".
- Keep it tight — max 3 short sentences per paragraph, no bullet-point dumps.

Facts:
- You have NO data on which companies recruit from which college, placement numbers, or what a campus's batch usually does. Never state those as facts ("they hire from Trichy every year", "most of your batch goes core"). Talk about what the path itself takes — skills, projects, prep — not who recruits where.
- Never invent a name, company, college, CGPA, or number.
Be a person, not a form.`;

// Collection phase — ask only what the mentor scorer uses (college, branch, goal
// field, target company). Blockers/timeline/constraints are captured silently
// if the student volunteers them, never asked.
const COLLECTION_SYSTEM = `${MASTER_SYSTEM_PROMPT}

You're still getting to know them so you can match them to the right senior's path. The only things you ever ask about are their college, branch, goal (and its field), and any company they're aiming for. Never ask what's stopping them, their timeline, or their constraints.

How to gather it like a human, not an intake form:
- React to their last message first (a few words), THEN ask for ONE missing thing. Don't fire questions back-to-back.
- Make every question feel worth answering: give them something first (a quick real insight about their path), or say in a few words why you're asking — it's so you can find a senior who's been exactly where they are.
- If a question is optional, make that obvious and easy — "no idea yet" is a perfectly good answer.
- Bundle naturally only when it genuinely fits — the way a senior would actually ask over chat. Never a checklist.
- If their message is unclear or doesn't answer you, say so honestly and ask again, simpler. Don't pretend you understood, and never make up a detail they didn't give.
- Skip anything the "Context extracted so far" block already has. Don't ask CGPA unless it actually matters here.
- Once you know their branch, show you get their situation — what this path usually takes for someone in their branch — in your OWN words, phrased DIFFERENTLY every time. No campus-specific claims (see Facts).
- If their goal is vague ("internship"/"placement"), the next thing to pin down is the DIRECTION — tech, core, or something else — framed by the options their branch genuinely has.
- FORMAT: at most 2 sentences, under 30 words — one short reaction or insight, then ONE clear question ending in a question mark. Output only your message — no JSON, no tags.`;

// Engine phase — final handoff. NO more questions; wrap up and route to clarity.
const ENGINE_SYSTEM = `${MASTER_SYSTEM_PROMPT}

You've got enough now — no more questions. FORMAT: EXACTLY 3 short sentences, about 50 words total, one paragraph. Long replies lose students — cut, don't cram.
1. A specific read on THEM (their branch, goal, any target company): what this path actually takes — concrete skills or projects, not generic advice.
2. One sharp next step they can start this week.
3. The handoff, built ONLY from the "Matched seniors" line you're given — say truthfully what matched, in your own words. If none share their college, don't imply they do. If there are none, say you're still finding the right senior for them.
Don't end on a question. Don't say results are "below".`;

// Per-turn length rules, sent after the student's latest message (see
// claudeChatStream) — the system-prompt word limits alone were ignored.
const COLLECT_REMINDER = "Reply now: at most 2 sentences, each under 15 words — a quick reaction, then your one question. No lists, nothing else.";
const ENGINE_REMINDER = "Reply now: exactly 3 sentences, EACH under 18 words, one paragraph. One idea per sentence — no lists of skills. No preamble (never announce 'no more questions'). Only claim what the Matched seniors line says — never imply they worked at a company it doesn't name.";

// ─── Helpers ────────────────────────────────────────────────────────────────

function countLayers(context = {}) {
  let count = 0;
  const { identity = {}, target, gap = [], timeline, constraint = [] } = context;

  if (identity.branch || identity.year || identity.college) count++;
  if (target) count++;
  if (gap.length > 0) count++;
  if (timeline) count++;
  if (constraint.length > 0) count++;

  return count;
}

// A goal is only matchable once we know the FIELD/DOMAIN, not just "internship".
// "internship" alone matches no mentor expertise; "SDE internship" / "ML
// internship" does. This is the difference between a real match and a random one.
const GOAL_FIELD_RE = /\b(sde|swe|software|backend|front[- ]?end|full[- ]?stack|web\s?dev|app\s?dev|\bdev\b|data(\s?science|\s?engineer|\s?analyst)?|\bds\b|\bml\b|\bai\b|machine\s?learning|deep\s?learning|\bnlp\b|computer\s?vision|analyt\w*|\bcore\b|non[- ]?core|mechanical|civil|electrical|electronics|vlsi|embedded|hardware|consult\w*|finance|fintech|quant|trading|product(\s?management|\s?manager)?|\bpm\b|design|\bux\b|\bui\b|marketing|sales|research|\bms\b|\bmba\b|\bgate\b|\bgre\b|higher\s?stud\w*|phd|startup|founder|cyber\s?sec\w*|devops|cloud|blockchain|robotics)\b/i;

function goalHasField(context = {}) {
  const text = [context.target, ...(context.gap || []), ...(context.constraint || [])]
    .filter(Boolean).join(' ');
  return GOAL_FIELD_RE.test(text);
}

// What we ACTUALLY need to connect a student to a mentor: their BRANCH + a goal
// that names a FIELD/DOMAIN (so the match is real, not random). College (a top
// scorer signal) and target company are each asked at most ONCE — if the student
// skips them we route anyway. Blockers/timeline/constraints are never gates —
// requiring all five was the bug that trapped students forever.
function readyToRoute(context = {}, asked = {}) {
  const id = context.identity || {};
  return !!id.branch && goalHasField(context)
    && (!!id.college || !!asked.college)
    && ((context.targetCompanies || []).length > 0 || !!asked.company);
}

// Detect an explicit ask to be connected to a mentor/senior ("connect me with a
// mentor", "talk to a senior", "i want a mentor"). When the student asks, we
// stop interrogating and route.
function wantsMentor(message) {
  const m = String(message || '').toLowerCase();
  if (!/\bmentor|\bsenior|\bguide\b/.test(m)) return false;
  return /connect|talk|speak|chat|find|need|want|get|meet|book|assign|introduce/.test(m);
}

function generateProblemStatement(context = {}) {
  const { identity = {}, target, targetCompanies = [], gap = [], timeline, constraint = [] } = context;
  const lines = [];

  const idParts = [
    identity.college || identity.collegeType,
    identity.branch,
    identity.year ? `Year ${identity.year}` : null,
    identity.cgpa ? `CGPA ${identity.cgpa}` : null
  ].filter(Boolean);

  if (idParts.length) lines.push(`Student: ${idParts.join(' | ')}`);
  if (target)            lines.push(`Goal: ${target}`);
  if (targetCompanies.length) lines.push(`Target companies: ${targetCompanies.join(', ')}`);
  if (gap.length)        lines.push(`Gap: ${gap.join(', ')}`);
  if (timeline)          lines.push(`Timeline: ${timeline}`);
  if (constraint.length) lines.push(`Constraint: ${constraint.join(', ')}`);

  const layers = countLayers(context);
  const confidence = layers >= 4 ? 'High' : layers >= 3 ? 'Medium' : 'Low';
  lines.push(`Confidence: ${confidence} (${layers}/5 layers extracted)`);

  return lines.join('\n');
}

function parseContextUpdate(text) {
  // Tolerant of malformed openers the model sometimes emits: "/context_update>",
  // "context_update>", "<context_update>". Close tag optional (falls back to end).
  const match = text.match(/<?\/?\s*context_update\s*>\s*([\s\S]*?)\s*(?:<\/?\s*context_update\s*>|$)/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    // Last resort: grab the first {...} block after the marker
    const obj = match[1].match(/\{[\s\S]*\}/);
    if (obj) { try { return JSON.parse(obj[0]); } catch { /* noop */ } }
    return null;
  }
}

function parseOutputMode(text) {
  const match = text.match(/<output_mode>\s*([\w_]+)\s*<\/output_mode>/);
  if (!match) return 'AI_ANSWER';
  const mode = match[1].trim().toUpperCase();
  return ['AI_ANSWER', 'MENTOR_ROUTING', 'CLARIFY'].includes(mode) ? mode : 'AI_ANSWER';
}

function stripTags(text) {
  return text
    // Strip closed <think>...</think> reasoning blocks (DeepSeek/Qwen traces)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Strip an UNCLOSED <think> (response truncated mid-reasoning): drop everything
    // from the opening tag to the end — this is the leak that broke the chat.
    .replace(/<think>[\s\S]*$/gi, '')
    // Drop any stray standalone reasoning tags
    .replace(/<\/?\s*think\s*>/gi, '')
    // Tolerant of malformed openers ("/context_update>", "context_update>") and a
    // missing close tag (strips to end of text). This is what was leaking JSON to users.
    .replace(/<?\/?\s*context_update\s*>[\s\S]*?(?:<\/?\s*context_update\s*>|$)/gi, '')
    .replace(/<?\/?\s*output_mode\s*>[\s\S]*?(?:<\/?\s*output_mode\s*>|$)/gi, '')
    // Sweep any stray tag fragments left behind
    .replace(/<\/?\s*(?:context_update|output_mode)\s*>/gi, '')
    // A bare JSON blob with our exact context keys also gets stripped as a fallback
    .replace(/\{[\s\S]*?"identity"[\s\S]*?\}\s*\}/gi, '')
    .trim();
}

function mergeContext(existing = {}, update) {
  if (!update) return existing;

  const merged = {
    identity: { ...(existing.identity || {}) },
    target: existing.target || null,
    targetCompanies: [...(existing.targetCompanies || [])],
    gap: [...(existing.gap || [])],
    timeline: existing.timeline || null,
    constraint: [...(existing.constraint || [])]
  };

  if (update.identity) {
    for (const [k, v] of Object.entries(update.identity)) {
      if (v !== null && v !== undefined && v !== '') {
        merged.identity[k] = v;
      }
    }
  }

  // A re-extracted vague goal ("internship") must not wipe one that already
  // names its field ("internship (core electrical)").
  if (update.target && !(goalHasField({ target: merged.target }) && !goalHasField({ target: update.target }))) {
    merged.target = update.target;
  }

  if (Array.isArray(update.gap) && update.gap.length > 0) {
    merged.gap = [...new Set([...merged.gap, ...update.gap.filter(Boolean)])];
  }

  if (Array.isArray(update.targetCompanies) && update.targetCompanies.length > 0) {
    merged.targetCompanies = [...new Set([...merged.targetCompanies, ...update.targetCompanies.filter(Boolean)])];
  }

  if (update.timeline) merged.timeline = update.timeline;

  if (Array.isArray(update.constraint) && update.constraint.length > 0) {
    merged.constraint = [...new Set([...merged.constraint, ...update.constraint.filter(Boolean)])];
  }

  return merged;
}

const MENTOR_FIELDS = 'name username profilePicture bio expertise interests topCompanies companyDomain education lastActive';

// Words that carry no matching signal but, unanchored, match inside half the
// corpus — "and" hits "Brand Building", "Pandas", "handling". Dropping them is
// what stops a metallurgy student being matched to a brand-building mentor.
const MATCH_STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'for', 'to', 'with', 'at', 'on',
  'my', 'me', 'i', 'is', 'am', 'are', 'be', 'get', 'got', 'want', 'need',
  'engineering', 'engineer', 'branch', 'year', 'student', 'role', 'roles', 'job', 'jobs',
  'management', // "product management" must not claim overlap with "People Management"
]);

// Build search tokens from a free-text phrase: lowercase, split, drop stopwords
// and 1-2 char noise. Returns [] when nothing meaningful survives, so callers
// can tell "no signal" apart from "searched and found nothing".
function matchTokens(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)          // keep c++, c#, node.js intact
    .filter(t => t.length > 2 && !MATCH_STOPWORDS.has(t));
}

// Whole-token, regex-safe matcher. Escaping matters: an unescaped "c++" makes
// `new RegExp` throw ("Nothing to repeat"), which used to bubble out of
// matchMentors and leave the student with NO mentors at all.
function tokenRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

// Find REAL mentors from the DB to back a MENTOR_ROUTING decision. The LLM must
// never invent mentors — this is the only source of truth the frontend renders.
//
// Each result carries `matchedOn`: the fields that genuinely matched, empty for
// a fallback pick. Nothing downstream should claim relevance a mentor doesn't
// have, and this is what makes that checkable rather than assumed.
async function keywordMatchMentors(context = {}, limit = 3) {
  const { identity = {}, target } = context;

  // `gap` is deliberately excluded — blockers read like "not prepared" / "no
  // coding experience", which describe the student's problem, not a skill any
  // mentor lists. As search terms they only ever added noise.
  const tokens = [...new Set([...matchTokens(target), ...matchTokens(identity.branch)])];

  let mentors = [];
  if (tokens.length) {
    const rx = tokens.map(tokenRegex);
    mentors = await User.find({
      role: 'mentor',
      $or: [
        { expertise: { $in: rx } },
        { interests: { $in: rx } },
        { domainExperience: { $in: rx } },
        { topCompanies: { $in: rx } },
      ],
    }).select(MENTOR_FIELDS).limit(limit).lean();
  }

  const relevantIds = new Set(mentors.map(m => String(m._id)));

  // Fallback: most recently active mentors so the user is never shown nothing.
  if (mentors.length < limit) {
    const fill = await User.find({ role: 'mentor', _id: { $nin: [...relevantIds] } })
      .select(MENTOR_FIELDS)
      .sort({ lastActive: -1 })
      .limit(limit - mentors.length)
      .lean();
    mentors = [...mentors, ...fill];
  }

  const rx = tokens.map(tokenRegex);
  const hitsIn = (values = []) => [
    ...new Set(values.filter(v => rx.some(r => r.test(String(v))))),
  ];

  return mentors.map(m => ({
    id: String(m._id),
    // Most mentor records have no `name` set — fall back to username so cards never render blank.
    name: m.name || m.username || 'Atyant Mentor',
    username: m.username,
    profilePicture: m.profilePicture,
    bio: m.bio,
    expertise: m.expertise || [],
    topCompanies: m.topCompanies || [],
    companyDomain: m.companyDomain,
    college: m.education?.[0]?.institutionName || m.education?.[0]?.institution || null,
    isRelevanceMatch: relevantIds.has(String(m._id)),
    matchedOn: relevantIds.has(String(m._id))
      ? {
          expertise: hitsIn(m.expertise),
          interests: hitsIn(m.interests),
          domainExperience: hitsIn(m.domainExperience),
          topCompanies: hitsIn(m.topCompanies),
        }
      : null,
  }));
}

// Ranked match through the same scorer the clarity page uses (college, branch,
// goal/domain, companies, feedback, load). `matchedOn` lists only overlap we can
// show the student; a mentor ranked on quality signals alone gets null, and the
// card labels it as a suggestion. Falls back to the keyword match when the
// scorer qualifies nobody.
async function matchMentors(context = {}, problemStatement = '', userId = null, limit = 3) {
  const { identity = {}, target } = context;
  const companies = context.targetCompanies || [];
  const goal = [target, ...companies].filter(Boolean).join(', ');
  const studentContext = { college: identity.college, branch: identity.branch, year: identity.year, goal };
  const queryText = [problemStatement, goal].filter(Boolean).join('\n');

  const { mentors: ranked, targetDomain } = await atyantEngine.matchMentorsForChat(userId, queryText, studentContext, limit);
  if (!ranked.length) return keywordMatchMentors(context, limit);

  const display = await User.find({ _id: { $in: ranked.map(m => m._id) } })
    .select('name username profilePicture').lean();
  const dmap = new Map(display.map(d => [String(d._id), d]));

  const rx = matchTokens(goal).map(tokenRegex);
  const hitsIn = (values = []) => [...new Set(values.filter(v => rx.some(r => r.test(String(v)))))];

  return ranked.map(m => {
    const d = dmap.get(String(m._id)) || {};
    const mEdu = m.education?.[0] || {};
    const mCollege = mEdu.institutionName || mEdu.institution || null;
    const background = [];
    if (isSameCollege(identity.college, mCollege)) background.push('Same college');
    if (identity.branch && isSameBranch(identity.branch, mEdu.field)) background.push('Same branch');
    if (targetDomain && m.companyDomain === targetDomain) background.push(`${m.companyDomain} path`);
    const matchedOn = {
      background,
      expertise: hitsIn(m.expertise),
      topCompanies: hitsIn(m.topCompanies),
    };
    const hasOverlap = background.length || matchedOn.expertise.length || matchedOn.topCompanies.length;
    return {
      id: String(m._id),
      name: d.name || d.username || m.username || 'Atyant Mentor',
      username: d.username || m.username,
      profilePicture: d.profilePicture,
      bio: m.bio,
      expertise: m.expertise || [],
      topCompanies: m.topCompanies || [],
      companyDomain: m.companyDomain,
      college: mCollege,
      matchScore: m.matchScore,
      isRelevanceMatch: !!hasOverlap,
      matchedOn: hasOverlap ? matchedOn : null,
    };
  });
}

// One-line, factual summary of the matches for the handoff prompt — counts and
// real overlaps only, so the model can't claim more than the cards show.
function describeMatches(mentors = []) {
  if (!mentors.length) return 'none yet';
  const n = mentors.length;
  const withTag = (label) => mentors.filter(m => m.matchedOn?.background?.includes(label)).length;
  const sameCollege = withTag('Same college');
  const sameBranch = withTag('Same branch');
  const paths = [...new Set(mentors.flatMap(m => (m.matchedOn?.background || []).filter(b => b.endsWith(' path'))))];
  const companies = [...new Set(mentors.flatMap(m => m.matchedOn?.topCompanies || []))];
  const loose = mentors.filter(m => !m.isRelevanceMatch).length;

  const parts = [`${n} senior${n === 1 ? '' : 's'}`];
  parts.push(sameCollege ? `${sameCollege} from the student's own college` : "none from the student's own college");
  if (sameBranch) parts.push(`${sameBranch} from their branch`);
  if (paths.length) parts.push(`on the ${paths.join(' / ')}`);
  if (companies.length) parts.push(`with experience at ${companies.join(', ')}`);
  if (loose) parts.push(`${loose} only a loose suggestion with no direct overlap`);
  return parts.join('; ');
}

// ─── Greeting Detection ─────────────────────────────────────────────────────

const GREETING_PATTERNS = /^(hi|hello|hey|hii|helo|helloo|heyy|yo|sup|namaste|hola|good morning|good evening|good afternoon|gm|ge)\s*[!.]*\s*$/i;

function isGreeting(message) {
  return GREETING_PATTERNS.test(message.trim());
}

// ─── Gibberish / unintelligible input detection ──────────────────────────────
// Without this, key-mash ("Hsbsbsvsvz") keeps the engine in intake mode and the
// LLM dutifully re-asks the same scripted question forever, pretending the noise
// was a real answer. We detect clear nonsense and ask the student to rephrase
// instead. Conservative by design: never flags real words, numbers, or the
// short domain answers students actually type (SDE, ML, core, MBA…).
const DOMAIN_SHORT_ANSWERS = /\b(sde|swe|ml|ai|cs|cse|ece|eee|it|me|mba|ms|gate|gre|cat|tech|core|dev|data|ux|ui|pm|hr|qa|iit|nit|bits)\b/i;

function isGibberishWord(w) {
  const word = w.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length < 4) return false;                 // too short to judge ("sde", "3")
  // 'y' counts as a vowel so real words like "myth"/"crypt" aren't flagged.
  const vowels = (word.match(/[aeiouy]/g) || []).length;
  // Real English words have at least one vowel and no 6+ consonant run. Consonant
  // key-mash ("hdhshsvsvsvs", "hdhdjsosoevdvs") fails one of these. We deliberately
  // do NOT use a vowel RATIO — that wrongly flagged real low-vowel words like
  // "strengths". A single vowel is enough to be treated as a real word.
  const longConsonantRun = /[bcdfghjklmnpqrstvwxz]{6,}/.test(word);
  return vowels === 0 || longConsonantRun;
}

function looksLikeNoise(message) {
  const text = String(message || '').trim();
  if (text.length < 4) return false;                 // short valid answers ("3", "ML")
  if (/\d/.test(text)) return false;                 // has a number → likely real info
  if (DOMAIN_SHORT_ANSWERS.test(text)) return false; // a real domain answer
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const gib = words.filter(isGibberishWord).length;
  return gib / words.length >= 0.6;                  // mostly gibberish tokens
}

// Friendly re-prompt when we can't read the message. Re-surface the last real
// question so the student knows exactly what to answer.
function buildNoiseReply(conv) {
  const lastQ = [...conv.messages].reverse()
    .find(m => m.role === 'assistant' && /\?/.test(m.content));
  const base = "That didn't come through as something I can read.";
  if (lastQ) {
    const q = lastQ.content.split('\n').map(s => s.trim()).filter(Boolean).pop();
    return `${base} Mind typing it again in plain words?\n\n${q}`;
  }
  return `${base} Tell me in plain words — your college, branch, year, and what you're trying to crack.`;
}

// Story-form opener: invites the WHOLE situation in one message instead of
// kicking off a field-by-field interrogation. The extractor parses all 5 layers
// from free text, so one good story message can skip intake entirely.
// ⚠️ NO example profile in this text — a quoted example ("3rd year Mech at GEC
// Raipur…") was extracted as the STUDENT's real profile and poisoned matching.
// ⚠️ Keep this string in sync with GREETING_OPENER in the frontend
// (AskAtyantPage.jsx) — chips are re-attached after refresh by exact match.
function buildGreeting() {
  return `Hey! What are you trying to crack right now — an internship, placements, a switch, higher studies?

Drop your college and branch too, and I'll find seniors from your own campus who've already done it.`;
}

// Quick-reply chips shown under the opener. `value` is what gets sent to the
// engine when tapped (clean text — no emoji — so extraction stays accurate).
const GREETING_QUICK_REPLIES = [
  { label: "🎯  I want an internship but don't know where to start", value: "I want an internship but I don't know where to start" },
  { label: "🏢  Placement season is coming and I'm not prepared",    value: "Placement season is coming and I'm not prepared" },
  { label: "🤔  Career confused — don't know what path to take",     value: "I'm career confused and don't know what path to take" },
  { label: "📚  Thinking about higher studies (MS / MBA / GATE)",    value: "I'm thinking about higher studies — MS, MBA or GATE" },
];

// ─── Core Engine ────────────────────────────────────────────────────────────

// Fetch (or create) the conversation, seeding identity from the user's saved
// profile on a brand-new conversation only — an existing one already has
// whatever context prior turns built up.
async function getOrCreateConversation(sessionId, userId) {
  let conv = await AtyantConversation.findOne({ sessionId });
  if (conv) return conv;

  conv = new AtyantConversation({ sessionId, userId: userId || null });
  if (userId) {
    try {
      const userProfile = await User.findById(userId)
        .select('name username education interests')
        .lean();
      if (userProfile) {
        const edu = userProfile.education?.[0] || {};
        conv.context = mergeContext(conv.context, {
          identity: {
            college: edu.institutionName || edu.institution || null,
            branch:  edu.field || null,
            year:    edu.year  || null,
            cgpa:    edu.cgpa != null ? String(edu.cgpa) : null,
          },
          target: userProfile.interests?.[0] || null,
        });
        conv.contextLayers = countLayers(conv.context);
      }
    } catch (err) {
      console.error('Profile fetch failed (non-fatal):', err.message);
    }
  }
  return conv;
}

// Shared turn tail: decide phase, generate the reply, match mentors if routed,
// persist, and return the standard response shape. `conv.context` must already
// reflect this turn's extraction and `conv.messages` must already include the
// user's turn (chat text or a resume-upload placeholder) before calling this.
async function finishTurn(conv, userMessage, emit, sessionId) {
  // The extractor often keeps a vague goal ("internship") even after the student
  // answers the field question, which left the chat asking forever. If we just
  // asked for the field and the reply names one, fold it into the goal here.
  if (conv.pendingAsk === 'field' && conv.context?.target && !goalHasField(conv.context)
      && GOAL_FIELD_RE.test(userMessage)) {
    conv.context.target = `${conv.context.target} (${String(userMessage).trim().slice(0, 120)})`;
  }
  conv.pendingAsk = null;

  conv.problemStatement = generateProblemStatement(conv.context);

  // ── Routing gate ─────────────────────────────────────────────────────────
  // Route the moment we can actually match a mentor (who they are + their goal),
  // OR the student explicitly asks for one and we have a goal to match on, OR
  // intake has simply dragged on too long. No more waiting for all 5 layers —
  // that strict gate is what kept the chat asking questions forever and never
  // connecting anyone.
  const userWantsMentor = wantsMentor(userMessage);
  const assistantTurns = conv.messages.filter(m => m.role === 'assistant').length;

  if (
    readyToRoute(conv.context, conv.asked) ||
    (userWantsMentor && conv.context.target) ||
    (assistantTurns >= 5 && (conv.context.target || conv.context.identity?.college || conv.context.identity?.branch))
  ) {
    conv.phase = 'engine';
  }

  let reply, outputMode = null;
  let matchedMentors = [];

  // ── Phase 1: Context Collection — ask ONE question ───────────────────────
  if (conv.phase === 'collecting') {
    const ctx = conv.context || {};
    const id = ctx.identity || {};

    // Only what the mentor scorer actually uses: branch, goal + its field, then
    // college and target company (each asked once, optional). We do NOT
    // interrogate for blockers/timeline/constraints — if the student mentions
    // them, extraction still captures them silently.
    const asked = conv.asked || {};
    const hasCompanies = (ctx.targetCompanies || []).length > 0;
    const need = [];
    if (!id.branch) {
      need.push(id.college
        ? `their branch/department at ${id.college} (and year if it comes up naturally) — branch is how we match a senior`
        : "their college AND branch — that's how we match a senior from a similar background");
    }
    if (!ctx.target) {
      need.push("what they're actually chasing — the goal or role");
    } else if (!goalHasField(ctx)) {
      // Goal is vague ("internship"/"placement"). Pin the FIELD so we match the
      // right mentor, framed by what their branch's seniors usually go for.
      need.push("WHICH field the goal is in — e.g. software/SDE, data/ML, core, product, or consulting — framed by what their branch's seniors usually target");
    }
    // Asked only once the essentials are in, so it's always need[0] when sent.
    let askingNow = null;
    if (!need.length) {
      if (!id.college && !asked.college) {
        askingNow = hasCompanies || asked.company ? 'college' : 'both';
        need.push(askingNow === 'both'
          ? "which college they're at, plus (optional, same breath) any company they've got their eye on — seniors from their own campus who cracked that are the best match. 'No idea yet' on the company is fine"
          : "which college they're at — seniors from their own campus are the closest match");
      } else if (!hasCompanies && !asked.company) {
        askingNow = 'company';
        need.push("(optional) any company they're dreaming of for this goal — make it fun and easy, 'no idea yet' is a perfectly good answer");
      }
    }
    if (askingNow) {
      conv.asked = {
        college: asked.college || askingNow !== 'company',
        company: asked.company || askingNow !== 'college',
      };
    }
    conv.pendingAsk = !id.branch ? 'branch' : !ctx.target ? 'goal' : !goalHasField(ctx) ? 'field' : askingNow;

    const systemWithContext = `${COLLECTION_SYSTEM}

---
What we already know about them:
${JSON.stringify(ctx, null, 2)}

Still need (ask ONLY the first one that applies, nothing more): ${need.length ? need.join('  |  ') : "nothing — wrap up warmly and tell them you're matching them to a mentor now"}
${userWantsMentor ? "\nThe student JUST asked to be connected to a mentor. Acknowledge it in one line, ask ONLY the single thing above in one short sentence, and do NOT pile on extra questions." : ""}
---`;

    emit({ type: 'progress', stage: 'drafting' });
    const rawReply = await callChatStream(toGroqMessages(systemWithContext, conv.messages), emit, { reminder: COLLECT_REMINDER });
    reply = stripTags(rawReply);

  // ── Phase 2: Execution Engine — final wrap-up, NO questions ──────────────
  } else {
    // Match FIRST, so the handoff describes the seniors who actually matched
    // instead of the model guessing ("NIT Trichy seniors" when none exist).
    emit({ type: 'progress', stage: 'searching_mentors' });
    try {
      matchedMentors = await matchMentors(conv.context, conv.problemStatement, conv.userId);
    } catch (err) {
      console.error('Mentor match failed (non-fatal):', err.message);
    }
    emit({ type: 'progress', stage: 'mentors_found', count: matchedMentors.length });
    conv.matchedMentors = matchedMentors;
    logFunnel('handoff_shown', {
      funnelId: sessionId,
      userId: conv.userId,
      props: {
        mentors: matchedMentors.length,
        sameCollege: matchedMentors.filter(m => m.matchedOn?.background?.includes('Same college')).length,
        assistantTurns: assistantTurns + 1,
      },
    });

    emit({ type: 'progress', stage: 'drafting' });
    const systemWithProblem = `${ENGINE_SYSTEM}

---
Student's Problem Statement (fully mapped by intake system):
${conv.problemStatement}

Matched seniors: ${describeMatches(matchedMentors)}
---`;

    const rawReply = await callClaudeStream(toGroqMessages(systemWithProblem, conv.messages), emit, { reminder: ENGINE_REMINDER });
    reply = stripTags(rawReply);

    outputMode = 'MENTOR_ROUTING';
    conv.outputMode = outputMode;
  }

  // Safety net: never persist or return an empty bubble. If stripping removed
  // everything (model emitted only tags/reasoning), fall back to a useful prompt.
  if (!reply || !reply.trim()) {
    reply = conv.phase === 'collecting'
      ? "Tell me a bit more so I can point you the right way — which college and branch are you in, and what are you aiming for?"
      : matchedMentors.length
        ? "I've pulled up seniors whose paths line up with yours — take a look at what they did."
        : "I'm still finding the right senior for you — I'll keep looking.";
  }

  conv.messages.push({ role: 'assistant', content: reply });

  // Cap at 30 messages to control document size
  if (conv.messages.length > 30) {
    conv.messages = conv.messages.slice(-30);
  }

  await conv.save();

  return {
    reply,
    phase: conv.phase,
    contextLayers: conv.contextLayers,
    context: conv.context,
    problemStatement: conv.problemStatement,
    outputMode: conv.outputMode,
    matchedMentors,
    // No senior from the student's own college in our pool → frontend offers
    // GET /api/invites/seniors (signed-in only), even if looser matches are shown.
    canInviteSeniors: conv.phase === 'engine' && !!conv.userId && !!conv.context?.identity?.college
      && !matchedMentors.some(m => m.matchedOn?.background?.includes('Same college')),
    sessionId
  };
}

// `onProgress`, if given, is called synchronously with real checkpoints as each
// stage of the turn actually completes — used to drive a live "thinking" UI
// instead of a canned one. Never throws from onProgress errors into the engine.
export async function processAtyantMessage(sessionId, userMessage, userId = null, onProgress = null) {
  const emit = onProgress ? (event) => { try { onProgress(event); } catch { /* UI-only, non-fatal */ } } : () => {};

  emit({ type: 'progress', stage: 'reading' });

  const conv = await getOrCreateConversation(sessionId, userId);
  if (userId && !conv.userId) conv.userId = userId; // guest who signed in mid-chat
  if (!conv.messages.length) logFunnel('chat_started', { funnelId: sessionId, userId, props: { via: 'text' } });

  // ── Greeting shortcut — problem-first opener + quick replies, no AI call ──
  if (isGreeting(userMessage)) {
    const reply = buildGreeting();
    conv.messages.push({ role: 'user', content: userMessage });
    conv.messages.push({ role: 'assistant', content: reply });
    if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
    await conv.save();
    return {
      reply,
      phase: conv.phase,
      contextLayers: conv.contextLayers,
      context: conv.context,
      problemStatement: conv.problemStatement,
      outputMode: null,
      matchedMentors: [],
      quickReplies: GREETING_QUICK_REPLIES,
      sessionId
    };
  }

  // ── Unintelligible input — don't force the intake script forward or extract
  //    a fake profile from key-mash. Ask the student to rephrase. ──
  if (looksLikeNoise(userMessage)) {
    const reply = buildNoiseReply(conv);
    conv.messages.push({ role: 'user', content: userMessage });
    conv.messages.push({ role: 'assistant', content: reply });
    if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
    await conv.save();
    return {
      reply,
      phase: conv.phase,
      contextLayers: conv.contextLayers,
      context: conv.context,
      problemStatement: conv.problemStatement,
      outputMode: null,
      matchedMentors: [],
      quickReplies: [],
      sessionId
    };
  }

  conv.messages.push({ role: 'user', content: userMessage });

  // ── Reliable context extraction (runs EVERY turn, before we reply) ────────
  // Dedicated JSON-mode model reads the whole conversation and returns the 5
  // layers. This is the source of truth — the chat model no longer has to emit
  // tags, so context is captured even when the reply is purely conversational.
  const extracted = await extractStudentContext(conv.messages);
  if (extracted) {
    conv.context = mergeContext(conv.context, extracted);
    conv.contextLayers = countLayers(conv.context);
  }
  emit({ type: 'progress', stage: 'context', context: conv.context, contextLayers: conv.contextLayers });

  return finishTurn(conv, userMessage, emit, sessionId);
}

// ─── Résumé upload ──────────────────────────────────────────────────────────
// A bare upload (no typed message alongside it) deliberately does NOT run the
// routing gate or mentor search — it only enriches context, then acknowledges
// + asks one short question, so the student gets a chance to add or confirm
// something before anything is searched.
//
// If the student DID type something alongside the file, that's a real turn —
// it's merged into context same as the file, and the normal routing gate
// applies via finishTurn(), so it CAN route straight to mentor matching if
// there's now enough signal (exactly like typing that same message alone would).
export async function processResumeUpload(sessionId, extractedContext, fileLabel, userId = null, onProgress = null, userText = '') {
  const emit = onProgress ? (event) => { try { onProgress(event); } catch { /* UI-only, non-fatal */ } } : () => {};

  const conv = await getOrCreateConversation(sessionId, userId);
  if (userId && !conv.userId) conv.userId = userId;
  if (!conv.messages.length) logFunnel('chat_started', { funnelId: sessionId, userId, props: { via: 'resume' } });
  const attachmentNote = `[Uploaded résumé: ${fileLabel}]`;
  const userMessage = userText ? `${userText}\n${attachmentNote}` : attachmentNote;
  conv.messages.push({ role: 'user', content: userMessage });

  if (extractedContext) {
    conv.context = mergeContext(conv.context, extractedContext);
    conv.contextLayers = countLayers(conv.context);
  }

  if (userText) {
    // Capture whatever the typed note adds (goal, constraint, correction) the
    // same way a normal chat turn would — the résumé extractor only reads the
    // file, not this note.
    const textExtracted = await extractStudentContext(conv.messages);
    if (textExtracted) {
      conv.context = mergeContext(conv.context, textExtracted);
      conv.contextLayers = countLayers(conv.context);
    }
  }
  emit({ type: 'progress', stage: 'context', context: conv.context, contextLayers: conv.contextLayers });

  if (userText) {
    return finishTurn(conv, userMessage, emit, sessionId);
  }

  conv.problemStatement = generateProblemStatement(conv.context);
  conv.phase = 'collecting';
  conv.outputMode = null;

  emit({ type: 'progress', stage: 'drafting' });
  const ctx = conv.context || {};
  const id = ctx.identity || {};
  const known = [id.college, id.branch, ctx.target].filter(Boolean).join(', ');

  const systemWithContext = `${COLLECTION_SYSTEM}

---
The student just uploaded their résumé. Here's what we now know about them:
${JSON.stringify(ctx, null, 2)}

Acknowledge the résumé naturally (mention ${known || "what you found in it"} if it's useful), then ask ONE short question — either confirm you've got their goal right, or ask the one thing still missing (branch, goal, or which field). Do NOT say you're matching them to a mentor yet — you still need to hear back from them first.
---`;

  const rawReply = await callChatStream(toGroqMessages(systemWithContext, conv.messages), emit, { reminder: COLLECT_REMINDER });
  let reply = stripTags(rawReply);
  if (!reply || !reply.trim()) {
    reply = known
      ? `Got your résumé — ${known}. Anything else I should know before I find your match?`
      : "Got your résumé. Tell me what you're aiming for and I'll find the right match.";
  }

  conv.messages.push({ role: 'assistant', content: reply });
  if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
  await conv.save();

  return {
    reply,
    phase: conv.phase,
    contextLayers: conv.contextLayers,
    context: conv.context,
    problemStatement: conv.problemStatement,
    outputMode: null,
    matchedMentors: [],
    sessionId,
  };
}

export async function getAtyantSession(sessionId) {
  const conv = await AtyantConversation.findOne({ sessionId })
    .select('-__v')
    .lean();
  return conv;
}

export async function clearAtyantSession(sessionId) {
  await AtyantConversation.deleteOne({ sessionId });
}

// Thumbs up/down on a bot reply. Matched by content (last assistant message
// with that exact text) — message indexes shift when history is capped at 30,
// so content match is the stable identifier.
export async function recordAtyantChatFeedback(sessionId, messageContent, value) {
  if (!['up', 'down', null].includes(value)) return { ok: false, error: 'Invalid value' };
  const conv = await AtyantConversation.findOne({ sessionId });
  if (!conv) return { ok: false, error: 'Session not found' };

  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'assistant' && m.content === messageContent) {
      m.feedback = value;
      conv.markModified('messages');
      await conv.save();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Message not found' };
}
