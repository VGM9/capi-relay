// lib/proxy-local.js — forward a side-channel request to LM Studio at localhost:1234
// Strips Copilot auth headers. Returns OpenAI-compatible response to caller.
// Model indirection: resolves incoming model id via model-registry before forwarding.
// Retry: if a model returns no choices or errors, falls back to next candidate.

const http  = require('http');
const { resolveModelList } = require('./model-registry');

const LM_HOST         = process.env.LM_HOST || 'localhost';
const LM_PORT         = parseInt(process.env.LM_PORT || '1234', 10);
const MODEL_TIMEOUT   = parseInt(process.env.MODEL_TIMEOUT_MS || '120000', 10);

// Per-category default hyperparameters sent to LM Studio.
// repeat_penalty > 1.0 is the primary defence against repetition loops.
// frequency_penalty / presence_penalty (OpenAI compat) are sent alongside
// in case the LM Studio version prefers one format over the other.
// repeat_penalty=1.3 is the empirically determined minimum for gemma-3-4b to
// produce actual letter tokens instead of only newlines on short-output tasks.
// qwen3.5 thinking models run out of tokens at 80 before answering; they'll
// fail and be skipped in the retry loop — no change needed to the param set.
const CATEGORY_PARAMS = {
  title:    { repeat_penalty: 1.30, frequency_penalty: 0.1, presence_penalty: 0.0, temperature: 0.05 },
  progress: { repeat_penalty: 1.30, frequency_penalty: 0.1, presence_penalty: 0.0, temperature: 0.05 },
  default:  { repeat_penalty: 1.10, frequency_penalty: 0.0, presence_penalty: 0.0 },
};

/**
 * Try one model. Returns { ok, data, reason }.
 * @param {string} model
 * @param {object} body
 * @param {object} overrides  — merged over defaults (max_tokens, temperature, repeat_penalty …)
 * @returns {Promise<{ok:boolean, data?:string, reason?:string}>}
 */
function _tryModel(model, body, overrides = {}) {
  return new Promise((resolve) => {
    const localBody = JSON.stringify({
      model,
      messages: body.messages,
      stream:   false,
      ...overrides,                     // category params + max_tokens override body defaults
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
        // Blank content — model generated whitespace-only (e.g. gemma hallucination).
        // Also check reasoning_content: qwen3 no-think mode may put the answer there.
        const msg     = parsed.choices[0]?.message ?? {};
        const content = (msg.content ?? '').trim();
        const reason  = (msg.reasoning_content ?? '').trim();
        if (content.length === 0) {
          // Log first 120 chars so we can see what actually came back
          const snippet = JSON.stringify(raw).slice(0, 200);
          process.stderr.write(`[proxy-local] empty content snippet: ${snippet}\n`);
          if (reason.length > 0) {
            // Promote reasoning_content to content and pass it on
            process.stderr.write(`[proxy-local] using reasoning_content as fallback (${reason.length} chars)\n`);
            parsed.choices[0].message.content = reason;
            resolve({ ok: true, data: JSON.stringify(parsed) });
          } else {
            resolve({ ok: false, reason: 'empty content in response', raw });
          }
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
  const tag = `[${category}]`;

  // Build per-category overrides. Category params override body defaults,
  // then cap max_tokens for lightweight tasks to prevent VRAM waste.
  const catParams = CATEGORY_PARAMS[category] || CATEGORY_PARAMS.default;
  const overrides = {
    temperature:       catParams.temperature    ?? body.temperature    ?? 0.1,
    repeat_penalty:    catParams.repeat_penalty,
    frequency_penalty: catParams.frequency_penalty,
    presence_penalty:  catParams.presence_penalty,
    ...(catParams.max_tokens != null ? { max_tokens: catParams.max_tokens } : {}),
  };
  if (category === 'title' || category === 'progress') overrides.max_tokens = 80;

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
    // Disable chain-of-thought on Qwen3 thinking models for all local requests.
    // Without this they exhaust max_tokens on <think> and return empty content.
    const modelOverrides = { ...overrides };
    if (/qwen.*3|qwen3/i.test(model)) {
      modelOverrides.enable_thinking = false;
    }
    const result = await _tryModel(model, body, modelOverrides);
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

  // For title/progress: return a placeholder rather than 502 so VS Code doesn't
  // surface an error to the user. A blank title is invisible; a 502 breaks the UI.
  if (category === 'title' || category === 'progress') {
    const placeholder = category === 'title' ? 'Chat Session' : 'Working...';
    process.stderr.write(`[proxy-local] ${tag} returning placeholder: "${placeholder}"\n`);
    const fallback = {
      id: 'fallback', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'none', choices: [{ index: 0, message: { role: 'assistant', content: placeholder },
        finish_reason: 'stop' }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
    return;
  }

  res.writeHead(502);
  res.end(lastRaw || JSON.stringify({ error: 'all local models exhausted', tried: candidates }));
}

module.exports = { forwardToLocal };
