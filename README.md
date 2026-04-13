# capi-relay

Routes Copilot side-channel completions (title generation, context compaction) to a local LM Studio instance instead of GitHub's servers. User-initiated chat completions pass through to Copilot unchanged.

Designed for LAN use: run on the machine with the GPU, point VS Code on any machine at it.

## How it works

VS Code Copilot supports debug override URLs that redirect all completion traffic to a local proxy. This relay inspects each request and either:
- **Forwards to LM Studio** (`:1234`) — background tasks like title generation and compaction
- **Forwards to CAPI** (`api.githubcopilot.com`) — everything else, transparently

## Requirements

- Node.js (any recent LTS)
- LM Studio running on the same machine, serving on port 1234

## Install

### Windows (as a scheduled task — starts at login)

```powershell
# Run as Administrator from the repo root
.\install\install-windows.ps1
```

### Linux (as a systemd user service)

```bash
bash install/install-linux.sh
```

### Manual (foreground, for testing)

```
npm start
```

## VS Code settings

Add to `settings.json` on every machine that should use the relay:

```json
"github.copilot.advanced.debug.overrideCapiUrl": "http://<relay-host-ip>:8787",
"github.copilot.advanced.debug.overrideProxyUrl": "http://<relay-host-ip>:8787"
```

If the relay is on the same machine as VS Code, use `localhost`. For a remote GPU machine, use its LAN IP.

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `8787` | Port the relay listens on |
| `LM_HOST` | `localhost` | LM Studio host |
| `LM_PORT` | `1234` | LM Studio port |
| `MODEL_TIMEOUT_MS` | `120000` | Per-request timeout in ms |

## Model mapping

`model-map.json` lets you pin specific Copilot model IDs to local models:

```json
{
  "gpt-4o-mini-2024-07-18": "qwen/qwen3-8b"
}
```

Leave a value empty (`""`) or omit the key to use heuristic auto-selection based on available models.

## Managing the service (Windows)

```powershell
.\install\status.ps1   # check if running
.\install\stop.ps1     # stop the task
.\install\start.ps1    # restart without re-registering
```

## Testing

```
npm test
```
