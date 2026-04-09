// lib/route.js — decides whether a request goes to LM Studio or real CAPI
//
// Source truth: chatMLFetcher.ts line ~1334:
//   'X-Initiator': userInitiatedRequest ? 'user' : 'agent'
//
// ALL side-channel requests (title gen, compaction, progressMessages, etc.)
// arrive with X-Initiator: agent. User chat arrives with X-Initiator: user.
// Belt-and-suspenders: title system prompt fallback for stripped-header scenarios.

const TITLE_PROMPT_MARKER = 'expert in crafting pithy titles';

// Known side-channel categories, matched against system prompt content.
// Order matters — first match wins.
const SIDE_CHANNEL_CATEGORIES = [
  ['title',       'expert in crafting pithy titles'],
  ['progress',    'expert in writing short, catchy, and encouraging progress messages'],
  ['compaction',  'compact the following conversation'],
  ['compaction',  'summarize the conversation'],
  ['compaction',  'conversation history'],
  ['agents',      'list of available agents'],
  ['workspace',   'workspace context'],
];

/**
 * Classify what kind of request this is. Useful for logging and future routing.
 * @param {object} body
 * @param {object} headers
 * @returns {string} category name
 */
function categorize(body, headers = {}) {
  const msgs = body?.messages || [];
  const sys  = msgs.find(m => m.role === 'system')?.content || '';
  for (const [name, marker] of SIDE_CHANNEL_CATEGORIES) {
    if (sys.toLowerCase().includes(marker.toLowerCase())) return name;
  }
  const initiator = headers['x-initiator'];
  if (initiator === 'agent') return 'agent-other';
  return 'user';
}

/**
 * @param {object} body - parsed JSON request body
 * @param {object} headers - incoming HTTP request headers (lowercased)
 * @returns {{ local: boolean, discriminator: string }}
 */
function whyLocal(body, headers = {}) {
  const initiator = headers['x-initiator'];
  if (initiator === 'agent') {
    // Agent-mode user chat carries a tools[] array for function calling.
    // Side-channel requests (title, compaction, progress) never have tools.
    // Route tool-bearing requests to CAPI — local models don't handle them reliably.
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return { local: false, discriminator: 'agent-with-tools→CAPI' };
    }
    return { local: true, discriminator: 'x-initiator=agent' };
  }

  const msgs = body.messages || [];
  if (msgs.some(m => m.role === 'system' && m.content?.includes(TITLE_PROMPT_MARKER))) {
    return { local: true, discriminator: 'titlePromptMarker' };
  }
  return { local: false, discriminator: 'user-initiated' };
}

/** @param {object} body @param {object} headers @returns {boolean} */
function isLocalRequest(body, headers) { return whyLocal(body, headers).local; }

module.exports = { isLocalRequest, whyLocal, categorize };
