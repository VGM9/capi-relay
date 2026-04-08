#!/usr/bin/env bash
# install/start.sh — start relay (used by node run.js start on Linux/Kali)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export RELAY_PORT=8787 LM_HOST=localhost LM_PORT=1234
node "$REPO_ROOT/capi-relay.js"
