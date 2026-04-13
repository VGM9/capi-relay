// capi-relay.js — LAN-wide Copilot CAPI relay entrypoint

const { createRelayServer } = require('./lib/server');

const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);
const server = createRelayServer();

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`[relay] listening on :${PORT}\n`);
  process.stderr.write(`[relay] side-channel → localhost:${process.env.LM_PORT || 1234}\n`);
  process.stderr.write(`[relay] user requests → ${process.env.CAPI_HOST || 'api.githubcopilot.com'}\n`);
});

server.on('error', err => {
  process.stderr.write(`[relay] server error: ${err.message}\n`);
  process.exit(1);
});
