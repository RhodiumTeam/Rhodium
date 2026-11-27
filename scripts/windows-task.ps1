# Register the installed daemon for the current user's interactive login.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string] $InstallDir,
  [string] $TaskName = 'Rhodium',
  [string] $ConfigTemplate,
  [switch] $PrepareOnly,
  [string] $InstanceDir = (Join-Path $env:LOCALAPPDATA 'Rhodium')
)
$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath (Join-Path $InstallDir 'rhodium.exe')).FullName
$launcher = (Get-Item -LiteralPath (Join-Path $InstallDir 'rh-hold.exe')).FullName
$user = [Security.Principal.WindowsIdentity]::GetCurrent()
$config = Join-Path $InstanceDir 'config.toml'
$configArgs = '--config "' + $config + '"'
$action = New-ScheduledTaskAction -Execute $launcher -Argument ("task " + $configArgs) -WorkingDirectory (Split-Path $exe)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user.Name
$principal = New-ScheduledTaskPrincipal -UserId $user.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
if ($PSCmdlet.ShouldProcess($TaskName, 'Register current-user logon task')) {
  $old = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($old) {
    $image = Split-Path -Leaf $old.Actions[0].Execute
    $argsMatch = ($image -eq 'rh-hold.exe' -and $old.Actions[0].Arguments -eq $action.Arguments) -or
                 ($image -eq 'rhodium.exe' -and $old.Actions[0].Arguments -eq $configArgs)
    if ($old.Actions.Count -ne 1 -or !$argsMatch) { throw "The existing task $TaskName belongs to another installation." }
  }
  if (-not (Test-Path -LiteralPath $InstanceDir)) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($user.User)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($user.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::CreateDirectory($InstanceDir, $acl) | Out-Null
  }
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    if (-not $ConfigTemplate) { throw "Create $config with your board or IM settings, then run this command again." }
    $text = [IO.File]::ReadAllText((Get-Item -LiteralPath $ConfigTemplate).FullName)
    $cli = Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $program = if ($cli) { $cli.Source } else { 'claude.exe' }
    $values = @{ '__STATE_DIR__' = (Join-Path $InstanceDir 'state'); '__RUN_DIR__' = (Join-Path $InstanceDir 'run')
                 '__LOCK_DIR__' = (Join-Path $InstanceDir 'lock'); '__CLAUDE_EXE__' = $program }
    foreach ($key in $values.Keys) { $text = $text.Replace($key, (ConvertTo-Json -InputObject $values[$key] -Compress)) }
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($user.User)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.User, 'FullControl', 'Allow'))
    $file = [IO.FileStream]::new($config, 'CreateNew', [Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $acl)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes($text)
      $file.Write($bytes, 0, $bytes.Length)
    } finally { $file.Dispose() }
  }
  # Each immutable version directory owns its CLI alias. Keep a live, correct link on reinstall.
  $rh = Join-Path (Split-Path $exe) 'rh.exe'
  $aliasFile = Get-Item -LiteralPath $rh -ErrorAction SilentlyContinue
  if ($aliasFile -and $aliasFile.PSIsContainer) { throw "Expected a file at $rh" }
  if (-not $aliasFile) {
    New-Item -ItemType HardLink -Path $rh -Target $exe | Out-Null
  } elseif ($aliasFile.LinkType -ne 'HardLink' -or $aliasFile.Target -notcontains $exe) {
    # Prepare the replacement first so an unsupported filesystem leaves the existing file intact.
    $temp = Join-Path (Split-Path $exe) ('rh-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
      New-Item -ItemType HardLink -Path $temp -Target $exe | Out-Null
      Move-Item -LiteralPath $temp -Destination $rh -Force
    } finally {
      if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
  }
  if ($PrepareOnly) { return }
  # Retire the previous version's watchdog before switching the registered executable.
  $retire = $old -and $old.Actions[0].Execute -ne $launcher -and $old.State -in 'Running','Queued'
  if ($retire) {
    Stop-ScheduledTask -InputObject $old
    $until = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-ScheduledTask -TaskPath '\' -TaskName $TaskName).State -in 'Running','Queued') {
      if ([DateTime]::UtcNow -ge $until) { throw "The previous task did not stop." }
      Start-Sleep -Milliseconds 200
    }
  }
  try {
    Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  } catch {
    if ($retire) { Start-ScheduledTask -TaskPath '\' -TaskName $TaskName }
    throw
  }
  Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
}
