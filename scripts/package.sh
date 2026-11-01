#!/usr/bin/env bash
# Make the package that installs Rhodium on another machine (#385): one .tar.xz with the programs,
# the service script, README.md for people and INSTALLATION.md for the agent that installs it, the
# licence and the third-party notices.
# Usage: scripts/package.sh [out-dir] [x86_64|arm64]   (dist/ and this machine's architecture by default)
#
# It builds as scripts/build.sh does, but for any Linux of that architecture rather than machines
# like the one it builds on: rhodium on Bun's baseline runtime on x86_64, for CPUs without AVX2, and
# rh-hold linked statically against musl, for an older glibc. build.sh, which deploy/upgrade.sh
# builds an instance from a checkout with, stays as it is. .github/workflows/release.yml runs this on
# each architecture for a release.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist}"
case "${2:-$(uname -m)}" in
  x86_64) arch=x86_64 bun=bun-linux-x64-baseline rust=x86_64-unknown-linux-musl ;;
  arm64 | aarch64) arch=arm64 bun=bun-linux-arm64 rust=aarch64-unknown-linux-musl ;;
  *) echo "不支持的架构：${2:-$(uname -m)}，只有 x86_64 和 arm64" >&2; exit 2 ;;
esac
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

bun install --frozen-lockfile --cwd "$root"
# The page as React's production build, whatever NODE_ENV the caller has, as build.sh builds it: the
# development one is slower and names this checkout's files.
(cd "$root" && NODE_ENV=production NODE_DISABLE_COMPILE_CACHE=1 bun --bun vite build web --outDir "$stage/web" --emptyOutDir --logLevel warn)
RHODIUM_BUILD_COMMIT=$(git -C "$root" describe --always --dirty)
export RHODIUM_BUILD_COMMIT RHODIUM_BUILD_NOTE=
mkdir "$stage/pkg"
# __dirname as the binary's own root, not this checkout's path (#524), as build.sh does.
bun build --compile --target="$bun" --env='RHODIUM_BUILD_*' --define '__dirname="/$bunfs/root"' "$root/src/main.ts" --asset "$stage/web" --outfile "$stage/pkg/rhodium"
# The Rust its notices are written for, release/licenses/rust-<version>.md, whatever the caller's
# default is: the code Rust's standard library bundles changes from one release to the next.
rustv=$(basename "$root"/release/licenses/rust-*.md .md)
export RUSTUP_TOOLCHAIN="${rustv#rust-}"
# One rustup at a time, which is all it's safe for: test/package.test.ts packages both
# architectures at once. The toolchain is installed only when missing, so this is offline once it's
# there, as toolchain install --no-update would be, a flag older rustups lack; target add is offline
# too. No grep -q: quitting early could SIGPIPE rustup, failing the pipe and reinstalling.
{
  flock 9
  rustup toolchain list | grep "^$RUSTUP_TOOLCHAIN-" >/dev/null || rustup --quiet toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --no-self-update
  rustup --quiet target add "$rust"
} 9<"$0"
# For the other architecture, Rust's own lld links rh-hold with the musl Rust bundles: this machine's cc
# links only its own.
[ "${rust%%-*}" = "$(uname -m)" ] || export "CARGO_TARGET_$(tr a-z- A-Z_ <<<"$rust")_LINKER=rust-lld"
cargo build --release --target "$rust" --manifest-path "$root/holder/Cargo.toml" --target-dir "$stage/cargo"
cp "$stage/cargo/$rust/release/rh-hold" "$stage/pkg/"

# What rhodium --version prints, read without running it: one built for the other architecture can't.
name="rhodium-$(bun -e 'console.log(require(process.argv[1]).version)' "$root/package.json")-$RHODIUM_BUILD_COMMIT-linux-$arch"
mv "$stage/pkg" "$stage/$name"
ln -s rhodium "$stage/$name/rh"
cp "$root/scripts/rhodium-service.sh" "$root/release/README.md" "$root/release/INSTALLATION.md" "$root/LICENSE" "$stage/$name/"
# The binary has no comments, so the notices it owes go beside it (#524).
bun "$root/scripts/notices.ts" >"$stage/$name/THIRD_PARTY_NOTICES.md"
# Rust's own notices for its standard library and the code it bundles, from the toolchain that built rh-hold.
cp "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" "$stage/$name/RUST-STD-COPYRIGHT.html"
mkdir -p "$out"
# xz: the Bun runtime is most of rhodium's 110MB; xz takes the package to about 40MB, gzip to 53MB,
# past the 50MB a Telegram bot may send.
tar -C "$stage" -cf - "$name" | xz -9 -T0 >"$out/$name.tar.xz"
echo "$out/$name.tar.xz"
