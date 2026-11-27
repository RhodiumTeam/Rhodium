# Run in the branch checkout after bun install --frozen-lockfile.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:RHODIUM_BUILD_COMMIT = (git rev-parse --short=12 HEAD)
$env:NODE_ENV = 'production'
bun --bun vite build web --outDir ../dist/web --emptyOutDir --logLevel warn
if ($LASTEXITCODE) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force dist | Out-Null
bun build --compile '--env=RHODIUM_BUILD_*' '--define' '__dirname="B:/~BUN/root"' src/main.ts --asset dist/web --outfile dist/rhodium.exe
if ($LASTEXITCODE) { exit $LASTEXITCODE }
cargo build --locked --release --manifest-path holder/Cargo.toml
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Copy-Item holder/target/release/rh-hold.exe dist/rh-hold.exe -Force
Copy-Item scripts/windows-task.ps1 dist/
