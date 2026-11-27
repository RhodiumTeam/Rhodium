# A disposable, account-free Windows Runner probe. Keep the release's adjacent DLLs.
param([switch]$SlotOnly)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:RUNNER_TEMP ('rhodium-test-herdr-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -Type Directory $dir | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Cannot restrict the test directory' }
$session = Split-Path -Leaf $dir
if ($SlotOnly) {
  $daemon = (Get-Item dist/rhodium.exe).FullName
  $holder = (Get-Item dist/rh-hold.exe).FullName
  $slotProbe = Join-Path $dir 'slot.mjs'
  $codex = Join-Path $dir 'codex.exe'
  bun build --target=bun "$PSScriptRoot/pi-import-daemon.ts" --outfile (Join-Path $dir 'pi-import-daemon.mjs')
  if ($LASTEXITCODE) { throw 'Pi test daemon bundle failed' }
  bun build --target=bun "$PSScriptRoot/slot.ts" --outfile $slotProbe
  if ($LASTEXITCODE) { throw 'Slot probe bundle failed' }
  bun build --compile "$PSScriptRoot/agent.ts" --outfile $codex
  if ($LASTEXITCODE) { throw 'Test CLI build failed' }
  foreach ($kind in 'claude','pi') { Copy-Item $codex (Join-Path $dir "$kind.exe") }
} else {
  $bundle = Join-Path $dir 'board.mjs'
  bun build --target=bun scripts/probes/herdr-tui/board.ts --outfile $bundle
  if ($LASTEXITCODE) { throw 'Bundle failed' }
  $drain = Join-Path $dir 'drain.mjs'
  bun build --target=bun "$PSScriptRoot/drain.ts" --outfile $drain
  if ($LASTEXITCODE) { throw 'Drain probe bundle failed' }
  $drainFixture = (Resolve-Path "$PSScriptRoot/drain-windows.py").Path
  $python = (Get-Command python.exe).Source
  $observer = (Resolve-Path "$PSScriptRoot/observe-windows.py").Path
  $supervisor = Join-Path $dir 'rhodium-test-job.exe'
  rustc --edition=2024 "$PSScriptRoot/job-supervisor.rs" -o $supervisor
  if ($LASTEXITCODE) { throw 'Job supervisor compilation failed' }
}
Push-Location $dir
try {
  Invoke-WebRequest -Uri 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip' -OutFile herdr.zip
  if ((Get-FileHash herdr.zip).Hash -ne 'd2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf') { throw 'Herdr release digest mismatch' }
  Expand-Archive herdr.zip -DestinationPath unpacked
  $bin = (Get-ChildItem unpacked -Recurse -Filter herdr.exe | Select-Object -First 1).FullName
  $env:HOME = $env:USERPROFILE = $dir
  $env:XDG_CONFIG_HOME = $env:APPDATA = $env:LOCALAPPDATA = Join-Path $dir 'profile'
  New-Item -Type Directory $env:XDG_CONFIG_HOME | Out-Null
  $env:CODEX_HOME = Join-Path $dir 'codex-home'
  $env:HERDR_CONFIG_PATH = Join-Path $dir 'herdr.toml'
  "[session]`nresume_agents_on_restore = false" | Set-Content -Encoding Ascii $env:HERDR_CONFIG_PATH
  $env:AnThRoPiC_aPi_KeY = 'rhodium-test-sentinel'
  & $bin --version
  $server = Start-Process $bin -ArgumentList @('--session', $session, 'server') -NoNewWindow -PassThru -RedirectStandardError server.err -RedirectStandardOutput server.out
  for ($i = 0; $i -lt 40; $i++) {
    $list = & $bin session list --json
    if ($LASTEXITCODE -eq 0 -and (($list | ConvertFrom-Json).sessions | Where-Object { $_.name -eq $session -and $_.running })) { break }
    if ($server.HasExited) { throw ('Isolated server exited: ' + (Get-Content server.err -Tail 3)) }
    Start-Sleep -Milliseconds 250
  }
  if ($SlotOnly) {
    foreach ($kind in 'codex','claude','pi') {
      Push-Location (New-Item -Type Directory (Join-Path $dir "slot-$kind")).FullName
      try {
        bun $slotProbe $daemon $holder (Join-Path $dir "$kind.exe") $bin $session $kind
        if ($LASTEXITCODE) { throw "$kind slot lifecycle failed" }
      } finally { Pop-Location }
    }
    return
  }
  foreach ($variant in @('plain', 'job')) {
    $work = New-Item -Type Directory (Join-Path $dir $variant)
    Push-Location $work.FullName
    try {
      $extra = @($observer)
      if ($variant -eq 'job') { $extra += $supervisor }
      bun $bundle $bin $session $python @extra
      if ($LASTEXITCODE) { throw "Board/ConPTY probe failed for $variant" }
    } finally { Pop-Location }
  }
  Push-Location (New-Item -Type Directory (Join-Path $dir 'drain')).FullName
  try {
    bun $drain $bin $session $python $drainFixture
    if ($LASTEXITCODE) { throw 'Post-exit grandchild or Job drainage check failed' }
  } finally { Pop-Location }
} finally {
  if ($server) {
    & $bin session stop $session --json | Out-Null
    if (!$server.WaitForExit(5000)) { $server.Kill() }
  }
  Pop-Location
}
