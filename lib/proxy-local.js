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

// Title/progress requests from Copilot contain the full conversation history
// (up to 12K tokens). Local models have small context windows (gemma=4K).
// Truncate the last user message to this many characters before forwarding.
const TITLE_USER_MSG_CHAR_LIMIT = 1200;

/**
 * For title/progress requests, truncate the last user message so local models
 * with small context windows (e.g. gemma-3-4b ~4K tokens) don't overflow.
 * A title only needs the first exchange, not the full history.
 */
function _truncateForTitle(messages) {
  if (!messages || messages.length === 0) return messages;
  const out = messages.map(m => ({ ...m }));
  // Find the last user message and cap its content
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user' && typeof out[i].content === 'string') {
      if (out[i].content.length > TITLE_USER_MSG_CHAR_LIMIT) {
        out[i].content = out[i].content.slice(0, TITLE_USER_MSG_CHAR_LIMIT) + '\n[truncated]';
      }
      break;
    }
  }
  return out;
}

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
        // Blank content — model generated whitespace-only or leaked thinking tokens.
        const content = (parsed.choices[0]?.message?.content ?? '').trim();
        if (content.length === 0) {
          const rawContent = parsed.choices[0]?.message?.content ?? '';
          const finish     = parsed.choices[0]?.finish_reason ?? '?';
          process.stderr.write(`[proxy-local] empty content (finish=${finish}) raw=${JSON.stringify(rawContent).slice(0, 80)}\n`);
          resolve({ ok: false, reason: 'empty content in response', raw });
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
 * Convert a non-streaming chat.completion JSON object into SSE chunks and
 * write them to res. Used when the Copilot client sent stream:true but we
 * collected the full response from LM Studio as stream:false.
 */
function _sendAsSSE(res, completion) {
  const id      = completion.id || 'relay';
  const created = completion.created || Math.floor(Date.now() / 1000);
  const model   = completion.model || 'none';
  const content = completion.choices?.[0]?.message?.content ?? '';
  const finish  = completion.choices?.[0]?.finish_reason ?? 'stop';

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  // Role chunk
  const roleChunk = JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  res.write(`data: ${roleChunk}\n\n`);

  // Content chunk
  if (content.length > 0) {
    const contentChunk = JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
    res.write(`data: ${contentChunk}\n\n`);
  }

  // Stop chunk
  const stopChunk = JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  });
  res.write(`data: ${stopChunk}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
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
  const streaming = !!body.stream;
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
  if (category === 'title' || category === 'progress') overrides.max_tokens = 4096;

  // Truncate the conversation for title/progress so small-context models
  // (gemma ~4K tokens) don't overflow on Copilot's 12K+ token history.
  const messages = (category === 'title' || category === 'progress')
    ? _truncateForTitle(body.messages)
    : body.messages;

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
    const result = await _tryModel(model, { ...body, messages }, modelOverrides);
    const ms     = Date.now() - t0;

    if (result.ok) {
      process.stderr.write(`[proxy-local] ${tag} success: ${model} (${ms}ms)\n`);
      if (streaming) {
        _sendAsSSE(res, JSON.parse(result.data));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result.data);
      }
      return;
    }

    process.stderr.write(`[proxy-local] ${tag} failed: ${model} — ${result.reason} (${ms}ms)\n`);
    lastRaw = result.raw;
  }

  // All candidates exhausted — return 502 and let the caller use its own fallback.
  process.stderr.write(`[proxy-local] ${tag} all ${candidates.length} candidate(s) failed\n`);
  res.writeHead(502);
  res.end(lastRaw || JSON.stringify({ error: 'all local models exhausted', tried: candidates }));
}

module.exports = { forwardToLocal };
