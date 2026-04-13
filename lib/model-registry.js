// lib/model-registry.js — dynamic model resolution for local LM Studio
//
// Resolution order (first match wins):
//   1. model-map.json user override  { "gpt-4o-mini-2024-07-18": "qwen3-8b" }
//   2. Heuristic score against available LM Studio models
//   3. First available model (catch-all)
//
// LM Studio model list is cached for CACHE_TTL_MS to avoid hammering /v1/models.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const LM_HOST     = process.env.LM_HOST || 'localhost';
const LM_PORT     = parseInt(process.env.LM_PORT || '1234', 10);
const CACHE_TTL_MS = 30_000; // re-fetch available models every 30 s

// Models that should never be selected for chat completions
const EXCLUDED_MODELS = new Set([
  'nvidia/nemotron-3-super',
  'text-embedding-nomic-embed-text-v1.5',
]);

// Models that produced garbage in prior sessions but should still be tested
// by the harness. Set INCLUDE_QUARANTINED=1 env var to re-enable them in the relay.
// nemotron-3-nano-4b: harness showed it produces only punctuation/control tokens;
//   usable as last-resort fallback but not worth placing early in candidate list.
// qwen3.5-35b-a3b: MoE model that generates ONLY reasoning_content tokens even
//   with /no_think suffix and enable_thinking=false. LM Studio llama.cpp backend
//   does not implement thinking suppression for this GGUF variant. Use 9b instead.
const QUARANTINED_MODELS = new Set([
  'nvidia/nemotron-3-nano-4b',
  'qwen/qwen3.5-35b-a3b',
]);

// Category-based size preferences
const SMALL_FIRST_CATEGORIES = new Set(['title', 'progress']); // fast/cheap tasks
const LARGE_FIRST_CATEGORIES = new Set(['compaction']);         // large-context tasks

const MODEL_MAP_PATH = path.resolve(__dirname, '..', 'model-map.json');

// ── internal cache ────────────────────────────────────────────────────────────
let _cachedModels = [];     // string[] of available model ids
let _cacheTime    = 0;

function _loadUserMap() {
  try {
    if (fs.existsSync(MODEL_MAP_PATH)) {
      return JSON.parse(fs.readFileSync(MODEL_MAP_PATH, 'utf8'));
    }
  } catch (e) {
    process.stderr.write(`[model-registry] failed to read model-map.json: ${e.message}\n`);
  }
  return {};
}

function _fetchModels() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: LM_HOST, port: LM_PORT, path: '/v1/models', method: 'GET' },
      upstream => {
        const chunks = [];
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const ids = (data.data || []).map(m => m.id).filter(Boolean);
            resolve(ids);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function _getModels() {
  const now = Date.now();
  if (now - _cacheTime < CACHE_TTL_MS && _cachedModels.length > 0) {
    return _cachedModels;
  }
  const models = await _fetchModels();
  if (models.length > 0) {
    _cachedModels = models;
    _cacheTime    = now;
    process.stderr.write(`[model-registry] available: ${models.join(', ')}\n`);
  }
  return _cachedModels; // may still be stale/empty on first-fetch failure
}

// ── size estimator ───────────────────────────────────────────────────────────
// Extract the parameter count in billions from a model id.
// e.g. "qwen/qwen3.5-9b" → 9, "qwen/qwen3.5-35b-a3b" → 35, unknown → 999.

function _estimateSize(modelId) {
  const m = modelId.match(/(\d+(?:\.\d+)?)b/i);
  return m ? parseFloat(m[1]) : 999;
}

// Models whose id ends in '-thinking' have extended reasoning enabled.
// Use as a tiebreaker: non-thinking wins for fast tasks, thinking wins for deep tasks.
function _isThinking(modelId) {
  return /-thinking$/i.test(modelId);
}

// ── heuristic scorer ──────────────────────────────────────────────────────────
// Tokenises both strings on non-alphanumeric chars, counts shared tokens.
// Longer requested-name tokens get higher weight so "gpt-4o-mini" won't
// accidentally score equal to a random "mini" substring.

function _score(requested, candidate) {
  const tokenise = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const rToks = tokenise(requested);
  const cToks = new Set(tokenise(candidate));
  let score = 0;
  for (const t of rToks) {
    if (cToks.has(t)) score += t.length; // weight by token length
  }
  return score;
}

function _bestHeuristic(requested, available) {
  if (available.length === 0) return null;
  let best = available[0];
  let bestScore = _score(requested, available[0]);
  for (let i = 1; i < available.length; i++) {
    const s = _score(requested, available[i]);
    if (s > bestScore) { bestScore = s; best = available[i]; }
  }
  return best;
}

function _filterAvailableModels(allModels, env = process.env) {
  return allModels.filter(model => {
    if (EXCLUDED_MODELS.has(model)) return false;
    if (QUARANTINED_MODELS.has(model) && !env.INCLUDE_QUARANTINED) return false;
    return true;
  });
}

function rankCandidates({ requested, available, userMap = {}, category, env = process.env }) {
  const filtered = _filterAvailableModels(available, env);
  const seen = new Set();
  const list = [];
  const push = model => {
    if (model && !seen.has(model)) {
      seen.add(model);
      list.push(model);
    }
  };

  if (userMap[requested]) push(userMap[requested]);

  if (SMALL_FIRST_CATEGORIES.has(category)) {
    const sorted = [...filtered].sort((a, b) => {
      const sizeDelta = _estimateSize(a) - _estimateSize(b);
      if (sizeDelta !== 0) return sizeDelta;
      return (_isThinking(a) ? 1 : 0) - (_isThinking(b) ? 1 : 0);
    });
    for (const model of sorted) push(model);
  } else if (LARGE_FIRST_CATEGORIES.has(category)) {
    const sorted = [...filtered].sort((a, b) => {
      const sizeDelta = _estimateSize(b) - _estimateSize(a);
      if (sizeDelta !== 0) return sizeDelta;
      return (_isThinking(b) ? 1 : 0) - (_isThinking(a) ? 1 : 0);
    });
    for (const model of sorted) push(model);
  } else {
    if (filtered.includes(requested)) push(requested);
    const scored = filtered
      .map(model => ({ model, score: _score(requested || '', model) }))
      .sort((a, b) => b.score - a.score);
    for (const { model } of scored) push(model);
  }

  if (list.length === 0) push(requested || 'local');
  return list;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns an ordered list of local model ids to try for a given requested id.
 * [0] is the best candidate; subsequent entries are fallbacks in priority order.
 *
 * Resolution order:
 *   1. User override from model-map.json (if non-empty value)
 *   2. Exact match if requested model is already available
 *   3. All remaining available models sorted by heuristic score  (desc)
 *   4. Original requested id as last-ditch passthrough
 *
 * @param {string} requested
 * @returns {Promise<string[]>}
 */
/**
 * @param {string} requested
 * @param {string} [category]  — request category from categorize() in route.js
 * @returns {Promise<string[]>}
 */
async function resolveModelList(requested, category) {
  const userMap   = _loadUserMap();
  const available = await _getModels();
  return rankCandidates({ requested, available, userMap, category });
}

/**
 * Resolve an incoming model identifier to one LM Studio actually has.
 * Returns the best single candidate. Use resolveModelList for retry scenarios.
 *
 * @param {string} requested
 * @returns {Promise<string>}
 */
async function resolveModel(requested) {
  const list = await resolveModelList(requested);
  return list[0];
}

/** Expose cache-busting for tests / status scripts */
function invalidateCache() {
  _cachedModels = [];
  _cacheTime = 0;
}

module.exports = {
  resolveModel,
  resolveModelList,
  invalidateCache,
  _testing: {
    _bestHeuristic,
    _estimateSize,
    _filterAvailableModels,
    _isThinking,
    _score,
    rankCandidates,
  },
};
