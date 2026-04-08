// lib/telemetry.js — append-only JSONL request log
// Writes route events to logs/relay.jsonl. No message content. No PII.
// Schema: { ts, route, discriminator, debugName, model, path, userInitiated }

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'relay.jsonl');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * @param {'LOCAL'|'CAPI'} route
 * @param {object} body - original request body
 * @param {string} reqPath - HTTP request path
 * @param {string} discriminator - which rule triggered the route decision
 */
function record(route, body, reqPath, discriminator) {
  ensureDir();
  const entry = {
    ts:            new Date().toISOString(),
    route,
    discriminator,
    debugName:     body.debugName   || null,
    model:         body.model       || null,
    path:          reqPath,
    userInitiated: body.userInitiatedRequest ?? true,
    msgCount:      (body.messages || []).length,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function logPath() { return LOG_FILE; }

module.exports = { record, logPath };
