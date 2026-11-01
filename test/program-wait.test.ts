// An agent program that is not there for a while, as while Claude or pi updates itself in place:
// the start waits for it (architecture §4.2, product §4.5), seen from seam one.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { newInstance, until, withoutSource, type Instance } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Bot q sends your messages to slot w/a; a start waits `wait` for a missing program. */
async function slotA(wait: string): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `[durations]\nprogramWait = "${wait}"` });
  await rhodium.start();
  await rhodium.slots("a");
}

async function posts(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

const state = () => rhodium.state("w/a");

/** Has a holder tried to start the fake claude and found its interpreter not there? It leaves an exit file. */
const refused = () => [...new Bun.Glob("state/hold/*/exit").scanSync(rhodium.dir)].length > 0;

/** Points the fake claude at an interpreter not there; returns where to put it back. */
function noInterpreter(): string {
  const claude = rhodium.claude.path;
  const interpreter = join(rhodium.dir, "bin/bun-updating");
  writeFileSync(claude, readFileSync(claude, "utf8").replace(process.execPath, interpreter));
  return interpreter;
}

/** Your messages the fake claude was given, over all its runs. */
const said = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

test("the agent program gone for a moment: the start waits for it, and your message gets its reply with no notice", async () => {
  await slotA("10s");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await Bun.sleep(1500);
  expect(await state()).toBe("启动中"); // your message waits with it
  renameSync(`${claude}.updating`, claude);

  const [reply, ...more] = await posts(1);
  expect(reply!.text).toBe("fake reply");
  await until(async () => (await state()) === "空闲", 15_000);
  expect(more).toEqual([]);
  expect(said()).toEqual(["hi"]);
}, 30_000);

test("the agent program not back in time: one notice that keeps your message for the next start, with no ask to send it again; your next message starts it, and it gets both", async () => {
  await slotA("2s");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.gone`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  const [notice] = await posts(1);
  expect(notice!.text).toBe(`w/a 没能启动，找不到 claude 程序。\n等着的消息都还在，不用重发。下次来消息时再启动它，到时一起交给它。\n原因：等了 2 秒还是找不到 ${claude}`);
  expect(notice!.text).not.toContain("崩溃");
  expect(await state()).toBe("未运行");

  renameSync(`${claude}.gone`, claude);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => said().length === 2, 15_000);
  expect(said()).toEqual(["hi", "again"]);
  await until(async () => (await state()) === "空闲", 15_000);
  expect((await rhodium.im.log("q", ME)).filter((p) => p.text?.includes("没能启动"))).toHaveLength(1);
}, 30_000);

test("the program there but its interpreter not, so the holder cannot start it: the start tries again, and your message gets its reply", async () => {
  await slotA("10s");
  const interpreter = noInterpreter();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await Bun.sleep(1500);
  expect(await state()).toBe("启动中");
  symlinkSync(process.execPath, interpreter);

  const [reply, ...more] = await posts(1);
  expect(reply!.text).toBe("fake reply");
  await until(async () => (await state()) === "空闲", 15_000);
  expect(more).toEqual([]);
  expect(said()).toEqual(["hi"]);
}, 30_000);

test("rhodium restarted while the start waits for the program's interpreter: the start goes on after the restart, and your message gets its reply with no crash notice", async () => {
  await slotA("20s");
  const interpreter = noInterpreter();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await until(refused, 10_000);
  await Bun.sleep(300); // rh-hold writes its exit file before rhodium marks the holder row exited; well under PROGRAM_RETRY, so no next try yet
  await rhodium.stop();
  symlinkSync(process.execPath, interpreter);
  await rhodium.start();

  const [reply] = await posts(1);
  expect(reply!.text).toBe("fake reply");
  await until(async () => (await state()) === "空闲", 15_000);
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  expect(said()).toEqual(["hi"]);
}, 30_000);

test("story 22: rh stop while the start waits for the program ends the wait at once: the slot is off, with no notice, and starts with your next message", async () => {
  await slotA("6s");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await until(async () => (await state()) === "启动中", 15_000);
  await Bun.sleep(300);
  expect(await rhodium.ok("stop", "w/a")).toBe("正在停止 w/a，对话保留。\n");
  await until(async () => (await state()) === "未运行", 1_500);
  renameSync(`${claude}.updating`, claude);
  await Bun.sleep(7000); // past the wait: nothing started, and no notice
  expect(await rhodium.im.log("q", ME)).toEqual([]);
  expect(rhodium.claude.runs()).toEqual([]);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  const [reply] = await posts(1);
  expect(reply!.text).toBe("fake reply");
  expect(said()).toEqual(["hi", "again"]);
}, 30_000);

test("story 54: a command while the start waits for the program waits with it, and runs once the program is back", async () => {
  // Commands wait holdStartTimeout for an agent still starting; the program is back only after that.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: '[durations]\nprogramWait = "10s"\nholdStartTimeout = "2s"' });
  await rhodium.start();
  await rhodium.slots("a");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/model haiku" });
  await Bun.sleep(3500);
  expect(await rhodium.im.log("q", ME)).toEqual([]);
  renameSync(`${claude}.updating`, claude);
  const [reply, ...more] = await posts(1);
  expect(reply!.text).toStartWith("已切到 Haiku。");
  expect(more).toEqual([]);
}, 30_000);

test("story 54: a command while the start waits for a program that does not come back says so once the wait is over", async () => {
  await slotA("2s");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.gone`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/model haiku" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 5_000);
  const texts = (await rhodium.im.log("q", ME)).map((p) => p.text);
  expect(texts).toContain("/model 没做成。\n原因：找不到 claude 程序");
  expect(texts.some((t) => t.startsWith("w/a 没能启动，找不到 claude 程序。"))).toBe(true);
}, 30_000);

test("the program's interpreter not back in time: once the slot gives up, rh doctor finds no holder the store takes for running", async () => {
  await slotA("2s");
  noInterpreter();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  const [notice] = await posts(1);
  expect(notice!.text).toStartWith("w/a 没能启动，找不到 claude 程序。");
  expect(await rhodium.ok("doctor")).not.toContain("库里有、systemd 里没有的托管进程");
}, 30_000);

test("the slot's directory not there: the start crashes at once, with no wait for the program", async () => {
  await slotA("10s");
  rmSync(join(rhodium.dir, "w"), { recursive: true });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  const [notice] = await posts(1);
  expect(notice!.text).toStartWith("w/a 崩溃了，没能启动。");
  expect(notice!.text).not.toContain("找不到");
}, 30_000);

test("a start that fails for another reason, here a program that may not be run, is a crash whose notice keeps your message all the same: the next one brings both", async () => {
  await slotA("10s");
  const claude = rhodium.claude.path;
  chmodSync(claude, 0o644);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  const [notice] = await posts(1);
  expect(notice!.text).toStartWith("w/a 崩溃了，没能启动。\n等着的消息都还在，不用重发。下次来消息时再启动它，到时一起交给它。\n原因：");
  chmodSync(claude, 0o755);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => said().length === 2, 15_000);
  expect(said()).toEqual(["hi", "again"]);
}, 30_000);
