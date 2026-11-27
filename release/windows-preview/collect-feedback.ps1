# Collect allowlisted diagnostics only. No config, database, message bodies, raw
# stderr, process arguments, account identifiers, machine name or environment.
[CmdletBinding()]
param([string]$TaskName = 'RhodiumPreview', [string]$InstanceDir = (Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'))
$ErrorActionPreference = 'Stop'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$stage = Join-Path ([IO.Path]::GetTempPath()) ('rhodium-feedback-' + [guid]::NewGuid().ToString('N'))
$zip = "$stage.zip"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $task = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
  $status = [ordered]@{ collectedUtc=$stamp; windowsBuild=[Environment]::OSVersion.Version.ToString(); timezoneOffset=[DateTimeOffset]::Now.Offset.ToString(); taskPresent=[bool]$task }
  if ($task) {
    $info = Get-ScheduledTaskInfo -InputObject $task
    $status.taskState = $task.State.ToString()
    $status.lastRunUtc = $info.LastRunTime.ToUniversalTime().ToString('o')
    $status.lastResult = $info.LastTaskResult
    $status.restartCount = $task.Settings.RestartCount
    $image = Join-Path (Split-Path $task.Actions[0].Execute) 'rhodium.exe'
    # Read the package's version manifest; do not execute a task action for diagnostics.
    $versionFile = Join-Path (Split-Path $image) 'VERSION.txt'
    if (Test-Path -LiteralPath $versionFile) {
      $version = Get-Content -LiteralPath $versionFile -First 1
      if ($version -match '^\d+\.\d+\.\d+-windows-preview-[0-9a-f]{7,40}$') { $status.version = $version }
    }
    $status.controller = @(Get-Process -Name rhodium -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $image } | ForEach-Object {
      [ordered]@{pid=$_.Id; startedUtc=$_.StartTime.ToUniversalTime().ToString('o')} })
  }
  $channel = 'Microsoft-Windows-TaskScheduler/Operational'
  try {
    $enabled = (Get-WinEvent -ListLog $channel).IsEnabled
    $status.taskHistory = if ($enabled) { 'enabled' } else { 'disabled' }
    if ($enabled) {
      if ($TaskName -notmatch '^[\w-]+$') { throw 'unsupported history filter' }
      $query = "*[System[TimeCreated[timediff(@SystemTime) <= 172800000]] and EventData[Data[@Name='TaskName']='\$TaskName']]"
      $events = @(Get-WinEvent -LogName $channel -FilterXPath $query -MaxEvents 100 -ErrorAction SilentlyContinue |
        ForEach-Object { [ordered]@{ utc=$_.TimeCreated.ToUniversalTime().ToString('o'); eventId=$_.Id; level=$_.Level } })
      ConvertTo-Json -InputObject $events -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $stage 'task-events.json')
    }
  } catch { $status.taskHistory = 'unavailable' }
  $rows = @()
  $holdIndex = 1
  foreach ($hold in @(Get-ChildItem -LiteralPath (Join-Path $InstanceDir 'state\hold') -Directory -ErrorAction SilentlyContinue)) {
    foreach ($name in 'in.log','out.log','err.log','exit') {
      $file = Get-Item -LiteralPath (Join-Path $hold.FullName $name) -ErrorAction SilentlyContinue
      if ($file) { $rows += [ordered]@{slotIndex=$holdIndex; file=$name; bytes=$file.Length; changedUtc=$file.LastWriteTimeUtc.ToString('o')} }
    }
    $holdIndex++
  }
  ConvertTo-Json -InputObject @($rows) -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $stage 'holder-log-metadata.json')
  $status | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $stage 'status.json')
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
  Write-Output $zip
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
