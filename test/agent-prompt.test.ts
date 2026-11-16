// What Rhodium tells the agent (architecture §6.1), seen from seam one: what stays the same is in
// the system prompt file the agent is launched with; where a message came from is its first line.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { agentBaseEnv } from "../src/runner";
import { newInstance, until, withoutSource, type Instance } from "./instance";
import { feishuCapabilities } from "../src/feishu";
import { systemPrompt } from "../src/prompt";
import { helpText, skillText } from "../src/commands";
import { chatOf, sendWord } from "../src/router";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium?.cleanup());

/** Slot w/a, the target of a QQ-like bot q and a Telegram-like bot t. */
async function begin(toml?: string): Promise<void> {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } },
    toml,
  });
  await rhodium.start();
  await rhodium.slots("a");
}

/** The text of every user frame the fake claude got, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => m.message.content[0].text as string);

test("story 7: the agent is launched with an appended system prompt: rh's usage, the reply conventions, each bot's format limits", async () => {
  await begin();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => asked().length === 1, 15_000);

  const [run] = rhodium.claude.runs();
  const file = run!.argv[run!.argv.indexOf("--append-system-prompt-file") + 1]!;
  const prompt = readFileSync(file, "utf8");
  // rh's usage, word for word as rh --skill prints it, but for the time it reads from the config (story 100).
  expect(prompt).toContain((await rhodium.rh(["--skill"])).out.replaceAll("结束一段时间后自动归档（默认 24 小时）", "结束 24 小时后自动归档"));
  // The reply conventions (product §5.5): the final reply goes back by itself, unless rh send me was
  // used. Text found only in that section: rh's usage says "最终回复" and "rh send me" too.
  expect(prompt).toContain("## 回复约定");
  expect(prompt).toContain("你的最后一条回复就是最终回复");
  // Progress goes in the reply, which reaches the user as it is written (round 14); rh send me is
  // for files and what a turn nobody waits on has to tell them.
  expect(prompt).toContain("你说的话会实时转给用户，进度直接写在回复里");
  // Nor in rh's usage, which the prompt carries whole.
  expect(prompt).not.toContain("发文件、图片");
  expect(prompt).toContain("`rh send me` 是往用户的 IM 推一条通知，只用来发文件，以及在内部回合里告诉用户事。");
  expect(prompt).not.toContain("里程碑");
  // What rh send me with words, to the turn's chat, takes over; tool lines still show; a file alone takes nothing over (docs/im-style.md §3.4).
  expect(prompt).toContain("带文字的 `rh send me` 发到了这个回合的窗口，Rhodium 就不再转发你这个回合后面说的话（工具行照常显示）");
  expect(prompt).toContain("只发文件、不带文字的不算。");
  // Your message joining the turn after it, or your answer to its ask in IM, lifts that: what it says next and the final reply go out again (#234, #237).
  expect(prompt).toContain("之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，你后面说的话和最终回复照常转发。");
  expect((await rhodium.rh(["--skill"])).out).toContain("不再代发这个回合的最终回复；之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，照常代发。");
  // rh send me is a push to IM, not while you watch the board (story 597).
  expect(prompt).toContain("`rh send me` 推到现在指着你的窗口里用户最近用的那个，都没有就推到主窗口。");
  expect(prompt).not.toContain("你选不了");
  // A turn something else began sends its reply to no chat.
  expect(prompt).toContain("别的消息开始的回合，最终回复不发回 IM。要让用户知道，用 `rh send me`。");
  // A message of yours that reaches it late says when you sent it (2026-10-23).
  expect(prompt).toContain("用户的消息发出后超过 5 分钟才交给你的（例如排队等额度），这一行还写发送时间，例如 [来自 QQ 私聊，发送于 21:05]；不是当天的写成 [来自 QQ 私聊，发送于 10-22 21:05]。");
  // The format limits of each bot, from its capability table, under the name its private chat goes
  // by in the first line of a message from it (2026-10-23).
  expect(prompt).toMatch(/^- 假 IM Bot q 的私聊（`rh send q`）：.*2000 字.*Markdown；行首 # 后不带空格的写法会按原文显示。/m);
  expect(prompt).toMatch(/^- 假 IM Bot t 的私聊（`rh send t`）：.*4096 字.*Markdown.*HTML/m);
}, 30_000);

test("story 100: the agent is told a one-off child is archived the configured time after its last turn ends, and that 回收时长 only stops the process", async () => {
  await begin('[durations]\noneoffArchive = "2h"');
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => asked().length === 1, 15_000);
  const [run] = rhodium.claude.runs();
  const prompt = readFileSync(run!.argv[run!.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8");
  const line = (cmd: string) => prompt.split("\n").find((l) => l.startsWith(`- \`rh ${cmd} `))!;
  expect(line("spawn")).toContain("默认一次性：最后一个回合结束 2 小时后自动归档；--longterm 一直保留");
  expect(line("set")).toContain("oneoff（一次性：最后一个回合结束 2 小时后自动归档）");
  // A slot's details say 回收时长 1h: that is how long it idles before its process stops, the slot kept.
  expect(line("set")).toContain("reap（回收时长：空闲多久停掉进程，槽位还在，不是归档）");
  // rh --help and rh --skill print with no config to read: the default, said as such.
  for (const flag of ["--help", "--skill"]) {
    const out = (await rhodium.rh([flag])).out;
    expect(out).toContain("默认一次性：最后一个回合结束一段时间后自动归档（默认 24 小时）；");
    expect(out).toContain("oneoff（一次性：最后一个回合结束一段时间后自动归档（默认 24 小时））");
  }
}, 30_000);

/** Slot w/a, the target of a QQ-like bot q alone, whose agent program is gone for a moment as your
 *  "hi" comes, so the message waits for the start (as in program-wait.test.ts); returns what the agent got. */
async function waited(durations: string, at?: number): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `[durations]\nprogramWait = "10s"\n${durations}`, env: { TZ: "UTC" } });
  await rhodium.start();
  await rhodium.slots("a");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi", at });
  await Bun.sleep(1500);
  renameSync(`${claude}.updating`, claude);
  await until(() => asked().length === 1, 15_000);
  return asked()[0]!;
}

/** 10-22 and 21:05 in UTC, the time zone waited() runs rhodium in. */
const utc = (at: number) => ({ date: new Date(at).toISOString().slice(5, 10), time: new Date(at).toISOString().slice(11, 16) });

test("your message that waited longer than durations.sentAtAfter by the time the agent gets it says when you sent it, the date too if not today (2026-10-23)", async () => {
  const sent = Date.now(); // when the message says it was sent: before the instance starts, which may cross a minute (#575)
  expect(await waited('sentAtAfter = "1s"', sent)).toBe(`[来自 假 IM 私聊，发送于 ${utc(sent).time}]\nhi`);
  // Sent two days ago, say kept by the platform while Rhodium was down: it says the day.
  const old = sent - 2 * 86_400_000;
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again", at: old });
  await until(() => asked().length === 2, 15_000);
  expect(asked()[1]).toBe(`[来自 假 IM 私聊，发送于 ${utc(old).date} ${utc(old).time}]\nagain`);
  expect(withoutSource(asked()[1]!)).toBe("again"); // as /resume shows a conversation's start
}, 30_000);

test("your message that waited, but less than 5 minutes, has the plain first line (2026-10-23)", async () => {
  expect(await waited("")).toBe("[来自 假 IM 私聊]\nhi");
  // The one bot on its platform: its format limits go by the chat's name as that line has it.
  const [run] = rhodium.claude.runs();
  expect(readFileSync(run!.argv[run!.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toMatch(/^- 假 IM 私聊（`rh send q`）：.*2000 字/m);
}, 30_000);

test("story 8: each message of yours reaches the agent with a first line naming the chat it came through as you call it, never by its id", async () => {
  await begin();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => asked().length === 1, 15_000);
  await rhodium.im.inject("t", { chat: "tg-chat", sender: ME, text: "again,\non two lines" });
  await until(() => asked().length === 2, 15_000);
  // Two bots on one platform: each is named. No chat id, no openid.
  expect(asked()).toEqual(["[来自 假 IM Bot q 的私聊]\nhello", "[来自 假 IM Bot t 的聊天窗口]\nagain,\non two lines"]);
}, 30_000);

test("story 457: the system prompt tells the agent a Feishu chat's limits: 4000 characters, Markdown, its HTML tags and :name: shown as written", () => {
  const prompt = systemPrompt([{ chat: "飞书私聊", send: "feishu", caps: feishuCapabilities(3000) }], 86_400_000, 300_000);
  expect(prompt).toContain("- 飞书私聊（`rh send feishu`）：一条消息最多 4000 字，更长的自动分成几条；可以用 Markdown；HTML 标签、:表情名:的写法会按原文显示。");
});

const BOTS = [{ chat: "QQ Bot echo 的私聊", send: "echo", caps: feishuCapabilities(3000) }];

test("story 597: a slot that is no child is told rh send me is a push to IM, when it is not pushed, the destinations it may name, each bot's among them, the receipt, to report on a timer of its own, and that its children can't write to you; nothing of rh send web", () => {
  const prompt = systemPrompt(BOTS, 86_400_000, 300_000);
  expect(prompt).toContain("- QQ Bot echo 的私聊（`rh send echo`）：");
  expect(prompt).toContain("- `rh send me` 是往用户的 IM 推一条通知，只用来发文件，以及在内部回合里告诉用户事。");
  // Pictures go in the reply, which IM now sends (story 595); a child's prompt says so too.
  const pictures = "要给用户看的图片，在回复里写 `![说明](绝对路径)`。只认你的目录和 /tmp 里的图片文件；发到 IM 时一条回复最多带 10 张。";
  expect(prompt).toContain(`- ${pictures}要给用户文件，用 \`rh send me --file <路径>\`。\n`);
  expect(systemPrompt(BOTS, 86_400_000, 300_000, true)).toContain(`- ${pictures}\n`);
  expect(prompt).toContain("用户最后是在网页上给你说话、网页又开在前台时不推，回执会写明。");
  expect(prompt).toContain("指定的地方发不出去，改照 `rh send me` 的规则发。");
  expect(prompt).toContain("- 回执写明推到了哪、有没有改发、有没有推，照回执告诉用户，不要自己猜。");
  expect(prompt).toContain("这个要求在这段对话里一直有效：你自己定时、读进度，到点用 `rh send` 发，每次都带上去处。");
  expect(prompt).toContain("- 别的消息开始的回合，最终回复不发回 IM。要让用户知道，用 `rh send me`。\n");
  expect(prompt).toContain("- 你派生的子槽位不能直接给用户发消息。它的结果随汇报交给你，由你决定告诉用户什么。\n- 用用户的语言回复。");
  expect(prompt).toContain("进度直接写在回复里。不要往同一个窗口用 `rh send me` 发文字");
  expect(prompt).toContain("用户发起或插过话的回合，子槽位跑完也不汇报。");
  for (const text of [prompt, skillText(), helpText()]) {
    expect(text).not.toContain("rh send web");
    expect(text).not.toContain("me|web");
    expect(text).not.toContain("你有父槽位");
  }
  expect(skillText()).toContain("rh send me|<平台>|<Bot 名> [--file <路径>]...");
  expect(skillText()).toContain("不要往同一个窗口用 rh send me 发文字。");
});

test("story 597: a child slot's prompt, skill and help say nothing of sending you words, nor of a platform's or a bot's word: results go in its final reply, a file alone when you ask it directly", () => {
  const prompt = systemPrompt(BOTS, 86_400_000, 300_000, true);
  expect(prompt).toContain("你是 Rhodium 托管的无头 agent，是别的槽位派生的子槽位。用户看不到你的终端输出。");
  expect(prompt).toContain("- 用户直接找你要文件时，用 `rh send me --file <路径>` 发，不带文字。");
  expect(prompt).toContain("- 用户要你定期汇报时，这个要求在这段对话里一直有效：你自己定时、读进度，到点把进度写在最终回复里。\n- 用用户的语言回复。");
  expect(prompt).toContain("- QQ Bot echo 的私聊：一条消息最多");
  expect(prompt).toContain("和消息第一行的写法一样：");
  expect(prompt).toContain("用户发起或插过话的回合，子槽位跑完也不汇报。");
  for (const text of [prompt, skillText(undefined, true), helpText(true)]) {
    expect(text).toContain("rh send me --file <路径>... | <工作区/槽位> <文字>");
    for (const word of ["rh send echo", "rh send qq", "rh send telegram", "<Bot 名>", "rh send web", "推一条通知"]) expect(text).not.toContain(word);
  }
});

test("story 597: rh --help and rh --skill are the child slot's with RHODIUM_CHILD=1, as a child's process is started; else the other's", async () => {
  const run = async (arg: string, env: Record<string, string>) => {
    const p = Bun.spawn([process.execPath, "src/main.ts", "rh", arg], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env }, stdout: "pipe" });
    return await new Response(p.stdout).text();
  };
  expect(await run("--skill", { RHODIUM_CHILD: "1" })).toBe(skillText(undefined, true));
  expect(await run("--help", { RHODIUM_CHILD: "1" })).toBe(helpText(true));
  expect(await run("--skill", { RHODIUM_CHILD: "" })).toBe(skillText());
});

test("story 597: a rhodium started from a child slot's shell does not hand its RHODIUM_CHILD down to every agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-env-"));
  process.env.RHODIUM_CHILD = "1";
  try {
    expect(agentBaseEnv({ stateDir: dir, agentPath: "/bin" } as Config).RHODIUM_CHILD).toBeUndefined();
  } finally {
    delete process.env.RHODIUM_CHILD;
    rmSync(dir, { recursive: true });
  }
});

test("story 576: a bot named for another platform, one of several on its own, has no word of rh send's that reaches it, and the system prompt gives none", () => {
  const config = { bots: { qq: { platform: "telegram" as const }, t: { platform: "telegram" as const }, q: { platform: "qq" as const } } };
  expect([sendWord(config, { name: "qq", platform: "telegram" }), sendWord(config, { name: "t", platform: "telegram" }), sendWord(config, { name: "q", platform: "qq" })]).toEqual([null, "t", "qq"]);
  const prompt = systemPrompt([{ chat: "Telegram Bot qq 的私聊", send: null, caps: feishuCapabilities(3000) }], 86_400_000, 300_000);
  expect(prompt).toContain("- Telegram Bot qq 的私聊：一条消息最多");
});

test("#598: a bot taken out of the config, its row still kept, no longer makes its platform's other bot go by name", async () => {
  // Feishu's one bot left in the config is 飞书私聊; the one gone, should it come up, keeps its name.
  const config = { bots: { kept: { platform: "feishu" as const } } };
  expect(chatOf(config, { name: "kept", platform: "feishu" }, "私聊")).toBe("飞书私聊");
  expect(chatOf(config, { name: "gone", platform: "feishu" }, "私聊")).toBe("飞书 Bot gone 的私聊");

  // Through rhodium: bot t's row stays after its [bots.t] table goes, so the database has two bots of
  // the fake platform and the config one. The source line and the system prompt both call q's chat 假 IM 私聊.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.stop();
  const toml = readFileSync(rhodium.config, "utf8");
  writeFileSync(rhodium.config, toml.slice(0, toml.indexOf("[bots.t]")));
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => asked().length === 1, 15_000);
  expect(asked()).toEqual(["[来自 假 IM 私聊]\nhello"]);
  const [run] = rhodium.claude.runs();
  const prompt = readFileSync(run!.argv[run!.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8");
  expect(prompt).toMatch(/^- 假 IM 私聊（`rh send q`）：.*2000 字/m);
  expect(prompt).not.toContain("Bot q");
}, 30_000);

test("story 609: both headless prompts tell the agent a decision on its confirm request comes with its own source line", () => {
  const line = "你发起的确认请求有了结果，Rhodium 发来一条消息，第一行是 [来自 Rhodium：确认结果]。";
  expect(systemPrompt(BOTS, 86_400_000, 300_000)).toContain(`${line}\n`);
  expect(systemPrompt(BOTS, 86_400_000, 300_000, true)).toContain(`${line}\n`);
});

test("stories 616, 630: the terminal's prompt says it runs in Herdr's terminal, that a message with no source line is typed by you there, how Rhodium's typed ones start, and to answer other slots with rh send; of replies going back to IM, only the exception for your IM message's turn", () => {
  const prompt = systemPrompt(BOTS, 86_400_000, 300_000, false, true);
  expect(prompt).toContain("你是 Rhodium 托管的 agent，现在在 Herdr 的终端里运行（TUI 模式）。用户可能就坐在终端前，也可能不在电脑前。\n");
  expect(prompt).toContain("切到终端以后，没有来源行的消息是用户在终端里亲手打的。Rhodium 也会往你的输入框里打字，");
  expect(prompt).toContain("这些消息的第一行永远是 [来自 …]。别的槽位和子槽位发来的请求，按平时的判断照做；只是它们不算用户的同意或批准，需要用户点头的事（例如要确认的命令、改用户的配置）不能拿它们当依据。确认结果里");
  expect(prompt).not.toContain("不是用户的话");
  expect(prompt).toContain("第一行是 [来自 用户的终端，经 rh send] 的，是用户在自己的终端里用 rh send 发的。长的消息可能整条包在粘贴标签（<pasted_content>）里，这时照标签里第一行的来源行处理，和没包时一样。\n\n");
  // Story 617: the same whether type-in is on or off, as it may change while the agent runs.
  expect(prompt).toContain("第一行是 [来自 QQ 私聊]、[来自 网页] 这类窗口名的，是用户在 IM、网页上发的，切到终端以前、以后都有：Rhodium 也把用户从 IM、网页发的消息打进你的输入框。图片和文件只给了路径，每个一行，要看就按路径读。\n");
  expect(prompt).toContain("别的槽位用 rh send 发来的消息，第一行是 [来自 槽位 w/a，经 rh send] 这样，回它就用 rh send w/a。");
  expect(prompt).toContain("Rhodium 发来一条汇报，第一行是 [来自 Rhodium：子槽位汇报]。");
  expect(prompt).toContain(
    "## 回复约定\n\n- 你在终端里说的话只在终端和网页上看得到，不发到 IM，也不汇报给父槽位。用户在终端前时，直接回答就行。\n- 例外：用户从 IM 发来的消息（第一行是 [来自 QQ 私聊] 这类 IM 窗口名）开始或并进的回合，你说的话 Rhodium 会实时转回那个窗口，最终回复也会发过去，和无头时一样。进度和结果直接写在回复里，不要再用 rh send 往同一个窗口发文字：那样会停掉这一回合后面的转发和最终回复。\n- 别的槽位发来的消息要回，用 `rh send <工作区/槽位>`。\n- 要让不在电脑前的用户知道事，用 `rh send me`。\n- `rh send me` 是往用户的 IM 推一条通知，",
  );
  expect(prompt).toContain("- 你派生的子槽位不能直接给用户发消息。");
  expect(prompt).toContain("- QQ Bot echo 的私聊（`rh send echo`）：");
  for (const gone of ["托管的无头 agent", "用户从 IM 发来的消息开始的回合", "用户从网页发来的消息开始的回合", "- 别的消息开始的回合", "- 这样的回合里", "在一个回合里用带文字的", "没有这一行的消息不是用户从 IM 发的"]) expect(prompt).not.toContain(gone);
});

test("stories 616, 630: a child slot's terminal prompt says it is a child, that the task rh spawn gave it is its parent's, and holds the three terminal conventions, the exception among them, files, language and pictures alone", () => {
  const prompt = systemPrompt(BOTS, 86_400_000, 300_000, true, true);
  expect(prompt).toContain("你是 Rhodium 托管的 agent，是别的槽位派生的子槽位，现在在 Herdr 的终端里运行（TUI 模式）。");
  expect(prompt).toContain("要看就按路径读。\nrh spawn 交给你的任务没有来源行，是父槽位写的，不是用户发的。\n");
  const conventions = prompt.slice(prompt.indexOf("## 回复约定"), prompt.indexOf("## 各 Bot"));
  expect(conventions.split("\n").filter((l) => l.startsWith("- "))).toEqual([
    "- 你在终端里说的话只在终端和网页上看得到，不发到 IM，也不汇报给父槽位。用户在终端前时，直接回答就行。",
    "- 例外：用户从 IM 发来的消息（第一行是 [来自 QQ 私聊] 这类 IM 窗口名）开始或并进的回合，你说的话 Rhodium 会实时转回那个窗口，最终回复也会发过去，和无头时一样。进度和结果直接写在回复里，不要再用 rh send 往同一个窗口发文字：那样会停掉这一回合后面的转发和最终回复。",
    "- 别的槽位发来的消息要回，用 `rh send <工作区/槽位>`。",
    "- 用户直接找你要文件时，用 `rh send me --file <路径>` 发，不带文字。",
    "- 用用户的语言回复。",
    "- 要给用户看的图片，在回复里写 `![说明](绝对路径)`。只认你的目录和 /tmp 里的图片文件；发到 IM 时一条回复最多带 10 张。",
  ]);
  expect(prompt).toContain("- QQ Bot echo 的私聊：一条消息最多");
  for (const gone of ["托管的无头 agent", "推一条通知", "要让不在电脑前的用户知道事", "rh send echo"]) expect(prompt).not.toContain(gone);
});
