// Generates structured, phased career roadmaps with Groq. Two entry points:
//   • fromSession(insights)  — turn a session's analysis into a roadmap the
//     student can follow next (used by the pipeline AND on-demand regeneration).
//   • fromGoal({...})        — a goal-based roadmap before any session exists.
//
// Both return an array of steps matching roadmapStepSchema. If Groq is
// unavailable or returns junk we fall back to sensible static steps so the
// student never sees an empty roadmap.
import { groqJSON, GROQ_API_KEYS } from '../utils/groqClient.js';

const ROADMAP_MODEL = process.env.GROQ_ROADMAP_MODEL || 'llama-3.3-70b-versatile';

const STATUS = ['active', 'upcoming', 'locked', 'completed'];

// Normalize whatever the model returns into clean roadmapStepSchema steps.
function sanitizeSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s, i) => ({
      phase:    String(s?.phase || `Phase ${i + 1}`).slice(0, 80),
      title:    String(s?.title || '').slice(0, 120),
      duration: String(s?.duration || '2–4 weeks').slice(0, 40),
      status:   STATUS.includes(s?.status) ? s.status : (i === 0 ? 'active' : 'upcoming'),
      tasks:    (Array.isArray(s?.tasks) ? s.tasks : [])
                  .map(t => String(t).trim()).filter(Boolean).slice(0, 6),
    }))
    .filter(s => s.title && s.tasks.length)
    .slice(0, 6);
}

const GOAL_FALLBACK = (goal) => [
  { phase: 'Phase 1', title: 'Foundations', duration: '4–6 weeks', status: 'active',
    tasks: ['Learn core concepts and tools relevant to your goal', 'Set up a clean GitHub portfolio', 'Complete 1 foundational course'] },
  { phase: 'Phase 2', title: 'Project Portfolio', duration: '6–8 weeks', status: 'upcoming',
    tasks: ['Build 2 end-to-end projects and deploy them', 'Write a LinkedIn post on your learning journey', 'Make 1 open-source contribution'] },
  { phase: 'Phase 3', title: 'Application Strategy', duration: '2–3 weeks', status: 'upcoming',
    tasks: ['Tailor resume for target roles', 'Apply to 50+ relevant openings', 'Reach out to 10 people at target companies'] },
  { phase: 'Phase 4', title: 'Interview Prep', duration: 'Ongoing', status: 'locked',
    tasks: ['Practice DSA (easy → medium)', 'Do 5 mock interviews', 'Review domain-specific interview questions'] },
];

class RoadmapGenerator {
  // Build a roadmap from a completed session's insights.
  async fromSession({ topic, insights = {} }) {
    const fallback = this._sessionFallback(insights);
    if (!GROQ_API_KEYS.length) return fallback;

    const ctx = {
      topic: topic || 'Career Guidance',
      summary: insights.detailedSummary || insights.summary || '',
      areasToImprove: insights.areasToImprove || [],
      actionItems: insights.actionItems?.student || [],
      nextSessionFocus: insights.nextSessionFocus || [],
      recommendedResources: insights.recommendedResources || [],
    };

    try {
      const out = await groqJSON(
        [
          { role: 'system', content: 'You turn a mentorship session summary into a concrete, sequenced action roadmap for the student. Ground EVERY task in what the session actually surfaced — do not invent unrelated generic advice. Return ONLY valid JSON.' },
          { role: 'user', content: `Build a 3–5 phase roadmap the student should follow after this session.
Session topic: ${ctx.topic}

Session summary:
${ctx.summary}

Improvement areas surfaced: ${JSON.stringify(ctx.areasToImprove)}
Agreed action items: ${JSON.stringify(ctx.actionItems)}
Suggested next focus: ${JSON.stringify(ctx.nextSessionFocus)}
Resources mentor recommended: ${JSON.stringify(ctx.recommendedResources)}

Return ONLY:
{ "steps": [ { "phase": "Phase 1", "title": "short title", "duration": "e.g. 1–2 weeks", "status": "active|upcoming", "tasks": ["specific, doable task grounded in the session"] } ] }
First phase status = "active", the rest "upcoming". 3–5 phases, 2–5 tasks each.` },
        ],
        { model: ROADMAP_MODEL, maxTokens: 1800, timeoutMs: 45000 },
      );
      const steps = sanitizeSteps(out?.steps);
      return steps.length ? steps : fallback;
    } catch (err) {
      console.warn('RoadmapGenerator.fromSession failed, using fallback:', err.message);
      return fallback;
    }
  }

  // Build a roadmap from a stated goal (no session yet).
  async fromGoal({ goal, college, branch, year, cgpa }) {
    if (!GROQ_API_KEYS.length) return GOAL_FALLBACK(goal);
    try {
      const out = await groqJSON(
        [
          { role: 'system', content: 'You are a career roadmap planner for Indian college students. Build a concrete, sequenced roadmap toward the stated goal. Return ONLY valid JSON.' },
          { role: 'user', content: `Build a 4-phase career roadmap.
Goal: ${goal}
${college ? `College: ${college}` : ''}${branch ? `\nBranch: ${branch}` : ''}${year ? `\nYear: ${year}` : ''}${cgpa ? `\nCGPA: ${cgpa}` : ''}

Return ONLY:
{ "steps": [ { "phase": "Phase 1", "title": "short title", "duration": "e.g. 4–6 weeks", "status": "active|upcoming|locked", "tasks": ["specific task"] } ] }
First phase "active". 4 phases, 3 tasks each.` },
        ],
        { model: ROADMAP_MODEL, maxTokens: 1800, timeoutMs: 45000 },
      );
      const steps = sanitizeSteps(out?.steps);
      return steps.length ? steps : GOAL_FALLBACK(goal);
    } catch (err) {
      console.warn('RoadmapGenerator.fromGoal failed, using fallback:', err.message);
      return GOAL_FALLBACK(goal);
    }
  }

  // Deterministic fallback when AI is unavailable — still session-specific,
  // built directly from the analysis fields.
  _sessionFallback(insights = {}) {
    const actions = insights.actionItems?.student || [];
    const improve = (insights.areasToImprove || []).map(a => `Work on: ${a}`);
    const next    = insights.nextSessionFocus || [];
    const steps = [];
    if (actions.length) steps.push({ phase: 'Phase 1', title: 'Immediate next steps', duration: '1–2 weeks', status: 'active', tasks: actions.slice(0, 5) });
    if (improve.length) steps.push({ phase: `Phase ${steps.length + 1}`, title: 'Close the gaps', duration: '2–4 weeks', status: steps.length ? 'upcoming' : 'active', tasks: improve.slice(0, 5) });
    if (next.length)    steps.push({ phase: `Phase ${steps.length + 1}`, title: 'Prepare for next session', duration: '2–3 weeks', status: 'upcoming', tasks: next.slice(0, 5) });
    return steps;
  }
}

export default new RoadmapGenerator();
