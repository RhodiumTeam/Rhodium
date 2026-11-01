// Commands in IM, steering and interrupting (seam one): /rh_x is Rhodium's, the ten common commands
// become driver operations, any other /x goes to the agent as typed (product §5.6); a message
// mid-turn joins the turn, and one starting with ! interrupts it first (product §5.3).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { resetText } from "../src/im-commands";
import { sourceLine } from "../src/prompt";
import { compaction, endTurn, on, startTurn, state as session } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

// rhodium inherits it, and shows /usage's reset times in it.
process.env.TZ = "Etc/GMT-9";

const FIXTURES = join(import.meta.dir, "fixtures/claude");
/** A reset as /usage tells it, relative to now as the reply is: im-commands.test.ts pins the wording. */
const when = (at: number) => resetText(at, Date.now());
const ME = "you-openid";
/** The first line of your messages through bot q (architecture §6.1), for the recordings made without it. */
const VIA = sourceLine("假 IM 私聊");

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

async function ok(...args: string[]): Promise<string> {
  const r = await rhodium.rh(args);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  return r.out;
}

/** A rhodium whose bot q sends your private chat to the slot w/a, in its own directory. Its lists
 *  come numbered, as on QQ when there are too many for buttons (buttons.test.ts has the buttons). */
async function slot(opts: InstanceOptions = {}, agent = "claude"): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a", buttons: "false" } }, ...opts });
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await ok("ws", "w", dir);
  await ok("new", "w/a", "--agent", agent);
  return dir;
}

const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const state = async () => (await ok("ls")).match(/^w\/a +\S+ +\S+ +(\S+)/m)?.[1];

/** Waits until the bot has posted n messages in your chat, and returns them. */
async function posts(n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

test("stories 52, 53, 149: /rh_x and /rh-x are Rhodium's; one it does not know is said to be no command, and restarts nothing", async () => {
  await slot();
  await say("/rh_restart");
  await say("/rh-restart now");
  expect((await posts(2)).map((p) => p.text)).toEqual([
    "没有 /rh_restart 这个命令，发 /rh_help 看有哪些。",
    "没有 /rh-restart 这个命令，发 /rh_help 看有哪些。",
  ]);
  // Neither reached an agent, and the rhodium that answered is still the one running.
  expect(rhodium.claude.runs()).toEqual([]);
  expect(await state()).toBe("未运行");
}, 30_000);

/** The messages the fake agent got, per run: Claude's user frames, pi's prompts. */
const asked = (agent: "claude" | "pi" = "claude") =>
  rhodium[agent].runs().map((r) =>
    r.stdin
      .map((l) => JSON.parse(l))
      .filter((m) => m.type === "user" || m.type === "prompt")
      .map((m) => withoutSource(m.type === "prompt" ? m.message : m.message.content[0].text)),
  );

test("story 61: a /x that is neither Rhodium's nor a common command reaches the agent as typed", async () => {
  await slot();
  await say("/btw what are you working on?");
  expect((await posts()).map((p) => p.text)).toEqual(["fake reply"]);
  expect(asked()).toEqual([["/btw what are you working on?"]]);
}, 30_000);

const sessionOf = (argv: string[]) => argv.find((a) => a.startsWith("--session-id="))?.split("=")[1];

test("story 9: after /new the next message starts a new conversation, without the old context", async () => {
  await slot();
  await say("first");
  await posts(1);
  const fresh = await say("/new");
  expect((await posts(2))[1]).toMatchObject({ text: "已开一段新对话。", replyTo: fresh.messageId });

  await say("second");
  expect((await posts(3))[2]!.text).toBe("fake reply");
  // A new claude with a session id of its own, not --resume of the old one, which /new closed.
  expect(asked()).toEqual([["first"], ["second"]]);
  const [old, now] = rhodium.claude.runs();
  expect(now!.argv.filter((a) => a.startsWith("--resume"))).toEqual([]);
  expect(sessionOf(now!.argv)).toBeString();
  expect(sessionOf(now!.argv)).not.toBe(sessionOf(old!.argv));
}, 30_000);

test("story 55: a message sent after /stop, before the stopped turn has ended, runs next and its reply comes back", async () => {
  // This claude takes 300 ms to end the turn after the interrupt.
  await slot({ claude: { script: "until-interrupted" } });
  await say("Count to a million.");
  await until(async () => (await state()) === "运行中", 15_000);
  await say("/stop");
  await posts(1);
  const next = await say("And now?");
  const [, reply] = await posts(2);
  expect(reply).toMatchObject({ text: "fake reply", replyTo: next.messageId });
  expect(asked()).toEqual([["Count to a million.", "And now?"]]);
}, 30_000);

test("a message sent after a ! message, before the interrupted turn has ended, goes in after it", async () => {
  await slot({ claude: { script: "until-interrupted" } });
  await say("Count to a million.");
  await until(async () => (await state()) === "运行中", 15_000);
  const bang = await say("!foo");
  await say("bar");
  await until(() => asked()[0]!.length === 3, 15_000);
  expect(asked()).toEqual([["Count to a million.", "foo", "bar"]]);
  // The turn foo starts is foo's; this claude runs bar as a turn of its own, which no chat started.
  expect((await posts())[0]).toMatchObject({ text: "fake reply", replyTo: bang.messageId });
}, 30_000);

test("a ! message, then /new before the interrupted turn has ended: back on that conversation with /resume, the ! message goes in first and the next one follows", async () => {
  await slot({ claude: { script: "until-interrupted" } });
  await say("Count to a million.");
  await until(async () => (await state()) === "运行中", 15_000);
  await say("!foo");
  await say("/new");
  await posts(1);
  await say("/resume 1");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.startsWith("已回到")), 15_000);
  await say("hello");
  await until(() => asked().length === 2 && asked()[1]!.length === 2, 15_000).catch(() => {});
  expect(asked()).toEqual([["Count to a million."], ["foo", "hello"]]);
}, 30_000);

test("/stop after a ! message, before the interrupted turn has ended, leaves the ! message to run and reply", async () => {
  await slot({ claude: { script: "until-interrupted" } });
  await say("Count to a million.");
  await until(async () => (await state()) === "运行中", 15_000);
  const bang = await say("!foo");
  const stop = await say("/stop");
  const [stopped, reply, ...more] = await posts(2);
  expect(stopped).toMatchObject({ text: "已停下这一回合，对话留着。", replyTo: stop.messageId });
  expect(reply).toMatchObject({ text: "fake reply", replyTo: bang.messageId });
  expect(more).toEqual([]);
  expect(asked()).toEqual([["Count to a million.", "foo"]]);
}, 30_000);

test("story 37: a message sent while the turn runs joins that turn", async () => {
  // The recording holds the turn open until the second message reaches the agent.
  await slot({ claude: { replay: join(FIXTURES, "mid-turn-message"), sourceLines: [VIA, VIA] } });
  const first = await say("Count from 1 to 40, one number per line, nothing else.");
  await until(async () => (await state()) === "运行中", 15_000);
  await say("Also, after the last number, write the word DONE.");
  // What it said before your second message, then its final reply (story 70).
  const [said, reply, ...more] = await posts(2);
  expect(said!.text).toMatch(/^1\n2\n.*\n40$/s);
  expect(reply).toMatchObject({ replyTo: first.messageId });
  expect(reply!.text).toMatch(/^1\n2\n.*\n40\nDONE$/s);
  expect(more).toEqual([]);
}, 30_000);

test("#129: a message that reaches Claude just as its turn ends runs as the next turn, and its reply comes back", async () => {
  // This claude holds its idle line back until the second message reaches it, as when that line is
  // still on its way to Rhodium: it went idle before reading the message, so it runs it as a new turn.
  const steps = [...startTurn, { wait: { type: "user" } }, ...endTurn("reply to first"), { emit: [session("running")] }, ...endTurn("reply to second")];
  await slot({ claude: { script: { on, steps } } });
  const first = await say("first");
  await until(async () => (await state()) === "运行中", 15_000);
  const second = await say("second");
  const [a, b, ...more] = await posts(2);
  expect(a).toMatchObject({ text: "reply to first", replyTo: first.messageId });
  expect(b).toMatchObject({ text: "reply to second", replyTo: second.messageId });
  expect(more).toEqual([]);
}, 30_000);

test("#129: the same on pi: a message that reaches pi just as its run settles runs as the next turn, and its reply comes back", async () => {
  await slot({ pi: { script: "pi-steered-late" } }, "pi");
  const first = await say("first");
  await until(async () => (await state()) === "运行中", 15_000);
  const second = await say("second");
  const [a, b, ...more] = await posts(2);
  expect(a).toMatchObject({ text: "reply to first", replyTo: first.messageId });
  expect(b).toMatchObject({ text: "reply to second", replyTo: second.messageId });
  expect(more).toEqual([]);
}, 30_000);

// A phone keyboard's full-width ！ counts too (product §5.3).
test.each(["!", "！"])("story 38: a message starting with %s interrupts the turn, then goes in as the next turn, and the reply comes back to it", async (bang) => {
  // The recording: the turn waits on an approval, the interrupt withdraws it, the turn ends, and
  // only then is the new message written. The replayer fails on any other order or text.
  await slot({ claude: { replay: join(FIXTURES, "interrupt-pending-approval"), sourceLines: [VIA, VIA] } });
  await say("Use the Bash tool to run exactly: touch c.txt");
  await until(async () => (await state()) === "需要你", 15_000); // the approval is open
  const sent = await say(`${bang}Never mind that. Reply with exactly: OK`);

  // The interrupted turn said nothing but its approval, and sends nothing; the reply is the new
  // turn's. The ! message interrupted rather than answered (product §5.3).
  const [ask, reply, ...more] = await posts(2);
  expect(ask!.text).toStartWith("要运行这条命令，允许吗？\n\ntouch c.txt\n");
  expect(reply).toMatchObject({ text: "OK", replyTo: sent.messageId });
  expect(more).toEqual([]);
  expect(await state()).toBe("空闲");
}, 30_000);

test("a ! message held for its interrupt is not lost when the agent dies first: the next start writes it", async () => {
  // This claude starts a turn, then dies on the interrupt instead of ending the turn.
  const running = JSON.stringify({ type: "system", subtype: "session_state_changed", state: "running" });
  await slot({ claude: { script: { steps: [{ wait: { type: "user" } }, { emit: [running] }, { wait: { type: "control_request", request: { subtype: "interrupt" } } }, { exit: 1 }] } } });
  await say("first");
  await until(async () => (await state()) === "运行中", 15_000);
  await say("!second");
  await until(async () => (await state()) === "崩溃", 15_000);
  await say("third");
  await until(() => asked().length === 2 && asked()[1]!.length === 2, 15_000);
  expect(asked()).toEqual([["first"], ["second", "third"]]);
}, 30_000);

test("/new and /stop while the agent is still starting say to try again, and leave it starting", async () => {
  // This claude never reports a turn, so the slot stays starting.
  await slot({ claude: { script: { steps: [{ wait: { type: "never" } }] } } });
  await say("hello");
  await until(async () => (await state()) === "启动中", 15_000);
  await say("/new");
  await say("/stop");
  expect((await posts(2)).map((p) => p.text)).toEqual(["w/a 还在启动，过几秒再试。", "w/a 还在启动，过几秒再试。"]);
  expect(await state()).toBe("启动中");
  await until(() => rhodium.claude.runs().length === 1);
}, 30_000);

// The common commands read the same on every agent (story 54). Each agent's entry is how it
// runs a first turn, and what that turn leaves for /status. #30, #34 and #35 add their commands
// to this group.
const LIVE: Record<"claude" | "pi", { model: string; context: string }> = {
  // The fake claude's default model, and its 52,000 of 200,000 tokens in use.
  claude: { model: "默认（Opus 5.5）", context: "26% (~52k / 200k Tokens)" },
  // The fake pi's model, and its 127 of 100,000.
  pi: { model: "Pi Fake", context: "<1% (~127 / 100k Tokens)" },
};

/** A turn that runs until it is interrupted, then ends 300 ms later. */
const STOPPABLE: Record<"claude" | "pi", InstanceOptions> = {
  claude: { claude: { script: "until-interrupted" } },
  pi: { pi: { script: "pi-until-interrupted" } },
};

/** What each agent answers to the commands its driver runs, in order, after one turn on the fake
 *  agent playing opts; how long till a reset as of now, which is said to the minute. */
const ANSWERS = (): Record<"claude" | "pi", { opts: InstanceOptions; answers: [string, string][] }> => ({
  // The fake claude's handshake offers two models; its get_usage answers USAGE (fake-agent/scripts.ts).
  claude: {
    opts: { claude: { script: "compact" } },
    answers: [
      // This bot has no buttons: panels come numbered (docs/im-style.md §9).
      ["/model", "换哪个模型？\n现在：默认（Opus 5.5）\n\n✓ 1. 默认（Opus 5.5）\n2. Haiku\n\n回编号选一个。"],
      ["/model 2", "已切到 Haiku。\n思考强度要改吗？\n\n1. low\n2. medium\n3. high\n\n回编号选一个。"],
      ["/model default", "已切到 默认（Opus 5.5）。\n思考强度要改吗？\n\n1. low\n2. medium\n3. high\n\n回编号选一个。"],
      ["/model nope", "/model 没做成。\n原因：没有模型 nope。可选：default、haiku"],
      ["/effort", "思考强度改成哪档？\n\n1. low\n2. medium\n3. high\n\n回编号选一个。"],
      ["/effort high", "思考强度改成 high。"],
      ["/effort bogus", "/effort 没做成。\n原因：没有思考强度 bogus。可选：low、medium、high"],
      [
        "/usage",
        `Claude 额度\n12% 5h，${when(Date.parse("2026-10-21T14:00:00"))}\n52% 7d，${when(Date.parse("2026-10-25T06:00:00"))}\n38% 7d Fable，${when(Date.parse("2026-10-25T06:00:00"))}\n\n当前对话\n$15.35 等效 API 价格\n18.9M 总 Tokens 消耗`,
      ],
      ["/context", "已使用 26% 上下文 (~52k / 200k Tokens)"],
      ["/compact", "已压缩上下文，从约 80k tokens 减到约 12k tokens。"],
    ],
  },
  pi: { opts: {}, answers: [
    ["/model", "换哪个模型？\n现在：Pi Fake，思考强度 medium\n\n✓ 1. Pi Fake\n2. Pi Other\n\n回编号选一个。"],
    ["/model 2", "已切到 Pi Other。\n思考强度要改吗？现在是 medium。\n\n1. off\n2. low\n✓ 3. medium\n4. high\n\n回编号选一个。"],
    ["/model pi-other", "已切到 Pi Other。\n思考强度要改吗？现在是 medium。\n\n1. off\n2. low\n✓ 3. medium\n4. high\n\n回编号选一个。"],
    ["/model nope", "/model 没做成。\n原因：没有模型 nope。可选：fake/pi-fake、fake/pi-other"],
    ["/effort", "思考强度改成哪档？\n现在：medium\n\n1. off\n2. low\n✓ 3. medium\n4. high\n\n回编号选一个。"],
    ["/effort high", "思考强度改成 high。"],
    ["/effort bogus", "/effort 没做成。\n原因：没有思考强度 bogus。可选：off、low、medium、high"],
    ["/usage", "当前对话\n$0.00\n127 总 Tokens 消耗"],
    ["/context", "已使用 <1% 上下文 (~127 / 100k Tokens)"],
    ["/compact", "已压缩上下文，从约 127 tokens 减到约 30 tokens。"],
  ] },
});

describe.each(["claude", "pi"] as const)("story 54: common commands on %s, in the one format", (agent) => {
  // docs/im-style.md §7.1.
  const name = agent === "claude" ? "Claude Code" : "Pi";
  const status = (dir: string, model: string, state: string, context: string) =>
    ["w/a", state, "", "模型设置", `Agent：${name}`, ...(model ? [`模型：${model}`] : []), "", "状态", `目录：${dir}`, ...(context ? [`上下文：${context}`] : [])].join("\n");

  test("story 56: /status on a slot not running shows its directory, agent and state", async () => {
    const dir = await slot({}, agent);
    await say("/status");
    expect((await posts())[0]!.text).toBe(status(dir, "", "未运行，来消息就启动", ""));
    expect(rhodium.claude.runs()).toEqual([]);
    expect(rhodium.pi.runs()).toEqual([]);
  }, 30_000);

  test("/stop and /new with nothing running", async () => {
    await slot({}, agent);
    await say("/stop");
    await say("/new");
    expect((await posts(2)).map((p) => p.text)).toEqual(["现在没有在跑的回合。", "已开一段新对话。"]);
  }, 30_000);

  test("stories 56, 403: /status on a running agent adds its model and its context", async () => {
    const dir = await slot({}, agent);
    await say("hello");
    await posts(1);
    await until(async () => (await state()) === "空闲", 15_000);
    const ask = await say("/status");
    expect((await posts(2))[1]).toMatchObject({ text: status(dir, LIVE[agent].model, "空闲", LIVE[agent].context), replyTo: ask.messageId });
  }, 30_000);

  // A bare ! leaves nothing to send, so it is /stop (product §5.3), whatever the agent: claude's covers it.
  test.each(agent === "claude" ? ["/stop", "!"] : ["/stop"])("story 55: %s ends the running turn and keeps the conversation; the next message carries on in it", async (word) => {
    await slot(STOPPABLE[agent], agent);
    await say("Count to a million.");
    await until(async () => (await state()) === "运行中", 15_000);
    const stop = await say(word);
    expect((await posts())[0]).toMatchObject({ text: "已停下这一回合，对话留着。", replyTo: stop.messageId });
    await until(async () => (await state()) === "空闲", 15_000);

    // The stopped turn sends no final reply; the next message gets one, from the same agent process.
    const next = await say("And now?");
    const [, reply, ...more] = await posts(2);
    expect(reply).toMatchObject({ text: "fake reply", replyTo: next.messageId });
    expect(more).toEqual([]);
    expect(asked(agent)).toEqual([["Count to a million.", "And now?"]]);
  }, 30_000);

  // Rhodium lists them itself, for every agent alike (product §4.7).
  test("story 10: /resume with no argument lists the slot's conversations, the current one marked", async () => {
    await slot({}, agent);
    await say("hello");
    await posts(1);
    await say("/resume");
    const [, list] = await posts(2);
    expect(list!.text).toMatch(/^回到哪段对话？\n现在：今天 \d\d:\d\d 那段\n\n✓ 1\. \d\d:\d\d hello\n\n回编号选一个。$/);
  }, 30_000);

  test("stories 57-60: /model /effort /usage /context /compact, each answered in the one format", async () => {
    const { opts, answers } = ANSWERS()[agent];
    await slot(opts, agent);
    await say("hello");
    await posts(1);
    // One at a time: each is answered when the agent is, so two in flight may answer out of order.
    for (const [i, [command]] of answers.entries()) {
      await say(command);
      await posts(i + 2);
    }
    const replies = (await posts()).slice(1).map((p) => p.text);
    // As of now: the replies said how long till the reset as they came.
    expect(replies).toEqual(ANSWERS()[agent].answers.map(([, text]) => text));
  }, 30_000);

  test("a command for the agent on a slot not running starts the agent, on its conversation, then runs (2026-10-21)", async () => {
    await slot(ANSWERS()[agent].opts, agent);
    const runs = () => rhodium[agent].runs();
    // Never used: the agent starts for it, and stays up, idle.
    await say("/effort high");
    expect((await posts(1)).map((p) => p.text)).toEqual(["思考强度改成 high。"]);
    expect(runs()).toHaveLength(1);
    expect(await state()).toBe("空闲");
    await say("hello");
    await posts(2);
    expect(runs()).toHaveLength(1);
    // Stopped: it starts again on the same conversation.
    await ok("stop", "w/a");
    await until(async () => (await state()) === "未运行", 15_000);
    await say("/effort low");
    expect((await posts(3))[2]!.text).toBe("思考强度改成 low。");
    expect(runs()).toHaveLength(2);
    expect(sessionOf(runs()[1]!.argv) ?? runs()[1]!.argv.find((a) => a.startsWith("--resume="))?.split("=")[1]).toBe(sessionOf(runs()[0]!.argv));
  }, 30_000);
});

test("a command that would start the agent past the running limit is refused, and says why (2026-10-21)", async () => {
  await slot({ toml: "[limits]\nmaxRunning = 1" });
  await ok("new", "w/b");
  await ok("send", "w/b", "hi");
  await until(async () => (await ok("ls")).match(/^w\/b +\S+ +\S+ +空闲/m) !== null, 15_000);
  await say("/effort high");
  expect((await posts(1)).map((p) => p.text)).toEqual(["/effort 没做成，w/a 没能启动。发一条消息就能启动它（你的消息不受这个限制），之后再发 /effort。\n原因：同时运行的无头槽位已到上限 1 个"]);
  expect(rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === "w/a")).toEqual([]);
}, 30_000);

test("story 58: /effort sets Claude's effort with apply_flag_settings, and /status shows it", async () => {
  await slot();
  await say("hello");
  await posts(1);
  await say("/effort high");
  await posts(2);
  await say("/status");
  expect((await posts(3))[2]!.text).toStartWith("w/a\n空闲\n\n模型设置\nAgent：Claude Code\n模型：默认（Opus 5.5）high\n\n");
  const sent = rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)));
  expect(sent.filter((m) => m.request?.subtype === "apply_flag_settings").map((m) => m.request)).toEqual([
    { subtype: "apply_flag_settings", settings: { effortLevel: "high", ultracode: false } },
  ]);
}, 30_000);

test("#276: /ultracode is a switch of its own: on and off as Claude has it, kept with the slot, and the next process starts with it beside the level", async () => {
  await slot({ claude: { script: "turn-ultracode" } });
  const flags = () => rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l))).filter((m) => m.request?.subtype === "apply_flag_settings").map((m) => m.request.settings);
  const reply = async (text: string) => {
    const n = (await rhodium.im.log("q", ME)).length;
    await say(text);
    return (await posts(n + 1))[n]!.text;
  };
  await reply("hello");
  // /effort lists the levels alone, and /model's second step too; none set, the one Claude uses marked (#454).
  expect(await reply("/effort")).toBe("思考强度改成哪档？\n现在：high\n\n1. low\n2. medium\n✓ 3. high\n4. xhigh\n5. max\n\n回编号选一个。");
  expect(await reply("/effort high")).toBe("思考强度改成 high。");
  expect(await reply("/model default")).toEndWith("\n\n1. low\n2. medium\n✓ 3. high\n4. xhigh\n5. max\n\n回编号选一个。");
  expect(await reply("/ultracode")).toBe("ultracode 开还是关？\n现在：关\n\n1. 开\n✓ 2. 关\n\n回编号选一个。");
  expect(await reply("/ultracode on")).toBe("ultracode 改成开。");
  expect(flags().at(-1)).toEqual({ ultracode: true });
  expect(await reply("/status")).toContain("\n模型：默认（Opus 5.5）high\n已开启 ultracode\n");

  await ok("stop", "w/a");
  await until(async () => (await state()) === "未运行", 15_000);
  await reply("again");
  const argv = rhodium.claude.runs().at(-1)!.argv;
  expect(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 4)).toEqual(["--effort", "high", "--settings", '{"ultracode":true}']);
  expect(await reply("/ultracode off")).toBe("ultracode 改成关。");
  expect(await reply("/status")).not.toContain("ultracode");
}, 30_000);

test("#276: another level leaves ultracode as Claude has it on, rather than turning it off", async () => {
  await slot({ claude: { script: "turn-ultracode-on" } });
  await say("hello");
  await posts(1);
  await say("/effort low");
  await say("/model default medium");
  await posts(3);
  const sent = rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)));
  expect(sent.filter((m) => m.request?.subtype === "apply_flag_settings").map((m) => m.request.settings)).toEqual([
    { effortLevel: "low", ultracode: true },
    { effortLevel: "medium", ultracode: true },
  ]);
}, 30_000);

test("#276: a model that cannot take ultracode says so and keeps what the slot has; pi has none, and its /status no line for it", async () => {
  await slot({ claude: { script: "turn-no-ultracode" } });
  await say("hello");
  await posts(1);
  await say("/ultracode on");
  expect((await posts(2))[1]!.text).toBe("这个模型用不了 ultracode。");
  await say("/status");
  expect((await posts(3))[2]!.text).not.toContain("ultracode");
  rhodium.cleanup();

  await slot({}, "pi");
  await say("/ultracode on");
  await say("/status");
  const [no, status] = await posts(2);
  expect(no!.text).toBe("pi 没有 ultracode。");
  expect(status!.text).not.toContain("ultracode");
  expect(rhodium.pi.runs()).toEqual([]);
}, 30_000);

test("story 60: a message sent while Claude compacts gets its reply", async () => {
  // The compaction's turn is no message's of yours: yours waits for it to end, then begins its own.
  await slot({ claude: { script: { on, steps: [...startTurn, ...endTurn("fake reply"), ...compaction([{ sleep: 1000 }, { emit: [session("idle")] }]), ...startTurn, ...endTurn("after compaction")] } } });
  await say("hello");
  await posts(1);
  const compact = await say("/compact");
  await until(async () => (await state()) === "运行中", 15_000);
  const next = await say("And now?");
  // The two come in either order: the turn's reply does not wait for the command's.
  const replies = (await posts(3)).slice(1).map((p) => [p.replyTo, p.text]);
  expect(replies.sort()).toEqual(
    [
      [compact.messageId, "已压缩上下文，从约 80k tokens 减到约 12k tokens。"],
      [next.messageId, "after compaction"],
    ].sort(),
  );
}, 30_000);
