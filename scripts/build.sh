#!/usr/bin/env bash
# Build dist/rhodium (Bun) and dist/rh-hold (Rust). Usage: scripts/build.sh [out-dir]
# rhodium gets baked in the commit it is built from, and RHODIUM_BUILD_NOTE, the note deploy/upgrade.sh
# was given, which it says in the main chat once it runs (architecture §12). It also has the board's
# page in it, built from web/ by Vite (architecture §2).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist}"
# Neither cargo nor bun is on the default PATH here.
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

# Cargo and Vite build in a temporary directory, not holder/target/ and web/dist/, so two builds of
# one checkout at once do not delete each other's. Rust build caches are large; it goes even on failure.
target=$(mktemp -d)
trap 'rm -rf "$target"' EXIT

mkdir -p "$out"
# node_modules as bun.lock has them, not as some older checkout left them.
bun install --frozen-lockfile --cwd "$root"
# The page goes in the binary as web/, which src/board.ts serves at /. Vite would leave a compile cache in TMPDIR.
# React's production build whatever NODE_ENV the caller has: Vite takes one set, and bun test sets test.
(cd "$root" && NODE_ENV=production NODE_DISABLE_COMPILE_CACHE=1 bun --bun vite build web --outDir "$target/web" --emptyOutDir --logLevel warn)
RHODIUM_BUILD_COMMIT=$(git -C "$root" describe --always)
export RHODIUM_BUILD_COMMIT RHODIUM_BUILD_NOTE=${RHODIUM_BUILD_NOTE-} # set, so the build has it, empty or not
# A module's __dirname would go in as this checkout's path (the Feishu SDK's does), so it says the
# binary's own root instead: no build machine's path in what ships (#524).
bun build --compile --env='RHODIUM_BUILD_*' --define '__dirname="/$bunfs/root"' "$root/src/main.ts" --asset "$target/web" --outfile "$out/rhodium"
cargo build --release --manifest-path "$root/holder/Cargo.toml" --target-dir "$target"
cp "$target/release/rh-hold" "$out/rh-hold"
