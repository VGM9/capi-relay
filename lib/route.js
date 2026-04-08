// lib/route.js — decides whether a request goes to LM Studio or real CAPI
//
// Source truth: chatMLFetcher.ts line ~1334:
//   'X-Initiator': userInitiatedRequest ? 'user' : 'agent'
//
// ALL side-channel requests (title gen, compaction, progressMessages, etc.)
// arrive with X-Initiator: agent. User chat arrives with X-Initiator: user.
// Belt-and-suspenders: title system prompt fallback for stripped-header scenarios.

const TITLE_PROMPT_MARKER = 'expert in crafting pithy titles';

/**
 * @param {object} body - parsed JSON request body
 * @param {object} headers - incoming HTTP request headers (lowercased)
 * @returns {{ local: boolean, discriminator: string }}
 */
function whyLocal(body, headers = {}) {
  const initiator = headers['x-initiator'];
  if (initiator === 'agent') return { local: true, discriminator: 'x-initiator=agent' };

  const msgs = body.messages || [];
  if (msgs.some(m => m.role === 'system' && m.content?.includes(TITLE_PROMPT_MARKER))) {
    return { local: true, discriminator: 'titlePromptMarker' };
  }
  return { local: false, discriminator: 'user-initiated' };
}

/** @param {object} body @param {object} headers @returns {boolean} */
function isLocalRequest(body, headers) { return whyLocal(body, headers).local; }

module.exports = { isLocalRequest, whyLocal };
