// test/watch.js — tail relay.jsonl and print each event as it arrives
// Usage: node test/watch.js

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'relay.jsonl');
const LOG_DIR  = path.dirname(LOG_FILE);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');

let offset = fs.statSync(LOG_FILE).size;

console.log(`Watching ${LOG_FILE} ...`);
console.log('─'.repeat(72));

fs.watchFile(LOG_FILE, { interval: 250 }, () => {
  const stat = fs.statSync(LOG_FILE);
  if (stat.size <= offset) return;

  const chunk = Buffer.alloc(stat.size - offset);
  const fd    = fs.openSync(LOG_FILE, 'r');
  fs.readSync(fd, chunk, 0, chunk.length, offset);
  fs.closeSync(fd);
  offset = stat.size;

  chunk.toString('utf8').trim().split('\n').filter(Boolean).forEach(line => {
    try {
      const e = JSON.parse(line);
      const badge = e.route === 'LOCAL' ? '\x1b[32mLOCAL\x1b[0m' : '\x1b[33mCAPI \x1b[0m';
      console.log(`${e.ts}  ${badge}  ${e.discriminator.padEnd(32)} debugName=${e.debugName || '-'}`);
    } catch {
      console.log(line);
    }
  });
});

process.on('SIGINT', () => { fs.unwatchFile(LOG_FILE); process.exit(0); });
