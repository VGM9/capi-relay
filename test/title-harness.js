// test/title-harness.js — hyperparameter dial-in for local models
//
// Tests each LM Studio model against a real-world title request, sweeping
// key hyperparameters to find what produces clean titles vs garbage.
//
// Usage:
//   node test/title-harness.js                      # all models, short prompt
//   node test/title-harness.js --long               # include long-prompt run
//   node test/title-harness.js --model qwen/qwen3.5-9b
//   node test/title-harness.js --param repeat_penalty=1.3
//   node test/title-harness.js --only baseline      # run only one sweep label

'use strict';
const http = require('http');

const LM_HOST    = process.env.LM_HOST || 'localhost';
const LM_PORT    = parseInt(process.env.LM_PORT || '1234', 10);
const TIMEOUT_MS = parseInt(process.env.HARNESS_TIMEOUT || '30000', 10);

// ── Prompts ───────────────────────────────────────────────────────────────────
// The system prompt uses the actual VS Code marker so it exercises the
// same code path the relay intercepts.
const SYSTEM_PROMPT =
  'You are an expert in crafting pithy titles for programmer conversations. ' +
  'Given a chat, output ONLY the title (≤ 6 words). No quotes, no punctuation, no explanation.';

const CONVERSATIONS = {
  short: [
    { role: 'user',      content: 'How do I fix a 502 bad gateway in Node.js when my upstream returns garbage JSON?' },
    { role: 'assistant', content: 'A 502 usually means the upstream returned an unparseable response. Check the raw body, add error handling around JSON.parse, and log the status code from upstream before you close the response.' },
  ],

  relay: [
    { role: 'user',      content: 'I am building a VS Code Copilot proxy relay in Node.js. It sits at localhost:8787 and routes side-channel completions (title generation, compaction, progress messages) to local LM Studio while forwarding user-chat requests to the real GitHub API. I need model name translation since Copilot sends names like gpt-4o-mini-2024-07-18.' },
    { role: 'assistant', content: 'For model name translation you can maintain a map and a heuristic scorer that tokenizes the requested name and finds the best match among whatever models LM Studio has loaded. Cache the /v1/models list with a 30s TTL.' },
    { role: 'user',      content: 'Now qwen3.5-35b keeps OOMing on large prompts. Do I need per-category routing so small tasks go to smaller models?' },
    { role: 'assistant', content: 'Yes. Classify the system prompt to detect title, progress, compaction, etc. For title and progress prefer the cheapest model first. For compaction prefer large context windows. Track which models produce garbage and exclude them automatically.' },
  ],
};

// ── Param sweep ───────────────────────────────────────────────────────────────
// Each config is tried for every model × every conversation.
// Columns: label, temperature, repeat_penalty, frequency_penalty, presence_penalty
// noThink: adds "/no_think" to the user message (Qwen3 thinking-disable protocol)
// enableThinking: false: adds enable_thinking:false to request body (LM Studio extension)
const SWEEP = [
  { label: 'baseline',           temperature: 0.1,  repeat_penalty: 1.0, frequency_penalty: 0.0, presence_penalty: 0.0 },
  { label: 'rp=1.1',             temperature: 0.1,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0 },
  { label: 'rp=1.3',             temperature: 0.1,  repeat_penalty: 1.3, frequency_penalty: 0.0, presence_penalty: 0.0 },
  { label: 'fp=0.1',             temperature: 0.1,  repeat_penalty: 1.0, frequency_penalty: 0.1, presence_penalty: 0.0 },
  { label: 'fp=0.3',             temperature: 0.1,  repeat_penalty: 1.0, frequency_penalty: 0.3, presence_penalty: 0.0 },
  { label: 't=0 rp=1.1',         temperature: 0.0,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0 },
  { label: 't=0.3 rp=1.1',       temperature: 0.3,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0 },
  // Qwen3 thinking-model specific — these two should unlock output from qwen3.x
  { label: 'no_think',           temperature: 0.1,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0, noThink: true },
  { label: 'no_think t=0.3',     temperature: 0.3,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0, noThink: true },
  { label: 'disable_thinking',   temperature: 0.1,  repeat_penalty: 1.1, frequency_penalty: 0.0, presence_penalty: 0.0, enableThinking: false },
];

// ── Quality grader ────────────────────────────────────────────────────────────
const GARBAGE_RE = /(\b\w+\b)(?:\s+\1){2,}/i; // same word 3+ times in a row

function grade(content) {
  if (!content || content.trim().length === 0) return { g: 'EMPTY', n: 'blank' };

  const t = content.trim();

  // Must contain at least one letter — pure punctuation/newlines = empty
  if (!/[a-zA-Z]/.test(t)) return { g: 'EMPTY', n: 'no letters' };

  // Detect non-ASCII clutter first (multilingual hallucination)
  const nonAscii = (t.match(/[^\x00-\x7F]/g) || []).length;
  if (nonAscii > 3) return { g: 'GARBLE', n: `${nonAscii} non-ASCII chars` };

  // Detect simple repetition loops
  if (GARBAGE_RE.test(t)) {
    const m = t.match(GARBAGE_RE);
    return { g: 'LOOP', n: `"${m[1]}" repeating` };
  }

  // Count only tokens that contain at least one letter (filter pure-punctuation tokens)
  const realWords = t.split(/\s+/).filter(w => /[a-zA-Z]/.test(w));
  if (realWords.length === 0) return { g: 'EMPTY', n: 'no letter-words' };

  // Detect high frequency repetition across real words
  const freq = {};
  for (const w of realWords) { freq[w.toLowerCase()] = (freq[w.toLowerCase()] || 0) + 1; }
  const maxF = Math.max(...Object.values(freq));
  const maxW = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  if (maxF >= 3 && realWords.length > 4) {
    return { g: 'LOOP', n: `"${maxW}" ×${maxF}` };
  }

  if (realWords.length > 12) return { g: 'VERBOSE', n: `${realWords.length} words` };
  if (realWords.length <= 7) return { g: '✓ GOOD',  n: `${realWords.length} words` };
  return                            { g: 'OK',       n: `${realWords.length} words` };
}

// ── Network helpers ───────────────────────────────────────────────────────────
function httpPost(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: LM_HOST, port: LM_PORT,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try   { resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ ok: false, reason: 'json-parse' }); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, reason: `timeout ${TIMEOUT_MS}ms` }); });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.write(payload);
    req.end();
  });
}

async function fetchModels() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: LM_HOST, port: LM_PORT, path: '/v1/models', method: 'GET' },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve((data.data || []).map(m => m.id));
          } catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────
const COL = {
  label: 18,
  grade: 8,
  note:  24,
  ms:    7,
};

function row(label, g, n, ms, preview) {
  const lPad = label.padEnd(COL.label);
  const gPad = g.padEnd(COL.grade);
  const nPad = n.padEnd(COL.note);
  const mPad = String(ms + 'ms').padEnd(COL.ms);
  return `    ${lPad} ${gPad} ${nPad} ${mPad}  "${preview}"`;
}

async function runModel(model, convLabel, messages, only) {
  const header = `  ── ${model}  [${convLabel}]`;
  console.log('\n' + header);
  console.log('  ' + '─'.repeat(header.length));

  const configs = only ? SWEEP.filter(s => s.label === only) : SWEEP;
  if (configs.length === 0) {
    console.log(`  No sweep entry matches --only "${only}"`);
    return;
  }

  for (const p of configs) {
    // Build messages — for noThink, append /no_think to the last user message
    let msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
    if (p.noThink) {
      msgs = msgs.map((m, i) =>
        (i === msgs.length - 1 && m.role === 'user')
          ? { ...m, content: m.content + ' /no_think' }
          : m
      );
    }

    const reqBody = {
      model,
      messages: msgs,
      max_tokens: 50,
      stream: false,
      temperature:       p.temperature,
      repeat_penalty:    p.repeat_penalty,
      frequency_penalty: p.frequency_penalty,
      presence_penalty:  p.presence_penalty,
    };
    // LM Studio extension for Qwen3 thinking models
    if (p.enableThinking === false) reqBody.enable_thinking = false;

    const t0  = Date.now();
    const res = await httpPost(reqBody);
    const ms  = Date.now() - t0;

    if (!res.ok) {
      console.log(row(p.label, 'ERR', res.reason, ms, ''));
      continue;
    }
    if (res.data.error) {
      const msg = (res.data.error.message || JSON.stringify(res.data.error)).slice(0, 50);
      console.log(row(p.label, 'ERR', msg, ms, ''));
      continue;
    }
    if (!res.data.choices?.length) {
      console.log(row(p.label, 'EMPTY', 'no choices', ms, ''));
      continue;
    }

    const content = res.data.choices[0]?.message?.content ?? '';
    const { g, n } = grade(content);
    const preview  = content.replace(/\n/g, '↵').slice(0, 55);
    console.log(row(p.label, g, n, ms, preview));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const has  = (flag) => args.includes(flag);

  const modelArg  = get('--model');
  const onlyArg   = get('--only');
  const doLong    = has('--long') || has('--relay');

  // Excluded from sweep (same list as relay)
  const EXCLUDED = new Set(['nvidia/nemotron-3-super', 'text-embedding-nomic-embed-text-v1.5']);

  let models = await fetchModels();
  if (models.length === 0) {
    console.error(`ERROR: No models from LM Studio at ${LM_HOST}:${LM_PORT}. Is it running?`);
    process.exit(1);
  }

  if (modelArg) {
    models = [modelArg];
  } else {
    models = models.filter(m => !EXCLUDED.has(m));
  }

  console.log('═'.repeat(80));
  console.log('  capi-relay title-harness — hyperparameter sweep');
  console.log('═'.repeat(80));
  console.log(`  LM Studio:   ${LM_HOST}:${LM_PORT}`);
  console.log(`  Models:      ${models.join(', ')}`);
  console.log(`  Timeout:     ${TIMEOUT_MS}ms per request`);
  console.log(`  Sweep:       ${onlyArg ? `only "${onlyArg}"` : SWEEP.map(s => s.label).join(', ')}`);
  console.log('─'.repeat(80));
  console.log(`  ${'label'.padEnd(COL.label)} ${'grade'.padEnd(COL.grade)} ${'note'.padEnd(COL.note)} ${'ms'.padEnd(COL.ms)}  output`);
  console.log('─'.repeat(80));

  for (const model of models) {
    await runModel(model, 'short', CONVERSATIONS.short, onlyArg);
    if (doLong) {
      await runModel(model, 'relay', CONVERSATIONS.relay, onlyArg);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  LEGEND: ✓ GOOD = clean title ≤7 words | LOOP = repetition | GARBLE = non-ASCII');
  console.log('  TIP:    If baseline LOOP but rp=1.1 is ✓ GOOD → add repeat_penalty to proxy-local.js');
  console.log('  TIP:    If GARBLE → model needs a stronger system prompt or smaller context');
  console.log('═'.repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
