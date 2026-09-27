// Runs candidate code for DSA coding questions through Piston
// (https://github.com/engineer-man/piston), a free open-source sandboxed
// execution API. No API key needed; the public instance rate-limits to a
// few requests/second per IP, so test cases run sequentially with a small
// gap rather than in parallel.
import fetch from 'node-fetch';

const PISTON_URL = process.env.PISTON_API_URL || 'https://emkc.org/api/v2/piston/execute';
const RUN_TIMEOUT_MS = 8000;
const BETWEEN_RUNS_MS = 250;

// Piston's public instance wants an exact version per language; "*" is
// accepted as "latest available" by its /execute endpoint.
export const SUPPORTED_LANGUAGES = {
  javascript: { language: 'javascript', version: '*' },
  python    : { language: 'python',     version: '*' },
  cpp       : { language: 'c++',        version: '*' },
  java      : { language: 'java',       version: '*' }
};

const FILENAMES = { javascript: 'main.js', python: 'main.py', cpp: 'main.cpp', java: 'Main.java' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function execute({ language, source, stdin }) {
  const lang = SUPPORTED_LANGUAGES[language];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  const res = await fetch(PISTON_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      language: lang.language,
      version : lang.version,
      files   : [{ name: FILENAMES[language], content: source }],
      stdin,
      run_timeout: RUN_TIMEOUT_MS
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Piston request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const run = data.run || {};
  const compile = data.compile || {};
  if (compile.code) return { stdout: '', stderr: compile.stderr || compile.output || 'Compile error', timedOut: false };
  return { stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.signal === 'SIGKILL' };
}

const norm = s => String(s || '').trim().replace(/\r\n/g, '\n');

// Runs every test sequentially and stops describing hidden-test detail once
// graded: callers decide how much of the result to expose to the client.
export async function runTestCases({ language, source, tests }) {
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    if (i > 0) await sleep(BETWEEN_RUNS_MS);
    try {
      const { stdout, stderr, timedOut } = await execute({ language, source, stdin: t.input });
      const passed = !stderr && !timedOut && norm(stdout) === norm(t.expected);
      results.push({ hidden: !!t.hidden, passed, stdout, stderr, timedOut });
    } catch (err) {
      results.push({ hidden: !!t.hidden, passed: false, stdout: '', stderr: err.message, timedOut: false });
    }
  }
  return results;
}
