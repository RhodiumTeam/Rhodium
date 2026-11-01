// Query replies in IM (spec info-commands, its first ticket): /context comes as Markdown, its number in
// bold, with 压缩上下文 under it; the plain text beside it, for a platform that takes no Markdown, has no
// Markdown marks. Seen from seam one, through the fake IM.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import type { Script } from "./fake-agent/fake-agent";
import { compaction, endTurn, on, startTurn, toolUse, USAGE } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** What bot posted in your chat once it has posted n. */
async function posts(bot: string, n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return rhodium.im.log(bot, ME);
}

test("stories 399, 411: on QQ /context is Markdown, its percentage in bold, 压缩上下文 under it; a bot that takes no Markdown gets the words without the marks", async () => {
  // q: QQ, which shows its buttons; p: a QQ-like bot that sends plain text only, so no buttons.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, p: { like: "qq", owner: ME, target: "w/a", markdown: "false", buttons: "false" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/context" });
  const [reply] = await posts("q");
  expect(reply).toMatchObject({
    text: "已使用 26% 上下文 (~52k / 200k Tokens)",
    markdown: "已使用 **26%** 上下文 (\\~52k / 200k Tokens)",
    buttons: [{ label: "压缩上下文", data: "/compact" }],
  });
  expect(reply!.buttonsHidden).toBeUndefined();

  await rhodium.im.inject("p", { chat: ME, sender: ME, text: "/context" });
  const [plain] = await posts("p");
  expect(plain!.text).toBe("已使用 26% 上下文 (~52k / 200k Tokens)");
  expect(plain!.markdown).toBeUndefined();
}, 30_000);

test("stories 399, 410: on Telegram /context is a rich message, < and ~ escaped as Telegram shows them, 压缩上下文 under it, which compacts", async () => {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/context" });
  const [reply] = await posts("t");
  // The fake pi has 127 tokens of 100,000 in use.
  expect(reply).toMatchObject({ text: "已使用 <1% 上下文 (~127 / 100k Tokens)", markdown: "已使用 **&lt;1%** 上下文 (\\~127 / 100k Tokens)" });
  const compact = reply!.buttons!.find((b) => b.label === "压缩上下文")!;
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "", button: { data: compact.data, message: reply!.messageId } });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.startsWith("已压缩上下文")), 15_000);
}, 30_000);

test("story 471: Claude's /compact from IM, a turn of its own with no reply, writes compacted before its idle, so the web counts it for neither unread nor a reminder", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: compaction() } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/compact" });
  await posts("q");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.stop();
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const events = db.query("SELECT type, data FROM event WHERE slot IS NOT NULL ORDER BY seq").all() as { type: string; data: string | null }[];
  db.close();
  const said = events.map((e) => (e.type === "slot_state" ? JSON.parse(e.data!).state : e.type));
  expect(said.slice(said.lastIndexOf("running"))).toEqual(["running", "compacted", "idle"]);
  expect(said).not.toContain("final_reply");
}, 30_000);

/** The message's buttons as their labels, in order. */
const labels = (p: Posted) => (p.buttons ?? []).map((b) => b.label);
const say = (bot: string, text: string) => rhodium.im.inject(bot, { chat: ME, sender: ME, text });

test("stories 407, 408: before Claude's first turn, with no model remembered, /model says the default is now, by the model it uses, and marks it", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await say("q", "/model");
  const [panel] = await posts("q");
  expect(panel!.text).toBe("换哪个模型？\n现在：默认（Opus 5.5）");
  expect(labels(panel!)).toEqual(["★ 默认（Opus 5.5）", "Haiku", "取消"]);
}, 30_000);

test("story 408: a Claude taken over after a restart of rhodium does not say its level; /effort says the one the slot has, and marks it", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await say("q", "hello");
  await say("q", "/effort high");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "思考强度改成 high。"), 15_000);
  await rhodium.kill9();
  await rhodium.start();
  const before = (await rhodium.im.log("q", ME)).length;
  await say("q", "/effort");
  const panel = (await posts("q", before + 1))[before]!;
  expect(panel.text).toBe("思考强度改成哪档？\n现在：high");
  expect(labels(panel)).toEqual(["low", "medium", "★ high", "取消"]);
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 30_000);

test("story 408: a Claude taken over after a restart of rhodium does not say its model; /model says the one the slot has, and marks it", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  // No turn yet, so no init names the model: the slot's is the one now.
  await say("q", "/model haiku");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.startsWith("已切到 Haiku。")), 15_000);
  await rhodium.kill9();
  await rhodium.start();
  const before = (await rhodium.im.log("q", ME)).length;
  await say("q", "/model");
  const panel = (await posts("q", before + 1))[before]!;
  expect(panel.text).toBe("换哪个模型？\n现在：Haiku");
  expect(labels(panel)).toEqual(["默认（Opus 5.5）", "★ Haiku", "取消"]);
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 30_000);

test("story 408: pi's /resume says which conversation is now and marks it; a new one not yet begun is said to be new", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  for (const [n, text] of [[1, "hello"], [2, "/new"], [3, "/resume"]] as const) {
    await say("q", text);
    await posts("q", n);
  }
  const fresh = (await rhodium.im.log("q", ME))[2]!;
  expect(fresh.text).toBe("回到哪段对话？\n现在：新对话");
  expect(labels(fresh).filter((l) => l.startsWith("★"))).toEqual([]);
  await say("q", "again");
  await posts("q", 4);
  await say("q", "/resume");
  const panel = (await posts("q", 5))[4]!;
  expect(panel.text).toMatch(/^回到哪段对话？\n现在：今天 \d\d:\d\d 那段$/);
  expect(labels(panel)[0]).toMatch(/^★ \d\d:\d\d again$/);
  expect(labels(panel)[1]).toMatch(/^\d\d:\d\d hello$/);
}, 30_000);

/** A workspace and slots named with Markdown's marks, its directory too: x_tmp_ in .../_tmp_/a*b, with
 *  the slots 2. and a_b_, the chat's; bot is a QQ or a Telegram one. */
async function hostile(like: "qq" | "telegram"): Promise<string> {
  rhodium = newInstance({ bots: { b: { like, owner: ME, target: "x_tmp_/a_b_" } } });
  await rhodium.start();
  const dir = join(rhodium.dir, "_tmp_", "a*b");
  mkdirSync(dir, { recursive: true });
  await rhodium.ok("ws", "x_tmp_", dir);
  await rhodium.ok("new", "x_tmp_/2.");
  await rhodium.ok("new", "x_tmp_/a_b_");
  await say("b", "/rh_ls");
  return dir;
}

const LS = (dir: string) => `2 个槽位\n\nx_tmp_（${dir}）\n2. 未运行\na_b_ 未运行\n\n这里的消息交给 x_tmp_/a_b_。点一个看详情。`;

test("story 409: on QQ /rh_ls heads its count with ## and each workspace with ###; names and directories show as written, Markdown's marks in them escaped", async () => {
  const dir = await hostile("qq");
  const [list] = await posts("b");
  expect(list!.text).toBe(LS(dir));
  const shownDir = dir.replace(/[_*]/g, "\\$&");
  expect(list!.markdown).toBe(
    `## 2 个槽位\n\n### x\\_tmp\\_（${shownDir}）  \n2\\.\u00a0未运行  \n` +
      `a\\_b\\_\u00a0未运行\n\n这里的消息交给 x\\_tmp\\_/a\\_b\\_。点一个看详情。`,
  );
  expect(labels(list!)).toEqual(["x_tmp_/2.", "x_tmp_/a_b_", "取消"]);
}, 30_000);

test("stories 409, 410: on Telegram /rh_ls is a rich message, the workspace's directory in code; names escaped, so 2. is no list nor _tmp_ italic", async () => {
  const dir = await hostile("telegram");
  const [list] = await posts("b");
  expect(list!.text).toBe(LS(dir));
  expect(list!.markdown).toBe(
    `## 2 个槽位\n\n### x\\_tmp\\_（\`${dir}\`）  \n2\\. 未运行  \n` +
      `a\\_b\\_ 未运行\n\n这里的消息交给 x\\_tmp\\_/a\\_b\\_。点一个看详情。`,
  );
}, 30_000);

test("stories 393, 396, 398, 411: on QQ /usage is Markdown, Claude 额度 and 当前对话 its headings, each number bold, the cost at API prices; a bot that takes no Markdown gets the words without the marks", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, p: { like: "qq", owner: ME, target: "w/a", markdown: "false", buttons: "false" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/usage" });
  const [reply] = await posts("q");
  // The fake claude's windows reset at 05:00 on 10/21 and 21:00 on 10/24 UTC: the lines' ends are as of now.
  expect(reply!.markdown).toMatch(/^## Claude 额度 {2}\n\*\*12%\*\* 5h，.+ {2}\n\*\*52%\*\* 7d，.+ {2}\n\*\*38%\*\* 7d Fable，.+\n\n## 当前对话 {2}\n\*\*\$15\.35\*\* 等效 API 价格 {2}\n\*\*18\.9M\*\* 总 Tokens 消耗$/);
  expect(reply!.buttons).toBeUndefined();

  await rhodium.im.inject("p", { chat: ME, sender: ME, text: "/usage" });
  const [plain] = await posts("p");
  expect(plain!.text).toMatch(/^Claude 额度\n12% 5h，.+\n\n当前对话\n\$15\.35 等效 API 价格\n18\.9M 总 Tokens 消耗$/s);
  expect(plain!.text).not.toMatch(/#|\*\*/);
  expect(plain!.markdown).toBeUndefined();
}, 30_000);

test("story 397: on Telegram a pi slot's /usage is this conversation alone, as a rich message", async () => {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/usage" });
  const [reply] = await posts("t");
  // The fake pi's session: 127 tokens, at no cost.
  expect(reply).toMatchObject({ text: "当前对话\n$0.00\n127 总 Tokens 消耗", markdown: "## 当前对话  \n**\\$0.00**  \n**127** 总 Tokens 消耗" });
}, 30_000);

test("architecture §8.2: a model's name in /usage shows as written on QQ and Telegram, whatever marks it holds", async () => {
  const name = "_a*b_";
  const limits = [{ kind: "weekly_scoped", group: "weekly", percent: 38, resets_at: null, scope: { model: { id: null, display_name: name } } }];
  const usage = { type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { ...USAGE, rate_limits: { limits } } } };
  const script = { on: [{ match: { type: "control_request", request: { subtype: "get_usage" } }, emit: [JSON.stringify(usage)] }, ...on!], steps: [] };
  rhodium = newInstance({ claude: { script }, bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  for (const bot of ["q", "t"]) await rhodium.im.inject(bot, { chat: ME, sender: ME, text: "/usage" });
  const [[qq], [tg]] = [await posts("q"), await posts("t")];
  expect(qq!.text).toStartWith(`Claude 额度\n38% 7d ${name}\n`);
  // QQ eats a space after an escape, so the line's end has a no-break one (architecture §8.2).
  expect(qq!.markdown).toStartWith("## Claude 额度  \n**38%** 7d \\_a\\*b\\_\u00a0\n\n");
  expect(tg!.markdown).toStartWith("## Claude 额度  \n**38%** 7d \\_a\\*b\\_\n\n");
}, 30_000);

/** The fake claude's script with get_usage answering these windows: 79% of the five hours, 91% of the seven days. */
const nearlyFull = (steps: Script["steps"] = [...startTurn, ...endTurn("OK")]): Script => {
  const limits = [
    { kind: "session", group: "session", percent: 79, resets_at: null, scope: null },
    { kind: "weekly_all", group: "weekly", percent: 91, resets_at: null, scope: null },
  ];
  const usage = { type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { ...USAGE, rate_limits: { limits } } } };
  return { on: [{ match: { type: "control_request", request: { subtype: "get_usage" } }, emit: [JSON.stringify(usage)] }, ...on!], steps };
};

test("stories 401-404, 406: on QQ /status is Markdown: the slot's name its heading, the state under it, 模型设置 and 状态, the context as /context has it; 额度信息 only with a window at 80% while Claude's process runs; its buttons stay", async () => {
  rhodium = newInstance({ claude: { script: nearlyFull() }, bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  // Not running: Rhodium answers alone, with no quota to ask.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/status" });
  const [off] = await posts("q");
  expect(off!.text).toMatch(/^w\/a\n未运行，来消息就启动\n\n模型设置\nAgent：Claude Code\n\n状态\n目录：\S+$/);
  expect(off!.markdown).toStartWith("## w/a  \n未运行，来消息就启动\n\n### 模型设置  \nAgent：Claude Code\n\n### 状态  \n目录：");
  expect(off!.buttons!.map((b) => b.label)).toEqual(["换模型", "思考强度", "压缩上下文", "开新对话", "取消"]);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await posts("q", 2);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/status" });
  const idle = (await posts("q", 3))[2]!;
  expect(idle.markdown).toMatch(/^## w\/a {2}\n空闲\n\n### 模型设置 {2}\nAgent：Claude Code {2}\n模型：.+\n\n### 状态 {2}\n目录：\S+ {2}\n上下文：26% \(\\~52k \/ 200k Tokens\)\n\n### 额度信息 {2}\n\*\*91%\*\* 7d$/);
  // 额度信息 holds the 7d line alone: the 5h window, at 79%, is under 80%. Not a not.toContain("5h"):
  // the directory line above it is a random temp path, which may hold "5h".
  expect(idle.text).toEndWith("\n\n额度信息\n91% 7d");
  expect(idle.buttons!.map((b) => b.label)).toEqual(["换模型", "思考强度", "压缩上下文", "开新对话", "取消"]);
}, 30_000);

test("story 405: on Telegram a running /status says how long the turn has run, and the tool running under it; the directory is code", async () => {
  const script = nearlyFull([...startTurn, toolUse("toolu_sleep", "Bash", { command: "sleep 600" }), { wait: { type: "never" } }]);
  rhodium = newInstance({ claude: { script }, bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "go" });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.includes("正在运行")), 15_000);
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/status" });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.startsWith("w/a\n")), 15_000);
  const status = (await rhodium.im.log("t", ME)).find((p) => p.text.startsWith("w/a\n"))!;
  expect(status.text).toMatch(/^w\/a\n运行中，这一回合跑了 \d+ 秒\n\[🔧 Bash\] sleep 600，正在运行\n\n模型设置\n/);
  expect(status.markdown).toMatch(/\n目录：`[^`]+`/);
  expect(status.text).toContain("\n\n额度信息\n91% 7d");
  expect(status.buttons!.map((b) => b.label)).toEqual(["停止", "换模型", "思考强度", "压缩上下文", "取消"]);
}, 30_000);

test("story 404: a pi slot's /status names Pi, with its context and no quota", async () => {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "hello" });
  await posts("t");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/status" });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.startsWith("w/a\n")), 15_000);
  const status = (await rhodium.im.log("t", ME)).find((p) => p.text.startsWith("w/a\n"))!;
  expect(status.text).toMatch(/^w\/a\n空闲\n\n模型设置\nAgent：Pi\n模型：.+\n\n状态\n目录：\S+\n上下文：<1% \(~127 \/ 100k Tokens\)$/);
}, 30_000);

test("story 500: on QQ a Codex slot's /usage is Codex 额度 with its 7-day window and credits left, then this conversation's tokens with no cost; /context its last request's tokens", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "codex");
  await say("q", "hello");
  await posts("q");
  await say("q", "/usage");
  // The fake codex's: its 7-day window reset at 06:42 on 10/30 UTC, as of now; 127 tokens a turn.
  const usage = (await posts("q", 2))[1]!;
  expect(usage.markdown).toMatch(/^## Codex 额度 {2}\n\*\*91%\*\* 7d，.+ {2}\n\*\*58572\.75\*\* credits 余额\n\n## 当前对话 {2}\n\*\*127\*\* 总 Tokens 消耗$/);
  await say("q", "/context");
  expect((await posts("q", 3))[2]).toMatchObject({ text: "已使用 <1% 上下文 (~127 / 258k Tokens)", buttons: [{ label: "压缩上下文", data: "/compact" }] });
}, 30_000);
