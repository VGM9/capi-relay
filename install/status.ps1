# install/status.ps1 — show Task Scheduler state and live port check
param([string]$RepoRoot = $PSScriptRoot + "\..")

$taskName = "capi-relay"
$port     = 8787

Write-Output "=== Scheduled Task ==="
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "NOT REGISTERED — run install-windows.ps1 as Administrator"
} else {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    [PSCustomObject]@{
        State          = $task.State
        LastRunTime    = $info.LastRunTime
        LastResult     = "0x{0:X8}" -f $info.LastTaskResult
        NextRunTime    = $info.NextRunTime
    } | Format-List
}

Write-Output "=== Port $port ==="
$conn = Test-NetConnection -ComputerName localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
if ($conn) {
    Write-Output "LISTENING — relay is up"
} else {
    Write-Output "NOT LISTENING — relay is down"
}

Write-Output "=== Recent Logs ==="
$logFile = Join-Path $RepoRoot "logs\relay.jsonl"
if (Test-Path $logFile) {
    Get-Content $logFile -Tail 10
} else {
    Write-Output "(no log file yet)"
}
