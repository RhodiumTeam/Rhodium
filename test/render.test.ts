// The renderer, fed agent events directly: how a turn shows has too many combinations for
// whole-system tests (docs/spec/v1.md "不在自动测试里的"). The examples are docs/im-style.md §3's.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AgentEvent } from "../src/contracts";
import { feishuCapabilities } from "../src/feishu";
import { QQ_CAPABILITIES } from "../src/qq";
import { append, chunkText, edit, finish, finishEdit, freeze, hide, markdown, moveOn, start, type Msg, type View } from "../src/render";
import { TELEGRAM_CAPABILITIES } from "../src/telegram";
import { shortParts } from "../src/tool-line";

type Ev = AgentEvent extends infer E ? (E extends unknown ? Omit<E, "conv" | "proc"> : never) : never;
const ev = (e: Ev) => ({ conv: "c", proc: 1, ...e }) as AgentEvent;
let ids = 0;
const started = (name: string, input: object = {}) => ev({ type: "tool_start", id: `t${++ids}`, name, input });
const ended = (s: AgentEvent) => {
  const { id, name, input } = s as Extract<AgentEvent, { type: "tool_start" }>;
  return ev({ type: "item", item: { kind: "tool", id, name, input } });
};
/** A tool call that started, and whose result came back. */
const tool = (name: string, input: object = {}) => {
  const s = started(name, input);
  return [s, ended(s)];
};
/** The ask a started tool call waits on, for your approval. */
const askFor = (s: AgentEvent) => {
  const { id, name, input } = s as Extract<AgentEvent, { type: "tool_start" }>;
  return ev({ type: "ask", requestId: `r-${id}`, kind: "permission", tool: name, input, toolUse: id });
};
const delta = (text: string) => ev({ type: "text_delta", text });
const message = (text: string) => ev({ type: "item", item: { kind: "message", text } });
/** What the agent says: streamed, then whole. */
const says = (text: string) => [delta(text), message(text)];

const DIR = "/srv/proj";
const at = (path: string) => ({ file_path: `${DIR}/${path}` });

/** The messages a turn sends on QQ: room is how many it may send before its end, as the quota allows.
 *  "sent me": the agent's rh send me took the turn over here. */
function qq(events: (AgentEvent | "sent me")[], o: { room?: number; verbose?: boolean; max?: number; reply?: string } = {}): string[] {
  const v: View = { verbose: o.verbose ?? false, dir: DIR, now: 0, caps: { ...QQ_CAPABILITIES, maxTextLength: o.max ?? 2000 } };
  let p = start();
  const sent: string[] = [];
  for (const e of events) {
    if (e === "sent me") {
      v.toolsOnly = true;
      continue;
    }
    if (e.type === "ask") {
      p = hide(p, e.toolUse);
      continue;
    }
    const r = append(p, e, v, (o.room ?? 18) - sent.length);
    p = r.progress;
    sent.push(...r.sends);
  }
  return [...sent, ...finish(p, o.reply, v)];
}

/** A step of a turn on Telegram: an agent event; "under", something else going to the chat (an ask);
 *  "sent me", the agent's rh send me going there and taking the turn over; or { now }, the clock moving on. */
type TgStep = AgentEvent | "under" | "sent me" | { now: number };

/** A turn on Telegram, as the router keeps its message: messages, what each shows in the end; shows,
 *  each thing the turn's message was given to show along the way. */
function telegram(steps: TgStep[], o: { verbose?: boolean; max?: number; reply?: string } = {}) {
  let now = 0;
  let toolsOnly = false;
  const v = (): View => ({ verbose: o.verbose ?? true, dir: DIR, now, caps: { ...TELEGRAM_CAPABILITIES, maxTextLength: o.max ?? 4096 }, toolsOnly });
  let p = start();
  let live = false;
  const messages: Msg[] = [];
  const shows: string[] = [];
  const put = (out: Msg[], show = true) => {
    out.forEach((m, i) => (i === 0 && live ? (messages[messages.length - 1] = m) : messages.push(m)));
    if (out.length) live = true;
    if (show) shows.push(...out.map((m) => m.text));
  };
  for (const s of steps) {
    if (s === "under" || s === "sent me") {
      if (live) messages[messages.length - 1] = freeze(p, v());
      p = moveOn(p, v());
      live = false;
      toolsOnly ||= s === "sent me";
      continue;
    }
    if ("conv" in s && s.type === "ask") {
      p = hide(p, s.toolUse);
      continue;
    }
    if (!("conv" in s)) now = s.now;
    const r = edit(p, "conv" in s ? s : null, v());
    p = r.progress;
    put(r.out);
  }
  const last = finishEdit(p, o.reply, v());
  put(last, false);
  return { messages, shows, last };
}

// ---- Tool lines, both platforms (im-style §3.1). ----

/** How one call shows in a detailed tool line. */
const line = (name: string, input: object) => qq([...tool(name, input), ...says("ok")], { verbose: true })[0]!.split("\n")[0];

test.each([
  ["a short command is the command", "Bash", { command: "npm test" }, "[🔧 Bash] npm test"],
  ["a long command is its description", "Bash", { command: `for f in *.ts; do echo "$f" >> list.txt; done`, description: "List the sources" }, "[🔧 Bash] List the sources"],
  ["a long command with no description is cut at 40", "Bash", { command: "x".repeat(50) }, `[🔧 Bash] ${"x".repeat(40)}…`],
  ["a file in the slot's directory is relative to it", "Read", at("src/config.ts"), "[🔧 Read] src/config.ts"],
  ["a file under home starts with ~", "Edit", { file_path: `${homedir()}/notes/todo.md` }, "[🔧 Edit] ~/notes/todo.md"],
  ["a long path keeps its head and last two parts", "Write", { file_path: "/opt/some-long-directory/with/many/levels/src/render.ts" }, "[🔧 Write] /opt/…/src/render.ts"],
  ["a notebook", "NotebookEdit", { notebook_path: `${DIR}/a.ipynb` }, "[🔧 NotebookEdit] a.ipynb"],
  ["pi's tools, their names capitalized", "read", { path: `${DIR}/README.md` }, "[🔧 Read] README.md"],
  ["pi's bash", "bash", { command: "ls -la" }, "[🔧 Bash] ls -la"],
  ["a search pattern", "Grep", { pattern: "TODO" }, "[🔧 Grep] TODO"],
  ["a glob", "Glob", { pattern: "**/*.ts" }, "[🔧 Glob] **/*.ts"],
  ["a web search", "WebSearch", { query: "bun sqlite wal" }, "[🔧 WebSearch] bun sqlite wal"],
  ["a fetched page, without https://", "WebFetch", { url: "https://example.com/docs" }, "[🔧 WebFetch] example.com/docs"],
  ["a subagent's task", "Agent", { description: "Find the bug", prompt: "long" }, "[🔧 Agent] Find the bug"],
  ["a skill", "Skill", { skill: "tdd" }, "[🔧 Skill] tdd"],
  ["an MCP tool, named server.tool, with no argument", "mcp__github__create_issue", { title: "x" }, "[🔧 github.create_issue]"],
  ["any other tool, only its name", "Frobnicate", { x: 1 }, "[🔧 Frobnicate]"],
  ["story 487: Codex's command, its name as Codex has it", "exec_command", { command: "rg timeout src" }, "[🔧 exec_command] rg timeout src"],
  ["story 487: Codex's long command, cut at 40", "exec_command", { command: "x".repeat(50) }, `[🔧 exec_command] ${"x".repeat(40)}…`],
  ["story 487: Codex's patch of one file", "apply_patch", { changes: [{ path: `${DIR}/src/config.ts`, kind: { type: "update" }, diff: "" }] }, "[🔧 apply_patch] src/config.ts"],
  ["story 487: Codex's patch of three files", "apply_patch", { changes: [{ path: `${DIR}/a.ts` }, { path: `${DIR}/b.ts` }, { path: `${DIR}/c.ts` }] }, "[🔧 apply_patch] a.ts 等 3 个文件"],
  ["story 487: Codex's picture", "view_image", { path: `${DIR}/shot.png` }, "[🔧 view_image] shot.png"],
  ["story 487: Codex's web search", "web_search", { query: "bun sqlite wal" }, "[🔧 web_search] bun sqlite wal"],
  ["story 487: Codex's other tools, only their name", "image_gen", {}, "[🔧 image_gen]"],
])("detailed tool line: %s", (_, name, input, want) => {
  expect(line(name, input)).toBe(want);
});

test.each([
  ["an sk- key", "Bash", { command: "export K=sk-ant-api03-abc_DEF" }, "[🔧 Bash] export K=***"],
  ["a ghp_ token", "Bash", { command: "git clone https://ghp_abc123@github.com/x" }, "[🔧 Bash] git clone https://***@github.com/x"],
  ["what follows Bearer", "Bash", { command: `curl -H "Authorization: Bearer abc.def" x` }, `[🔧 Bash] curl -H "Authorization: Bearer ***" x`],
  ["what follows token=", "WebFetch", { url: "https://example.com/cb?token=abc&x=1" }, "[🔧 WebFetch] example.com/cb?token=***&x=1"],
  ["what follows --token", "Bash", { command: "gh auth login --token abc123" }, "[🔧 Bash] gh auth login --token ***"],
  ["a NAME=value whose name says key, token, secret or password", "Bash", { command: "API_KEY=a password='b c' SECRET=d make" }, "[🔧 Bash] API_KEY=*** password=*** SECRET=*** make"],
  ["a key in a long command, before it is cut to 40", "Bash", { command: `GITHUB_TOKEN=${"x".repeat(50)} gh pr list` }, "[🔧 Bash] GITHUB_TOKEN=*** gh pr list"],
])("story 67: a value that looks like a secret shows as *** in a tool line: %s", (_, name, input, want) => {
  expect(line(name, input)).toBe(want);
});

test("a run of calls to one tool is one line: ×N after the name, its different arguments joined with 、", () => {
  const events = [...tool("Read", at("src/a.ts")), ...tool("Read", at("src/b.ts")), ...tool("Read", at("src/c.ts")), ...tool("Bash", { command: "npm test" }), ...tool("Bash", { command: "npm test" }), ...says("ok")];
  expect(qq(events, { verbose: true })).toEqual(["[🔧 Read ×3] src/a.ts、src/b.ts、src/c.ts\n[🔧 Bash ×2] npm test\n\nok"]);
});

test("a detailed line over 60 characters ends with …", () => {
  const files = ["alpha", "bravo", "charlie", "delta", "echo"].map((n) => tool("Read", at(`src/${n}-module.ts`))).flat();
  expect(qq([...files, ...says("ok")], { verbose: true })[0]!.split("\n")[0]).toBe("[🔧 Read ×5] src/alpha-module.ts、src/bravo-module.ts…");
});

test("the short tool line: in order, a run of one tool as ×N, at most four items", () => {
  const short = (names: string[]) => qq([...names.flatMap((n) => tool(n)), ...says("ok")])[0]!.split("\n")[0];
  expect(short(["Edit", "Bash", "Bash"])).toBe("[🔧 Edit、Bash ×2]");
  expect(short(["Read", "Bash", "Read", "Read"])).toBe("[🔧 Read、Bash、Read ×2]");
  expect(short([...Array(6).fill("Read"), ...Array(4).fill("Bash"), "Edit", "Grep", "Grep", "Glob", "Write", "Write"])).toBe("[🔧 Read ×6、Bash ×4、Edit、Grep ×2，另外 3 次]");
});

test("#495: the short tool line in parts, as the board draws it: each run with how many of its calls failed, and the calls after four runs with theirs", () => {
  const calls = ["Read", "Bash", "Bash!", "Bash", "Bash", "Workflow!", "Read", "Edit!", "Grep"].map((n) => ({ name: n.replace("!", ""), arg: null, code: false, failed: n.endsWith("!") }));
  const { runs, more } = shortParts(calls);
  expect(runs.map((r) => [r.name, r.n, r.failed])).toEqual([["Read", 1, 0], ["Bash", 4, 1], ["Workflow", 1, 1], ["Read", 1, 0]]);
  expect(more).toEqual({ n: 2, failed: 1 });
});

test("a detailed tool part over 10 lines is one short line instead", () => {
  const names = Array.from({ length: 11 }, (_, i) => (i % 2 ? "Grep" : "Read"));
  expect(qq([...names.flatMap((n) => tool(n, { pattern: "x" })), ...says("ok")], { verbose: true })[0]!.split("\n")[0]).toBe("[🔧 Read、Grep、Read、Grep，另外 7 次]");
});

test("asking you, planning, keeping a to-do list (Codex's update_plan too) and a call that asked for your approval are no tool work", () => {
  const make = started("Bash", { command: "make" });
  const events = [...tool("TodoWrite", { todos: [] }), ...tool("update_plan", { text: "1. a" }), ...tool("Read", at("a.ts")), ...tool("AskUserQuestion", {}), ...tool("ExitPlanMode", {}), make, askFor(make), ended(make), ...says("ok")];
  expect(qq(events)).toEqual(["[🔧 Read]\n\nok"]);
});

// ---- QQ (im-style §3.2). ----

const SECTION_3 = [
  ...says("我先看一下配置。"),
  ...tool("Read", at("src/config.ts")),
  ...tool("Grep", { pattern: "X" }),
  ...says("配置里少了 X，我来补上，然后跑测试。"),
  ...tool("Edit", at("src/config.ts")),
  ...tool("Bash", { command: "npm test" }),
  ...tool("Bash", { command: "npm test" }),
  ...says("改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。"),
];

test("QQ: a message each time the agent finishes saying something, the tools before it in a line on top; the last one is the final reply", () => {
  expect(qq(SECTION_3)).toEqual([
    "我先看一下配置。",
    "[🔧 Read、Grep]\n\n配置里少了 X，我来补上，然后跑测试。",
    "[🔧 Edit、Bash ×2]\n\n改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。",
  ]);
  // The last waits for the turn's end, to go out as the final reply.
  let p = start();
  let mid = 0;
  for (const e of SECTION_3) {
    const r = append(p, e, { verbose: false, dir: DIR, now: 0, caps: QQ_CAPABILITIES }, 18);
    p = r.progress;
    mid += r.sends.length;
  }
  expect(mid).toBe(2);
});

test("QQ: what the agent said goes out once a tool call starts after it, one that asks you too: before the ask, not after your answer", () => {
  const v: View = { verbose: false, dir: DIR, now: 0, caps: QQ_CAPABILITIES };
  let p = start();
  const sent = [...says("Let me ask."), started("AskUserQuestion", {})].map((e) => {
    const r = append(p, e, v, 18);
    p = r.progress;
    return r.sends;
  });
  expect(sent).toEqual([[], [], ["Let me ask."]]);
});

test("QQ with detailed tool lines: one line a tool", () => {
  expect(qq(SECTION_3, { verbose: true })).toEqual([
    "我先看一下配置。",
    "[🔧 Read] src/config.ts\n[🔧 Grep] X\n\n配置里少了 X，我来补上，然后跑测试。",
    "[🔧 Edit] src/config.ts\n[🔧 Bash ×2] npm test\n\n改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。",
  ]);
});

test("QQ: tools after the last thing said send nothing; a turn that said nothing sends its tools and says so", () => {
  expect(qq([...says("Done."), ...tool("Bash", { command: "ls" })], { reply: "Done." })).toEqual(["Done."]);
  expect(qq([...tool("Bash"), ...tool("Bash")])).toEqual(["[🔧 Bash ×2]\n\n这一回合没有回复文字。"]);
  expect(qq([])).toEqual([]);
});

test("QQ: a turn that said only blank lines between its tools says nothing; all its tools show", () => {
  expect(qq([...tool("Read"), ...says("\n\n"), ...tool("Bash")])).toEqual(["[🔧 Read、Bash]\n\n这一回合没有回复文字。"]);
});

test("QQ: what is said once the quota's room is used up waits, and goes out with the final reply", () => {
  const turn = [...says("A"), ...tool("Read"), ...says("B"), ...tool("Bash"), ...says("C")];
  expect(qq(turn, { room: 1 })).toEqual(["A", "[🔧 Read]\n\nB\n\n[🔧 Bash]\n\nC"]);
  expect(qq(turn, { room: 0 })).toEqual(["A\n\n[🔧 Read]\n\nB\n\n[🔧 Bash]\n\nC"]);
  // Too long for one message, it is cut down to a sentence on top.
  const long = "x".repeat(60);
  expect(qq([...says(long), ...tool("Read"), ...says(long), ...tool("Bash"), ...says("C")], { room: 0, max: 100 })).toEqual(["中间还有 2 段话没发出来，看板上能看到。\n\n[🔧 Bash]\n\nC"]);
});

test("QQ: something said over the limit goes in pieces, the tool line only on the first; with too little room for them all it waits", () => {
  const long = Array.from({ length: 12 }, (_, i) => String(i % 10).repeat(19)).join("\n"); // 239 characters
  const turn = [...tool("Read"), ...says(long), ...tool("Bash"), ...says("done")];
  const sent = qq(turn, { max: 100 });
  expect(sent.length).toBe(4);
  expect(sent[0]).toStartWith("[🔧 Read]\n\n" + "0".repeat(19));
  expect(sent.slice(1, 3).every((m) => !m.includes("🔧"))).toBe(true);
  expect(sent.slice(0, 3).join("\n")).toBe("[🔧 Read]\n\n" + long);
  expect(sent[3]).toBe("[🔧 Bash]\n\ndone");
  expect(qq(turn, { max: 100, room: 2 })).toEqual(["中间还有 1 段话没发出来，看板上能看到。\n\n[🔧 Bash]\n\ndone"]);
});

// ---- Telegram (im-style §3.3). ----

test("Telegram: one message, in the order things happened; tool parts are quotes, the step still running their last line", () => {
  const { shows } = telegram([...SECTION_3.slice(0, -4), started("Bash", { command: "npm test" })]);
  expect(shows.at(-1)).toBe(
    "我先看一下配置。\n\n[🔧 Read] src/config.ts\n[🔧 Grep] X\n\n配置里少了 X，我来补上，然后跑测试。\n\n[🔧 Edit] src/config.ts\n[🔧 Bash] npm test\n[🔧 Bash] npm test，正在运行",
  );
  const r = edit(start(), started("Bash", { command: "npm test" }), { verbose: true, dir: DIR, now: 0, caps: TELEGRAM_CAPABILITIES });
  expect(r.out).toEqual([{ text: "[🔧 Bash] npm test，正在运行", markdown: "> [🔧 Bash] `npm test`，正在运行" }]);
});

test("Telegram: the final reply stays in the turn's message as its last part, with all that was said", () => {
  const { messages } = telegram(SECTION_3, { reply: "改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。" });
  expect(messages).toEqual([
    {
      text: "我先看一下配置。\n\n[🔧 Read] src/config.ts\n[🔧 Grep] X\n\n配置里少了 X，我来补上，然后跑测试。\n\n[🔧 Edit] src/config.ts\n[🔧 Bash ×2] npm test\n\n改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。",
      markdown:
        "我先看一下配置。\n\n> [🔧 Read] `src/config.ts`  \n> [🔧 Grep] `X`\n\n配置里少了 X，我来补上，然后跑测试。\n\n> [🔧 Edit] `src/config.ts`  \n> [🔧 Bash ×2] `npm test`\n\n改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。",
    },
  ]);
});

test("Telegram with short tool lines: a tool part is one line", () => {
  const { messages } = telegram(SECTION_3, { verbose: false });
  expect(messages.map((m) => m.markdown)).toEqual([
    "我先看一下配置。\n\n> [🔧 Read、Grep]\n\n配置里少了 X，我来补上，然后跑测试。\n\n> [🔧 Edit、Bash ×2]\n\n改好了，测试都过了。\nX 的默认值设成了 30，和文档里写的一致。",
  ]);
  const { shows } = telegram([...tool("Read"), started("Bash", { command: "npm test" })], { verbose: false });
  expect(shows.at(-1)).toBe("[🔧 Read]\n[🔧 Bash] 正在运行");
});

test("Telegram: a step running a minute or more says for how long", () => {
  const run = started("Bash", { command: "npm test" });
  const { shows } = telegram([run, { now: 59_999 }, { now: 60_000 }, { now: 2 * 3_600_000 + 10 * 60_000 }, ended(run), ...says("ok")]);
  expect(shows).toEqual([
    "[🔧 Bash] npm test，正在运行",
    "[🔧 Bash] npm test，正在运行（1 分钟）",
    "[🔧 Bash] npm test，正在运行（2 小时 10 分）",
    "[🔧 Bash] npm test",
    "[🔧 Bash] npm test\n\nok",
  ]);
});

test("Telegram: an argument with backticks still shows as code", () => {
  const r = edit(start(), started("Grep", { pattern: "a`b" }), { verbose: true, dir: DIR, now: 0, caps: TELEGRAM_CAPABILITIES });
  expect(r.out[0]!.markdown).toBe("> [🔧 Grep] ``a`b``，正在运行");
});

test("Telegram: when something else goes to the chat, the message stops as it was, without the running step, and the turn goes on in a new one", () => {
  const make = started("Bash", { command: "make" });
  const { messages } = telegram([...says("Looking."), make, "under", ended(make), ...says("Built.")]);
  expect(messages.map((m) => m.text)).toEqual(["Looking.", "[🔧 Bash] make\n\nBuilt."]);
});

test("Telegram: a call that asks for your approval shows no tool line, before the ask or after it", () => {
  const make = started("Bash", { command: "make" });
  const { messages } = telegram([...says("Looking."), make, askFor(make), "under", ended(make), ...says("Built.")]);
  expect(messages.map((m) => m.text)).toEqual(["Looking.", "Built."]);
});

test("Telegram: once the message stopped, the step it showed running is no more the turn's: a minute on, nothing shows it", () => {
  const make = started("Bash", { command: "make" });
  const { messages } = telegram([...says("Looking."), make, "under", { now: 61_000 }]);
  expect(messages.map((m) => m.text)).toEqual(["Looking."]);
});

test("Telegram: an approval as the turn's first step: its message stops with the call's line, done, and while the ask waits no clock shows the call running", () => {
  const make = started("Bash", { command: "make" });
  const { messages, shows } = telegram([make, askFor(make), "under", { now: 61_000 }, { now: 3 * 3_600_000 }, ended(make), ...says("Built.")]);
  expect(messages.map((m) => m.text)).toEqual(["[🔧 Bash] make", "Built."]);
  expect(shows.filter((s) => s.includes("正在运行（"))).toEqual([]);
});

test("Telegram: a message that showed only the step running stops with that step, done, never empty", () => {
  const send = started("Bash", { command: "rh send me hi" });
  const { messages } = telegram([send, "under"]);
  expect(messages).toEqual([{ text: "[🔧 Bash] rh send me hi", markdown: "> [🔧 Bash] `rh send me hi`" }]);
});

test("Telegram: a step a stopped message showed as all it had, done, shows in no tool line after it", () => {
  const send = started("Bash", { command: "rh send me hi" });
  const { messages } = telegram([send, "under", ended(send), ...tool("Read", at("a.ts")), ...says("Done.")]);
  expect(messages.map((m) => m.text)).toEqual(["[🔧 Bash] rh send me hi", "[🔧 Read] a.ts\n\nDone."]);
});

test("story 40, Telegram: once rh send me took the turn over, what the agent says is not shown, nor its final reply; its tool lines are, in a message under it", () => {
  const send = started("Bash", { command: "rh send me done" });
  const { messages } = telegram([...says("Looking."), send, "sent me", ended(send), ...says("Sent it."), ...tool("Read", at("a.ts")), ...says("Bye.")]);
  expect(messages.map((m) => m.text)).toEqual(["Looking.", "[🔧 Bash] rh send me done\n\n[🔧 Read] a.ts"]);
});

test("story 40, QQ: once rh send me took the turn over, what the agent says is not sent; the tools before each thing it said go alone, those before its final reply at the turn's end", () => {
  const events = [...says("Looking."), ...tool("Read", at("a.ts")), "sent me" as const, ...says("Fixing."), ...tool("Bash", { command: "ls" }), ...tool("Edit", at("a.ts")), ...says("Done.")];
  expect(qq(events)).toEqual(["Looking.", "[🔧 Read]", "[🔧 Bash、Edit]"]);
});

test("story 40, QQ: a turn rh send me took over that says nothing ends with its tool line alone, not saying it said nothing", () => {
  const [send, sent] = tool("Bash", { command: "rh send me hi" });
  expect(qq([send!, "sent me", sent!, ...tool("Bash", { command: "ls" })])).toEqual(["[🔧 Bash ×2]"]);
});

test("Telegram: over the limit, the message is cut between parts, never inside a tool part; one part over it alone is cut at a line break", () => {
  const a = Array.from({ length: 30 }, () => "a".repeat(99)).join("\n"); // 2,999 characters
  const b = Array.from({ length: 20 }, () => "b".repeat(99)).join("\n"); // 1,999 characters
  const { messages } = telegram([...says(a), ...tool("Read", at("notes.txt")), ...says(b)]);
  expect(messages.map((m) => m.text)).toEqual([`${a}\n\n[🔧 Read] notes.txt`, b]);
  const long = Array.from({ length: 45 }, (_, i) => String(i % 10).repeat(99)).join("\n");
  expect(telegram(says(long)).messages.map((m) => m.text)).toEqual([long.slice(0, 3999), long.slice(4000)]);
});

test("Telegram: a turn that only talks is just its reply", () => {
  expect(telegram([delta("Hi"), delta(" there"), message("Hi there")]).messages).toEqual([{ text: "Hi there", markdown: "Hi there" }]);
});

test("story 74: a fence line about as long as the limit, left open, comes in pieces that fit like any other text, as it streams on Telegram too", () => {
  // A fence open to the end whose first line takes the whole message: QQ's final reply, rh send me, a long ask.
  const open = "```" + "x".repeat(2000);
  expect(chunkText(open, 2000)).toEqual([open.slice(0, 2000), "xxx"]);
  // Telegram's turn message, one line of compact JSON in a fence that never closes.
  const json = "```json " + '{"k":1},'.repeat(520);
  const { out } = edit(start(), delta(json), { verbose: true, dir: DIR, now: 0, caps: TELEGRAM_CAPABILITIES });
  expect(out.map((m) => m.text)).toEqual([json.slice(0, 4096), json.slice(4096)]);
});

test("story 73: a code block cut between QQ messages closes at the end of one and opens again at the start of the next, so each shows as code", () => {
  const code = Array.from({ length: 30 }, (_, i) => `let a${String(i).padStart(2, "0")} = 1; // some padding`).join("\n");
  const text = `Here:\n\`\`\`js\n${code}\n\`\`\`\nDone.`;
  const sent = qq([...says(text), ...tool("Read"), ...says("ok")], { max: 500 });
  const pieces = sent.slice(0, -1);
  expect(pieces.length).toBeGreaterThan(1);
  for (const m of pieces) expect(m.match(/^```/gm)!.length % 2).toBe(0);
  expect(pieces[0]).toStartWith("Here:\n```js\n");
  expect(pieces[0]).toEndWith("\n```");
  expect(pieces[1]).toStartWith("```js\n");
  expect(pieces.at(-1)).toEndWith("\n```\nDone.");
});

// Moved from qq-cli (test/qq.test.ts) as is.
test("chunkText", () => {
  expect(chunkText("short", 2000)).toEqual(["short"]);
  expect(chunkText("", 2000)).toEqual([]);
  const long = "a".repeat(4500);
  const c = chunkText(long, 2000);
  expect(c.map((x) => x.length)).toEqual([2000, 2000, 500]);
  const lines = "line\n".repeat(600).trim();
  for (const x of chunkText(lines, 2000)) {
    expect(x.length).toBeLessThanOrEqual(2000);
    expect(x.startsWith("line")).toBe(true);
  }
  expect(chunkText(lines, 2000).join("\n")).toBe(lines);
  const emoji = "a" + "😀".repeat(1500); // surrogate pairs must not be split
  expect(chunkText(emoji, 2000).join("")).toBe(emoji);
  for (const x of chunkText(emoji, 2000)) expect(x).not.toMatch(/^[\uDC00-\uDFFF]/);
});

test("story 74: text over the limit splits at line breaks; a code block cut in two closes, and the next piece opens it again with its language", () => {
  const code = Array.from({ length: 30 }, (_, i) => `let x${i} = ${i};`).join("\n");
  const text = `Here is the fix:\n\n\`\`\`rust\n${code}\n\`\`\`\n\nThat's all.`;
  const pieces = chunkText(text, 200);
  expect(pieces.length).toBeGreaterThan(1);
  for (const p of pieces) expect(p.length).toBeLessThanOrEqual(200);
  // Every piece is whole Markdown: each code fence it opens, it closes.
  for (const p of pieces) expect(p.match(/^```/gm)!.length % 2).toBe(0);
  expect(pieces[0]).toStartWith("Here is the fix:\n\n```rust\nlet x0 = 0;");
  expect(pieces[0]).toEndWith("\n```");
  expect(pieces[1]).toStartWith("```rust\n");
  expect(pieces.at(-1)).toEndWith("```\n\nThat's all.");
  // Taking the added fence lines out again gives back the text.
  const fence = /\n```\n```rust\n/g;
  expect(pieces.join("\n").replace(fence, "\n")).toBe(text);
});

test("story 74: a line opening with inline code is no fence: a backtick fence's info string has no backticks", () => {
  const line = "```a``` " + "字".repeat(2100);
  expect(chunkText(line, 2000)).toEqual([line.slice(0, 2000), line.slice(2000)]);
  expect(markdown("```a``` and Vec<T>\nVec<T>", TELEGRAM_CAPABILITIES)).toBe("```a``` and Vec&lt;T>\nVec&lt;T>");
});

test("story 73: the same Markdown in Telegram's and in QQ's: Telegram reads $, ||, == and HTML tags as its own syntax, so outside code they are escaped; QQ takes it as it is", () => {
  const md = "## Plan\n\n- costs $5 to $10, `$HOME` stays\n- Vec<T> and a || b, x == y, AT&T\n\n```sh\necho $PATH || true\n```";
  expect(markdown(md, TELEGRAM_CAPABILITIES)).toBe(
    "## Plan\n\n- costs \\$5 to \\$10, `$HOME` stays\n- Vec&lt;T> and a \\|\\| b, x \\=\\= y, AT&amp;T\n\n```sh\necho $PATH || true\n```",
  );
  expect(markdown(md, QQ_CAPABILITIES)).toBe(md);
  // A platform that shows plain text only gets none.
  expect(markdown(md, { ...QQ_CAPABILITIES, markdown: null })).toBeUndefined();
});

test("story 457: on Feishu, & and < outside code are entities and :name: has its first colon one, so the agent's :OK: and <font> show as written; in code nothing changes", () => {
  const caps = feishuCapabilities(3000);
  const md = "Say :OK: and <font color='red'>red</font>, a < b && c, 12:30:45\n`:OK: <b>`\n```\n:OK: <at id=all></at> &\n```";
  expect(markdown(md, caps)).toBe("Say &#58;OK: and &lt;font color='red'>red&lt;/font>, a &lt; b &amp;&amp; c, 12&#58;30:45\n`:OK: <b>`\n```\n:OK: <at id=all></at> &\n```");
  // The rest is GFM as written: the agent's own Markdown.
  expect(markdown("__init__.py and ~~gone~~ and $5", caps)).toBe("__init__.py and ~~gone~~ and $5");
});

test("story 457: on Feishu a link to anything but http or https keeps only its text, which Feishu would turn the whole card down for; http links, pictures and code stay", () => {
  const caps = feishuCapabilities(3000);
  const md = "See [render.ts](src/render.ts#L12), [`main.ts`](/srv/proj/main.ts) and [docs](https://open.feishu.cn/a?b=1) or [x](HTTP://x.y)\n![shot](shot.png) `[a](b.ts)`";
  expect(markdown(md, caps)).toBe("See render.ts, `main.ts` and [docs](https://open.feishu.cn/a?b=1) or [x](HTTP://x.y)\n![shot](shot.png) `[a](b.ts)`");
  // Telegram keeps them.
  expect(markdown("[a](b.ts)", TELEGRAM_CAPABILITIES)).toBe("[a](b.ts)");
});

test("#397: QQ takes a line's # as a heading with no space after it, so there it is escaped; a real heading, code and Telegram stay as they are", () => {
  const md = [
    "   - #393 断线不丢；",
    "   - #396 `rh bot` 扫码或粘贴",
    "#tag",
    "> 1. #1",
    "2) ##x",
    "# 标题",
    "## 小节",
    "a #393 and `#x`",
    "`#x` #y",
    "```",
    "#include <x>",
    "```",
  ].join("\n");
  expect(markdown(md, QQ_CAPABILITIES)).toBe(
    [
      "   - \\#393 断线不丢；",
      "   - \\#396 `rh bot` 扫码或粘贴",
      "\\#tag",
      "> 1. \\#1",
      "2) \\##x",
      "# 标题",
      "## 小节",
      "a #393 and `#x`",
      "`#x` #y",
      "```",
      "#include <x>",
      "```",
    ].join("\n"),
  );
  expect(markdown(md, TELEGRAM_CAPABILITIES)).toBe(md);
});
