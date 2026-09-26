import { keepsSpecifics } from './directorPrompts.js';

// Decides what the interviewer says next. Pure logic: no LiveKit, no DB.
// The agent feeds it student turns and silences, speaks whatever `say` it
// returns, and persists any `turn` it returns.
//
// The order of planned questions, the time budget and the follow-up limits live
// here. The words of each reaction and follow-up come from `judge` (see
// directorPrompts.js), which reads what the candidate actually said. If the
// judge is unavailable the interview keeps going with the follow-ups that were
// written at planning time.

const TRIGGER_BY_VERDICT = { strong: 'strongDeeper', shallow: 'shallow', wrong: 'wrong', skip: 'shallow' };

// Only used when the judge gives no reaction of its own.
const ACKS      = ['Okay.', 'Right.', 'Mm-hm.', 'I see.', 'Okay, noted.'];
const SKIP_ACKS = ['No worries.', 'Fair enough.', "That's fine."];
const CONTINUES = ['Mm-hm, go on.', 'Take your time.', 'Okay, go ahead.'];

// An answer that trails off ("It is a...", "so the first thing is") is a
// thinking pause, not the end. A person would just nod and wait.
const DANGLING = /(\.\.\.|…|\b(a|an|the|and|so|but|or|is|are|was|to|of|with|for|in|on|that|because|like|um+|uh+|actually|basically),?)$/i;
const looksUnfinished = text => DANGLING.test(String(text || '').trim());

const TRANSITIONS = {
  resume    : "Let's look at some of the work on your resume.",
  technical : 'Now a few technical questions.',
  behavioral: "Let's switch to a couple of situational questions.",
  closing   : "We're near the end."
};

const MAX_CLARIFY     = 2;
const MAX_CONTINUE    = 2;
const MAX_NOT_HEARD   = 2;
const WRAP_UP_MS      = 3 * 60 * 1000;
const MIN_PER_QUESTION_MS = 2 * 60 * 1000;

const STOPWORDS = new Set(['about', 'their', 'there', 'which', 'would', 'could', 'should', 'these', 'those', 'where', 'while', 'being', 'using', 'other', 'explains', 'explain', 'mentions', 'states', 'describes', 'covers', 'gives', 'names']);
// Whisper "hears" these over silence or background noise. An utterance made of
// nothing else is not an answer, so it is ignored rather than judged.
const PHANTOM = /^(thank you( so much| very much)?|thanks( for watching)?|you|bye)$/;
const isPhantom = text => {
  const parts = String(text || '').toLowerCase().split(/[.!?,]+/).map(x => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(x => PHANTOM.test(x));
};

// Word overlap, to catch a follow-up that just re-asks something already asked.
const wordSet = text => new Set((String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2));
const overlap = (a, b) => {
  const x = wordSet(a); const y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let shared = 0; for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
};
const REPEAT_OVERLAP = 0.7;

// The candidate explicitly asking for a different question is respected in code,
// whatever the judge says.
const WANTS_NEXT = /\b(ask|give|try)( me)? (another|a different|some other|the next|one more) question\b|\bmove on\b|\bnext question,? please\b|\b(can|could|may) (we|i) skip\b|\bskip (this|that)( one| question)\b|\bask( me)? something else\b/i;

// When the judge gives no line of its own for a misheard answer.
const NOT_HEARD = ["Sorry, I didn't catch that. Could you say it again?", 'You cut out for a second there. One more time?', 'Sorry, missed that. Say that again?'];

// A bridge follows the reaction, so a leading "okay" would double it up.
const tidyBridge = text => {
  const t = String(text || '').replace(/^(okay|ok|alright|all right|right|so|sure|got it|mm-?hm|mm)[,.!]?\s+/i, '').trim();
  if (!t || /moving on|switching topics|next topic|let's move on/i.test(t)) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const words = text => (String(text || '').toLowerCase().match(/[a-z]{5,}/g) || []).filter(w => !STOPWORDS.has(w));

export class InterviewController {
  constructor({ questions, judge, seniority = 'fresher', candidateName = '', role = '', company = '',
    durationMs = 30 * 60 * 1000, now = Date.now }) {
    if (!questions?.length) throw new Error('Interview has no planned questions');
    this.questions  = questions;
    this.judge      = judge;
    this.seniority  = seniority;
    this.candidateName = candidateName;
    this.role       = role;
    this.company    = company;
    this.durationMs = durationMs;
    this.now        = now;
    this.finished   = false;
    this.ackCount   = 0;
    this.continueCount = 0;
    this.recentReactions = [];
    // Consecutive answers the candidate couldn't give; the interviewer eases off as it grows.
    this.struggleStreak = 0;
  }

  get current() { return this.questions[this.index]; }

  opening() {
    this.startedAt = this.now();
    this.endsAt = this.startedAt + this.durationMs;
    const first = (this.candidateName || '').trim().split(/\s+/)[0];
    const forRole = this.role ? ` for the ${this.role} role${this.company ? ` at ${this.company}` : ''}` : '';
    const minutes = Math.round(this.durationMs / 60000);
    const intro = `Hi${first ? ` ${first}` : ''}, thanks for making the time. I'll be your interviewer today${forRole}. `
      + `We have about ${minutes} minutes. I'll ask about you, a few of your projects and some technical things. `
      + `Keep it conversational, and feel free to think out loud. So, to start.`;
    return `${intro} ${this.#ask(0).text}`;
  }

  // After an agent restart mid-interview: continue at `index`, keeping the
  // original time budget.
  resume(index, startedAt) {
    this.startedAt = startedAt.getTime();
    this.endsAt = this.startedAt + this.durationMs;
    return `Welcome back. Let's continue where we left off. ${this.#ask(index).text}`;
  }

  // The student dropped and reconnected: they may have missed the question.
  welcomeBack() {
    this.asking.parts = [];
    return `Welcome back. ${this.asking.text}`;
  }

  // One finished student turn (end of speech detected).
  async onAnswer(text) {
    if (this.finished) return { say: null, end: true, turn: null };
    const clean = (text || '').trim();
    // Noise transcribed as "thank you": say nothing and keep listening.
    if (isPhantom(clean)) return { say: null, end: false, turn: null };

    if (clean.split(/\s+/).filter(Boolean).length < 2 && !/\b(no|skip|pass)\b/i.test(clean)) {
      if (this.asking.notHeard++ < MAX_NOT_HEARD) {
        return { say: "Sorry, I didn't catch that. Could you say that again?", end: false, turn: null };
      }
    }
    this.asking.parts.push(clean);

    if (this.current.phase === 'closing') return this.#finishClosing();

    if (looksUnfinished(clean) && this.asking.continues < MAX_CONTINUE) {
      this.asking.continues++;
      return { say: CONTINUES[this.continueCount++ % CONTINUES.length], end: false, turn: null };
    }

    let d = await this.#direct(this.asking.continues < MAX_CONTINUE);
    if (WANTS_NEXT.test(clean)) {
      // They asked for another question: no easier follow-up on this one.
      d = { ...(d || {}), verdict: 'skip', followUp: null, reaction: d?.reaction || "Sure, let's try something else." };
    }
    // "What do you mean?" is short. A long answer labelled clarify is a
    // misjudgement; asking the same question again would sound broken.
    if (d?.verdict === 'clarify' && clean.split(/\s+/).length > 20 && !clean.includes('?')) {
      d = { ...d, verdict: 'shallow', rephrase: null };
    }
    const verdict = d?.verdict;

    if (verdict === 'incomplete') {
      this.asking.continues++;
      return { say: CONTINUES[this.continueCount++ % CONTINUES.length], end: false, turn: null };
    }
    if (verdict === 'clarify') {
      this.asking.parts = [];
      if (this.asking.clarifies++ < MAX_CLARIFY) {
        return { say: d.rephrase || `Sure. ${this.asking.text}`, end: false, turn: null };
      }
      return this.#respond({ verdict: 'skip' });
    }
    if (verdict === 'garbled') {
      // Probably misheard: drop it and ask again, but never loop on it.
      this.asking.parts.pop();
      if (this.asking.notHeard++ < MAX_NOT_HEARD) {
        const say = d.reaction ? `${d.reaction} Could you say it again?` : NOT_HEARD[this.continueCount++ % NOT_HEARD.length];
        return { say, end: false, turn: null };
      }
      return this.#respond({ verdict: 'skip' });
    }
    return this.#respond(d);
  }

  // The student has been silent for the session's away timeout.
  async onSilence() {
    if (this.finished) return { say: null, end: true, turn: null };
    if (this.asking.parts.length) {
      if (this.current.phase === 'closing') return this.#finishClosing();
      const d = await this.#direct(false);
      return this.#respond(['clarify', 'garbled', 'incomplete'].includes(d?.verdict) ? { verdict: 'skip' } : d);
    }
    if (this.asking.silences++ === 0) {
      return { say: "Take your time. Let me know if you'd like me to repeat the question.", end: false, turn: null };
    }
    if (this.current.phase === 'closing') return this.#finishClosing();
    return this.#respond({ verdict: 'skip' }, "Let's move on for now.");
  }

  onTimeUp() {
    const turn = this.asking?.parts.length ? this.#record(null) : null;
    this.finished = true;
    return {
      say: "We're out of time, so let's stop here. Thank you. Your feedback report will be ready in a few minutes.",
      end: true,
      turn
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  // Asks the planned question at `index`, or a follow-up ({ text, trigger })
  // on the current one.
  #ask(index, followUp = null) {
    const q = this.questions[index];
    const same = index === this.index && this.asking;
    this.index = index;
    this.asking = {
      text     : followUp ? followUp.text : q.text,
      kind     : followUp ? 'follow_up' : 'planned',
      trigger  : followUp ? followUp.trigger : null,
      askedAt  : new Date(this.now()),
      parts    : [],
      continues: 0,
      clarifies: 0,
      silences : 0,
      notHeard : 0,
      usedTriggers : same ? this.asking.usedTriggers : new Set(),
      followUpsUsed: same ? this.asking.followUpsUsed : 0,
      // What was already said on this question, so follow-ups build on it.
      history  : same ? [...this.asking.history, { interviewer: this.asking.text, candidate: this.asking.parts.join(' ') }] : []
    };
    return this.asking;
  }

  // Asks the judge what to say about the current answer. Returns
  // { verdict, reaction, followUp, rephrase } or null when the judge is down.
  // Which planned question comes next if the interview moves on now.
  #nextIndex() {
    const closing = this.#closingIndex();
    if (this.#remainingMs() < WRAP_UP_MS && closing > this.index) return closing;
    return this.index + 1;
  }

  async #direct(allowIncomplete) {
    this.plannedNext = this.#nextIndex();
    try {
      const out = await this.judge({
        question       : this.current,
        askedText      : this.asking.text,
        answer         : this.asking.parts.join(' '),
        seniority      : this.seniority,
        role           : this.role,
        company        : this.company,
        allowIncomplete,
        allowFollowUp  : this.#canFollowUp(this.current),
        isFollowUp     : this.asking.kind === 'follow_up',
        history        : this.asking.history,
        priorReactions : this.recentReactions.slice(-5),
        candidateFirstName: (this.candidateName || '').trim().split(/\s+/)[0] || null,
        struggleStreak : this.struggleStreak,
        nextQuestion   : this.questions[this.plannedNext] || null
      });
      // A judge that only returns a verdict string still works.
      const d = typeof out === 'string' ? { verdict: out, reaction: '', followUp: null, rephrase: null } : out;
      if (!d?.verdict) return null;
      if (!allowIncomplete && d.verdict === 'incomplete') return { ...d, verdict: 'shallow' };
      return d;
    } catch {
      return null; // judge unavailable: record the answer and move on
    }
  }

  #record(verdict) {
    return {
      qid       : this.current.qid,
      kind      : this.asking.kind,
      trigger   : this.asking.trigger,
      text      : this.asking.text,
      answer    : this.asking.parts.join(' '),
      verdict   : ['strong', 'shallow', 'wrong', 'skip'].includes(verdict) ? verdict : null,
      askedAt   : this.asking.askedAt,
      answeredAt: new Date(this.now())
    };
  }

  #remainingMs() { return this.endsAt - this.now(); }

  #closingIndex() { return this.questions.findIndex(q => q.phase === 'closing'); }

  // Whether another follow-up fits: per-question limit, and enough time left
  // for the rest of the interview.
  #canFollowUp(q) {
    if (q.phase === 'closing') return false;
    if (this.asking.followUpsUsed >= (q.maxFollowUps ?? 2)) return false;
    const remaining = this.#remainingMs();
    if (remaining < WRAP_UP_MS) return false;
    const questionsLeft = this.questions.length - this.index;
    return remaining / questionsLeft >= MIN_PER_QUESTION_MS;
  }

  // A follow-up that already says the concepts a strong answer would contain
  // gives the answer away.
  #leaks(followUp) {
    const known = new Set([...words(this.asking.text), ...words(this.asking.parts.join(' '))]);
    const guard = new Set(words((this.current.expectedPoints || []).map(p => p.point).join(' ')));
    // One shared word ("model", "users") is normal; naming several is giving it away.
    return new Set(words(followUp).filter(w => guard.has(w) && !known.has(w))).size >= 2;
  }

  #stockAck(verdict) {
    const pool = verdict === 'skip' ? SKIP_ACKS : ACKS;
    return pool[this.ackCount++ % pool.length];
  }

  #remember(reaction) {
    if (reaction) this.recentReactions.push(reaction);
    if (this.recentReactions.length > 8) this.recentReactions.shift();
  }

  // The answer is done: follow up on it, or move to the next planned question.
  #respond(d, leadIn = null) {
    const verdict = d?.verdict ?? null;
    const turn = this.#record(verdict);
    const q = this.current;
    const reaction = d?.reaction || '';
    if (verdict === 'skip') this.struggleStreak++;
    else if (verdict) this.struggleStreak = 0;

    if (this.#canFollowUp(q)) {
      const trigger = TRIGGER_BY_VERDICT[verdict];
      let text = null;
      const askedBefore = [this.asking.text, ...this.asking.history.map(h => h.interviewer)];
      if (d?.followUp && askedBefore.some(a => overlap(a, d.followUp) >= REPEAT_OVERLAP)) {
        // Asking the same thing again sounds like a machine; move on instead.
        d = { ...d, followUp: null };
      }
      if (d?.followUp) {
        // The judge wrote it from the candidate's own words. If it hints at the answer, fall back to the planned one.
        // An easier way in after "I don't know" naturally names the topic, so only real answers are checked.
        text = verdict !== 'skip' && this.#leaks(d.followUp) ? null : d.followUp;
      }
      // Planned follow-up only when the judge gave nothing usable, and never the same one twice.
      if (!text && trigger && !this.asking.usedTriggers.has(trigger)) text = q.followUps?.[trigger] || null;
      if (text && askedBefore.some(a => overlap(a, text) >= REPEAT_OVERLAP)) text = null;
      if (text && trigger) {
        this.asking.followUpsUsed++;
        this.asking.usedTriggers.add(trigger);
        this.#remember(reaction);
        const lead = reaction ? `${reaction} ` : '';
        return { say: `${lead}${this.#ask(this.index, { text, trigger }).text}`.trim(), end: false, turn };
      }
    }

    const nextIndex = this.#nextIndex();
    if (nextIndex >= this.questions.length) {
      this.finished = true;
      return { say: this.#closingLine(''), end: true, turn };
    }

    const nextQ = this.questions[nextIndex];
    const lead = leadIn || reaction || this.#stockAck(verdict);
    this.#remember(reaction);
    // The judge wrote its bridge and spoken wording for the question it expected
    // next; only use them if that is still the one being asked.
    const planned = d && this.plannedNext === nextIndex;
    const bridge = planned && d.bridge ? tidyBridge(d.bridge) : (!planned && nextQ.phase !== q.phase ? TRANSITIONS[nextQ.phase] || '' : '');
    this.#remember(bridge);
    const spoken = planned && keepsSpecifics(nextQ.text, d.nextQuestionSpoken) ? d.nextQuestionSpoken : nextQ.text;
    this.#ask(nextIndex);
    this.asking.text = spoken;
    return { say: `${lead} ${bridge} ${spoken}`.replace(/\s+/g, ' ').trim(), end: false, turn };
  }

  #finishClosing() {
    const turn = this.#record(null);
    this.finished = true;
    return { say: this.#closingLine(turn.answer), end: true, turn };
  }

  #closingLine(answer) {
    const askedSomething = answer.split(/\s+/).length > 6 && !/^(no|nope|nothing|not really)\b/i.test(answer.trim());
    return `${askedSomething ? 'Those are good questions to ask in your real interview. ' : ''}`
      + "Thank you, that's all from my side. Your feedback report will be ready in a few minutes. All the best!";
  }
}
