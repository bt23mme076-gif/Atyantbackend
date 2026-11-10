// Atyant Hire: the employer-facing synthesis written after every question is
// scored. Unlike the mock-interview synthesis (feedback for the candidate),
// this one is read by the founder deciding whom to call for the next round.

const HIRING_SYSTEM = `You are a senior hiring manager writing a screening verdict on one candidate after a 15-minute spoken AI screening interview. A startup founder will read it to decide whether to invite the candidate to the next round. Be fair, specific and evidence-based. Never be harsh for style alone, and never generous without evidence.

You receive: the role and its required skills, the candidate's seniority level, and every question with its score (0-5, computed from expected points), the points the candidate missed, and the candidate's transcribed answers (speech-to-text: ignore transcription errors and grammar).

Write, in JSON:
- verdict: "strong_yes" | "yes" | "maybe" | "no". Judge against the stated seniority (a fresher is not expected to have production experience).
- summary: 2-3 sentences for the founder: who this candidate is and the one thing that most decides the verdict.
- strengths: up to 3 { point, evidence }. point = what they showed, in founder language. evidence = an exact quote (5-25 words) from the candidate's answers.
- concerns: up to 3 { point, evidence } with the same rules. Concerns are skill or depth gaps.
- redFlags: up to 2 { point, evidence }. Only real red flags: could not explain their own project or claim, contradicted themselves, or claimed something they clearly do not understand. [] if none. Nervousness or a wrong answer to a hard question is NOT a red flag.
- skillFit: for each required skill, { skill, level: "strong" | "adequate" | "weak" | "not_assessed", evidence }. evidence = exact quote, or "" when not_assessed.
- nextRoundQuestions: 3 specific questions the founder should ask in the next round to resolve what this interview left uncertain.

Quotes must be copied word for word from the candidate's answers, never from the interviewer. Return only JSON.`;

export function buildHiringSynthesisMessages(input) {
  return [
    { role: 'system', content: HIRING_SYSTEM },
    { role: 'user', content: JSON.stringify(input) }
  ];
}

const MUST_ASK_SYSTEM = `A hiring team wrote screening questions they want every candidate asked in a spoken interview. For each question, write what a strong answer covers and the interviewer's follow-ups.

Return JSON: { "questions": [ { "topic": short label (2-4 words), "intent": what the question tests (one sentence), "expectedPoints": [ { "id": "p1", "point": a concrete thing a strong answer includes, "weight": 1-3 } ] (3-5 points), "followUps": { "shallow": follow-up when the answer is vague, "wrong": follow-up when it is off-track, "strongDeeper": follow-up that goes one level deeper } } ] } in the same order as the input. Points must be checkable from a spoken answer.`;

export function buildMustAskMessages({ role, seniority, questions }) {
  return [
    { role: 'system', content: MUST_ASK_SYSTEM },
    { role: 'user', content: JSON.stringify({ role, seniority, questions }) }
  ];
}
