#!/usr/bin/env bash
# Apple Silicon preview; on Linux zig cc supplies the Darwin linker and system stubs.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
out=${1:-$repo/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export RHODIUM_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)
version="$(bun -p 'require("./package.json").version')-macos-preview-$RHODIUM_BUILD_COMMIT"
pkg="$tmp/rhodium-$version-arm64"
mkdir -p "$pkg"
NODE_ENV=production bun --bun vite build web --outDir "$tmp/web" --emptyOutDir --logLevel warn
bun build --compile --target=bun-darwin-arm64 --env='RHODIUM_BUILD_*' --define '__dirname="/$bunfs/root"' src/main.ts --asset "$tmp/web" --outfile "$pkg/rhodium"
export PATH="$HOME/.cargo/bin:$PATH"
rust=$(basename release/licenses/rust-*.md .md)
export RUSTUP_TOOLCHAIN=${rust#rust-}
export MACOSX_DEPLOYMENT_TARGET=13.0
if [[ $(uname -s) == Linux ]]; then
  cat >"$tmp/darwin-link" <<'LINKER'
#!/bin/sh
exec zig cc -target aarch64-macos.13.0 "$@"
LINKER
  chmod 700 "$tmp/darwin-link"
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$tmp/darwin-link"
fi
cargo build --locked --release --target aarch64-apple-darwin --manifest-path holder/Cargo.toml --target-dir "$tmp/cargo"
cp "$tmp/cargo/aarch64-apple-darwin/release/rh-hold" "$pkg/"
ln -s rhodium "$pkg/rh"
cp LICENSE NOTICE.md release/macos-preview/* "$pkg/"
# Ship the same narrow template; prepare-macos.sh renders @TEST_USER@ at setup time.
install -m 644 scripts/macos/rhodium-test-launchd "$pkg/macos-admin.in"
awk 'from && /^PLIST$/ {exit} from {print} /<<.PLIST.$/ {from=1}' "$pkg/macos-admin.in" >"$pkg/LaunchDaemon.plist.in"
grep -q '<key>UserName</key><string>@TEST_USER@</string>' "$pkg/LaunchDaemon.plist.in"
grep -q 'id -u @TEST_USER@' "$pkg/macos-admin.in"
printf '%s\ncommit %s\n' "$version" "$(git rev-parse HEAD)" > "$pkg/VERSION.txt"
bun scripts/notices.ts "$repo" darwin >"$pkg/THIRD_PARTY_NOTICES.md"
cp "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" "$pkg/RUST-STD-COPYRIGHT.html"
(cd "$pkg"; for f in *; do [[ -L $f ]] || shasum -a 256 "$f"; done) >"$tmp/SHA256SUMS.txt"
mv "$tmp/SHA256SUMS.txt" "$pkg/"
archive="$(basename "$pkg").tar.gz"
tar -C "$tmp" -czf "$out/$archive" "$(basename "$pkg")"
(cd "$out" && shasum -a 256 "$archive" >"$archive.sha256")
