import fetch from 'node-fetch';
import axios from 'axios'; 
import User from '../models/User.js';
import AIConversation from '../models/AIConversation.js';
import { ATYANT_KNOWLEDGE, findRelevantInfo } from './AtyantKnowledge.js';

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
    this.model  = 'llama3-70b-8192';
    this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

    if (!this.apiKey) {
      console.error('❌ GROQ_API_KEY not found in .env!');
      return;
    }
    console.log('✅ Groq AI initialized successfully');
  }

  async _groqRequest(systemPrompt, userPrompt) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1024
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq API error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }
  // AIService class ke andar refineExperience function mein prompt ko aise change karein:
  async refineExperience(rawData) {
    try {
      if (!this.apiKey) return rawData;

      const systemPrompt = `You are a senior mentor at Atyant. Fix grammar and structure of mentor journeys.
STRICT RULES:
1. DO NOT change the mentor's original story or specific details.
2. KEEP the tone casual and "Senior-like".
3. If they used Hinglish (Hindi + English), PRESERVE IT.
4. AVOID robotic words like 'delve', 'unleash', 'comprehensive', or 'empower'.
5. Return ONLY a valid JSON object, no markdown.`;

      const userPrompt = `Fix this mentor's raw journey and return JSON with keys:
mainAnswer, situation, firstAttempt, keyMistakes (array), whatWorked, actionableSteps (array), timeline, differentApproach, additionalNotes.

RAW DATA: ${JSON.stringify(rawData)}`;

      const aiText = await this._groqRequest(systemPrompt, userPrompt);
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : rawData;
    
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