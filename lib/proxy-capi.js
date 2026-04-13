// lib/proxy-capi.js — forward user-initiated requests to real Copilot CAPI
// Passes through all headers (including Authorization bearer token).

const http = require('http');
const https = require('https');

function getCapiConfig() {
  const protocol = process.env.CAPI_PROTOCOL || 'https';
  return {
    protocol,
    host: process.env.CAPI_HOST || 'api.githubcopilot.com',
    port: parseInt(process.env.CAPI_PORT || (protocol === 'https' ? '443' : '80'), 10),
    transport: protocol === 'https' ? https : http,
  };
}

/**
 * @param {object|null} body - parsed request body, or null for bodyless requests
 * @param {object} incomingHeaders - headers from the VS Code extension
 * @param {import('http').ServerResponse} res
 * @param {string} reqPath - original request path to forward
 * @param {string} [method] - HTTP method (default: POST)
 */
function forwardToCAPI(body, incomingHeaders, res, reqPath, method = 'POST') {
  const capi = getCapiConfig();
  const payload = body != null ? JSON.stringify(body) : null;

  // Forward all headers except host — set Content-Length only when there is a body
  const headers = Object.assign({}, incomingHeaders, { host: capi.host });
  delete headers['transfer-encoding'];
  if (payload != null) {
    headers['content-length'] = Buffer.byteLength(payload);
  } else {
    delete headers['content-length'];
    delete headers['content-type'];
  }

  const opts = { hostname: capi.host, port: capi.port, path: reqPath || '/chat/completions', method, headers };

  const req = capi.transport.request(opts, upstream => {
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

module.exports = { forwardToCAPI, getCapiConfig };
