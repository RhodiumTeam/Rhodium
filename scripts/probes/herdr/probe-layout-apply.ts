#!/usr/bin/env bun
// How Herdr's layout.apply starts a tab running a command with no shell (#372), the way the Herdr
// bridge starts a slot's agent (architecture §10.3 "启动命令"), recorded for the fake Herdr's test to
// compare against.
//
// Runs a Herdr server for session `rhodium-test` under a temporary HOME, with HERDR_CONFIG_PATH at a
// temporary config that turns resume_agents_on_restore off, so neither your Herdr sessions nor its
// config are touched, and stops it at the end. Makes Rhodium's workspace, then a tab by layout.apply
// whose pane runs `/usr/bin/env -u PROBE_UNSET PATH=/usr/bin:/bin sleep 30` with the slot's variables
// in env; reads what the pane runs and its environment; presses Ctrl+C as rh release does, and the
// pane, its tab and workspace go. Then layout.apply into a workspace that is not there. No agent runs.
//
//   bun scripts/probes/herdr/probe-layout-apply.ts [--fixture PATH]
//
// Prints each line. --fixture writes the socket traffic, requests and answers then the events heard,
// the temporary directory replaced by /work, as test/fixtures/herdr/layout-apply.jsonl is: dir ">>" a
// request, "<<" its answer, "proc" what /proc says of the pane's process, "ev" an event.

import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { call, subscribe } from "../../../src/herdr";
import { synthPath } from "../synth";

const HERDR = process.env.HERDR_BIN ?? join(homedir(), ".local/bin/herdr");
const at = process.argv.indexOf("--fixture");
const FIXTURE = at > 0 ? process.argv[at + 1] : undefined;

const work = mkdtempSync(join(tmpdir(), "rhodium-test-layout-"));
const config = join(work, "herdr.toml");
writeFileSync(config, "[session]\nresume_agents_on_restore = false\n");
const env = { HOME: work, PATH: process.env.PATH!, SHELL: "/bin/sh", TERM: "xterm-256color", HERDR_CONFIG_PATH: config, PROBE_UNSET: "server's" };
const socket = join(work, ".config/herdr/sessions/rhodium-test/herdr.sock");
const server = Bun.spawn([HERDR, "--session", "rhodium-test", "server"], { env, stdout: "ignore", stderr: "ignore" });
const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => {
  log.push({ t: Date.now() - t0, dir, msg });
  console.log(dir, JSON.stringify(msg).slice(0, 300));
};
let n = 0;
async function ask(method: string, params: object = {}): Promise<any> {
  const id = `la:${++n}`;
  rec(">>", { id, method, params });
  const answer = { ...(await call(socket, method, params)), id };
  rec("<<", answer);
  return answer;
}

try {
  for (const end = Date.now() + 10_000; !(await call(socket, "ping").catch(() => undefined)); await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error("no Herdr socket in 10 s");
  }
  const sub = subscribe(socket, ["workspace.created", "workspace.closed", "tab.created", "tab.closed", "pane.created", "pane.closed", "pane.exited", "pane.agent_detected"]);
  await sub.started;
  const ws = (await ask("workspace.create", { cwd: work, label: "w", focus: false })).result;
  const root = { type: "pane", cwd: work, env: { RHODIUM_SLOT: "slot-1", RHODIUM_TOKEN: "token-1" }, command: ["/usr/bin/env", "-u", "PROBE_UNSET", "PATH=/usr/bin:/bin", "sleep", "30"] };
  const { layout } = (await ask("layout.apply", { workspace_id: ws.workspace.workspace_id, tab_label: "slot", root })).result;
  await ask("tab.close", { tab_id: ws.tab.tab_id });
  // What the bridge's agentPid reads: the pane's process, env until it execs the command.
  let pid = 0;
  for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(100)) {
    pid = (await ask("pane.process_info", { pane_id: layout.root.pane_id })).result.process_info.shell_pid;
    if (basename(readlinkSync(`/proc/${pid}/exe`)) === "sleep") break;
  }
  const environ = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const kept = ["RHODIUM_SLOT", "RHODIUM_TOKEN", "PATH", "PROBE_UNSET", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"];
  rec("proc", { pid, exe: basename(readlinkSync(`/proc/${pid}/exe`)), cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1), cwd: readlinkSync(`/proc/${pid}/cwd`), env: Object.fromEntries(kept.map((k) => [k, environ.get(k) ?? null])) });
  await ask("session.snapshot");
  await ask("pane.send_keys", { pane_id: layout.root.pane_id, keys: ["ctrl+c"] });
  for (const end = Date.now() + 5000; !sub.events.some((e) => e.event === "pane_exited") && Date.now() < end; ) await Bun.sleep(50);
  await Bun.sleep(300);
  await ask("session.snapshot");
  await ask("layout.apply", { workspace_id: "w99", tab_label: "x", root });
  for (const e of sub.events) rec("ev", e);
  sub.close();
  if (FIXTURE) {
    writeFileSync(FIXTURE, log.map((l) => JSON.stringify(l).replaceAll(work, "/work")).join("\n") + "\n");
    synthPath(FIXTURE, "herdr");
  }
} finally {
  server.kill();
  await server.exited;
  rmSync(work, { recursive: true, force: true });
}
