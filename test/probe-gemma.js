// test/probe-gemma.js — direct LM Studio probe for title generation
// Run: node test/probe-gemma.js
'use strict';
const http = require('http');

const SYSTEM_COPILOT = [
  'You are an expert in crafting pithy titles for chatbot conversations.',
  'You are presented with a chat request, and you reply with a brief title that captures the main topic of that request.',
  'Follow Microsoft content policies.',
  'Avoid content that violates copyrights.',
  'If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can\'t assist with that."',
  'Keep your answers short and impersonal.',
  'The title should not be wrapped in quotes. It should be about 8 words or fewer.',
  'Here are some examples of good titles:',
  '- Git rebase question',
  '- Installing Python packages',
].join('\n');

const SYSTEM_SIMPLE = 'You are an expert in crafting pithy titles for programmer conversations. Given a chat, output ONLY the title (6 words max). No quotes, no punctuation, no explanation.';

const SYSTEM_NONE = null;

const USER_SHORT  = 'Please write a brief title for the following request:\n\nHow do I fix a 502 bad gateway in Node.js?';

function msgs(userContent, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  out.push({ role: 'user', content: userContent });
  return out;
}

const BASE = { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 150 };

const CASES = [
  { label: 'copilot system prompt',    messages: msgs(USER_SHORT, SYSTEM_COPILOT), params: BASE },
  { label: 'simple system prompt',     messages: msgs(USER_SHORT, SYSTEM_SIMPLE),  params: BASE },
  { label: 'no system prompt',         messages: msgs(USER_SHORT, SYSTEM_NONE),    params: BASE },
  { label: 'enable_thinking=false',    messages: msgs(USER_SHORT, SYSTEM_SIMPLE),  params: { ...BASE, enable_thinking: false } },
  { label: 'no max_tokens',            messages: msgs(USER_SHORT, SYSTEM_SIMPLE),  params: { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1 } },
  { label: 'temp=0.7',                 messages: msgs(USER_SHORT, SYSTEM_SIMPLE),  params: { ...BASE, temperature: 0.7 } },
];
  return new Promise(resolve => {
    const body = JSON.stringify({ model, stream: false, messages, ...params });
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
          resolve({ finish: j.choices?.[0]?.finish_reason, content: j.choices?.[0]?.message?.content ?? '', error: j.error?.message });
        } catch (e) {
          resolve({ error: 'json-parse: ' + e.message });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

function msgs(userContent) {
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }];
}

function show(label, r) {
  const out = r.error ? `ERR: ${r.error}` : `[${r.finish}] ${JSON.stringify(r.content).slice(0, 80)}`;
  console.log(`  ${label.padEnd(30)} ${out}`);
}

const MODELS = ['google/gemma-3-4b', 'qwen/qwen3.5-9b', 'qwen/qwen3.5-35b-a3b'];

const CASES = [
  { label: 'short / baseline',       user: USER_SHORT,  params: { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 150 } },
  { label: 'short / rp=1.1',         user: USER_SHORT,  params: { temperature: 0.1, repeat_penalty: 1.1, frequency_penalty: 0.0, max_tokens: 150 } },
  { label: 'short / no freq_pen',    user: USER_SHORT,  params: { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.0, max_tokens: 150 } },
  { label: 'short / temp=0.7',       user: USER_SHORT,  params: { temperature: 0.7, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 150 } },
  { label: 'medium (1200c)',          user: USER_MEDIUM, params: { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 150 } },
  { label: 'long (5000c)',            user: USER_LONG,   params: { temperature: 0.1, repeat_penalty: 1.3, frequency_penalty: 0.1, max_tokens: 150 } },
];

(async () => {
  for (const model of MODELS) {
    console.log(`\n── ${model}`);
    for (const c of CASES) {
      const r = await post(model, msgs(c.user), c.params);
      show(c.label, r);
    }
  }
  console.log('\ndone.');
})();
