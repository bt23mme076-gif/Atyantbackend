import express from 'express';
import Roadmap from '../models/Roadmap.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';
import { groqJSON } from '../utils/groqClient.js';

const router = express.Router();

// ─── AI Roadmap Generation ─────────────────────────────────────────────────
// Uses groqJSON for structured, personalised roadmap output.

const ROADMAP_SYSTEM_PROMPT = `You are Atyant's career-roadmap engine for Indian engineering students.

Given a student's GOAL, BRANCH, COLLEGE, YEAR, and CGPA, produce a personalised, actionable roadmap
broken into 4–6 sequential phases that take them from where they are NOW to their target.

RULES:
1. Each phase must have a SPECIFIC title reflecting the actual goal — never use generic titles like "Foundations" or "Application Strategy" unless they genuinely apply.
2. Tasks must be CONCRETE and ACTIONABLE — name real platforms (LeetCode, Kaggle, Coursera, NPTEL, GeeksforGeeks, LinkedIn, Codeforces, InterviewBit), real strategies, real companies, real exams.
3. Timelines must be REALISTIC for the student's current year — a 4th year student has less time than a 2nd year student.
4. For each phase, include 1-2 pro-tips (short, sharp advice a senior would give) and 1-3 resources (name + URL).
5. First phase status should be "active", last phase "locked", rest "upcoming".
6. If the goal involves non-tech paths (MBA, Core Engineering, Civil Services, etc.), DO NOT default to SDE/coding advice.
7. Tailor to the BRANCH — a Metallurgy student wanting a core job needs different steps than a CSE student wanting SDE.
8. If CGPA is low (<7), include a phase about CGPA damage-control or alternative pathways.
9. Keep tasks to 3-5 per phase. Keep tips to 1-2 per phase. Keep resources to 1-3 per phase.
10. Handle Hinglish goal descriptions naturally.

Return ONLY a JSON object with this exact structure:
{
  "phases": [
    {
      "phase": "Phase 1",
      "title": "specific title",
      "duration": "X–Y weeks",
      "status": "active",
      "tasks": ["task1", "task2", "task3"],
      "tips": ["pro tip 1"],
      "resources": [{"name": "Resource Name", "url": "https://..."}]
    }
  ]
}`;

async function generateWithAI(goal, branch, college, year, cgpa) {
  const userPrompt = `Student Profile:
- GOAL: ${goal}
- BRANCH: ${branch || 'Not specified'}
- COLLEGE: ${college || 'Not specified'}
- YEAR: ${year || 'Not specified'}
- CGPA: ${cgpa || 'Not specified'}

Generate their personalised career roadmap. Return ONLY the JSON.`;

  const result = await groqJSON(
    [
      { role: 'system', content: ROADMAP_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
    { maxTokens: 2000, timeoutMs: 30000 },
  );

  // Validate structure
  const phases = result?.phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;

  // Normalize and validate each phase
  return phases.map((p, i) => ({
    phase:    p.phase    || `Phase ${i + 1}`,
    title:    p.title    || 'Untitled Phase',
    duration: p.duration || '2–4 weeks',
    status:   i === 0 ? 'active' : (i === phases.length - 1 ? 'locked' : 'upcoming'),
    tasks:    Array.isArray(p.tasks) ? p.tasks.filter(t => typeof t === 'string') : [],
    tips:     Array.isArray(p.tips) ? p.tips.filter(t => typeof t === 'string') : [],
    resources: Array.isArray(p.resources)
      ? p.resources
          .filter(r => r && typeof r === 'object' && r.name)
          .map(r => ({ name: String(r.name), url: String(r.url || '#') }))
      : [],
  }));
}

// ─── Goal-aware static fallbacks ───────────────────────────────────────────
// These kick in only when AI generation fails entirely.

function getFallbackSteps(goal) {
  const g = (goal || '').toLowerCase();

  // SDE / Tech
  if (/sde|software|developer|coding|web dev|full.?stack|backend|frontend|dsa|faang|tech/i.test(g)) {
    return [
      { phase: 'Phase 1', title: 'DSA & Language Mastery', duration: '4–6 weeks', status: 'active',
        tasks: ['Pick one language (C++/Java/Python) and master STL/Collections', 'Solve 100 LeetCode problems (Easy → Medium)', 'Learn time/space complexity analysis'],
        tips: ['Don\'t jump to Hard problems — build pattern recognition on Easy/Medium first.'],
        resources: [{ name: 'NeetCode Roadmap', url: 'https://neetcode.io/roadmap' }, { name: 'Striver SDE Sheet', url: 'https://takeuforward.org/interviews/strivers-sde-sheet-top-coding-interview-problems' }] },
      { phase: 'Phase 2', title: 'Projects & GitHub Portfolio', duration: '6–8 weeks', status: 'upcoming',
        tasks: ['Build 2 end-to-end projects (one full-stack, one with API integration)', 'Deploy on Vercel/Railway with clean READMEs', 'Contribute to 1 open-source project'],
        tips: ['Recruiters scan GitHub in 30 seconds — pin your best repos, add screenshots.'],
        resources: [{ name: 'Project Ideas', url: 'https://github.com/florinpop17/app-ideas' }] },
      { phase: 'Phase 3', title: 'Resume & Application Blitz', duration: '2–3 weeks', status: 'upcoming',
        tasks: ['Tailor resume using STAR format for each role type', 'Apply to 50+ openings on LinkedIn, company career pages, and AngelList', 'Cold-message 10 employees at target companies on LinkedIn'],
        tips: ['Apply in the first 24 hours of a job posting — early applications get 3x more views.'],
        resources: [{ name: 'Resume Template', url: 'https://www.overleaf.com/latex/templates/jakes-resume/syzfjbzwjncs' }] },
      { phase: 'Phase 4', title: 'Interview Prep & Mock Rounds', duration: 'Ongoing', status: 'locked',
        tasks: ['Do 5 mock interviews on Pramp or with peers', 'Practice system design basics (LLD + HLD)', 'Review company-specific interview patterns on LeetCode Discuss'],
        tips: ['Record yourself solving problems — watch it back to catch verbal tics and clarity issues.'],
        resources: [{ name: 'System Design Primer', url: 'https://github.com/donnemartin/system-design-primer' }] },
    ];
  }

  // MBA / Consulting
  if (/mba|iim|cat|consulting|management|business/i.test(g)) {
    return [
      { phase: 'Phase 1', title: 'CAT/XAT Foundations', duration: '8–12 weeks', status: 'active',
        tasks: ['Start with Quant basics (Arithmetic, Algebra, Geometry)', 'Build reading speed — 1 editorial + 1 long-form article daily', 'Join a test series (IMS/TIME/CL)'],
        tips: ['Start with your weakest section. Most toppers say VARC decides the final percentile.'],
        resources: [{ name: 'Cracku Free CAT Material', url: 'https://cracku.in/cat-preparation' }] },
      { phase: 'Phase 2', title: 'Mock Tests & Analysis', duration: '6–8 weeks', status: 'upcoming',
        tasks: ['Take 2 full-length mocks per week', 'Spend 2x the test time on analysis — find patterns in your mistakes', 'Target 99+ percentile accuracy in your strongest section'],
        tips: ['Never skip mock analysis. The mock is 30% of the value — the analysis is 70%.'],
        resources: [{ name: 'IMS Mocks', url: 'https://www.imsindia.com/' }] },
      { phase: 'Phase 3', title: 'Profile Building (Calls, WAT/PI)', duration: '4–6 weeks', status: 'upcoming',
        tasks: ['Draft 5 versions of "Why MBA?" and get senior feedback', 'Prepare 10 case study frameworks', 'Build extracurricular proof (leadership, social impact, sports)'],
        tips: ['IIMs care about "spikes" — one standout achievement > five mediocre ones.'],
        resources: [{ name: 'InsideIIM Profiles', url: 'https://insideiim.com/' }] },
      { phase: 'Phase 4', title: 'D-Day & Convert', duration: '2–3 weeks', status: 'locked',
        tasks: ['Revise Quant formulae and VARC strategies', 'Do 3 full-length mocks under exam conditions', 'Keep GK/current affairs updated for XAT/IIFT'],
        tips: ['Sleep well the night before. Freshness > last-minute cramming at this stage.'],
        resources: [{ name: 'PaGaLGuY Forum', url: 'https://www.pagalguy.com/' }] },
    ];
  }

  // Core Engineering
  if (/core|psu|gate|mechanical|civil|electrical|metallurgy|chemical|manufacturing/i.test(g)) {
    return [
      { phase: 'Phase 1', title: 'GATE Syllabus & Core Concepts', duration: '8–10 weeks', status: 'active',
        tasks: ['Map the GATE syllabus to your branch subjects', 'Complete one standard textbook per subject (Signals & Systems, Strength of Materials, etc.)', 'Solve previous 10 years\' GATE papers topic-wise'],
        tips: ['Don\'t study all subjects equally — 60% of marks come from 40% of the syllabus. Identify high-weightage topics.'],
        resources: [{ name: 'GATE Overflow', url: 'https://gateoverflow.in/' }, { name: 'NPTEL Courses', url: 'https://nptel.ac.in/' }] },
      { phase: 'Phase 2', title: 'Test Series & Problem Practice', duration: '6–8 weeks', status: 'upcoming',
        tasks: ['Join a GATE test series (MADE EASY / ACE Academy)', 'Take 2 subject tests + 1 full-length per week', 'Maintain an error log — categorise mistakes by concept vs silly errors'],
        tips: ['Time management is the real GATE skill — practice completing sections within time limits.'],
        resources: [{ name: 'MADE EASY', url: 'https://www.madeeasy.in/' }] },
      { phase: 'Phase 3', title: 'PSU Applications & Core Internships', duration: '3–4 weeks', status: 'upcoming',
        tasks: ['Track PSU recruitment calendars (NTPC, ONGC, IOCL, BHEL, SAIL)', 'Apply through GATE score + direct recruitment', 'Build a project portfolio in your core domain'],
        tips: ['Many PSUs accept GATE scores from previous years — don\'t wait for this year\'s result to apply.'],
        resources: [{ name: 'PSU Recruitment Calendar', url: 'https://testbook.com/psu-exams' }] },
      { phase: 'Phase 4', title: 'Interview & GD Prep', duration: 'Ongoing', status: 'locked',
        tasks: ['Prepare technical fundamentals for PSU interviews', 'Practice GD on current affairs and industry topics', 'Mock interviews with seniors who cracked PSUs'],
        tips: ['PSU interviews test depth over breadth — know your final year project inside out.'],
        resources: [{ name: 'GradeUp GATE', url: 'https://gradeup.co/gate' }] },
    ];
  }

  // Generic fallback
  return [
    { phase: 'Phase 1', title: 'Skill Assessment & Goal Clarity', duration: '2–3 weeks', status: 'active',
      tasks: ['Research 5 people who\'ve achieved your target goal on LinkedIn', 'List the top 3 skills/qualifications required', 'Assess your current level honestly and identify gaps'],
      tips: ['Talk to 2 seniors who\'ve walked this path — they\'ll tell you what Google won\'t.'],
      resources: [{ name: 'LinkedIn Career Explorer', url: 'https://www.linkedin.com/career-explorer' }] },
    { phase: 'Phase 2', title: 'Skill Building & Practice', duration: '6–8 weeks', status: 'upcoming',
      tasks: ['Complete 1 structured course on the primary skill gap', 'Build 2 proof-of-work projects', 'Start a learning journal/blog to document progress'],
      tips: ['Projects > Certificates. Recruiters want to see what you\'ve BUILT, not what you\'ve watched.'],
      resources: [{ name: 'Coursera', url: 'https://www.coursera.org/' }] },
    { phase: 'Phase 3', title: 'Network & Apply', duration: '3–4 weeks', status: 'upcoming',
      tasks: ['Update LinkedIn with projects and skills', 'Apply to 30+ relevant opportunities', 'Reach out to 10 professionals in your target field'],
      tips: ['A warm referral has 10x the conversion rate of a cold application.'],
      resources: [{ name: 'AngelList Jobs', url: 'https://angel.co/jobs' }] },
    { phase: 'Phase 4', title: 'Preparation & Execution', duration: 'Ongoing', status: 'locked',
      tasks: ['Prepare for domain-specific interviews', 'Do 3 mock interviews', 'Review and iterate on your approach weekly'],
      tips: ['Rejection is data, not failure. Track what went wrong and fix it for the next one.'],
      resources: [] },
  ];
}

// ─── Routes ────────────────────────────────────────────────────────────────

// GET /api/roadmap/me — get current user's saved roadmap
router.get('/me', protect, async (req, res) => {
  try {
    const roadmap = await Roadmap.findOne({ userId: req.user.userId }).lean();
    res.json({ ok: true, roadmap: roadmap || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/roadmap/generate — generate a personalised roadmap
router.post('/generate', optionalAuth, async (req, res) => {
  try {
    const { goal, college, branch, year, cgpa } = req.body;
    const userId = req.user?.userId || req.user?._id;

    if (!goal || !goal.trim()) {
      return res.status(400).json({ ok: false, error: 'goal is required' });
    }

    // Try AI generation first, fall back to goal-aware templates on failure
    let steps;
    try {
      steps = await generateWithAI(goal.trim(), branch, college, year, cgpa);
    } catch (aiErr) {
      console.warn('⚠️ Roadmap AI generation failed, using fallback:', aiErr.message);
      steps = null;
    }

    if (!steps || steps.length === 0) {
      steps = getFallbackSteps(goal);
    }

    // Only save to DB if user is logged in
    let roadmap;
    if (userId) {
      roadmap = await Roadmap.findOneAndUpdate(
        { userId },
        { userId, goal: goal.trim(), college, branch, year, cgpa: String(cgpa || ''), steps, generatedAt: new Date() },
        { upsert: true, new: true }
      );
    } else {
      roadmap = { goal: goal.trim(), college, branch, year, cgpa, steps, generatedAt: new Date() };
    }

    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/roadmap/step/:index/status — update a phase's status
// Body: { status: "active" | "upcoming" | "locked" | "completed" }
router.patch('/step/:index/status', protect, async (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const { status } = req.body;
    const allowed = ['active', 'upcoming', 'locked', 'completed'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: `status must be one of: ${allowed.join(', ')}` });
    }

    const roadmap = await Roadmap.findOne({ userId: req.user.userId });
    if (!roadmap) return res.status(404).json({ ok: false, error: 'Roadmap not found' });
    if (!roadmap.steps[idx]) return res.status(400).json({ ok: false, error: 'Step index out of range' });

    roadmap.steps[idx].status = status;
    roadmap.markModified('steps');
    await roadmap.save();

    res.json({ ok: true, roadmap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
