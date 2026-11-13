// Groq Whisper speech-to-text for the interview agent. Routes through the
// shared key rotation in utils/groqClient.js. The interviewer's voice is not
// here: it comes from OpenRouter (services/voice, agent/voicePlayer.js).
import { OpenAI } from 'openai';
import * as openai from '@livekit/agents-plugin-openai';
import { groqRotate } from '../utils/groqClient.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const STT_MODEL = process.env.MOCK_STT_MODEL || 'whisper-large-v3-turbo';

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
