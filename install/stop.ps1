# install/stop.ps1 — stop the capi-relay scheduled task
$taskName = "capi-relay"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "Task '$taskName' not found — nothing to stop"
    exit 0
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Output "Stopped task '$taskName'"
