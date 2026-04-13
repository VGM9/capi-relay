'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createRelayServer } = require('../lib/server');

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString(),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('relay server routes bodyless, local, CAPI, and invalid JSON requests correctly', async () => {
  const calls = { local: [], capi: [], telemetry: [] };
  const server = createRelayServer({
    forwardToLocal: async (body, res, category) => {
      calls.local.push({ body, category });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ route: 'local', category }));
    },
    forwardToCAPI: (body, headers, res, path, method) => {
      calls.capi.push({ body, headers, path, method });
      res.writeHead(204);
      res.end();
    },
    telemetry: {
      record(route, body, path, discriminator) {
        calls.telemetry.push({ route, body, path, discriminator });
      },
    },
    logger() {},
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const noBody = await request(port, { method: 'GET', path: '/models' });
    assert.equal(noBody.status, 204);
    assert.equal(calls.capi.length, 1);

    const invalid = await request(port, {
      method: 'POST',
      path: '/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(invalid.status, 400);

    const local = await request(port, {
      method: 'POST',
      path: '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'x-initiator': 'agent' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'compact the following conversation' }] }),
    });
    assert.equal(local.status, 200);
    assert.match(local.body, /compaction/);
    assert.equal(calls.local[0].category, 'compaction');

    const capi = await request(port, {
      method: 'POST',
      path: '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'x-initiator': 'agent' },
      body: JSON.stringify({ messages: [], tools: [{ name: 'read_file' }] }),
    });
    assert.equal(capi.status, 204);
    assert.equal(calls.capi.length, 2);
    assert.equal(calls.telemetry[0].route, 'LOCAL');
    assert.equal(calls.telemetry[1].route, 'CAPI');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});