// Process-level self-tests for the fake Herdr: start its server, talk to its socket like the
// Herdr bridge would, and compare with the probe 18 recording (docs/architecture.md §10.3).
import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { basename, join } from "node:path";
import { claudeProjectDir, installFakeAgent, realHome } from "./fake-agent/fake-agent.ts";
import { call, installFakeHerdr, startFakeHerdr, subscribe, type FakeHerdrConfig } from "./fake-herdr/fake-herdr.ts";
import { exec } from "./instance";

// Short prefix: the socket path must stay under the 108-byte unix socket limit.
const base = mkdtempSync(join(tmpdir(), "rhodium-test-fh-"));
const servers: { stop(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  rmSync(base, { recursive: true, force: true });
});

let count = 0;
/** One fake Herdr per test: its own HOME, session name, and a fake `claude` on the server's PATH. */
async function setup(config: FakeHerdrConfig = {}) {
  const dir = join(base, String(count++));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work);
  const bin = installFakeHerdr(dir, config);
  const agent = installFakeAgent(dir, {});
  const session = `rhodium-test-${randomBytes(4).toString("hex")}`;
  const env = { HOME: home, PATH: `${dir}:/usr/bin:/bin` };
  const start = async () => {
    const s = await startFakeHerdr(bin, session, env);
    servers.push(s);
    return s;
  };
  const server = await start();
  return { dir, home, work, bin, agent, session, env, server, start, socket: server.socket };
}

/** Polls `f` until it returns something truthy. */
async function until<T>(f: () => Promise<T> | T, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const environ = (pid: number) =>
  Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );
const alive = (pid: number) => existsSync(`/proc/${pid}`);

/** A workspace plus a slot tab whose shell is typed the launch line, as the bridge did before #372: the
 *  fake's shell panes, which the tests below and Herdr's own resume use. */
async function launch(t: Awaited<ReturnType<typeof setup>>) {
  const session = randomUUID();
  // A conversation Claude wrote down, as only those resume.
  const projects = join(t.home, ".claude/projects", claudeProjectDir(t.work));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${session}.jsonl`), "");
  const ws = (await call(t.socket, "workspace.create", { cwd: t.work, label: "rh" })).result;
  const tab = (
    await call(t.socket, "tab.create", {
      workspace_id: ws.workspace.workspace_id,
      cwd: t.work,
      label: "slot",
      env: { RHODIUM_SLOT: "slot-1", RHODIUM_TOKEN: "token-1" },
    })
  ).result;
  const pane: string = tab.root_pane.pane_id;
  const typed = ` exec env PATH=${t.dir}:/bin ${t.agent.path} --resume ${session}`;
  const sent = await call(t.socket, "pane.send_input", { pane_id: pane, text: typed, keys: ["enter"] });
  expect(sent.result).toEqual({ type: "ok" });
  const get = async () => (await call(t.socket, "pane.get", { pane_id: pane })).result?.pane;
  await until(async () => (await get())?.agent_session);
  const info = (await call(t.socket, "pane.process_info", { pane_id: pane })).result.process_info;
  const pid: number = info.foreground_processes.find((p: any) => p.name === "claude").pid;
  return { ws, tab, pane, pid, info, get, session };
}

test("serves one socket per session under HOME and answers ping like Herdr 0.9.1", async () => {
  const { home, session, socket } = await setup();
  expect(socket).toBe(join(home, ".config/herdr/sessions", session, "herdr.sock"));
  const pong = await call(socket, "ping");
  expect(pong.result.type).toBe("pong");
  expect([pong.result.version, pong.result.protocol]).toEqual(["0.9.1", 22]);
});

test("`herdr session list --json` gives the bridge the socket path, like the real CLI", async () => {
  const { bin, env, session, socket, server } = await setup();
  const list = async () => JSON.parse((await exec([bin, "session", "list", "--json"], { env })).out);
  expect((await list()).sessions).toEqual([
    { default: false, name: session, running: true, session_dir: join(socket, ".."), socket_path: socket },
  ]);
  await server.stop();
  expect((await list()).sessions[0].running).toBe(false);
});

test("every command refuses to run against the user's own ~/.config/herdr", async () => {
  const { bin } = await setup();
  const session = `rhodium-test-${randomBytes(4).toString("hex")}`;
  const root = join(realHome()!, ".config/herdr");
  const dir = join(root, "sessions", session);
  // Should a check regress, none of these reach the user's live Herdr: an unused session name, or only a ping.
  const cases: [string[], Record<string, string>][] = [
    [["--session", session, "tab", "create", "--workspace", "w1"], { HOME: realHome()! }],
    [["--session", session, "server"], { HOME: realHome()! }],
    [["session", "list", "--json"], {}], // no HOME: Herdr falls back to the real one
    [["session", "list", "--json"], { HOME: realHome()! }],
  ];
  try {
    for (const [argv, env] of cases) {
      const run = await exec([bin, ...argv], { env, timeoutMs: 3000 });
      expect([argv, run.code, run.out, run.err]).toEqual([
        argv,
        2,
        "",
        `fake herdr: refusing to run under ${root}; set HOME\n`,
      ]);
    }
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed request gets an invalid_params error and the server keeps running", async () => {
  const t = await setup();
  const { pane } = await launch(t);
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const bad: [string, object][] = [
    ["pane.send_keys", { pane_id: pane }],
    ["pane.send_input", { pane_id: pane, keys: ["enter"] }],
    ["events.subscribe", {}],
  ];
  for (const [method, params] of bad)
    expect([method, (await call(t.socket, method, params)).error?.code]).toEqual([method, "invalid_params"]);
  // A line that is not JSON at all.
  const raw = await new Promise<string>((ok, ko) => {
    const s = connect(t.socket, () => s.write("{not json\n"));
    s.on("data", (d) => (s.end(), ok(d.toString())));
    s.on("error", ko);
  });
  expect(JSON.parse(raw).error.code).toBe("invalid_params");
  expect((await call(t.socket, "ping")).result.type).toBe("pong");
  expect((await call(t.socket, "pane.get", { pane_id: pane })).result.pane.pane_id).toBe(pane);
  await Bun.sleep(100);
  expect(sub.events).toEqual([]);
});

test("a pane runs what is typed into it: the launch line starts the fake agent with tab.create's env", async () => {
  const t = await setup();
  const { ws, tab, pane, pid, info, get, session } = await launch(t);
  expect([ws.workspace.workspace_id, ws.tab.tab_id, ws.root_pane.pane_id]).toEqual(["w1", "w1:t1", "w1:p1"]);
  expect([tab.tab.tab_id, pane]).toEqual(["w1:t2", "w1:p2"]);
  // pane.get reports the session id the agent was started with, as Claude's SessionStart hook does.
  expect((await get()).agent_session).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: session });
  // `exec`: the agent is the pane's process.
  expect(pid).toBe(info.shell_pid);
  expect(info.foreground_processes[0].cwd).toBe(t.work);
  const env = environ(pid);
  expect([env.RHODIUM_SLOT, env.RHODIUM_TOKEN, env.PATH]).toEqual(["slot-1", "token-1", `${t.dir}:/bin`]);
  expect([env.HERDR_ENV, env.HERDR_PANE_ID, env.HERDR_SOCKET_PATH]).toEqual(["1", pane, t.socket]);
  expect(env.HOME).toBe(t.home); // the server's own env underneath
  // Detected on exec, so the agent may not have logged its run yet.
  expect((await until(() => t.agent.runs().find((r) => r.pid === pid))).argv).toEqual(["--resume", session]);
});

test("trigger: /clear or /resume changes the reported session id, with no event", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const { pane, pid, get } = await launch(t);
  const from = sub.events.length;
  // What Claude's SessionStart hook sends when /clear or /resume switches conversations.
  const next = randomUUID();
  const report = { pane_id: pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: next };
  expect((await call(t.socket, "pane.report_agent_session", report)).result).toEqual({ type: "ok" });
  expect((await get()).agent_session).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: next });
  const snap = (await call(t.socket, "session.snapshot")).result.snapshot;
  expect(snap.panes.find((p: any) => p.pane_id === pane).agent_session.value).toBe(next);
  // Same process: /clear and /resume do not restart the agent.
  await Bun.sleep(100);
  expect((await call(t.socket, "pane.process_info", { pane_id: pane })).result.process_info.shell_pid).toBe(pid);
  expect((await get()).agent_session.value).toBe(next);
  expect(sub.events.slice(from)).toEqual([]);
});

/** Stops the server under an open subscription and checks what Herdr does: EOF, no event, agent gone. */
async function stopServer(t: Awaited<ReturnType<typeof setup>>, pid: number) {
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  await t.server.stop();
  await sub.closed;
  expect(sub.events).toEqual([]);
  await until(() => !alive(pid));
  expect(await call(t.socket, "ping").catch(() => "down")).toBe("down");
}

test("trigger: Herdr restarts; the socket drops, comes back, and Herdr resumes the agent by itself", async () => {
  const t = await setup({ resumeDelay: 300 });
  const { ws, tab, pane, pid, session } = await launch(t);
  await stopServer(t, pid);
  await Bun.sleep(200);
  const back = await t.start();
  // Before any agent runs, the restored pane, same ids, already reports the old session id.
  const snap = (await call(back.socket, "session.snapshot")).result.snapshot;
  const restored = snap.panes.find((p: any) => p.agent_session?.value === session);
  expect([restored.pane_id, restored.tab_id, restored.workspace_id]).toEqual([pane, tab.tab.tab_id, ws.workspace.workspace_id]);
  const procs = async () => (await call(back.socket, "pane.process_info", { pane_id: pane })).result.process_info.foreground_processes;
  expect((await procs()).map((p: any) => p.name)).not.toContain("claude");
  // Then Herdr types `claude --resume <id>` into the shell: new pid, without tab.create's env.
  const claude = await until(async () => (await procs()).find((p: any) => p.name === "claude"));
  expect(claude.pid).not.toBe(pid);
  expect((await until(() => t.agent.runs().find((r) => r.pid === claude.pid))).argv).toEqual(["--resume", session]);
  expect(environ(claude.pid).RHODIUM_TOKEN).toBeUndefined();
  expect((await call(back.socket, "pane.get", { pane_id: pane })).result.pane.agent_session.value).toBe(session);
});

test("closing the restored tab right after reconnecting beats the auto-resume", async () => {
  const t = await setup({ resumeDelay: 300 });
  const { tab, pid } = await launch(t);
  await stopServer(t, pid);
  const back = await t.start();
  expect((await call(back.socket, "tab.close", { tab_id: tab.tab.tab_id })).result.type).toBe("ok");
  const runs = t.agent.runs().length;
  await Bun.sleep(600);
  expect(t.agent.runs().length).toBe(runs);
});

test("with resumeAgents off, a restart brings the panes back as plain shells", async () => {
  const t = await setup({ resumeAgents: false, resumeDelay: 100 });
  const { pane, pid } = await launch(t);
  await stopServer(t, pid);
  const back = await t.start();
  const p = (await call(back.socket, "pane.get", { pane_id: pane })).result.pane;
  expect([p.agent, p.agent_session]).toEqual([undefined, undefined]);
  const runs = t.agent.runs().length;
  await Bun.sleep(300);
  expect(t.agent.runs().length).toBe(runs);
});

const recorded: { dir: string; msg: any }[] = readFileSync(join(import.meta.dir, "fixtures/herdr/probe-18.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const recAnswer = (id: string) => recorded.find((l) => l.dir === "<<" && l.msg.id === id)!.msg;
const recEvent = (event: string, pick: (data: any) => boolean = () => true) =>
  recorded.find((l) => l.dir === "ev" && l.msg.event === event && pick(l.msg.data))!.msg;

/** Keys and value types, recursively; an array by its first item. Terminal titles are cosmetic and left out. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("terminal_title")).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

test("every command and event probe 18 recorded comes back in the recorded shape", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  const ask = (method: string, params: object = {}) => call(t.socket, method, params);
  const pairs: [string, unknown, unknown][] = [];
  const same = (what: string, rec: unknown, fake: unknown) => pairs.push([what, shape(rec), shape(fake)]);

  same("subscription_started", recorded.find((l) => l.dir === "ev" && l.msg.id === "p18:sub")!.msg, await sub.started);
  same("ping", recAnswer("p18:1"), await ask("ping"));
  const { ws, tab, pane } = await launch(t);
  const root = ws.root_pane.pane_id;
  same("workspace.create", recAnswer("p18:2").result, ws);
  same("tab.create", recAnswer("p18:110").result, tab);
  for (const name of ["workspace_created", "tab_created", "pane_created"])
    same(name, recEvent(name), sub.events.find((e) => e.event === name));
  same("pane_agent_detected", recEvent("pane_agent_detected", (d) => !d.released), sub.events.find((e) => e.event === "pane_agent_detected"));
  same("pane_updated", recEvent("pane_updated", (d) => d.pane.agent_session), sub.events.find((e) => e.event === "pane_updated"));
  same("pane.get, shell", recAnswer("p18:4"), await ask("pane.get", { pane_id: root }));
  same("pane.get, agent", recAnswer("p18:29"), await ask("pane.get", { pane_id: pane }));
  same("pane.process_info", recAnswer("p18:84"), await ask("pane.process_info", { pane_id: pane }));
  same("session.snapshot", recAnswer("p18:218"), await ask("session.snapshot"));
  same("pane.send_text", recAnswer("p18:85"), await ask("pane.send_text", { pane_id: pane, text: "/clear" }));
  const release = { pane_id: pane, source: "herdr:claude", agent: "claude" };
  same("pane.release_agent", recAnswer("p18:219"), await ask("pane.release_agent", release));
  same("pane.clear_agent_authority", recAnswer("p18:222"), await ask("pane.clear_agent_authority", { pane_id: pane }));
  same("pane.send_keys", recAnswer("p18:105"), await ask("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] }));
  await ask("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(() => sub.events.some((e) => e.event === "pane_exited"));
  await Bun.sleep(100);
  same("pane_exited", recEvent("pane_exited"), sub.events.find((e) => e.event === "pane_exited"));
  same("pane_agent_detected, released", recEvent("pane_agent_detected", (d) => d.released), sub.events.find((e) => e.data.released));
  same("pane_not_found", recAnswer("p18:108"), await ask("pane.get", { pane_id: pane }));
  const cli = recorded.find((l) => l.dir === "cli")!.msg;
  const argv = ["--session", t.session, ...cli.argv.slice(1)].map((a: string) => (a === "w2" ? ws.workspace.workspace_id : a));
  const out = JSON.parse((await exec([t.bin, ...argv], { env: t.env })).out);
  same("cli tab create", cli.out, out);
  expect(out.id).toBe("cli:tab:create");
  same("tab.close", recAnswer("p18:227"), await ask("tab.close", { tab_id: ws.tab.tab_id }));
  await until(() => sub.events.some((e) => e.event === "tab_closed"));
  same("tab_closed", recEvent("tab_closed"), sub.events.find((e) => e.event === "tab_closed"));
  await ask("tab.close", { tab_id: out.result.tab.tab_id });
  same("session.snapshot, empty", recAnswer("p18:107"), await ask("session.snapshot"));

  for (const [what, rec, fake] of pairs) expect([what, fake]).toEqual([what, rec]);
});

const renaming: { dir: string; msg: any }[] = readFileSync(join(import.meta.dir, "fixtures/herdr/tab-rename.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test("tab.rename, as Herdr 0.9.1 did it (scripts/probes/herdr/probe-tab-rename.ts): the tab named takes the label, the others keep theirs, one not there is tab_not_found; the fake answers each request alike", async () => {
  const requests = renaming.filter((l) => l.dir === ">>").map((l) => l.msg);
  const answer = (id: string) => renaming.find((l) => l.dir === "<<" && l.msg.id === id)!.msg;
  // What a test can compare: the shape of each answer; the tabs' labels in a snapshot; an error's code.
  const seen = (method: string, a: any) =>
    a.error ? a.error.code : [shape(a.result), method === "session.snapshot" ? a.result.snapshot.tabs.map((t: any) => `${t.tab_id} ${t.label}`) : null];
  const real = requests.map((r) => [r.method, seen(r.method, answer(r.id))]);
  expect(real.filter(([m]) => m === "session.snapshot" || m === "tab.rename").map(([, s]) => (typeof s === "string" ? s : s[1]))).toEqual([
    ["w1:t1 1", "w1:t2 a", "w2:t1 1"],
    null,
    ["w1:t1 1", "w1:t2 c", "w2:t1 1"],
    "tab_not_found",
  ]);

  const t = await setup();
  const fake = [];
  for (const r of requests) {
    const params = JSON.parse(JSON.stringify(r.params).replaceAll('"/work"', JSON.stringify(t.work)));
    fake.push([r.method, seen(r.method, await call(t.socket, r.method, params))]);
  }
  expect(fake).toEqual(real);
});

const laying: { dir: string; msg: any }[] = readFileSync(join(import.meta.dir, "fixtures/herdr/layout-apply.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test("layout.apply, as Herdr 0.9.1 did it (scripts/probes/herdr/probe-layout-apply.ts): the tab's pane runs the command, no shell, with env; Ctrl+C ends it, and the tab goes; the fake answers and tells each alike", async () => {
  const requests = laying.filter((l) => l.dir === ">>").map((l) => l.msg);
  const answer = (id: string) => laying.find((l) => l.dir === "<<" && l.msg.id === id)!.msg;
  const ev = (rows: { msg: any }[]) => rows.map((e) => [e.msg.event, shape(e.msg.data)]);
  // What a test can compare: each answer's shape, or its error's code; and what the pane runs.
  const seen = (a: any) => (a.error ? a.error.code : shape(a.result));
  const ran = ({ exe, cmdline, env }: any) => [exe, cmdline, env.RHODIUM_SLOT, env.RHODIUM_TOKEN, env.PATH, env.HERDR_ENV, typeof env.HERDR_PANE_ID];
  const real = requests.map((r) => [r.method, seen(answer(r.id))]);
  const asked = requests.find((r) => r.method === "layout.apply")!;
  const { layout } = answer(asked.id).result;
  // The answer echoes the command, not env; the tab takes tab_label.
  expect(layout.root.command).toEqual(asked.params.root.command);
  expect(JSON.stringify(layout)).not.toContain("token-1");
  expect(answer("la:5").result.snapshot.tabs.map((t: any) => t.label)).toEqual(["slot"]);
  const proc = laying.find((l) => l.dir === "proc")!.msg;
  expect(ran(proc)).toEqual(["sleep", ["sleep", "30"], "slot-1", "token-1", "/usr/bin:/bin", "1", "string"]);
  expect(proc.env.PROBE_UNSET).toBeNull(); // env -u takes it out of the server's

  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const fake = [];
  let pane = "";
  for (const r of requests) {
    const params = JSON.parse(JSON.stringify(r.params).replaceAll('"/work"', JSON.stringify(t.work)));
    const a = await call(t.socket, r.method, params);
    fake.push([r.method, seen(a)]);
    if (r.method === "layout.apply" && a.result) pane = a.result.layout.root.pane_id;
    if (r.method === "pane.process_info") {
      const pid = a.result.process_info.shell_pid;
      expect(ran({ exe: basename(readlinkSync(`/proc/${pid}/exe`)), cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1), env: environ(pid) })).toEqual(ran(proc));
    }
    if (r.method === "pane.send_keys") await until(() => sub.events.some((e) => e.event === "pane_exited" && e.data.pane_id === pane));
  }
  expect(fake).toEqual(real);
  await Bun.sleep(100);
  expect(ev(sub.events.map((msg) => ({ msg })))).toEqual(ev(laying.filter((l) => l.dir === "ev")));
});

test("a layout.apply pane runs the fake agent itself: Herdr detects it and reads its session, and the two Ctrl+C of rh release end it, the pane and its tab with it", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const session = randomUUID();
  const ws = (await call(t.socket, "workspace.create", { cwd: t.work, label: "rh" })).result;
  const root = { type: "pane", cwd: t.work, env: { RHODIUM_SLOT: "slot-1" }, command: ["/usr/bin/env", `PATH=${t.dir}:/bin`, t.agent.path, "--session-id", session] };
  const { layout } = (await call(t.socket, "layout.apply", { workspace_id: ws.workspace.workspace_id, tab_label: "slot", root })).result;
  const pane: string = layout.root.pane_id;
  const get = async () => (await call(t.socket, "pane.get", { pane_id: pane })).result?.pane;
  expect((await until(async () => (await get())?.agent_session)).value).toBe(session);
  const info = (await call(t.socket, "pane.process_info", { pane_id: pane })).result.process_info;
  expect(info.foreground_processes[0]).toMatchObject({ pid: info.shell_pid, name: "claude" });
  expect(environ(info.shell_pid).RHODIUM_SLOT).toBe("slot-1");
  for (let i = 0; i < 2; i++) await call(t.socket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(() => sub.events.some((e) => e.event === "pane_exited" && e.data.pane_id === pane));
  const snap = (await call(t.socket, "session.snapshot")).result.snapshot;
  expect(snap.tabs.map((x: any) => x.tab_id)).toEqual([ws.tab.tab_id]);
});

const ALL = ["workspace.created", "workspace.closed", "tab.created", "tab.closed", "pane.created", "pane.closed",
  "pane.updated", "pane.exited", "pane.agent_detected"];

test("trigger: the pane's process exits; pane_exited, and the pane goes, then its tab and workspace", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  expect(await sub.started).toEqual({ id: "rh:events.subscribe", result: { type: "subscription_started" } });
  const { ws, pane, pid } = await launch(t);
  const w = ws.workspace.workspace_id;
  const from = sub.events.length;
  process.kill(pid, "SIGKILL");
  await until(() => sub.events.length >= from + 2);
  await Bun.sleep(100);
  expect(sub.events.slice(from)).toEqual([
    { event: "pane_exited", data: { type: "pane_exited", pane_id: pane, workspace_id: w } },
    {
      event: "pane_agent_detected",
      data: { type: "pane_agent_detected", agent: "claude", final_status: "idle", pane_id: pane, released: true, workspace_id: w },
    },
  ]);
  expect((await call(t.socket, "pane.get", { pane_id: pane })).error).toEqual({
    code: "pane_not_found",
    message: `pane ${pane} not found`,
  });
  // The root tab's shell is the workspace's last pane: when it exits, the workspace goes too, with no other event.
  const root = ws.root_pane.pane_id;
  await call(t.socket, "pane.send_input", { pane_id: root, text: "exit", keys: ["enter"] });
  await until(() => sub.events.length > from + 2);
  await Bun.sleep(100);
  expect(sub.events.slice(from + 2)).toEqual([
    { event: "pane_exited", data: { type: "pane_exited", pane_id: root, workspace_id: w } },
  ]);
  const snap = (await call(t.socket, "session.snapshot")).result.snapshot;
  expect([snap.workspaces, snap.tabs, snap.panes]).toEqual([[], [], []]);
});

test("two Ctrl-C quit Claude: a pane_updated with the current session id comes before pane_exited", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const { pane, pid } = await launch(t);
  const now = randomUUID();
  await call(t.socket, "pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: now });
  const from = sub.events.length;
  expect((await call(t.socket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] })).result).toEqual({ type: "ok" });
  await Bun.sleep(300);
  expect(alive(pid)).toBe(true);
  await call(t.socket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(() => sub.events.some((e) => e.event === "pane_exited"));
  await Bun.sleep(100);
  expect(alive(pid)).toBe(false);
  const got = sub.events.slice(from);
  expect(got.map((e) => e.event)).toEqual(["pane_updated", "pane_exited", "pane_agent_detected"]);
  expect(got[0].data.pane.agent_session.value).toBe(now);
});

test("Ctrl-C reaches an agent the shell exec'd while it runs a child, say rh, as a terminal's whole foreground job gets it", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const pane = (await call(t.socket, "workspace.create", { cwd: t.work, label: "rh" })).result.root_pane.pane_id;
  const agent = `exec ${process.execPath} -e "Bun.spawn(['sleep', '30']); setInterval(() => {}, 1000)"`;
  await call(t.socket, "pane.send_input", { pane_id: pane, text: agent, keys: ["enter"] });
  const fg = async () => (await call(t.socket, "pane.process_info", { pane_id: pane })).result.process_info.foreground_processes;
  await until(async () => (await fg()).some((p: any) => p.name === "sleep"));
  const pids: number[] = (await fg()).map((p: any) => p.pid);
  await call(t.socket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(() => sub.events.some((e) => e.event === "pane_exited"));
  expect(pids.filter(alive)).toEqual([]);
});

test("tab.close ends the pane's process with only tab_closed, and keeps the rest of the workspace", async () => {
  const t = await setup();
  const sub = subscribe(t.socket, ALL);
  await sub.started;
  const { ws, tab, pane, pid } = await launch(t);
  const from = sub.events.length;
  expect((await call(t.socket, "tab.close", { tab_id: tab.tab.tab_id })).result).toEqual({ type: "ok" });
  await until(() => !alive(pid));
  await Bun.sleep(100);
  expect(sub.events.slice(from)).toEqual([
    { event: "tab_closed", data: { type: "tab_closed", tab_id: tab.tab.tab_id, workspace_id: ws.workspace.workspace_id } },
  ]);
  expect((await call(t.socket, "pane.get", { pane_id: pane })).error.code).toBe("pane_not_found");
  const snap = (await call(t.socket, "session.snapshot")).result.snapshot;
  expect(snap.tabs.map((x: any) => x.tab_id)).toEqual([ws.tab.tab_id]);
  expect((await call(t.socket, "tab.close", { tab_id: tab.tab.tab_id })).error.code).toBe("tab_not_found");
});

test("the bridge's client survives a line from Herdr that is not JSON: the call fails, the subscription reads on", async () => {
  const socket = join(base, "garbled.sock");
  const started = '{"id":"rh:events.subscribe","result":{"type":"subscription_started"}}';
  const server = createServer((c) => c.on("data", () => c.write(`not json\n${started}\n`)));
  await new Promise<void>((ok) => server.listen(socket, ok));
  try {
    await expect(call(socket, "ping")).rejects.toThrow("ping");
    const sub = subscribe(socket, ALL);
    expect((await sub.started).result.type).toBe("subscription_started");
    sub.close();
  } finally {
    server.close();
  }
});

/** A terminal session control on pane, as session name, its lines put in log as the probe records
 *  them (scripts/probes/herdr/probe-terminal.ts). */
function control(t: Awaited<ReturnType<typeof setup>>, log: { dir: string; msg: any }[], name: string, pane: string, ...flags: string[]) {
  const proc = Bun.spawn([t.bin, "--session", t.session, "terminal", "session", "control", pane, ...flags], { env: t.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reading = (async () => {
    let buf = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) log.push({ dir: `${name}<`, msg: JSON.parse(buf.slice(0, i)) });
    }
  })();
  const closed = (async () => {
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text(), reading]);
    log.push({ dir: `${name} exit`, msg: { code, stderr: err.trim() ? err.trim().split("\n") : [] } });
  })();
  return {
    closed,
    send: (msg: object) => (proc.stdin.write(JSON.stringify(msg) + "\n"), proc.stdin.flush()),
    end: () => proc.stdin.end(),
    frames: (test: (m: any) => boolean = () => true) => until(() => log.some((l) => l.dir === `${name}<` && l.msg.type === "terminal.frame" && test(l.msg))),
  };
}

/** What the fake must say alike, by session: its frames by size and whether whole, the same in a row
 *  once; why it closed, the terminal's and pane's ids taken out; how it exited, by its stderr's first
 *  line. And a frame's keys and value types. */
function terminalSeen(log: { dir: string; msg: any }[]) {
  const by: Record<string, string[]> = {};
  for (const { dir, msg } of log) {
    const [, name, what] = /^([A-Z]) ?(<|exit)$/.exec(dir) ?? [];
    if (!name) continue;
    const said =
      what === "exit"
        ? `exit ${msg.code} ${(msg.stderr[0] ?? "").replace(/: No such file.*/, "")}`
        : msg.type === "terminal.frame"
          ? `${msg.full ? "whole" : "part"} ${msg.width}x${msg.height}`
          : `closed ${msg.reason.replace(/term_\w+/, "TERM").replace(/target \S+/, "target PANE")}`;
    if ((by[name] ??= []).at(-1) !== said) by[name]!.push(said);
  }
  const frame = log.find((l) => l.msg?.type === "terminal.frame")!.msg;
  return { by, frame: shape(frame) };
}

test("terminal session control, as Herdr 0.9.1 did it (scripts/probes/herdr/probe-terminal.ts): one operator, a second refused or taking over, letting go by release or stdin's end, the pane's process exiting, no pane, the pane closed, a stopping Herdr, none; every line it gets in fake.calls", async () => {
  const recorded = readFileSync(join(import.meta.dir, "fixtures/herdr/terminal-control.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const real = terminalSeen(recorded);
  expect(real.by).toEqual({
    A: ["whole 50x20", "part 50x20", "whole 40x12", "part 40x12", "closed terminal attach taken over", "exit 0 "],
    B: ["closed terminal attach failed: terminal TERM already has an attached client; retry with --takeover", "exit 0 "],
    C: ["whole 30x10", "closed detached", "exit 0 "],
    D: ["whole 30x10", "closed detached", "exit 0 "],
    E: ["whole 30x10", "closed terminal TERM exited", "exit 0 "],
    F: ["closed terminal session control failed: terminal target PANE not found", "exit 0 "],
    I: ["whole 30x10", "closed terminal attach ended: terminal TERM not found", "exit 0 "],
    H: ["whole 30x10", "closed server is shutting down", "exit 0 "],
    G: ["exit 1 herdr: failed to connect to server"],
  });

  const t = await setup();
  const log: { dir: string; msg: any }[] = [];
  const pane = (await call(t.socket, "workspace.create", { cwd: t.work, label: "w", focus: false })).result.root_pane.pane_id;
  const a = control(t, log, "A", pane, "--cols", "50", "--rows", "20");
  await a.frames();
  a.send({ type: "terminal.input", text: "echo hello\r" });
  await a.frames((m) => atob(m.bytes).includes("echo hello"));
  a.send({ type: "terminal.resize", cols: 40, rows: 12 });
  await a.frames((m) => m.width === 40);
  a.send({ type: "terminal.input", text: "seq 1 30\r" });
  a.send({ type: "terminal.scroll", direction: "up", lines: 5 });
  a.send({ type: "terminal.scroll", direction: "down", lines: 5 });
  await a.frames((m) => atob(m.bytes).includes("down"));
  await control(t, log, "B", pane, "--cols", "30", "--rows", "10").closed;
  const c = control(t, log, "C", pane, "--takeover", "--cols", "30", "--rows", "10");
  await a.closed;
  await c.frames();
  c.send({ type: "terminal.release" });
  await c.closed;
  const d = control(t, log, "D", pane, "--cols", "30", "--rows", "10");
  await d.frames();
  d.end();
  await d.closed;
  const e = control(t, log, "E", pane, "--cols", "30", "--rows", "10");
  await e.frames();
  process.kill((await call(t.socket, "pane.process_info", { pane_id: pane })).result.process_info.shell_pid, "SIGKILL");
  await e.closed;
  await control(t, log, "F", "w9:p9", "--cols", "30", "--rows", "10").closed;
  const closing = (await call(t.socket, "workspace.create", { cwd: t.work, label: "w", focus: false })).result;
  const i = control(t, log, "I", closing.root_pane.pane_id, "--cols", "30", "--rows", "10");
  await i.frames();
  await call(t.socket, "tab.close", { tab_id: closing.tab.tab_id });
  await i.closed;
  const other = (await call(t.socket, "workspace.create", { cwd: t.work, label: "w", focus: false })).result.root_pane.pane_id;
  const h = control(t, log, "H", other, "--cols", "30", "--rows", "10");
  await h.frames();
  const calls = (await call(t.socket, "fake.calls")).result.calls.filter((c: any) => c.method.startsWith("terminal."));
  await t.server.stop();
  await h.closed;
  await control(t, log, "G", other, "--cols", "30", "--rows", "10").closed;
  expect(terminalSeen(log)).toEqual(real);
  // The first frame is the whole screen, saying its size.
  expect(atob(log.find((l) => l.dir === "A<")!.msg.bytes)).toContain(`${pane} 50x20`);

  const attach = (cols: number, rows: number, takeover = false, pane_id = pane) => ({ method: "terminal.session.control", params: { pane_id, takeover, cols, rows } });
  expect(calls).toEqual([
    attach(50, 20),
    { method: "terminal.input", params: { text: "echo hello\r" } },
    { method: "terminal.resize", params: { cols: 40, rows: 12 } },
    { method: "terminal.input", params: { text: "seq 1 30\r" } },
    { method: "terminal.scroll", params: { direction: "up", lines: 5 } },
    { method: "terminal.scroll", params: { direction: "down", lines: 5 } },
    attach(30, 10),
    attach(30, 10, true),
    { method: "terminal.release", params: {} },
    attach(30, 10),
    attach(30, 10),
    attach(30, 10, false, "w9:p9"),
    attach(30, 10, false, closing.root_pane.pane_id),
    attach(30, 10, false, other),
  ]);
}, 15_000);
