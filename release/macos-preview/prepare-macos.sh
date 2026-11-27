#!/bin/sh
# Prepare only the invoking user's test installation. Never run as root.
set -eu
umask 077
[ "$(/usr/bin/id -u)" -ne 0 ] || { echo "run as the test user, without sudo" >&2; exit 1; }
pkg=$(cd "$(dirname "$0")" && pwd -P)
user=$(/usr/bin/id -un)
case "$user" in ''|*[!a-zA-Z0-9_.-]*) echo 'unsupported account name' >&2; exit 1;; esac
[ "$HOME" = "/Users/$user" ] || { echo 'the preview expects a local home under /Users' >&2; exit 1; }
base="$HOME/rhodium-test"
mkdir -p "$base"
[ ! -L "$base" ] && [ "$(/usr/bin/stat -f '%u:%Lp' "$base")" = "$(/usr/bin/id -u):700" ] || { echo 'test directory must be private (0700)' >&2; exit 1; }
mkdir -p "$base/work"
if [ ! -e "$base/config.toml" ]; then
  cat >"$base/config.toml" <<CONFIG
stateDir = '$base/state'
socketDir = '$base/run'
[board]
bind = "127.0.0.1"
port = 17861
auth = "none"
CONFIG
  chmod 600 "$base/config.toml"
fi
# The installed, root-owned, machine-specific helper always targets current.
if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then echo 'current is not a symbolic link' >&2; exit 1; fi
ln -sfn "$pkg" "$base/current"
/usr/bin/sed "s/@TEST_USER@/$user/g" "$pkg/macos-admin.in" >"$base/macos-admin.new"
chmod 700 "$base/macos-admin.new"
mv -f "$base/macos-admin.new" "$base/macos-admin"
echo "Prepared $base; no system service was registered."
