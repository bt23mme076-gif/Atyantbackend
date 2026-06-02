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
    this.apiKey = process.env.GEMINI_API_KEY;
    // Use gemini-1.5-flash for v1beta endpoint compatibility (public API key)
    this.model = 'gemini-1.5-flash';
    
    if (!this.apiKey) {
      console.error('❌ GEMINI_API_KEY not found in .env!');
      return;
    }
    console.log('✅ Gemini AI initialized successfully');
  }
  // AIService class ke andar refineExperience function mein prompt ko aise change karein:
async refineExperience(rawData) {
  try {
    if (!this.apiKey) return rawData;

    // 🔥 NEW HUMAN PROMPT: Isse AI feeling khatam hogi
    const prompt = `You are a senior mentor at Atyant. A mentor shared their raw journey below. 
    Your task: Fix only the grammar and make the structure readable. 
    STRICT RULES:
    1. DO NOT change the mentor's original story or specific details.
    2. KEEP the tone casual and "Senior-like". 
    3. If they used Hinglish (Hindi + English), PRESERVE IT.
    4. AVOID robotic words like 'delve', 'unleash', 'comprehensive', or 'empower'.
    5. Return ONLY a JSON object with these keys: 
    6. Map 'What failed' text to the 'keyMistakes' array.
    7. Map 'Step-by-step actions' to the 'actionableSteps' array.
{
  "mainAnswer": "Short summary",
  "situation": "The backstory",
  "firstAttempt": "Initially tried...",
  "keyMistakes": [
    { "mistake": "Mistake Title", "description": "Why it failed" }
  ],
  "whatWorked": "Final success solution",
  "actionableSteps": [
    { "step": "Step Title", "description": "What to do exactly" }
  ],
  "timeline": "Months/Days",
  "differentApproach": "If I did it today...",
  "additionalNotes": "Final tips"
}
    
    RAW DATA: ${JSON.stringify(rawData)}`;

    // Use v1 endpoint for gemini-1.5-flash
    const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const data = await response.json();
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
    return `You are Atyant AI Assistant - an expert on the Atyant student mentorship platform.
    ABOUT ATYANT: ${ATYANT_KNOWLEDGE.platform.description}
    KEY FEATURES: ${ATYANT_KNOWLEDGE.platform.features.map(f => `${f.icon} ${f.name}`).join(', ')}
    YOUR ROLE: Help students find mentors and answer Atyant related queries concisely. 😊`;
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
        // Gemini API logic - use v1 endpoint for gemini-1.5-flash
        const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${this.getSystemPrompt()}\nUser: ${userMessage}` }] }]
          })
        });
        const data = await response.json();
        console.log('🔎 Gemini API raw response:', JSON.stringify(data, null, 2));
        if (data.error) {
          console.error('❌ Gemini API Error:', data.error);
        }
        aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm here to help! 😊";
        if (!aiResponse || aiResponse === "I'm here to help! 😊") {
          console.warn('⚠️ Gemini API did not return a valid answer. See above for details.');
        }
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