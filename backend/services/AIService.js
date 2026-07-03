import axios from 'axios';
import User from '../models/User.js';
import AIConversation from '../models/AIConversation.js';
import { ATYANT_KNOWLEDGE, findRelevantInfo } from './AtyantKnowledge.js';
import { groqChat, groqJSON } from '../utils/groqClient.js';

/**
 * 🚀 FEATURE: Question Text ko Vector mein badalna
 * Ye function Python Service se baat karke searchable numbers lata hai.
 */
export const getQuestionEmbedding = async (text) => {
  try {
    const PYTHON_SERVICE_URL = process.env.PYTHON_ENGINE_URL || "http://127.0.0.1:8000";
    const response = await axios.post(`${PYTHON_SERVICE_URL}/embed`, { text });

    // Debugging: Check karo Python actually kya bhej raha hai
    if (response.data.error) {
      console.error("⚠️ Python Service Error:", response.data.details || response.data.error);
      return null;
    }

    let vector = response.data.embedding;

    if (!Array.isArray(vector)) {
      console.error("⚠️ Expected embedding array but got:", typeof vector);
      return null;
    }

    return vector;
  } catch (error) {
    console.error("❌ Python AI Service Call Failed:", error.message);
    return null; 
  }
};

class AIService {
  constructor() {
    this.apiKey = process.env.GROQ_API_KEY;
    // Use the model from env — the old hardcoded 'llama3-70b-8192' is decommissioned
    // by Groq and 400s, which silently fell back to the raw (unstructured) story.
    this.model  = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

    if (!this.apiKey) {
      console.error('❌ GROQ_API_KEY not found in .env!');
      return;
    }
    console.log(`✅ Groq AI initialized (model: ${this.model})`);
  }

  async _groqRequest(systemPrompt, userPrompt) {
    // Routed through the shared rotating client so this shares the key pool with
    // the chat engine and fails over on rate limits instead of erroring out.
    return groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      { model: this.model, temperature: 0.7, maxTokens: 1024 },
    );
  }
  // AIService class ke andar refineExperience function mein prompt ko aise change karein:
  async refineExperience(rawData) {
    try {
      if (!this.apiKey) return rawData;

      const systemPrompt = `You are helping Indian engineering students write mentor profile cards for Atyant.
STRICT RULES:
1. DO NOT change the mentor's original story or specific details.
2. KEEP the tone casual, real, and "senior talking to junior" — not corporate.
3. If they used Hinglish (Hindi + English), PRESERVE IT.
4. AVOID robotic words like 'delve', 'unleash', 'comprehensive', 'empower', 'leverage'.
5. Return ONLY a valid JSON object, no markdown, no extra text.

CRITICAL — mainAnswer must be a student-facing headline:
- Written as what a STUDENT would feel reading it, not what the mentor wants to say
- Format: "[Starting struggle] → [What they achieved]" OR "How I [achieved X] from [background Y]"
- Must be specific with real context (branch, college tier, company, exam, etc.)
- Must feel like something a junior would think "this is exactly my situation"
- NEVER describe Atyant or any platform — only the mentor's personal journey
- BAD: "Atyant helps students find mentors" / "Mentorship is key to success"
- BAD: "A comprehensive guide to placements"
- GOOD: "Failed 3 campus drives, cracked Amazon off-campus in final year"
- GOOD: "Metallurgy → IIM Calcutta research intern without CAT — exact playbook"
- GOOD: "How I got a FAANG SDE role with zero CS background from NIT Raipur"`;

      const userPrompt = `/no_think
Rewrite this mentor's raw journey into a structured answer card a junior student would find genuinely useful.
Expand each section into proper sentences. Don't copy the same text into every field.
Return ONLY a JSON object with these exact keys:
- mainAnswer: student-facing headline (see rules above — most important field)
- situation: what was the mentor's actual starting point and challenge
- whatWorked: the 2-3 things that actually moved the needle
- keyMistakes: array of strings — real mistakes, not generic advice
- actionableSteps: array of {step, description} — concrete steps a junior can follow
- timeline: how long the whole journey took (e.g. "8 months", "Final year")
- differentApproach: what they'd do differently if starting today

RAW DATA: ${JSON.stringify(rawData)}`;

      const aiText = await this._groqRequest(systemPrompt, userPrompt);
      // Qwen3 / reasoning models can prepend a <think>…</think> block (and any
      // prose) before the JSON. Strip thinking, then take the JSON object.
      const cleaned = String(aiText || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json|```/gi, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      let parsed;
      try {
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : rawData;
      } catch (parseErr) {
        console.warn('refineExperience: JSON parse failed, using raw:', parseErr.message);
        parsed = rawData;
      }
    
    // 🔴 FIX: Validate and normalize actionableSteps format
    if (parsed.actionableSteps) {
      // If it's a string, convert to array of objects
      if (typeof parsed.actionableSteps === 'string') {
        const steps = parsed.actionableSteps.split('\n').filter(s => s.trim());
        parsed.actionableSteps = steps.map((stepText, index) => ({
          step: `Step ${index + 1}`,
          description: stepText.trim()
        }));
      }
      // If it's an array of strings, convert to array of objects
      else if (Array.isArray(parsed.actionableSteps) && 
               parsed.actionableSteps.length > 0 && 
               typeof parsed.actionableSteps[0] === 'string') {
        parsed.actionableSteps = parsed.actionableSteps.map((stepText, index) => ({
          step: `Step ${index + 1}`,
          description: stepText.trim()
        }));
      }
      // If it's array of objects, validate structure
      else if (Array.isArray(parsed.actionableSteps)) {
        parsed.actionableSteps = parsed.actionableSteps.map((item, index) => {
          if (typeof item === 'object' && item !== null) {
            return {
              step: item.step || `Step ${index + 1}`,
              description: item.description || item.step || ''
            };
          }
          return {
            step: `Step ${index + 1}`,
            description: String(item)
          };
        });
      }
    }
    
    // 🔴 FIX: Validate and normalize keyMistakes format
    if (parsed.keyMistakes) {
      if (typeof parsed.keyMistakes === 'string') {
        parsed.keyMistakes = [parsed.keyMistakes];
      } else if (Array.isArray(parsed.keyMistakes) && 
                 parsed.keyMistakes.length > 0 && 
                 typeof parsed.keyMistakes[0] === 'string') {
        // Already array of strings - this is valid per schema
      } else if (Array.isArray(parsed.keyMistakes)) {
        // Convert objects to strings if needed
        parsed.keyMistakes = parsed.keyMistakes.map(item => {
          if (typeof item === 'object' && item !== null) {
            return item.description || item.mistake || String(item);
          }
          return String(item);
        });
      }
    }
    
    return parsed;
  } catch (error) {
    return rawData;
  }
}

  /**
   * 🎯 TARGET-DOMAIN CLASSIFIER
   *
   * Maps a student's goal/query to the SAME `companyDomain` enum that mentors
   * are tagged with, so role fit ("SDE / tech job" → Tech) can be matched
   * structurally — WITHOUT a hardcoded keyword list that needs a backend edit
   * for every new phrasing. The LLM generalises across wordings and languages
   * (Hinglish included), and this one field is reused everywhere in scoring.
   *
   * Returns one of the enum strings, or null when the goal is genuinely
   * domain-agnostic / unclear (so we never force a wrong hard signal).
   */
  async classifyTargetDomain(text) {
    const VALID = ['Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering'];
    try {
      if (!text || !String(text).trim()) return null;

      const systemPrompt = `You classify an Indian engineering student's CAREER TARGET into exactly one role domain, or "none".
Valid domains (return the label EXACTLY):
- "Tech": software/SDE/SWE, web/app/mobile dev, ML/data/cloud/devops engineering, any coding-first role
- "Data Analytics": data analyst, business analyst, analytics, data science reporting
- "Consulting": management/strategy consulting, consultant roles
- "Product": product manager / product management / APM
- "Core Engineering": mechanical, civil, metallurgy, chemical, electrical, manufacturing, PSU/core-company roles (JSW, ONGC, HPCL, L&T, etc.)
- "none": the target is unclear, generic, or not tied to any single domain

Rules:
- Judge by the ROLE the student wants, NOT their current branch. A Metallurgy student who wants an "SDE role" is "Tech".
- Handle Hinglish and casual phrasing.
- Return ONLY a JSON object: {"domain": "<one label above>"}. No prose, no markdown.`;

      const userPrompt = `Student target: """${String(text).slice(0, 800)}"""\nReturn the JSON.`;

      // groqJSON → deterministic (temp 0), JSON-mode, fast/cheap model. More
      // reliable than free-text parsing, so the domain gate rarely goes inert.
      const parsed = await groqJSON([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ]);
      const domain = String(parsed?.domain || '').trim();
      return VALID.includes(domain) ? domain : null;
    } catch (error) {
      // Never break matching on a classifier hiccup — semantic path still runs.
      console.warn('classifyTargetDomain failed:', error.message);
      return null;
    }
  }

  /**
   * 🎯 CARD-DOMAIN CLASSIFIER
   *
   * Classifies the role domain of an answer-card's JOURNEY (what the mentor
   * actually achieved), not the generic advice text inside it. This is the
   * signal the Clarity feed gates on: unlike a mentor's profile (blank for
   * 68%), every surfaced card HAS content, so its domain is always derivable.
   * Call this once at card creation and store the result on AnswerCard.domain.
   *
   * IMPORTANT: mainAnswer/situation (the actual outcome — "→ IIM Mumbai intern")
   * carry the real signal. actionableSteps are generic advice ("build a tech
   * project", "prep case interviews") that mention OTHER domains incidentally —
   * feeding them in undifferentiated made a management/IIM card misclassify as
   * "Tech" because a step said "create small Tech projects". So the outcome is
   * given separately and weighted explicitly over the advice text.
   */
  async classifyCardDomain(answerContent) {
    const VALID = ['Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering'];
    try {
      const a = answerContent || {};
      const outcome = [a.mainAnswer, a.situation].filter(Boolean).join('. ').slice(0, 500);
      if (!outcome.trim()) return null;

      const steps = Array.isArray(a.actionableSteps)
        ? a.actionableSteps.map(s => (typeof s === 'object' ? s.description : s)).filter(Boolean).join(' ')
        : '';
      const advice = [a.whatWorked, steps].filter(Boolean).join(' ').slice(0, 500);

      const systemPrompt = `You classify a mentor's ACHIEVED career outcome into exactly one role domain.
Valid domains (return the label EXACTLY):
- "Tech": software/SDE/SWE, web/app/mobile dev, ML/data/cloud/devops engineering, any coding-first role
- "Data Analytics": data analyst, business analyst, analytics, data science reporting
- "Consulting": management/strategy consulting, MBA-track roles, IIM/B-school internships or placements
- "Product": product manager / product management / APM
- "Core Engineering": mechanical, civil, metallurgy, chemical, electrical, manufacturing, PSU/core-company roles
- "none": unclear or not tied to any single domain

Rules:
- Judge ONLY by the OUTCOME field (what role/company/programme they actually reached), NOT the advice/steps field.
- The advice/steps field is generic guidance and may mention unrelated domains in passing (e.g. "build a tech project" as a suggestion) — IGNORE domain words that appear only there if they contradict the outcome.
- An MBA/IIM/management internship or placement is "Consulting", never "Tech", regardless of what the advice text suggests.
- Handle Hinglish and casual phrasing.
- Return ONLY a JSON object: {"domain": "<one label above>"}. No prose, no markdown.`;

      const userPrompt = `OUTCOME (what they actually achieved): """${outcome}"""\nADVICE/STEPS (context only, do not classify from this alone): """${advice}"""\nReturn the JSON.`;

      const parsed = await groqJSON([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ]);
      const domain = String(parsed?.domain || '').trim();
      return VALID.includes(domain) ? domain : null;
    } catch (error) {
      console.warn('classifyCardDomain failed:', error.message);
      return null;
    }
  }

  // Aapka Platform Knowledge Prompt
  getSystemPrompt() {
    return `You are Atyant's AI — talk like a sharp senior who already cracked college, not like a support bot.

ABOUT ATYANT: ${ATYANT_KNOWLEDGE.platform.description}
KEY FEATURES: ${ATYANT_KNOWLEDGE.platform.features.map(f => `${f.icon} ${f.name}`).join(', ')}

YOUR JOB: Help Tier-2/3 engineering students find the right mentor and answer Atyant questions. When the student has a real career problem, point them to the mentor who walked that exact path instead of faking a full answer.

VOICE:
- Plain, direct sentences. Get to the point in the first line. Contractions are fine.
- Warm but never soft. Specific over generic — name real companies, platforms, timelines.
- Keep it short. 2-4 sentences unless they ask for a roadmap.

NEVER write (instant robot tells — banned): "Great question!", "I'd be happy to", "Let me help you with that", "delve", "unleash", "comprehensive", "empower", "leverage", "seamless", "In today's competitive world", "Feel free to". No emoji spam. Don't recap what you just said.`;
  }

  /**
   * 🤖 CHAT FLOW: Gemini Conversation Logic
   */
  async chat(userId, userMessage, conversationId = null) {
    try {
      console.log('🤖 AI Chat Request for User:', userId);

      if (!this.apiKey) throw new Error('API key not configured');
      if (!userMessage?.trim()) throw new Error('Message cannot be empty');

      const platformInfo = findRelevantInfo(userMessage);

      let conversation = conversationId 
        ? await AIConversation.findOne({ _id: conversationId, userId }) 
        : await AIConversation.create({ userId, messages: [] });

      if (!conversation) conversation = await AIConversation.create({ userId, messages: [] });

      conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });

      let aiResponse;
      if (platformInfo) {
        aiResponse = platformInfo.type === 'faq' ? platformInfo.content.answer : "I can help with that Atyant feature!";
      } else {
        aiResponse = await this._groqRequest(this.getSystemPrompt(), userMessage);
        if (!aiResponse) aiResponse = "I'm here to help! 😊";
      }

      conversation.messages.push({ role: 'assistant', content: aiResponse, timestamp: new Date() });
      await conversation.save();

      return { success: true, response: aiResponse, conversationId: conversation._id };
    } catch (error) {
      console.error('❌ Chat Error:', error.message);
      return { success: false, response: "Sorry, I'm having trouble! 🙏" };
    }
  }

  // Intent Detection Logic
  detectIntent(message) {
    const lower = message.toLowerCase();
    if (/internship|exam|study/i.test(lower)) return { category: 'academic', needsMentor: true };
    return { category: 'general', needsMentor: false };
  }

  // Mentor Search Logic
  async findRelevantMentors(category, excludeUserId) {
    try {
      return await User.find({ role: 'mentor', _id: { $ne: excludeUserId } }).limit(3);
    } catch (error) { return []; }
  }
}

// Dono exports set hain: Instance (default) aur Function (named)
const aiServiceInstance = new AIService();
export default aiServiceInstance;