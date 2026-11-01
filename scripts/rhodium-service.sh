#!/usr/bin/env bash
# Install or remove rhodium as a systemd user service: started at boot (linger is on),
# restarted when it dies (docs/product.md §10, story 148).
#
#   rhodium-service.sh install <unit> --config <file> --path <PATH> [--env NAME=VALUE]... [--alert-env <file>] -- <rhodium> [args...]
#   rhodium-service.sh uninstall <unit>
#
# --alert-env: once rhodium keeps failing to start and systemd gives up on it, the unit <unit>-alert
# tells you on Telegram with nothing but curl (architecture §12, story 134). It reads only <file>,
# never rhodium's config, so a broken config cannot stop the alert. <file> is mode 0600 and holds
#   TELEGRAM_TOKEN=<the alert bot's token>
#   TELEGRAM_CHAT_ID=<your chat id with that bot>
#   TELEGRAM_API=<another Bot API server, for tests>   (optional; https://api.telegram.org)
#
# <unit> names the instance, so the one in use, a dev instance and each test instance get their
# own: rhodium, rhodium-dev, rhodium-test-<random>-rhodium. The unit runs `<rhodium> [args...]
# --config <file>`. Paths are absolute and PATH is spelled out: a user service's PATH has
# neither nvm nor bun. install restarts a running instance, so it also upgrades one.
set -euo pipefail

marker="# Written by Rhodium's rhodium-service.sh, which only overwrites or removes files with this line."
dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

die() {
  echo "rhodium-service: $*" >&2
  exit 2
}
abs() { [[ $1 == /* ]] || die "$2 must be an absolute path, not '$1'"; }
# One double-quoted word for a unit file. % starts a specifier; on Exec lines $ starts a variable.
quote() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//%/%%}
  [[ ${2-} == exec ]] && s=${s//\$/\$\$}
  printf '"%s"' "$s"
}

cmd=${1-} unit=${2-}
[[ $cmd == install || $cmd == uninstall ]] && [[ $unit =~ ^[A-Za-z0-9:_.-]+$ ]] ||
  die "usage: $0 install <unit> --config <file> --path <PATH> [--env NAME=VALUE]... [--alert-env <file>] -- <rhodium> [args...] | uninstall <unit>"
shift 2
file="$dir/$unit.service"
alert_file="$dir/$unit-alert.service"
for f in "$file" "$alert_file"; do
  if [[ -e $f ]] && ! grep -qxF "$marker" "$f"; then die "$f was not written by this script; leaving it alone"; fi
done

if [[ $cmd == uninstall ]]; then
  [[ -e $file ]] || exit 0
  systemctl --user disable --now --quiet "$unit"
  # Forget a failed run; a unit that stopped cleanly is already unloaded, which is fine too.
  systemctl --user reset-failed "$unit" "$unit-alert" 2>/dev/null || true
  rm -f "$file" "$alert_file"
  systemctl --user daemon-reload
  exit 0
fi

config= path= envs=() alert=
while (($#)); do
  case $1 in
  --config) config=${2-} && shift 2 ;;
  --path) path=${2-} && shift 2 ;;
  --env) [[ ${2-} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die "--env takes NAME=VALUE"; envs+=("$2") && shift 2 ;;
  --alert-env) alert=${2-} && shift 2 ;;
  --) shift && break ;;
  *) die "unknown option $1" ;;
  esac
done
(($#)) || die "missing -- <rhodium> [args...]"
abs "$1" "<rhodium>"
[[ -x $1 ]] || die "$1 is not executable"
abs "$config" "--config"
[[ -n $path ]] || die "--path is required"
IFS=: read -ra entries <<<"$path"
for e in "${entries[@]}"; do abs "$e" "every --path entry"; done
if [[ -n $alert ]]; then
  abs "$alert" "--alert-env"
  [[ $alert != *[[:space:]]* ]] || die "--alert-env must have no spaces in it"
  [[ -f $alert ]] || die "$alert does not exist"
  [[ $(stat -c %a "$alert") == 600 ]] || die "$alert must be mode 0600: it holds a bot token"
  [[ -x /usr/bin/curl ]] || die "the alert needs /usr/bin/curl"
fi

exec_start=
for a in "$@" --config "$config"; do exec_start+="$(quote "$a" exec) "; done
mkdir -p "$dir"
if [[ -n $alert ]]; then
  text="Rhodium（$unit，$(hostname)）起不来了：反复启动失败，systemd 已不再拉起它，IM 遥控断了。"
  text+="ssh 上去用 journalctl --user -u $unit 看原因；修好后运行 systemctl --user reset-failed $unit，再 systemctl --user start $unit。"
  {
    echo "$marker"
    echo "[Unit]"
    echo "Description=Telegram alert that Rhodium ($unit) failed"
    echo
    echo "[Service]"
    echo "Type=oneshot"
    # The file's own TELEGRAM_API wins over this. (curl 8.5's --variable %NAME=default would not let it.)
    echo "Environment=TELEGRAM_API=https://api.telegram.org"
    echo "EnvironmentFile=${alert//%/%%}"
    # curl takes the token from its environment, so it is never on a command line.
    # It goes out exactly when things are broken: a network blip must not lose it.
    echo -n "ExecStart=/usr/bin/curl -sS --fail --max-time 10 --retry 3 --retry-all-errors -o /dev/null"
    echo -n " --variable %%TELEGRAM_API --variable %%TELEGRAM_TOKEN --variable %%TELEGRAM_CHAT_ID"
    echo -n " --expand-url {{TELEGRAM_API}}/bot{{TELEGRAM_TOKEN}}/sendMessage --expand-data-urlencode chat_id={{TELEGRAM_CHAT_ID}}"
    echo " --data-urlencode $(quote "text=$text" exec)"
  } >"$alert_file.tmp"
  mv "$alert_file.tmp" "$alert_file"
else
  rm -f "$alert_file" # one an earlier install left
fi
{
  echo "$marker"
  echo "[Unit]"
  echo "Description=Rhodium agent host ($unit)"
  # Failing to start 5 times in a minute, it stays down: failed, which sends the alert.
  echo "StartLimitIntervalSec=60s"
  echo "StartLimitBurst=5"
  [[ -z $alert ]] || echo "OnFailure=$unit-alert.service"
  echo
  echo "[Service]"
  echo "ExecStart=${exec_start% }"
  echo "Environment=$(quote "PATH=$path")"
  for e in "${envs[@]}"; do echo "Environment=$(quote "$e")"; done
  echo "Restart=on-failure"
  echo "RestartSec=1s"
  # A restart skips the failed state, so a crash it recovers from sends no alert (systemd 254+).
  echo "RestartMode=direct"
  echo
  echo "[Install]"
  echo "WantedBy=default.target"
} >"$file.tmp"
mv "$file.tmp" "$file"
systemctl --user daemon-reload
systemctl --user enable --quiet "$unit"
systemctl --user restart "$unit"
