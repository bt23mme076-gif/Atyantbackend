// Time-to-first-audio for the interview voice through OpenRouter.
//
//   node scripts/ttsSpeedTest.js                     main voice (TTS_MAIN_MODEL / TTS_MAIN_VOICE), 20 runs
//   node scripts/ttsSpeedTest.js --backup            the backup voice instead
//   node scripts/ttsSpeedTest.js --runs 30 --text "Okay, tell me more about that."
//   node scripts/ttsSpeedTest.js --save out.wav      also keep the last run's audio, to listen to
//
// Needs OPENROUTER_API_KEY in backend/.env. Runs one request at a time, the way
// live lines are spoken. Recommends the backup model as the main voice if the
// slowest first audio regularly passes ~1 s (never mix voices in one interview).
import 'dotenv/config';
import fs from 'fs';
import { streamSpeech, voiceProblem, wavFromPcm } from '../services/voice/openRouterSpeech.js';
import { voiceConfig, voiceId } from '../services/voice/voiceLines.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const runs = Number(opt('--runs')) || 20;
const text = opt('--text') || 'Okay, walk me through how you built that.';
const save = opt('--save');
const spec = args.includes('--backup') ? voiceConfig().backup : voiceConfig().main;
const SLOW_MS = 1000;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main() {
  const problem = await voiceProblem(spec);
  if (problem) throw new Error(problem);
  console.log(`Voice ${voiceId(spec)} · ${runs} runs · "${text}"\n`);

  const first = [];
  const total = [];
  let failures = 0;
  let lastPcm = [];
  let lastRate = null;
  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now();
    let ttfa = null;
    const pcm = [];
    try {
      for await (const chunk of streamSpeech(text, spec, { timeoutMs: 15000 })) {
        ttfa ??= chunk.firstAudioMs;
        lastRate = chunk.sampleRate;
        pcm.push(chunk.pcm);
      }
      first.push(ttfa);
      total.push(Date.now() - t0);
      lastPcm = pcm;
      console.log(`run ${String(i).padStart(2)}  first audio ${String(ttfa).padStart(5)} ms   complete ${String(Date.now() - t0).padStart(5)} ms`);
    } catch (err) {
      failures++;
      console.log(`run ${String(i).padStart(2)}  FAILED: ${err.message}`);
    }
  }
  if (!first.length) throw new Error('every run failed');

  const f = [...first].sort((a, b) => a - b);
  const t = [...total].sort((a, b) => a - b);
  const slow = first.filter(ms => ms > SLOW_MS).length;
  console.log(`\nfirst audio  median ${pct(f, 50)} ms · p90 ${pct(f, 90)} ms · slowest ${f.at(-1)} ms`);
  console.log(`complete     median ${pct(t, 50)} ms · slowest ${t.at(-1)} ms`);
  console.log(`failures     ${failures}/${runs} · over ${SLOW_MS} ms: ${slow}/${first.length}`);

  if (slow / first.length < 0.2 && !failures) {
    console.log(`\nFirst audio is within target (${SLOW_MS} ms).`);
  } else if (args.includes('--backup')) {
    console.log(`\nFirst audio regularly passes ${SLOW_MS} ms for this voice too. Compare the medians: keep whichever voice is faster as the main one.`);
  } else {
    const { backup } = voiceConfig();
    console.log(`\nFirst audio regularly passes ${SLOW_MS} ms. Run this again with --backup: if ${backup.model} is faster, make it the main voice`
      + ` for the whole interview (TTS_MAIN_MODEL/TTS_MAIN_VOICE). Never mix voices within an interview.`);
  }

  if (save && lastPcm.length) {
    fs.writeFileSync(save, wavFromPcm(Buffer.concat(lastPcm), lastRate));
    console.log(`Saved the last run to ${save} (${lastRate} Hz).`);
  }
}

main().catch(err => { console.error(`Speed test failed: ${err.message}`); process.exit(1); });
