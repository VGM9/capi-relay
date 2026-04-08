#!/usr/bin/env bash
# install/install-linux.sh
# Register capi-relay as a systemd user service (no root needed).
# Run from: bash install/install-linux.sh
# Works on Kali, Ubuntu, Debian. Starts on login; restarts on failure.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/capi-relay.service"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Copilot CAPI relay — routes side-channel completions to local LM Studio
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $REPO_ROOT/capi-relay.js
WorkingDirectory=$REPO_ROOT
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=LM_HOST=localhost
Environment=LM_PORT=1234
Environment=RELAY_PORT=8787

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now capi-relay

echo "capi-relay service installed and started."
echo "Status: systemctl --user status capi-relay"
echo ""
echo "Add to VS Code settings:"
echo '  "github.copilot.advanced.debug.overrideCapiUrl": "http://localhost:8787"'
echo '  "github.copilot.advanced.debug.overrideProxyUrl": "http://localhost:8787"'
