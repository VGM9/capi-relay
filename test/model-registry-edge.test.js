'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _testing } = require('../lib/model-registry');

test('filterAvailableModels excludes quarantined models unless INCLUDE_QUARANTINED is set', () => {
  const allModels = ['good/model', 'nvidia/nemotron-3-nano-4b', 'qwen/qwen3.5-35b-a3b'];

  assert.deepEqual(_testing._filterAvailableModels(allModels, {}), ['good/model']);
  assert.deepEqual(_testing._filterAvailableModels(allModels, { INCLUDE_QUARANTINED: '1' }), allModels);
});

test('rankCandidates falls back to requested or local when nothing is available', () => {
  assert.deepEqual(_testing.rankCandidates({ requested: 'requested-model', available: [], userMap: {}, category: 'user', env: {} }), ['requested-model']);
  assert.deepEqual(_testing.rankCandidates({ requested: '', available: [], userMap: {}, category: 'user', env: {} }), ['local']);
});

test('bestHeuristic returns the first available model when scores tie', () => {
  assert.equal(_testing._bestHeuristic('mini', ['a', 'b', 'c']), 'a');
});