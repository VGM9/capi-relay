# install/install-windows.ps1
# Register capi-relay as a Windows Task Scheduler task that starts at login.
# Run as Administrator. Edit $RepoRoot if needed.

param([string]$RepoRoot = "C:\.______\SOURCE\remote\github.com\VGM9\capi-relay")

# Fail loudly if not elevated — silent failure is the root cause of ghost installs
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Must run as Administrator. Re-run from an elevated PowerShell prompt."
    exit 1
}

$taskName = "capi-relay"
$node     = (Get-Command node -ErrorAction Stop).Source
$script   = Join-Path $RepoRoot "capi-relay.js"

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "capi-relay registered and started. Port 8787."
Write-Output "Add to VS Code settings:"
Write-Output '  "github.copilot.advanced.debug.overrideCapiUrl": "http://localhost:8787"'
Write-Output '  "github.copilot.advanced.debug.overrideProxyUrl": "http://localhost:8787"'
