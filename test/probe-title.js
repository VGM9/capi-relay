// test/probe-title.js — find what makes local models produce title output
// Run: node test/probe-title.js
'use strict';
const http = require('http');

const SYSTEM_COPILOT = [
  'You are an expert in crafting pithy titles for chatbot conversations.',
  'You are presented with a chat request, and you reply with a brief title that captures the main topic of that request.',
  'Follow Microsoft content policies.',
  'Avoid content that violates copyrights.',
  'Keep your answers short and impersonal.',
  'The title should not be wrapped in quotes. It should be about 8 words or fewer.',
  'Here are some examples of good titles:',
  '- Git rebase question',
  '- Installing Python packages',
].join('\n');

const SYSTEM_SIMPLE =
  'You are an expert in crafting pithy titles for programmer conversations. ' +
  'Given a chat, output ONLY the title (6 words max). No quotes, no explanation.';

const USER = 'Please write a brief title for the following request:\n\nHow do I fix a 502 bad gateway in Node.js?';

const BASE = { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 4096, stream: false };

const CASES = [
  { label: 'simple prompt',             sys: SYSTEM_SIMPLE,  params: BASE },
  { label: 'simple + no_think suffix',  sys: SYSTEM_SIMPLE,  params: BASE,  noThink: true },
  { label: 'copilot + no_think suffix', sys: SYSTEM_COPILOT, params: BASE,  noThink: true },
  { label: 'no system + no_think',      sys: null,           params: BASE,  noThink: true },
];

const MODELS = ['google/gemma-3-4b', 'qwen/qwen3.5-9b', 'qwen/qwen3.5-35b-a3b'];

function callLM(model, messages, params) {
  return new Promise(resolve => {
    const body = JSON.stringify({ model, messages, ...params });
    const req = http.request({
      hostname: 'localhost', port: 1234,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          resolve({
            finish:          j.choices?.[0]?.finish_reason ?? '?',
            content:         j.choices?.[0]?.message?.content ?? '',
            reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
            completionTokens: j.usage?.completion_tokens ?? 0,
            error:           j.error?.message,
          });
        } catch (e) {
          resolve({ error: 'json-parse: ' + e.message });
        }
      });
    });
    req.setTimeout(45000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

function show(label, r) {
  const out = r.error
    ? `ERR: ${r.error}`
    : `[${r.finish}] think=${r.reasoningTokens} out=${r.completionTokens} ${JSON.stringify(r.content).slice(0, 60)}`;
  console.log(`  ${label.padEnd(30)} ${out}`);
}

(async () => {
  for (const model of MODELS) {
    console.log(`\n── ${model}`);
    for (const c of CASES) {
      const messages = [];
      if (c.sys) messages.push({ role: 'system', content: c.sys });
      const userContent = c.noThink ? USER + ' /no_think' : USER;
      messages.push({ role: 'user', content: userContent });
      const r = await callLM(model, messages, c.params);
      show(c.label, r);
    }
  }
  console.log('\ndone.');
})();
