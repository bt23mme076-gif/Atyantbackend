// AI mock interviewer — LiveKit Agents worker.
//
//   node agent/interviewAgent.js dev     (local, auto-reload)
//   node agent/interviewAgent.js start   (production)
//
// The API dispatches this agent by name into room mock_<interviewId> when the
// student joins (routes/mockInterviewRoutes.js). There is no LLM in the voice
// loop: InterviewController decides every line from the pre-built plan, and
// the only live model call is the fast judge after each answer.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { cli, defineAgent, voice, ServerOptions, log } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomEvent } from '@livekit/rtc-node';
import User from '../models/User.js';
import liveKitService from '../services/LiveKitService.js';
import { InterviewController } from '../services/mockInterview/InterviewController.js';
import {
  judge, sttPrompt, resumeIndex, startLiveInterview, markLiveStart, saveTurn, endLiveInterview
} from '../services/mockInterview/liveSession.js';
import { MOCK_AGENT_NAME, INTERVIEW_DURATION_MS, hireParticipantIdentity } from '../services/mockInterview/liveConfig.js';
import { createGroqSTT, createInterviewTTS } from './groqAudio.js';

const SILENCE_MS      = 30 * 1000;       // no speech after the interviewer finishes
const REJOIN_GRACE_MS  = 3 * 60 * 1000;   // student dropped: wait this long before ending
const TIME_UP_GRACE_MS = 2 * 60 * 1000;   // hard stop after the planned duration
const HARD_STOP_EXTRA_MS = 60 * 1000;    // after that: closing line's playout, then leave no matter what
const JOIN_WAIT_MS = Number(process.env.MOCK_JOIN_WAIT_MS) || 5 * 60 * 1000; // dispatched, candidate never connected
const CLOSE_TIMEOUT_MS = 15 * 1000;      // cap on each shutdown step so the job always exits

// true if `promise` settles within `ms`, false on timeout (rejections propagate).
function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })
  ]).finally(() => clearTimeout(timer));
}

// End of answer = VAD silence + endpointing delay. Candidates pause while thinking
// — a real interviewer waits. These defaults are intentionally generous; cut them
// only if the interview feels sluggish. MOCK_* env vars override all three.
const VAD_MIN_SILENCE_MS = Number(process.env.MOCK_VAD_MIN_SILENCE_MS) || 1400;
const ENDPOINTING = {
  minDelay: Number(process.env.MOCK_ENDPOINT_MIN_DELAY_MS) || 2200,
  maxDelay: Number(process.env.MOCK_ENDPOINT_MAX_DELAY_MS) || 7000
};

class InterviewerAgent extends voice.Agent {
  constructor({ openingText, onAnswer }) {
    super({
      instructions: 'Scripted mock interviewer. Every reply comes from InterviewController, not an LLM.',
      allowInterruptions: false
    });
    this.openingText = openingText;
    this.onAnswer = onAnswer;
  }

  async onEnter() {
    this.session.say(this.openingText, { allowInterruptions: false });
  }

  async onUserTurnCompleted(_chatCtx, message) {
    await this.onAnswer(message.textContent ?? '');
  }
}

export default defineAgent({
  prewarm: async proc => {
    proc.userData.vad = await silero.VAD.load({ minSilenceDuration: VAD_MIN_SILENCE_MS });
  },

  entry: async ctx => {
    const logger = log().child({ job: ctx.job.id });
    const { interviewId } = JSON.parse(ctx.job.metadata || '{}');

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
    }

    const started = await startLiveInterview(interviewId);
    if (!started) {
      logger.warn({ interviewId }, 'interview not startable, leaving');
      ctx.shutdown('interview not startable');
      return;
    }
    const { interview, resuming } = started;
    let { startedAt } = started;
    const questions = interview.plan.questions;
    const hiring = interview.mode === 'hiring';
    // Hiring interviews run for the founder-chosen length (5-15 min).
    const durationMs = hiring && interview.hire?.durationMin ? interview.hire.durationMin * 60 * 1000 : INTERVIEW_DURATION_MS;

    const roomName = ctx.job.room?.name;
    const studentId = hiring ? hireParticipantIdentity(interview.hire.applicationId) : String(interview.userId);
    await ctx.connect();
    // The candidate may never arrive (e.g. closed the tab during the network
    // check). Don't hold a room and a worker process for them: release the
    // interview so they can start it again later.
    if (!(await within(ctx.waitForParticipant(studentId), JOIN_WAIT_MS))) {
      logger.warn({ interviewId }, 'candidate never joined, leaving');
      await within(endLiveInterview(interviewId, 'no_show'), CLOSE_TIMEOUT_MS)
        .catch(err => logger.error({ err }, 'failed to release interview'));
      if (roomName) await liveKitService.deleteRoom(roomName);
      ctx.shutdown('candidate never joined');
      return;
    }
    // A fresh interview's clock runs from when the candidate is in the room.
    if (!resuming) startedAt = await markLiveStart(interviewId);

    const user = hiring ? null : await User.findById(interview.userId).select('name username').lean();
    const controller = new InterviewController({
      questions,
      judge,
      seniority    : interview.seniority,
      candidateName: hiring ? interview.hire.candidateName : user?.name || '',
      role         : interview.role,
      company      : interview.company,
      durationMs
    });

    const timers = {};
    let session;
    let finished = false;
    let announcedQid = null;

    // Tells the student's browser to show/hide the code panel for the
    // question currently being asked. Sent over LiveKit's data channel so it
    // arrives alongside (not instead of) the spoken question.
    const CODE_TYPES = new Set(['coding', 'sql_exercise']);
    const announceQuestionPanel = () => {
      const q = controller.current;
      if (!q || announcedQid === q.qid) return;
      announcedQid = q.qid;
      const payload = CODE_TYPES.has(q.ref?.type)
        ? { type: 'coding_question', kind: q.ref.type, problemId: q.ref.id, qid: q.qid }
        : { type: 'hide_coding_panel', qid: q.qid };
      try {
        ctx.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true });
      } catch (err) {
        logger.error({ err }, 'failed to publish question-panel data message');
      }
    };

    const finish = async reason => {
      if (finished) return;
      finished = true;
      Object.values(timers).forEach(clearTimeout);
      try {
        const saved = await within(lastSave.then(() => endLiveInterview(interviewId, reason)), CLOSE_TIMEOUT_MS);
        if (!saved) logger.error({ interviewId }, 'timed out saving interview end state');
      } catch (err) {
        logger.error({ err }, 'failed to save interview end state');
      }
      if (session) await within(session.close(), CLOSE_TIMEOUT_MS).catch(() => {});
      if (roomName) await liveKitService.deleteRoom(roomName);
      ctx.shutdown(reason);
    };

    // Controller steps run one at a time: a student turn, a silence timeout
    // and the time cap can otherwise race each other.
    let chain = Promise.resolve();
    // The final turn must be stored before the interview is handed to evaluation.
    let lastSave = Promise.resolve();
    const step = (fn, endReason = 'completed') => {
      chain = chain.then(async () => {
        if (finished) return;
        const t0 = Date.now();
        const result = await fn();
        logger.info({ ms: Date.now() - t0 }, 'timing: director step');
        announceQuestionPanel();
        if (result.turn) {
          lastSave = saveTurn(interviewId, result.turn).catch(err => logger.error({ err }, 'failed to save turn'));
        }
        if (!result.say) {
          if (result.end) await finish(endReason);
          return;
        }
        // Not awaited: waiting for playout inside a speech task deadlocks the session.
        const handle = session.say(result.say, { allowInterruptions: false });
        if (result.end) handle.waitForPlayout().then(() => finish(endReason), () => finish(endReason));
      }).catch(err => logger.error({ err }, 'interview step failed'));
      return chain;
    };

    let openingText;
    if (resuming) {
      const index = resumeIndex(interview);
      if (index <= 0 || index >= questions.length || Date.now() - startedAt.getTime() > durationMs) {
        await finish(index >= questions.length ? 'completed' : 'time_up');
        return;
      }
      openingText = controller.resume(index, startedAt);
    } else {
      openingText = controller.opening();
    }
    announceQuestionPanel();

    session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: createGroqSTT({ prompt: sttPrompt(interview) }),
      tts: createInterviewTTS(),
      userAwayTimeout: null,
      turnHandling: {
        turnDetection: 'vad',
        endpointing  : ENDPOINTING,
        interruption : { enabled: false }
      }
    });

    const armSilence = () => {
      clearTimeout(timers.silence);
      timers.silence = setTimeout(() => step(() => controller.onSilence()), SILENCE_MS);
    };
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, ev => {
      if (ev.newState === 'listening') armSilence();
      else clearTimeout(timers.silence);
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, ev => {
      if (ev.newState === 'speaking') clearTimeout(timers.silence);
    });
    session.on(voice.AgentSessionEventTypes.Error, ev => logger.error({ error: ev.error }, 'session error'));
    // An unrecoverable error (e.g. speech still failing after retries) closes the
    // session. End the interview properly so it is scored and the student's room
    // closes, instead of leaving it stuck as "live" with a silent interviewer.
    session.on(voice.AgentSessionEventTypes.Close, ev => {
      if (finished) return;
      logger.error({ reason: ev?.reason, error: ev?.error }, 'session closed unexpectedly');
      finish('error');
    });

    // The candidate's code panel reports a result (submit passed/failed some
    // tests, or "move on without solving") over the data channel. Only acted
    // on while the current question is actually the one it's about — a late
    // message for a question already left behind is ignored.
    ctx.room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (participant?.identity !== studentId) return;
      let msg;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (msg?.type !== 'code_result') return;
      const q = controller.current;
      if (!q || q.qid !== msg.qid || !CODE_TYPES.has(q.ref?.type)) return;
      step(() => controller.onCodingResult({ passed: Number(msg.passed) || 0, total: Number(msg.total) || 0, skipped: !!msg.skipped }));
    });

    ctx.room.on(RoomEvent.ParticipantDisconnected, participant => {
      if (participant.identity !== studentId) return;
      clearTimeout(timers.silence);
      timers.rejoin = setTimeout(() => step(async () => ({ say: null, end: true, turn: null }), 'student_left'), REJOIN_GRACE_MS);
    });
    ctx.room.on(RoomEvent.ParticipantConnected, participant => {
      if (participant.identity !== studentId || !timers.rejoin) return;
      clearTimeout(timers.rejoin);
      timers.rejoin = null;
      step(async () => ({ say: controller.welcomeBack(), end: false, turn: null }));
    });

    const remainingMs = Math.max(0, startedAt.getTime() + durationMs - Date.now());
    timers.timeUp = setTimeout(() => step(() => controller.onTimeUp(), 'time_up'), remainingMs + TIME_UP_GRACE_MS);
    // Backstop outside the step chain: a hung judge or speech call can't keep
    // the interview (and this worker) running past the time limit.
    timers.hardStop = setTimeout(() => finish('time_up'), remainingMs + TIME_UP_GRACE_MS + HARD_STOP_EXTRA_MS);

    await session.start({
      agent: new InterviewerAgent({
        openingText,
        // The thinking sound is spoken at once, outside the step chain, so it
        // lands during the judge call instead of after it.
        onAnswer: text => step(() => controller.onAnswer(text, f => { try { session.say(f, { allowInterruptions: false }); } catch { /* best-effort */ } })),
      }),
      room : ctx.room,
      inputOptions: { participantIdentity: studentId, closeOnDisconnect: false }
    });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({
    agent    : fileURLToPath(import.meta.url),
    agentName: MOCK_AGENT_NAME,
    wsURL    : process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL
  }));
}
