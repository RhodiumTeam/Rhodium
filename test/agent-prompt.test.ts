// What Rhodium tells the agent (architecture §6.1), seen from seam one: what stays the same is in
// the system prompt file the agent is launched with; where a message came from is its first line.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, renameSync } from "node:fs";
import { newInstance, until, withoutSource, type Instance } from "./instance";
import { feishuCapabilities } from "../src/feishu";
import { systemPrompt } from "../src/prompt";

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
  // for files, pictures and what a turn nobody waits on has to tell them.
  expect(prompt).toContain("你说的话会实时转给用户，进度直接写在回复里");
  expect(prompt).toContain("`rh send me` 只用来发文件、图片，以及内部回合");
  expect(prompt).not.toContain("里程碑");
  // What rh send me with words, to the turn's chat, takes over; tool lines still show; a file alone takes nothing over (docs/im-style.md §3.4).
  expect(prompt).toContain("带文字的 `rh send me` 发到了这个回合的窗口，Rhodium 就不再转发你这个回合后面说的话（工具行照常显示）");
  expect(prompt).toContain("只发文件、不带文字的不算。");
  // Your message joining the turn after it, or your answer to its ask in IM, lifts that: what it says next and the final reply go out again (#234, #237).
  expect(prompt).toContain("之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，你后面说的话和最终回复照常转发。");
  expect((await rhodium.rh(["--skill"])).out).toContain("不再代发这个回合的最终回复；之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，照常代发。");
  // Where rh send me lands is Rhodium's to pick, not the agent's: it promises no platform (2026-10-22).
  expect(prompt).toContain("`rh send me` 发到现在指着你的窗口里用户最近用的那个，没有就发主窗口，由 Rhodium 定，你选不了。不要向用户承诺发到某个平台");
  expect((await rhodium.rh(["--skill"])).out).toContain("没有窗口指着你时，子槽位用指着根槽位的窗口，再没有就发主窗口");
  // A turn something else began sends its reply to no chat; a child's goes, its start, to its parent (architecture §9.3).
  expect(prompt).toContain("别的消息开始的回合，最终回复不发回 IM；你是子槽位时，它的开头会随汇报交给父槽位。");
  // A message of yours that reaches it late says when you sent it (2026-10-23).
  expect(prompt).toContain("用户的消息发出后超过 5 分钟才交给你的（例如排队等额度），这一行还写发送时间，例如 [来自 QQ 私聊，发送于 21:05]；不是当天的写成 [来自 QQ 私聊，发送于 10-22 21:05]。");
  // The format limits of each bot, from its capability table, under the name its private chat goes
  // by in the first line of a message from it (2026-10-23).
  expect(prompt).toMatch(/^- 假 IM Bot q 的私聊：.*2000 字.*Markdown；行首 # 后不带空格的写法会按原文显示。/m);
  expect(prompt).toMatch(/^- 假 IM Bot t 的私聊：.*4096 字.*Markdown.*HTML/m);
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
async function waited(durations: string): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `[durations]\nprogramWait = "10s"\n${durations}`, env: { TZ: "UTC" } });
  await rhodium.start();
  await rhodium.slots("a");
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await Bun.sleep(1500);
  renameSync(`${claude}.updating`, claude);
  await until(() => asked().length === 1, 15_000);
  return asked()[0]!;
}

/** 10-22 and 21:05 in UTC, the time zone waited() runs rhodium in. */
const utc = (at: number) => ({ date: new Date(at).toISOString().slice(5, 10), time: new Date(at).toISOString().slice(11, 16) });

test("your message that waited longer than durations.sentAtAfter by the time the agent gets it says when you sent it, the date too if not today (2026-10-23)", async () => {
  const sent = Date.now();
  expect(await waited('sentAtAfter = "1s"')).toBe(`[来自 假 IM 私聊，发送于 ${utc(sent).time}]\nhi`);
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
  expect(readFileSync(run!.argv[run!.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toMatch(/^- 假 IM 私聊：.*2000 字/m);
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
  const prompt = systemPrompt([{ chat: "飞书私聊", caps: feishuCapabilities(3000) }], 86_400_000, 300_000);
  expect(prompt).toContain("- 飞书私聊：一条消息最多 4000 字，更长的自动分成几条；可以用 Markdown；HTML 标签、:表情名:的写法会按原文显示。");
});
