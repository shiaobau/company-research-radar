param(
  [ValidateSet("install", "uninstall")]
  [string]$Action = "install"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$runner = Join-Path $root "tools\scheduled-update.mjs"
$taskPrefix = "CompanyResearchDashboard"
$runAsUser = "$env:USERDOMAIN\$env:USERNAME"
$slots = @(
  @{ Id = "morning"; Time = "08:15" },
  @{ Id = "evening"; Time = "20:30" }
)
$obsoleteTaskNames = @("$taskPrefix-market_close")

if (-not (Test-Path -LiteralPath $node)) { throw "Node runtime not found: $node" }
if (-not (Test-Path -LiteralPath $runner)) { throw "Scheduled update runner not found: $runner" }

function Save-FrequencyStatus {
  $statusPath = Join-Path $root "data\scheduler_status.json"
  if (Test-Path -LiteralPath $statusPath) {
    $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $status = [pscustomobject]@{ version = "1.0.0"; timezone = "Asia/Taipei"; schedules = @{} }
  }
  $frequencyLabel = ([char]0x5E73).ToString() + ([char]0x65E5)
  $status | Add-Member -NotePropertyName frequency -NotePropertyValue "weekday" -Force
  $status | Add-Member -NotePropertyName frequency_label -NotePropertyValue $frequencyLabel -Force
  $status | Add-Member -NotePropertyName generated_at -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
  if ($status.schedules -and $status.schedules.PSObject.Properties["market_close"]) {
    $status.schedules.PSObject.Properties.Remove("market_close")
  }
  [System.IO.File]::WriteAllText($statusPath, (($status | ConvertTo-Json -Depth 16) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
}

if ($Action -eq "install") {
  foreach ($taskName in $obsoleteTaskNames) {
    try {
      & schtasks.exe /Delete /TN $taskName /F 2>$null
    } catch {
      # A previous version may not have created the obsolete task.
    }
  }
}

foreach ($slot in $slots) {
  $taskName = "$taskPrefix-$($slot.Id)"
  if ($Action -eq "uninstall") {
    & schtasks.exe /Delete /TN $taskName /F 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Output "Removed $taskName" }
    continue
  }

  $command = "`"$node`" `"$runner`" --slot=$($slot.Id)"
  & schtasks.exe /Create /TN $taskName /TR $command /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST $slot.Time /RU $runAsUser /RL LIMITED /IT /F
  if ($LASTEXITCODE -ne 0) { throw "Failed to create $taskName (schtasks exit code: $LASTEXITCODE)." }
  & schtasks.exe /Query /TN $taskName /FO LIST | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Created task could not be queried: $taskName" }
  Write-Output "Installed $taskName at $($slot.Time) on weekdays for $runAsUser"
}

if ($Action -eq "install") { Save-FrequencyStatus }
