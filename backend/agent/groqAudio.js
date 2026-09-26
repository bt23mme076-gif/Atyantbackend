// Groq speech adapters for the interview agent. Both route through the shared
// multi-key rotation in utils/groqClient.js, so a rate-limited key fails over.
import { OpenAI } from 'openai';
import { AudioByteStream, shortuuid, tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { groqRotate, GROQ_API_KEYS } from '../utils/groqClient.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const STT_MODEL = process.env.MOCK_STT_MODEL || 'whisper-large-v3-turbo';
const TTS_MODEL = process.env.MOCK_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const TTS_VOICE = process.env.MOCK_TTS_VOICE || 'daniel';
const TTS_SAMPLE_RATE = 24000;

async function groqFetch(url, init = {}) {
  return groqRotate(async (key, ctx) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${key}`);
    const res = await fetch(url, { ...init, headers });
    ctx?.onHeaders?.(res.headers);
    if (res.status === 429 || res.status >= 500 || res.status === 401) {
      const err = new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }
    return res;
  });
}

// Orpheus needs its terms accepted separately on every Groq org, so some keys can
// be valid for chat and Whisper yet refuse speech (400 model_terms_required). The
// shared rotation treats a 400 as a bad request and would fail the utterance, so
// speech uses its own pass over the keys that skips any that refuse it.
// Keys that can never speak (terms not accepted, or revoked) are dropped for
// the life of the process.
const unusable = new Set();
const TTS_RETRY_WAITS_MS = [1500, 4000, 8000];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// Tries every usable key. When they are all rate-limited (the free plan allows
// 10 speech requests a minute) it waits and tries again instead of failing: a
// failed speech request is fatal to the LiveKit session, a short pause isn't.
async function ttsFetch(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let rateLimited = null;
    let failed = null;
    for (const key of GROQ_API_KEYS) {
      if (unusable.has(key)) continue;
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${key}`);
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401 || (res.status === 400 && /model_terms_required/.test(await res.clone().text()))) {
        unusable.add(key);
        continue;
      }
      if (res.status === 429) { rateLimited = res; continue; }
      if (res.status >= 500) { failed = res; continue; }
      return res;
    }
    const waitable = rateLimited || failed;
    if (!waitable) {
      throw new Error('No Groq key can use Orpheus. Accept the terms at console.groq.com/playground?model=canopylabs%2Forpheus-v1-english');
    }
    if (attempt >= TTS_RETRY_WAITS_MS.length) return waitable;
    const retryAfter = Number(waitable.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : TTS_RETRY_WAITS_MS[attempt];
    await sleep(wait, init.signal);
  }
}

// Whisper, non-streaming: the session wraps it with the VAD so each finished
// utterance is transcribed once. `prompt` biases spelling of names and jargon
// (skills, project names) that Whisper would otherwise mishear.
export function createGroqSTT({ prompt = '' } = {}) {
  return new openai.STT({
    model         : STT_MODEL,
    language      : 'en',
    detectLanguage: false,
    useRealtime   : false,
    prompt        : prompt.slice(0, 800),
    apiKey        : 'rotated-per-request',
    client        : new OpenAI({ baseURL: GROQ_BASE_URL, apiKey: 'rotated-per-request', fetch: groqFetch, maxRetries: 0 })
  });
}

function wavToPcm(buffer) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Groq TTS did not return a WAV file');

  let sampleRate, channels, bits;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels   = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits       = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      // Streamed WAVs can carry a placeholder size; take everything that's there.
      const end = Math.min(body + size, buffer.byteLength);
      return { pcm: buffer.slice(body, end), sampleRate, channels, bits };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('Groq TTS WAV has no data chunk');
}

class GroqChunkedStream extends tts.ChunkedStream {
  label = 'groq.ChunkedStream';

  constructor(ttsInstance, text, request, connOptions, abortSignal) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.request = request;
  }

  async run() {
    try {
      const t0 = Date.now();
      const { pcm, sampleRate, channels, bits } = wavToPcm(await this.request);
      console.log(`timing: ${this.label} tts ${Date.now() - t0}ms for ${this.inputText.length} chars`);
      if (sampleRate !== TTS_SAMPLE_RATE || channels !== 1 || bits !== 16) {
        throw new Error(`Unexpected Groq TTS format ${sampleRate}Hz/${channels}ch/${bits}bit, expected ${TTS_SAMPLE_RATE}Hz mono 16-bit`);
      }
      const requestId = shortuuid();
      const frames = new AudioByteStream(TTS_SAMPLE_RATE, 1).write(pcm);
      frames.forEach((frame, i) => {
        this.queue.put({ requestId, segmentId: requestId, frame, final: i === frames.length - 1 });
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      throw error;
    } finally {
      this.queue.close();
    }
  }
}

export class GroqTTS extends tts.TTS {
  label = 'groq.TTS';
  #model;
  #voice;

  constructor({ model = TTS_MODEL, voice = TTS_VOICE } = {}) {
    super(TTS_SAMPLE_RATE, 1, { streaming: false });
    this.#model = model;
    this.#voice = voice;
  }

  get model() { return this.#model; }
  get provider() { return 'groq'; }

  synthesize(text, connOptions, abortSignal) {
    const request = ttsFetch(`${GROQ_BASE_URL}/audio/speech`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ model: this.#model, voice: this.#voice, input: text, response_format: 'wav' }),
      signal : abortSignal
    }).then(async res => {
      if (!res.ok) throw new Error(`Groq TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.arrayBuffer();
    });
    return new GroqChunkedStream(this, text, request, connOptions, abortSignal);
  }

  stream() {
    throw new Error('Groq TTS does not support streaming');
  }
}

const KOKORO_URL = (process.env.KOKORO_URL || '').replace(/\/+$/, '');
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'am_michael';
const KOKORO_TIMEOUT_MS = 8000;

// Self-hosted Kokoro (OpenAI-compatible). Fails fast so the fallback adapter can
// hand the utterance to Orpheus.
export class KokoroTTS extends tts.TTS {
  label = 'kokoro.TTS';
  #voice;

  constructor({ voice = KOKORO_VOICE } = {}) {
    super(TTS_SAMPLE_RATE, 1, { streaming: false });
    this.#voice = voice;
  }

  get model() { return 'kokoro'; }
  get provider() { return 'kokoro'; }

  synthesize(text, connOptions, abortSignal) {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, AbortSignal.timeout(KOKORO_TIMEOUT_MS)])
      : AbortSignal.timeout(KOKORO_TIMEOUT_MS);
    const request = fetch(`${KOKORO_URL}/audio/speech`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ model: 'kokoro', voice: this.#voice, input: text, response_format: 'wav' }),
      signal
    }).then(async res => {
      if (!res.ok) throw new Error(`Kokoro TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.arrayBuffer();
    });
    return new GroqChunkedStream(this, text, request, connOptions, abortSignal);
  }

  stream() {
    throw new Error('Kokoro TTS does not support streaming');
  }
}

export function createInterviewTTS() {
  if (!KOKORO_URL) return new GroqTTS();
  return new tts.FallbackAdapter({ ttsInstances: [new KokoroTTS(), new GroqTTS()] });
}
