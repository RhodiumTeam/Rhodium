// Seam one: how a turn shows on QQ, and how Rhodium spends QQ's reply quota (product §5.5,
// architecture §8.2). The fake IM copies QQ's capabilities and refuses sends as its quota says.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import type { Step } from "./fake-agent/fake-agent";
import { askingCall, askOnce, askWithdrawn, endTurn, joinBetweenTools, on, saying, startTurn, toolCall, toolResult, toolUse, type FakeAsk } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium whose QQ-like bot q sends your messages to slot w/a. */
async function qq(opts: InstanceOptions = {}): Promise<Daemon> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  const daemon = await rhodium.start();
  mkdirSync(join(rhodium.dir, "a"));
  for (const args of [["ws", "w", join(rhodium.dir, "a")], ["new", "w/a"]]) expect((await rhodium.rh(args)).code).toBe(0);
  return daemon;
}

/** at: when the platform says you sent it, if not just now. */
const say = (text: string, at?: number) => rhodium.im.inject("q", { chat: ME, sender: ME, text, at });
/** The outbound records whose send failed, oldest first, from rhodium's log. */
const failed = (d: Daemon) => d.logs.filter((l) => l.msg === "send failed").map((l) => l.outbound);
const HOUR = 3_600_000;
const state = async () => (await rhodium.rh(["ls"])).out.match(/^w\/a +\S+ +\S+ +(\S+)/m)?.[1];

/** What the bot posted in your chat once the turn is over and n messages are there. */
async function afterTurn(n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n && (await state()) === "空闲", 15_000);
  return rhodium.im.log("q", ME);
}

/** A turn that says three things, reading a file, then running a command, in between. */
const TALK = {
  on,
  steps: [
    ...startTurn,
    saying("Looking."),
    toolCall("toolu_read", "Read", { file_path: "notes.txt" }),
    saying("Found it."),
    toolCall("toolu_bash", "Bash", { command: "ls" }),
    ...endTurn("Done."),
    { goto: 0 },
  ],
};
/** What TALK's turn sends on QQ, by default. */
const TALKED = ["Looking.", "[🔧 Read]\n\nFound it.", "[🔧 Bash]\n\nDone."] as const;

test("story 70: a message each time the agent finishes saying something, the tools it ran before it in a line on top; the last is the final reply", async () => {
  await qq({ claude: { script: TALK } });
  const { messageId } = await say("look around");
  const posts = await afterTurn(3);
  expect(posts.map((p) => p.text)).toEqual([...TALKED]);
  // All of them replies to your message: passive replies, with the last one still left over (story 71).
  expect(posts.map((p) => p.replyTo)).toEqual([messageId, messageId, messageId]);
}, 30_000);

test("by default your message brings 20 passive replies (probe 12): a long turn shows 18 things it said as it goes, the rest with its end, and one reply is left over", async () => {
  const said = Array.from({ length: 25 }, (_, i) => String(i % 10).repeat(399));
  const steps = [...startTurn, ...said.slice(0, -1).flatMap((t, i) => [saying(t), toolCall(`toolu_${i}`, "Read", { file_path: "notes.txt" })]), ...endTurn(said.at(-1)!), { goto: 0 }];
  await qq({ claude: { script: { on, steps } }, toml: "[limits]\nqqActive = 0" });
  const { messageId } = await say("write a lot");
  const posts = await afterTurn(19);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.replyTo)).toEqual(Array(19).fill(messageId));
  expect(posts.slice(0, 18).map((p) => p.text)).toEqual(said.slice(0, 18).map((t, i) => (i ? `[🔧 Read]\n\n${t}` : t)));
  // The other six it said are too long to go with the final reply: a line says so.
  expect(posts[18]!.text).toBe(`中间还有 6 段话没发出来，看板上能看到。\n\n[🔧 Read]\n\n${said.at(-1)}`);
}, 30_000);

test("story 71: with two passive replies to a message, the whole turn comes as one, and the last reply is kept", async () => {
  await qq({ claude: { script: TALK }, toml: "[limits]\nqqPassiveReplies = 2" });
  const { messageId } = await say("look around");
  const posts = await afterTurn();
  expect(posts.map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([{ text: TALKED.join("\n\n"), replyTo: messageId }]);
}, 30_000);

/** TALK's turn with rh send me run with args after its first tool. */
const sendsMe = (args: string[]) => ({ on, steps: TALK.steps.toSpliced(startTurn.length + 2, 0, { rh: ["send", "me", ...args] }) });

test("story 40: once the agent says something here with rh send me, the rest of what it says this turn, and its final reply, are not sent; the tool line that would have topped what it said goes alone, the last one at the turn's end", async () => {
  await qq({ claude: { script: sendsMe(["found it"]) } });
  await say("look around");
  await afterTurn(4);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(["Looking.", "found it", "[🔧 Read]", "[🔧 Bash]"]);
}, 30_000);

test("story 40: rh send me here that does not go out takes nothing over: the turn shows as ever (#615)", async () => {
  await qq({ claude: { script: sendsMe(["found it"]) } });
  await rhodium.im.next("q", "ok", "send");
  await rhodium.im.next("q", "fail", "send");
  await say("look around");
  await afterTurn(3);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual([...TALKED]);
}, 30_000);

/** After what it said, if anything: a Bash call that runs rh send me, then ls, then the final reply. */
const takesOver = (said: Step[] = []) => ({
  on,
  steps: [
    ...startTurn,
    ...said,
    toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
    { rh: ["send", "me", "测试接管"] },
    toolResult("toolu_send"),
    toolCall("toolu_ls", "Bash", { command: "ls ~" }),
    ...endTurn("看完了。"),
    { goto: 0 },
  ],
});

test("story 40: rh send me from a Bash call, then ls, then the final reply: what it sent comes, then at the turn's end one tool line for the two Bash calls, never the reply", async () => {
  await qq({ claude: { script: takesOver() } });
  await say("先用 rh send me 给我发一句，然后跑 ls ~");
  await afterTurn(2);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(["测试接管", "[🔧 Bash ×2]"]);
}, 30_000);

test("story 40: what the agent said before rh send me, kept for want of passive replies, still comes at the turn's end, with the tool line after it", async () => {
  // Three passive replies: one for what it says as it goes, one for rh send me, the last kept for the hint.
  await qq({ claude: { script: takesOver([saying("A"), toolCall("toolu_read", "Read", { file_path: "notes.txt" }), saying("B")]) }, toml: "[limits]\nqqPassiveReplies = 3" });
  await say("look around");
  await afterTurn(3);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(["A", "测试接管", "[🔧 Read]\n\nB\n\n[🔧 Bash ×2]"]);
}, 30_000);

/** rh send me, words after it, then, once your next message joins the turn, an answer to it, ls and the final reply. */
const takesOverThenJoined: Step[] = [
  ...startTurn,
  toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
  { rh: ["send", "me", "测试接管"] },
  toolResult("toolu_send"),
  saying("接管后说的话。"),
  ...joinBetweenTools,
  saying("回答插话。"),
  toolCall("toolu_ls", "Bash", { command: "ls ~" }),
  ...endTurn("最终回复。"),
  { goto: 0 },
];

test.each([
  ["this chat", ME],
  ["another chat", "a-group"],
])("#234: your message from %s joining a turn rh send me took over lifts it: the answer to it and the final reply come to the turn's chat, what the agent said before it still does not", async (_, chat) => {
  await qq({ claude: { script: { on, steps: takesOverThenJoined } } });
  await say("go");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "测试接管"), 15_000);
  await Bun.sleep(300); // the words after rh send me reached rhodium
  await rhodium.im.inject("q", { chat, sender: ME, text: "再说一句" });
  await afterTurn(3);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(["测试接管", "[🔧 Bash]\n\n回答插话。", "[🔧 Bash]\n\n最终回复。"]);
}, 30_000);

test("#234: without your message joining, the turn rh send me took over stays quiet to its end", async () => {
  const steps = takesOverThenJoined.filter((s) => !joinBetweenTools.includes(s));
  await qq({ claude: { script: { on, steps } } });
  await say("go");
  await afterTurn(2);
  await Bun.sleep(300); // nothing more comes
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(["测试接管", "[🔧 Bash]", "[🔧 Bash]"]);
}, 30_000);

const TEA: FakeAsk = ["q-1", "AskUserQuestion", { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }], multiSelect: false }] }];

/** rh send me unless not, words after it, the ask, then words, ls and the final reply. */
const takesOverThenAsks = (ask: Step[], sendMe = true): Step[] => [
  ...startTurn,
  ...(sendMe ? [toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }), { rh: ["send", "me", "测试接管"] }, toolResult("toolu_send")] : []),
  saying("接管后说的话。"),
  toolUse("toolu_q-1", "AskUserQuestion", TEA[2]),
  ...ask,
  toolResult("toolu_q-1"),
  saying("答完说的话。"),
  toolCall("toolu_ls", "Bash", { command: "ls ~" }),
  ...endTurn("最终回复。"),
  { goto: 0 },
];

/** What the bot sent in your chat once the turn is over, the ask as "ask". */
async function sentAfterTurn(): Promise<string[]> {
  await until(async () => (await state()) === "空闲", 15_000);
  await Bun.sleep(300); // nothing more comes
  return (await rhodium.im.log("q", ME)).filter((p) => p.kind === "send").map((p) => (p.text.startsWith("Tea or coffee?") ? "ask" : p.text));
}

/** The ask, once it reached your chat. */
async function theAsk(): Promise<Posted> {
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.buttons?.length), 15_000);
  return (await rhodium.im.log("q", ME)).find((p) => p.buttons?.length)!;
}

test.each([
  ["a button", (ask: Posted) => rhodium.im.press("q", ME, ask, "Tea")],
  ["words", () => say("Tea")],
])("#237: your answer by %s to the ask of a turn rh send me took over lifts it: what the agent says after it and the final reply come, what it said before still does not", async (_, answer) => {
  await qq({ claude: { script: { on, steps: takesOverThenAsks(askOnce(TEA)) } } });
  await say("go");
  await answer(await theAsk());
  expect(await sentAfterTurn()).toEqual(["测试接管", "[🔧 Bash]", "ask", "已回答：Tea。", "答完说的话。", "[🔧 Bash]\n\n最终回复。"]);
}, 30_000);

test.each([
  ["times out", askOnce(TEA), '[durations]\naskTimeout = "1s"'],
  ["is withdrawn by the agent", askWithdrawn(TEA, 1000), ""],
])("#237: an ask of a turn rh send me took over that %s lifts nothing: the turn stays quiet to its end", async (_, ask, toml) => {
  await qq({ claude: { script: { on, steps: takesOverThenAsks(ask) } }, toml });
  await say("go");
  await theAsk();
  expect(await sentAfterTurn()).toEqual(["测试接管", "[🔧 Bash]", "ask", "[🔧 Bash]"]);
}, 30_000);

test("#237: without rh send me, your answer changes nothing: the turn shows as ever", async () => {
  await qq({ claude: { script: { on, steps: takesOverThenAsks(askOnce(TEA), false) } } });
  await say("go");
  await theAsk();
  await say("Tea");
  expect(await sentAfterTurn()).toEqual(["接管后说的话。", "ask", "已回答：Tea。", "答完说的话。", "[🔧 Bash]\n\n最终回复。"]);
}, 30_000);

test("story 40: a file alone the agent sends here with rh send me takes nothing over: the turn shows as ever", async () => {
  await qq({ claude: { script: sendsMe(["--file", "notes.txt"]) } });
  writeFileSync(join(rhodium.dir, "a/notes.txt"), "notes");
  await say("look around");
  const posts = await afterTurn(4);
  expect(posts.map((p) => p.file?.name ?? p.text)).toEqual([TALKED[0], "notes.txt", ...TALKED.slice(1)]);
}, 30_000);

/** The messages the bot sent to your chat, once n are there, and the turn, if any, is over. */
async function posted(n: number): Promise<Posted[]> {
  const sent = async () => (await rhodium.im.log("q", ME)).filter((p) => p.kind === "send");
  await until(async () => (await sent()).length >= n && (await state()) !== "运行中", 15_000);
  return sent();
}

test("story 414: /rh_verbose bare still switches this chat's tool lines, here to a line a tool with what it worked on; its button, or off, makes them short again", async () => {
  await qq({ claude: { script: TALK } });
  await say("/rh_verbose");
  const [on] = await posted(1);
  expect(on).toMatchObject({ text: "工具行改成详细：每个工具一行，带文件名或命令。", buttons: [{ label: "改回简略", data: "/rh_verbose off" }] });
  await say("look around");
  expect((await posted(4)).slice(1).map((p) => p.text)).toEqual(["Looking.", "[🔧 Read] notes.txt\n\nFound it.", "[🔧 Bash] ls\n\nDone."]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "", button: { data: "/rh_verbose off", message: on!.messageId } });
  expect((await posted(5))[4]).toMatchObject({ text: "工具行改成简略：只写工具名和次数。", buttons: [{ label: "改回详细", data: "/rh_verbose on" }] });
  await say("look again");
  expect((await posted(8)).slice(5).map((p) => p.text)).toEqual([...TALKED]);
  // Bare again, it switches back.
  await say("/rh_verbose");
  expect((await posted(9))[8]).toMatchObject({ text: "工具行改成详细：每个工具一行，带文件名或命令。" });
}, 30_000);

test("what the agent says before it asks you comes before the ask, not once you answered", async () => {
  const TEA = { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }], multiSelect: false }] };
  await qq({ claude: { script: { on, steps: [...startTurn, saying("Let me ask."), ...askingCall(["q-1", "AskUserQuestion", TEA]), ...endTurn("Tea it is."), { goto: 0 }] } } });
  await say("pick a drink");
  const [said, ask] = await posted(2);
  expect(said!.text).toBe("Let me ask.");
  expect(ask!.text).toContain("Tea or coffee?");
}, 30_000);

/** What the fake claude was asked, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

test("story 41: with no passive reply to spare, the reply goes out as an active message", async () => {
  await qq({ toml: "[limits]\nqqPassiveReplies = 1" });
  await say("hello");
  expect((await afterTurn()).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([{ text: "fake reply", replyTo: undefined }]);
}, 30_000);

test("story 41: a passive reply the platform refuses for its quota goes out again, the same message as an active one", async () => {
  // The platform allows fewer passive replies than rhodium counts on.
  await qq({ platform: { passiveReplies: 0 } });
  await say("hello");
  expect((await afterTurn()).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([{ text: "fake reply", replyTo: undefined }]);
}, 30_000);

test("story 41: a message the platform refuses for its quota mid-turn goes out again as an active message, in order", async () => {
  // The platform allows one passive reply to a message; rhodium counts on 20.
  await qq({ claude: { script: TALK }, platform: { passiveReplies: 1 } });
  const { messageId } = await say("look around");
  const posts = await afterTurn(3);
  expect(posts.map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([
    { text: TALKED[0], replyTo: messageId },
    { text: TALKED[1], replyTo: undefined },
    { text: TALKED[2], replyTo: undefined },
  ]);
}, 30_000);

test("story 122: a restarted rhodium goes on counting from where it was", async () => {
  await qq({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 1" });
  await say("first");
  expect((await afterTurn()).map((p) => p.replyTo)).toEqual([undefined]); // the one active message
  expect((await rhodium.rh(["stop", "w/a"])).code).toBe(0);
  await until(async () => (await state()) === "未运行", 15_000);
  await rhodium.stop();
  await rhodium.start();

  const second = await say("second");
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 15_000);
  expect((await rhodium.im.log("q", ME))[1]).toMatchObject({ text: "完成，回任意字查看", replyTo: second.messageId });
}, 30_000);

test("story 42: with both used up, you get 完成，回任意字查看; anything you send then brings the reply, and reaches no agent", async () => {
  await qq({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0" });
  const first = await say("hello");
  const [hint, ...more] = await afterTurn();
  expect(hint).toMatchObject({ text: "完成，回任意字查看", replyTo: first.messageId });
  expect(more).toEqual([]);

  const any = await say("1");
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 15_000);
  expect((await rhodium.im.log("q", ME))[1]).toMatchObject({ text: "fake reply", replyTo: any.messageId });
  expect(asked()).toEqual(["hello"]);
}, 30_000);

test("story 41: a refused reply with no active message left waits for your next message, which still reaches the agent", async () => {
  // The platform's passive window for your first message has passed; rhodium counts on a longer one.
  const d = await qq({ toml: '[limits]\nqqActive = 0\n[durations]\nqqPassiveWindow = "3h"' });
  await say("hello", Date.now() - 2 * HOUR);
  await until(() => failed(d).length === 1, 15_000);

  // No 完成，回任意字查看 went out, so this one is not asking for what waits.
  const next = await say("please do X");
  const posts = await afterTurn(2);
  expect(posts.map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([
    { text: "fake reply", replyTo: next.messageId }, // the reply to hello
    { text: "fake reply", replyTo: next.messageId },
  ]);
  expect(asked()).toEqual(["hello", "please do X"]);
}, 30_000);

test("story 42: a 完成，回任意字查看 that never reached you leaves your next message for the agent", async () => {
  const d = await qq({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0" });
  await rhodium.im.next("q", "fail", "send");
  await say("hello");
  await until(() => failed(d).length === 1, 15_000); // the hint

  const next = await say("please do X");
  const posts = await afterTurn();
  expect(posts.map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([{ text: "fake reply", replyTo: next.messageId }]);
  expect(asked()).toEqual(["hello", "please do X"]);
}, 30_000);

test("story 42: a held message the platform refuses again when your next message brings it is dropped, not held again", async () => {
  // The platform refuses every passive reply, as it would a message its moderation turns down.
  const d = await qq({ platform: { passiveReplies: 0 }, toml: "[limits]\nqqActive = 0" });
  await say("hello");
  await until(() => failed(d).length === 1, 15_000);
  const [reply] = failed(d);
  await say("please do X");
  await until(() => failed(d).length === 3, 15_000); // hello's reply once more, and this one's reply
  await say("are you there?");
  await until(() => failed(d).length >= 5 && asked().length === 3, 15_000);

  expect(failed(d).filter((id) => id === reply)).toHaveLength(2);
  expect(asked()).toEqual(["hello", "please do X", "are you there?"]);
}, 30_000);

test("story 42: with one passive reply to your message and two messages waiting, it brings the first of them, not another hint", async () => {
  await qq({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0" });
  // Both turns end after their message's passive window, so both replies wait.
  for (const [i, text] of ["first", "second"].entries()) {
    await say(text, Date.now() - 2 * HOUR);
    await until(async () => asked().length === i + 1 && (await state()) === "空闲", 15_000);
  }
  const next = await say("1");
  await until(async () => (await rhodium.im.log("q", ME)).length > 0, 15_000);
  expect((await rhodium.im.log("q", ME))[0]).toMatchObject({ text: "fake reply", replyTo: next.messageId });
}, 30_000);

/** 45 lines of 99 characters, 4,499 characters in all: over QQ's 2,000 and Telegram's 4,096. */
const LONG = Array.from({ length: 45 }, (_, i) => String(i % 10).repeat(99)).join("\n");

test("story 74: a reply longer than a QQ message comes in pieces at line breaks, each one sent", async () => {
  await qq({ claude: { script: { on, steps: [...startTurn, ...endTurn(LONG), { goto: 0 }] } } });
  const { messageId } = await say("write a lot");
  const posts = await afterTurn(3);
  expect(posts.map((p) => p.text.length <= 2000)).toEqual([true, true, true]);
  expect(posts.map((p) => p.text).join("\n")).toBe(LONG);
  expect(posts.map((p) => p.replyTo)).toEqual([messageId, messageId, messageId]);
}, 30_000);
