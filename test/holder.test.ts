// Process-level tests for the holder (spec "接缝二"): this file plays rhodium, the fake
// agent plays the agent, and every holder runs under a real `systemd-run --user`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { connectHolder, holderPaths, launchHolder, spawnHolder, type HolderEvents } from "../src/holder";
import { openStore, ulid } from "../src/store";
import { installFakeAgent, type Config as FakeConfig } from "./fake-agent/fake-agent.ts";
import { exec, rhHold, systemctl } from "./instance";

const base = mkdtempSync(join(tmpdir(), "rhodium-test-holder-"));
// Our own unit prefix, socket and lock directories, so parallel test runs and the
// real Rhodium never see each other's holders.
const prefix = `rhodium-test-${crypto.randomUUID().slice(0, 8)}-`;
const { bin: holdBin, built } = rhHold();

writeFileSync(
  join(base, "config.toml"),
  [
    `stateDir = "${base}/state"`,
    `socketDir = "${base}/run"`,
    `lockDir = "${base}/lock"`,
    `unitPrefix = "${prefix}"`,
    `agentPath = "${base}/bin:/usr/bin:/bin"`,
    "[durations]",
    'holdStartTimeout = "500ms"',
  ].join("\n"),
  { mode: 0o600 },
);
const cfg = loadConfig(join(base, "config.toml"));
const store = openStore(join(base, "rh.db"));
const home = join(base, "home");
mkdirSync(home);
mkdirSync(join(base, "bin"));
const TOKEN = "tok-3f9a1c77e2";

beforeAll(() => built, 300_000);

afterAll(async () => {
  await exec(["systemctl", "--user", "stop", `${prefix}*`]);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const unitExists = async (unit: string) =>
  (await systemctl("list-units", "--all", "--no-legend", "--plain", `${unit}.service`)) !== "";
const readExit = (dir: string) => JSON.parse(readFileSync(join(dir, "exit"), "utf8"));

async function until(done: () => boolean | Promise<boolean>, ms = 10_000) {
  for (const end = Date.now() + ms; !(await done()); await Bun.sleep(20)) {
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms`);
  }
}

test("a holder that gets no start within holdStartTimeout exits and leaves no unit", async () => {
  const { unit, dir } = await launchHolder({ cfg, store, conversation: ulid(), holdBin });
  expect(await unitExists(unit)).toBe(true);
  await until(async () => !(await unitExists(unit)), 5000);
  expect(readExit(dir)).toEqual({ from: "holder", code: 0, signal: null });
}, 15_000);

test("a holder's unit goes on when the kernel kills one of its processes for memory, as a test the agent runs", async () => {
  const { unit } = await launchHolder({ cfg, store, conversation: ulid(), holdBin });
  expect(await systemctl("show", "--property=OOMPolicy", "--value", `${unit}.service`)).toBe("continue");
}, 15_000);

/** Plays rhodium's side of one connection: keeps every out message and the exit. */
function recorder() {
  const chunks: { pos: number; data: Buffer }[] = [];
  const acks: string[] = [];
  let onExit!: (e: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (onExit = r));
  let closed = false;
  const on: HolderEvents = {
    out: (pos, data) => chunks.push({ pos, data: Buffer.from(data) }),
    ack: (id) => acks.push(id),
    exit: (code, signal) => onExit({ code, signal }),
    close: () => (closed = true),
  };
  const bytes = () => Buffer.concat(chunks.map((c) => c.data));
  return {
    on,
    chunks,
    acks,
    exited,
    bytes,
    lines: () => bytes().toString().split("\n").slice(0, -1),
    closed: () => closed,
  };
}

/** A holder running `argv`, started the way rhodium starts one. */
async function startHolder(argv: string[], conversation = ulid()) {
  const got = recorder();
  const link = await spawnHolder({
    cfg,
    store,
    conversation,
    holdBin,
    boot: 1,
    on: got.on,
    spec: { argv, env: { HOME: home, RHODIUM_TOKEN: TOKEN }, cwd: home },
  });
  return { ...holderPaths(cfg, conversation), conversation, link, got };
}

/** A holder running the fake agent with `script`. */
async function agentHolder(script: FakeConfig["script"], argv: string[] = []) {
  const conversation = ulid();
  const agent = installFakeAgent(join(base, "bin"), { script, transcript: false }, `agent-${conversation}`);
  return { ...(await startHolder([agent.path, ...argv], conversation)), agent };
}

test("an agent that exits by itself: exit carries its code and the exit file says it came from the agent", async () => {
  const h = await agentHolder({ steps: [{ emit: ['{"bye":1}'] }, { exit: 3 }] });
  expect(await h.got.exited).toEqual({ code: 3, signal: null });
  expect(h.got.lines()).toEqual(['{"bye":1}']);
  expect(await h.link.exited).toEqual({ code: 3, signal: null }); // AgentLink.exited, for the driver
  await until(async () => !(await unitExists(h.unit)));
  expect(readExit(h.dir)).toEqual({ from: "agent", code: 3, signal: null });
}, 15_000);

test("the agent sees exactly the PATH from the config, and nothing of the holder's own environment", async () => {
  const h = await agentHolder({ steps: [{ exit: 0 }] });
  await h.got.exited;
  const env = h.agent.runs()[0]!.env;
  expect(env.PATH).toBe(cfg.agentPath);
  expect(env.HOME).toBe(home);
  expect(env.INVOCATION_ID).toBeUndefined(); // systemd sets it for the holder only
}, 15_000);

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const outLog = (dir: string) => readFileSync(join(dir, "out.log"));

test("in.log records each line written to stdin with out.log's size at that moment", async () => {
  const h = await agentHolder("turn");
  await h.link.write("a", user("one"));
  await until(() => h.got.lines().some((l) => l.includes('"idle"')));
  const size = h.got.bytes().length;
  await h.link.write("b", user("two"));
  expect(readFileSync(join(h.dir, "in.log"), "utf8")).toBe(`0 ${user("one")}\n${size} ${user("two")}\n`);
  await h.link.eof();
  expect(await h.got.exited).toEqual({ code: 0, signal: null });
  expect(h.agent.runs()[0]!.stdin).toEqual([user("one"), user("two")]);
}, 15_000);

test("a new hello takes over from the old connection, which is closed; a bad hello takes nothing over", async () => {
  const h = await agentHolder("turn");
  await expect(connectHolder(h.sock, { boot: 2, offset: -1 }, recorder().on)).rejects.toThrow();
  expect(h.got.closed()).toBe(false);
  const second = recorder();
  const link = await connectHolder(h.sock, { boot: 2, offset: 0 }, second.on);
  await until(() => h.got.closed());
  await link.write("c", user("hi"));
  await until(() => second.lines().some((l) => l.includes("fake reply")));
  await link.eof();
  expect(await second.exited).toEqual({ code: 0, signal: null });
}, 15_000);

test("a reconnect while a write is stuck in stdin: hello_ok says so, and each line reaches stdin once", async () => {
  const h = await agentHolder({ steps: [] }); // reads stdin until eof
  await until(() => h.agent.runs().length > 0);
  const agentPid = h.agent.runs()[0]!.pid;
  process.kill(agentPid, "SIGSTOP"); // the agent stops reading stdin
  const big = user("x".repeat(300 * 1024)); // well over the 64 KiB pipe buffer
  const small = user("queued behind the big one");
  const inLog = () => readFileSync(join(h.dir, "in.log"), "utf8");
  h.link.write("w1", big).catch(() => {});
  // Queued behind w1 on the old connection: once it is replaced, the holder handles neither.
  h.link.eof().catch(() => {});
  h.link.write("w2", small).catch(() => {});
  await until(() => inLog().length > big.length); // w1 is on its way into stdin
  h.link.close(); // rhodium restarts
  await until(() => h.got.closed());

  const again = recorder();
  const link = await connectHolder(h.sock, { boot: 2, offset: 0 }, again.on);
  expect(link.hello.written).toEqual([]);
  expect(link.hello.writing).toBe("w1");
  // §4.6: w1 is still being written, so wait for its ack; w2 never got in, so write it again.
  const w2 = link.write("w2", small);
  process.kill(agentPid, "SIGCONT");
  await until(() => again.acks.includes("w1"));
  await w2;
  await link.eof();
  expect(await again.exited).toEqual({ code: 0, signal: null });
  expect(h.agent.runs()[0]!.stdin).toEqual([big, small]);
  expect(inLog().split("\n").length - 1).toBe(2);
}, 15_000);

test("lines with U+2028, several MB, or a character split across two writes arrive byte for byte", async () => {
  const h = await agentHolder("hard-lines");
  await h.link.write("h", user("go"));
  await until(() => h.got.lines().some((l) => l.includes('"idle"')));
  const said = h.got
    .lines()
    .map((l) => JSON.parse(l))
    .filter((m) => m.type === "assistant")
    .map((m) => m.message.content[0].text);
  expect(said).toEqual(["line separator   inside a line", "x".repeat(3 * 1024 * 1024), "汉字被切开", "done"]);
  expect(h.got.bytes().equals(outLog(h.dir))).toBe(true);
  // Every out message is whole lines, so the 3 MiB line came in one piece.
  expect(h.got.chunks.filter((c) => c.data.at(-1) !== 10)).toEqual([]);
  await h.link.eof();
  await h.got.exited;
}, 15_000);

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

test("kill -9 of the holder stops the agent in its unit, and the exit file says the holder died", async () => {
  const h = await agentHolder("seq");
  await h.link.write("k", user("go"));
  await until(() => h.agent.runs().length > 0);
  const agentPid = h.agent.runs()[0]!.pid;
  const holderPid = Number(await systemctl("show", "--property=MainPID", "--value", `${h.unit}.service`));
  // Only ever kill the pid we recorded, and only once it is surely our holder.
  expect(holderPid).toBeGreaterThan(1);
  expect(readFileSync(`/proc/${holderPid}/cmdline`, "utf8")).toStartWith(`${holdBin}\0run\0${h.dir}\0`);
  process.kill(holderPid, "SIGKILL");
  await until(async () => !(await unitExists(h.unit)));
  expect(alive(agentPid)).toBe(false);
  expect(readExit(h.dir)).toEqual({ from: "holder", code: null, signal: "KILL" });
}, 15_000);

test("neither the token nor the agent's arguments show up on the holder's or the unit's command line", async () => {
  const marker = `--marker-${ulid()}`; // its own, as other runs of this file may be in ps too
  const h = await agentHolder("turn", [marker]);
  await until(() => h.agent.runs().length > 0);
  const agentPid = h.agent.runs()[0]!.pid;
  const ps = (await exec(["ps", "-eo", "pid=,args="])).out.split("\n");
  expect(ps.filter((l) => l.includes(TOKEN))).toEqual([]);
  expect(ps.filter((l) => l.includes(marker) && Number(l.trim().split(" ")[0]) !== agentPid)).toEqual([]);
  const unit = await systemctl("show", `${h.unit}.service`);
  expect(unit).not.toContain(TOKEN);
  expect(unit).not.toContain(marker);
  await h.link.eof();
  await h.got.exited;
}, 15_000);

test("the holder holds the conversation lock while the agent lives", async () => {
  const h = await agentHolder("turn");
  const tryLock = async () => (await exec(["flock", "--nonblock", h.lock, "true"])).code;
  expect(await tryLock()).toBe(1);
  await h.link.eof();
  await h.got.exited;
  await until(async () => !(await unitExists(h.unit)));
  expect(await tryLock()).toBe(0);
}, 15_000);

test("an agent that cannot start: exit 127 from the agent, the reason in err.log", async () => {
  const conversation = ulid();
  const got = recorder();
  const spawning = spawnHolder({
    cfg,
    store,
    conversation,
    holdBin,
    boot: 1,
    on: got.on,
    spec: { argv: [join(base, "bin/no-such-agent")], env: {}, cwd: home },
  });
  await expect(spawning).rejects.toThrow(/did not start/);
  expect(await got.exited).toEqual({ code: 127, signal: null });
  const { dir, unit } = holderPaths(cfg, conversation);
  await until(async () => !(await unitExists(unit)));
  expect(readExit(dir)).toEqual({ from: "agent", code: 127, signal: null });
  expect(readFileSync(join(dir, "err.log"), "utf8")).toContain("no-such-agent");
}, 15_000);

test("a relaunch after the hold directory was cleaned up replays from byte 0, whatever offset the store had", async () => {
  const conversation = ulid();
  // The last holder got far; its directory has since been deleted (§4.3).
  store.tx((tx) => tx.insert("holder", { conversation, unit: "gone", proto: 1, outOffset: 1000, outStart: 0, errStart: 0, stopRequested: 0, exited: 0 }));
  const h = await startHolder(["/bin/sh", "-c", "echo first; echo second"], conversation);
  expect(await h.got.exited).toEqual({ code: 0, signal: null });
  expect(h.got.lines()).toEqual(["first", "second"]);
}, 15_000);

test("a relaunch appends to out.log and in.log, ends the half line left behind, and clears the old exit", async () => {
  const conversation = ulid();
  const first = await startHolder(["/bin/sh", "-c", "read l; printf 'one\\npartial'"], conversation);
  await first.link.write("a", "in-one");
  await first.got.exited;
  await until(async () => !(await unitExists(first.unit)));
  expect(readExit(first.dir)).toEqual({ from: "agent", code: 0, signal: null });
  store.tx((tx) => tx.update("holder", { conversation }, { outOffset: 4 })); // rhodium got as far as "one\n"

  const again = await startHolder(["/bin/sh", "-c", "read l; echo two"], conversation);
  expect(existsSync(join(again.dir, "exit"))).toBe(false); // that exit was the last agent's
  await again.link.write("b", "in-two");
  expect(await again.got.exited).toEqual({ code: 0, signal: null });
  expect(outLog(again.dir).toString()).toBe("one\npartial\ntwo\n");
  expect(readFileSync(join(again.dir, "in.log"), "utf8")).toBe("0 in-one\n12 in-two\n");
  // The half line comes back as a whole line, as if the new agent had said it.
  expect(again.got.chunks[0]!.pos).toBe(4);
  expect(again.got.bytes().toString()).toBe("partial\ntwo\n");
}, 20_000);

test("stderr still being written when the agent exits reaches err.log before the holder goes", async () => {
  // Something the agent left behind holds stderr (not stdout) a little past the agent's exit.
  const h = await startHolder(["/bin/sh", "-c", "(sleep 0.3; echo late-diag >&2) >/dev/null & exit 0"]);
  expect(await h.got.exited).toEqual({ code: 0, signal: null });
  await until(async () => !(await unitExists(h.unit)));
  expect(readExit(h.dir)).toEqual({ from: "agent", code: 0, signal: null });
  expect(readFileSync(join(h.dir, "err.log"), "utf8")).toBe("late-diag\n");
}, 15_000);

// The interleaving is forced with chrt and taskset, finding the writer by its wchan: skipped without them.
const canForce = Boolean(Bun.which("chrt") && Bun.which("taskset")) && existsSync("/proc/self/wchan");
test.skipIf(!canForce)("a write that waited behind one finishing after a reconnect is still named in writing at the next hello", async () => {
  const big = "x".repeat(300 * 1024); // well over the 64 KiB pipe buffer
  const gate = join(base, `gate-${ulid()}`);
  // Reads nothing until the gate opens, then exactly the first line, then nothing again.
  const reader = `until [ -e ${gate} ]; do sleep 0.02; done; head -c ${big.length + 1} >/dev/null; exec sleep 60`;
  const h = await startHolder(["/bin/sh", "-c", reader]);
  const inLog = () => readFileSync(join(h.dir, "in.log"), "utf8");
  h.link.write("a", big).catch(() => {});
  await until(() => inLog().length > big.length); // a is stuck in stdin
  h.link.close();
  await until(() => h.got.closed());
  const second = recorder();
  const link = await connectHolder(h.sock, { boot: 2, offset: 0 }, second.on);
  expect(link.hello.writing).toBe("a");
  link.write("b", big).catch(() => {}); // waits for a to finish
  await Bun.sleep(200);

  // Make the bad interleaving certain rather than rare: on one CPU, a's thread is SCHED_IDLE,
  // so b's thread runs the moment a lets go of stdin, before a does anything else.
  const pid = await systemctl("show", "--property=MainPID", "--value", `${h.unit}.service`);
  const task = (t: string) => readFileSync(`/proc/${pid}/task/${t}/wchan`, "utf8").trim();
  const writer = readdirSync(`/proc/${pid}/task`).filter((t) => task(t) === "pipe_write");
  expect(writer.length).toBe(1);
  expect((await exec(["chrt", "--idle", "-p", "0", writer[0]!])).code).toBe(0);
  expect((await exec(["taskset", "-a", "-cp", "0", pid])).code).toBe(0);
  writeFileSync(gate, "");
  await until(() => second.acks.includes("a"));
  await until(() => inLog().length > 2 * big.length); // b is on its way into stdin, stuck there

  const third = recorder();
  const last = await connectHolder(h.sock, { boot: 3, offset: 0 }, third.on);
  expect(last.hello.written).toEqual(["a"]);
  expect(last.hello.writing).toBe("b"); // not null: rhodium must not write b again (§4.6)
  await last.signal("KILL");
  await third.exited;
}, 15_000);

test("a signal above 15 is named the way systemd names it for ExecStopPost", async () => {
  const h = await startHolder(["/bin/sh", "-c", "kill -s PWR $$"]); // 30
  expect(await h.got.exited).toEqual({ code: null, signal: "PWR" });
  await until(async () => !(await unitExists(h.unit)));
  expect(readExit(h.dir)).toEqual({ from: "agent", code: null, signal: "PWR" });
}, 15_000);

test("a line nested 200k deep only drops its connection; the holder carries on", async () => {
  const h = await agentHolder("turn");
  const raw = connect(h.sock);
  raw.on("error", () => {});
  raw.end("[".repeat(200_000) + "\n");
  await new Promise((r) => raw.on("close", r));
  const again = recorder();
  const link = await connectHolder(h.sock, { boot: 2, offset: 0 }, again.on);
  await link.eof();
  expect(await again.exited).toEqual({ code: 0, signal: null });
}, 15_000);
