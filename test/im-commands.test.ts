// The IM text of the common commands' results (product §5.6), for the six whose drivers come
// later (#30, #34, #35); /new /stop /status and the panels are checked end to end in commands.test.ts
// and im-panels.test.ts.
import { expect, test } from "bun:test";
import { IM_COMMANDS } from "../src/commands";
import type { Capabilities, CommandResult } from "../src/contracts";
import { contextText, formatCommand, resetText, statusText, usageText } from "../src/im-commands";
import { money, percent, tokens } from "../src/panels";
import { feishuCapabilities } from "../src/feishu";
import { QQ_CAPABILITIES } from "../src/qq";
import { md, plain, queryMarkdown } from "../src/render";
import { TELEGRAM_CAPABILITIES } from "../src/telegram";

process.env.TZ = "Etc/GMT-9";

const slot = { ref: "w/a", dir: "/w/a", agent: "claude", state: "空闲", line: "空闲" };
const resets = Date.UTC(2026, 9, 20, 22, 0, 0); // 07:00 in Tokyo
const now = resets - (2 * 60 + 10) * 60_000; // 2 hours 10 minutes before

test.each<[string, CommandResult, string]>([
  ["/model, switched", { command: "model", model: "haiku", label: "Haiku" }, "已切到 Haiku。"],
  ["/model, switched to the default", { command: "model", model: null }, "已切到默认模型。"],
  ["/effort, set", { command: "effort", level: "low" }, "思考强度改成 low。"],
  ["/usage, nothing to show", { command: "usage", limits: [] }, "Claude 没有用量可查。"],
  ["/compact", { command: "compact", beforeTokens: 80_000, afterTokens: 12_000 }, "已压缩上下文，从约 80k tokens 减到约 12k tokens。"],
  ["/compact, sizes unknown", { command: "compact", beforeTokens: null, afterTokens: null }, "已压缩上下文。"],
  ["/resume, nothing to list", { command: "resume", session: null, choices: [] }, "这个槽位还没有用过的对话，这个目录里也没有。"],
  ["/resume, back", { command: "resume", session: "s1", agent: "claude", name: "昨天 22:10 那段" }, "已回到昨天 22:10 那段对话。"],
])("%s", (_, result, text) => {
  expect(formatCommand(result, slot, now)).toBe(text);
});

test.each<[string, Partial<Extract<CommandResult, { command: "status" }>>, Partial<typeof slot> & { tool?: string }, string]>([
  [
    "Claude idle, 7 days nearly full: the model with its level, ultracode on, the context as /context has it, and the window at 80% or more",
    {
      model: "Opus 5.5",
      effort: "xhigh",
      ultracode: true,
      context: { usedTokens: 186_000, maxTokens: 1_000_000 },
      limits: [
        { window: "5h", usedPercent: 79, resetsAt: null },
        { window: "7d", usedPercent: 91, resetsAt: resets },
        { window: "7d", model: "Fable", usedPercent: 80, resetsAt: null },
      ],
    },
    { ref: "dispatcher/main", dir: "/r" },
    "## dispatcher/main\n空闲\n\n### 模型设置\nAgent：Claude Code\n模型：Opus 5.5 xhigh\n已开启 ultracode\n\n### 状态\n目录：`/r`\n上下文：19% (\\~186k / 1M Tokens)\n\n### 额度信息\n**91%** 7d，2h 10m 后重置\n**80%** 7d Fable",
  ],
  [
    "story 404: every window under 80%, no quota section",
    { model: "Opus 5.5", context: { usedTokens: 50, maxTokens: 200_000 }, limits: [{ window: "7d", usedPercent: 79.4, resetsAt: null }] },
    {},
    "## w/a\n空闲\n\n### 模型设置\nAgent：Claude Code\n模型：Opus 5.5\n\n### 状态\n目录：`/w/a`\n上下文：<1% (\\~50 / 200k Tokens)",
  ],
  [
    "story 405: running, how long the turn has run, the tool running under it; the window not known",
    { model: "Sonnet 4.5", effort: "high", context: { usedTokens: 62_000, maxTokens: null } },
    { line: "运行中，这一回合跑了 3 分钟", tool: "[🔧 Bash] npm test，正在运行（3 分钟）" },
    "## w/a\n运行中，这一回合跑了 3 分钟\n\\[🔧 Bash\\] npm test，正在运行（3 分钟）\n\n### 模型设置\nAgent：Claude Code\n模型：Sonnet 4.5 high\n\n### 状态\n目录：`/w/a`\n上下文：\\~62k Tokens",
  ],
  [
    "the default model with its level, no space after its bracket; no process, no context",
    { model: "默认（Opus 5.5）", effort: "xhigh", context: null },
    { line: "未运行，来消息就启动" },
    "## w/a\n未运行，来消息就启动\n\n### 模型设置\nAgent：Claude Code\n模型：默认（Opus 5.5）xhigh\n\n### 状态\n目录：`/w/a`",
  ],
  [
    "TUI: what Rhodium knows alone, the agent and the directory",
    { context: null },
    { line: "TUI 模式", agent: "pi" },
    "## w/a\nTUI 模式\n\n### 模型设置\nAgent：Pi\n\n### 状态\n目录：`/w/a`",
  ],
  [
    "story 500: Codex, Agent：Codex CLI, its default with its level, the 7-day window nearly full",
    { model: "默认（GPT-6.1-Sol）", effort: "high", context: { usedTokens: 31_000, maxTokens: 258_400 }, limits: [{ window: "7d", usedPercent: 86, resetsAt: resets }] },
    { agent: "codex", ref: "shop/codex", dir: "/k" },
    "## shop/codex\n空闲\n\n### 模型设置\nAgent：Codex CLI\n模型：默认（GPT-6.1-Sol）high\n\n### 状态\n目录：`/k`\n上下文：12% (\\~31k / 258k Tokens)\n\n### 额度信息\n**86%** 7d，2h 10m 后重置",
  ],
  [
    "pi: Agent：Pi, its model and level, no quota",
    { model: "DeepSeek V4.1 Flash", effort: "medium", context: { usedTokens: 48_000, maxTokens: 1_000_000 } },
    { agent: "pi" },
    "## w/a\n空闲\n\n### 模型设置\nAgent：Pi\n模型：DeepSeek V4.1 Flash medium\n\n### 状态\n目录：`/w/a`\n上下文：5% (\\~48k / 1M Tokens)",
  ],
])("stories 401-405, im-style §7.1: /status, %s", (_, result, info, shown) => {
  const q = statusText({ command: "status", model: null, context: null, ...result }, { ...slot, ...info }, now);
  expect(marked(q)).toBe(shown);
  // Story 411: the plain text has no marks.
  expect(plain(q)).not.toMatch(/#|\*\*|`/);
});

test("architecture §8.2: a slot's name, its directory and a model's name in /status show as written on QQ and Telegram", () => {
  const q = statusText({ command: "status", model: "**F** ## x", context: null }, { ...slot, ref: "_tmp_/a*b", dir: "/a`b_c" }, now);
  expect(plain(q)).toStartWith("_tmp_/a*b\n空闲\n\n模型设置\nAgent：Claude Code\n模型：**F** ## x\n");
  expect(queryMarkdown(q, TELEGRAM_CAPABILITIES)).toBe("## \\_tmp\\_/a\\*b  \n空闲\n\n### 模型设置  \nAgent：Claude Code  \n模型：\\*\\*F\\*\\* ## x\n\n### 状态  \n目录：``/a`b_c``");
  expect(queryMarkdown(q, QQ_CAPABILITIES)).toStartWith("## \\_tmp\\_/a\\*b  \n");
  expect(queryMarkdown(q, QQ_CAPABILITIES)).toEndWith("目录：/a\\`b\\_c");
});

test("architecture §8.2: a query reply takes QQ's escaping by the platform's Markdown, not by where its buttons show", () => {
  const q = statusText({ command: "status", model: null, context: null }, { ...slot, ref: "_tmp_/a*b", dir: "/a`b_c" }, now);
  expect(queryMarkdown(q, { ...TELEGRAM_CAPABILITIES, buttons: "markdown" })).toBe(queryMarkdown(q, TELEGRAM_CAPABILITIES));
});

test("im-style §9.1: a list's candidates run their command with the choice, or its number when the id would take the data past 64 bytes", () => {
  const long = "x".repeat(60);
  const model = IM_COMMANDS.find((c) => c.name === "model")!;
  // pi's provider goes along, for the board's groups (#455).
  expect(model.list!({ choices: [{ id: "haiku", label: "Haiku", current: true }, { id: long, label: "Long", group: "x" }] })).toEqual([
    { label: "Haiku", command: "/model haiku", current: true },
    { label: "Long", command: "/model 2", group: "x" },
  ]);
  // A slot whose name would take it past 64 bytes goes by its row id.
  const use = IM_COMMANDS.find((c) => c.name === "rh_use")!;
  const slots = [{ id: "01SLOT", ref: `w/${long}`, workspace: "w", name: long, urgency: 0 }];
  expect(use.list!({ slots, byDefault: "w/a", own: false })).toEqual([
    { label: "默认（w/a）", command: "/rh_use -", current: true },
    { label: `w/${long}`, command: "/rh_use 01SLOT", current: false },
  ]);
});

test("im-style §2.4: a token count is 127, 7.9k, 186k, 18.9M, 1M; under 1% of the window is <1%", () => {
  expect([127, 7_900, 52_000, 186_400, 999_600, 1_000_000, 18_940_000].map(tokens)).toEqual(["127", "7.9k", "52k", "186k", "1M", "1M", "18.9M"]);
  expect([percent(186_000, 1_000_000), percent(9_999, 1_000_000), percent(10_000, 1_000_000), percent(0, 200_000)]).toEqual(["19%", "<1%", "1%", "<1%"]);
});

/** A query reply as a platform with GFM and nothing more shows it, each line break as it is. */
const marked = (q: string) => queryMarkdown(q, { markdown: { extensions: [] }, buttons: true } as unknown as Capabilities)!.replaceAll("  \n", "\n");

test.each<[string, number, number | null, string]>([
  ["story 399: out of the model's window", 186_000, 1_000_000, "已使用 **19%** 上下文 (\\~186k / 1M Tokens)"],
  ["under 1%", 127, 1_000_000, "已使用 **<1%** 上下文 (\\~127 / 1M Tokens)"],
  ["the window not known", 62_000, null, "已使用 **\\~62k** Tokens 上下文"],
])("im-style §7.3: /context, %s", (_, usedTokens, maxTokens, shown) => {
  const r = { command: "context", usedTokens, maxTokens } as const;
  expect(marked(contextText(r))).toBe(shown);
  expect(formatCommand(r, slot)).toBe(shown.replaceAll("**", "").replaceAll("\\", ""));
});

test("im-style §2.4: an amount is $15.35, under a cent <$0.01; a quota resets in 1h 46m within a day, at a moment further off, and 已重置 once past", () => {
  expect([money(15.349), money(0), money(0.004), money(0.007), money(0.011), money(12.3, "EUR")]).toEqual(["$15.35", "$0.00", "<$0.01", "<$0.01", "$0.01", "EUR 12.30"]);
  const h = 3_600_000;
  expect([resetText(now + 106 * 60_000, now), resetText(now + 46 * 60_000, now), resetText(now + 2 * h, now), resetText(now + 24 * h - 60_000, now), resetText(now + 25 * h, now), resetText(now - 1, now)]).toEqual([
    "1h 46m 后重置", "46m 后重置", "2h 后重置", "23h 59m 后重置", "明天 05:50 重置", "已重置",
  ]);
});

test("stories 393, 396, 398: Claude's /usage is its quota windows, a model's own too, and this conversation's cost at API prices and tokens, in two sections, numbers first and bold", () => {
  const h = 3_600_000;
  const r: Extract<CommandResult, { command: "usage" }> = {
    command: "usage",
    limits: [
      { window: "5h", usedPercent: 28, resetsAt: now + 106 * 60_000 },
      { window: "7d", usedPercent: 91, resetsAt: now + 9 * h + 26 * 60_000 },
      { window: "7d", model: "Fable", usedPercent: 38, resetsAt: null },
    ],
    session: { cost: 15.35, tokens: { input: 1_800, output: 96_000, cacheRead: 18_200_000, cacheWrite: 612_000, total: 18_909_800 } },
  };
  const shown = "## Claude 额度\n**28%** 5h，1h 46m 后重置\n**91%** 7d，9h 26m 后重置\n**38%** 7d Fable\n\n## 当前对话\n**$15.35** 等效 API 价格\n**18.9M** 总 Tokens 消耗";
  expect(marked(usageText(r, "claude", now))).toBe(shown);
  // Story 411: the plain text has no marks.
  expect(formatCommand(r, slot, now)).toBe(shown.replaceAll("## ", "").replaceAll("**", ""));
  // Extra usage, when on, is a line of its own; a login with no quota has no quota section.
  const extra = { usedPercent: 24.6, used: 12.3, limit: 50, currency: "USD" };
  expect(marked(usageText({ ...r, limits: [], extra }, "claude", now))).toStartWith("## Claude 额度\n**25%** 额外用量，本月 $12.30 / $50.00\n\n## 当前对话");
  expect(marked(usageText({ command: "usage", limits: [], session: r.session }, "claude", now))).toStartWith("## 当前对话\n");
});

test("story 397: pi's /usage is this conversation alone, its cost with nothing after it; with nothing at all, one sentence", () => {
  const session = { cost: 0.11, tokens: { input: 182_000, output: 41_000, cacheRead: 1_020_000, cacheWrite: 0, total: 1_243_000 } };
  expect(marked(usageText({ command: "usage", limits: [], session }, "pi", now))).toBe("## 当前对话\n**$0.11**\n**1.2M** 总 Tokens 消耗");
  expect(usageText({ command: "usage", limits: [] }, "pi", now)).toBe("pi 没有用量可查。");
});

test("story 500: Codex's /usage is its windows, the credits left to two places with no commas, and this conversation's tokens with no cost", () => {
  const r: Extract<CommandResult, { command: "usage" }> = {
    command: "usage",
    limits: [{ window: "7d", usedPercent: 35, resetsAt: resets }],
    credits: 58572.7492495,
    session: { tokens: { input: 19_618, output: 108, cacheRead: 44_544, cacheWrite: 0, total: 1_243_000 } },
  };
  const shown = "## Codex 额度\n**35%** 7d，2h 10m 后重置\n**58572.75** credits 余额\n\n## 当前对话\n**1.2M** 总 Tokens 消耗";
  expect(marked(usageText(r, "codex", now))).toBe(shown);
  expect(formatCommand(r, { ...slot, agent: "codex" }, now)).toBe(shown.replaceAll("## ", "").replaceAll("**", ""));
  // An API key login: no quota, the conversation alone.
  expect(marked(usageText({ command: "usage", limits: [], session: r.session }, "codex", now))).toBe("## 当前对话\n**1.2M** 总 Tokens 消耗");
});

test("#419: an agent's quota is named after it, never Claude's unless it is Claude's", () => {
  const limits = [{ window: "5h" as const, usedPercent: 28, resetsAt: null }];
  expect(marked(usageText({ command: "usage", limits }, "pi", now))).toBe("## pi 额度\n**28%** 5h");
});

test("story 411: a query reply's plain text has no heading marks, bold or code", () => {
  expect(plain(md`## w/a\n空闲\n\n### 状态\n目录：\`${"~/w a"}\`\n**91%** 7d`)).toBe("w/a\n空闲\n\n状态\n目录：~/w a\n91% 7d");
});

test("stories 410, 411: a query reply's Markdown keeps its template's headings and bold; QQ's shows the rest as written, with no code; Telegram's escapes GFM and its own syntax and keeps the directory as code", () => {
  const q = md`## w/a\n已使用 **<1%** 上下文 (~127 / 1M Tokens)\n\n### 额度\n**$1.50** 本月 $12.30 / $50.00\n目录：\`${"~/a_b"}\``;
  expect(queryMarkdown(q, QQ_CAPABILITIES)).toBe(
    "## w/a  \n已使用 **\\<1%** 上下文 (\\~127 / 1M Tokens)\n\n### 额度  \n**$1.50** 本月 $12.30 / $50.00  \n目录：\\~/a\\_b",
  );
  expect(queryMarkdown(q, TELEGRAM_CAPABILITIES)).toBe(
    "## w/a  \n已使用 **&lt;1%** 上下文 (\\~127 / 1M Tokens)\n\n### 额度  \n**\\$1.50** 本月 \\$12.30 / \\$50.00  \n目录：`~/a_b`",
  );
  expect(queryMarkdown(q, { ...TELEGRAM_CAPABILITIES, markdown: null })).toBeUndefined();
});

test("architecture §8.2: what a query reply puts in, a slot's name, a path, a model's, shows as written on QQ and Telegram, its marks no formatting", () => {
  const [slotName, model, dir] = ["_tmp_/a*b", "**Fable** `x`", "~/a`b_c"];
  const q = md`## ${slotName}\n**91%** 7d ${model}\n目录：\`${dir}\``;
  expect(plain(q)).toBe(`${slotName}\n91% 7d ${model}\n目录：${dir}`);
  expect(queryMarkdown(q, TELEGRAM_CAPABILITIES)).toBe("## \\_tmp\\_/a\\*b  \n**91%** 7d \\*\\*Fable\\*\\* \\`x\\`  \n目录：``~/a`b_c``");
  expect(queryMarkdown(q, QQ_CAPABILITIES)).toBe("## \\_tmp\\_/a\\*b  \n**91%** 7d \\*\\*Fable\\*\\*\u00a0\\`x\\`\u00a0  \n目录：\\~/a\\`b\\_c");
  // A ## or ** in a value, or a template's ## past a line's start, is no heading or bold.
  expect(queryMarkdown(md`${"## x"} ## y`, TELEGRAM_CAPABILITIES)).toBe("\\## x ## y");
  // On Feishu, the backslashes first, then its own: & and < as entities, :name: with its first colon one.
  expect(queryMarkdown(md`## ${"a&b<c> :OK:"}\n目录：\`${dir}\``, feishuCapabilities(3000))).toBe("## a&amp;b&lt;c> &#58;OK:  \n目录：``~/a`b_c``");
  // A value opening a line with Telegram's == is escaped once, not twice.
  expect(queryMarkdown(md`${"==m=="}`, TELEGRAM_CAPABILITIES)).toBe("\\=\\=m\\=\\=");
});
