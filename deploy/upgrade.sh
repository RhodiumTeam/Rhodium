#!/usr/bin/env bash
# Upgrade a Rhodium instance in one command (deploy/README.md, architecture §12):
#
#   deploy/upgrade.sh [-m <note>] <instance> [git ref]
#
# note: a sentence on what changed, in Chinese, say -m "每回合第一行带发送时间". The build bakes it
# into the new rhodium (scripts/build.sh), which says in the main chat 升级到 <version>（<commit>）：<note>
# once it runs, and only 升级到 <version>（<commit>）。 with no note.
#
# It fetches origin and checks the ref (origin/main by default) out into a temporary worktree of
# this repository, so it runs from any checkout, whatever that has checked out. It builds the ref
# there with the ref's own scripts/build.sh, which installs the dependencies bun.lock pins, into a
# new <opt>/versions/<version>-<commit>-<random>, and removes the worktree, built or not. Then it
# points <opt>/current at the new version, restarts the systemd user service <instance> (which runs
# <opt>/current/rhodium), and runs rh doctor. Then <opt>/previous is the version before. If rhodium
# does not come back within a minute or rh doctor reports an error, but of the board or your codex, current goes
# back to the version before, the service restarts on it, and the script exits 1. But a rhodium refuses a
# database newer than itself, so once the new one has migrated the database, current stays on it
# and the script exits 1 all the same. With no service installed yet, it only installs.
#
# Versions are never deleted: holders started by one run its rh-hold till their agents exit (§4.7).
# <opt> is ~/.local/opt/<instance>, and rh reaches rhodium at $XDG_RUNTIME_DIR/<instance>/rh.sock,
# so the instance's socketDir must be $XDG_RUNTIME_DIR/<instance>. Tests set RHODIUM_OPT and
# RHODIUM_UPGRADE_SOCKET.
set -euo pipefail

die() {
  echo "upgrade: $*" >&2
  exit 1
}

usage="usage: $0 [-m <note>] <instance> [git ref, origin/main by default]"
note=
while getopts m: opt; do
  [[ $opt == m ]] || die "$usage"
  note=$OPTARG
done
shift $((OPTIND - 1))
instance=${1-}
ref=${2:-origin/main}
[[ ($# == 1 || $# == 2) && $instance =~ ^[A-Za-z0-9:_.-]+$ ]] || die "$usage"
repo=$(cd "$(dirname "$0")/.." && pwd)
opt=${RHODIUM_OPT:-$HOME/.local/opt/$instance}
# Not the RHODIUM_SOCKET your shell may have: rh reads it, and it may be another instance's.
export RHODIUM_SOCKET=${RHODIUM_UPGRADE_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$instance/rh.sock}

# Points the symlink <opt>/<name> at <target> in one step.
point() {
  ln -sfn "$2" "$opt/$1.new"
  mv -T "$opt/$1.new" "$opt/$1"
}

# Restarts the service and waits up to a minute for rhodium to answer. A rhodium that keeps failing
# to start leaves the unit failed within seconds (StartLimitBurst), so it does not wait that long.
# rh has no timeout of its own, so a rhodium that takes the call and never answers would hang it.
up() {
  systemctl --user reset-failed "$instance" 2>/dev/null || true
  systemctl --user restart "$instance" || return 1
  local end=$((SECONDS + 60))
  while ((SECONDS < end)); do
    timeout --foreground 5 "$opt/current/rh" ls >/dev/null 2>&1 && return 0
    systemctl --user is-failed --quiet "$instance" && return 1
    sleep 0.5
  done
  return 1
}

# Runs rh doctor and prints its report; false if it could not run or found an error. Not one of the
# board (错误：看板...) or of your codex (错误：Codex...): the config's or codex's, not the version's,
# so going back fixes none of them.
healthy() {
  local report
  report=$(timeout --foreground 60 "$opt/current/rh" doctor) || return 1
  echo "$report"
  ! grep '^错误：' <<<"$report" | grep -qv -e '^错误：看板' -e '^错误：Codex'
}

mkdir -p "$opt/versions"
new=$(mktemp -d "$opt/versions/.build-XXXXXX")
work=$(mktemp -d -t rhodium-upgrade-XXXXXX)
# Removes the temporary checkout, and the new version unless it was moved into place.
clean() {
  rm -rf "$new"
  git -C "$repo" worktree remove --force "$work" 2>/dev/null || rm -rf "$work"
}
trap clean EXIT
git -C "$repo" fetch --quiet origin
git -C "$repo" worktree add --quiet --detach "$work" "$ref"
RHODIUM_BUILD_NOTE=$note "$work/scripts/build.sh" "$new"
# <version>-<commit>, as rhodium --version says it; one built before 1.0.0 says only the version.
build=$("$new/rhodium" --version)
[[ $build == *-* ]] || build+="-$(git -C "$work" describe --always)"
name="$build-${new##*-}"
ln -s rhodium "$new/rh"
mv "$new" "$opt/versions/$name"
clean
trap - EXIT

old=$(readlink "$opt/current" || true)
if ! systemctl --user cat "$instance.service" >/dev/null 2>&1; then
  point current "versions/$name"
  echo "Installed $opt/versions/$name as $opt/current. The service $instance is not installed yet:"
  echo "install it with scripts/rhodium-service.sh, running $opt/current/rhodium."
  exit 0
fi

# The database's schema, read by the new rhodium with the service's --config (rhodium-service.sh puts it last).
config=$(systemctl --user show -p ExecStart --value "$instance" | sed -n 's/.* --config \(.*\) ; ignore_errors=.*/\1/p')
schema() { "$opt/versions/$name/rhodium" --schema --config "$config"; }
before=$(schema) || die "$name cannot read the schema of $instance's database (config: ${config:-not found in the service})"
point current "versions/$name"

if up && healthy; then
  [[ -z $old ]] || point previous "$old"
  echo "$instance now runs $name."
  exit 0
fi
[[ -n $old ]] || die "$name does not work, and there is no version before it to go back to: see journalctl --user -u $instance"
after=$(schema) || after=unknown
[[ $after == "$before" ]] || die "$name does not work, but it has moved the database from schema $before to $after," \
  "which ${old#versions/} cannot open, so $instance stays on $name: see journalctl --user -u $instance"
echo "upgrade: $name does not work; going back to ${old#versions/}" >&2
point current "$old"
up || die "${old#versions/} does not come back either: see journalctl --user -u $instance"
echo "upgrade: $instance runs ${old#versions/} again" >&2
exit 1
