// Run from a private temp directory against a disposable named session, never a user's server.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { terminalSocket } from "./socket";
import { serveBoard } from "../../../src/board";
import { loadConfig } from "../../../src/config";
import { request, sessionSocket } from "../../../src/herdr";
import { openStore } from "../../../src/store";

const [herdr, session, python, observer, supervisor] = process.argv.slice(2);
const dir = process.cwd();
if (!herdr || !isAbsolute(herdr) || !python || !isAbsolute(python) || !session?.startsWith("rhodium-test-") || !process.env.XDG_CONFIG_HOME) {
  throw new Error("Expected isolated Herdr executable, rhodium-test- session, Python executable and XDG_CONFIG_HOME");
}
const at = await sessionSocket(herdr, session);
const assert = (condition: unknown, what: string) => { if (!condition) throw new Error(what); };
const fixture = join(dir, "terminal-fixture.py");
writeFileSync(fixture, [
  "import json, os, subprocess, sys",
  ...(observer ? [
    "child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(45)'])",
    "with open('fixture-pids', 'w') as f: json.dump([os.getpid(), child.pid], f)",
  ] : []),
  "print('PTY_READY', flush=True)",
  "for line in sys.stdin:",
  "    if line.strip() == 'probe':",
  "        size = os.get_terminal_size()",
  "        print('PTY_REPLY_%dx%d' % (size.columns, size.lines), flush=True)",
].join("\n"));
const { workspace } = await request(at, "workspace.create", { cwd: dir, label: "board-probe", focus: false });
const { layout } = await request(at, "layout.apply", { workspace_id: workspace.workspace_id, tab_label: "probe",
  root: { type: "pane", cwd: dir, command: [...(supervisor ? [supervisor] : []), python, "-I", "-u", fixture] } });
const pane = layout.root.pane_id;
const { process_info } = await request(at, "pane.process_info", { pane_id: pane });
const { snapshot } = await request(at, "session.snapshot");
assert(snapshot.panes.some((p: any) => p.pane_id === pane), "missing pane in snapshot");
console.log("snapshot/get/process_info", !!(await request(at, "pane.get", { pane_id: pane })).pane, !!process_info.shell_pid,
  "foreground candidates", process_info.foreground_processes?.length ?? 0);
const cfg = join(dir, "board-probe.toml");
writeFileSync(cfg, `stateDir = ${JSON.stringify(dir)}\n[programs]\nherdr = ${JSON.stringify(herdr)}\n[herdr]\nsession = ${JSON.stringify(session)}\n[board]\nbind = "127.0.0.1"\nauth = "none"\nport = 0\n`, { mode: 0o600 });
const store = openStore(join(dir, "board-probe.db"));
const slot = store.tx(tx => {
  const workspace = tx.insert("workspace", { name: "probe", dir }).id;
  return tx.insert("slot", { workspace, name: "pane", dir, mode: "tui", state: "idle", lifetime: "longterm", herdrPane: pane }).id;
});
const board = serveBoard(store, loadConfig(cfg)).servers[0]!;
const origin = "http://127.0.0.1:" + board.port;
try {
  const first = terminalSocket(origin, slot);
  await first.wait("PTY_READY");
  if (supervisor) {
    await first.wait("JOB_TREE_READY");
    console.log("Job process count at attached console", readFileSync(join(dir, "job-count"), "utf8"));
  }
  const watch = observer ? Bun.spawn([python, "-I", "-u", observer, ...(supervisor ? ["job"] : [])], { cwd: dir, stdout: "pipe", stderr: "inherit" }) : null;
  const lines = watch?.stdout.getReader();
  if (lines) assert(new TextDecoder().decode((await lines.read()).value).includes("pinned"), "failed to pin live test processes");
  first.ws.send(JSON.stringify({ t: "size", c: 91, r: 29 }));
  first.ws.send(JSON.stringify({ t: "in", d: "probe\r" }));
  await first.wait("PTY_REPLY_91x29");
  console.log("PASS real board WS binary output, input and resize");
  const second = terminalSocket(origin, slot);
  assert(await first.closed === 4001, "takeover code");
  await second.wait("PTY_READY");
  await request(at, "pane.close", { pane_id: pane });
  if (watch && lines) {
    writeFileSync(join(dir, "pane-closed"), "");
    let out = "";
    for (;;) { const row = await lines.read(); if (row.done) break; out += new TextDecoder().decode(row.value); }
    console.log(supervisor ? "window Job" : "plain Herdr", out.trim());
    assert(await watch.exited === 0, "OS exit check failed");
  }
  const code = await Promise.race([second.closed, Bun.sleep(4500).then(() => 0)]);
  console.log("pane.close WebSocket result", code);
  assert(code === 4000, "pane close did not reach board as terminal exit");
} finally {
  board.stop(true);
}
