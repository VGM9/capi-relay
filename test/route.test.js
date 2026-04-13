'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { categorize, whyLocal } = require('../lib/route');

test('whyLocal routes side-channel agent requests to local unless tools are present', () => {
  const body = { messages: [{ role: 'system', content: 'compact the following conversation' }] };

  assert.deepEqual(whyLocal(body, { 'x-initiator': 'agent' }), {
    local: true,
    discriminator: 'x-initiator=agent',
  });

  assert.deepEqual(whyLocal({ ...body, tools: [{ name: 'read_file' }] }, { 'x-initiator': 'agent' }), {
    local: false,
    discriminator: 'agent-with-tools→CAPI',
  });
});

test('whyLocal falls back to the title system prompt marker when headers are missing', () => {
  const body = {
    messages: [{ role: 'system', content: 'You are an expert in crafting pithy titles for programmer conversations.' }],
  };

  assert.deepEqual(whyLocal(body, {}), {
    local: true,
    discriminator: 'titlePromptMarker',
  });
});

test('categorize identifies title, compaction, and default user traffic', () => {
  assert.equal(categorize({ messages: [{ role: 'system', content: 'You are an expert in crafting pithy titles for chatbot conversations.' }] }, {}), 'title');
  assert.equal(categorize({ messages: [{ role: 'system', content: 'Please compact the following conversation history.' }] }, {}), 'compaction');
  assert.equal(categorize({ messages: [] }, { 'x-initiator': 'agent' }), 'agent-other');
  assert.equal(categorize({ messages: [] }, {}), 'user');
});