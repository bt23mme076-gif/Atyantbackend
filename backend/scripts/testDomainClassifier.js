// ─────────────────────────────────────────────────────────────────────────────
//  Quick isolation test for the LLM role-domain classifier.
//
//  WHY: if the Clarity page still shows an off-domain senior (e.g. a Core
//  Engineering "JSW Steel" card for an SDE goal), the usual cause is that
//  classifyTargetDomain() returned null — the GROQ key is missing or the API
//  failed, so every domain gate in the engine is inert. This script calls the
//  classifier directly (no DB, no embedding service) so you can see exactly
//  what it returns.
//
//  USAGE (from backend/ folder):
//    node scripts/testDomainClassifier.js
//    node scripts/testDomainClassifier.js "mujhe data analyst banna hai"
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import aiService from '../services/AIService.js';

const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'SDE',
      'i want to go for sde',
      'SDE at Google, lack of projects',
      'tech job',
      'mujhe software developer banna hai',
      'data analyst role',
      'core engineering JSW Steel',
      'product manager at a startup',
      'consulting McKinsey',
      'placement ki tayari',        // vague → expect null
    ];

(async () => {
  console.log(`GROQ_API_KEY present : ${process.env.GROQ_API_KEY ? 'YES' : 'NO ❌ (classifier will return null)'}`);
  console.log(`GROQ_MODEL          : ${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile (default)'}`);
  console.log('─'.repeat(60));
  for (const text of cases) {
    const t0 = Date.now();
    const domain = await aiService.classifyTargetDomain(text);
    console.log(`"${text}"`.padEnd(42) + ` → ${domain === null ? 'null' : domain}   (${Date.now() - t0}ms)`);
  }
  console.log('─'.repeat(60));
  console.log('Expected: SDE/tech/software → "Tech", data → "Data Analytics",');
  console.log('core → "Core Engineering", vague → null.');
  console.log('If everything is null, fix GROQ_API_KEY in backend/.env first.');
  process.exit(0);
})();
