import { GoogleGenerativeAI } from '@google/generative-ai';
import AtyantConversation from '../models/AtyantConversation.js';
import User from '../models/User.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Prompts ────────────────────────────────────────────────────────────────

const COLLECTION_SYSTEM = `You are Atyant's AI intake system for Indian engineering students. Atyant is a career guidance platform connecting Tier-2/3 engineering students with alumni mentors who've cracked real placements, internships, and higher studies.

Your job is to have a natural conversation that collects the student's career context across 5 layers:
1. Identity — college, branch, year, CGPA
2. Target — what they want (internship, placement, higher studies, skill roadmap, resume review, etc.)
3. Gap — what's blocking them (no projects, low CGPA, non-CS branch, no network, weak communication, etc.)
4. Timeline — urgency (this month, next semester, 6 months, long-term plan)
5. Constraint — hard limits (no paid courses, first-gen student, no CS peers, time-constrained, etc.)

Conversation rules:
- Be warm and direct. Not corporate. Not a chatbot. Talk like a sharp senior.
- If the student asks a career question, give a short useful answer first, then collect context
- Ask exactly ONE missing context question per response — woven naturally, never listed
- Never ask multiple questions in one response
- Keep responses under 120 words unless giving a detailed roadmap
- Be specific to India — reference real companies, timelines, and playbooks that work for Tier-2/3 students

After your conversational reply, output a JSON block with what you've learned from the ENTIRE conversation:
<context_update>
{
  "identity": {
    "college": null,
    "collegeType": null,
    "branch": null,
    "year": null,
    "cgpa": null
  },
  "target": null,
  "gap": [],
  "timeline": null,
  "constraint": []
}
</context_update>

Rules for the JSON:
- Only fill in fields you're confident about from the ENTIRE conversation history
- null means genuinely unknown — never guess
- Arrays: include all values mentioned across the conversation
- collegeType: one of "IIT", "NIT-top", "NIT-other", "BITS", "Tier-2", "Tier-3", "private"`;

const ENGINE_SYSTEM = `You are Atyant's career execution engine for Indian engineering students from Tier-2/3 colleges.

You operate in 3 output modes — pick the right one:
- AI_ANSWER: You can give a specific, actionable execution plan right now
- MENTOR_ROUTING: The problem is nuanced enough that a mentor who walked this exact path will provide more value than AI advice
- CLARIFY: You need one more critical piece of context before giving useful guidance

Response rules:
- Be brutally specific to the student's actual college, branch, year, and constraints
- Don't give IIT-style advice to Tier-2/3 students — different network, different playbook
- Reference real timelines: what to do in week 1, week 2, etc. for time-constrained students
- Name specific skills, platforms, or companies relevant to their background
- End every response with a concrete action the student can take TODAY, not eventually
- If routing to mentor: explain what type of mentor background would best serve this student
- Keep responses under 300 words unless giving a full roadmap (then be as specific as needed)

After your response, declare your mode:
<output_mode>AI_ANSWER</output_mode>`;

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
  const match = text.match(/<context_update>([\s\S]*?)<\/context_update>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
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
    .replace(/<context_update>[\s\S]*?<\/context_update>/g, '')
    .replace(/<output_mode>[\s\S]*?<\/output_mode>/g, '')
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

// Build Gemini-compatible history from stored messages, excluding the last user message
function buildGeminiHistory(messages) {
  // Exclude the last message (current user turn, passed via sendMessage)
  const history = messages.slice(0, -1);

  // Gemini requires strict user/model alternation starting with user
  // Filter to ensure valid alternation
  const valid = [];
  let lastRole = null;

  for (const msg of history) {
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
    if (geminiRole === lastRole) continue; // skip duplicates
    valid.push({ role: geminiRole, parts: [{ text: msg.content }] });
    lastRole = geminiRole;
  }

  // History must start with 'user'
  if (valid.length > 0 && valid[0].role !== 'user') {
    valid.shift();
  }

  // History must end with 'model' (the last assistant response before current user msg)
  if (valid.length > 0 && valid[valid.length - 1].role !== 'model') {
    valid.pop();
  }

  // Keep last 20 turns (10 exchanges) to stay within token limits
  return valid.slice(-20);
}

// ─── Core Engine ────────────────────────────────────────────────────────────

export async function processAtyantMessage(sessionId, userMessage, userId = null) {
  let conv = await AtyantConversation.findOne({ sessionId });
  if (!conv) {
    conv = new AtyantConversation({ sessionId, userId: userId || null });
    // Seed identity from the logged-in user's profile so the intake never
    // re-asks college/branch/year it already knows. ("understand first.")
    if (userId) {
      try {
        const u = await User.findById(userId).select('education interests').lean();
        const edu = u?.education?.[0] || {};
        conv.context = mergeContext(conv.context, {
          identity: {
            college: edu.institutionName || edu.institution || null,
            branch: edu.field || null,
            year: edu.year || null,
            cgpa: edu.cgpa != null ? String(edu.cgpa) : null,
          },
          target: u?.interests?.[0] || null,
        });
        conv.contextLayers = countLayers(conv.context);
      } catch (err) {
        console.error('Profile seed failed (non-fatal):', err.message);
      }
    }
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

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemWithContext
    });

    const history = buildGeminiHistory(conv.messages);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const rawReply = result.response.text();

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

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemWithProblem
    });

    const history = buildGeminiHistory(conv.messages);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const rawReply = result.response.text();

    outputMode = parseOutputMode(rawReply);
    conv.outputMode = outputMode;
    reply = stripTags(rawReply);
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
