// Claude (Anthropic) client — used only for the Atyant engine chat reply.
// Everything else (JSON extraction, roadmap, cover letters, audio) stays on Groq.
import Anthropic from '@anthropic-ai/sdk';

const CHAT_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  if (!client) client = new Anthropic({ timeout: 30000 });
  return client;
}

// Accepts the same OpenAI-format array the Groq path used (system + turns),
// streams text via onToken, and resolves with the full reply.
export async function claudeChatStream(messages, { maxTokens = 2048, onToken } = {}) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  while (turns.length && turns[0].role === 'assistant') turns.shift();

  const stream = getClient().messages.stream({
    model: CHAT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: turns,
    output_config: { effort: 'low' },
  });
  stream.on('text', (text) => onToken?.(text));

  const final = await stream.finalMessage();
  return final.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
