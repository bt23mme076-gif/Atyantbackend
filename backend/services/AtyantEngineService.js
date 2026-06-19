import AtyantConversation from '../models/AtyantConversation.js';
import User from '../models/User.js';
// ─── Groq — shared rotating client ───────────────────────────────────────────
// All Groq traffic in the backend flows through utils/groqClient.js, which does
// multi-key round-robin + cooldown failover (see that file). Add GROQ_API_KEY_2
// / _3 from SEPARATE Groq accounts in .env to multiply throughput.
import { groqChat, groqJSON } from '../utils/groqClient.js';

// Chat reply. Slightly higher temperature for a natural, human voice (not robotic).
const callGroq = (messages, opts = {}) => groqChat(messages, { temperature: 0.85, ...opts });

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
  "target": null,         // the student's stated goal; else null
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
Be a person, not a form.`;

// Collection phase — natural intake. We still need all 5 layers extracted:
// 1) Identity (college, branch, year), 2) Target goal, 3) Blockers/Gaps, 4) Timeline, 5) Constraints —
// but the model gathers them like a senior chatting, not a questionnaire.
const COLLECTION_SYSTEM = `${MASTER_SYSTEM_PROMPT}

You're still getting to know them so you can match them to the right senior's path. Over the chat you need: college, branch, year; their goal; what's blocking them; their timeline; any hard constraints.

How to gather it like a human, not an intake form:
- React to their last message first (a few words), THEN ask for ONE missing thing. Don't fire questions back-to-back.
- Bundle naturally only when it genuinely fits — the way a senior would actually ask over chat. Never a checklist.
- If their message is unclear or doesn't answer you, say so honestly and ask again, simpler. Don't pretend you understood, and never make up a detail they didn't give.
- Skip anything the "Context extracted so far" block already has. Don't ask CGPA unless it actually matters here.
- Once you know their college + branch, talk like an insider — weave in what students from there actually do, in your OWN words, phrased DIFFERENTLY every time (never reuse the same core/tech/non-core line). Never invent a name, company, or number.
- If their goal is vague ("internship"/"placement"), the next thing to pin down is the DIRECTION — tech, core, or something else — using their college's real paths, before you ask about blockers.
- Keep replies under ~45 words and end on one natural question. Output only your message — no JSON, no tags.`;

// Engine phase — final handoff. NO more questions; wrap up and route to clarity.
const ENGINE_SYSTEM = `${MASTER_SYSTEM_PROMPT}

You've got enough now — no more questions. Give them a real, confident read (under ~85 words):
- Talk to THEM specifically: their college, branch, year, goal. Generic advice that could fit anyone is banned.
- Tell them, like a senior would, what people from their kind of background actually did to get there — concrete moves: specific skills, projects, clubs, paths. Not "pick coding or product".
- One sharp next step that's clearly theirs.
Then hand off in your OWN words — say you've found seniors who pulled this off from a similar background and you'll show their exact paths. Phrase it naturally and differently each time; don't use a fixed template. Don't end on a question. Don't say results are "below".
Use ONLY facts you actually have — never invent a college, company, CGPA, or number.`;

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

function generateProblemStatement(context = {}) {
  const { identity = {}, target, gap = [], timeline, constraint = [] } = context;
  const lines = [];

  const idParts = [
    identity.college || identity.collegeType,
    identity.branch,
    identity.year ? `Year ${identity.year}` : null,
    identity.cgpa ? `CGPA ${identity.cgpa}` : null
  ].filter(Boolean);

  if (idParts.length) lines.push(`Student: ${idParts.join(' | ')}`);
  if (target)            lines.push(`Goal: ${target}`);
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

  if (update.target) merged.target = update.target;

  if (Array.isArray(update.gap) && update.gap.length > 0) {
    merged.gap = [...new Set([...merged.gap, ...update.gap.filter(Boolean)])];
  }

  if (update.timeline) merged.timeline = update.timeline;

  if (Array.isArray(update.constraint) && update.constraint.length > 0) {
    merged.constraint = [...new Set([...merged.constraint, ...update.constraint.filter(Boolean)])];
  }

  return merged;
}

// Find REAL mentors from the DB to back a MENTOR_ROUTING decision. The LLM must
// never invent mentors — this is the only source of truth the frontend renders.
async function matchMentors(context = {}, limit = 3) {
  const { identity = {}, target, gap = [] } = context;
  const terms = [target, identity.branch, ...(gap || [])]
    .filter(Boolean)
    .map(t => String(t).toLowerCase());

  const base = { role: 'mentor' };
  let mentors = [];

  // Loose relevance match on expertise / interests / domain when we have signals.
  if (terms.length) {
    const rx = terms.map(t => new RegExp(t.split(/\s+/).slice(0, 2).join('|'), 'i'));
    mentors = await User.find({
      ...base,
      $or: [
        { expertise: { $in: rx } },
        { interests: { $in: rx } },
        { domainExperience: { $in: rx } },
        { topCompanies: { $in: rx } },
      ],
    })
      .select('name username profilePicture bio expertise interests topCompanies companyDomain education')
      .limit(limit)
      .lean();
  }

  // Fallback: most recently active mentors so the user is never shown nothing.
  if (mentors.length < limit) {
    const existing = new Set(mentors.map(m => String(m._id)));
    const fill = await User.find({ ...base, _id: { $nin: [...existing] } })
      .select('name username profilePicture bio expertise interests topCompanies companyDomain education')
      .sort({ lastActive: -1 })
      .limit(limit - mentors.length)
      .lean();
    mentors = [...mentors, ...fill];
  }

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
  }));
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
  return `What's confusing you right now?

Tell me your full situation in one go — your college, branch, year, and what you're trying to crack.`;
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

export async function processAtyantMessage(sessionId, userMessage, userId = null) {
  let conv = await AtyantConversation.findOne({ sessionId });
  let userProfile = null;

  // Fetch user profile once — used for greeting + context seeding
  if (userId) {
    try {
      userProfile = await User.findById(userId)
        .select('name username education interests')
        .lean();
    } catch (err) {
      console.error('Profile fetch failed (non-fatal):', err.message);
    }
  }

  if (!conv) {
    conv = new AtyantConversation({ sessionId, userId: userId || null });
    // Seed identity from profile so intake never re-asks what it already knows
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
  }

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

  // ── Decide the phase BEFORE replying ─────────────────────────────────────
  // Using the freshly-extracted context. This kills the old bug where the turn
  // that crossed the threshold still asked an intake question AND showed the
  // clarity button at the same time. Once we have 3+ layers, we stop asking.
  conv.problemStatement = generateProblemStatement(conv.context);

  // STRICT GATE: transition to 'engine' phase ONLY when all 5 layers are fully extracted.
  if (conv.contextLayers >= 5) {
    conv.phase = 'engine';
  }

  let reply, outputMode = null;

  // ── Phase 1: Context Collection — ask ONE question ───────────────────────
  if (conv.phase === 'collecting') {
    const ctx = conv.context || {};
    const layers = countLayers(ctx);

    const id = ctx.identity || {};

    // Is the goal specific about a field/domain yet (tech vs core vs non-core, or a
    // concrete role)? If the goal is still broad, the field question comes next —
    // framed by their college's common paths — BEFORE we ask about blockers.
    const ctxGoalText = [ctx.target, ...(ctx.gap || []), ...(ctx.constraint || [])].filter(Boolean).join(' ');
    const hasDomainSignal = /\btech\b|software|\bsde\b|\bswe\b|\bdata\b|\bml\b|\bai\b|\bcore\b|non-?core|consult|finance|fintech|product|analyst|analytics|research|design|hardware|embedded|quant|trading|marketing|\bdev\b/i.test(ctxGoalText);

    const missing = [];
    if (!id.college) missing.push('college/institute name (ASK THIS FIRST — most important)');
    if (!id.branch) missing.push('branch/department');
    if (!id.year) missing.push('current year of study');
    if (!ctx.target) missing.push('target goal');
    else if (!hasDomainSignal) missing.push('FIELD/DOMAIN of the goal — tech vs core vs non-core (frame it with what students from their college + branch typically do)');
    if (!ctx.gap?.length) missing.push('biggest blocker');
    if (!ctx.timeline) missing.push('timeline/urgency');
    if (!ctx.constraint?.length) missing.push('constraints');

    const systemWithContext = `${COLLECTION_SYSTEM}

---
Context extracted so far (${layers}/5 layers):
${JSON.stringify(ctx, null, 2)}

Still missing: ${missing.length ? missing.join(', ') : 'Nothing — all layers collected!'}
---`;

    const rawReply = await callGroq(toGroqMessages(systemWithContext, conv.messages));
    reply = stripTags(rawReply);

  // ── Phase 2: Execution Engine — final wrap-up, NO questions ──────────────
  } else {
    const systemWithProblem = `${ENGINE_SYSTEM}

---
Student's Problem Statement (fully mapped by intake system):
${conv.problemStatement}
---`;

    const rawReply = await callGroq(toGroqMessages(systemWithProblem, conv.messages));
    reply = stripTags(rawReply);

    // Engine is ready → always route to the clarity page (verified seniors below).
    outputMode = 'MENTOR_ROUTING';
    conv.outputMode = outputMode;
  }

  // When the engine routes to a mentor, attach REAL matches from the DB. The LLM
  // describes the type of mentor; the frontend renders these actual cards.
  let matchedMentors = [];
  if (outputMode === 'MENTOR_ROUTING') {
    try {
      matchedMentors = await matchMentors(conv.context);
    } catch (err) {
      console.error('Mentor match failed (non-fatal):', err.message);
    }
  }

  // Safety net: never persist or return an empty bubble. If stripping removed
  // everything (model emitted only tags/reasoning), fall back to a useful prompt.
  if (!reply || !reply.trim()) {
    reply = conv.phase === 'collecting'
      ? "Tell me a bit more so I can point you the right way — what's the main thing blocking you right now?"
      : "Found seniors who walked a similar path from the same kind of background. Let me show you their exact paths.";
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
    sessionId
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
