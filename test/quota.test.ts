// Waiting out Claude's quota and carrying on at its reset (stories 127-131, product §4.6,
// architecture §7.6), seen from seam one: the fake claude's first turn is refused for quota
// until a reset seconds away.
import { afterEach, expect, test } from "bun:test";
import type { Posted } from "../src/fake-im";
import { dirname } from "node:path";
import { installFakeAgent, type Step } from "./fake-agent/fake-agent";
import { rateLimited } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
// rhodium tells times in its own zone; this one is passed on to it, so both read the same clock.
process.env.TZ = "Etc/GMT-9";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** The reset's time of day as you read it, say 14:30. */
const clock = (resetsAt: number) => new Date(resetsAt * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

/** Waits for no other slot to run out with it: the notice goes at once. */
const NOW = '[durations]\nquotaNotice = "0s"';

/** Bot q sends your messages to slot w/a; started, with the slot made. Resolves to the board's address. */
async function slotA(opts: InstanceOptions = {}): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: NOW, ...opts });
  const d = await rhodium.start();
  await rhodium.slots("a");
  return `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
}

/** Each claude started from now on, as a slot's is on its first message, is out of quota until a
 *  reset s seconds or a little more from now. Set once rhodium is up, so a slow start does not eat
 *  into it. wake, first: as rateLimited's. Returns the reset, in epoch seconds. */
function outOfQuota(s: number, wake?: number, first?: Step[]): number {
  const resetsAt = Math.ceil(Date.now() / 1000) + s;
  installFakeAgent(dirname(rhodium.claude.path), { script: rateLimited(resetsAt, true, wake, first) });
  return resetsAt;
}

async function posts(n: number, bot = "q"): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return rhodium.im.log(bot, ME);
}

/** What each of the slot's claude runs was given as user messages, without their source lines. */
const told = (ref = "w/a") =>
  rhodium.claude
    .runs()
    .filter((r) => r.env.RHODIUM_SLOT === ref)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"))
    .map((m) => withoutSource(m.message.content[0].text) as string);

test("story 127: Claude's quota runs out: the slot waits for it, and you hear when it resets instead of the refusal", async () => {
  const board = await slotA();
  const resetsAt = outOfQuota(30);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [notice] = await posts(1);
  expect(notice!.text).toMatch(new RegExp(`^w/a 用完了 Claude 额度，${clock(resetsAt)} 恢复（还有 \\d+ 秒）。\n到时它自己接着做。这之间发给它的消息先存着，到时一起交给它。$`));
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await Bun.sleep(300); // the refusal would show up by now
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual([notice!.text]);

  // On the board it runs, waiting, with when it carries on (product §4).
  type Board = { workspaces: { name: string; groups: Record<string, { name: string; state: string }[]> }[] };
  const r = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const running = ((await r.json()) as Board).workspaces.find((w) => w.name === "w")!.groups.running!;
  expect(running.map((c) => c.name)).toEqual(["a"]);
  expect(running[0]!.state).toBe(`等额度，预计 ${clock(resetsAt)} 恢复`);
}, 30_000);

test("#240: a reset on another day is told with its day, without seconds: on the board, in the notice, /rh_ls, a slot's details and /rh_use (im-style §2.4)", async () => {
  const board = await slotA();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 5, 0, 0);
  outOfQuota(Math.ceil((tomorrow.getTime() - Date.now()) / 1000));
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  expect((await posts(1))[0]!.text).toStartWith("w/a 用完了 Claude 额度，明天 09:05 恢复");
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);

  const r = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const cards = ((await r.json()) as { workspaces: { name: string; groups: Record<string, { state: string }[]> }[] }).workspaces[0]!.groups.running!;
  expect(cards[0]!.state).toBe("等额度，预计 明天 09:05 恢复");
  for (const [n, text] of [[2, "/rh_ls"], [3, "/rh_ls w/a"], [4, "/rh_use w/a"]] as const) {
    await rhodium.im.inject("q", { chat: ME, sender: ME, text });
    expect((await posts(n))[n - 1]!.text).toContain("明天 09:05 恢复");
  }
}, 30_000);

test("stories 128, 129: a message sent while the slot waits is queued, the reply says when it resumes, and at the reset it goes in in place of 继续", async () => {
  await slotA();
  const resetsAt = outOfQuota(2);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await posts(1);
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "later" });
  const [, queued] = await posts(2);
  expect(queued!.text).toBe(`w/a 在等 Claude 额度，${clock(resetsAt)} 恢复。这条先存着，到时交给它。`);
  expect(told()).toEqual(["work"]);

  const [, , reply] = await posts(3);
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  expect(reply!.text).toBe("fake reply");
  expect(told()).toEqual(["work", "later"]);
}, 30_000);

test("story 129: at the reset with nothing queued, the slot is told 继续, and the turn's reply comes to you", async () => {
  await slotA();
  const resetsAt = outOfQuota(2);
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [, reply] = await posts(2);
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  expect(reply).toMatchObject({ text: "fake reply", replyTo: messageId });
  expect(told()).toEqual(["work", "继续"]);
  const frames = rhodium.claude.runs()[0]!.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user");
  expect(frames[1].origin).toBeUndefined(); // Rhodium's, not yours
  expect(rhodium.claude.runs()).toHaveLength(1); // the agent waited all along
}, 30_000);

test("story 130: three slots waiting at once carry on staggered over quotaStagger, not all at the reset", async () => {
  const bots = { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" }, qc: { like: "qq", owner: ME, target: "w/c" } } as const;
  rhodium = newInstance({ bots, toml: `${NOW}\nquotaStagger = "2s"` });
  await rhodium.start();
  await rhodium.slots("a", "b", "c");
  const resetsAt = outOfQuota(2);
  for (const bot of ["q", "qb", "qc"]) await rhodium.im.inject(bot, { chat: ME, sender: ME, text: "work" });
  // Each one's notice that it waits: it stays, where the waiting state is over at its reset.
  const notices = await Promise.all(["q", "qb", "qc"].map((bot) => posts(1, bot)));
  for (const [notice] of notices) expect(notice!.text).toContain("用完了 Claude 额度");

  // When each was told 继续.
  const at: Record<string, number> = {};
  await until(() => {
    for (const ref of ["w/a", "w/b", "w/c"]) if (!at[ref] && told(ref).includes("继续")) at[ref] = Date.now();
    return Object.keys(at).length === 3;
  }, 15_000);
  const times = Object.values(at).sort((x, y) => x - y);
  expect(times[0]!).toBeGreaterThanOrEqual(resetsAt * 1000);
  // 0, 1 and 2 s after the reset, as seen here: a second apart, give or take what a busy machine adds.
  expect(times[1]! - times[0]!).toBeGreaterThan(400);
  expect(times[2]! - times[1]!).toBeGreaterThan(400);
  expect(times[2]! - times[0]!).toBeLessThan(4000);
}, 30_000);

test("slots that run out of Claude's quota together are told of in one notice in their chat, which names them all (2026-10-21)", async () => {
  // w/b and w/c have no chat of their own: theirs is the main chat, as w/a's is.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `mainChat = "q/${ME}"\n[durations]\nquotaNotice = "3s"` });
  await rhodium.start();
  await rhodium.slots("a", "b", "c");
  await rhodium.ok("set", "w/c", "auto-continue=off");
  const resetsAt = outOfQuota(30);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await rhodium.ok("send", "w/b", "work");
  await rhodium.ok("send", "w/c", "work");
  const [notice] = await posts(1);
  expect(notice!.text).toMatch(new RegExp(`^Claude 额度用完了，${clock(resetsAt)} 恢复（还有 \\d+ 秒）。\n在等的：w/a、w/b、w/c。\n到时它们自己接着做。这之间发给它们的消息先存着，到时一起交给它们。\nw/c 到时不会自己接着做，要你发一条消息。$`));
  await Bun.sleep(500); // another notice would show up by now
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
}, 30_000);

test("story 131: with auto-continue off for the slot, nothing goes in at the reset; it is idle, and your next message goes in", async () => {
  await slotA();
  await rhodium.ok("set", "w/a", "auto-continue=off");
  const resetsAt = outOfQuota(2);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [notice] = await posts(1);
  expect(notice!.text).toContain("\n到时不会自己接着做，要你发一条消息。");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  await Bun.sleep(500);
  expect(told()).toEqual(["work"]);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "now" });
  expect((await posts(2))[1]!.text).toBe("fake reply");
  expect(told()).toEqual(["work", "now"]);
}, 30_000);

test("the quota clock lives through a restart of rhodium: 继续 still goes in at the reset", async () => {
  await slotA();
  outOfQuota(3);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await posts(1);
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.kill9();
  await rhodium.start();
  expect((await posts(2))[1]!.text).toBe("fake reply");
  expect(told()).toEqual(["work", "继续"]);
}, 30_000);

test("a quota notice still waiting for other slots to run out goes at once after a restart of rhodium", async () => {
  await slotA({ toml: '[durations]\nquotaNotice = "1h"' });
  outOfQuota(30);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  expect(await rhodium.im.log("q", ME)).toEqual([]);
  await rhodium.kill9();
  await rhodium.start();
  expect((await posts(1))[0]!.text).toStartWith("w/a 用完了 Claude 额度");
}, 30_000);

test("Claude starting a turn by itself while the slot waits, say for a background task, means the quota is back: the wait ends, and its reply comes to you", async () => {
  await slotA();
  outOfQuota(30, 1000);
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [, reply] = await posts(2);
  expect(reply).toMatchObject({ text: "woke", replyTo: messageId });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  // Not waiting any more: your next message goes in at once.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "now" });
  expect((await posts(3))[2]!.text).toBe("fake reply");
  expect(told()).toEqual(["work", "now"]);
}, 30_000);

test("/new while the slot waits: what was queued for the reset stays with that conversation, and goes in once you go back to it", async () => {
  await slotA();
  outOfQuota(30);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await posts(1);
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "later" });
  await posts(2);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/new" });
  await posts(3);
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/resume 1" });
  expect((await posts(4))[3]!.text).toStartWith("已回到");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => told().length === 3, 15_000);
  expect(told()).toEqual(["work", "later", "again"]);
  // Its new claude refuses the first and runs the second: done with, before the test ends.
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
}, 30_000);

test("/stop while the slot waits stops the turn carrying on: no 继续 at the reset, and the slot is idle", async () => {
  await slotA();
  const resetsAt = outOfQuota(2);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await posts(1);
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/stop" });
  expect((await posts(2))[1]!.text).toBe("已停下这一回合，对话留着。");

  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  await Bun.sleep(500);
  expect(told()).toEqual(["work"]);
}, 30_000);

test("the agent crashes while the slot waits: no turn was lost, it starts again still waiting, and what was queued goes in at the reset", async () => {
  await slotA();
  const resetsAt = outOfQuota(3);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await posts(1);
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "later" });
  await posts(2);

  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  const [, , notice] = await posts(3);
  expect(notice!.text).toStartWith("w/a 崩溃了。\n还在等 Claude 额度，已经重新启动，");
  await until(() => rhodium.claude.runs().length === 2, 15_000);
  expect(await rhodium.state("w/a")).toBe("等额度");

  await until(() => told().length === 2, 15_000);
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  expect(told()).toEqual(["work", "later"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
}, 30_000);

test("/stop while the slot waits after the refused turn used rh send me: your next message, queued for the reset, still gets its final reply", async () => {
  await slotA();
  outOfQuota(4, undefined, [{ rh: ["send", "me", "on it"] }]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  expect((await posts(2))[0]!.text).toBe("on it");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/stop" });
  expect((await posts(3))[2]!.text).toBe("已停下这一回合，对话留着。");
  const later = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "later" });
  expect((await posts(4))[3]!.text).toStartWith("w/a 在等 Claude 额度，");

  // The send me was the stopped turn's: this one used none, so its reply comes, and is on record.
  expect((await posts(5))[4]).toMatchObject({ text: "fake reply", replyTo: later.messageId });
  expect(told()).toEqual(["work", "later"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await rhodium.ok("trace", later.messageId)).toMatch(/^ {2}.* final_reply w\/a$/m);
}, 30_000);

test("! while a turn that used rh send me runs, then the turn is refused for quota: your message, queued for the reset, still gets its final reply", async () => {
  await slotA();
  outOfQuota(4, undefined, [{ rh: ["send", "me", "on it"] }, { sleep: 1500 }]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  expect((await posts(1))[0]!.text).toBe("on it");
  const later = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "!later" });
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  expect((await posts(2))[1]!.text).toContain("用完了 Claude 额度");

  // The send me was the interrupted turn's: this one used none, so its reply comes, and is on record.
  expect((await posts(3))[2]).toMatchObject({ text: "fake reply", replyTo: later.messageId });
  expect(told()).toEqual(["work", "later"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await rhodium.ok("trace", later.messageId)).toMatch(/^ {2}.* final_reply w\/a$/m);
}, 30_000);

test("#234: your message while the slot waits, after the refused turn used rh send me, lifts it: at the reset the turn carries on with it, and its final reply comes", async () => {
  await slotA();
  outOfQuota(3, undefined, [{ rh: ["send", "me", "on it"] }]);
  const work = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "等额度", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "later" });
  expect((await posts(3))[2]!.text).toStartWith("w/a 在等 Claude 额度，");

  // It is still the turn your first message began: the reply answers that one.
  expect((await posts(4))[3]).toMatchObject({ text: "fake reply", replyTo: work.messageId });
  expect(told()).toEqual(["work", "later"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await rhodium.ok("trace", work.messageId)).toMatch(/^ {2}.* final_reply w\/a$/m);
}, 30_000);
