// Messages between slots (stories 46, 90-92, 95, 96): rh send, rh read and a child's reports to its
// parent, seen from seam one. The fake claude does what its message says, as in rh-spawn.test.ts:
// the message is a list of rh calls. Children that must take their time are fake pis.
import { afterEach, expect, test } from "bun:test";
import type { Run, Script } from "./fake-agent/fake-agent";
import { asking, builtins, compaction, endTurn, joinTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";
import { REPORT_LINE, sourceLine } from "../src/prompt";

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
/** A message that has the agent make these rh calls, in order. */
const plan = (...calls: string[][]) => JSON.stringify(calls);

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** An instance whose bot q goes to w/a, with w at <dir>/w; started, with the slot w/a made. */
async function begin(opts: InstanceOptions = {}): Promise<Instance> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey }, ...opts });
  await rhodium.start();
  await rhodium.slots("a");
  return rhodium;
}

/** The slot's latest claude run, once it has been given a message. */
async function runOf(ref: string): Promise<Run> {
  const find = () => rhodium.claude.runs().findLast((r) => r.env.RHODIUM_SLOT === ref && r.stdin.some((l) => JSON.parse(l).type === "user"));
  await until(() => find() !== undefined, 15_000);
  return find()!;
}

/** The user frames written to the slot's claude runs, oldest first. */
const frames = (ref: string) =>
  rhodium.claude
    .runs()
    .filter((r) => r.env.RHODIUM_SLOT === ref)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"));
const told = (ref: string) => frames(ref).map((m) => withoutSource(m.message.content[0].text) as string);

/** The texts the bot has posted to you, once there are at least n. */
async function texts(n: number, bot = "q"): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return (await rhodium.im.log(bot, ME)).map((p) => p.text);
}

test("story 46: a child you never messaged sends rh send me to its root slot's chat, from any depth, led by its name as that chat goes to another slot", async () => {
  await begin();
  const leaf = plan(["send", "me", "from c2"]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", plan(["spawn", "c2", leaf])]) });
  expect(await texts(2)).toContain("〔w/c2〕\nfrom c2");
  await until(async () => (await runOf("w/c2")).rh.length > 0, 15_000);
  expect((await runOf("w/c2")).rh).toMatchObject([{ args: ["send", "me", "from c2"], code: 0 }]);
}, 30_000);

test("story 90: a child's report reaches its parent once the child is done; with a background task running it waits for the turn that task wakes", async () => {
  // Each turn runs its rh calls, starts a background task and ends with "started"; the task then
  // wakes the session for a turn ending with "background task done".
  const bg = builtins.background!.steps;
  await begin({ claude: { script: { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...bg.slice(startTurn.length)] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "do it"]) });

  await until(() => frames("w/a").length >= 2, 15_000);
  await Bun.sleep(500); // no second report comes
  const [, report, ...more] = frames("w/a");
  expect(more).toEqual([]);
  const text = report.message.content[0].text as string;
  expect(text).toContain("w/c");
  expect(text).toContain("完成");
  expect(text).toContain("background task done");
  expect(text).not.toContain("started");
  // Not from you.
  expect(report.origin).toBeUndefined();
}, 30_000);

/** The reports the slot's agent was given, oldest first. */
const reports = (ref: string) => frames(ref).map((m) => m.message.content[0].text as string).filter((t) => t.startsWith("[来自 Rhodium：子槽位汇报]"));

/** Bots q, qb and qc go to w/a, w/b and w/c, at most two slots run, and every pi asks. */
const limited: InstanceOptions = {
  toml: "[limits]\nmaxRunning = 2",
  pi: { script: "pi-ask" },
  bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" }, qc: { like: "qq", owner: ME, target: "w/c" } },
};

/**
 * w/a spawns the pi w/c, which asks and so reports it is stuck. Then w/a is stopped, your message
 * starts w/b, and you answer w/c: it is done with two slots running, so its report waits for room.
 */
async function reportAtTheLimit(): Promise<void> {
  await begin(limited);
  await rhodium.ok("new", "w/b");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(() => reports("w/a").length === 1, 15_000);
  expect(reports("w/a")[0]).toContain("w/c 卡住了");
  expect(reports("w/a")[0]).toContain("echo hi");
  await until(async () => (await texts(1)).some((t) => t.includes("允许吗？")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "hello" });
  expect(await texts(1, "qb")).toEqual(["done"]);
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "1" });
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(reports("w/a")).toHaveLength(1);
}

test("story 90: your /compact on a child is no work of its own: the parent is not woken for it", async () => {
  // Each claude runs the rh calls its first message lists and ends with "done"; its next message
  // is a /compact. The parent's, the child's report, is compacted too, which matters to no one.
  const script: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), ...compaction()] };
  await begin({ claude: { script }, bots: { q: { like: "qq", owner: ME, target: "w/a" }, qc: { like: "qq", owner: ME, target: "w/c" } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "do it"]) });
  await until(() => reports("w/a").length === 1, 15_000);
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);

  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "/compact" });
  expect(await texts(1, "qc")).toEqual(["已压缩上下文，从约 80k tokens 减到约 12k tokens。"]);
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  await Bun.sleep(500);
  expect(reports("w/a")).toHaveLength(1);
}, 30_000);

test("a child a chat of yours points at (/rh_use) reports neither done nor stuck to its parent; pointed elsewhere, it reports again", async () => {
  await begin({ pi: { script: "pi-ask" }, bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(() => reports("w/a").length === 1, 15_000); // stuck, before any chat points at it
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const say = async (text: string, then: (t: string) => boolean) => {
    await rhodium.im.inject("t", { chat: ME, sender: ME, text });
    await until(async () => (await rhodium.im.log("t", ME)).some((p) => then(p.text)), 15_000);
  };
  const idle = async () => {
    await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
    await Bun.sleep(500);
  };

  // In t you answer its ask, so it is done; then you give it more, so it asks again: stuck.
  await say("/rh_use c", (t) => t.includes("w/c"));
  await say("1", (t) => t === "已允许运行这条命令。");
  await idle();
  await say("more", (t) => t.startsWith("要运行这条命令，允许吗？"));
  await Bun.sleep(500);
  expect(reports("w/a")).toHaveLength(1);
  await say("2", (t) => t === "已拒绝。");
  await idle();
  expect(reports("w/a")).toHaveLength(1);

  // Once t points elsewhere, it reports as before.
  await say("/rh_use a", (t) => t.includes("w/a"));
  await rhodium.ok("send", "w/c", "again");
  await until(() => reports("w/a").length === 2, 15_000);
  expect(reports("w/a")[1]).toContain("w/c 卡住了");
}, 45_000);

test("stories 90, 101: a child with an ask open reports it is stuck; done at the running limit, its report waits until a slot stops", async () => {
  await reportAtTheLimit();
  await rhodium.ok("stop", "w/b");
  await until(() => reports("w/a").length === 2, 15_000);
  expect(reports("w/a")[1]).toContain("w/c 完成了");
  expect(reports("w/a")[1]).toContain("fake reply");
}, 45_000);

test("story 101: after rh stop --all a report waiting for room starts no slot; it goes in with the slot's next start", async () => {
  await reportAtTheLimit();
  await rhodium.ok("stop", "--all");
  await until(async () => (await rhodium.state("w/b")) === "未运行" && (await rhodium.state("w/c")) === "未运行", 15_000);
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(reports("w/a")).toHaveLength(1);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello again" });
  // The report and your message reach the agent one after the other.
  await until(() => reports("w/a").length === 2 && told("w/a").includes("hello again"), 15_000);
  expect(reports("w/a")[1]).toContain("w/c 完成了");
}, 45_000);

test("story 90: a child that crashes, with nothing to resume it, reports it is stuck", async () => {
  await begin({ pi: { script: { steps: [{ wait: { type: "prompt" } }, { exit: 1 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(() => reports("w/a").length === 1, 15_000);
  expect(reports("w/a")[0]).toContain("w/c 卡住了");
  expect(reports("w/a")[0]).toContain("崩溃");
  expect(await rhodium.state("w/c")).toBe("崩溃");
}, 30_000);

test("story 90: a report to a parent whose ask waits for you is no answer to it: it goes in once you have answered", async () => {
  // w/a asks once it has made its rh calls; its child is a pi that takes 0.5 s.
  const askAfter: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...asking([["perm-1", "Bash", { command: "ls" }]]).steps.slice(startTurn.length)] };
  const slow = builtins["pi-slow"]!;
  await begin({ claude: { script: askAfter }, pi: { script: { ...slow, steps: slow.steps.map((s) => ("sleep" in s ? { sleep: 500 } : s)) } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.includes("允许吗？")), 15_000);
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  await Bun.sleep(500);
  expect(reports("w/a")).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("需要你");

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "1" });
  await until(() => reports("w/a").length === 1, 15_000);
  expect(reports("w/a")[0]).toContain("w/c 完成了");
  // Your answer went to the ask, before the report.
  const a = await runOf("w/a");
  const answer = a.stdin.findIndex((l) => JSON.parse(l).type === "control_response");
  const report = a.stdin.findIndex((l) => l.includes("子槽位汇报"));
  expect(answer).toBeGreaterThan(-1);
  expect(report).toBeGreaterThan(answer);
}, 30_000);

test("stories 90, 95: a confirm request holds up no turn: with one open, reports and rh send go in at once, and so does your decision", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } } });
  await rhodium.ok("new", "w/b");
  await rhodium.ok("new", "w/x");
  // w/x is not w/a's descendant: archiving it is a confirm request, hung on w/a.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["archive", "w/x"], ["spawn", "c", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.includes("命令：rh archive w/x")), 15_000);
  await until(() => reports("w/a").length === 1, 15_000);
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: plan(["send", "w/a", "from b"]) });
  await until(() => told("w/a").includes("from b"), 15_000);
  expect(await rhodium.ok("ls", "w/x")).toMatch(/^状态: 未运行$/m); // nobody answered it yet

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "2" });
  await until(() => told("w/a").includes("用户拒绝了你的确认请求：rh archive w/x 没有执行。"), 15_000);
  // Nothing is left holding up what comes next.
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => told("w/a").includes("hello"), 15_000);
}, 45_000);

/** The prompts written to the slot's pi runs, oldest first. */
const prompts = (ref: string) =>
  rhodium.pi
    .runs()
    .filter((r) => r.env.RHODIUM_SLOT === ref)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "prompt"));

test("stories 92, 95: rh send from any slot to another joins the turn it is running, as a message not from you", async () => {
  await begin({ pi: { script: "pi-until-steered" }, bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } } });
  await rhodium.ok("new", "w/b");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(async () => (await rhodium.state("w/c")) === "运行中", 15_000);

  // w/b is not w/c's parent.
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: plan(["send", "w/c", "change of plan:", "-", "use v2"]) });
  await until(() => prompts("w/c").length === 2, 15_000);
  const [, steer] = prompts("w/c");
  expect(steer).toMatchObject({ streamingBehavior: "steer", message: "[来自 槽位 w/b，经 rh send]\nchange of plan: - use v2" });
  await until(async () => (await runOf("w/b")).rh.length > 0, 15_000); // logged once rh has exited, maybe after the steer
  expect((await runOf("w/b")).rh).toMatchObject([{ args: ["send", "w/c", "change of plan:", "-", "use v2"], code: 0 }]);
  // One run: the instruction joined it, and it ends with it.
  await until(() => reports("w/a").length === 1, 15_000);
  expect(reports("w/a")[0]).toContain("steered");
  expect(rhodium.pi.runs().filter((r) => r.env.RHODIUM_SLOT === "w/c")).toHaveLength(1);

  // Idle, it takes the next one as a new turn, and is done again.
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: plan(["send", "w/c", "one more thing"]) });
  await until(() => reports("w/a").length === 2, 15_000);
  expect(prompts("w/c")[2]).toMatchObject({ message: "[来自 槽位 w/b，经 rh send]\none more thing" });
  expect(prompts("w/c")[2].streamingBehavior).toBeUndefined();
  expect(reports("w/a")[1]).toContain("w/c 完成了");
}, 30_000);

test("story 37: an rh send waiting for the end of the turn you began holds back no message of yours: that joins the turn, whose reply comes back to you", async () => {
  // The first turn ends only once a second message has reached it; every turn after takes one.
  const twoInOne: Script = { on, steps: [...startTurn, ...joinTurn, ...endTurn("both read"), ...startTurn, ...endTurn("noted"), { goto: 8 }] };
  await begin({ claude: { script: twoInOne } });
  const first = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.ok("send", "w/a", "from you"); // waits for the turn to end
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });

  await until(() => told("w/a").length === 3, 15_000);
  expect(told("w/a")).toEqual(["first", "second", "from you"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(300);
  // The rh send's turn is one of its own: its reply is not taken for one to you.
  expect((await rhodium.im.log("q", ME)).map((p) => [p.text, p.replyTo])).toEqual([["both read", first.messageId]]);
}, 30_000);

test("story 101: an agent's rh send wakes a stopped slot under the running limit; at it the call is refused and you are told", async () => {
  await begin({ toml: "[limits]\nmaxRunning = 2" });
  await rhodium.ok("new", "w/b");
  await rhodium.ok("new", "w/c");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["send", "w/b", "wake up"], ["send", "w/c", "you too"]) });

  const [notice, reply] = await texts(2);
  expect(reply).toBe("done");
  expect(notice).toContain("w/a");
  expect(notice).toContain("w/c");
  expect(notice).toContain("同时运行的无头槽位已到上限 2 个");
  const [woke, refused] = (await runOf("w/a")).rh;
  expect(woke!.code).toBe(0);
  expect([refused!.code, refused!.err]).toEqual([1, expect.stringContaining("上限")]);

  await until(() => frames("w/b").length === 1, 15_000);
  const [frame] = frames("w/b");
  expect(frame.message.content[0].text).toBe("[来自 槽位 w/a，经 rh send]\nwake up");
  expect(frame.origin).toBeUndefined();
  expect(await rhodium.state("w/c")).toBe("未运行");
}, 30_000);

test("story 101: your rh send from a terminal is your message: it wakes a stopped slot past the running limit, saying it came from your terminal", async () => {
  await begin({ toml: "[limits]\nmaxRunning = 1" });
  await rhodium.ok("new", "w/b");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  expect(await texts(1)).toEqual(["done"]); // w/a holds the one place

  expect(await rhodium.ok("send", "w/b", "from", "you")).toBe("已发给 w/b。\n");
  await until(() => frames("w/b").length === 1, 15_000);
  expect(frames("w/b")[0].message.content[0].text).toBe("[来自 用户的终端，经 rh send]\nfrom you");
  expect(await rhodium.state("w/a")).toBe("空闲");
}, 30_000);

test("story 38: a message held for an ask that a ! message withdraws then waits for the interrupt, as your message does", async () => {
  await begin({ claude: { script: "ask-until-interrupted" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "需要你", 15_000);
  expect(await rhodium.ok("send", "w/a", "later")).toBe("已发给 w/a。它有提问在等用户回答，答完再交给它。\n");

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "!never mind" });
  // The ask is withdrawn at once, and the turn ends a second later.
  await until(() => told("w/a").length === 3, 15_000);
  expect(told("w/a")).toEqual(["work", "later", "never mind"]);
  // later went in once the turn had ended, not once the ask was withdrawn. The script marks the end
  // in the agent's input: Rhodium's error answer to the control request it sends right before.
  const input = (await runOf("w/a")).stdin.map((l) => JSON.parse(l));
  const ended = input.findIndex((m) => m.response?.request_id === "fake-turn-end");
  const later = input.findIndex((m) => m.type === "user" && withoutSource(m.message.content[0].text) === "later");
  expect(ended).toBeGreaterThan(-1);
  expect(later).toBeGreaterThan(ended);
}, 30_000);

for (const [stop, again] of [["w/a", true], ["--all", false]] as const) {
  test(`rh send to a slot rh stop ${stop} is still stopping ${again ? "starts it again once it has exited" : "waits for its next start: the emergency stop starts nothing"}`, async () => {
    // After each turn the agent reads nothing for 5 s, so stopping it takes stopGrace and TERM.
    const lazy: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { sleep: 5000 }, { goto: 0 }] };
    await begin({ claude: { script: lazy }, toml: '[durations]\nstopGrace = "1500ms"', bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } } });
    await rhodium.ok("new", "w/b");
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
    await texts(1);

    await rhodium.ok("stop", stop);
    await rhodium.im.inject("qb", { chat: ME, sender: ME, text: plan(["send", "w/a", "from b"]) });
    await until(async () => (await runOf("w/b")).rh.length === 1, 15_000);
    expect(await rhodium.state("w/a")).not.toBe("未运行"); // it came while w/a was stopping
    if (again) {
      await until(() => frames("w/a").length === 2, 15_000);
      expect(frames("w/a")[1].message.content[0].text).toBe("[来自 槽位 w/b，经 rh send]\nfrom b");
    } else {
      await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
      await Bun.sleep(500);
      expect(await rhodium.state("w/a")).toBe("未运行");
      await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello again" });
      await until(() => told("w/a").includes("hello again"), 15_000);
      expect(told("w/a")).toContain("from b");
    }
  }, 30_000);
}

test("stories 91, 95: rh read shows any slot's state and its recent conversation, Claude's or pi's", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } } });
  await rhodium.ok("new", "w/b");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(() => reports("w/a").length === 1, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  // w/b reads w/c, which is not its child.
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: plan(["read", "w/c"]) });
  await until(async () => (await runOf("w/b")).rh.length === 1, 15_000);
  const [read] = (await runOf("w/b")).rh;
  expect(read!.code).toBe(0);
  expect(read!.out).toMatch(/^槽位: w\/c$/m);
  expect(read!.out).toMatch(/^状态: 空闲$/m);
  expect(read!.out).toMatch(/^父槽位: w\/a$/m);
  expect(read!.out).toMatch(/do it[\s\S]*fake reply/);

  // What it was told keeps the line saying where that came from: you, or its child's report.
  const a = await rhodium.ok("read", "w/a");
  expect(a).toMatch(/^状态: 空闲$/m);
  const yours = `收到：${sourceLine("假 IM Bot q 的私聊")} ${plan(["spawn", "c", "--agent", "pi", "do it"])}`;
  const report = `收到：${REPORT_LINE} 子槽位 w/c 完成了`;
  expect(a).toContain(yours);
  expect(a).toContain(report);
  expect(a.indexOf(report)).toBeGreaterThan(a.indexOf(yours));
}, 30_000);

test("story 96: once its parent is archived, a child's done and stuck come to you, for you to decide", async () => {
  await begin(limited);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.includes("允许吗？")), 15_000);
  await until(() => reports("w/a").length === 1, 15_000);
  await rhodium.ok("bind", "q", "w/c"); // a bot's default target is not archived
  await rhodium.ok("archive", "w/a");

  const notices = async () => (await rhodium.im.log("qc", ME)).map((p) => p.text).filter((t) => t.includes("需要你拿主意"));
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "1" });
  await until(async () => (await notices()).length === 1, 15_000);
  expect((await notices())[0]).toContain("w/c 完成了");
  // Its next run asks again: stuck.
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "once more" });
  await until(async () => (await notices()).length === 2, 15_000);
  expect((await notices())[1]).toContain("w/c 卡住了");

  expect(reports("w/a")).toHaveLength(1);
  expect(await rhodium.ok("ls", "w/a")).toMatch(/^状态: 未运行（已归档）$/m);
}, 45_000);
