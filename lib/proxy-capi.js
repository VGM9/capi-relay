// lib/proxy-capi.js — forward user-initiated requests to real Copilot CAPI
// Passes through all headers (including Authorization bearer token).
// Uses Node built-in https — zero external deps.

const https = require('https');

const CAPI_HOST = process.env.CAPI_HOST || 'api.githubcopilot.com';

/**
 * @param {object} body - original request body
 * @param {object} incomingHeaders - headers from the VS Code extension
 * @param {import('http').ServerResponse} res
 * @param {string} reqPath - original request path to forward
 */
function forwardToCAPI(body, incomingHeaders, res, reqPath) {
  const payload = JSON.stringify(body);

  // Forward all headers except host — add correct Content-Length
  const headers = Object.assign({}, incomingHeaders, {
    host:             CAPI_HOST,
    'content-length': Buffer.byteLength(payload),
  });
  delete headers['transfer-encoding'];

  const opts = { hostname: CAPI_HOST, port: 443, path: reqPath || '/chat/completions', method: 'POST', headers };

  const req = https.request(opts, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });

  req.on('error', e => {
    process.stderr.write(`[proxy-capi] error: ${e.message}\n`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'CAPI unavailable', message: e.message }));
  });

  req.write(payload);
  req.end();
}

module.exports = { forwardToCAPI };
