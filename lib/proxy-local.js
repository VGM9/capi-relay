// lib/proxy-local.js — forward a side-channel request to LM Studio at localhost:1234
// Strips Copilot auth headers. Returns OpenAI-compatible response to caller.
// Model indirection: resolves incoming model id via model-registry before forwarding.
// Retry: if a model returns no choices or errors, falls back to next candidate.

const http  = require('http');
const { resolveModelList } = require('./model-registry');

const LM_HOST         = process.env.LM_HOST || 'localhost';
const LM_PORT         = parseInt(process.env.LM_PORT || '1234', 10);
const MODEL_TIMEOUT   = parseInt(process.env.MODEL_TIMEOUT_MS || '120000', 10);

// For small/fast categories, cap output to avoid wasting VRAM on long preambles
const SMALL_MAX_TOKENS = 80;
const SMALL_CATEGORIES = new Set(['title', 'progress']);

/**
 * Try one model. Returns { ok, data, reason }.
 * @param {string} model
 * @param {object} body
 * @param {number} [maxTokens]  — optional output cap
 * @returns {Promise<{ok:boolean, data?:string, reason?:string}>}
 */
function _tryModel(model, body, maxTokens) {
  return new Promise((resolve) => {
    const localBody = JSON.stringify({
      model,
      messages:    body.messages,
      temperature: body.temperature ?? 0.1,
      stream:      false,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    });

    const opts = {
      hostname: LM_HOST,
      port:     LM_PORT,
      path:     '/v1/chat/completions',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(localBody) },
    };

    const req = http.request(opts, upstream => {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          resolve({ ok: false, reason: 'invalid JSON response', raw });
          return;
        }
        // LM Studio error response
        if (parsed.error) {
          resolve({ ok: false, reason: parsed.error.message || JSON.stringify(parsed.error), raw });
          return;
        }
        // Empty choices — model crashed or produced nothing
        if (!parsed.choices || parsed.choices.length === 0) {
          resolve({ ok: false, reason: 'no choices in response', raw });
          return;
        }
        resolve({ ok: true, data: raw });
      });
      upstream.on('error', e => resolve({ ok: false, reason: `upstream error: ${e.message}` }));
    });

    req.setTimeout(MODEL_TIMEOUT, () => {
      req.destroy();
      resolve({ ok: false, reason: `timeout after ${MODEL_TIMEOUT}ms` });
    });

    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.write(localBody);
    req.end();
  });
}

/**
 * Forward a side-channel request to LM Studio, retrying down the model
 * candidate list until one succeeds or all are exhausted.
 *
 * @param {object} body - original request body
 * @param {http.ServerResponse} res - response to write to
 * @param {string} [category] - request category for logging (title/progress/etc)
 */
async function forwardToLocal(body, res, category = 'unknown') {
  const candidates = await resolveModelList(body.model, category);
  const maxTokens  = SMALL_CATEGORIES.has(category) ? SMALL_MAX_TOKENS : undefined;
  const tag = `[${category}]`;

  process.stderr.write(
    `[proxy-local] ${tag} candidates for "${body.model}":\n` +
    candidates.map((m, i) => `  ${i === 0 ? '→' : ' '} ${m}`).join('\n') + '\n'
  );

  let lastRaw;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const attempt = `${i + 1}/${candidates.length}`;
    process.stderr.write(`[proxy-local] ${tag} attempt ${attempt}: ${model}\n`);

    const t0     = Date.now();
    const result = await _tryModel(model, body, maxTokens);
    const ms     = Date.now() - t0;

    if (result.ok) {
      process.stderr.write(`[proxy-local] ${tag} success: ${model} (${ms}ms)\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result.data);
      return;
    }

    process.stderr.write(`[proxy-local] ${tag} failed: ${model} — ${result.reason} (${ms}ms)\n`);
    lastRaw = result.raw;
  }

  // All candidates exhausted
  process.stderr.write(`[proxy-local] ${tag} all ${candidates.length} candidate(s) failed\n`);
  res.writeHead(502);
  res.end(lastRaw || JSON.stringify({ error: 'all local models exhausted', tried: candidates }));
}

module.exports = { forwardToLocal };
