# Run after the native build and tests on the Windows preview branch.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$commit = (git rev-parse HEAD)
$short = (git rev-parse --short=12 HEAD)
$base = (Get-Content package.json -Raw | ConvertFrom-Json).version
$version = "$base-windows-preview-$short"
$name = "rhodium-$version-win-x64"
# PowerShell can return before a GUI-subsystem helper writes its version.
$versionOutput = [IO.Path]::GetTempFileName()
try {
  foreach ($exe in 'rhodium','rh-hold') {
    $process = Start-Process -FilePath ".\dist\$exe.exe" -ArgumentList '--version' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $versionOutput
    $reported = (Get-Content -LiteralPath $versionOutput -Raw).Trim()
    if ($process.ExitCode -ne 0 -or $reported -ne $version) { throw "Unexpected $exe version: $reported" }
  }
} finally { Remove-Item -LiteralPath $versionOutput }
$pkg = (New-Item -Type Directory -Path "dist/$name").FullName
Copy-Item -Path dist/rhodium.exe,dist/rh-hold.exe,dist/windows-task.ps1,LICENSE,NOTICE.md -Destination $pkg
Copy-Item -Path release/windows-preview/* -Destination $pkg
@($version, "commit $commit", "Windows x64 MSVC", (rustc -V), "Bun $(bun --version)") | Set-Content -Encoding ascii (Join-Path $pkg 'VERSION.txt')
# pwsh 7 on the Windows runner uses UTF-8 for redirected native output.
bun scripts/notices.ts > (Join-Path $pkg 'THIRD_PARTY_NOTICES.md')
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice generation failed' }
$expectedRust = (Get-Item release/licenses/rust-*.md).BaseName.Substring(5)
if ((rustc -V) -notlike "rustc $expectedRust *") { throw 'Rust toolchain and notice versions differ' }
Copy-Item (Join-Path (rustc --print sysroot) 'share/doc/rust/COPYRIGHT-library.html') (Join-Path $pkg 'RUST-STD-COPYRIGHT.html')
$hashes = foreach ($f in (Get-ChildItem -LiteralPath $pkg -File | Sort-Object Name)) {
  (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $f.Name
}
$hashes | Set-Content -Encoding ascii (Join-Path $pkg 'SHA256SUMS.txt')
$zip = "dist/$name.zip"
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -CompressionLevel Optimal
if ((Get-Item $zip).Length -ge 100000000) { throw 'Preview exceeds the QQ file limit' }
# Exercise the archive as received: install, reinstall and switch version directories.
$testName = 'rhodium-test-preview-' + [guid]::NewGuid().ToString('N')
$private = Join-Path ([IO.Path]::GetTempPath()) $testName
$unpacked = "$private-unpacked"
try {
  Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
  if (Test-Path -LiteralPath "$unpacked/rh.exe") { throw 'ZIP contains a duplicate controller' }
  # A stale alias in an existing install directory must also be refreshed.
  New-Item -ItemType HardLink -Path "$unpacked/rh.exe" -Target "$unpacked/rh-hold.exe" | Out-Null
  foreach ($dir in @($pkg, $pkg, $unpacked)) {
    powershell.exe -NoProfile -NonInteractive -File "$dir/windows-task.ps1" -InstallDir $dir -InstanceDir $private -TaskName $testName -ConfigTemplate "$dir/config.example.toml" -PrepareOnly
    if ($LASTEXITCODE -ne 0) { throw 'Preview config initialization failed' }
    $link = Get-Item -LiteralPath "$dir/rh.exe"
    if ($link.LinkType -ne 'HardLink' -or (Get-FileHash $link.FullName).Hash -ne (Get-FileHash "$dir/rhodium.exe").Hash) { throw 'CLI is not linked to this controller' }
    if ((& $link.FullName --version) -ne $version -or $LASTEXITCODE -ne 0) { throw 'Installed CLI version mismatch' }
  }
  $env:RHODIUM_TEST_CONFIG = Join-Path $private 'config.toml'
  bun -e 'const c = Bun.TOML.parse(await Bun.file(process.env.RHODIUM_TEST_CONFIG).text()); if (c.board.bind !== "127.0.0.1" || c.board.port !== 17860 || !c.stateDir.endsWith("state") || !c.socketDir.endsWith("run")) process.exit(1)'
  if ($LASTEXITCODE -ne 0) { throw 'Generated config differs from the tester guide' }
  $feedback = powershell.exe -NoProfile -NonInteractive -File "$pkg/collect-feedback.ps1" -InstanceDir $private -TaskName $testName
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $feedback -PathType Leaf)) { throw 'Feedback archive missing' }
  Remove-Item -LiteralPath $feedback
} finally {
  if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
  if (Test-Path -LiteralPath $private) { Remove-Item -LiteralPath $private -Recurse -Force }
}
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$sha  $name.zip" | Set-Content -Encoding ascii "$zip.sha256"
Write-Output "$name.zip  $((Get-Item $zip).Length) bytes  SHA256 $sha"
