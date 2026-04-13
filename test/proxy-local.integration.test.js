'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

function reloadProxyLocal(port) {
  process.env.LM_HOST = '127.0.0.1';
  process.env.LM_PORT = String(port);
  process.env.MODEL_TIMEOUT_MS = '5000';

  const files = [
    path.resolve(__dirname, '../lib/proxy-local.js'),
    path.resolve(__dirname, '../lib/model-registry.js'),
  ];

  for (const file of files) {
    delete require.cache[file];
  }

  return require('../lib/proxy-local');
}

function createMockResponse() {
  const chunks = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  return {
    headersSent: false,
    statusCode: null,
    headers: null,
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.headersSent = true;
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      resolveDone();
    },
    async wait() {
      await done;
      return Buffer.concat(chunks).toString();
    },
  };
}

test('forwardToLocal retries model candidates, truncates title prompts, and re-emits SSE', async () => {
  const lmCalls = [];
  const savedEnv = {
    LM_HOST: process.env.LM_HOST,
    LM_PORT: process.env.LM_PORT,
    MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3-8b' }, { id: 'local/70b' }] }));
        return;
      }

      const body = JSON.parse(Buffer.concat(chunks).toString());
      lmCalls.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.model === 'qwen/qwen3-8b') {
        res.end('data: [DONE]\n\n');
        return;
      }

      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Short title' }, finish_reason: null }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { forwardToLocal } = reloadProxyLocal(port);
  const res = createMockResponse();
  const longContent = 'x'.repeat(1400);

  try {
    await forwardToLocal({
      model: 'gpt-4o-mini-2024-07-18',
      stream: true,
      messages: [
        { role: 'system', content: 'You are an expert in crafting pithy titles for chatbot conversations.' },
        { role: 'user', content: longContent },
      ],
    }, res, 'title');

    const body = await res.wait();

    assert.equal(res.statusCode, 200);
    assert.equal(lmCalls.length, 2);
    assert.equal(lmCalls[0].model, 'qwen/qwen3-8b');
    assert.match(lmCalls[0].messages[1].content, /\[truncated\] \/no_think$|\[truncated\]\s*\/no_think$/);
    assert.equal(lmCalls[1].model, 'local/70b');
    assert.match(body, /Short title/);
    assert.match(body, /\[DONE\]/);
  } finally {
    process.env.LM_HOST = savedEnv.LM_HOST;
    process.env.LM_PORT = savedEnv.LM_PORT;
    process.env.MODEL_TIMEOUT_MS = savedEnv.MODEL_TIMEOUT_MS;
    await new Promise(resolve => server.close(resolve));
  }
});