// One shared Groq client for the whole backend.
//
// Multi-key round-robin with per-key cooldown + failover: requests spread across
// all configured keys (so their per-minute limits ADD UP), a key that hits a 429
// is "parked" until it resets (using Groq's own retry hint) and routed around,
// and a key that's nearly drained is parked proactively BEFORE it 429s. When all
// keys are exhausted we fail fast with a 429 so the caller can show a friendly
// message instead of hanging.
//
// ⚠️ Keys MUST be from SEPARATE Groq accounts to actually raise throughput —
// keys generated under one account share the same rate-limit bucket.

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

const keyState = GROQ_API_KEYS.map(() => ({ cooldownUntil: 0 }));
let cursor = 0;

const REASONING_RE = /qwen|deepseek|r1/i;
const DEFAULT_CHAT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const DEFAULT_JSON_MODEL = process.env.GROQ_EXTRACT_MODEL || 'llama-3.1-8b-instant';

// Parse Groq's duration strings ("7.66s", "2m59.56s", "500ms") → milliseconds.
function parseDurationMs(s) {
  if (!s) return 0;
  const str = String(s);
  const min = str.match(/([\d.]+)m(?!s)/);
  const ms  = str.match(/([\d.]+)ms/);
  const sec = str.match(/([\d.]+)s(?!.*ms)/);
  let total = 0;
  if (min) total += parseFloat(min[1]) * 60000;
  if (ms)  total += parseFloat(ms[1]);
  else if (sec) total += parseFloat(sec[1]) * 1000;
  return total;
}

// Works for both fetch `Headers` (has .get) and a plain object (axios headers).
function headerGet(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(key);
  return headers[key] ?? headers[key.toLowerCase()] ?? null;
}

function cooldownAfter429(headers) {
  const ra = Number(headerGet(headers, 'retry-after')); // seconds
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60000);
  const reset = parseDurationMs(headerGet(headers, 'x-ratelimit-reset-tokens')
             || headerGet(headers, 'x-ratelimit-reset-requests'));
  return reset > 0 ? Math.min(reset, 60000) : 30000;
}

// Park a key proactively when a SUCCESSFUL response shows it's nearly out, so the
// next request rotates away before it ever 429s.
function noteHeaders(st, headers) {
  const remTokens = Number(headerGet(headers, 'x-ratelimit-remaining-tokens'));
  const remReqs   = Number(headerGet(headers, 'x-ratelimit-remaining-requests'));
  if ((Number.isFinite(remTokens) && remTokens < 1200) ||
      (Number.isFinite(remReqs) && remReqs < 2)) {
    const reset = parseDurationMs(headerGet(headers, 'x-ratelimit-reset-tokens'));
    st.cooldownUntil = Date.now() + (reset > 0 ? Math.min(reset, 60000) : 8000);
  }
}

// Generic rotation runner. `attempt(apiKey, ctx)` performs ONE request with the
// given key. It must resolve with its value on success (and may call
// ctx.onHeaders(headers) so we can read rate-limit budget), or throw an error
// carrying `.status` (and ideally `.headers` / `.response`) on failure.
// 429 / 5xx → park that key and try the next; any other error surfaces at once.
export async function groqRotate(attempt) {
  const n = GROQ_API_KEYS.length;
  if (!n) throw new Error('GROQ_API_KEY not configured');

  let lastErr, attempted = false;
  let soonestIdx = cursor, soonest = Infinity;

  const run = async (idx) => {
    const st = keyState[idx];
    const ctx = { onHeaders: (h) => noteHeaders(st, h) };
    try {
      const value = await attempt(GROQ_API_KEYS[idx], ctx);
      cursor = (idx + 1) % n; // advance round-robin so load spreads evenly
      return { ok: true, value };
    } catch (err) {
      const status = err.status || err.response?.status;
      const headers = err.headers || err.response?.headers;
      if (status === 429)      { st.cooldownUntil = Date.now() + cooldownAfter429(headers); return { ok: false, err }; }
      else if (status >= 500)  { st.cooldownUntil = Date.now() + 5000; return { ok: false, err }; }
      throw err; // non-retryable (bad key / bad request) — failover can't help
    }
  };

  for (let step = 0; step < n; step++) {
    const idx = (cursor + step) % n;
    if (keyState[idx].cooldownUntil > Date.now()) {
      if (keyState[idx].cooldownUntil < soonest) { soonest = keyState[idx].cooldownUntil; soonestIdx = idx; }
      continue; // parked → route around it
    }
    attempted = true;
    const r = await run(idx);
    if (r.ok) return r.value;
    lastErr = r.err;
  }

  if (!attempted) {
    // Every key parked — best shot at whichever recovers soonest.
    const r = await run(soonestIdx);
    if (r.ok) return r.value;
    lastErr = r.err;
  }

  if (!lastErr) { lastErr = new Error('Groq: all keys rate-limited'); lastErr.status = 429; }
  throw lastErr;
}

// Low-level chat-completions POST through the rotation. Returns the parsed body.
async function postChat(body, timeoutMs) {
  return groqRotate(async (apiKey, ctx) => {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }
    ctx.onHeaders(res.headers);
    return res.json();
  });
}

function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')  // closed reasoning blocks
    .replace(/<think>[\s\S]*$/gi, '')           // unclosed (truncated) block
    .replace(/<\/?\s*think\s*>/gi, '')          // stray tags
    .trim();
}

// Chat completion → clean text. Reasoning traces (qwen/deepseek) are auto-disabled.
export async function groqChat(messages, {
  model = DEFAULT_CHAT_MODEL, temperature = 0.7, maxTokens = 800, timeoutMs = 20000,
} = {}) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (REASONING_RE.test(model)) { body.reasoning_effort = 'none'; body.reasoning_format = 'hidden'; }
  const data = await postChat(body, timeoutMs);
  return stripThink(data?.choices?.[0]?.message?.content || '');
}

// JSON-mode completion → parsed object ({} on parse failure). Deterministic (temp 0).
export async function groqJSON(messages, {
  model = DEFAULT_JSON_MODEL, maxTokens = 900, timeoutMs = 20000,
} = {}) {
  const body = { model, messages, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' } };
  const data = await postChat(body, timeoutMs);
  const raw = data?.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}
