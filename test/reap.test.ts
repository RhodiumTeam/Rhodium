// Idle reap (stories 14–17, product §4.4), seen from seam one with the reap time in seconds.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Posted } from "../src/fake-im";
import { installFakeAgent, type Script } from "./fake-agent/fake-agent";
import { background, endTurn, on, rateLimited, startTurn, toolUse } from "./fake-agent/scripts";
import { newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Bot q sends your messages to slot w/a; the global reap time is reap. */
async function slotA(reap: string, opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `[durations]\nidleReap = "${reap}"`, ...opts });
  await rhodium.start();
  await rhodium.slots("a");
}

async function posts(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

const state = () => rhodium.state("w/a");

/** A file of the slot's holder (architecture §4.3). */
const holdFile = (name: "out.log" | "in.log") => {
  const dir = join(rhodium.dir, "state/hold");
  return readFileSync(join(dir, readdirSync(dir)[0]!, name), "utf8");
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("story 16: rh set reap= on a slot already idle takes effect: shorter reaps it", async () => {
  await slotA("1h");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  expect(await rhodium.ok("set", "w/a", "reap=500ms")).toContain("回收时长: 500ms");
  await until(async () => (await state()) === "未运行", 15_000);
}, 30_000);

test("story 16: rh set reap= on slots already idle takes effect: longer and off keep them, the default reaps", async () => {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" }, qc: { like: "qq", owner: ME, target: "w/c" } },
    toml: '[durations]\nidleReap = "1500ms"',
  });
  await rhodium.start();
  await rhodium.slots("a", "b", "c");
  for (const bot of ["q", "qb", "qc"]) await rhodium.im.inject(bot, { chat: ME, sender: ME, text: "hello" });
  for (const bot of ["q", "qb", "qc"]) await until(async () => (await rhodium.im.log(bot, ME)).length === 1, 15_000);
  await rhodium.ok("set", "w/b", "reap=1h");
  await rhodium.ok("set", "w/c", "reap=off");

  await until(async () => (await state()) === "未运行", 15_000);
  await Bun.sleep(500); // past the default for all three
  expect(await rhodium.state("w/b")).toBe("空闲");
  expect(await rhodium.state("w/c")).toBe("空闲");
}, 30_000);

test("story 17: an agent with a background task running is not reaped; once the task is done and its turn ends, it is", async () => {
  // The task runs 1.5 s after the turn that started it, three times the reap time.
  await slotA("500ms", { claude: { script: background(1500) } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "start it" });
  expect((await posts(1)).map((p) => p.text)).toEqual(["started"]);
  await Bun.sleep(1000);
  expect(await state()).toBe("空闲");
  const out = () => readFileSync(join(rhodium.dir, "state/hold", readdirSync(join(rhodium.dir, "state/hold"))[0]!, "out.log"), "utf8");
  expect(out()).not.toContain("background task done");

  await until(async () => (await state()) === "未运行", 15_000);
  expect(out()).toContain("background task done"); // reaped only after the task's own turn
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 30_000);

test("story 17: the reap time counts from the end of the turn the done task wakes the agent for, though Claude says the task is done a moment before that turn starts", async () => {
  // The task over in one chunk, the turn it wakes for 30 ms later in the next, which takes 300 ms.
  const steps = background(1500).steps.flatMap((s) =>
    "emit" in s && s.emit.some((l) => l.includes("task_notification")) ? [{ emit: s.emit.slice(0, 2) }, { sleep: 30 }, { emit: s.emit.slice(2) }, { sleep: 300 }] : [s],
  );
  await slotA("500ms", { claude: { script: { on, steps } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "start it" });
  await posts(1);
  await until(() => holdFile("out.log").includes("background task done"), 15_000);
  await Bun.sleep(150);
  expect(await state()).toBe("空闲");
}, 30_000);

test("story 14: the reap clock lives through a restart of rhodium: reaped while rhodium is down", async () => {
  await slotA("1s");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  const agent = rhodium.claude.runs()[0]!.pid;
  await rhodium.kill9();
  await Bun.sleep(1200);
  await rhodium.start();
  await until(async () => (await state()) === "未运行", 15_000);
  await until(() => !alive(agent), 15_000);
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
}, 30_000);

test("story 123: an idle agent that died while rhodium was down, past its reap time, is no reap but a crash: you hear of it", async () => {
  await slotA("1s");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  await rhodium.kill9();
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  await until(async () => !(await rhodium.units()).some((u) => u.includes("hold-")), 15_000);
  await Bun.sleep(1200); // past the reap time
  await rhodium.start();
  const [, notice] = await posts(2);
  expect(notice!.text).toStartWith("w/a 崩溃了");
  expect(notice!.text).toContain("\n原因：agent 被信号 KILL 结束");
}, 30_000);

test("story 14: a restart of rhodium does not set the reap clock back: it still counts from the turn's end", async () => {
  await slotA("2s");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  await Bun.sleep(1500); // idle three quarters of the reap time
  await rhodium.kill9();
  await rhodium.start(); // the agent, asked again how it is, says it runs no background task
  const ready = Date.now();
  await until(async () => (await state()) === "未运行", 15_000);
  // Due 2 s after the turn's end: half a second after the restart at most, or at once if that took
  // longer; counted from the restart, 2 s after it. Measured from ready, as a busy machine restarts slowly (#575).
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const stop = db.query("SELECT at FROM event WHERE source = 'clock' AND type = 'slot_stop'").get() as { at: number };
  db.close();
  expect(stop.at - ready).toBeLessThan(1000);
  expect(await rhodium.im.log("q", ME)).toHaveLength(1); // reaped, no crash: no notice
}, 30_000);

test("story 15: the next message after a reap resumes the same conversation", async () => {
  await slotA("500ms");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  await until(async () => (await state()) === "未运行", 15_000);

  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  expect((await posts(2))[1]).toMatchObject({ text: "fake reply", replyTo: messageId });
  const [first, again, ...more] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
  expect(more).toEqual([]);
}, 30_000);

/** A picture the agent read, which comes back as a little over a megabyte of base64 (#578). */
const picture = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2 ** 20 + 2 ** 17) } }] }] },
  parent_tool_use_id: null,
});
const BIG = '\n[limits]\noutRestartMB = 1';

test("#578: an agent past limits.outRestartMB of output goes once its turn ends, its reap far off; the next message resumes the conversation in a fresh one, the old output gone", async () => {
  // Each turn reads a picture.
  const reading: Script = { on, steps: [...startTurn, toolUse("toolu_read", "Read", { file_path: "shot.png" }), { emit: [picture] }, ...endTurn("fake reply"), { goto: 0 }] };
  await slotA("1h", { claude: { script: reading }, toml: `[durations]\nidleReap = "1h"${BIG}` });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts(1);
  await until(async () => (await state()) === "未运行", 15_000);
  expect(await rhodium.im.log("q", ME)).toHaveLength(1); // no crash: no notice

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  expect((await posts(2))[1]!.text).toContain("fake reply");
  const [first, again] = rhodium.claude.runs();
  expect(again!.argv).toContain(`--resume=${first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1]}`);
  // All of the first process's output was read, so the second one's logs start afresh.
  expect(holdFile("in.log")).not.toContain("hello");
  expect(holdFile("in.log")).toContain("again");
  expect(holdFile("out.log").length).toBeLessThan(2 * 2 ** 20);
}, 30_000);

test("#578: a slot with auto-continue off and its reap off goes at the quota's reset, its agent past limits.outRestartMB of output", async () => {
  await slotA("0s", { toml: `[durations]\nidleReap = "0s"${BIG}` });
  await rhodium.ok("set", "w/a", "auto-continue=off");
  // The turn reads a picture, then is refused for quota till a reset 2 s away.
  installFakeAgent(dirname(rhodium.claude.path), { script: rateLimited(Math.ceil(Date.now() / 1000) + 2, true, undefined, [{ emit: [picture] }]) });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await state()) === "未运行", 15_000);
}, 30_000);
