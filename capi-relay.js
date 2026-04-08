// capi-relay.js — LAN-wide Copilot CAPI relay
// Routes side-channel completions (title gen, compaction) to local LM Studio.
// Routes user-initiated requests to real CAPI unchanged.
//
// VS Code settings to enable:
//   "github.copilot.advanced.debug.overrideCapiUrl": "http://localhost:8787"
//   "github.copilot.advanced.debug.overrideProxyUrl": "http://localhost:8787"
//
// Start: node capi-relay.js
// Install as service: see install/ folder

const http = require('http');
const { isLocalRequest, whyLocal } = require('./lib/route');
const { forwardToLocal }  = require('./lib/proxy-local');
const { forwardToCAPI }   = require('./lib/proxy-capi');
const telemetry           = require('./lib/telemetry');

const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    // Non-POST requests (e.g. GET /models) have no JSON body — forward directly to CAPI.
    if (req.method !== 'POST' || raw.length === 0) {
      process.stderr.write(`[relay] CAPI  ${req.method} ${req.url} [no-body]\n`);
      forwardToCAPI(null, req.headers, res, req.url, req.method);
      return;
    }

    let body;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    const { local, discriminator } = whyLocal(body, req.headers);
    process.stderr.write(`[relay] ${local ? 'LOCAL' : 'CAPI '} ${req.method} ${req.url} [${discriminator}]\n`);
    telemetry.record(local ? 'LOCAL' : 'CAPI', body, req.url, discriminator);

    if (local) {
      forwardToLocal(body, res);
    } else {
      forwardToCAPI(body, req.headers, res, req.url, req.method);
    }
  });

  req.on('error', e => {
    process.stderr.write(`[relay] request error: ${e.message}\n`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`[relay] listening on :${PORT}\n`);
  process.stderr.write(`[relay] side-channel → localhost:${process.env.LM_PORT || 1234}\n`);
  process.stderr.write(`[relay] user requests → ${process.env.CAPI_HOST || 'api.githubcopilot.com'}\n`);
});

server.on('error', e => {
  process.stderr.write(`[relay] server error: ${e.message}\n`);
  process.exit(1);
});
