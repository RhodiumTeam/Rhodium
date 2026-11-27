// Real daemon, named Herdr server and an account-free native agent fixture. CWD is a private test directory.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { terminalSocket } from "./socket";
import { nativeProcess } from "../../../src/tui-process";
import { request, sessionSocket } from "../../../src/herdr";
import { connectHolder } from "../../../src/holder";

const [daemon, holder, program, herdr, session, kind = "codex"] = process.argv.slice(2);
const cwd = process.cwd(), home = process.env.HOME, codexHome = process.env.CODEX_HOME;
if (!daemon || !holder || !program || !herdr || ![daemon, holder, program, herdr].every(isAbsolute) ||
    !["codex", "pi", "claude"].includes(kind) || !session?.startsWith("rhodium-test-") || ![cwd, home, codexHome].every(p => p?.includes("rhodium-test-"))) {
  throw new Error("Expected absolute binaries, named test session, private HOME/CODEX_HOME and working directory");
}
const state = join(cwd, "state"), socketDir = join(cwd, "run"), lockDir = join(cwd, "lock"), work = join(cwd, "work");
mkdirSync(work);
writeFileSync(join(work, "rhodium-test-workspace"), "");
if (kind === "claude" || kind === "pi") {
  const profile = join(home!, kind === "claude" ? ".claude" : ".pi/agent");
  mkdirSync(profile, { recursive: true });
  const install = Bun.spawnSync([herdr, "integration", "install", kind], {
    env: { ...process.env, [kind === "claude" ? "CLAUDE_CONFIG_DIR" : "PI_CODING_AGENT_DIR"]: profile }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  if (install.exitCode !== 0) throw new Error("Herdr could not install the isolated " + kind + " integration");
}
if (kind === "claude") {
  mkdirSync(join(work, ".claude"));
  writeFileSync(join(work, ".claude", "settings.local.json"), JSON.stringify({ editorMode: "vim" }));
}
const reserve = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = reserve.port!;
reserve.stop(true);
const cfg = join(cwd, "config.toml"), q = JSON.stringify, missing = q(join(cwd, "missing"));
writeFileSync(cfg, `stateDir = ${q(state)}
socketDir = ${q(socketDir)}
lockDir = ${q(lockDir)}
holdBin = ${q(holder)}
unitPrefix = "rhodium-test-tui-"
[programs]
codex = ${kind === "codex" ? q(program) : missing}
herdr = ${q(herdr)}
pi = ${kind === "pi" ? q(program) : missing}
claude = ${kind === "claude" ? q(program) : missing}
[herdr]
session = ${q(session)}
[board]
bind = "127.0.0.1"
auth = "none"
port = ${port}
`, { mode: 0o600 });
const origin = "http://127.0.0.1:" + port;
const launch = (argv: string[]) => Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "ignore", stderr: Bun.file(join(cwd, "daemon.log")) });
let proc = launch([daemon, "--config", cfg]);
const headers = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
async function act(value: object) {
  const response = await fetch(origin + "/api/act", { method: "POST", headers, body: JSON.stringify({ id: crypto.randomUUID(), act: value }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("board action HTTP " + response.status);
  const result = await response.json();
  if (!result.ok) throw new Error("board action rejected: " + result.error);
  return result;
}
const rh = (...argv: string[]) => act({ kind: "rh", argv, sure: true });
async function until<T>(what: string, f: () => Promise<T> | T, timeout = 22000): Promise<NonNullable<T>> {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    if (proc.exitCode !== null) throw new Error("daemon exited " + proc.exitCode + " while waiting for " + what);
    const value = await f();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}
let slot: string | undefined, db: Database | undefined;
const ref = "test/" + kind;
const transcriptRoot = kind === "codex" ? join(codexHome!, "sessions") : kind === "pi" ? join(home!, ".pi", "agent", "sessions") : join(process.env.CLAUDE_CONFIG_DIR || join(home!, ".claude"), "projects");
const sockets: WebSocket[] = [];
try {
  await until("board", () => fetch(origin + "/api/board", { headers }).then(r => r.ok, () => false));
  await rh("ws", "test", work);
  slot = (await rh("new", ref, "--agent", kind)).slot as string;
  assert(slot);
  db = new Database(join(state, "rh.db"), { readonly: true });
  type Row = { mode: string; state: string; tuiPid: number | null; tuiStart: number | null; sessionId: string | null; id: string; herdrPane: string; tuiInput: string };
  const status = db.query<Row, [string]>("SELECT s.mode,s.state,s.tuiPid,s.tuiStart,s.herdrPane,s.tuiInput,c.sessionId,c.id FROM slot s JOIN conversation c ON c.id=s.conversation WHERE s.id=?");
  const row = () => status.get(slot!)!;
  const replies = () => {
    const dir = transcriptRoot;
    const file = row().sessionId && existsSync(dir) && readdirSync(dir, { recursive: true, encoding: "utf8" }).find(f => f.endsWith(row().sessionId + ".jsonl"));
    return file ? readFileSync(join(dir, file), "utf8").split("\n").filter(l => l.includes("fake reply")).length : 0;
  };
  const say = async (text: string) => {
    const before = replies();
    await act({ kind: "say", slot, text });
    await until("headless reply to " + text, () => row().mode === "headless" && row().state === "idle" && replies() > before);
  };
  await say("first");
  const thread = row().sessionId;
  assert(thread);
  const at = await sessionSocket(herdr, session);
  for (const exit of ["natural", "release"]) {
    const observation = join(work, "pane-observation.json");
    rmSync(observation, { force: true });
    await rh("tui", ref);
    await until("TUI slot and pane fixture", () => row().mode === "tui" && row().tuiPid && existsSync(observation));
    const seen = JSON.parse(readFileSync(observation, "utf8"));
    assert.equal(seen.thread, thread);
    if (kind === "codex") assert.equal(seen.dedicated, true);
    assert.equal(seen.sentinel, kind === "claude");
    if (kind !== "codex") {
      const pane = await until("Herdr " + kind + " integration session report", async () => {
        const { pane } = await request(at, "pane.get", { pane_id: row().herdrPane });
        return pane.agent_session?.agent === kind && pane;
      });
      if (kind === "claude") assert.equal(pane.agent_session.value, thread);
      else {
        assert(isAbsolute(pane.agent_session.value));
        assert(pane.agent_session.value.endsWith("_" + thread + ".jsonl"));
        assert(existsSync(pane.agent_session.value));
      }
    }
    assert.equal(row().tuiPid, seen.pid);
    const identity = nativeProcess(seen.pid);
    assert(identity);
    assert.equal(identity.start, row().tuiStart);
    assert.equal(basename(identity.exe).toLowerCase(), basename(program).toLowerCase());
    const testLock: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync([holder, "probe", join(lockDir, row().id)]);
    assert.equal(testLock.exitCode, 0);
    assert.equal(testLock.stdout.toString().trim(), "live");
    const first = terminalSocket(origin, slot);
    sockets.push(first.ws);
    await first.wait("PANE_READY");
    const second = terminalSocket(origin, slot);
    sockets.push(second.ws);
    assert.equal(await Promise.race([first.closed, Bun.sleep(5000).then(() => 0)]), 4001);
    await second.wait("PANE_READY");
    if (kind === "claude") {
      await until("vim NORMAL classified as draft", () => row().tuiInput === "draft");
      second.ws.send(JSON.stringify({ t: "in", d: "insert\r" }));
      await until("vim INSERT classified as ready", () => row().tuiInput === "ready");
    }
    second.ws.send(JSON.stringify({ t: "in", d: "probe\r" }));
    await second.wait("PANE_ACCEPTED");
    if (exit === "natural") second.ws.send(JSON.stringify({ t: "in", d: "leave\r" }));
    else await rh("release", ref);
    await until("return to headless after " + exit, () => row().mode === "headless");
    const remaining = nativeProcess(seen.pid);
    assert(!remaining || remaining.start !== identity.start || remaining.state === "Z");
    assert.equal(row().sessionId, thread);
    await say("after-" + exit);
    assert.equal(row().sessionId, thread);
    console.log("PASS", kind, "headless -> TUI ->", exit, "-> same headless session; main PID, lock and board WS verified");
  }
  if (kind === "claude") console.log("PASS installed Claude SessionStart hook ID, vim NORMAL/INSERT and retained synthetic Anthropic key");
  if (kind === "pi") console.log("PASS installed pi session_start extension path and removed synthetic Anthropic key");
  // Seed a second, unmanaged transcript and let the external pane report it to Herdr.
  const other = crypto.randomUUID();
  const source = readdirSync(transcriptRoot, { recursive: true, encoding: "utf8" }).find(f => f.endsWith(thread + ".jsonl"));
  assert(source);
  writeFileSync(join(transcriptRoot, source.replace(thread, other)), readFileSync(join(transcriptRoot, source), "utf8").replaceAll(thread, other));
  const { workspace, root_pane } = await request(at, "workspace.create", { cwd: work, label: "external-test", focus: false });
  const args = kind === "codex" ? ["resume", other, "--no-daemon"] : [kind === "pi" ? "--session-id" : "--resume", other];
  const obs = join(work, "pane-observation.json");
  rmSync(obs, { force: true });
  const { layout } = await request(at, "layout.apply", { workspace_id: workspace.workspace_id, tab_label: "external", root: { type: "pane", cwd: work, env: kind === "pi" ? { ANTHROPIC_API_KEY: "" } : {}, command: [program, ...args] } });
  const external = layout.root.pane_id;
  try {
    await until("external pane agent", () => existsSync(obs) && JSON.parse(readFileSync(obs, "utf8")).thread === other);
    if (kind === "codex") {
      // Our Codex fixture does not run a hook; give the pane a positive Codex report as a real hook would.
      await request(at, "pane.report_agent_session", { pane_id: external, agent: kind, source: "herdr:codex", agent_session_id: other, seq: Date.now() * 1000 });
      await until("external Codex report", async () => (await request(at, "pane.get", { pane_id: external })).pane.agent_session?.agent === kind);
      await assert.rejects(rh("import", external), /Codex 只能从磁盘导入/);
      console.log("PASS live Codex pane import stays disabled");
    } else {
      const pick = async () => (await (await fetch(origin + "/api/importable?" + new URLSearchParams({ agent: kind, dir: work }), { headers })).json()).list;
      await until("external pane first on board", async () => (await pick())?.[0]?.pane === external);
      assert.equal((await pick())[0].session, other);
      // The board returns a selection panel. The local rh CLI returns the textual list.
      const list = Bun.spawnSync([daemon, "rh", "import", "--dir", work], {
        env: { ...process.env, RHODIUM_SOCKET: join(socketDir, "rh.sock") }, stdout: "pipe", stderr: "pipe", timeout: 15000,
      });
      assert.equal(list.exitCode, 0, "rh import listing failed");
      assert(list.stdout.toString().includes(external), "external pane absent from the local CLI listing");
      console.log("PASS external", kind, "discovered by board and local rh");
      const seen = JSON.parse(readFileSync(obs, "utf8"));
      const start = nativeProcess(seen.pid)!.start;
      const held = () => db!.query("SELECT id FROM slot WHERE herdrPane=?").get(external);
      if (kind === "pi") {
        for (const result of ["unknown", "true", "false"]) {
          proc.kill(); await proc.exited;
          proc = launch([process.execPath, join(dirname(Bun.main), "pi-import-daemon.mjs"), cfg, result]);
          await until("fixture board", () => fetch(origin + "/api/board", { headers }).then(r => r.ok, () => false));
          if (result === "false") break;
          await assert.rejects(rh("import", external), result === "unknown" ? /读不到 pane/ : /带着 Anthropic 的凭据/);
          assert(!held());
          assert.equal(nativeProcess(seen.pid)?.start, start);
          assert.equal((await request(at, "pane.get", { pane_id: external })).pane.pane_id, external);
        }
      }
      // A different process naming this conversation still blocks adoption even with a clean check.
      const conflict = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", other], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        await assert.rejects(rh("import", external), /另一个进程正在用这段对话/);
        assert(!held());
      } finally { conflict.kill(); await conflict.exited; }
      await rh("import", external, "--name", "external");
      slot = (held() as { id: string }).id;
      assert.equal(row().mode, "tui");
      assert.equal(row().tuiPid, seen.pid);
      assert.equal(row().tuiStart, start);
      assert.equal(row().sessionId, other);
      assert(!(await pick()).some((r: { pane?: string; session: string }) => r.pane === external || r.session === other));
      assert.equal(Bun.spawnSync([holder, "probe", join(lockDir, row().id)]).stdout.toString().trim(), "live");
      await assert.rejects(rh("import", external), /已经是/);
      const term = terminalSocket(origin, slot);
      sockets.push(term.ws);
      await term.wait("PANE_READY");
      term.ws.send(JSON.stringify({ t: "in", d: "leave\r" }));
      await until("imported pane returns to headless", () => row().mode === "headless");
      assert.equal((await request(at, "pane.get", { pane_id: root_pane.pane_id })).pane.pane_id, root_pane.pane_id);
      await say("after external pane");
      assert.equal(row().sessionId, other);
      console.log("PASS", kind, "external pane, PID/start, lock, duplicate check, exit and headless continuation", kind === "pi" ? "(three stubbed credential decisions)" : "");
    }
  } finally {
    await request(at, "workspace.close", { workspace_id: workspace.workspace_id }).catch(() => {});
  }
} catch (err) {
  if (slot && db) {
    const summary = db.query("SELECT s.mode,s.state,s.tuiPid IS NOT NULL AS hasTuiPid,c.sessionId IS NOT NULL AS hasThread FROM slot s JOIN conversation c ON c.id=s.conversation WHERE s.id=?").get(slot);
    const holds = join(state, "hold");
    const failures: string[] = [];
    for (const name of existsSync(holds) ? readdirSync(holds) : []) {
      const file = join(holds, name, "err.log");
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf8");
        failures.push(...["TypeError", "RangeError", "SyntaxError", "ENOENT", "EACCES", "refusing to write a transcript", "cannot start"].filter(reason => lines.includes(reason)));
      }
    }
    console.error("Fixture diagnosis", { summary, headlessEntered: existsSync(join(work, "headless-entered")), paneEntered: existsSync(join(work, "pane-observation.json")), naturalExitRequested: existsSync(join(work, "natural-exit-requested")), rolloutCreated: existsSync(transcriptRoot), errors: failures });
  }
  throw err;
} finally {
  for (const ws of sockets) ws.close();
  if (slot) await rh("stop", ref).catch(() => {});
  proc.kill();
  await proc.exited;
  db?.close();
  const holds = join(state, "hold");
  for (const id of existsSync(holds) ? readdirSync(holds) : []) {
    const link = await connectHolder(join(socketDir, "hold", id + ".sock"), { boot: 100, offset: 0 }, { out() {}, exit() {} }).catch(() => null);
    if (link) { await link.signal("KILL").catch(() => {}); link.close(); }
  }
}
