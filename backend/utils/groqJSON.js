// Shared Groq JSON-mode helper. Deterministic structured extraction used by
// mentor onboarding (LinkedIn PDF parse) and any other "text → JSON" task.
//
// Thin wrapper over the shared rotating client (utils/groqClient.js) so this
// path also benefits from multi-key round-robin + failover.
import { groqJSON } from './groqClient.js';

export async function callGroqJSON(messages, { maxTokens = 900, model } = {}) {
  return groqJSON(messages, { maxTokens, ...(model ? { model } : {}) });
}

export default callGroqJSON;
