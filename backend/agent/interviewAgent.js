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
  judge, sttPrompt, resumeIndex, startLiveInterview, saveTurn, endLiveInterview
} from '../services/mockInterview/liveSession.js';
import { MOCK_AGENT_NAME, INTERVIEW_DURATION_MS } from '../services/mockInterview/liveConfig.js';
import { createGroqSTT, createInterviewTTS } from './groqAudio.js';

const SILENCE_MS      = 30 * 1000;       // no speech after the interviewer finishes
const REJOIN_GRACE_MS  = 3 * 60 * 1000;   // student dropped: wait this long before ending
const TIME_UP_GRACE_MS = 2 * 60 * 1000;   // hard stop after the planned duration

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
    const { interview, startedAt, resuming } = started;
    const questions = interview.plan.questions;

    const roomName = ctx.job.room?.name;
    const studentId = String(interview.userId);
    await ctx.connect();
    await ctx.waitForParticipant(studentId);

    const user = await User.findById(interview.userId).select('name username').lean();
    const controller = new InterviewController({
      questions,
      judge,
      seniority    : interview.seniority,
      candidateName: user?.name || '',
      role         : interview.role,
      company      : interview.company,
      durationMs   : INTERVIEW_DURATION_MS
    });

    const timers = {};
    let session;
    let finished = false;

    const finish = async reason => {
      if (finished) return;
      finished = true;
      Object.values(timers).forEach(clearTimeout);
      try {
        await lastSave;
        await endLiveInterview(interviewId, reason);
      } catch (err) {
        logger.error({ err }, 'failed to save interview end state');
      }
      await session?.close().catch(() => {});
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
      if (index <= 0 || index >= questions.length || Date.now() - startedAt.getTime() > INTERVIEW_DURATION_MS) {
        await finish(index >= questions.length ? 'completed' : 'time_up');
        return;
      }
      openingText = controller.resume(index, startedAt);
    } else {
      openingText = controller.opening();
    }

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

    const remainingMs = startedAt.getTime() + INTERVIEW_DURATION_MS - Date.now();
    timers.timeUp = setTimeout(() => step(() => controller.onTimeUp(), 'time_up'), remainingMs + TIME_UP_GRACE_MS);

    await session.start({
      agent: new InterviewerAgent({ openingText, onAnswer: text => step(() => controller.onAnswer(text)) }),
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
