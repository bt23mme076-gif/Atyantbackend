// Text-to-speech through OpenRouter's OpenAI-compatible endpoint
// (POST /api/v1/audio/speech). Shared by the backend (pre-made interview audio)
// and the interview agent (live lines), so it must not import LiveKit.
//
// OpenRouter accepts only mp3 or pcm. We ask for raw 16-bit mono PCM and take
// its sample rate from the Content-Type ("audio/pcm;rate=24000;channels=1").
// A WAV body is also understood, in case a provider sends one.
import { alertOps } from './opsAlert.js';

const API = 'https://openrouter.ai/api/v1';
// Used only if the Content-Type carries no rate (both current models send 24 kHz).
const RAW_PCM_SAMPLE_RATE = Number(process.env.TTS_PCM_SAMPLE_RATE) || 24000;

function pcmFormat(contentType = '') {
  const rate = Number(/rate=(\d+)/i.exec(contentType)?.[1]) || null;
  const channels = Number(/channels=(\d+)/i.exec(contentType)?.[1]) || 1;
  if (channels !== 1) throw new SpeechError(`Unsupported speech audio: ${channels} channels (need mono)`);
  if (/mpeg|mp3/i.test(contentType)) throw new SpeechError('Speech came back as MP3; PCM was requested');
  return rate;
}

export class SpeechError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new SpeechError('OPENROUTER_API_KEY is not set');
  return key;
}

async function speechRequest(text, { model, voice }, signal) {
  let res;
  try {
    res = await fetch(`${API}/audio/speech`, {
      method : 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ model, voice, input: text, response_format: 'pcm' }),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError' && signal?.aborted && !signal.reason?.name?.includes('Timeout')) throw err;
    throw new SpeechError(`OpenRouter speech request failed: ${err.message}`, { retryable: true });
  }
  if (res.ok) return res;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 402) {
    alertOps('openrouter_402', `OpenRouter refused speech for ${model} (402: out of credits or over the key's limit). ${body}`);
  }
  throw new SpeechError(`OpenRouter speech ${res.status} (${model}): ${body}`, {
    status   : res.status,
    retryable: res.status === 429 || res.status >= 500
  });
}

// Retries 429/5xx/network errors with backoff. 402 and other 4xx fail at once.
async function withRetry(fn, waitsMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SpeechError) || !err.retryable || attempt >= waitsMs.length) throw err;
      await sleep(waitsMs[attempt]);
    }
  }
}

// ── PCM extraction ───────────────────────────────────────────────────────────

const tag = (buf, at) => buf.toString('ascii', at, at + 4);

// Incremental WAV/PCM reader: feed byte chunks, get PCM chunks back. The WAV
// header is read once enough bytes have arrived; streamed WAVs may carry a
// placeholder data size, so everything after the data chunk header is audio.
class PcmReader {
  constructor(rawRate = null) {
    this.rawRate = rawRate || RAW_PCM_SAMPLE_RATE;
    this.pending = Buffer.alloc(0);
    this.sampleRate = null;
    this.inData = false;
    this.odd = null; // a 16-bit sample split across chunks
  }

  push(chunk) {
    let buf = Buffer.concat([this.pending, Buffer.from(chunk)]);
    this.pending = Buffer.alloc(0);
    if (!this.inData) {
      if (buf.length < 12) { this.pending = buf; return null; }
      if (tag(buf, 0) !== 'RIFF') {
        // Raw PCM, the normal case: rate from the Content-Type.
        this.sampleRate = this.rawRate;
        this.inData = true;
      } else {
        if (tag(buf, 8) !== 'WAVE') throw new SpeechError('Speech response is not a WAV file');
        let offset = 12;
        while (!this.inData) {
          if (offset + 8 > buf.length) { this.pending = buf; return null; }
          const id = tag(buf, offset);
          const size = buf.readUInt32LE(offset + 4);
          if (id === 'data') {
            buf = buf.subarray(offset + 8);
            this.inData = true;
            break;
          }
          if (offset + 8 + size > buf.length) { this.pending = buf; return null; }
          if (id === 'fmt ') {
            const format = buf.readUInt16LE(offset + 8);
            const channels = buf.readUInt16LE(offset + 10);
            const bits = buf.readUInt16LE(offset + 22);
            this.sampleRate = buf.readUInt32LE(offset + 12);
            if (format !== 1 || channels !== 1 || bits !== 16) {
              throw new SpeechError(`Unsupported speech audio: format ${format}, ${channels}ch, ${bits}-bit (need 16-bit mono PCM)`);
            }
          }
          offset += 8 + size + (size % 2);
        }
        if (!this.sampleRate) throw new SpeechError('Speech WAV has no fmt chunk');
      }
    }
    if (this.odd) { buf = Buffer.concat([this.odd, buf]); this.odd = null; }
    if (buf.length % 2) { this.odd = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
    return buf.length ? buf : null;
  }
}

// A whole WAV (or raw PCM at `rawRate`) → { pcm, sampleRate }.
export function pcmFromWav(wav, rawRate = null) {
  const reader = new PcmReader(rawRate);
  const pcm = reader.push(wav);
  if (!reader.inData) throw new SpeechError('Speech audio has no data');
  return { pcm: pcm || Buffer.alloc(0), sampleRate: reader.sampleRate };
}

export function wavFromPcm(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── Public API ───────────────────────────────────────────────────────────────

const MIN_AUDIO_BYTES = 2000; // ~40 ms at 24 kHz: anything shorter is an empty reply

// Whole utterance → { pcm, sampleRate, ms }. For pre-made audio: patient retries.
export async function synthesize(text, voiceSpec, { timeoutMs = 30000, retryWaitsMs = [1000, 3000, 8000] } = {}) {
  return withRetry(async () => {
    const t0 = Date.now();
    const res = await speechRequest(text, voiceSpec, AbortSignal.timeout(timeoutMs));
    const rate = pcmFormat(res.headers.get('content-type'));
    let audio;
    try {
      audio = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new SpeechError(`OpenRouter speech body failed: ${err.message}`, { retryable: true });
    }
    const { pcm, sampleRate } = pcmFromWav(audio, rate);
    if (pcm.length < MIN_AUDIO_BYTES) throw new SpeechError(`OpenRouter returned no audio for ${voiceSpec.model}`, { retryable: true });
    return { pcm, sampleRate, ms: Date.now() - t0 };
  }, retryWaitsMs);
}

// Streams PCM chunks as they arrive, for live lines. Yields
// { pcm, sampleRate, firstAudioMs? }. One quick retry before the first byte;
// after audio has started, a failure ends the line rather than restarting it.
export async function* streamSpeech(text, voiceSpec, { signal, timeoutMs = 8000, retryWaitsMs = [300] } = {}) {
  const t0 = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await withRetry(() => speechRequest(text, voiceSpec, combined), retryWaitsMs);
  const reader = new PcmReader(pcmFormat(res.headers.get('content-type')));
  let first = true;
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      const pcm = reader.push(chunk);
      if (!pcm) continue;
      bytes += pcm.length;
      yield first ? { pcm, sampleRate: reader.sampleRate, firstAudioMs: Date.now() - t0 } : { pcm, sampleRate: reader.sampleRate };
      first = false;
    }
  } catch (err) {
    if (signal?.aborted) return;
    throw new SpeechError(`OpenRouter speech stream broke after ${bytes} bytes: ${err.message}`, { retryable: bytes === 0 });
  }
  if (bytes < MIN_AUDIO_BYTES) throw new SpeechError(`OpenRouter returned no audio for ${voiceSpec.model}`, { retryable: true });
}

// The speech models OpenRouter lists, with their voices. Cached for an hour.
let modelsCache = null;
export async function listSpeechModels() {
  if (modelsCache && modelsCache.at > Date.now() - 60 * 60 * 1000) return modelsCache.models;
  const res = await fetch(`${API}/models?output_modalities=speech`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new SpeechError(`OpenRouter models list ${res.status}`);
  const { data = [] } = await res.json();
  const models = new Map(data.map(m => [m.id, { id: m.id, voices: m.supported_voices || [] }]));
  modelsCache = { at: Date.now(), models };
  return models;
}

// null when OpenRouter lists the model with that voice, else the problem.
export async function voiceProblem({ model, voice }) {
  if (!model || !voice) return 'model or voice not set';
  let models;
  try {
    models = await listSpeechModels();
  } catch {
    return null; // can't check right now; the request itself will tell
  }
  const m = models.get(model);
  if (!m) return `OpenRouter does not list speech model "${model}"`;
  if (m.voices.length && !m.voices.includes(voice)) return `"${voice}" is not a voice of ${model}`;
  return null;
}
