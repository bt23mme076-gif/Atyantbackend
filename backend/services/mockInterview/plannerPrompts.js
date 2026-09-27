// Planner + critic prompts for the mock interview question plan.
//
// Flow (orchestrated by the planner service):
//   1. Code retrieves approved bank entries for company + role family and
//      decides how many bank slots this interview gets.
//   2. buildPlannerMessages → strongest model → JSON plan.
//   3. planValidator runs hard checks (ids, quotas, company claims).
//   4. buildCriticMessages → returns issues. If validator or critic found
//      issues, buildReviseMessages → one revision, then validate again.

export const INTERVIEW_COMPOSITION = { intro: 1, resume: 3, technical: 4, behavioral: 2, closing: 1 };

// Unsupported role families get no technical phase: its slots become extra
// resume questions. Resume slots can't exceed the claims available, so any
// shortfall moves to behavioral.
export function interviewComposition(roleFamily, claimCount) {
  if (roleFamily && roleFamily !== 'unsupported') return { ...INTERVIEW_COMPOSITION };
  const wanted = INTERVIEW_COMPOSITION.resume + INTERVIEW_COMPOSITION.technical;
  const resume = Math.min(wanted, claimCount);
  return { ...INTERVIEW_COMPOSITION, resume, technical: 0, behavioral: INTERVIEW_COMPOSITION.behavioral + wanted - resume };
}

export const CLAIM_QUOTA = 0.4;

const PLANNER_SYSTEM = `You are the question planner for a spoken mock interview. You design the full plan before the interview starts. You do not conduct the interview.

You receive one JSON object:
- interview: seniority and the exact number of questions per phase. This is one complete interview covering resume, technical and behavioral.
- roleFamily: topic sheet for this role family. Each topic has an id and mustKnow points written by senior engineers.
- coreTopics: standard HR/behavioral topics with ids (core.*).
- jd: requiredSkills and niceToHave (ids jd_s*), responsibilities, companyContext (ids cc*, facts quoted from the JD).
- resume: projects, skills (evidenced true/false), claims (ids c*, each with type, defensibilityRisk and a probeLadder).
- gap: jd skill ids the resume matches, and jd skill ids it does not show.
- bank: real questions reported by seniors for this company (ids b*), plus bankSlots, the maximum number you may use.
- retake: null, or { retestTopics, retestClaimIds, previousQuestions } for a repeat attempt.

## Grounding rules (hard)
1. Every question references exactly one input item through "ref":
   - {"type":"bank","id":"b*"} for a senior-reported question
   - {"type":"claim","id":"c*"} for a resume claim
   - {"type":"jd_skill","id":"jd_s*"} for a JD skill
   - {"type":"core","id":"core.*"} for a standard HR/behavioral topic
   Use only ids present in the input. Never invent ids.
2. Bank questions keep the substance of the reported question. You may rephrase for speech; do not add details the report does not contain. Use at most bankSlots bank questions, and only where they fit the phase.
3. Never state or imply anything about the company (what it usually asks, its culture, its process, its products) unless it appears in jd.companyContext. When a question uses such a fact, list its cc ids in "companyContextIds".
4. Do not name the company in any question except bank questions and the core "why this company" question.

## Resume claims
5. The resume phase asks exactly one question about each claim in interview.resumeClaimIds, in that order. These are already chosen and prioritized; do not substitute others. Across resume + technical phases, at least 40% of questions must target claims.
6. A technical question may also target a claim not in resumeClaimIds. Never ask two questions about the same claim or the same underlying fact.
7. Open a claim at the first rung of its probeLadder. "followUps.strongDeeper" is the next rung.
7b. A claim question tests the claim as written. Never presuppose work the resume doesn't state: if the resume says "92% accuracy", ask how that was measured, not how the model was deployed. Name the resume item in the question ("On your stock price predictor, ...") so it makes sense on its own when heard aloud.

## Technical coverage
8. Technical-phase questions ref a jd_skill (or a bank entry) and must actually test that skill. Set "topic" to the roleFamily topic id that matches what the question asks; if none matches, use the jd skill id as the topic.
9. If gap is non-empty, at least one technical question targets a gap skill. Ask it neutrally; do not reveal that the resume lacks it. Pitch it at someone who has not used the tool: how it works, when you would use it, how it compares to what they know. One skill per question; never combine two skills or turn a gap into a design task.
10. No two questions share a topic, except retestTopics on a retake.
11. For software roles, if the JD asks for fundamentals (data structures and algorithms, DBMS, operating systems, networks), at least one technical question covers them.

## Role-family blueprints (apply in addition to the rules above)
12a. For the "sde" family: the technical phase must include at least one DSA/algorithmic reasoning question and one project architecture or systems question, if the JD mentions these.
12b. For the "data" or "consultant" family: the technical phase must include at least one SQL question and at least one case-study or guesstimate question (topic "data.case" or "consultant.case" or "consultant.guesstimate"), unless the JD explicitly excludes them. Consulting/analyst interviews without case questions are incomplete regardless of JD wording.
12c. For any role: do not fill the technical phase exclusively with resume deep-dives. At least half the technical questions must test skills from the JD (SQL, Python, Excel, case, etc.), not just projects already covered in the resume phase.

## No technical phase
If roleFamily is null, this role family has no topic sheet and the interview has no technical phase. The extra resume-phase questions carry the technical depth instead: ask how the student applied their field's knowledge in their own projects and internships (the calculations, design choices, tools, and trade-offs they made), not textbook theory. Set "topic" to the claim id.

## Expected points
12. Give 3-5 expected points per question (2-5 for intro and closing). Each must be concrete and checkable in a spoken answer.
    Good: "Explains that a composite index on (user_id, created_at) serves the filter and the sort."
    Bad: "Shows good understanding of indexing."
13. For claim questions, expected points describe what someone who genuinely did the work could say (method, numbers, trade-offs, what broke), not a restatement of the resume.
14. Weight each point 1-3 by importance.

## Follow-ups (one spoken sentence each)
15. shallow: asks for the mechanism or a specific example ("Walk me through what actually happens when…").
16. wrong: politely challenges with a concrete scenario, without giving the answer ("What would happen if two requests hit that at the same time?"). For behavioral questions, "wrong" handles a generic or hypothetical answer instead: ask for the specific real situation and what they personally did.
17. strongDeeper: a harder extension, or the next probeLadder rung for claims.
18. Follow-ups follow the same spoken rules as questions: no code, no "show me", no "write".
19. Every resume, technical and behavioral question needs all three follow-ups, non-empty. For behavioral questions, strongDeeper probes further into the same story ("What would you do differently now?", "How did the other person react?"). Only intro and closing are different: they need at most "shallow" (or "" if none fits), with "wrong" and "strongDeeper" set to "".

## Flow and style
20. Phases run in order: intro → resume → technical → behavioral → closing. Produce exactly the count given per phase.
21. Difficulty is 1-5. Ramp from 2 at the start to 4 in late technical, then ease for behavioral. Intern/fresher: technical peaks at 4; experienced: may reach 5.
22. Questions are spoken aloud: at most 35 words, no code, no bullet lists, at most two parts, answerable in 1-3 minutes.
23. intro is core.intro. closing is core.questions_for_us.

## Retake
24. If retake is present, include at least one question for each retestTopic (up to 3), using a different angle. Claims in retestClaimIds were defended weakly last time; open them at a later probeLadder rung than the first. Do not repeat or lightly rephrase any previousQuestions.

## Output
Return only JSON:
{
  "questions": [
    {
      "qid": "q1",
      "phase": "intro|resume|technical|behavioral|closing",
      "ref": { "type": "bank|claim|jd_skill|core", "id": "..." },
      "companyContextIds": [],
      "topic": "roleFamily or core topic id",
      "intent": "one line: what this tests",
      "difficulty": 1,
      "text": "the question as spoken",
      "expectedPoints": [ { "id": "p1", "point": "...", "weight": 2 } ],
      "followUps": { "shallow": "...", "wrong": "...", "strongDeeper": "..." }
    }
  ]
}`;

const CRITIC_SYSTEM = `You review a mock interview question plan written by another model. You do not rewrite it. You list concrete problems.

Check each question against:
A. Realism: would an experienced interviewer for this role and seniority actually ask this? Flag textbook trivia, quiz-style definitions and anything no real interviewer says.
B. Grounding: does the question stay within its ref? Does any non-bank question imply facts about the company that are not in jd.companyContext?
C. Claims: do claim questions test whether the candidate really did the work, or can they be answered by rereading the resume?
D. Expected points: concrete and checkable in speech? Vague points ("good understanding") are a problem.
E. Follow-ups: does "wrong" give away the answer? Is "strongDeeper" actually harder?
F. Plan level: duplicate topics, missing gap coverage, a broken difficulty ramp, questions too long to say aloud. The plan has a fixed number of slots; do not ask for more topics to be covered than the slots allow.
G. Fit: does each question actually test the skill or claim in its ref, and does its topic label match what it asks? A question that mixes two skills is a problem.
H. Blueprint: for data/consultant roles, does the plan include at least one case/guesstimate question? For any role, does the technical phase test at least half its slots on JD skills rather than resume claims already covered by the resume phase?

Return only JSON:
{ "pass": true|false, "issues": [ { "qid": "q3", "check": "A-G", "problem": "...", "fix": "..." } ] }
Set pass to false if any issue is in A, B, C, G or H. Do not report stylistic preferences.`;

const RISK_RANK = { high: 0, medium: 1, low: 2 };
const TYPE_RANK = { skill_listed: 0, metric: 1, ownership: 2, tech_choice: 3, outcome: 4 };

// Which claims the resume phase asks about, riskiest first. Done in code so
// the model doesn't have to count slots or rank risk.
// On a retake, claims the student defended weakly last time come first.
export function selectResumeClaims(claims, slots, priorityIds = []) {
  const priority = id => (priorityIds.includes(id) ? priorityIds.indexOf(id) : Infinity);
  return claims
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (priority(a.c.id) - priority(b.c.id) || 0)
      || (RISK_RANK[a.c.defensibilityRisk] - RISK_RANK[b.c.defensibilityRisk])
      || ((TYPE_RANK[a.c.type] ?? 9) - (TYPE_RANK[b.c.type] ?? 9))
      || (a.i - b.i))
    .slice(0, slots)
    .map(({ c }) => c.id);
}

export function buildPlannerInput({ interview, roleFamilySheet, coreTopics, bankCandidates, bankSlots, retake }) {
  const { parsed, seniority, roleFamily } = interview;
  const supported = roleFamily && roleFamily !== 'unsupported';
  const perPhase = interviewComposition(roleFamily, parsed.resume.claims.length);
  // Spans, risk reasons and the raw skills list only matter for parsing; leaving
  // them out keeps every prep request under the per-request token cap.
  const skill = s => ({ id: s.id, name: s.name });
  return {
    interview: {
      seniority,
      perPhase,
      resumeClaimIds: selectResumeClaims(parsed.resume.claims, perPhase.resume, retake?.retestClaimIds)
    },
    roleFamily: supported ? roleFamilySheet : null,
    coreTopics,
    jd: {
      requiredSkills  : parsed.jd.requiredSkills.map(skill),
      niceToHave      : parsed.jd.niceToHave.map(skill),
      responsibilities: parsed.jd.responsibilities,
      companyContext  : parsed.jd.companyContext.map(c => ({ id: c.id, fact: c.fact }))
    },
    resume: {
      projects: parsed.resume.projects.map(p => ({ id: p.id, name: p.name, kind: p.kind, tech: p.tech })),
      claims  : parsed.resume.claims.map(c => ({
        id               : c.id,
        claim            : c.claim,
        type             : c.type,
        projectId        : c.projectId,
        defensibilityRisk: c.defensibilityRisk,
        probeLadder      : c.probeLadder
      }))
    },
    gap   : { matches: [...parsed.gap.matches], gaps: [...parsed.gap.gaps] },
    bank  : {
      bankSlots,
      entries: bankCandidates.map(b => ({
        id          : b.planId,
        topic       : b.topic,
        roundType   : b.roundType,
        questionText: b.questionText
      }))
    },
    retake: retake || null
  };
}

export function buildPlannerMessages(plannerInput) {
  return [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: JSON.stringify(plannerInput) }
  ];
}

const outline = questions => questions.map(q => ({
  qid: q.qid, phase: q.phase, ref: q.ref, topic: q.topic, difficulty: q.difficulty, text: q.text
}));

// The critic gets only what it needs to judge realism and grounding, not the
// full planner input.
export function buildCriticMessages(plannerInput, plan) {
  const skills = [...plannerInput.jd.requiredSkills, ...plannerInput.jd.niceToHave];
  const context = {
    seniority     : plannerInput.interview.seniority,
    jdSkills      : skills.map(s => `${s.id} ${s.name}`),
    gapSkillIds   : plannerInput.gap.gaps,
    companyContext: plannerInput.jd.companyContext,
    claims        : plannerInput.resume.claims.map(c => `${c.id} [${c.defensibilityRisk}] ${c.claim}`)
  };
  const questions = (plan?.questions || []).map(q => ({
    ...outline([q])[0],
    expectedPoints: (q.expectedPoints || []).map(p => p.point),
    followUps     : q.followUps
  }));
  return [
    { role: 'system', content: CRITIC_SYSTEM },
    { role: 'user', content: JSON.stringify({ context, plan: questions }) }
  ];
}

// Revisions see the plan as a one-line-per-question outline and return only
// the questions they change, add or remove. mergeRevision applies them.
export function buildReviseMessages(plannerInput, plan, issues) {
  return [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: JSON.stringify(plannerInput) },
    {
      role: 'user',
      content: `Current plan outline:\n${JSON.stringify(outline(plan?.questions || []))}\n\n`
        + `Fix every issue below by changing as few questions as possible.\n${JSON.stringify(issues)}\n\n`
        + 'Return only JSON: { "questions": [ full question objects, in the output format above, for every question you change or add ], "remove": [ qids to delete ] }. '
        + 'A changed question keeps its qid; a new question gets a qid not in the outline.'
    }
  ];
}

const PHASE_ORDER = ['intro', 'resume', 'technical', 'behavioral', 'closing'];

export function mergeRevision(plan, revision) {
  const removed = new Set(revision?.remove || []);
  const byQid = new Map((plan?.questions || []).filter(q => !removed.has(q.qid)).map(q => [q.qid, q]));
  // Revisions sometimes return only the changed fields of a question; overlay
  // them so the untouched fields survive.
  // Blank values never overwrite: a revision's "" or null means "not sent".
  const filled = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null));
  for (const q of revision?.questions || []) {
    if (!q?.qid) continue;
    const before = byQid.get(q.qid) || {};
    byQid.set(q.qid, {
      ...before,
      ...filled(q),
      ref      : { ...before.ref, ...filled(q.ref) },
      followUps: { ...before.followUps, ...filled(q.followUps) }
    });
  }

  const position = new Map((plan?.questions || []).map((q, i) => [q.qid, i]));
  const questions = [...byQid.values()].sort((a, b) =>
    (PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
    || ((position.get(a.qid) ?? Infinity) - (position.get(b.qid) ?? Infinity))
  );
  return { questions };
}
