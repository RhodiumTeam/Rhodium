// Seam one: how a turn shows on Telegram, one message edited as the turn goes (product §5.5,
// architecture §8.2). The fake IM copies Telegram's capabilities: it edits, at five requests a chat a
// second (test/instance.ts), or once a second as Telegram does in the test of that limit.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { REPORT_LINE } from "../src/prompt";
import { TELEGRAM_CAPABILITIES } from "../src/telegram";
import type { Script, Step } from "./fake-agent/fake-agent";
import { askingCall, askOnce, builtins, endTurn, joinBetweenTools, on, PROGRESS_PIECES, startTurn, textDelta, toolCall, toolResult, toolUse, type FakeAsk } from "./fake-agent/scripts";
import { newInstance, recorded, until, type Daemon, type Instance, type InstanceOptions } from "./instance";

const ME = "you-tg-id";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium whose Telegram-like bot t sends your messages to slot w/a; t has more keys from bot. */
async function telegram(opts: InstanceOptions = {}, bot: Record<string, string> = {}): Promise<Daemon> {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a", ...bot } }, ...opts });
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  return daemon;
}

const say = (text: string) => rhodium.im.inject("t", { chat: ME, sender: ME, text });

/** What the bot posted in your chat, once the last of it shows text. */
async function lastShows(text: string, bot = "t", chat = ME): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log(bot, chat)).at(-1)?.text === text, 15_000);
  return rhodium.im.log(bot, chat);
}

test("story 25: on Telegram you talk with the slot, and its reply comes back to your chat", async () => {
  await telegram();
  await say("hello");
  expect((await lastShows("fake reply")).map((p) => ({ kind: p.kind, text: p.text }))).toEqual([{ kind: "send", text: "fake reply" }]);
}, 30_000);

/** The tool part of the progress scripts' turn: it reads notes.txt and runs ls. */
const TOOLS = "[🔧 Read] notes.txt\n[🔧 Bash] ls";
/** What the progress scripts' turn shows in the end: its tools, then its reply. */
const PROGRESS_SHOWN = `${TOOLS}\n\n${PROGRESS_PIECES.join("").trimEnd()}`;

test("stories 66-69: a turn is one message, edited as it goes: tool lines as the tools run, the text growing under them, the final reply its last part", async () => {
  await telegram({ claude: { script: "progress-fast" } });
  await say("look around");
  const posts = await lastShows(PROGRESS_SHOWN);

  // Story 66: sent once, then only edited.
  const [first, ...edits] = posts;
  expect(first!.kind).toBe("send");
  expect(edits.map((p) => ({ kind: p.kind, messageId: p.messageId }))).toEqual(edits.map(() => ({ kind: "edit", messageId: first!.messageId })));

  // Story 67: a line for each tool as it starts, there till it is done; in Markdown, a quote.
  expect(first!.text).toBe("[🔧 Read] notes.txt，正在运行");
  const progress = posts.slice(0, -1).map((p) => p.text);

  // Story 68: under them, the text so far, longer each time.
  const bodies = progress.filter((t) => t.startsWith(`${TOOLS}\n\n`)).map((t) => t.slice(TOOLS.length + 2));
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  bodies.forEach((body, i) => {
    expect(PROGRESS_PIECES.join("").startsWith(body)).toBe(true);
    if (i) expect(body.length).toBeGreaterThan(bodies[i - 1]!.length);
  });

  // Story 69: the turn over, the message keeps how it went, the final reply its last part.
  expect(posts.at(-1)).toMatchObject({ text: PROGRESS_SHOWN, markdown: `> [🔧 Read] \`notes.txt\`  \n> [🔧 Bash] \`ls\`\n\n${PROGRESS_PIECES.join("").trimEnd()}` });
}, 30_000);

test("a turn's events arriving all at once make a few edits, not one each: newer text replaces text not yet sent", async () => {
  await telegram({ claude: { script: "progress" } }); // 13 events with no pause between them
  await say("look around");
  const posts = await lastShows(PROGRESS_SHOWN);
  expect(posts[0]!.kind).toBe("send");
  expect(posts.length).toBeLessThanOrEqual(4); // the send and at most 3 edits
}, 30_000);

test("requests to one chat, sends and edits alike, go out about a second apart, as Telegram's limit asks", async () => {
  expect(TELEGRAM_CAPABILITIES.sendLimit).toEqual({ kind: "rate", perChatPerSecond: 1 });
  // Slower than the limit: a step, then text, then the end, each a little over a second apart.
  const steps: Step[] = [...startTurn, toolCall("toolu_read", "Read", { file_path: "notes.txt" }), { sleep: 1100 }, { emit: [textDelta("one ")] }, { sleep: 1100 }, ...endTurn("one two"), { goto: 0 }];
  await telegram({ claude: { script: { on, steps } } }, { perChatPerSecond: "1" });
  await say("look around");
  await until(async () => (await rhodium.im.log("t", ME)).length > 0, 15_000);
  await say("/status"); // answered at once, while the turn's message is being edited
  const reply = "[🔧 Read] notes.txt\n\none two";
  await until(async () => {
    const posts = await rhodium.im.log("t", ME);
    return posts.at(-1)?.text === reply && posts.filter((p) => p.kind === "send").length === 2;
  }, 15_000);
  const posts = await rhodium.im.log("t", ME);
  expect(posts.filter((p) => p.kind === "edit").length).toBeGreaterThanOrEqual(2);
  // A request the fake IM takes in late makes the gap before it long and the one after it short;
  // the span shows they went out a second apart all the same (#575). Each is paced from the one
  // before's scheduled time, so a late first request shortens the span: allow it the same 300 ms.
  const gaps = posts.slice(1).map((p, i) => p.at - posts[i]!.at);
  expect(gaps.filter((ms) => ms < 700)).toEqual([]);
  expect(posts.at(-1)!.at - posts[0]!.at).toBeGreaterThanOrEqual(gaps.length * 900);
}, 30_000);

test("a send the platform took but never answered is unknown, not failed, and rhodium does not send it again", async () => {
  const d = await telegram();
  await rhodium.im.next("t", "timeout", "send");
  await say("hello");
  await until(() => d.logs.some((l) => l.msg === "send failed" && l.status === "unknown"), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(400); // past an edit's wait, so a resend or an edit would be there by now
  expect((await rhodium.im.log("t", ME)).map((p) => ({ kind: p.kind, text: p.text }))).toEqual([{ kind: "send", text: "fake reply" }]);
}, 30_000);

test("story 72: when the turn's only message failed, there is nothing to edit, and the final reply comes as a new message", async () => {
  await telegram();
  await rhodium.im.next("t", "fail", "send");
  await say("hello");
  await until(async () => (await rhodium.im.log("t", ME)).length > 0, 15_000);
  await Bun.sleep(400); // past an edit's wait: nothing more comes
  expect((await rhodium.im.log("t", ME)).map((p) => `${p.kind} ${p.text}`)).toEqual(["send fake reply"]);
}, 30_000);

test.each([
  ["failed", "fail", 1],
  ["may not have arrived", "timeout", 2],
] as const)("story 72: when the turn's first message %s, its progress goes on in a new message, which becomes the final reply", async (_, outcome, sends) => {
  await telegram({ claude: { script: "progress-fast" } });
  await rhodium.im.next("t", outcome, "send");
  await say("look around");
  const posts = await lastShows(PROGRESS_SHOWN);
  // The platform never took the failed one; the one that timed out it did, and it shows the first step.
  expect(posts.filter((p) => p.kind === "send")).toHaveLength(sends);
  if (sends === 2) expect(posts[0]!.text).toBe("[🔧 Read] notes.txt，正在运行");
  expect(posts.slice(sends - 1).every((p) => p.messageId === posts.at(-1)!.messageId)).toBe(true);
}, 30_000);

test("story 72: an edit Telegram turns down sends the text as a new message, which the turn edits from then on", async () => {
  await telegram({ claude: { script: "progress-fast" } });
  await rhodium.im.next("t", "fail", "edit");
  await say("look around");
  const posts = await lastShows(PROGRESS_SHOWN);
  const sends = posts.filter((p) => p.kind === "send");
  expect(sends).toHaveLength(2);
  expect(messages(posts)).toEqual(["[🔧 Read] notes.txt，正在运行", PROGRESS_SHOWN]);
}, 30_000);

/** A turn that reads a file and says "Looking.", pauses for that to show, then does middle, then
 *  ends with tail's steps. */
const around = (middle: Step[], ...tail: Step[]): Step[] => [
  ...startTurn,
  toolCall("toolu_read", "Read", { file_path: "notes.txt" }),
  { emit: [textDelta("Looking.")] },
  { sleep: 300 },
  ...middle,
  ...tail,
  { goto: 0 },
];

test("story 72: an ask mid-turn comes as a message of its own, and the turn goes on in a new message under it; the call it asks about is in no tool line", async () => {
  await telegram({ claude: { script: { on, steps: around(askingCall(["p-1", "Bash", { command: "make" }]), ...endTurn("Built.")) } } });
  await say("build it");
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.buttons?.length), 15_000);
  const ask = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "", button: { data: ask.buttons![0]!.data, message: ask.messageId } });
  const posts = await lastShows("Built.");
  // The message the ask came under stops without the call it showed running.
  expect(messages(posts)).toEqual(["[🔧 Read] notes.txt\n\nLooking.", ask.text, "已允许运行这条命令。", "Built."]);
}, 30_000);

test("story 72: an approval as the turn's first step: the message that showed the call running stops with its line, done, never empty", async () => {
  // As the approval-allow-deny recording: the call starts, then asks, nothing said before it.
  const make: FakeAsk = ["p-1", "Bash", { command: "make" }];
  const steps: Step[] = [...startTurn, toolUse("toolu_p-1", "Bash", { command: "make" }), { sleep: 300 }, ...askOnce(make), toolResult("toolu_p-1"), ...endTurn("Built."), { goto: 0 }];
  const d = await telegram({ claude: { script: { on, steps } } });
  await say("build it");
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.buttons?.length), 15_000);
  const ask = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "", button: { data: ask.buttons![0]!.data, message: ask.messageId } });
  const posts = await lastShows("Built.");
  expect(posts[0]!.text).toBe("[🔧 Bash] make，正在运行");
  expect(posts.filter((p) => p.kind === "edit" && !p.text)).toEqual([]);
  expect(messages(posts)).toEqual(["[🔧 Bash] make", ask.text, "已允许运行这条命令。", "Built."]);
  expect(d.logs.filter((l) => l.msg === "send failed" || l.msg === "edit failed")).toEqual([]);
}, 30_000);

test("story 72: when the last edit of a message the turn has moved on from is turned down, its text comes in a new message all the same", async () => {
  const make: FakeAsk = ["p-1", "Bash", { command: "make" }];
  // The ask comes before "Looking." can show: the turn moves on from its message with that edit still to make.
  const steps = [...startTurn, toolCall("toolu_read", "Read", { file_path: "notes.txt" }), { emit: [textDelta("Looking.")] }, ...askOnce(make), ...endTurn("Built."), { goto: 0 }];
  await telegram({ claude: { script: { on, steps } } });
  await rhodium.im.next("t", "fail", "edit");
  await say("build it");
  const looking = "[🔧 Read] notes.txt\n\nLooking.";
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.kind === "send" && p.text === looking), 15_000);
  const ask = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "", button: { data: ask.buttons![0]!.data, message: ask.messageId } });
  expect(messages(await lastShows("Built."))).toEqual(["[🔧 Read] notes.txt，正在运行", ask.text, looking, "已允许运行这条命令。", "Built."]);
}, 30_000);

/** A turn whose first step runs rh with argv in its Bash tool, then runs ls and replies Done;
 *  what each message shows once the last shows last. */
async function runsRh(argv: string[], last: string): Promise<{ d: Daemon; shown: string[] }> {
  const send = toolUse("toolu_send", "Bash", { command: `rh ${argv.join(" ")}` });
  const steps: Step[] = [...startTurn, send, { sleep: 300 }, { rh: argv }, toolResult("toolu_send"), toolCall("toolu_bash", "Bash", { command: "ls" }), ...endTurn("Done."), { goto: 0 }];
  const d = await telegram({ claude: { script: { on, steps } } });
  writeFileSync(join(rhodium.dir, "w/chart.png"), "not really a png");
  await say("draw it");
  await until(async () => (await rhodium.state("w/a")) === "空闲" && messages(await rhodium.im.log("t", ME)).at(-1) === last, 15_000);
  await Bun.sleep(400); // past an edit's wait, so one more would be there by now
  return { d, shown: messages(await rhodium.im.log("t", ME)) };
}

test("story 72: a picture rh send me sends here alone mid-turn stops the turn's message as it was, never empty; the turn goes on under it, its final reply too", async () => {
  const { d, shown } = await runsRh(["send", "me", "--file", "chart.png"], "[🔧 Bash] ls\n\nDone.");
  // The message showed only the step running rh send me: it keeps that step, done, and no tool line shows it again.
  expect(shown).toEqual(["[🔧 Bash] rh send me --file chart.png", "", "[🔧 Bash] ls\n\nDone."]);
  expect(d.logs.filter((l) => l.msg === "send failed")).toEqual([]);
}, 30_000);

test("story 72: the pairing code rh pair --add sends here mid-turn stops the turn's message as it was; the turn goes on under it, its final reply too", async () => {
  const { shown } = await runsRh(["pair", "t", "--add"], "[🔧 Bash] ls\n\nDone.");
  expect(shown).toEqual(["[🔧 Bash] rh pair t --add", expect.stringContaining("加一个主人"), expect.stringMatching(/^[A-Z0-9]{8}$/), "[🔧 Bash] ls\n\nDone."]);
}, 30_000);

test("story 40: once rh send me says something here mid-turn, what the agent says after it, and its final reply, are not shown; its tool lines are, under it", async () => {
  const { shown } = await runsRh(["send", "me", "--file", "chart.png", "the chart"], "[🔧 Bash] ls");
  expect(shown).toEqual(["[🔧 Bash] rh send me --file chart.png the chart", "the chart", "", "[🔧 Bash] ls"]);
}, 30_000);

test("story 40: the turn rh send me took over still ends with the last edit of its message: tool lines only, no step running, none of the agent's words; turned down, it comes as a new message", async () => {
  const steps: Step[] = [
    ...startTurn,
    toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
    { sleep: 300 },
    { rh: ["send", "me", "测试接管"] },
    toolResult("toolu_send"),
    toolCall("toolu_ls", "Bash", { command: "ls ~" }),
    ...endTurn("看完了。"),
    { goto: 0 },
  ];
  // Once a second: the edit that ends the ls step is still waiting its turn when the turn ends, and
  // the turn's last edit takes its place.
  await telegram({ claude: { script: { on, steps } } }, { perChatPerSecond: "1" });
  await rhodium.im.next("t", "ok", "edit"); // stopping the first message, at rh send me
  await rhodium.im.next("t", "fail", "edit"); // the last of the message under it
  await say("go");
  await until(async () => (await rhodium.state("w/a")) === "空闲" && messages(await rhodium.im.log("t", ME)).at(-1) === "[🔧 Bash] ls ~", 15_000);
  expect(messages(await rhodium.im.log("t", ME))).toEqual(["[🔧 Bash] rh send me 测试接管", "测试接管", "[🔧 Bash] ls ~，正在运行", "[🔧 Bash] ls ~"]);
}, 30_000);

test("#234: your message joining a turn rh send me took over lifts it: under rh send me's message, the answer to it and the final reply show, what the agent said before it still does not", async () => {
  const steps: Step[] = [
    ...startTurn,
    toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
    { sleep: 300 },
    { rh: ["send", "me", "测试接管"] },
    toolResult("toolu_send"),
    { emit: [textDelta("接管后说的话。")] },
    ...joinBetweenTools,
    { emit: [textDelta("回答插话。")] },
    toolCall("toolu_ls", "Bash", { command: "ls" }),
    ...endTurn("最终回复。"),
    { goto: 0 },
  ];
  await telegram({ claude: { script: { on, steps } } });
  await say("go");
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text === "测试接管"), 15_000);
  await recorded(rhodium, "SELECT 1 FROM conversation WHERE progress LIKE '%接管后说的话%'"); // the words after rh send me reached rhodium
  await say("再说一句");
  // The turn may end while its edits still wait their turn at the chat's pace.
  const last = "回答插话。\n\n[🔧 Bash] ls\n\n最终回复。";
  await until(async () => (await rhodium.state("w/a")) === "空闲" && messages(await rhodium.im.log("t", ME)).at(-1) === last, 15_000);
  await Bun.sleep(400); // past an edit's wait, so one more would be there by now
  expect(messages(await rhodium.im.log("t", ME))).toEqual(["[🔧 Bash] rh send me 测试接管", "测试接管", last]);
}, 30_000);

test.each([
  ["a button", (ask: Posted) => rhodium.im.press("t", ME, ask, "Tea")],
  ["words", () => say("Tea")],
])("#237: your answer by %s to the ask of a turn rh send me took over lifts it: under the ask, what the agent says after it and the final reply show, what it said before still does not", async (_, answer) => {
  const tea: FakeAsk = ["q-1", "AskUserQuestion", { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }], multiSelect: false }] }];
  const steps: Step[] = [
    ...startTurn,
    toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
    { sleep: 300 },
    { rh: ["send", "me", "测试接管"] },
    toolResult("toolu_send"),
    { emit: [textDelta("接管后说的话。")] },
    ...askingCall(tea),
    { emit: [textDelta("答完说的话。")] },
    toolCall("toolu_ls", "Bash", { command: "ls" }),
    ...endTurn("最终回复。"),
    { goto: 0 },
  ];
  await telegram({ claude: { script: { on, steps } } });
  await say("go");
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.buttons?.length), 15_000);
  const ask = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  await answer(ask);
  const last = "答完说的话。\n\n[🔧 Bash] ls\n\n最终回复。";
  await lastShows(last);
  await Bun.sleep(400); // past an edit's wait, so one more would be there by now
  expect(messages(await rhodium.im.log("t", ME))).toEqual(["[🔧 Bash] rh send me 测试接管", "测试接管", ask.text, "已回答：Tea。", last]);
}, 30_000);

/** What the turn's message shows while the step-until-cut-short script's step runs. */
const LOOP_RUNNING = "开始跑循环。\n\n[🔧 Bash] Run 8-step loop，正在运行";

test.each([
  ["its agent is killed, and the turn resumed", (): unknown => process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL"), "空闲"],
  ["/stop", () => say("/stop"), "空闲"],
  ["a message with !", () => say("!换个做法"), "空闲"],
  ["rh stop", () => rhodium.ok("stop", "w/a"), "未运行"],
  ["rh agent with !", () => rhodium.ok("agent", "w/a", "pi", "!"), "未运行"],
] as const)("a turn cut short mid-step (%s) ends its message without the step running, and nothing edits it after", async (_, cut, settled) => {
  await telegram({ claude: { script: "step-until-cut-short" } });
  await say("跑循环");
  await until(async () => (await rhodium.im.log("t", ME)).at(-1)?.text === LOOP_RUNNING, 15_000);
  await cut();
  await until(async () => (await rhodium.state("w/a")) === settled, 15_000);
  await Bun.sleep(400); // past an edit's wait, so one more would be there by now
  const posts = await rhodium.im.log("t", ME);
  const shows = posts.filter((p) => p.messageId === posts[0]!.messageId).map((p) => p.text);
  expect(shows.slice(shows.indexOf(LOOP_RUNNING))).toEqual([LOOP_RUNNING, "开始跑循环。"]);
}, 30_000);

test("story 40: a turn rh send me took over, then cut short by rh stop, ends its message with none of what the agent said after it", async () => {
  const steps: Step[] = [
    ...startTurn,
    toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
    { sleep: 300 },
    { rh: ["send", "me", "测试接管"] },
    toolResult("toolu_send"),
    { emit: [textDelta("接管后说的话。")] },
    toolUse("toolu_wait", "Bash", { command: "sleep 600" }),
    { wait: { type: "control_request", request: { subtype: "interrupt" } } },
  ];
  await telegram({ claude: { script: { on, steps } } });
  await say("go");
  await lastShows("[🔧 Bash] sleep 600，正在运行");
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await Bun.sleep(400); // past an edit's wait, so one more would be there by now
  expect(messages(await rhodium.im.log("t", ME))).toEqual(["[🔧 Bash] rh send me 测试接管", "测试接管", "[🔧 Bash] sleep 600"]);
}, 30_000);

test.each([
  ["telegram", "Use `Vec<T>`, not Vec&lt;T>, for \\$5."],
  ["qq", "Use `Vec<T>`, not Vec<T>, for $5."],
] as const)("story 73: the reply goes out in %s's Markdown too, for the adapter to send, with the plain text to fall back on", async (like, md) => {
  const reply = "Use `Vec<T>`, not Vec<T>, for $5.";
  rhodium = newInstance({ bots: { b: { like, owner: ME, target: "w/a" } }, claude: { script: { on, steps: [...startTurn, ...endTurn(reply), { goto: 0 }] } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("b", { chat: ME, sender: ME, text: "hi" });
  const [post] = await lastShows(reply, "b");
  expect(post).toMatchObject({ kind: "send", text: reply, markdown: md });
}, 30_000);

test("story 158: a QQ bot and a Telegram bot, both enabled, each take your message and reply in their own chat", async () => {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/b" } },
  });
  await rhodium.start();
  await rhodium.slots("a", "b");
  const q = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello from QQ" });
  await say("hello from Telegram");
  expect(await lastShows("fake reply", "q")).toMatchObject([{ kind: "send", text: "fake reply", replyTo: q.messageId }]);
  expect(await lastShows("fake reply", "t")).toMatchObject([{ kind: "send", text: "fake reply" }]);
}, 30_000);

/** 45 lines of 99 characters, 4,499 characters in all: over Telegram's 4,096. */
const LONG = Array.from({ length: 45 }, (_, i) => String(i % 10).repeat(99)).join("\n");

/** What each message the bot sent shows in the end, in the order they were sent. */
function messages(posts: Posted[]): string[] {
  const last = new Map<string, string>();
  for (const p of posts) if (p.kind === "send" || p.kind === "edit") last.set(p.messageId, p.text);
  return [...last.values()];
}

test("story 72: a turn outgrowing its message goes on in a new one, cut between parts, and a part alone too long at a line break", async () => {
  const lines = LONG.split("\n");
  const deltas = Array.from({ length: 9 }, (_, i) => lines.slice(i * 5, i * 5 + 5).join("\n") + (i < 8 ? "\n" : ""));
  const steps: Step[] = [...startTurn, toolCall("toolu_read", "Read", { file_path: "notes.txt" }), ...deltas.flatMap((t): Step[] => [{ sleep: 60 }, { emit: [textDelta(t)] }])];
  await telegram({ claude: { script: { on, steps: [...steps, ...endTurn(LONG), { goto: 0 }] } } });
  await say("write a lot");
  const posts = await lastShows(LONG.slice(4000));
  expect(posts.filter((p) => p.kind === "send")).toHaveLength(3);
  expect(posts.every((p) => p.text.length <= 4096)).toBe(true);
  expect(messages(posts)).toEqual(["[🔧 Read] notes.txt", LONG.slice(0, 3999), LONG.slice(4000)]);
}, 30_000);

test("story 72: when the turn ends right after its text outgrew the message, and the edit cutting that message down is turned down, its text comes in a new message all the same", async () => {
  const steps: Step[] = [...startTurn, toolCall("toolu_read", "Read", { file_path: "notes.txt" }), { emit: [textDelta(LONG)] }, ...endTurn(LONG), { goto: 0 }];
  await telegram({ claude: { script: { on, steps } } });
  await rhodium.im.next("t", "fail", "edit");
  await say("write a lot");
  const want = ["[🔧 Read] notes.txt，正在运行", LONG.slice(0, 3999), LONG.slice(4000), "[🔧 Read] notes.txt"];
  await until(async () => JSON.stringify(messages(await rhodium.im.log("t", ME))) === JSON.stringify(want), 10_000).catch(() => {});
  expect(messages(await rhodium.im.log("t", ME))).toEqual(want);
}, 30_000);

test("a child's report that comes while you wait for the reply to your message waits for that turn to end: the reply is to your message, and the report's turn sends none", async () => {
  const [report, , reportEnd] = endTurn("这条汇报说明切换成功了") as { emit: string[] }[];
  const [mine, , mineEnd] = endTurn("我是调度员。") as { emit: string[] }[];
  // Turn 1 runs the rh calls your message lists. Turn 2 answers you and takes 3 s; a user frame written
  // meanwhile is answered within it, as the CLI runs a frame queued mid-turn before it goes idle
  // (architecture §6.2). One written once it is idle starts turn 3.
  const parent: Script = {
    on: [{ match: { type: "user" }, emit: [...report!.emit, reportEnd!.emit[0]!] }, ...on!],
    steps: [
      ...startTurn,
      { rhFrom: "in.message.content.0.text" },
      ...endTurn("done"),
      ...startTurn,
      { emit: [textDelta("我是调度员。"), ...mine!.emit] },
      { sleep: 3000 },
      mineEnd!,
      ...startTurn,
      ...endTurn("这条汇报说明切换成功了"),
    ],
  };
  // The child pi takes 2 s, so it is done while the parent answers your second message.
  const pi = builtins["pi-turn"]!;
  const slow: Script = { on: pi.on, steps: [...pi.steps.slice(0, 3), { sleep: 2000 }, ...pi.steps.slice(3)] };
  await telegram({ claude: { script: parent }, pi: { script: slow } });
  await say(JSON.stringify([["spawn", "c", "--agent", "pi", "do it"]]));
  await lastShows("done");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await say("你现在是谁？");
  const reports = () =>
    rhodium.claude
      .runs()
      .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
      .filter((m) => m.type === "user" && String(m.message.content[0].text).startsWith(REPORT_LINE));
  await until(async () => reports().length === 1 && (await rhodium.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(1500); // an edit would go out by now, at the chat's pace
  expect(messages(await rhodium.im.log("t", ME))).toEqual(["done", "我是调度员。"]);
}, 45_000);
