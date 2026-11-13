import {
  lib, REACTIONS, CONTINUES, REPEATS, SKIP_ACKS, TRANSITIONS, GREETING_KEY, questionKey, followUpKey, greetingText
} from '../voice/voiceLines.js';

// Decides what the interviewer says next. Pure logic: no LiveKit, no DB.
// The agent feeds it student turns and silences, speaks whatever it returns,
// and persists any `turn` it returns.
//
// Every reply is { say, segments, end, turn }. `segments` is what to play, in
// order: { key, text } is a pre-made clip (services/voice/voiceLines.js),
// { key: null, text, fallback? } is spoken live; `fallback` is what to play
// instead if the live line can't be spoken. `say` is the same words as text.
//
// The order of planned questions, the time budget and the follow-up limits live
// here. Planned questions and follow-ups are always spoken as planned (from
// their pre-made audio); only follow-ups and rephrasings built from what the
// candidate just said are spoken live. If the judge is unavailable the
// interview keeps going with the follow-ups written at planning time.

const TRIGGER_BY_VERDICT = { strong: 'strongDeeper', shallow: 'shallow', wrong: 'wrong', skip: 'shallow' };

// An answer that trails off ("It is a...", "so the first thing is") is a
// thinking pause, not the end. A person would just nod and wait.
const DANGLING = /(\.\.\.|…|\b(a|an|the|and|so|but|or|is|are|was|to|of|with|for|in|on|that|because|since|although|however|like|um+|uh+|actually|basically|essentially|so\s+basically|i\s+think),?)$/i;
const looksUnfinished = text => DANGLING.test(String(text || '').trim());

const MAX_CLARIFY     = 2;
const MAX_CONTINUE    = 3;
const MAX_NOT_HEARD   = 3;
// Pacing for the 15-minute mock interview: digs deep and may drop later questions.
const WRAP_UP_MS      = 3 * 60 * 1000;
const MIN_PER_QUESTION_MS = 90 * 1000;
// Hiring interviews (askAll) ask every planned question, because the founder
// chose them; timing scales with the founder-chosen length.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// How far the interviewer may dig into one topic. A real interview goes deep on
// a few things rather than skimming many, so this is more than the plan's default.
const DIG_DEPTH = { intro: 2, closing: 0 };
const DEFAULT_DIG_DEPTH = 4;

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

const words = text => (String(text || '').toLowerCase().match(/[a-z]{5,}/g) || []).filter(w => !STOPWORDS.has(w));

const live = (text, fallback = null) => ({ key: null, text, ...(fallback?.length ? { fallback } : {}) });

const reply = (segments, end = false, turn = null) => {
  const segs = segments.filter(Boolean);
  return { say: segs.length ? segs.map(s => s.text).join(' ') : null, segments: segs, end, turn };
};

export class InterviewController {
  constructor({ questions, judge, seniority = 'fresher', candidateName = '', role = '', company = '',
    durationMs = 30 * 60 * 1000, now = Date.now, askAll = false, hiring = false, closer = null }) {
    if (!questions?.length) throw new Error('Interview has no planned questions');
    this.questions  = questions;
    this.askAll     = askAll;
    this.hiring     = hiring;   // a real screening: no report for the candidate, questions go to the team
    this.closer     = closer;   // answers the candidate's own questions at the end (liveSession.answerCandidateQuestions)
    if (askAll) {
      // Time kept back for the closing question, and the time each planned
      // question is assumed to need. Follow-ups only use what is left over.
      const asked = questions.filter(q => q.phase !== 'closing').length || 1;
      this.wrapUpMs      = clamp(durationMs * 0.12, 30 * 1000, 90 * 1000);
      this.perQuestionMs = clamp((durationMs - this.wrapUpMs) / asked, 30 * 1000, MIN_PER_QUESTION_MS);
    } else {
      this.wrapUpMs      = WRAP_UP_MS;
      this.perQuestionMs = MIN_PER_QUESTION_MS;
    }
    this.judge      = judge;
    this.seniority  = seniority;
    this.candidateName = candidateName;
    this.role       = role;
    this.company    = company;
    this.durationMs = durationMs;
    this.now        = now;
    this.finished   = false;
    this.rotation   = new Map(); // pool → next index, so stock lines rotate
    this.lastReaction = null;    // never the same reaction twice in a row
    // Consecutive answers the candidate couldn't give; the interviewer eases off as it grows.
    this.struggleStreak = 0;
    this.warmed     = false;     // the "no pressure" line, once per streak
    this.timeWarned = false;     // "almost at time" is said once
    this.exchanges  = 0;         // answered asks so far, and the time they took (pacing)
    this.exchangeMsTotal = 0;
  }

  get current() { return this.questions[this.index]; }

  opening() {
    this.startedAt = this.now();
    this.endsAt = this.startedAt + this.durationMs;
    const greeting = greetingText({
      candidateName: this.candidateName,
      role         : this.role,
      company      : this.company,
      minutes      : Math.round(this.durationMs / 60000)
    });
    this.#ask(0);
    return reply([{ key: GREETING_KEY, text: greeting }, this.#askingSegment()]);
  }

  // After an agent restart mid-interview: continue at `index`, keeping the
  // original time budget.
  resume(index, startedAt) {
    this.startedAt = startedAt.getTime();
    this.endsAt = this.startedAt + this.durationMs;
    this.#ask(index);
    return reply([lib('back.resume'), this.#askingSegment()]);
  }

  // The student dropped and reconnected: they may have missed the question.
  welcomeBack() {
    this.asking.parts = [];
    return reply([lib('back.drop'), this.#askingSegment()]);
  }

  // One finished student turn (end of speech detected). `onThinking` is called
  // with a reaction segment to play right away while the judge call runs, so
  // the couple of seconds of judging never play as dead air.
  async onAnswer(text, onThinking = null) {
    if (this.finished) return reply([], true);
    const clean = (text || '').trim();
    // Noise transcribed as "thank you": say nothing and keep listening.
    if (isPhantom(clean)) return reply([]);

    if (clean.split(/\s+/).filter(Boolean).length < 2 && !/\b(no|yes|nope|yep|skip|pass|never|agree|done|correct|right|sure|okay|fine)\b/i.test(clean)) {
      if (this.asking.notHeard++ < MAX_NOT_HEARD) return reply([this.#rotate(REPEATS)]);
    }
    this.asking.parts.push(clean);

    if (looksUnfinished(clean) && this.asking.continues < MAX_CONTINUE) {
      this.asking.continues++;
      return reply([this.#rotate(CONTINUES)]);
    }

    if (this.current.phase === 'closing') return this.#finishClosing(onThinking);

    // A person acknowledges as soon as you stop talking; silence sounds like a machine.
    this.reacted = false;
    if (onThinking) {
      try { onThinking(this.#reaction()); this.reacted = true; } catch { /* speech is best-effort */ }
    }
    let d = await this.#direct(this.asking.continues < MAX_CONTINUE);
    let leadIn = null;
    if (WANTS_NEXT.test(clean)) {
      // They asked for another question: no easier follow-up on this one.
      d = { ...(d || {}), verdict: 'skip', followUp: null };
      leadIn = lib('next.sure');
    }
    // "What do you mean?" is short. A long answer labelled clarify is a
    // misjudgement; asking the same question again would sound broken.
    if (d?.verdict === 'clarify' && clean.split(/\s+/).length > 20 && !clean.includes('?')) {
      d = { ...d, verdict: 'shallow', rephrase: null };
    }
    const verdict = d?.verdict;

    if (verdict === 'incomplete') {
      this.asking.continues++;
      return reply([this.#rotate(CONTINUES)]);
    }
    if (verdict === 'clarify') {
      this.asking.parts = [];
      if (this.asking.clarifies++ < MAX_CLARIFY) {
        const plain = [lib('clarify.sure'), this.#askingSegment()];
        return reply(d.rephrase ? [live(d.rephrase, plain)] : plain);
      }
      return this.#respond({ verdict: 'skip' });
    }
    if (verdict === 'garbled') {
      // Probably misheard: drop it and ask again, but never loop on it.
      this.asking.parts.pop();
      if (this.asking.notHeard++ < MAX_NOT_HEARD) return reply([this.#rotate(REPEATS)]);
      return this.#respond({ verdict: 'skip' }, null, 'uncertain');
    }
    return this.#respond(d, leadIn);
  }

  // The student has been silent for the session's away timeout.
  async onSilence() {
    if (this.finished) return reply([], true);
    this.reacted = false;
    if (this.asking.parts.length) {
      if (this.current.phase === 'closing') return this.#finishClosing();
      const d = await this.#direct(false);
      return this.#respond(['clarify', 'garbled', 'incomplete'].includes(d?.verdict) ? { verdict: 'skip' } : d);
    }
    if (this.asking.silences++ === 0) return reply([lib('silence.take')]);
    if (this.current.phase === 'closing') return this.#finishClosing();
    return this.#respond({ verdict: 'skip' }, lib('moveon'));
  }

  // A coding/SQL exercise question was graded (or the candidate asked to move
  // on) via the code panel, not spoken. Bypasses the judge entirely: pass/fail
  // maps straight to a verdict and the interview advances the same way a
  // spoken answer would.
  onCodingResult({ passed, total, skipped }) {
    if (this.finished) return reply([], true);
    this.reacted = false;
    const allPassed = !skipped && total > 0 && passed === total;
    const verdict = skipped ? 'skip' : allPassed ? 'strong' : passed > 0 ? 'shallow' : 'wrong';
    this.asking.parts.push(skipped
      ? 'Asked to move on without a working solution.'
      : `Code submitted: ${passed}/${total} test cases passed.`);
    const leadIn = skipped ? lib('code.skip')
      : allPassed ? lib('code.pass')
        : passed > 0 ? live(`That gets ${passed} out of ${total}. Let's move on for now.`, [lib('code.fail')])
          : lib('code.fail');
    return this.#respond({ verdict }, leadIn, skipped ? 'skipped' : 'captured');
  }

  onTimeUp() {
    const turn = this.asking?.parts.length ? this.#record(null) : null;
    this.finished = true;
    return reply([lib(this.hiring ? 'timeup.hire' : 'timeup')], true, turn);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  // Asks the planned question at `index`, or a follow-up ({ text, trigger, key })
  // on the current one. `key` is the follow-up's clip, null when it is live.
  #ask(index, followUp = null) {
    const q = this.questions[index];
    const same = index === this.index && this.asking;
    this.index = index;
    this.asking = {
      text     : followUp ? followUp.text : q.text,
      clip     : followUp ? followUp.key ?? null : questionKey(q.qid),
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

  // What is being asked right now, as something to play again.
  #askingSegment() {
    return this.asking.clip ? { key: this.asking.clip, text: this.asking.text } : live(this.asking.text);
  }

  // Next line from a pool of library keys, in rotation.
  #rotate(pool) {
    const i = this.rotation.get(pool) || 0;
    this.rotation.set(pool, i + 1);
    return lib(pool[i % pool.length]);
  }

  // A neutral acknowledgement, never the same one twice in a row.
  #reaction() {
    const choices = REACTIONS.filter(k => k !== this.lastReaction);
    const key = choices[Math.floor(Math.random() * choices.length)];
    this.lastReaction = key;
    return lib(key);
  }

  // Which planned question comes next if the interview moves on now.
  #nextIndex() {
    const closing = this.#closingIndex();
    const remaining = this.#remainingMs();
    if (this.askAll) {
      // Every planned question is asked. Only the closing is given up, and only
      // once the interview is already past its length.
      const next = this.index + 1;
      return next === closing && remaining <= 0 ? this.questions.length : next;
    }
    if (remaining < WRAP_UP_MS && closing > this.index) return closing;
    // Behind schedule after digging: drop later questions of a phase that still has
    // another question left, so every phase is still covered and the close isn't rushed.
    let next = this.index + 1;
    // Employer must-ask questions (hiring interviews) are never dropped.
    while (next < this.questions.length - 1
      && remaining / (this.questions.length - next) < MIN_PER_QUESTION_MS
      && this.questions[next].source !== 'employer'
      && this.questions[next + 1].phase === this.questions[next].phase) next++;
    return next;
  }

  // Asks the judge about the current answer. Returns { verdict, followUp,
  // rephrase } or null when the judge is down.
  async #direct(allowIncomplete) {
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
        struggleStreak : this.struggleStreak
      });
      // A judge that only returns a verdict string still works.
      const d = typeof out === 'string' ? { verdict: out, followUp: null, rephrase: null } : out;
      if (!d?.verdict) return null;
      if (!allowIncomplete && d.verdict === 'incomplete') return { ...d, verdict: 'shallow' };
      return d;
    } catch {
      return null; // judge unavailable: record the answer and move on
    }
  }

  #record(verdict, capture = 'captured') {
    return {
      qid       : this.current.qid,
      kind      : this.asking.kind,
      trigger   : this.asking.trigger,
      capture,
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
    if (q.ref?.type === 'coding' || q.ref?.type === 'sql_exercise') return false;
    if (this.asking.followUpsUsed >= (DIG_DEPTH[q.phase] ?? DEFAULT_DIG_DEPTH)) return false;
    const remaining = this.#remainingMs();
    if (remaining < this.wrapUpMs) return false;
    if (this.askAll) {
      // Only with time to spare after every question still to come, at the
      // pace this candidate is actually going (until measured: the budget).
      const ahead = this.questions.slice(this.index + 1).filter(x => x.phase !== 'closing').length;
      const pace = this.exchanges ? clamp(this.exchangeMsTotal / this.exchanges, 20 * 1000, this.perQuestionMs) : this.perQuestionMs;
      return remaining - this.wrapUpMs - ahead * pace >= pace;
    }
    // Later questions can be dropped, so only the phases still ahead need time.
    const phasesLeft = new Set(this.questions.slice(this.index + 1).map(x => x.phase)).size;
    return remaining - phasesLeft * MIN_PER_QUESTION_MS >= MIN_PER_QUESTION_MS;
  }

  // A follow-up that already says the concepts a strong answer would contain
  // gives the answer away.
  #leaks(followUp) {
    const known = new Set([...words(this.asking.text), ...words(this.asking.parts.join(' '))]);
    const guard = new Set(words((this.current.expectedPoints || []).map(p => p.point).join(' ')));
    // One shared word ("model", "users") is normal; naming several is giving it away.
    return new Set(words(followUp).filter(w => guard.has(w) && !known.has(w))).size >= 2;
  }

  // What comes before the next line: an explicit lead-in, else a plain
  // acknowledgement if none was played yet this turn. Someone who couldn't
  // answer gets a "no worries", and after several in a row one gentle line.
  #lead(verdict, leadIn) {
    if (leadIn) return [leadIn];
    if (verdict === 'skip') {
      if (this.struggleStreak >= 2 && !this.warmed) {
        this.warmed = true;
        return [lib('warm')];
      }
      return [this.#rotate(SKIP_ACKS)];
    }
    return this.reacted ? [] : [this.#reaction()];
  }

  // The answer is done: follow up on it, or move to the next planned question.
  #respond(d, leadIn = null, capture = 'captured') {
    const verdict = d?.verdict ?? null;
    const turn = this.#record(verdict, capture);
    const q = this.current;
    // The greeting is spoken before the first question, so that one isn't a fair sample.
    if (this.index > 0 || this.asking.kind === 'follow_up') {
      this.exchanges++;
      this.exchangeMsTotal += this.now() - this.asking.askedAt.getTime();
    }
    if (verdict === 'skip') this.struggleStreak++;
    else if (verdict) { this.struggleStreak = 0; this.warmed = false; }

    if (this.#canFollowUp(q)) {
      const trigger = TRIGGER_BY_VERDICT[verdict];
      const askedBefore = [this.asking.text, ...this.asking.history.map(h => h.interviewer)];
      const fresh = text => text && !askedBefore.some(a => overlap(a, text) >= REPEAT_OVERLAP);
      // The planned follow-up for this kind of answer, never the same one twice.
      const plannedText = trigger && !this.asking.usedTriggers.has(trigger) ? q.followUps?.[trigger] || null : null;
      const planned = fresh(plannedText) ? { text: plannedText, trigger, key: followUpKey(q.qid, trigger) } : null;
      // The judge's follow-up is built from the candidate's own words; it is
      // dropped if it repeats an earlier question or hints at the answer (an
      // easier way in after "I don't know" naturally names the topic, so only
      // real answers are checked).
      const judged = fresh(d?.followUp) && !(verdict !== 'skip' && this.#leaks(d.followUp))
        ? { text: d.followUp, trigger, key: null } : null;
      const followUp = trigger ? judged || planned : null;
      if (followUp) {
        const lead = this.#lead(verdict, leadIn);
        // A live follow-up that can't be spoken is replaced by something
        // pre-recorded in the same voice: the planned follow-up, or else the
        // next planned question.
        let fallback = null;
        if (!followUp.key) {
          if (planned) {
            fallback = { segments: [{ key: planned.key, text: planned.text }], state: { text: planned.text, key: planned.key } };
          } else {
            const next = this.#nextIndex();
            const nq = this.questions[next];
            if (nq) {
              const bridge = nq.phase !== q.phase && TRANSITIONS[nq.phase] ? lib(TRANSITIONS[nq.phase]) : null;
              fallback = { segments: [bridge, { key: questionKey(nq.qid), text: nq.text }].filter(Boolean), state: { advanceTo: next } };
            }
          }
        }
        this.asking.followUpsUsed++;
        this.asking.usedTriggers.add(trigger);
        this.#ask(this.index, followUp);
        const ask = followUp.key ? { key: followUp.key, text: followUp.text }
          : { ...live(followUp.text, fallback?.segments), ...(fallback ? { fallbackState: { ...fallback.state, asking: this.asking } } : {}) };
        return reply([...lead, ask], false, turn);
      }
    }

    const nextIndex = this.#nextIndex();
    if (nextIndex >= this.questions.length) {
      this.finished = true;
      return reply(this.#closingLine(), true, turn);
    }

    const nextQ = this.questions[nextIndex];
    const lead = this.#lead(verdict, leadIn);
    let bridge = nextQ.phase !== q.phase && TRANSITIONS[nextQ.phase] ? lib(TRANSITIONS[nextQ.phase]) : null;
    // Entering the close on the clock: say so once, like a person watching the time.
    if (!this.timeWarned && nextQ.phase === 'closing' && q.phase !== 'closing' && this.#remainingMs() < this.wrapUpMs) {
      this.timeWarned = true;
      bridge = lib('time.warn');
    }
    this.#ask(nextIndex);
    return reply([...lead, bridge, this.#askingSegment()], false, turn);
  }

  // The agent played a live segment's recorded fallback instead of it. Applies
  // only if that segment's question is still the one being asked.
  usedFallback(segment) {
    const f = segment?.fallbackState;
    if (!f || f.asking !== this.asking) return;
    if (f.advanceTo != null) {
      this.#ask(f.advanceTo);
      return;
    }
    this.asking.text = f.text;
    this.asking.clip = f.key;
  }

  // The candidate answered "Do you have any questions for us?". Their questions
  // get a real reply (only from the JD and company profile; anything else is
  // passed on to the team or, in a mock, left for the real interview), then the
  // goodbye. A reaction plays while the reply is written.
  async #finishClosing(onThinking = null) {
    const turn = this.#record(null);
    this.finished = true;
    const answer = turn.answer.trim();
    const deferral = lib(this.hiring ? 'close.defer.hire' : 'close.good');
    const goodbye = lib(this.hiring ? 'close.end.hire' : 'close.end');
    const words = answer.split(/\s+/).filter(Boolean).length;
    // "No", "nothing", "I'm good, thanks": no question to answer. Speech-to-text
    // often drops the "?", so any question word means they may be asking.
    const mayAsk = answer.includes('?')
      || /\b(what|what'?s|how|how'?s|when|where|where'?s|why|who|who'?s|which|is there|are there|is it|do you|do i|does|did i|can i|could|will i|would|should i|i wanted to ask|i want to know|tell me about)\b/i.test(answer);
    const clearlyNone = !mayAsk && (words <= 4 || /^(no|nope|nothing|not really|i'?m good|i think (that'?s|you covered))\b/i.test(answer));
    if (clearlyNone || !this.closer) {
      return reply([!clearlyNone && words > 6 ? deferral : null, goodbye], true, turn);
    }
    if (onThinking) {
      try { onThinking(this.#reaction()); } catch { /* speech is best-effort */ }
    }
    let answered = null;
    try {
      answered = await this.closer({ candidateSaid: answer });
    } catch {
      answered = null; // model down: fall back to the recorded line
    }
    if (answered && !answered.asked) return reply([goodbye], true, turn);
    const response = answered?.reply ? live(answered.reply, [deferral]) : (words > 6 ? deferral : null);
    return reply([response, goodbye], true, turn);
  }

  #closingLine() {
    return [lib(this.hiring ? 'close.end.hire' : 'close.end')];
  }
}
