'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _testing } = require('../lib/model-registry');

test('estimateSize parses common GGUF model identifiers correctly', () => {
  assert.equal(_testing._estimateSize('qwen/qwen3.5-35b-a3b'), 35);
  assert.equal(_testing._estimateSize('local/something-7b-thinking'), 7);
  assert.equal(_testing._estimateSize('mystery-model'), 999);
});

test('rankCandidates prefers small non-thinking models for title work and honors overrides', () => {
  const list = _testing.rankCandidates({
    requested: 'gpt-4o-mini-2024-07-18',
    available: ['local/70b-thinking', 'local/7b-thinking', 'local/7b', 'qwen/qwen3.5-35b-a3b'],
    userMap: { 'gpt-4o-mini-2024-07-18': 'override/model' },
    category: 'title',
    env: {},
  });

  assert.deepEqual(list, ['override/model', 'local/7b', 'local/7b-thinking', 'local/70b-thinking']);
});

test('rankCandidates prefers large thinking models first for compaction', () => {
  const list = _testing.rankCandidates({
    requested: 'gpt-4o-2024-11-20',
    available: ['local/7b', 'local/70b-thinking', 'local/70b'],
    userMap: {},
    category: 'compaction',
    env: {},
  });

  assert.deepEqual(list, ['local/70b-thinking', 'local/70b', 'local/7b']);
});

test('rankCandidates falls back to exact match and heuristic order for ordinary user traffic', () => {
  const list = _testing.rankCandidates({
    requested: 'gpt-4o-mini',
    available: ['other/model', 'gpt-4o-mini', 'mini-helper'],
    userMap: {},
    category: 'user',
    env: {},
  });

  assert.deepEqual(list, ['gpt-4o-mini', 'mini-helper', 'other/model']);
});