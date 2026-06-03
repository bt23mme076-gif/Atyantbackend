// Shared Groq JSON-mode helper. Deterministic structured extraction used by
// mentor onboarding (LinkedIn PDF parse) and any other "text → JSON" task.

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Fast, cheap model with reliable JSON mode.
const GROQ_JSON_MODEL = process.env.GROQ_EXTRACT_MODEL || 'llama-3.1-8b-instant';

export async function callGroqJSON(messages, { maxTokens = 900, model = GROQ_JSON_MODEL } = {}) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq JSON ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

export default callGroqJSON;
