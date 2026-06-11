import express from 'express';
import { optionalAuth } from '../middleware/auth.js';
import {
  processAtyantMessage,
  getAtyantSession,
  clearAtyantSession,
  recordAtyantChatFeedback
} from '../services/AtyantEngineService.js';

const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Honour the env model (qwen3-32b etc.); fall back to a current Groq model.
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Reasoning models inline a <think> trace; disable it so replies stay clean.
const IS_REASONING_MODEL = /qwen|deepseek|r1/i.test(GROQ_MODEL);

// Simple in-memory conversation store (per session, not persisted)
const conversations = new Map();

async function groqChat(messages) {
  const body = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 800
  };
  if (IS_REASONING_MODEL) {
    body.reasoning_effort = 'none';
    body.reasoning_format = 'hidden';
  }
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  // Backstop: strip any reasoning trace that slips through (closed or truncated).
  return (data.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/?\s*think\s*>/gi, '')
    .trim();
}

const SYSTEM_PROMPT = `You are Atyant — India's career execution intelligence. You are not a chatbot. You are not a generic AI assistant. You are the voice of a platform built by VNIT students, for Indian engineering students who are trying to figure out exactly what to do next in their career.

YOUR PERSONALITY:
- You speak like a sharp, warm senior from the same college — not a corporate bot.
- You are direct. You do not give vague, generic advice.
- You ask smart questions before giving answers.
- You never say "Great question!" or "Certainly!" or "As an AI..."
- You speak in short, clear sentences. You do not lecture.
- You mix Hindi naturally only if the student starts in Hindi. Otherwise stay in clean English.

WHAT YOU NEVER DO:
- Never give a numbered list of 10 generic steps.
- Never say "it depends" without immediately asking the specific question that resolves it.
- Never end a message without a clear next step or one specific question.
- Never use: "leverage", "utilize", "synergy", "empower", "journey", "passion", "unlock", "delve".

HOW YOU START:
Ask one direct question that gets to the point. Example: "Hey — what are you trying to crack? Tell me the goal and where you're starting from."

LANGUAGE: Short sentences. Max 3 per paragraph. Use: "Here's the thing", "The honest answer is", "What actually works is".`;

// POST /api/ai/chat
// Body: { message, sessionId? }
router.post('/chat', optionalAuth, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Message is required' });
    }
    if (message.trim().length > 1000) {
      return res.status(400).json({ ok: false, error: 'Message too long (max 1000 chars)' });
    }

    const sid = sessionId || (req.user?._id?.toString()) || 'guest';
    const history = conversations.get(sid) || [];

    // Build messages array for Groq (OpenAI format)
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message.trim() }
    ];

    const reply = await groqChat(messages);

    // Update history (keep last 10 turns)
    history.push(
      { role: 'user',      content: message.trim() },
      { role: 'assistant', content: reply }
    );
    if (history.length > 20) history.splice(0, 2);
    conversations.set(sid, history);

    if (conversations.size > 500) {
      const firstKey = conversations.keys().next().value;
      conversations.delete(firstKey);
    }

    res.json({ ok: true, reply, sessionId: sid });

  } catch (error) {
    console.error('AI chat error:', error.message);
    if (error.message?.includes('429')) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
    }
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/ai/chat/:sessionId — clear conversation history
router.delete('/chat/:sessionId', (req, res) => {
  conversations.delete(req.params.sessionId);
  res.json({ ok: true });
});

// ─── Atyant Engine ──────────────────────────────────────────────────────────

// POST /api/ai/atyant-chat
// Body: { message, sessionId }
// Drives the 2-phase context-collection + execution engine
router.post('/atyant-chat', optionalAuth, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Message is required' });
    }

    if (message.trim().length > 2000) {
      return res.status(400).json({ ok: false, error: 'Message too long (max 2000 chars)' });
    }

    if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 8) {
      return res.status(400).json({ ok: false, error: 'Valid sessionId is required' });
    }

    const userId = req.user?._id?.toString() || null;
    const result = await processAtyantMessage(sessionId, message.trim(), userId);

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Atyant Engine error:', error.message);

    if (error.message?.includes('429')) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
    }

    res.status(500).json({ ok: false, error: 'Engine error. Please try again.' });
  }
});

// GET /api/ai/atyant-chat/:sessionId — fetch session state (context, phase, history)
router.get('/atyant-chat/:sessionId', optionalAuth, async (req, res) => {
  try {
    const session = await getAtyantSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }
    res.json({ ok: true, session });
  } catch (error) {
    console.error('Atyant session fetch error:', error.message);
    res.status(500).json({ ok: false, error: 'Failed to fetch session' });
  }
});

// POST /api/ai/atyant-chat/:sessionId/feedback — thumbs up/down on a bot reply
// Body: { message: <exact reply text>, value: 'up' | 'down' | null }
router.post('/atyant-chat/:sessionId/feedback', optionalAuth, async (req, res) => {
  try {
    const { message, value } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }
    const result = await recordAtyantChatFeedback(
      req.params.sessionId,
      message,
      value === undefined ? null : value
    );
    res.status(result.ok ? 200 : 404).json(result);
  } catch (error) {
    console.error('Atyant chat feedback error:', error.message);
    res.status(500).json({ ok: false, error: 'Failed to record feedback' });
  }
});

// DELETE /api/ai/atyant-chat/:sessionId — reset session
router.delete('/atyant-chat/:sessionId', optionalAuth, async (req, res) => {
  try {
    await clearAtyantSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Atyant session clear error:', error.message);
    res.status(500).json({ ok: false, error: 'Failed to clear session' });
  }
});

export default router;
