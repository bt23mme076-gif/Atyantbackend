import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Simple in-memory conversation store (per session, not persisted)
// For production, use Redis or MongoDB
const conversations = new Map();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: `You are Atyant AI, a friendly career guidance assistant for Indian engineering students. 
Keep responses concise (2-4 sentences max for simple questions). 
Be warm, helpful, and practical. Focus on career, internships, placements, and college life.
If asked something unrelated to career/education, gently redirect.`
    });

    // Get or create chat history for this session
    const sid = sessionId || (req.user?._id?.toString()) || 'guest';
    const history = conversations.get(sid) || [];

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(message.trim());
    const reply = result.response.text();

    // Update history (keep last 10 turns to avoid token bloat)
    history.push(
      { role: 'user',  parts: [{ text: message.trim() }] },
      { role: 'model', parts: [{ text: reply }] }
    );
    if (history.length > 20) history.splice(0, 2); // remove oldest turn
    conversations.set(sid, history);

    // Clean up old sessions (keep map small)
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
    if (error.message?.includes('API key')) {
      return res.status(500).json({ ok: false, error: 'AI service unavailable. Please try again later.' });
    }

    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/ai/chat/:sessionId — clear conversation history
router.delete('/chat/:sessionId', (req, res) => {
  conversations.delete(req.params.sessionId);
  res.json({ ok: true });
});

export default router;
