// test/verify.js — assert that specific LOCAL route events exist in the relay log
// Usage: node test/verify.js [--since <ISO>] [--discriminator <name>] [--timeout <ms>]
//
// Tests:
//   1. title side-channel: routed LOCAL via x-initiator=agent or titlePromptMarker fallback
//   2. compaction side-channel: routed LOCAL via x-initiator=agent
//   3. agent-with-tools request: routed CAPI to avoid leaking tool-calling chats to local models
//
// Exit codes: 0=all asserted tests passed, 1=timeout or assertion failure

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'relay.jsonl');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null;
}

const since       = flag('--since') ? new Date(flag('--since')) : new Date(Date.now() - 60 * 1000);
const discriminator = flag('--discriminator') || null;
const timeoutMs   = parseInt(flag('--timeout') || '30000', 10);

const TESTS = [
  { name: 'title-side-channel',      match: e => e.route === 'LOCAL' && e.discriminator === 'x-initiator=agent' && e.path.includes('chat') },
  { name: 'title-marker-fallback',   match: e => e.route === 'LOCAL' && e.discriminator === 'titlePromptMarker' },
  { name: 'compaction-side-channel', match: e => e.route === 'LOCAL' && e.discriminator === 'x-initiator=agent' },
  { name: 'agent-with-tools-capi',   match: e => e.route === 'CAPI'  && e.discriminator === 'agent-with-tools→CAPI' },
];

const activeTests = discriminator
  ? TESTS.filter(t => t.name.includes(discriminator))
  : TESTS.slice(0, 1);  // default: assert title test only

function readEntries() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(e => new Date(e.ts) >= since);
}

function check() {
  const entries = readEntries();
  const results = activeTests.map(t => ({
    name:   t.name,
    passed: entries.some(t.match),
  }));
  return results;
}

const deadline = Date.now() + timeoutMs;

function poll() {
  const results = check();
  const pending = results.filter(r => !r.passed);

  if (pending.length === 0) {
    results.forEach(r => console.log(`PASS  ${r.name}`));
    process.exit(0);
  }

  if (Date.now() >= deadline) {
    results.forEach(r => console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`));
    console.error(`\nTimeout after ${timeoutMs}ms. Log: ${LOG_FILE}`);
    process.exit(1);
  }

  setTimeout(poll, 500);
}

console.log(`Watching: ${LOG_FILE}`);
console.log(`Since: ${since.toISOString()}`);
console.log(`Tests: ${activeTests.map(t => t.name).join(', ')}`);
console.log('---');
poll();
