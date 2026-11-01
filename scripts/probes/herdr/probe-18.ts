#!/usr/bin/env bun
// Probe 18 (docs/spec/v1.md, "真机探针"): Herdr session IDs, launch-command env, agent PID,
// server restart vs. auto-resume, and the restore record.
//
// Runs against a throwaway Herdr session `rhodium-test-p18-<suffix>` whose server lives in the
// transient user unit `rhodium-test-herdr-p18-<suffix>`. Never touches the `default` session or
// Herdr's config. Opens Claude's TUI and types only local slash commands (/clear, /resume) and
// Ctrl-C, so nothing reaches the model. Claude still starts with `--model haiku`, so a slip that
// does reach the model costs little.
//
// Cleans up its Herdr session, cwd and Claude transcripts. It leaves two lines of user history it
// does not own: the typed /clear and /resume in ~/.claude/history.jsonl, and the
// `claude --resume <id>` that Herdr's auto-resume types into the restored shell.
//
//   bun scripts/probes/herdr/probe-18.ts [--fixture PATH]
//
// Prints PASS/FAIL per check (exit 1 on any FAIL) and NOTE lines for measured facts. The raw
// socket traffic goes to .scratch/probe18-<suffix>.jsonl, with a `stop` line where the probe stops
// the server; --fixture also writes a copy with home, cwd and session names replaced by fixed
// placeholders.

import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { synthPath } from "../synth";

const HOME = homedir();
const HERDR = process.env.HERDR_BIN ?? join(HOME, ".local/bin/herdr");
const CLAUDE = process.env.CLAUDE_BIN ?? Bun.which("claude") ?? die("claude not on PATH; set CLAUDE_BIN");
const SUFFIX = randomBytes(4).toString("hex");
const SESSION = `rhodium-test-p18-${SUFFIX}`;
const UNIT = `rhodium-test-herdr-p18-${SUFFIX}`;
const REPO = resolve(import.meta.dir, "../../..");
// Under the repo so Claude's folder-trust dialog doesn't appear (the user already trusts it).
const CWD = join(REPO, ".scratch", `probe18-${SUFFIX}`);
// Same PATH as a Herdr server the user starts with systemd.
const SERVER_PATH = `${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const fixtureArg = process.argv.indexOf("--fixture");
const FIXTURE = fixtureArg > 0 ? process.argv[fixtureArg + 1] : undefined;

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// ---- recording and verdicts

const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => log.push({ t: Date.now() - t0, dir, msg });
let failed = false;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}
const note = (name: string, detail: string) => console.log(`NOTE ${name}: ${detail}`);

// ---- Herdr socket: one JSON line per request, one JSON line back

let SOCK = "";
let SESSION_JSON = "";
let reqSeq = 0;
// Polls are recorded only when their answer changes.
const POLLS = new Set(["ping", "pane.get", "pane.process_info", "session.snapshot"]);
const lastResult = new Map<string, string>();

function call(method: string, params: object = {}): Promise<any> {
  const req = { id: `p18:${++reqSeq}`, method, params };
  return new Promise((ok, ko) => {
    const s = connect(SOCK);
    let buf = "";
    s.setTimeout(10_000, () => s.destroy(new Error(`${method}: timeout`)));
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const res = JSON.parse(buf.slice(0, i));
      const key = method + JSON.stringify(params), answer = JSON.stringify(res.result ?? res.error);
      if (!POLLS.has(method) || lastResult.get(key) !== answer) {
        lastResult.set(key, answer);
        rec(">>", req);
        rec("<<", res);
      }
      s.end();
      if (res.error) ko(new Error(`${method}: ${JSON.stringify(res.error)}`));
      else ok(res.result);
    });
    s.on("error", ko);
  });
}

const EVENT_TYPES = ["workspace.created", "workspace.closed", "tab.created", "tab.closed", "pane.created",
  "pane.closed", "pane.updated", "pane.exited", "pane.agent_detected"];

function subscribe(): Socket {
  const req = { id: "p18:sub", method: "events.subscribe",
    params: { subscriptions: EVENT_TYPES.map((type) => ({ type })) } };
  const s = connect(SOCK);
  let buf = "";
  s.on("connect", () => {
    rec(">>", req);
    s.write(JSON.stringify(req) + "\n");
  });
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) rec("ev", JSON.parse(buf.slice(0, i)));
  });
  s.on("close", () => rec("ev", "EOF"));
  s.on("error", () => {});
  return s;
}
const events = (type: string) => log.filter((l) => l.dir === "ev" && (l.msg as any)?.event === type).map((l) => (l.msg as any).data);

// ---- helpers

type Truthy<T> = Exclude<T, false | null | undefined | 0 | "">;
async function waitFor<T>(what: string, ms: number, f: () => T | Promise<T>): Promise<Truthy<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(f).catch(() => undefined);
    if (v) return v as Truthy<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function sh(argv: string[], env?: Record<string, string>): string {
  const r = Bun.spawnSync(argv, { env: env ?? process.env as Record<string, string> });
  if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const startServer = () => sh(["systemd-run", "--user", "--unit", UNIT, `--setenv=PATH=${SERVER_PATH}`,
  "--setenv=RHODIUM_PROBE_SERVER=1", HERDR, "--session", SESSION, "server"]);
function stopServer() {
  try { sh(["systemctl", "--user", "stop", UNIT]); } catch {}
  try { sh(["systemctl", "--user", "reset-failed", UNIT]); } catch {}
}
const ready = () => waitFor("herdr socket", 15_000, () => call("ping"));
// Stop the server with the subscription still open, to record what it sees: the `stop` line, then
// whatever Herdr sends while shutting down, then EOF.
async function stopUnderSubscription(sub: Socket) {
  rec("stop", "systemctl stop");
  stopServer();
  await waitFor("server to close the subscription", 5_000, () => sub.destroyed);
}

const pane = async (id: string) => (await call("pane.get", { pane_id: id })).pane;
const seen = new Set<string>(); // every conversation the probe touched, for cleanup
async function paneSession(id: string): Promise<string | undefined> {
  const v: string | undefined = (await pane(id)).agent_session?.value;
  if (v) seen.add(v);
  return v;
}
async function agentPid(id: string): Promise<number | undefined> {
  const info = (await call("pane.process_info", { pane_id: id })).process_info;
  return info.foreground_processes?.find((p: any) => p.name === "claude")?.pid;
}
function environ(pid: number): Record<string, string> {
  const kv = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
  return Object.fromEntries(kv.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
}
const alive = (pid: number) => existsSync(`/proc/${pid}`);
// Every process whose command line names this conversation, like Rhodium's /proc scan.
function holders(sessionId: string): number[] {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d) && +d !== process.pid).filter((d) => {
    try { return readFileSync(`/proc/${d}/cmdline`, "utf8").includes(sessionId); } catch { return false; }
  }).map(Number);
}
const savedRecord = () => (existsSync(SESSION_JSON) ? readFileSync(SESSION_JSON, "utf8") : "");
const findPane = async (sessionId: string) =>
  (await call("session.snapshot")).snapshot.panes.find((p: any) => p.agent_session?.value === sessionId);

// Local slash command: type it, let the menu settle, then Enter.
async function slash(paneId: string, text: string) {
  await call("pane.send_text", { pane_id: paneId, text });
  await Bun.sleep(700);
  await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
}
// Typed into the pane's shell. The leading space keeps the line out of history in shells with
// hist_ignore_space (oh-my-zsh default); `exec` makes the pane exit with the agent.
const typed = (cmd: string) => ` exec ${cmd}`;
async function waitIdle(paneId: string) {
  const p = await waitFor("claude TUI", 30_000, async () => {
    const p = await pane(paneId);
    return p.agent === "claude" && p.agent_status !== "unknown" && p.agent_session && p;
  });
  if (p.agent_status === "blocked") throw new Error("claude is blocked at startup (folder trust dialog?)");
}

// ---- the probe

async function probe() {
  mkdirSync(CWD, { recursive: true });
  startServer();
  const listed = await waitFor("session in herdr session list", 15_000, () =>
    JSON.parse(sh([HERDR, "session", "list", "--json"])).sessions.find((s: any) => s.name === SESSION && s.running));
  SOCK = listed.socket_path;
  SESSION_JSON = join(listed.session_dir, "session.json");
  await ready();
  let sub = subscribe();

  // 1. The session ID a pane reports follows /clear and /resume.
  // The spec's launch form: env vars as an `env` prefix on the command line.
  const ws1 = await call("workspace.create", { cwd: CWD, label: "probe18" });
  const p1 = ws1.root_pane.pane_id;
  await call("pane.send_input", { pane_id: p1,
    text: typed(`env RHODIUM_SLOT=probe-slot RHODIUM_TOKEN=probe-token ${CLAUDE} --model haiku --strict-mcp-config`), keys: ["enter"] });
  await waitIdle(p1);
  const a = (await paneSession(p1))!;
  const pid1 = (await agentPid(p1))!;
  const env1 = environ(pid1);
  check("env prefix on the launch command reaches the agent",
    env1.RHODIUM_SLOT === "probe-slot" && env1.RHODIUM_TOKEN === "probe-token",
    `RHODIUM_SLOT=${env1.RHODIUM_SLOT} RHODIUM_TOKEN=${env1.RHODIUM_TOKEN}`);
  await slash(p1, "/clear");
  const b = await waitFor("id after /clear", 15_000, async () => { const s = await paneSession(p1); return s !== a && s; });
  await slash(p1, "/clear");
  const c = await waitFor("id after 2nd /clear", 15_000, async () => { const s = await paneSession(p1); return s !== b && s; });
  await slash(p1, `/resume ${b}`);
  const back = await waitFor("id after /resume", 15_000, async () => { const s = await paneSession(p1); return s === b && s; })
    .catch(() => undefined);
  check("session id follows /clear and /resume", !!back, `start ${a} → /clear ${b} → /clear ${c} → /resume → ${back}`);
  const evented = events("pane_updated").some((d) => [b, c].includes(d.pane?.agent_session?.value));
  note("session id change event", evented ? "a pane_updated event carried the new id" : "no event carries the new id; poll pane.get");

  // Agent exit under `exec`: the pane exits, its tab closes, and the reported id is gone with it.
  for (const _ of [1, 2]) {
    await call("pane.send_keys", { pane_id: p1, keys: ["ctrl+c"] });
    await Bun.sleep(400);
  }
  await waitFor("claude exit", 10_000, () => !alive(pid1));
  await waitFor("pane_exited", 5_000, () => events("pane_exited").some((d) => d.pane_id === p1));
  const left = (await call("session.snapshot")).snapshot;
  note("agent exit under exec", `pane_exited for ${p1}; workspaces left: ${left.workspaces.length}, panes left: ${left.panes.length}`);
  await call("pane.get", { pane_id: p1 }).catch((e) => note("pane.get on a gone pane", e.message));

  // 2. The bridge's launch form (architecture §10.3): tokens via tab.create's env (kept out of
  //    shell history), PATH in the typed ` exec env PATH=… claude --resume` line. The agent gets
  //    all three; its PID is readable.
  process.env.RHODIUM_PROBE_CLIENT = "1";
  const agentPath = `${dirname(CLAUDE)}:${SERVER_PATH}`;
  const ws2 = await call("workspace.create", { cwd: CWD, label: "probe18" });
  const tab2 = await call("tab.create", { workspace_id: ws2.workspace.workspace_id, cwd: CWD, label: "slot",
    env: { RHODIUM_SLOT: "probe-slot-2", RHODIUM_TOKEN: "probe-token-2" } });
  const p2 = tab2.root_pane.pane_id;
  // Why PATH is not in tab.create's env: the shell rc rewrites it. A plain process shows what survives.
  const rcPane = (await call("tab.create", { workspace_id: ws2.workspace.workspace_id, cwd: CWD, label: "rc",
    env: { PATH: agentPath } })).root_pane.pane_id;
  await call("pane.send_input", { pane_id: rcPane, text: typed("sleep 600"), keys: ["enter"] });
  const cliOut = sh([HERDR, "--session", SESSION, "tab", "create", "--workspace", ws2.workspace.workspace_id,
    "--label", "cli", "--no-focus"], process.env as Record<string, string>);
  rec("cli", { argv: ["herdr", "tab", "create", "--workspace", ws2.workspace.workspace_id, "--label", "cli", "--no-focus"],
    out: JSON.parse(cliOut) });
  await call("pane.send_input", { pane_id: p2,
    text: typed(`env PATH=${agentPath} ${CLAUDE} --model haiku --strict-mcp-config --resume ${b}`), keys: ["enter"] });
  await waitIdle(p2);
  const pid2 = await agentPid(p2);
  const env2 = pid2 ? environ(pid2) : {};
  const cmd2 = pid2 ? readFileSync(`/proc/${pid2}/cmdline`, "utf8").split("\0").join(" ") : "";
  check("pane reports the resumed id", (await paneSession(p2)) === b, `${await paneSession(p2)}`);
  check("agent PID from pane.process_info", !!pid2 && cmd2.includes(`--resume ${b}`), `${pid2}: ${cmd2}`);
  check("tab.create env reaches the agent", env2.RHODIUM_SLOT === "probe-slot-2" && env2.RHODIUM_TOKEN === "probe-token-2",
    `RHODIUM_SLOT=${env2.RHODIUM_SLOT} RHODIUM_TOKEN=${env2.RHODIUM_TOKEN}`);
  check("PATH typed in the launch command reaches the agent unchanged", env2.PATH === agentPath, `${env2.PATH}`);
  const rcPid = await waitFor("sleep in the rc tab", 15_000, async () =>
    (await call("pane.process_info", { pane_id: rcPane })).process_info.foreground_processes?.find((p: any) => p.name === "sleep")?.pid);
  const rcPath = environ(rcPid).PATH;
  const cliShell = (await call("pane.process_info", { pane_id: JSON.parse(cliOut).result.root_pane.pane_id })).process_info.shell_pid;
  note("pane env sources", `server env ${env2.RHODIUM_PROBE_SERVER ? "yes" : "no"}, ` +
    `CLI client env ${environ(cliShell).RHODIUM_PROBE_CLIENT ? "yes" : "no"}, HERDR_* ${env2.HERDR_PANE_ID ? "yes" : "no"}; ` +
    `PATH given to tab.create ${rcPath === agentPath ? "arrives unchanged" : `arrives as ${rcPath} (shell rc)`}`);

  // 3. Restart; right after reconnecting, release the agent but keep the tab.
  await waitFor("session.json records the id", 15_000, () => savedRecord().includes(b));
  await stopUnderSubscription(sub);
  await waitFor("agent gone with the server", 5_000, () => !alive(pid2!));
  let tStart = Date.now();
  startServer();
  await ready();
  const tReady = Date.now() - tStart;
  sub = subscribe();
  const restored = await waitFor("restored pane", 3_000, () => findPane(b)).catch(() => undefined);
  const releasedPane = restored?.pane_id;
  if (restored) await call("pane.release_agent", { pane_id: restored.pane_id, source: restored.agent_session.source, agent: restored.agent_session.agent });
  const resumedPid = await waitFor("auto-resume", 15_000, () => holders(b)[0]).catch(() => undefined);
  const tResume = Date.now() - tStart;
  note("restored pane before any process", restored ? `${restored.pane_id} reports ${restored.agent_session.value}, agent ${restored.agent}` : "no pane reports the id");
  note("release_agent right after reconnect", resumedPid
    ? `does not stop auto-resume: socket ready +${tReady}ms, Herdr ran ${readFileSync(`/proc/${resumedPid}/cmdline`, "utf8").split("\0").join(" ").trim()} at +${tResume}ms, tab.create env kept: ${environ(resumedPid).RHODIUM_SLOT ? "yes" : "no"}`
    : `no auto-resume within 15s (socket ready +${tReady}ms)`);
  if (resumedPid && releasedPane) {
    await waitFor("auto-resumed agent reports id", 15_000, async () => (await paneSession(releasedPane)) === b);
    await call("pane.release_agent", { pane_id: releasedPane, source: "herdr:claude", agent: "claude" });
    await call("pane.clear_agent_authority", { pane_id: releasedPane });
    await Bun.sleep(6_000);
    note("release on a live agent", `pane.get still reports ${await paneSession(releasedPane)}; restore record still has it: ${savedRecord().includes(b)}`);
  }

  // 4. Restart again; right after reconnecting, close the tab. Herdr must not resume it.
  await waitFor("session.json records the id", 15_000, () => savedRecord().includes(b));
  await stopUnderSubscription(sub);
  await waitFor("agents gone with the server", 5_000, () => holders(b).length === 0);
  tStart = Date.now();
  startServer();
  await ready();
  const tReady2 = Date.now() - tStart;
  sub = subscribe();
  const again = await waitFor("restored pane", 3_000, () => findPane(b)).catch(() => undefined);
  if (again) await call("tab.close", { tab_id: again.tab_id });
  const tClosed = Date.now() - tStart;
  const late = await waitFor("auto-resume", 10_000, () => holders(b)[0]).catch(() => undefined);
  check("closing the tab right after reconnect beats auto-resume", !!again && !late,
    `socket ready +${tReady2}ms, tab closed +${tClosed}ms, holder after 10s: ${late ?? "none"}`);
  await Bun.sleep(6_000);
  check("closed tab leaves no restore record", !savedRecord().includes(b), `session.json mentions ${b}: ${savedRecord().includes(b)}`);
  sub.destroy();
}

// ---- run, always clean up

try {
  await probe();
} catch (e) {
  check("probe ran to the end", false, (e as Error).message);
} finally {
  stopServer();
  try { sh([HERDR, "session", "delete", SESSION, "--json"]); } catch {}
  rmSync(CWD, { recursive: true, force: true });
  rmSync(join(HOME, ".claude/projects", CWD.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
  for (const id of seen) rmSync(join(HOME, ".claude/session-env", id), { recursive: true, force: true });
}
const stillListed = JSON.parse(sh([HERDR, "session", "list", "--json"])).sessions.some((s: any) => s.name === SESSION);
const leftovers = [...seen].flatMap(holders);
check("cleanup", !stillListed && leftovers.length === 0, `session listed: ${stillListed}, leftover processes: ${leftovers.join(",") || "none"}`);

const raw = log.map((l) => JSON.stringify(l)).join("\n") + "\n";
writeFileSync(join(REPO, ".scratch", `probe18-${SUFFIX}.jsonl`), raw);
if (FIXTURE) {
  writeFileSync(FIXTURE, raw.replaceAll(CWD, "/work/probe18").replaceAll(CWD.replace(HOME, "~"), "/work/probe18")
    .replaceAll(`${userInfo().username}@${hostname()}`, "user@host").replaceAll(HOME, "/home/user")
    .replaceAll(SESSION, "rhodium-test-p18").replaceAll(UNIT, "rhodium-test-herdr-p18"));
  synthPath(FIXTURE, "herdr");
}
process.exit(failed ? 1 : 0);
