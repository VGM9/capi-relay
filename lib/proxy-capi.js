// lib/proxy-capi.js — forward user-initiated requests to real Copilot CAPI
// Passes through all headers (including Authorization bearer token).
// Uses Node built-in https — zero external deps.

const https = require('https');

const CAPI_HOST = process.env.CAPI_HOST || 'api.githubcopilot.com';

/**
 * @param {object|null} body - parsed request body, or null for bodyless requests
 * @param {object} incomingHeaders - headers from the VS Code extension
 * @param {import('http').ServerResponse} res
 * @param {string} reqPath - original request path to forward
 * @param {string} [method] - HTTP method (default: POST)
 */
function forwardToCAPI(body, incomingHeaders, res, reqPath, method = 'POST') {
  const payload = body != null ? JSON.stringify(body) : null;

  // Forward all headers except host — set Content-Length only when there is a body
  const headers = Object.assign({}, incomingHeaders, { host: CAPI_HOST });
  delete headers['transfer-encoding'];
  if (payload != null) {
    headers['content-length'] = Buffer.byteLength(payload);
  } else {
    delete headers['content-length'];
    delete headers['content-type'];
  }

  const opts = { hostname: CAPI_HOST, port: 443, path: reqPath || '/chat/completions', method, headers };

  const req = https.request(opts, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });

  req.on('error', e => {
    process.stderr.write(`[proxy-capi] error: ${e.message}\n`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'CAPI unavailable', message: e.message }));
  });

  if (payload != null) req.write(payload);
  req.end();
}

module.exports = { forwardToCAPI };
