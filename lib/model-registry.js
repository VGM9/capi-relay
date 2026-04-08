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
async function resolveModelList(requested) {
  const userMap  = _loadUserMap();
  const available = await _getModels();
  const seen = new Set();
  const list = [];
  const push = m => { if (m && !seen.has(m)) { seen.add(m); list.push(m); } };

  // 1. User override (non-empty)
  if (userMap[requested]) push(userMap[requested]);

  // 2. Exact match
  if (available.includes(requested)) push(requested);

  // 3. All available sorted by heuristic score descending
  const scored = available
    .map(m => ({ m, s: _score(requested || '', m) }))
    .sort((a, b) => b.s - a.s);
  for (const { m } of scored) push(m);

  // 4. Passthrough fallback
  if (list.length === 0) push(requested || 'local');

  return list;
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
  _cacheTime = 0;
}

module.exports = { resolveModel, resolveModelList, invalidateCache };
