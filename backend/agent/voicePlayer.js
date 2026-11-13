// Plays the interviewer's lines: pre-made clips from memory, live lines through
// OpenRouter, all in the interview's one voice.
//
// A line is a list of segments from InterviewController ({ key, text } = clip,
// { key: null, text, fallback? } = live). Live segments start synthesizing the
// moment the line is queued, so they render while the clips before them play.
// A live line that fails is retried, then tried once in the other voice (a
// logged last resort), then replaced by its planned fallback clip.
import { AudioByteStream } from '@livekit/agents';
import { AudioResampler } from '@livekit/rtc-node';
import VoiceClip from '../models/VoiceClip.js';
import { pcmFromWav, streamSpeech } from '../services/voice/openRouterSpeech.js';
import { LIBRARY, voiceConfig, voiceId } from '../services/voice/voiceLines.js';

const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_TIMEOUT_MS = 15000;

const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pcmFromWav(Buffer.from(await res.arrayBuffer()));
}

// Downloads this interview's clips and its voice's library into memory.
// A clip that fails to download is spoken live instead (logged).
export async function loadInterviewAudio(interview, logger) {
  const t0 = Date.now();
  const spec = { role: interview.voice.role, model: interview.voice.model, voice: interview.voice.voice };
  const library = await VoiceClip.find({ voiceId: voiceId(spec) }).select('key text url').lean();
  const wanted = [
    ...(interview.voice.clips || []),
    ...library.filter(c => LIBRARY[c.key] === c.text)
  ];
  const clips = new Map();
  let next = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    while (next < wanted.length) {
      const c = wanted[next++];
      try {
        clips.set(c.key, { text: c.text, ...(await download(c.url)) });
      } catch (err) {
        failed++;
        logger.warn({ key: c.key, err: err.message }, 'clip download failed, will speak it live');
      }
    }
  }));
  const missingLibrary = Object.keys(LIBRARY).filter(k => !clips.has(k));
  logger.info({ ms: Date.now() - t0, clips: clips.size, failed, missingLibrary: missingLibrary.length, voice: voiceId(spec) }, 'interview audio loaded');
  return { clips, spec };
}

// The other configured voice, for a live line the interview voice can't speak.
function otherVoice(spec) {
  const { main, backup } = voiceConfig();
  const other = spec.role === 'backup' ? main : backup;
  return other.model && other.voice && voiceId(other) !== voiceId(spec) ? other : null;
}

// Minimal async queue of PCM chunks, filled by a producer task.
class ChunkQueue {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(item) { const w = this.waiters.shift(); if (w) w({ value: item, done: false }); else this.items.push(item); }
  close() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class VoicePlayer {
  constructor({ clips, spec, interviewId, logger, onVoiceSwitch, onFallback }) {
    this.clips = clips;
    this.spec = spec;
    this.other = otherVoice(spec);
    this.interviewId = interviewId;
    this.logger = logger;
    this.onVoiceSwitch = onVoiceSwitch;
    this.onFallback = onFallback;
  }

  // Starts synthesizing a live segment now; chunks land in the returned queue.
  #live(seg, info) {
    const queue = new ChunkQueue();
    (async () => {
      const attempts = [this.spec, this.other].filter(Boolean);
      for (const voice of attempts) {
        let started = false;
        try {
          for await (const chunk of streamSpeech(seg.text, voice)) {
            if (!started) {
              started = true;
              if (voice !== this.spec) {
                this.logger.warn({ from: voiceId(this.spec), to: voiceId(voice), text: seg.text }, 'interview voice failed on a live line; used the other voice');
                this.onVoiceSwitch?.({ at: new Date(), from: voiceId(this.spec), to: voiceId(voice), reason: info.lastError || 'live line failed' });
              }
              info.voices.add(voiceId(voice));
              this.logger.info({ ms: chunk.firstAudioMs, chars: seg.text.length, voice: voiceId(voice) }, 'timing: live line first audio');
            }
            queue.push({ pcm: chunk.pcm, sampleRate: chunk.sampleRate });
          }
          queue.close();
          return;
        } catch (err) {
          info.lastError = err.message;
          this.logger.warn({ voice: voiceId(voice), err: err.message, started }, 'live line failed');
          if (started) { queue.close(); return; } // part of it played: don't restart it
        }
      }
      // Neither voice could say it: play the planned line instead, if there is one.
      for (const f of seg.fallback || []) {
        const clip = this.clips.get(f.key);
        if (clip) queue.push(clip);
      }
      if (seg.fallback?.length) this.onFallback?.(seg);
      else this.logger.error({ text: seg.text }, 'live line could not be spoken and has no fallback');
      queue.close();
    })().catch(err => { this.logger.error({ err }, 'live line task crashed'); queue.close(); });
    return queue;
  }

  // Speaks one line. `onFirstAudio({ first, voices })` fires when its first
  // audio frame is handed to LiveKit for playout.
  speak(session, segments, { onFirstAudio } = {}) {
    const info = { voices: new Set(), lastError: null };
    const sources = segments.map(seg => {
      const clip = seg.key ? this.clips.get(seg.key) : null;
      if (clip && clip.text === seg.text) return { kind: 'clip', clip };
      if (seg.key) this.logger.warn({ key: seg.key }, 'clip missing, speaking it live');
      return { kind: 'live', queue: this.#live(seg, info) };
    });
    const first = sources[0]?.kind || 'clip';
    const text = segments.map(s => s.text).join(' ');

    let targetRate = null;
    let i = 0;
    let started = false;
    const frames = [];
    const self = this;
    // Converts a PCM chunk to frames at one rate for the whole line.
    const toFrames = (pcm, sampleRate, state) => {
      targetRate ??= sampleRate;
      state.bytes ??= new AudioByteStream(sampleRate, 1);
      let out = state.bytes.write(toArrayBuffer(pcm));
      if (sampleRate !== targetRate) {
        state.resampler ??= new AudioResampler(sampleRate, targetRate, 1);
        out = out.flatMap(f => state.resampler.push(f));
      }
      return out;
    };
    const flushFrames = state => {
      let out = state.bytes ? state.bytes.flush() : [];
      if (state.resampler) out = [...out.flatMap(f => state.resampler.push(f)), ...state.resampler.flush()];
      return out;
    };

    const audio = new ReadableStream({
      async pull(controller) {
        while (!frames.length) {
          if (i >= sources.length) { controller.close(); return; }
          const src = sources[i];
          const state = (src.state ??= {});
          if (src.kind === 'clip') {
            frames.push(...toFrames(src.clip.pcm, src.clip.sampleRate, state), ...flushFrames(state));
            i++;
          } else {
            const { value, done } = await src.queue.next();
            if (done) { frames.push(...flushFrames(state)); i++; }
            else frames.push(...toFrames(value.pcm, value.sampleRate, state));
          }
        }
        if (!started) {
          started = true;
          if (first === 'clip') info.voices.add(voiceId(self.spec));
          try { onFirstAudio?.({ first, voices: [...info.voices] }); } catch { /* logging only */ }
        }
        controller.enqueue(frames.shift());
      }
    });

    return session.say(text, { audio, allowInterruptions: false });
  }
}
