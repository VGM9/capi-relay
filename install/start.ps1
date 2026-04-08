# install/start.ps1 — start relay (used by node run.js start on Windows)
param([string]$RepoRoot = $PSScriptRoot + "\..")
$env:RELAY_PORT = "8787"
$env:LM_HOST    = "localhost"
$env:LM_PORT    = "1234"
node "$RepoRoot\capi-relay.js"
