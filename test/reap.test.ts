// Idle reap (stories 14–17, product §4.4), seen from seam one with the reap time in seconds.
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { background } from "./fake-agent/scripts";
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
  const ended = Date.now();
  await Bun.sleep(1500); // idle three quarters of the reap time
  await rhodium.kill9();
  await rhodium.start(); // the agent, asked again how it is, says it runs no background task
  await until(async () => (await state()) === "未运行", 15_000);
  // Due 2 s after the turn's end; counted from the restart, it would be 3.5 s at the least.
  expect(Date.now() - ended).toBeLessThan(3000);
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
