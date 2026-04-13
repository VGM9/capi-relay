'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _testing } = require('../lib/proxy-local');

test('_appendNoThink is idempotent and only touches the last user message', () => {
  const original = [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: 'assistant' },
    { role: 'user', content: 'hello' },
  ];

  const once = _testing._appendNoThink(original);
  const twice = _testing._appendNoThink(once);

  assert.equal(original[2].content, 'hello');
  assert.equal(once[2].content, 'hello /no_think');
  assert.equal(twice[2].content, 'hello /no_think');
  assert.equal(once[0].content, 'system');
  assert.equal(once[1].content, 'assistant');
});

test('_truncateForTitle truncates only the final user message', () => {
  const messages = [
    { role: 'user', content: 'short' },
    { role: 'assistant', content: 'keep me' },
    { role: 'user', content: 'x'.repeat(1300) },
  ];

  const out = _testing._truncateForTitle(messages);

  assert.equal(out[0].content, 'short');
  assert.equal(out[1].content, 'keep me');
  assert.match(out[2].content, /\[truncated\]$/);
  assert.ok(out[2].content.length < messages[2].content.length);
});