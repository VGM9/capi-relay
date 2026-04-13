'use strict';

const http = require('http');
const { whyLocal, categorize } = require('./route');
const { forwardToLocal } = require('./proxy-local');
const { forwardToCAPI } = require('./proxy-capi');
const telemetry = require('./telemetry');

function createRelayServer(deps = {}) {
  const route = deps.route || { whyLocal, categorize };
  const localForwarder = deps.forwardToLocal || forwardToLocal;
  const capiForwarder = deps.forwardToCAPI || forwardToCAPI;
  const logger = deps.logger || (message => process.stderr.write(message));
  const sink = deps.telemetry || telemetry;

  return http.createServer((req, res) => {
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);

      if (req.method !== 'POST' || raw.length === 0) {
        logger(`[relay] CAPI  ${req.method} ${req.url} [no-body]\n`);
        capiForwarder(null, req.headers, res, req.url, req.method);
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

      const { local, discriminator } = route.whyLocal(body, req.headers);
      const category = local ? route.categorize(body, req.headers) : 'user';

      logger(`[relay] ${local ? 'LOCAL' : 'CAPI '} ${req.method} ${req.url} [${discriminator}] <${category}>\n`);
      sink.record(local ? 'LOCAL' : 'CAPI', body, req.url, discriminator);

      if (local) {
        localForwarder(body, res, category).catch(err => {
          logger(`[relay] forwardToLocal error: ${err.message}\n`);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      } else {
        capiForwarder(body, req.headers, res, req.url, req.method);
      }
    });

    req.on('error', err => {
      logger(`[relay] request error: ${err.message}\n`);
    });
  });
}

module.exports = { createRelayServer };