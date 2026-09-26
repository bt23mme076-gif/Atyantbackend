// Post-interview evaluation prompts (strongest model, off the live path).
//   1. Answer evaluation, once per planned question (its follow-ups included):
//      per-point hits with evidence quotes, plus communication and confidence.
//      The 0-5 score is computed from the hits in code, not chosen by the model.
//   2. Synthesis: summary, strengths, improvements and prep path from the
//      scored questions.

const ANSWER_SYSTEM = `You grade one question from a spoken mock interview. You receive the planned question, what it tests, the expected points of a strong answer, and the exchange: the interviewer's question, any follow-ups, and the candidate's answers as speech-to-text transcripts (expect transcription errors; grade meaning, not wording).

## Expected points
For each expected point, decide:
- "full": the candidate clearly made this point, anywhere in the exchange, including in answers to follow-ups.
- "partial": they touched it but vaguely, incompletely, or only after heavy prompting.
- "none": not made, or stated incorrectly.
"evidence" is a short exact quote (5-25 words) from the candidate's answers that shows the point. Copy it word for word from the transcript. For "none", evidence is "".
Grade against the candidate's seniority: a fresher does not need production-scale depth for "full".
Never give credit for what the interviewer said.

## Ratings (1-5), from the transcript only
communication:
  5 = leads with the answer, then reasoning or an example; concise; easy to follow
  3 = understandable but rambling, unordered, or padded
  1 = fragmented or hard to follow
confidence:
  5 = direct, commits to answers, owns decisions, stays steady when challenged
  3 = noticeable hedging ("I think maybe", "not sure but"), backs off under a follow-up
  1 = mostly hedging, gives up, or says "I don't know" without attempting

## Feedback (address the candidate as "you")
- whatWentWell: one sentence on the strongest part of the answer; "" if nothing was.
- missing: the expected points they missed, rewritten as short actionable phrases.
- feedback: 2-3 sentences on how to improve this answer. Specific to what they said, never generic advice. Refer to the company by name, never as "our company".
- sampleAnswer: a strong spoken answer to the planned question, 80-150 words, in first person, as a well-prepared candidate at this seniority would say it.
  For questions about the candidate's own resume or experience, use only facts from their answers and the claim. Where a real answer needs a fact they didn't give or a tool they didn't use, write a bracketed placeholder instead of inventing it.
    Candidate said: "I checked it in Postman a few times."
    Wrong: "I measured it with JMeter at 100 concurrent users."
    Right: "I measured it with [a load-testing tool such as k6] at [N] concurrent requests, comparing p95 latency."
  Never invent their numbers, tools, employers, or results.

Return only JSON:
{
  "points": [ { "id": "p1", "hit": "full|partial|none", "evidence": "..." } ],
  "communication": 1,
  "confidence": 1,
  "whatWentWell": "...",
  "missing": [ "..." ],
  "feedback": "...",
  "sampleAnswer": "..."
}`;

const SYNTHESIS_SYSTEM = `You write the summary section of a mock interview report for a student. You receive every question with its score (0-5), what it tested, the points the student missed, and dimension scores (0-100). The per-question grading is final; do not re-grade.

Write, addressing the student as "you":
- summary: 3-4 sentences. The overall picture: where you stood, what held you back most, and what would change the result fastest. Plain and honest, not motivational.
- strengths: 2-3 specific strengths, each tied to what they actually did well in named questions.
- improvements: 2-3 specific improvements, most impactful first.
- prepPath: 3-6 study items for before the real interview, ordered by impact. Each has:
  topic (short name), why (which answers showed the gap), action (a concrete thing to practice or study, not "revise the basics"), basedOn (the qids it comes from).
  Prioritize: skipped or wrong answers on required skills, then weakly defended resume claims, then shallow answers.

Only use what is in the input. Do not invent questions, scores, or facts about the student or the company.
Never advise the student to prepare a made-up or "mock" answer about their own work. When they couldn't defend a resume claim, the action is to go back and get the real facts (numbers, method, their own part), or to reword or remove the claim if they can't back it up.
Refer to the company by name if needed, never as "our company" or "we": you are writing feedback, not interviewing.

Return only JSON:
{ "summary": "...", "strengths": ["..."], "improvements": ["..."], "prepPath": [ { "topic": "...", "why": "...", "action": "...", "basedOn": ["q3"] } ] }`;

const REPAIR_SYSTEM = `You edit a sample interview answer written for a student. Some sentences state numbers about the student's own work that the student never said; each comes with its inventedValues. In those sentences, replace only the phrase containing each invented value with a short bracketed placeholder saying what the student should fill in, for example "a TTL of [your TTL]" or "with [the load-testing tool you used]". Keep the rest of each sentence, keep every other sentence exactly as it is, and keep numbers that are not listed.

Return only JSON: { "sampleAnswer": "..." }`;

export function buildSampleRepairMessages({ sampleAnswer, inventedFacts }) {
  return [
    { role: 'system', content: REPAIR_SYSTEM },
    { role: 'user', content: JSON.stringify({ sampleAnswer, inventedFacts }) }
  ];
}

export function buildAnswerEvalMessages({ question, exchange, seniority, claim }) {
  return [
    { role: 'system', content: ANSWER_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({
        seniority,
        phase         : question.phase,
        plannedQuestion: question.text,
        intent        : question.intent,
        resumeClaim   : claim ? claim.claim : undefined,
        expectedPoints: question.expectedPoints.map(p => ({ id: p.id, point: p.point })),
        exchange
      })
    }
  ];
}

export function buildSynthesisMessages(input) {
  return [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    { role: 'user', content: JSON.stringify(input) }
  ];
}
