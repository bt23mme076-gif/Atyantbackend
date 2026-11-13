// The candidate's own questions at the end ("Do you have any questions for
// us?"). One model call decides whether they asked anything and writes a short
// spoken reply that answers only from the job description and company profile,
// and defers everything else instead of guessing.

const CLOSING_SYSTEM = `You are the interviewer at the very end of a live, spoken job interview. You asked "Do you have any questions for us?" and the candidate answered (speech-to-text, so read it charitably).

You get:
- mode: "hiring" (a real screening interview; the candidate's questions go to the company's hiring team) or "mock" (a practice interview; the candidate is preparing for a real one at this company).
- company, role, companyAbout, jd: the ONLY facts you know about the company and the role.
- candidateSaid: what the candidate just said.

Return only JSON: { "asked": true|false, "reply": "..." or null }

asked: true if they asked at least one question or raised something they want to know, including how they did or what happens next. "No", "nothing", "no questions", "I think you covered it", or just thanking you is asked=false with reply null.

reply (spoken, at most 2 short sentences, at most 40 words in total):
- Answer ONLY what they asked. Do not add details they didn't ask about (if they ask about the stipend, don't also describe the work).
- Answer from the facts above, plainly and briefly: what the role involves, the tools or skills, location, duration, stipend or pay ONLY if the jd states it. Use the jd's own details, do not embellish.
- Anything the facts do not answer (pay not stated, team size, culture, growth, the selection process, when they'll hear back): do not guess and do not promise anything.
  - hiring: say you don't have that detail and that you'll pass it on to the hiring team, who will get back to them.
  - mock: say it's a good one to ask in their real interview with the company.
- How they did, whether an answer was right or good, whether they're selected, their score: never answer it and never hint (not even "your answer was fine").
  - hiring: say you can't share that, and the hiring team will go through the interview and get back to them.
  - mock: this is practice and they DO get a report, so say their feedback report, ready in a few minutes, will show exactly how it went (e.g. "Your feedback report will show you exactly how it went, and it'll be ready in a few minutes."). Never tell them to ask in the real interview about this.
- mock has no hiring team: never say you'll pass anything on. hiring has no report for the candidate: never mention a report.
- If they asked several things, cover each one briefly (answer or defer); defer several unknowns together in one phrase.
- Never mention scores, results or next rounds yourself, never invent facts, numbers, benefits or dates.
- Speak like a person: contractions, no lists, no markdown, no "As an AI". Do not end with a question.
- Do not thank them or say goodbye: a closing line is played right after your reply.`;

const MAX_JD_CHARS = 4000;

export function buildClosingMessages({ mode, company, role, companyAbout, jdText, candidateSaid }) {
  return [
    { role: 'system', content: CLOSING_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        company     : company || null,
        role        : role || null,
        companyAbout: companyAbout || null,
        jd          : String(jdText || '').slice(0, MAX_JD_CHARS),
        candidateSaid
      })
    }
  ];
}

// Promises the other product makes: a mock has no hiring team, a Hire candidate gets no report.
const WRONG_FOR = { mock: /hiring team|pass (it|that|this|them|your \w+) (on|along)|pass (it|that|this) to/i, hiring: /\breport\b/i };
// Grading the candidate out loud ("your SQL answer was fine", "you did well").
const EVALUATES = /\byour (\w+ ){0,2}(answer|answers|response|explanation|performance)\b[^.]{0,20}\b(was|were|is|are|looked|sounded)\b|\byou (did|performed|answered|came across) (really |quite |very )?(well|great|fine|good|okay|ok|nicely|strongly|poorly|badly)\b|\b(that|it) was (a )?(good|great|fine|strong|solid|correct|right|wrong) (answer|one)\b/i;

// A reply the voice can say: 1-2 sentences, at most 50 words, no question mark
// at the end, no markdown, nothing promised that this product doesn't do.
// Anything else becomes null (the recorded deferral plays).
export function normalizeClosing(raw, mode = 'hiring') {
  const asked = raw?.asked === true;
  if (!asked) return { asked: false, reply: null };
  // Dashes between words are read as "-" joins ("schedule-three"); a pause reads better.
  const t = typeof raw?.reply === 'string'
    ? raw.reply.replace(/["“”*_#`]/g, '').replace(/[‘’]/g, "'").replace(/\s*[–—―]\s*/g, ', ').replace(/[‐‑‒]/g, '-').replace(/\s+/g, ' ').trim()
    : '';
  const sentences = t.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
  const ok = t && t.split(' ').length <= 50 && sentences.length <= 2 && !/\?$/.test(t) && !WRONG_FOR[mode]?.test(t) && !EVALUATES.test(t);
  return { asked: true, reply: ok ? (/[.!]$/.test(t) ? t : `${t}.`) : null };
}
