// run.js — OS-aware polyglot launcher
// Delegates to platform-specific scripts in install/ via a single interface
// Usage: node run.js <script-name>  e.g. node run.js install | node run.js start

const { platform } = require('os');
const { execSync }  = require('child_process');
const path          = require('path');

const script = process.argv[2];
if (!script) {
  console.error('Usage: node run.js <script>');
  console.error('Scripts: install | start | stop | status');
  process.exit(1);
}

const INSTALL = path.resolve(__dirname, 'install');

if (platform() === 'win32') {
  execSync(`powershell -ExecutionPolicy Bypass -File "${path.join(INSTALL, script + '.ps1')}"`,
    { stdio: 'inherit', cwd: __dirname });
} else {
  execSync(`bash "${path.join(INSTALL, script + '.sh')}"`,
    { stdio: 'inherit', cwd: __dirname });
}
