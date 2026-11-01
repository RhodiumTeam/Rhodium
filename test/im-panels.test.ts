// Panels to pick from in IM (docs/im-style.md §7–§9, §11), seen from seam one: a command with no
// argument offers its candidates as buttons; Telegram walks the steps in one message, edited in place,
// QQ in a new message each step; a long list pages, numbered across pages, and a number replied picks.
import { afterEach, expect, test } from "bun:test";
import type { Posted } from "../src/fake-im";
import { asking, endTurn, on, saying, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium with a Telegram-like bot t and a QQ-like bot q, both sending your chat to w/a, and the
 *  slots w/<name> for each of names. */
async function start(names: string[], opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" }, q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  await rhodium.start();
  await rhodium.slots(...names);
}

const say = (bot: string, text: string) => rhodium.im.inject(bot, { chat: ME, sender: ME, text });
const press = (bot: string, message: Posted, label: string) => rhodium.im.press(bot, ME, message, label);

/** What each message in your chat shows now, once there are n. */
async function shown(bot: string, n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.shown(bot, ME)).length >= n, 15_000);
  return rhodium.im.shown(bot, ME);
}

/** The message's buttons, row by row, as their labels. */
const rows = (p: Posted) => {
  const out: string[][] = [];
  p.buttons?.forEach((b, i) => (i > 0 && b.row !== undefined && b.row === p.buttons![i - 1]!.row ? out.at(-1)!.push(b.label) : out.push([b.label])));
  return out;
};

/** Waits until the message reads text. */
async function reads(bot: string, i: number, text: string | RegExp): Promise<Posted> {
  const is = (t: string | undefined) => (typeof text === "string" ? t === text : text.test(t ?? ""));
  await until(async () => is((await rhodium.im.shown(bot, ME))[i]?.text), 15_000).catch(async () => expect((await rhodium.im.shown(bot, ME))[i]?.text).toMatch(text));
  return (await rhodium.im.shown(bot, ME))[i]!;
}

/** The slots the fake claude ran for. */
const ranIn = () => rhodium.claude.runs().map((r) => r.env.RHODIUM_SLOT?.split("/")[1]);

test("§9.2 on Telegram: /rh_use offers the default and the other slots; a press picks one in place, and the chat goes to it", async () => {
  await start(["a", "b"]);
  await say("t", "/rh_use");
  const [panel] = await shown("t", 1);
  expect(panel!.text).toBe("这里的消息交给谁？\n现在：w/a");
  expect(rows(panel!)).toEqual([["✓ 默认（w/a）", "w/b"], ["取消"]]);
  await press("t", panel!, "w/b");
  const picked = await reads("t", 0, "这里的消息交给谁？\n已选：w/b");
  expect(picked.buttons ?? []).toEqual([]);
  await say("t", "hello b");
  await until(() => ranIn().includes("b"), 15_000);
}, 30_000);

test("story 31, §9.2 on QQ: each step is a new message, the slot in use marked ★, as ✓ there shows on a button you pressed; 回到默认 goes back to the bot's default", async () => {
  await start(["a", "b"]);
  await say("q", "/rh_use");
  await press("q", (await shown("q", 1))[0]!, "w/b");
  expect((await reads("q", 1, "这里的消息改交给 w/b。")).buttons).toBeUndefined();
  await say("q", "/rh_use");
  const again = (await shown("q", 3))[2]!;
  expect(again.text).toBe("这里的消息交给谁？\n现在：w/b");
  expect(rows(again)).toEqual([["回到默认（w/a）", "★ w/b"], ["取消"]]);
  await press("q", again, "回到默认（w/a）");
  await reads("q", 3, "这里改回默认，消息交给 w/a。");
  await say("q", "hello a");
  await until(() => ranIn().includes("a"), 15_000);
}, 30_000);

test("§9.2, §11.4: a long list pages, numbered across pages; a number replied picks from the latest panel, and nothing else does", async () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  await start(names);
  await say("q", "/rh_use");
  const first = (await shown("q", 1))[0]!;
  expect(first.text).toBe("这里的消息交给谁？\n现在：w/a\n第 1 页，共 2 页。也可以回编号。");
  expect(rows(first)).toEqual([["★ 1. 默认（w/a）", "2. w/b"], ["3. w/c", "4. w/d"], ["5. w/e", "6. w/f"], ["7. w/g", "8. w/h"], ["下一页", "取消"]]);
  await press("q", first, "下一页");
  const second = (await shown("q", 2))[1]!;
  expect(second.text).toBe("这里的消息交给谁？\n现在：w/a\n第 2 页，共 2 页。也可以回编号。");
  expect(rows(second)).toEqual([["9. w/i", "10. w/j"], ["上一页", "取消"]]);
  await say("q", "10");
  await reads("q", 2, "这里的消息改交给 w/j。");
  // The panel is used up: a number now is a message for the agent.
  await say("q", "3");
  await until(() => ranIn().includes("j"), 15_000);
}, 30_000);

test.each(["q", "t"])("§11.4 on %s: a number picks from a paged panel only while it is this chat's last message: once the agent says something after it, a number is for the agent", async (bot) => {
  // On Telegram the turn's message is out before the panel: what the agent says after it is an edit of that one.
  const steps = [...startTurn, saying("先看一下。"), { sleep: 1500 }, ...endTurn("方案 1 还是 2？"), { goto: 0 }];
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"], { claude: { script: { on, steps } } });
  const asked = async () => (await rhodium.im.shown(bot, ME)).filter((p) => p.text.includes("方案 1 还是 2？")).length;
  await say(bot, "go");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say(bot, "/rh_use");
  await until(async () => (await asked()) === 1 && (await rhodium.state("w/a")) === "空闲", 15_000);
  await say(bot, "2");
  await until(async () => (await asked()) === 2, 15_000);
  expect((await rhodium.im.shown(bot, ME)).map((p) => p.text).join("\n")).not.toContain("w/b");
}, 30_000);

test("§11.4 on QQ: once you send a message after a paged panel, a number is for the agent, though the agent has said nothing yet", async () => {
  const steps = [...startTurn, { sleep: 5000 }, ...endTurn("好"), { goto: 0 }];
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"], { claude: { script: { on, steps } } });
  await say("q", "/rh_use");
  await shown("q", 1);
  await say("q", "hello");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("q", "9");
  const given = () =>
    rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text)));
  await until(() => given().includes("9"), 15_000);
  expect((await rhodium.im.shown("q", ME)).map((p) => p.text)).not.toContain("这里的消息改交给 w/i。");
}, 30_000);

test("§11.4: a command sent while a paged panel is open closes it: a number after it is for the agent", async () => {
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  await say("q", "/rh_use");
  await shown("q", 1);
  await say("q", "/rh_help");
  await shown("q", 2);
  await say("q", "9");
  await until(() => ranIn().includes("a"), 15_000);
  expect((await rhodium.im.shown("q", ME)).map((p) => p.text)).not.toContain("这里的消息改交给 w/i。");
}, 30_000);

test("§9.1 on Telegram: [取消] takes the panel's buttons off and writes it back, its page line gone; its numbers are void", async () => {
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  await say("t", "/rh_use");
  const panel = (await shown("t", 1))[0]!;
  expect(rows(panel).at(-1)).toEqual(["下一页", "取消"]);
  await press("t", panel, "取消");
  expect((await reads("t", 0, "这里的消息交给谁？\n现在：w/a\n已取消")).buttons ?? []).toEqual([]);
  await say("t", "9");
  await until(() => ranIn().includes("a"), 15_000);
}, 30_000);

test("§9.1 on Telegram: a paged /rh_ls left by [取消] or by a command typed loses its page line and 也可以回编号", async () => {
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  const list = `9 个槽位\n\nw（${rhodium.dir}/w）\n${["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((x, i) => `${i + 1}. ${x} 未运行`).join("\n")}\n\n`;
  await say("t", "/rh_ls");
  const panel = (await shown("t", 1))[0]!;
  expect(panel.text).toBe(`${list}这里的消息交给 w/a。点一个看详情，也可以回编号。第 1 页，共 2 页。`);
  // The numbers as written, no Markdown list (§8.2).
  expect(panel.markdown).toContain(`### w（\`${rhodium.dir}/w\`）  \n1\\. a 未运行  \n2\\. b 未运行`);
  await press("t", panel, "取消");
  await reads("t", 0, `${list}这里的消息交给 w/a。点一个看详情。\n已取消`);
  await say("t", "/rh_ls");
  await shown("t", 2);
  await say("t", "/rh_help");
  await reads("t", 1, `${list}这里的消息交给 w/a。点一个看详情。\n已取消`);
}, 30_000);

test("§9.1 on QQ: [取消] says so in a new message", async () => {
  await start(["a", "b"]);
  await say("q", "/rh_use");
  await press("q", (await shown("q", 1))[0]!, "取消");
  expect((await reads("q", 1, "已取消，没有改动。")).buttons).toBeUndefined();
}, 30_000);

test("§9.1: a command typed while a panel is open closes it: on Telegram as 取消 does; on QQ with no word of it", async () => {
  await start(["a", "b"]);
  await say("t", "/rh_use");
  await shown("t", 1);
  await say("t", "/rh_help");
  expect((await reads("t", 0, "这里的消息交给谁？\n现在：w/a\n已取消")).buttons ?? []).toEqual([]);
  await say("q", "/rh_use");
  await shown("q", 1);
  await say("q", "/rh_help");
  await shown("q", 2);
  await Bun.sleep(300); // nothing more comes
  expect(await rhodium.im.shown("q", ME)).toHaveLength(2);
}, 30_000);

test("§9.5 on Telegram: 取消 at /model's second step, or a command typed then, leaves the model picked, the level as it was", async () => {
  await start(["a"]);
  await say("t", "hello");
  await shown("t", 1);
  await say("t", "/model");
  await press("t", (await shown("t", 2))[1]!, "Haiku");
  await press("t", await reads("t", 1, "换哪个模型？\n已选：Haiku\n思考强度要改吗？"), "medium");
  await say("t", "/model");
  await press("t", (await shown("t", 3))[2]!, "✓ Haiku");
  const levels = await reads("t", 2, "换哪个模型？\n已选：Haiku\n思考强度要改吗？现在是 medium。");
  await press("t", levels, "取消");
  expect((await reads("t", 2, "换哪个模型？\n已选：Haiku，思考强度还是 medium")).buttons ?? []).toEqual([]);
  await say("t", "/model");
  await press("t", (await shown("t", 4))[3]!, "✓ Haiku");
  await reads("t", 3, "换哪个模型？\n已选：Haiku\n思考强度要改吗？现在是 medium。");
  await say("t", "/rh_help");
  expect((await reads("t", 3, "换哪个模型？\n已选：Haiku，思考强度还是 medium")).buttons ?? []).toEqual([]);
}, 30_000);

test("§9.1, §9.5: 取消 at /model's second step with no level set keeps the model picked and says no 已取消", async () => {
  await start(["a"]);
  await say("t", "hello");
  await shown("t", 1);
  await say("t", "/model");
  const levels = await press("t", (await shown("t", 2))[1]!, "Haiku").then(() => reads("t", 1, "换哪个模型？\n已选：Haiku\n思考强度要改吗？"));
  await press("t", levels, "取消");
  expect((await reads("t", 1, "换哪个模型？\n已选：Haiku")).buttons ?? []).toEqual([]);
  await say("q", "/model");
  await press("q", (await shown("q", 1))[0]!, "默认（Opus 5.5）");
  await press("q", await reads("q", 1, "已切到 默认（Opus 5.5）。\n思考强度要改吗？"), "取消");
  await reads("q", 2, "思考强度没改。");
  // Typed over, the step on Telegram reads the same.
  await say("t", "/model");
  await press("t", (await shown("t", 3))[2]!, "Haiku");
  await reads("t", 2, "换哪个模型？\n已选：Haiku\n思考强度要改吗？");
  await say("t", "/rh_help");
  expect((await reads("t", 2, "换哪个模型？\n已选：Haiku")).buttons ?? []).toEqual([]);
}, 30_000);

test("§11.4: with an ask waiting for you, a number replied answers it, not the paged panel", async () => {
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"], { claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  await say("q", "go");
  await until(async () => (await rhodium.state("w/a")) === "需要你", 15_000);
  await say("q", "/rh_use");
  await shown("q", 2);
  await say("q", "2");
  await reads("q", 2, "已拒绝。");
}, 30_000);

test("§11.4 on Telegram: a number replied to a paged panel picks in place", async () => {
  await start(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  await say("t", "/rh_bind");
  const panel = (await shown("t", 1))[0]!;
  expect(panel.text).toBe("这个 Bot 的默认槽位换成哪个？\n现在：w/a\n第 1 页，共 2 页。也可以回编号。");
  await say("t", "9");
  await reads("t", 0, "这个 Bot 的默认槽位换成哪个？\n已选：w/i");
}, 30_000);

test("§7, §9.5 on Telegram: /status's 换模型 turns it into /model's panel in place; a model, then a level, all in one message", async () => {
  await start(["a"]);
  await say("t", "hello");
  await shown("t", 1);
  await say("t", "/status");
  const status = (await shown("t", 2))[1]!;
  expect(status.text).toStartWith(`w/a\n空闲\n\n模型设置\nAgent：Claude Code\n模型：默认（Opus 5.5）\n\n状态\n目录：${rhodium.dir}/w`);
  expect(rows(status)).toEqual([["换模型", "思考强度"], ["压缩上下文", "开新对话"], ["取消"]]);
  await press("t", status, "换模型");
  const models = await reads("t", 1, "换哪个模型？\n现在：默认（Opus 5.5）");
  expect(rows(models)).toEqual([["✓ 默认（Opus 5.5）"], ["Haiku"], ["返回", "取消"]]);
  await press("t", models, "Haiku");
  const levels = await reads("t", 1, "换哪个模型？\n已选：Haiku\n思考强度要改吗？");
  expect(rows(levels)).toEqual([["low", "medium", "high"], ["返回", "取消"]]);
  await press("t", levels, "high");
  expect((await reads("t", 1, "换哪个模型？\n已选：Haiku，思考强度 high")).buttons ?? []).toEqual([]);
  await say("t", "/status");
  expect((await shown("t", 3))[2]!.text).toContain("\n模型：Haiku high\n");
}, 30_000);

test("story 56: /status as the first message of a new chat, its slot not running, comes with its buttons", async () => {
  await start(["a"]);
  await say("t", "/status");
  const status = (await shown("t", 1))[0]!;
  expect(status.text).toStartWith("w/a\n未运行，来消息就启动\n");
  expect(rows(status)).toEqual([["换模型", "思考强度"], ["压缩上下文", "开新对话"], ["取消"]]);
}, 30_000);

test("§9.5 on QQ: /model's steps are new messages; /effort alone is a row of levels", async () => {
  await start(["a"]);
  await say("q", "hello");
  await shown("q", 1);
  await say("q", "/model");
  await press("q", (await shown("q", 2))[1]!, "Haiku");
  const levels = await reads("q", 2, "已切到 Haiku。\n思考强度要改吗？");
  await press("q", levels, "medium");
  await reads("q", 3, "思考强度改成 medium。");
  await say("q", "/effort");
  const effort = await reads("q", 4, "思考强度改成哪档？\n现在：medium");
  expect(rows(effort)).toEqual([["low", "★ medium", "high"], ["取消"]]);
  await press("q", effort, "low");
  await reads("q", 5, "思考强度改成 low。");
  // 取消 at the second step: the model is switched already, the level stays.
  await say("q", "/model");
  await press("q", (await shown("q", 7))[6]!, "★ Haiku");
  const again = await reads("q", 7, "已切到 Haiku。\n思考强度要改吗？现在是 low。");
  expect(rows(again)).toEqual([["★ low", "medium", "high"], ["取消"]]);
  await press("q", again, "取消");
  await reads("q", 8, "思考强度还是 low。");
}, 30_000);

test("§8 on Telegram: /rh_ls groups the slots by workspace with their state; a slot's button shows its details and actions in place, with 返回", async () => {
  await start(["a", "b"]);
  await rhodium.ok("ws", "v", rhodium.dir);
  await rhodium.ok("new", "v/c", "--agent", "pi");
  await say("t", "/rh_ls");
  const list = (await shown("t", 1))[0]!;
  const text = `3 个槽位\n\nw（${rhodium.dir}/w）\na 未运行\nb 未运行\n\nv（${rhodium.dir}）\nc 未运行（pi）\n\n这里的消息交给 w/a。点一个看详情。`;
  expect(list.text).toBe(text);
  expect(rows(list)).toEqual([["w/a", "w/b"], ["v/c"], ["取消"]]);
  await press("t", list, "v/c");
  const detail = await reads("t", 0, `v/c\n未运行，来消息就启动\n用 pi。\n\n目录：${rhodium.dir}\n设置都是默认。`);
  // Story 409: its head as /status's, the slot's name a heading; the directory as code.
  expect(detail.markdown).toBe(`## v/c  \n未运行，来消息就启动  \n用 pi。\n\n目录：\`${rhodium.dir}\`  \n设置都是默认。`);
  expect(rows(detail)).toEqual([["交给这里", "切到 TUI"], ["归档"], ["返回", "取消"]]);
  await press("t", detail, "返回");
  await reads("t", 0, text);
  // An action runs its command on that slot.
  await press("t", detail, "归档");
  await until(async () => (await rhodium.ok("ls", "--all")).includes("（已归档）"), 15_000);
}, 30_000);

test("§9.4: /rh_agent offers the agents, the one now marked, and says what changing costs", async () => {
  await start(["a"]);
  await say("q", "/rh_agent");
  const panel = (await shown("q", 1))[0]!;
  expect(panel.text).toBe("w/a 换哪个 agent？\n现在：Claude\n换了会开一段新对话，旧对话发 /resume 能回去。");
  expect(rows(panel)).toEqual([["★ Claude", "pi"], ["Codex"], ["取消"]]);
  await press("q", panel, "pi");
  await reads("q", 1, "w/a 换成了 pi，下一条消息开始新对话。");
}, 30_000);

test("§9.1: picking the agent the slot has already, say on an old QQ panel, changes nothing: the conversation goes on", async () => {
  await start(["a"]);
  await say("q", "/rh_agent");
  const panel = (await shown("q", 1))[0]!;
  await press("q", panel, "pi");
  await reads("q", 1, "w/a 换成了 pi，下一条消息开始新对话。");
  await say("q", "hello");
  await reads("q", 2, "fake reply");
  await press("q", panel, "pi"); // still live: QQ cannot take it off (§11.3)
  await reads("q", 3, "w/a 本来就是 pi，没有改动。");
  await say("q", "again");
  await reads("q", 4, "fake reply");
  const prompts = rhodium.pi.runs().map((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "prompt").map((m) => withoutSource(m.message)));
  expect(prompts).toEqual([["hello", "again"]]);
}, 30_000);

test("§9.1: picking what /rh_use or /rh_bind has already says so and changes nothing", async () => {
  await start(["a", "b"]);
  await say("q", "/rh_use");
  const panel = (await shown("q", 1))[0]!;
  await press("q", panel, "★ 默认（w/a）");
  await reads("q", 1, "这里本来就跟着默认，消息交给 w/a，没有改动。");
  await press("q", panel, "w/b");
  await reads("q", 2, "这里的消息改交给 w/b。");
  await press("q", panel, "w/b");
  await reads("q", 3, "这里的消息本来就交给 w/b，没有改动。");
  await say("t", "/rh_bind");
  const bind = (await shown("t", 1))[0]!;
  await press("t", bind, "✓ w/a");
  await reads("t", 0, "这个 Bot 的默认槽位换成哪个？\n已选：w/a\n这个 Bot 的默认槽位本来就是 w/a，没有改动。");
}, 30_000);

test("§9.1 on Telegram: a pick from /status that cannot be done says why in place of the panel, its buttons off", async () => {
  await start(["a", "b"], { toml: "[limits]\nmaxRunning = 1" });
  await rhodium.ok("send", "w/b", "hi");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await say("t", "/status"); // a chat's first message gets no buttons: the chat is not on record yet
  await shown("t", 1);
  await say("t", "/status");
  await press("t", (await shown("t", 2))[1]!, "思考强度");
  const why = await reads("t", 1, "/effort 没做成，w/a 没能启动。发一条消息就能启动它（你的消息不受这个限制），之后再发 /effort。\n原因：同时运行的无头槽位已到上限 1 个");
  expect(why.buttons ?? []).toEqual([]);
  expect(await rhodium.im.shown("t", ME)).toHaveLength(2);
}, 30_000);

/** Waits until a message in your chat reads text, and returns it as it shows now. */
async function reading(bot: string, text: string): Promise<Posted> {
  const find = async () => (await rhodium.im.shown(bot, ME)).find((p) => p.text === text);
  await until(async () => (await find()) !== undefined, 15_000).catch(async () => expect((await rhodium.im.shown(bot, ME)).map((p) => p.text)).toContain(text));
  return (await find())!;
}

test("§9.4 on Telegram: picked mid-turn, the panel itself says what waits for the turn, under 已选, with only the button that cuts it short", async () => {
  await start(["a"], { claude: { script: "until-interrupted" } });
  await say("t", "work until stopped");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("t", "/rh_agent");
  const panel = await reading("t", "w/a 换哪个 agent？\n现在：Claude\n换了会开一段新对话，旧对话发 /resume 能回去。");
  const count = (await rhodium.im.shown("t", ME)).length;
  await press("t", panel, "pi");
  const picked = await reading("t", "w/a 换哪个 agent？\n已选：pi\nw/a 这一回合还没跑完，跑完就换成 pi，下一条消息开始新对话。");
  expect(picked.messageId).toBe(panel.messageId);
  expect(rows(picked)).toEqual([["打断，马上换"]]);
  expect(await rhodium.im.shown("t", ME)).toHaveLength(count);
  await press("t", picked, "打断，马上换");
  await reading("t", "已打断 w/a 这一回合，停下就换成 pi，下一条消息开始新对话。");
  await until(async () => (await rhodium.ok("ls")).match(/^w\/a +pi +/m) !== null, 15_000);
}, 30_000);

test("§8.3 on QQ: a running slot's details offer 停止, which stops that slot's turn, though this chat goes to another", async () => {
  await start(["a", "b"], { claude: { script: "until-interrupted" } });
  await rhodium.ok("send", "w/b", "count to a million");
  await until(async () => (await rhodium.state("w/b")) === "运行中", 15_000);
  await say("q", "/rh_ls w/b");
  const detail = await reads("q", 0, new RegExp(`^w/b\n运行中，这一回合跑了 \\d+ 秒\n用 Claude。\n\n目录：${rhodium.dir}/w\n设置都是默认。$`));
  expect(rows(detail)).toEqual([["交给这里", "切到 TUI"], ["停止"], ["取消"]]);
  await press("q", detail, "停止");
  await reads("q", 1, "已停下这一回合，对话留着。");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
}, 30_000);

test("story 65, §10.2: a /rh_ command given arguments it does not take answers with an example as you write it in chat, never rh's usage or an English error", async () => {
  await start(["a"]);
  const said: [string, string][] = [
    ["/rh_release !", "/rh_release 后面只写槽位，例如 /rh_release w/a；不写就是这里的槽位。"],
    ["/rh_release w/a --force", "/rh_release 后面只写槽位，例如 /rh_release w/a；不写就是这里的槽位。"],
    ["/rh_tui w/a x", "/rh_tui 后面写槽位，例如 /rh_tui w/a；不写就是这里的槽位，加 ! 先打断当前回合。"],
    ["/rh_agent pi x", "/rh_agent 后面写 agent，例如 /rh_agent pi；加 ! 先打断当前回合。"],
    ["/rh_ls w/a w/a", "/rh_ls 后面只写一个槽位，例如 /rh_ls w/a；不写就列出所有槽位，加 --all 连已归档的也列出。"],
    ["/rh_import --foo", "/rh_import 后面写对话 ID 或 pane ID，例如 /rh_import w1:p1 --name review；不写就列出可以导入的。"],
    ["/rh_archive w/a w/a", "/rh_archive 后面只写槽位，例如 /rh_archive w/a；不写就列出槽位让你选。"],
    ["/rh_use w/a w/a", "/rh_use 后面写槽位，例如 /rh_use w/a；写 - 回到默认。"],
  ];
  for (const [i, [command, reply]] of said.entries()) {
    await say("q", command);
    await reads("q", i, reply);
  }
}, 30_000);

test("story 23, §9.8 on Telegram: /rh_archive alone offers the slots not archived; a press archives that one, as /rh_archive with it does", async () => {
  await start(["a", "b", "c"]);
  await rhodium.ok("archive", "w/c");
  await say("t", "/rh_archive");
  const panel = await reads("t", 0, "归档哪个槽位？\n归档会停掉它的进程，对话保留，随时能恢复。");
  expect(rows(panel)).toEqual([["w/a", "w/b"], ["取消"]]);
  await press("t", panel, "w/b");
  expect((await reads("t", 0, "已归档 w/b，对话保留。rh unarchive w/b 恢复。")).buttons ?? []).toEqual([]);
  expect(await rhodium.ok("ls", "--all")).toMatch(/^w\/b .*（已归档）/m);
}, 30_000);

const HOME = [["槽位", "切换", "切到 TUI", "换 agent"], ["改名…", "归档", "导入", "默认槽位"], ["工具行详略"], ["取消"]];

test("stories 328, 329 on QQ: /rh_help is Rhodium's home: who this chat goes to, then a button for each function on one page, unnumbered; 改名… fills the input box", async () => {
  await start(["a"]);
  await say("q", "/rh_help");
  const home = (await shown("q", 1))[0]!;
  expect(home.text).toBe("这里的消息交给 w/a，用 Claude。");
  expect(rows(home)).toEqual(HOME);
  expect(home.buttons!.map((b) => b.data)).toEqual(["/rh_ls", "/rh_use", "/rh_tui", "/rh_agent", "/rh_rename", "/rh_archive", "/rh_import", "/rh_bind", "/rh_verbose", "cancel"]);
  expect(home.buttons!.find((b) => b.label === "改名…")!.fill).toBe("/rh_rename ");
  // A pi slot says so.
  await rhodium.ok("agent", "w/a", "pi");
  await say("q", "/rh_help");
  expect((await shown("q", 2))[1]!.text).toBe("这里的消息交给 w/a，用 pi。");
}, 30_000);

test("story 328: with no slot here, /rh_help says so and has no 切到 TUI", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME } } });
  await rhodium.start();
  await say("q", "/rh_help");
  const home = (await shown("q", 1))[0]!;
  expect(home.text).toBe("这里还没指定槽位。");
  expect(rows(home)).toEqual([["槽位", "切换", "换 agent", "改名…"], ["归档", "导入", "默认槽位"], ["工具行详略"], ["取消"]]);
}, 30_000);

test("story 328 on Telegram: a home button turns /rh_help into that panel in place, 返回 last, which goes back home; a command typed after it leaves its buttons live", async () => {
  await start(["a", "b"]);
  await say("t", "/rh_help");
  const home = (await shown("t", 1))[0]!;
  await press("t", home, "槽位");
  const list = await reads("t", 0, `2 个槽位\n\nw（${rhodium.dir}/w）\na 未运行\nb 未运行\n\n这里的消息交给 w/a。点一个看详情。`);
  expect(rows(list)).toEqual([["w/a", "w/b"], ["返回", "取消"]]);
  await press("t", list, "返回");
  expect(rows(await reads("t", 0, "这里的消息交给 w/a，用 Claude。"))).toEqual(HOME);
  // Not an open panel: a command typed leaves it, and its buttons, as they were.
  await say("t", "/rh_ls");
  await shown("t", 2);
  await press("t", home, "切换");
  const use = await reads("t", 0, "这里的消息交给谁？\n现在：w/a");
  expect(rows(use)).toEqual([["✓ 默认（w/a）", "w/b"], ["返回", "取消"]]);
  // 改名… is a plain button here: it sends /rh_rename, which answers with an example.
  await press("t", use, "返回");
  await press("t", await reads("t", 0, "这里的消息交给 w/a，用 Claude。"), "改名…");
  await reads("t", 0, "/rh_rename 后面写新名字，例如 /rh_rename new-name；改别的槽位，先写槽位，例如 /rh_rename w/a new-name。");
  // One with no panel ends there too (§9.1): 工具行详略 says what it switched to, in place.
  await say("t", "/rh_help");
  await press("t", await reads("t", 2, "这里的消息交给 w/a，用 Claude。"), "工具行详略");
  expect(rows(await reads("t", 2, "工具行改成简略：只写工具名和次数。"))).toEqual([["改回详细"]]);
  expect(await rhodium.im.shown("t", ME)).toHaveLength(3);
}, 30_000);
