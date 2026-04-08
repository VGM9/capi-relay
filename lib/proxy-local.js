// lib/proxy-local.js — forward a side-channel request to LM Studio at localhost:1234
// Strips Copilot auth headers. Returns OpenAI-compatible response to caller.
// Model indirection: resolves incoming model id via model-registry before forwarding.

const http  = require('http');
const { resolveModel } = require('./model-registry');

const LM_HOST = process.env.LM_HOST || 'localhost';
const LM_PORT = parseInt(process.env.LM_PORT || '1234', 10);

/**
 * @param {object} body - original request body
 * @param {http.ServerResponse} res - response to write to
 */
async function forwardToLocal(body, res) {
  const resolvedModel = await resolveModel(body.model);

  // Strip non-accepted fields Copilot adds that LM Studio may reject
  const localBody = JSON.stringify({
    model:       resolvedModel,
    messages:    body.messages,
    temperature: body.temperature ?? 0.1,
    stream:      false,
  });

  const opts = {
    hostname: LM_HOST,
    port:     LM_PORT,
    path:     '/v1/chat/completions',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(localBody) },
  };

  const req = http.request(opts, upstream => {
    res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
    upstream.pipe(res);
  });

  req.on('error', e => {
    process.stderr.write(`[proxy-local] error: ${e.message}\n`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'LM Studio unavailable', message: e.message }));
  });

  req.write(localBody);
  req.end();
}

module.exports = { forwardToLocal };
