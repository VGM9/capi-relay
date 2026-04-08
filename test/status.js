// test/status.js — print summary of relay.jsonl: counts by route + last 5 entries
const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'relay.jsonl');

if (!fs.existsSync(LOG_FILE)) { console.log('No log file yet. Is the relay running?'); process.exit(0); }

const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const counts = entries.reduce((acc, e) => { acc[e.route] = (acc[e.route] || 0) + 1; return acc; }, {});
const byDisc = entries.reduce((acc, e) => { acc[e.discriminator] = (acc[e.discriminator] || 0) + 1; return acc; }, {});

console.log(`\nRelay telemetry: ${LOG_FILE}`);
console.log(`Total requests: ${entries.length}`);
console.log(`  LOCAL: ${counts.LOCAL || 0}   CAPI: ${counts.CAPI || 0}`);
console.log('\nBy discriminator:');
Object.entries(byDisc).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)}  ${k}`));
console.log('\nLast 5 entries:');
entries.slice(-5).forEach(e => console.log(`  ${e.ts}  ${e.route.padEnd(5)}  ${e.discriminator}`));
console.log('');
