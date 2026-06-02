import AtyantConversation from '../models/AtyantConversation.js';
import User from '../models/User.js';

// ─── Groq (OpenAI-compatible chat completions) ───────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama3-70b-8192';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(messages, { temperature = 0.7, maxTokens = 300 } = {}) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(20000), // hung socket throws → route returns a friendly error
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
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

// Lean base — ~80 tokens vs ~600 before
const MASTER_SYSTEM_PROMPT = `You are Atyant — career AI for Indian engineering students. Built by VNIT students.
Voice: sharp senior, not a bot. Direct. Warm. No filler.
Banned words: "Great question", "Certainly", "As an AI", "leverage", "empower", "delve", "journey", "unlock", "Let me help", "I'd be happy to", "Got it —".
Format: short sentences, max 3 per paragraph, no bullet dumps.
Rule: every reply ends with ONE next step OR one question. Never both. Never neither.`;

// Collection phase — ~120 tokens
const COLLECTION_SYSTEM = `${MASTER_SYSTEM_PROMPT}

INTAKE MODE:
- Ask ONE question per reply. The last sentence is always the question.
- Max 60 words per reply.
- Never open with filler. Start with the substance.
- Priority order for missing info: year → target → what they've tried → timeline
- Never ask CGPA unless directly relevant.

After reply, emit context JSON (invisible to user):
<context_update>{"identity":{"college":null,"collegeType":null,"branch":null,"year":null,"cgpa":null},"target":null,"gap":[],"timeline":null,"constraint":[]}</context_update>
Only fill fields you're confident about. null = unknown. collegeType: IIT/NIT-top/NIT-other/BITS/Tier-2/Tier-3/private.`;

// Engine phase — ~100 tokens
const ENGINE_SYSTEM = `${MASTER_SYSTEM_PROMPT}

EXECUTION MODE — context is known. Give specific, actionable guidance.
Modes: AI_ANSWER / MENTOR_ROUTING / CLARIFY — pick one.
Rules: specific to their college+branch+year. No IIT advice for Tier-2 students. Max 150 words. End with one action they can do today.
For MENTOR_ROUTING: describe the type of mentor needed. Never invent a mentor name or profile.

End with: <output_mode>AI_ANSWER</output_mode>`;

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
    // Strip <think>...</think> blocks (DeepSeek/Qwen reasoning traces)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
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

function buildGreeting(user) {
  const name = user?.name || user?.username || null;
  const college = user?.education?.[0]?.institutionName || user?.education?.[0]?.institution || null;
  const branch  = user?.education?.[0]?.field || null;
  const year    = user?.education?.[0]?.year || null;

  const nameStr = name ? `${name}` : 'there';

  // Build context-aware topic suggestions based on profile
  const topics = [];
  if (branch && branch.toLowerCase().match(/metallurgy|mechanical|civil|chemical|electrical|ece/)) {
    topics.push('core vs software switch');
  }
  if (year && (year === '3' || year === '3rd' || year === '2' || year === '2nd')) {
    topics.push('internships');
  }
  if (year && (year === '4' || year === '4th' || year === 'final')) {
    topics.push('placements');
  }
  topics.push('roadmap', 'resume', 'higher studies');

  const topicStr = topics.slice(0, 4).join(', ');
  const collegeStr = college ? ` from ${college}` : '';

  return `Hey ${nameStr}! 👋\n\nGood to see you${collegeStr}. What are you working on today — ${topicStr}, or something else on your mind?`;
}

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

  // ── Greeting shortcut — warm reply, no AI call needed ───────────────────
  if (isGreeting(userMessage)) {
    const reply = buildGreeting(userProfile);
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
      sessionId
    };
  }

  conv.messages.push({ role: 'user', content: userMessage });

  let reply, outputMode = null;

  // ── Phase 1: Context Collection ──────────────────────────────────────────
  if (conv.phase === 'collecting') {
    const ctx = conv.context || {};
    const layers = countLayers(ctx);

    const missing = [];
    if (!ctx.identity?.branch && !ctx.identity?.year && !ctx.identity?.college) missing.push('identity (college/branch/year)');
    if (!ctx.target) missing.push('target goal');
    if (!ctx.gap?.length) missing.push('what\'s blocking them');
    if (!ctx.timeline) missing.push('timeline/urgency');
    if (!ctx.constraint?.length) missing.push('constraints');

    const systemWithContext = `${COLLECTION_SYSTEM}

---
Context extracted so far (${layers}/5 layers):
${JSON.stringify(ctx, null, 2)}

Still missing: ${missing.length ? missing.join(', ') : 'Nothing — all layers collected!'}
---`;

    const rawReply = await callGroq(toGroqMessages(systemWithContext, conv.messages));

    const contextUpdate = parseContextUpdate(rawReply);
    conv.context = mergeContext(conv.context, contextUpdate);
    conv.contextLayers = countLayers(conv.context);

    reply = stripTags(rawReply);

    // Switch to engine once 3+ layers are collected
    if (conv.contextLayers >= 3) {
      conv.phase = 'engine';
      conv.problemStatement = generateProblemStatement(conv.context);
    }

  // ── Phase 2: Execution Engine ────────────────────────────────────────────
  } else {
    // Regenerate problem statement in case context updated mid-engine
    conv.problemStatement = generateProblemStatement(conv.context);

    const systemWithProblem = `${ENGINE_SYSTEM}

---
Student's Problem Statement (fully mapped by intake system):
${conv.problemStatement}
---`;

    const rawReply = await callGroq(toGroqMessages(systemWithProblem, conv.messages));

    outputMode = parseOutputMode(rawReply);
    conv.outputMode = outputMode;
    reply = stripTags(rawReply);
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
