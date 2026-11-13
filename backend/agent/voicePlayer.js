// Plays the interviewer's lines: pre-made clips from memory, live lines through
// OpenRouter, always in the interview's one voice. The voice never changes
// mid-interview.
//
// A line is a list of segments from InterviewController ({ key, text } = clip,
// { key: null, text, fallback? } = live). Live segments start synthesizing the
// moment the line is queued, so they render while the clips before them play.
// A live line that fails is retried in the same voice, then replaced by its
// pre-recorded fallback (the planned follow-up, or the next question), which
// is in the same voice too.
import { AudioByteStream } from '@livekit/agents';
import VoiceClip from '../models/VoiceClip.js';
import { pcmFromWav, streamSpeech } from '../services/voice/openRouterSpeech.js';
import { LIBRARY, voiceId } from '../services/voice/voiceLines.js';

const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_TIMEOUT_MS = 15000;
// Each live-line attempt waits this long for audio; two attempts, then the fallback.
const LIVE_ATTEMPT_MS = Number(process.env.TTS_LIVE_ATTEMPT_MS) || 5000;
// Clips are handed to LiveKit in slices, so a long clip never blocks the audio loop.
const SLICE_BYTES = 24000 * 2 * 0.4; // 400 ms at 24 kHz

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
  constructor({ clips, spec, logger, onLiveFailure, onFallback }) {
    this.clips = clips;
    this.spec = spec;
    this.logger = logger;
    this.onLiveFailure = onLiveFailure;
    this.onFallback = onFallback;
  }

  // Starts synthesizing a live segment now; chunks land in the returned queue.
  #live(seg, info) {
    const queue = new ChunkQueue();
    (async () => {
      let started = false;
      try {
        for await (const chunk of streamSpeech(seg.text, this.spec, { timeoutMs: LIVE_ATTEMPT_MS })) {
          if (!started) {
            started = true;
            info.voices.add(voiceId(this.spec));
            this.logger.info({ ms: chunk.firstAudioMs, chars: seg.text.length, voice: voiceId(this.spec) }, 'timing: live line first audio');
          }
          queue.push({ pcm: chunk.pcm, sampleRate: chunk.sampleRate });
        }
        queue.close();
        return;
      } catch (err) {
        this.logger.warn({ voice: voiceId(this.spec), err: err.message, started, text: seg.text }, 'live line failed');
        if (started) { queue.close(); return; } // part of it played: don't restart it
        // Same voice, pre-recorded: the planned line this live one was replacing.
        const fallback = (seg.fallback || []).map(f => this.clips.get(f.key)).filter(Boolean);
        for (const clip of fallback) queue.push(clip);
        if (fallback.length) {
          info.voices.add(voiceId(this.spec));
          this.onFallback?.(seg);
        } else {
          this.logger.error({ text: seg.text }, 'live line could not be spoken and has no recorded fallback');
        }
        this.onLiveFailure?.({ at: new Date(), text: seg.text, reason: err.message, fallback: fallback.length ? 'recorded' : 'none' });
        queue.close();
      }
    })().catch(err => { this.logger.error({ err }, 'live line task crashed'); queue.close(); });
    return queue;
  }

  // Speaks one line. `onFirstAudio({ first, voices })` fires when its first
  // audio frame is handed to LiveKit for playout.
  speak(session, segments, { onFirstAudio } = {}) {
    const info = { voices: new Set() };
    const sources = segments.map(seg => {
      const clip = seg.key ? this.clips.get(seg.key) : null;
      if (clip && clip.text === seg.text) return { kind: 'clip', clip, offset: 0 };
      if (seg.key) this.logger.warn({ key: seg.key }, 'clip missing, speaking it live');
      return { kind: 'live', queue: this.#live(seg, info) };
    });
    const first = sources[0]?.kind || 'clip';
    const text = segments.map(s => s.text).join(' ');

    let i = 0;
    let started = false;
    const frames = [];
    const self = this;
    const audio = new ReadableStream({
      async pull(controller) {
        while (!frames.length) {
          if (i >= sources.length) { controller.close(); return; }
          const src = sources[i];
          if (src.kind === 'clip') {
            src.bytes ??= new AudioByteStream(src.clip.sampleRate, 1);
            const slice = src.clip.pcm.subarray(src.offset, src.offset + SLICE_BYTES);
            src.offset += slice.length;
            frames.push(...src.bytes.write(toArrayBuffer(slice)));
            if (src.offset >= src.clip.pcm.length) { frames.push(...src.bytes.flush()); i++; }
          } else {
            const { value, done } = await src.queue.next();
            src.bytes ??= value ? new AudioByteStream(value.sampleRate, 1) : null;
            if (done) { if (src.bytes) frames.push(...src.bytes.flush()); i++; }
            else frames.push(...src.bytes.write(toArrayBuffer(value.pcm)));
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
