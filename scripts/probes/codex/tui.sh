#!/usr/bin/env bash
# ADR-0011's open item: can `codex resume` and a private app-server write one thread at once?
# Runs after probe.ts has recorded "turn" (it needs the thread id in <work>/state.json).
# Uses only the Herdr session rhodium-test, whose server runs in the unit rhodium-test-herdr-codex.
# No model turn unless TURN=1 (one tiny prompt typed into the TUI, to see when Herdr learns the session).
# Leaves one line in ~/.codex/history.jsonl when TURN=1 (the TUI records typed prompts there).
#   scripts/probes/codex/tui.sh <work-dir> [fixtures-dir]
set -euo pipefail
WORK=$(realpath "$1")
CWD=$WORK/project
probe() { bun "$(dirname "$0")/probe.ts" "$WORK" "$@" ${FIXTURES:+--fixtures "$FIXTURES"}; }
FIXTURES=${2:-}
H=(herdr --session rhodium-test)
THREAD=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['thread'])" "$WORK/state.json")
pane() { "${H[@]}" pane get w1:p1 | python3 -c "import json,sys; p=json.load(sys.stdin)['result']['pane']; print('agent', p.get('agent'), 'session', (p.get('agent_session') or {}).get('value'))"; }
wait_for() { "${H[@]}" pane wait-output w1:p1 --source visible --regex "$1" --timeout "${2:-30000}" >/dev/null; }
locks() { lslocks -o PID,MODE,PATH | grep thread-writer-locks || echo "no writer lock"; }

systemd-run --user --unit rhodium-test-herdr-codex --setenv=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" herdr --session rhodium-test server
trap '"${H[@]}" workspace close w1 >/dev/null 2>&1 || true; touch "$WORK/tui-done"; systemctl --user stop rhodium-test-herdr-codex' EXIT
sleep 2

rm -f "$WORK"/tui-ready "$WORK"/tui-done
probe tui-coexist >"$WORK/tui-coexist.report" &
until [ -f "$WORK/tui-ready" ]; do sleep 0.5; done
echo "== private app-server holds the thread"; locks

"${H[@]}" workspace create --cwd "$CWD" --label codex-tui --no-focus >/dev/null
sleep 2 # let the shell start before typing
# The trust override keeps the TUI's folder-trust prompt away without writing ~/.codex/config.toml.
"${H[@]}" pane send-text w1:p1 "codex resume $THREAD -m gpt-6-luna -c model_reasoning_effort=low -c 'projects={\"$CWD\"={trust_level=\"trusted\"}}'" >/dev/null
"${H[@]}" pane send-keys w1:p1 enter >/dev/null
# Dialogs that may come first: "Update available" and "Hooks need review" (plugin hooks changed).
# Esc skips each without updating or trusting anything.
for _ in 1 2 3 4; do
  wait_for 'Update available|Hooks need review|open in another app' || { "${H[@]}" pane read w1:p1 | tail; exit 1; }
  wait_for 'open in another app' 500 && break
  "${H[@]}" pane send-keys w1:p1 esc >/dev/null; sleep 1
done
echo "== TUI screen while the private app-server holds the thread"; "${H[@]}" pane read w1:p1 | tail -4
pane

touch "$WORK/tui-done"; wait
echo "== private app-server gone; press r in the TUI"
"${H[@]}" pane send-text w1:p1 r >/dev/null
wait_for 'Ask Codex' 20000
"${H[@]}" pane read w1:p1 | tail -3; locks; pane
probe resume-locked

if [ "${TURN:-0}" = 1 ]; then
  python3 -c "import json,sys; p=sys.argv[1]; s=json.load(open(p)); s['turns']+=1; json.dump(s, open(p,'w'), indent=2)" "$WORK/state.json"
  "${H[@]}" pane send-text w1:p1 "Reply with the single word: pong." >/dev/null
  sleep 1; "${H[@]}" pane send-keys w1:p1 enter >/dev/null
  wait_for 'pong' 60000; sleep 2
  echo "== after one TUI turn"; pane
fi

"${H[@]}" pane send-keys w1:p1 ctrl+c >/dev/null; sleep 1; "${H[@]}" pane send-keys w1:p1 ctrl+c >/dev/null; sleep 3
echo "== TUI exited"; locks; pane
probe resume-after-tui
