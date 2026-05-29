import express from 'express';
import User from '../models/User.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// ─────────────────────────────────────────────
//  SEARCH MENTORS
// ─────────────────────────────────────────────
router.get('/mentors', optionalAuth, async (req, res) => {
  try {
    const { q, category, mentorBackground, sort } = req.query;

    const filter      = { role: 'mentor' };
    let   sortOptions = { lastActive: -1 };   // 🔴 FIX: default = most recently active

    // ── Text search ──────────────────────────
    if (q?.trim()) {
      const re = { $regex: q.trim(), $options: 'i' };
      filter.$or = [
        { username : re },
        { bio      : re },
        { expertise: re },
        { skills   : re },
        { 'education.institution': re }
      ];
    }

    // ── Category filter ───────────────────────
    if (category && category !== 'All') {
      switch (category) {
        case 'Roadmap & Guidance':
          filter.expertise = { $elemMatch: { $regex: /roadmap|guidance|career/i } };
          break;
        case 'Internships':
          filter.expertise = { $elemMatch: { $regex: /internship|intern/i } };
          break;
        case 'Placements':
          filter.expertise = { $elemMatch: { $regex: /placement|job|interview/i } };
          break;
        case 'Higher Studies':
          filter.expertise = { $elemMatch: { $regex: /higher studies|ms|mba/i } };
          break;
        case 'Startups / Entrepreneurship':
          filter.expertise = { $elemMatch: { $regex: /startup|entrepreneur/i } };
          break;
        case 'Top Rated Mentors':
          filter.rating = { $gte: 4.5 };
          break;
        case 'Active Now':
          filter.isOnline = true;
          break;
      }
    }

    // ── Mentor background filter ──────────────
    if (mentorBackground && mentorBackground !== 'All') {
      const userCollege = req.user?.education?.[0]?.institution ||
                          req.user?.education?.[0]?.institutionName;

      if (
        (mentorBackground === 'Senior from My College' ||
         mentorBackground === 'Alumni from My College') && userCollege
      ) {
        filter['education.institution'] = userCollege;
      } else if (mentorBackground === 'Industry Professional') {
        filter.expertise = { $elemMatch: { $regex: /engineer|developer|manager|professional/i } };
      } else if (mentorBackground === 'Founder / Entrepreneur') {
        filter.expertise = { $elemMatch: { $regex: /founder|ceo|entrepreneur/i } };
      } else if (mentorBackground === 'Exam / Subject Expert') {
        filter.expertise = { $elemMatch: { $regex: /exam|gate|gre|cat/i } };
      }
    }

    // ── Sort ──────────────────────────────────
    switch (sort) {
      case 'Most Helpful':
      case 'Highest Rated':
        sortOptions = { rating: -1 };
        break;
      case 'Most Active':
        sortOptions = { lastActive: -1 };
        break;
      case 'Lowest Price':
        sortOptions = { price: 1 };
        break;
      case 'Most Experienced':
        sortOptions = { yearsOfExperience: -1 };
        break;
      case 'Newest Mentors':
        sortOptions = { createdAt: -1 };
        break;
      default:
        sortOptions = { lastActive: -1 };
    }

    // Respect client-provided `limit` with a safe upper bound to avoid huge responses
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 100;

    const mentors = await User.find(filter)
      .sort(sortOptions)
      .limit(limit)
      .select('username name profilePicture bio rating expertise skills education location isOnline lastActive price yearsOfExperience topCompanies specialTags primaryDomain')
      .lean();

    res.json(mentors);
  } catch (error) {
    console.error('search/mentors error:', error);
    res.status(500).json({ message: 'Error searching mentors', error: error.message });
  }
});



// �������������������������������������
// �������������������������������������
// �������������������������������������

// �������������������������������������
// INTELLIGENCE SEARCH WITH GROQ
// �������������������������������������
router.post('/intelligence/search', async (req, res) => {
  try {
    const { query, college, branch } = req.body;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'Query too short' });
    }

    const systemPrompt = `You are AtyantEngine — the AI intelligence layer of Atyant, a career guidance platform for Indian engineering students.

Your job: analyze the student's career question and return a sharp, data-backed response.

STRICT OUTPUT FORMAT — return ONLY valid JSON, no markdown, no extra text:
{
  "context": "One line like 'VNIT Metallurgy → IIM · 3 paths found'",
  "analysis": "2-3 sentences of sharp, specific, actionable analysis for Indian engineering context. Mention specific colleges (NITs, IITs, IIMs), companies (Google, Amazon, Razorpay), exams (CAT, GATE, GRE) where relevant.",
  "callout": {
    "label": "// Verified · [College] → [Company/Achievement] · [Year]",
    "quote": "A realistic, specific quote from a student who solved this exact problem. 1-2 sentences. Casual tone."
  },
  "followUps": ["Natural follow-up question 1", "Natural follow-up question 2", "Natural follow-up question 3"]
}

Rules:
- Be specific to Indian engineering context
- Analysis must be actionable, not generic platitudes
- Quote must feel real — casual, specific, not corporate
- followUps must be the natural next questions a student would ask
- Return ONLY the JSON object`;

    const userPrompt = `Student background: College: ${college || 'Not specified'}, Branch: ${branch || 'Not specified'}

Their question: "${query}"

Analyze this and return the JSON response.`;

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not configured' });
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.65,
        max_tokens: 700,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      console.error('Groq API Error:', groqResponse.status, errorText);
      return res.status(500).json({ error: 'Groq API unavailable' });
    }

    const groqData = await groqResponse.json();
    const content = groqData.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty Groq response' });

    let resultJson;
    try {
      resultJson = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'Invalid JSON from Groq' });
      resultJson = JSON.parse(match[0]);
    }

    res.json(resultJson);
  } catch (error) {
    console.error('Intelligence search error:', error);
    res.status(500).json({ error: 'Internal intelligence failure' });
  }
});

export default router;

