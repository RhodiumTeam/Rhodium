# Exercise real registrations under the preview principal. Run in Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$bin = (Resolve-Path dist).Path
$root = Join-Path $env:RUNNER_TEMP ('rhodium-test-scheduler-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$channel = 'Microsoft-Windows-TaskScheduler/Operational'
$restoreLog = $false
$cases = @()

function BoardPid($case) {
  try { return [int](Invoke-RestMethod "http://127.0.0.1:$($case.Port)/api/rhodium" -TimeoutSec 2).pid }
  catch { return 0 }
}
function Act($case, $action) {
  $body = @{id=[guid]::NewGuid().ToString(); act=$action} | ConvertTo-Json -Depth 5
  $reply = Invoke-RestMethod "http://127.0.0.1:$($case.Port)/api/act" -Method Post -ContentType 'application/json' -Headers @{'sec-fetch-site'='same-origin'} -Body $body
  if (!$reply.ok) { throw "Board test action failed ($($action.kind))" }
  return $reply
}
function Observe($case) {
  $info = Get-ScheduledTaskInfo -TaskName $case.Name
  $state = (Get-ScheduledTask -TaskName $case.Name).State
  $controller = BoardPid $case
  $sample = "pid=$controller state=$state LastTaskResult=$($info.LastTaskResult)"
  if ($sample -ne $case.Sample) {
    Write-Host "$($case.Kind) +$([int]$clock.Elapsed.TotalSeconds)s $sample"
    $case.Sample = $sample
  }
  if ($controller -and $controller -ne $case.Old) { $case.New = $controller }
}

try {
  if (!(Get-WinEvent -ListLog $channel).IsEnabled) {
    wevtutil sl $channel /e:true
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enable task history on the disposable runner' }
    $restoreLog = $true
  }
  # Check the zero-exit path and the retry ceiling concurrently with the two-minute observation.
  $fixture = New-Item -ItemType Directory (Join-Path $root 'backoff')
  Copy-Item (Join-Path $bin 'rh-hold.exe') $fixture.FullName
  Add-Type -OutputAssembly (Join-Path $fixture 'rhodium.exe') -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
class Probe {
  static int Main(string[] args) {
    File.AppendAllText(args[1], DateTime.UtcNow.Ticks + Environment.NewLine);
    return args[1] == "zero" ? 0 : 7;
  }
}
'@
  $watch = Join-Path $fixture 'rh-hold.exe'
  $zero = Start-Process $watch -ArgumentList 'task --config zero' -WorkingDirectory $fixture -PassThru -Wait
  if ($zero.ExitCode -ne 0 -or @(Get-Content (Join-Path $fixture 'zero')).Count -ne 1) { throw 'Clean exit was retried' }
  $backoff = Start-Process $watch -ArgumentList 'task --config failing' -WorkingDirectory $fixture -PassThru
  foreach ($kind in 'kill','exit') {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $case = @{Kind=$kind; Name=((Split-Path -Leaf $root) + '-' + $kind); Port=$port; Old=0; New=0; Sample=''}
    $cases += $case
    $dir = Join-Path $root $kind
    $case.Dir = $dir
    $template = Join-Path $root "$kind.toml"
    $text = (Get-Content -Raw release/windows-preview/config.example.toml).Replace('port = 17860', "port = $port").Replace('__CLAUDE_EXE__', (ConvertTo-Json (Join-Path $bin 'rhodium-test-claude.exe') -Compress))
    [IO.File]::WriteAllText($template, $text + "`ncodex = 'rhodium-test-no-agent.exe'`npi = 'rhodium-test-no-agent.exe'`n")
    # The installer registers and starts the interactive logon task; never start it again here.
    & ./scripts/windows-task.ps1 -InstallDir $bin -TaskName $case.Name -InstanceDir $dir -ConfigTemplate $template
    $until = [datetime]::UtcNow.AddSeconds(30)
    while (!($case.Old = BoardPid $case) -and [datetime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 500 }
    if (!$case.Old) {
      $result = (Get-ScheduledTaskInfo -TaskName $case.Name).LastTaskResult
      throw "Interactive task did not start the $kind daemon; LastTaskResult=$result"
    }
    $case.Process = Get-Process -Id $case.Old
    $null = $case.Process.Handle
    if ($case.Process.Path -ne (Join-Path $bin 'rhodium.exe')) { throw 'Unexpected daemon executable' }
  }
  # Pin the independent holder and its agent before a controller crash and a version swap.
  $kill = $cases[0]
  Act $kill @{kind='rh'; argv=@('ws','test',$kill.Dir)} | Out-Null
  $slot = (Act $kill @{kind='rh'; argv=@('new','test/one')}).slot
  $waiting = Join-Path $kill.Dir 'waiting-for-agent'
  New-Item -ItemType File $waiting | Out-Null
  Act $kill @{kind='say'; slot=$slot; text='scheduled task smoke'} | Out-Null
  for ($i=0; $i -lt 80 -and (Test-Path $waiting); $i++) { Start-Sleep -Milliseconds 150 }
  if (Test-Path $waiting) { throw 'Fake agent did not accept the turn' }
  $agent = Get-Process -Id ([int](Get-Content (Join-Path $kill.Dir 'fake-agent-pids') -Last 1))
  $agentInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($agent.Id)"
  $holder = Get-Process -Id $agentInfo.ParentProcessId
  if ($holder.Path -ne (Join-Path $bin 'rh-hold.exe') -or $agent.Path -ne (Join-Path $bin 'rhodium-test-claude.exe')) { throw 'Unexpected test processes' }
  $null = $holder.Handle; $null = $agent.Handle
  $clock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($case in $cases) {
    Write-Host "$($case.Kind) initial pid=$($case.Old)"
    if ($case.Kind -eq 'kill') {
      $case.Process.Kill()
    } else {
      # Losing the CLI listener makes the production daemon itself call process.exit(1).
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($case.Old) AND Name = 'rh-hold.exe'" |
        Where-Object { $_.ExecutablePath -eq (Join-Path $bin 'rh-hold.exe') -and $_.CommandLine -match '\s"?cli"?\s' })
      if ($children.Count -ne 1) { throw 'Expected one isolated daemon CLI listener' }
      (Get-Process -Id $children[0].ProcessId).Kill()
    }
    if (!$case.Process.WaitForExit(5000)) { throw 'Original daemon did not exit' }
    $code = $case.Process.ExitCode
    Write-Host "$($case.Kind) original exit=$code"
    if ($code -eq 0 -or ($case.Kind -eq 'exit' -and $code -ne 1)) { throw 'Unexpected original exit code' }
  }
  $until = [datetime]::UtcNow.AddSeconds(120)
  do {
    foreach ($case in $cases) { Observe $case }
    Start-Sleep -Seconds 2
  } while ([datetime]::UtcNow -lt $until)
  foreach ($case in $cases) {
    Observe $case
    $query = "*[EventData[Data[@Name='TaskName']='\$($case.Name)']]"
    $events = @(Get-WinEvent -LogName $channel -FilterXPath $query -ErrorAction SilentlyContinue | Sort-Object TimeCreated)
    foreach ($event in $events) {
      $xml = [xml]$event.ToXml()
      $result = @($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'ResultCode' } | ForEach-Object { $_.'#text' }) -join ','
      Write-Host "$($case.Kind) history $($event.TimeCreated.ToUniversalTime().ToString('HH:mm:ss')) event=$($event.Id) result=$result"
    }
    Write-Host "$($case.Kind) two-minute result old=$($case.Old) new=$($case.New) historyEvents=$($events.Count)"
  }
  if (@($cases | Where-Object { !$_.New -or (BoardPid $_) -ne $_.New }).Count) { throw 'Task failed to restore a healthy daemon within two minutes' }
  if (!$backoff.HasExited -or $backoff.ExitCode -ne 7) { throw 'Repeated failures did not stop with their exit code' }
  $attempts = @(Get-Content (Join-Path $fixture 'failing'))
  if ($attempts.Count -ne 6) { throw "Unexpected attempt count $($attempts.Count)" }
  $gaps = for ($i=1; $i -lt $attempts.Count; $i++) {
    $gap = [TimeSpan]::FromTicks([long]$attempts[$i] - [long]$attempts[$i-1]).TotalSeconds
    if ($gap -lt (1 -shl $i) - 0.25) { throw "Retry $i was too early" }
    [Math]::Round($gap, 1)
  }
  Write-Host "Clean exit: one launch. Persistent exit 7: retry gaps in seconds $gaps then stopped."
  # Upgrade an already supervised version to another immutable directory.
  $next = New-Item -ItemType Directory (Join-Path $root 'next')
  foreach ($file in 'rhodium.exe','rh-hold.exe') { Copy-Item -LiteralPath (Join-Path $bin $file) -Destination $next }
  $prior = Get-Process -Id $kill.New
  $null = $prior.Handle
  & ./scripts/windows-task.ps1 -InstallDir $next -TaskName $kill.Name -InstanceDir $kill.Dir
  $upgrade = 0
  for ($i=0; $i -lt 50; $i++) {
    $upgrade = BoardPid $kill
    if ($upgrade -and $upgrade -ne $kill.New) { break }
    Start-Sleep -Milliseconds 300
  }
  if (!$upgrade -or !$prior.HasExited -or (Get-Process -Id $upgrade).Path -ne (Join-Path $next 'rhodium.exe')) { throw 'Upgrade did not hand off to the new directory' }
  if ($holder.HasExited -or $agent.HasExited) { throw 'Upgrade interrupted the original agent tree' }
  New-Item -ItemType File $waiting | Out-Null
  Act $kill @{kind='say'; slot=$slot; text='continue after upgrade'} | Out-Null
  for ($i=0; $i -lt 80 -and (Test-Path $waiting); $i++) { Start-Sleep -Milliseconds 150 }
  if ((Test-Path $waiting) -or $agent.HasExited -or @(Get-Content (Join-Path $kill.Dir 'fake-agent-pids')).Count -ne 1) { throw 'Original agent did not take the follow-up' }
  Write-Host "Upgrade pid=$upgrade preserved holder=$($holder.Id) agent=$($agent.Id) and accepted follow-up"
  Stop-ScheduledTask -TaskName $kill.Name
  Start-Sleep -Seconds 6
  if ((BoardPid $kill) -or (Get-ScheduledTask -TaskName $kill.Name).State -eq 'Running') { throw 'Manual task stop unexpectedly restarted the daemon' }
  Write-Host 'Manual Stop-ScheduledTask left the controller stopped'
} finally {
  foreach ($case in $cases) {
    if (Get-ScheduledTask -TaskName $case.Name -ErrorAction SilentlyContinue) {
      Disable-ScheduledTask -TaskName $case.Name | Out-Null
      Stop-ScheduledTask -TaskName $case.Name
      Unregister-ScheduledTask -TaskName $case.Name -Confirm:$false
    }
  }
  if ($holder -and !$holder.HasExited) { $holder.Kill(); $null = $holder.WaitForExit(5000) }
  if ($backoff -and !$backoff.HasExited) { $backoff.Kill(); $null = $backoff.WaitForExit(5000) }
  if ($restoreLog) { wevtutil sl $channel /e:false }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
