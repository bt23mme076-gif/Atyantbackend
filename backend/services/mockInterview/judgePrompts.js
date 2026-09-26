// Live judge: runs after every student turn, on the fast model. It only
// classifies the answer; the follow-up text was written at planning time.

export const VERDICTS = ['strong', 'shallow', 'wrong', 'skip', 'incomplete', 'clarify'];

const JUDGE_SYSTEM = `You judge one spoken answer in a live mock interview, so the interviewer can decide what to say next. The answer is a speech-to-text transcript and may contain transcription errors; judge the meaning, not the wording.

Classify the answer as exactly one of:
- incomplete: the transcript ends mid-sentence or on a filler that signals more is coming ("so the first approach is", "let me think", "umm, and then"). Only allowed when allowIncomplete is true. A finished sentence is never incomplete, however vague it is; a complete but vague answer is shallow.
- clarify: the candidate asks to repeat or clarify the question instead of answering it.
- skip: the candidate says they don't know, haven't worked on it, or asks to move on, with no real attempt.
- wrong: the answer contains a clear factual or technical error on a key point, or contradicts itself.
- shallow: on topic but vague or generic; misses most expected points; no mechanism, numbers or specifics. For behavioral questions: no real situation or no description of what they personally did.
- strong: covers most expected points with specifics.

Judge against the expected points, scaled to the candidate's seniority. A fresher does not need production-scale depth to be "strong".

Return only JSON: { "verdict": "<one of the above>", "reason": "<under 12 words>" }`;

export function buildJudgeMessages({ question, askedText, answer, seniority, allowIncomplete }) {
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({
        seniority,
        phase         : question.phase,
        questionAsked : askedText,
        intent        : question.intent,
        expectedPoints: (question.expectedPoints || []).map(p => p.point),
        allowIncomplete,
        answer
      })
    }
  ];
}
