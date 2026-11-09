// The transcript reader, through its public interface, on copies of real
// transcripts (test/fixtures/transcripts/) and a generated large file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeSettings, codexSettings, findConversations, fullText, piSettings, lastSaid, listConversations, messagePage, readPage, recentMessages, startedIn, type Block, type Page } from "../src/transcript.ts";

const FIXTURES = join(import.meta.dir, "fixtures/transcripts");
const PI_ID = "00000000-0000-4000-8000-4c4a2a950dc8";
// pi names its session file by the start time, which the fixture's synthesis moves; the id stays.
const PI_FILE = join(FIXTURES, "pi", readdirSync(join(FIXTURES, "pi")).find((f) => f.endsWith(`_${PI_ID}.jsonl`))!);
const CLAUDE_ID = "00000000-0000-4000-8000-645e563d4553";
const CLAUDE_FILE = join(FIXTURES, "claude", `${CLAUDE_ID}.jsonl`);
const PI_SIZE = statSync(PI_FILE).size;
/** When a fixture says its conversation began: the time of its first timestamped line. */
const startOf = (file: string) => new Date(readFileSync(file, "utf8").split("\n").flatMap((l) => (l ? [JSON.parse(l).timestamp] : [])).find(Boolean));

const tmp = mkdtempSync(join(tmpdir(), "rhodium-test-transcript-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("readPage", () => {
  test("reads a pi session forward, giving type, role and content", async () => {
    const page = await readPage(PI_FILE, 0, 100, "forward");
    expect(page.entries.map((e) => [e.type, e.role])).toEqual([
      ["session", undefined],
      ["model_change", undefined],
      ["thinking_level_change", undefined],
      ["message", "system"],
      ["message", "user"],
      ["message", "assistant"],
      ["message", "toolResult"],
      ["message", "assistant"],
      ["compaction", undefined],
    ]);
    expect(page.entries[4]!.content).toEqual([
      { type: "text", text: "Run `echo hello from bash` with the bash tool, then reply with the single word: done." },
    ]);
    expect(page.start).toBe(0);
    expect(page.end).toBe(PI_SIZE);
  });

  // Claude's api-request-blob lines (lines 18, 19 and 28 of the fixture) hold the
  // whole API request, CLAUDE.md and email included (redacted here), and are skipped.
  const claudeLines = readFileSync(CLAUDE_FILE, "utf8").split("\n").slice(0, -1);
  const shown = claudeLines.filter((l) => JSON.parse(l).type !== "api-request-blob");

  test("paging back from the end and forward again gives every shown line once, in order", async () => {
    expect(claudeLines.length).toBe(32);
    expect(shown.length).toBe(29);

    const back: Page[] = [];
    let at = Infinity;
    do {
      const page = await readPage(CLAUDE_FILE, at, 5, "backward");
      back.unshift(page);
      at = page.start;
    } while (at > 0);
    expect(back.map((p) => p.entries.length)).toEqual([4, 5, 5, 5, 5, 5]);
    expect(back.flatMap((p) => p.entries.map((e) => e.raw))).toEqual(shown);

    const forward: Page[] = [];
    at = 0;
    for (;;) {
      const page = await readPage(CLAUDE_FILE, at, 5, "forward");
      if (page.entries.length === 0) break;
      forward.push(page);
      at = page.end;
    }
    expect(forward.flatMap((p) => p.entries.map((e) => e.raw))).toEqual(shown);
    expect(at).toBe(statSync(CLAUDE_FILE).size);
  });

  test("a page of one moves past skipped lines instead of coming back empty", async () => {
    const back: string[] = [];
    for (let at = Infinity; at > 0; ) {
      const page = await readPage(CLAUDE_FILE, at, 1, "backward");
      expect(page.entries.length).toBe(1);
      back.unshift(page.entries[0]!.raw);
      at = page.start;
    }
    expect(back).toEqual(shown);

    const forward: string[] = [];
    for (let at = 0; ; ) {
      const page = await readPage(CLAUDE_FILE, at, 1, "forward");
      if (page.entries.length === 0) break;
      forward.push(page.entries[0]!.raw);
      at = page.end;
    }
    expect(forward).toEqual(shown);
  });

  test("a line still being appended is left out until its newline arrives", async () => {
    const file = join(tmp, "growing.jsonl");
    copyFileSync(PI_FILE, file);
    const next = '{"type":"session_info","id":"a1b2c3d4","parentId":"00105901","name":"probe"}';
    appendFileSync(file, next.slice(0, 30));

    const tail = await readPage(file, Infinity, 2, "backward");
    expect(tail.entries.map((e) => e.type)).toEqual(["message", "compaction"]);
    expect(tail.end).toBe(PI_SIZE);
    expect((await readPage(file, tail.end, 10, "forward")).entries).toEqual([]);

    appendFileSync(file, next.slice(30) + "\n");
    const more = await readPage(file, tail.end, 10, "forward");
    expect(more.entries.map((e) => e.raw)).toEqual([next]);
    expect(more.entries[0]).toMatchObject({ offset: PI_SIZE, type: "session_info" });
  });

  test("long lines with multi-byte text come back whole in both directions", async () => {
    const file = join(tmp, "long.jsonl");
    const long = JSON.stringify({ type: "user", message: { role: "user", content: "对话记录".repeat(50_000) } });
    const lines = ['{"type":"a"}', long, '{"type":"b"}', long + long];
    writeFileSync(file, lines.join("\n") + "\n");

    const back: string[] = [];
    for (let at = Infinity; at > 0; ) {
      const page = await readPage(file, at, 1, "backward");
      back.unshift(...page.entries.map((e) => e.raw));
      at = page.start;
    }
    expect(back).toEqual(lines);

    const forward: string[] = [];
    for (let at = 0; ; ) {
      const page = await readPage(file, at, 1, "forward");
      if (page.entries.length === 0) break;
      forward.push(...page.entries.map((e) => e.raw));
      at = page.end;
    }
    expect(forward).toEqual(lines);
  });

  test("lines it does not understand come back as they are", async () => {
    const file = join(tmp, "odd.jsonl");
    const lines = ["not json at all", "[1,2]", "", '{"type":"mystery","x":1}', '{"type":"user","message":{"role":"user","content":"hi"}}'];
    writeFileSync(file, lines.join("\n") + "\n");
    const page = await readPage(file, 0, 10, "forward");
    expect(page.entries).toEqual([
      { offset: 0, raw: "not json at all" },
      { offset: 16, raw: "[1,2]" },
      { offset: 22, raw: "" },
      { offset: 23, raw: '{"type":"mystery","x":1}', type: "mystery" },
      { offset: 48, raw: lines[4]!, type: "user", role: "user", content: "hi" },
    ]);
  });
});

describe("listConversations", () => {
  const home = join(tmp, "home");
  const savedHome = process.env.HOME;
  beforeAll(() => (process.env.HOME = home));
  afterAll(() => (process.env.HOME = savedHome));

  // Where Claude Code and pi keep a directory's conversations: every
  // non-alphanumeric character becomes "-" for Claude; pi drops the leading
  // "/", turns "/" "\" ":" into "-" and wraps the result in "--".
  const DIR = "/srv/work/my_app.v2";
  const claudeDir = join(home, ".claude/projects/-srv-work-my-app-v2");
  const piDir = join(home, ".pi/agent/sessions/--srv-work-my_app.v2--");

  function place(src: string, dir: string, name: string, mtime: string) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, name));
    utimesSync(join(dir, name), new Date(mtime), new Date(mtime));
  }

  test("lists the Claude and pi conversations of a directory, newest first", async () => {
    place(CLAUDE_FILE, claudeDir, `${CLAUDE_ID}.jsonl`, "2026-10-21T01:00:00Z");
    place(PI_FILE, piDir, basename(PI_FILE), "2026-10-21T02:00:00Z");
    // Another directory's conversation, and a Claude subagent file, are not listed.
    place(CLAUDE_FILE, join(home, ".claude/projects/-srv-work-other"), "11111111-1111-1111-1111-111111111111.jsonl", "2026-10-21T03:00:00Z");
    place(CLAUDE_FILE, join(claudeDir, CLAUDE_ID, "subagents"), "agent-x.jsonl", "2026-10-21T03:00:00Z");

    expect(await listConversations(DIR)).toEqual([
      {
        id: PI_ID,
        agent: "pi",
        file: join(piDir, basename(PI_FILE)),
        startedAt: startOf(PI_FILE),
        modifiedAt: new Date("2026-10-21T02:00:00Z"),
        title: "Run `echo hello from bash` with the bash tool, then reply with the single word: done.",
      },
      {
        id: CLAUDE_ID,
        agent: "claude",
        file: join(claudeDir, `${CLAUDE_ID}.jsonl`),
        startedAt: startOf(CLAUDE_FILE),
        modifiedAt: new Date("2026-10-21T01:00:00Z"),
        title: "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options red and b",
      },
    ]);
  });

  test("a pi conversation named with /name is listed by its latest name, not its first message", async () => {
    const dir = "/srv/named";
    const lines = [
      '{"type":"session","version":3,"id":"0199f000-0000-7000-8000-000000000001","timestamp":"2026-10-19T08:00:00.000Z","cwd":"/srv/named"}',
      '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-10-19T08:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the build"}]}}',
      '{"type":"session_info","id":"a2","parentId":"a1","name":"build"}',
      '{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-10-19T08:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}}',
      '{"type":"session_info","id":"a4","parentId":"a3","name":"build fix, round two"}',
    ];
    const sessions = join(home, ".pi/agent/sessions/--srv-named--");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "2026-10-19T08-00-00-000Z_0199f000-0000-7000-8000-000000000001.jsonl"), lines.join("\n") + "\n");
    expect((await listConversations(dir))[0]!.title).toBe("build fix, round two");
  });

  test("the first user message skips notices, slash commands and tool results", async () => {
    const dir = "/srv/typed";
    const lines = [
      "garbage",
      '{"type":"summary","summary":"Earlier work"}',
      '{"type":"user","timestamp":"2026-10-19T08:00:00.000Z","isMeta":true,"message":{"role":"user","content":"## Context Usage"}}',
      '{"type":"user","timestamp":"2026-10-19T08:00:01.000Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}',
      '{"type":"user","timestamp":"2026-10-19T08:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}',
      '{"type":"user","timestamp":"2026-10-19T08:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"  fix\\nthe   build  "}]}}',
    ];
    mkdirSync(join(home, ".claude/projects/-srv-typed"), { recursive: true });
    writeFileSync(join(home, ".claude/projects/-srv-typed/c0ffee00-0000-4000-8000-000000000000.jsonl"), lines.join("\n") + "\n");
    const [c] = await listConversations(dir);
    expect(c).toMatchObject({ startedAt: new Date("2026-10-19T08:00:00.000Z"), title: "fix the build" });
  });

  // One Claude conversation in `dir` whose first line is a user message with `content`.
  async function firstUserMessage(dir: string, content: unknown): Promise<string | undefined> {
    const projects = join(home, ".claude/projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    const line = JSON.stringify({ type: "user", timestamp: "2026-10-19T08:00:00.000Z", message: { role: "user", content } });
    writeFileSync(join(projects, "c0ffee00-0000-4000-8000-000000000001.jsonl"), line + "\n");
    return (await listConversations(dir))[0]?.title;
  }

  test("the first user message keeps what was typed beside IDE context", async () => {
    const content = [
      { type: "text", text: "<ide_opened_file>The user opened the file /srv/ide/src/main.ts in the IDE.</ide_opened_file>" },
      { type: "text", text: "fix the build" },
    ];
    expect(await firstUserMessage("/srv/ide", content)).toBe("fix the build");
  });

  test("a conversation that opens with a paste opens with the pasted text", async () => {
    const content = '<pasted_content id="2117">\nPR #240 is merged.\n</pasted_content id="2117"> Open the next one.';
    expect(await firstUserMessage("/srv/paste", content)).toBe("PR #240 is merged. Open the next one.");
  });

  // The largest transcript on this machine is 121MB.
  test("a 110MB transcript is listed and paged without reading it all into memory", async () => {
    const dir = join(home, ".claude/projects/-srv-big");
    const file = join(dir, "b16b16b1-0000-4000-8000-000000000000.jsonl");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(900) }] },
    }) + "\n";
    const block = line.repeat(1024);
    const fd = openSync(file, "w");
    let size = 0;
    while (size < 110 * 1024 * 1024) size += writeSync(fd, block);
    // The only typed message is the last line, so listing has to scan the whole file.
    writeSync(fd, '{"type":"user","message":{"role":"user","content":"the end"}}\n');
    closeSync(fd);

    Bun.gc(true);
    const base = process.memoryUsage.rss();
    let peak = base;
    const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 2);
    try {
      const [c] = await listConversations("/srv/big");
      expect(c!.title).toBe("the end");

      let page = await readPage(file, Infinity, 50, "backward");
      expect(page.entries.at(-1)!.content).toBe("the end");
      for (let i = 0; i < 20; i++) page = await readPage(file, page.start, 50, "backward");
      const mid = await readPage(file, Math.floor(size / 2 / line.length) * line.length, 50, "forward");
      expect(mid.entries.map((e) => e.raw + "\n")).toEqual(Array(50).fill(line));
    } finally {
      clearInterval(sample);
    }
    peak = Math.max(peak, process.memoryUsage.rss());
    // Reading the whole file would take at least its 110MB.
    expect((peak - base) / 2 ** 20).toBeLessThan(64);
    rmSync(dir, { recursive: true });
  }, 30_000);

  test("a file gone between listing the directory and reading it is left out", async () => {
    const dir = join(home, ".claude/projects/-srv-gone");
    place(CLAUDE_FILE, dir, `${CLAUDE_ID}.jsonl`, "2026-10-21T01:00:00Z");
    // A name that is not UTF-8 is listed with U+FFFD in it, and that name finds
    // no file: the same ENOENT as a file Claude's cleanup deletes mid-listing.
    writeFileSync(Buffer.concat([Buffer.from(join(dir, "gone-")), Buffer.from([0xff]), Buffer.from(".jsonl")]), "{}\n");
    expect((await listConversations("/srv/gone")).map((c) => c.id)).toEqual([CLAUDE_ID]);
  });

  test("a directory with no conversations lists nothing", async () => {
    expect(await listConversations("/srv/nowhere")).toEqual([]);
  });
});

describe("recentMessages", () => {
  const home = join(tmp, "home-recent");
  const savedHome = process.env.HOME;
  beforeAll(() => (process.env.HOME = home));
  afterAll(() => (process.env.HOME = savedHome));

  test("cuts each message at a character as you see it, never inside an emoji", async () => {
    const dir = join(home, ".claude/projects/-srv-recent");
    mkdirSync(dir, { recursive: true });
    const said = (role: string, content: unknown) => JSON.stringify({ type: role, message: { role, content } });
    writeFileSync(join(dir, "s1.jsonl"), [said("user", "ab👨‍👩‍👧cd"), said("assistant", [{ type: "text", text: "ok👍🏽" }])].join("\n") + "\n");
    expect(await recentMessages("/srv/recent", "claude", "s1", 10, 3)).toEqual([
      { role: "user", text: "ab👨‍👩‍👧…" },
      { role: "assistant", text: "ok👍🏽" },
    ]);
  });

  test("#228: what you send while a turn runs is among the messages rh read shows; a task's notice is not", async () => {
    const dir = join(home, ".claude/projects/-srv-recent");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "user", message: { role: "user", content: "fix the typo" } },
      { type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "[来自 QQ 私聊]\nalso the title" }], commandMode: "prompt", origin: { kind: "human" } } },
      { type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>\n</task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } } },
      { type: "attachment", attachment: { type: "queued_command", prompt: "a peer's", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed both." }] } },
    ];
    writeFileSync(join(dir, "s2.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await recentMessages("/srv/recent", "claude", "s2", 10, 100)).toEqual([
      { role: "user", text: "fix the typo" },
      { role: "user", text: "[来自 QQ 私聊] also the title" },
      { role: "assistant", text: "Fixed both." },
    ]);
  });
});

describe("messagePage", () => {
  /** A transcript file of these lines, each an object as JSON or a string as it is. */
  const transcript = (name: string, lines: unknown[]) => {
    const file = join(tmp, name);
    writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
    return file;
  };
  /** The byte offset of each line of the file. */
  const offsets = (file: string) => {
    const out = [0];
    for (const l of readFileSync(file, "utf8").split("\n").slice(0, -1)) out.push(out.at(-1)! + Buffer.byteLength(l) + 1);
    return out.slice(0, -1);
  };
  const T = (s: number) => `2026-10-23T01:00:0${s}.000Z`;
  /** What a block says, without where it is. */
  const said = (b: Block) => {
    if (b.kind === "user") return [b.kind, b.source, b.text];
    if (b.kind === "tool") return [b.kind, b.id, b.result?.text ?? null];
    if (b.kind === "result") return [b.kind, b.id, b.text];
    if (b.kind === "system") return [b.kind, b.title];
    return [b.kind, b.text];
  };
  const latest = (file: string) => messagePage(file, Infinity, "backward", "/w");

  // One turn, as Claude and pi write it down, each with lines of its own the page leaves out.
  const CLAUDE = [
    { type: "queue-operation", operation: "enqueue", timestamp: T(0) },
    { type: "user", timestamp: T(1), message: { role: "user", content: "[来自 QQ 私聊]\nfix the typo" } },
    { type: "attachment", timestamp: T(1), attachment: { type: "date", date: "2026-10-23" } },
    { type: "assistant", timestamp: T(2), message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] } },
    { type: "assistant", timestamp: T(2), message: { role: "assistant", content: [{ type: "thinking", thinking: "README first.", signature: "s" }] } },
    { type: "assistant", timestamp: T(3), message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/w/README.md" } }] } },
    { type: "user", timestamp: T(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "teh typo" }] }] } },
    { type: "assistant", timestamp: T(5), message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } },
    { type: "system", subtype: "turn_duration", durationMs: 4000, timestamp: T(5) },
    { type: "last-prompt", lastPrompt: "fix the typo" },
    { type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: T(6) },
    { type: "user", isCompactSummary: true, timestamp: T(6), message: { role: "user", content: "This session is being continued from a previous conversation." } },
  ];
  const PI = [
    { type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/w" },
    { type: "thinking_level_change", thinkingLevel: "high", timestamp: T(0) },
    { type: "message", timestamp: T(1), message: { role: "user", content: [{ type: "text", text: "[来自 QQ 私聊]\nfix the typo" }] } },
    {
      type: "message",
      timestamp: T(3),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "README first." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/w/README.md" } }] },
    },
    { type: "message", timestamp: T(4), message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "teh typo" }], isError: false } },
    { type: "message", timestamp: T(5), message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } },
    { type: "custom", customType: "codex-footer-metrics", data: {}, timestamp: T(5) },
    { type: "compaction", timestamp: T(6), summary: "Fixed a typo in the README.", tokensBefore: 100 },
  ];

  test("stories 192, 193, 194, 198: Claude's and pi's record of one turn give the same blocks, without the lines that are not the conversation", async () => {
    const turn = [
      ["user", "QQ 私聊", "fix the typo"],
      ["thinking", "README first."],
      ["tool", "c1", "teh typo"],
      ["assistant", "Fixed it."],
      ["system", "压缩了对话"],
    ];
    const claude = transcript("same-claude.jsonl", CLAUDE);
    const pi = transcript("same-pi.jsonl", PI);
    expect((await latest(claude)).blocks.map(said)).toEqual(turn);
    expect((await latest(pi)).blocks.map(said)).toEqual(turn);

    // Each block where its line is, and when that was written; a tool's result has its own.
    const [user, thinking, tool] = (await latest(pi)).blocks;
    const at = offsets(pi);
    expect(user).toMatchObject({ at: `${at[2]}.0`, time: Date.parse(T(1)) });
    expect(thinking).toMatchObject({ at: `${at[3]}.0`, time: Date.parse(T(3)) });
    expect(tool).toMatchObject({ at: `${at[3]}.1`, name: "read", result: { at: `${at[4]}.0`, time: Date.parse(T(4)), error: false } });
    expect(JSON.parse((tool as Extract<Block, { kind: "tool" }>).input)).toEqual({ path: "/w/README.md" });
    expect((await latest(pi)).blocks[4]).toMatchObject({ kind: "system", text: "Fixed a typo in the README." });
  });

  test("story 193: real transcripts: the turns, and pi's change of model; a line that is not JSON is a system line", async () => {
    expect((await latest(CLAUDE_FILE)).blocks.map(said)).toEqual([
      ["user", null, "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options red and blue. After I answer, reply with just the color."],
      ["tool", "toolu_000010724704293211215979", 'Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue with these answers in mind.'],
      ["assistant", "Blue"],
    ]);
    expect((await latest(PI_FILE)).blocks.map(said)).toEqual([
      ["system", "换模型：deepseek/deepseek-flash"],
      ["user", null, "Run `echo hello from bash` with the bash tool, then reply with the single word: done."],
      ["tool", "call_000051070417743505142745048097", "hello from bash\n"],
      ["assistant", "done"],
      ["system", "压缩了对话"],
    ]);
    const odd = transcript("odd-blocks.jsonl", ["not json at all", CLAUDE[7]]);
    expect((await latest(odd)).blocks).toEqual([
      { kind: "system", at: "0.0", time: null, title: "看不懂的一行", text: "not json at all" },
      { kind: "assistant", at: "16.0", time: Date.parse(T(5)), text: "Fixed it." },
    ]);
  });

  test("story 193: what Claude writes in tags as your words gives no blocks: a task's notice, a slash command, its output, IDE context; what you pasted is yours", async () => {
    const file = transcript("tagged.jsonl", [
      { type: "user", timestamp: T(1), origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>" } },
      { type: "user", timestamp: T(1), message: { role: "user", content: "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>" } },
      { type: "user", timestamp: T(1), message: { role: "user", content: "<local-command-stdout>Set effort level to high</local-command-stdout>" } },
      { type: "user", timestamp: T(2), message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>The user opened /w/README.md.</ide_opened_file>" }, { type: "text", text: "fix the typo" }] } },
      { type: "user", timestamp: T(3), message: { role: "user", content: '<pasted_content id="1">\nteh typo\n</pasted_content id="1">' } },
    ]);
    expect((await latest(file)).blocks.map(said)).toEqual([
      ["user", null, "fix the typo"],
      ["user", null, '<pasted_content id="1">\nteh typo\n</pasted_content id="1">'],
    ]);
  });

  // #228: what you send while a turn runs, as Claude records it once it takes it in: an attachment, beside
  // the queue's own lines; a task's notice and another session's message come the same way. Sanitised
  // from real transcripts; the image's data is cut short.
  const queued = (s: number, prompt: unknown, more: object = { origin: { kind: "human" }, humanTurn: true }) => ({
    type: "attachment",
    uuid: "a1",
    timestamp: T(s),
    attachment: { type: "queued_command", prompt, source_uuid: "u1", commandMode: "prompt", ...more, timestamp: T(s) },
    rendered: [{ content: "<system-reminder>\nThe user sent a new message while you were working:\n…\n</system-reminder>" }],
    renderedRole: "system",
  });
  const MID_TURN = [
    CLAUDE[1],
    CLAUDE[5],
    { type: "queue-operation", operation: "enqueue", timestamp: T(3), content: "[来自 QQ 私聊]\nalso the title" },
    { type: "queue-operation", operation: "remove", timestamp: T(3), content: "[来自 QQ 私聊]\nalso the title" },
    CLAUDE[6],
    queued(4, [{ type: "text", text: "[来自 QQ 私聊]\nalso the title" }]),
    queued(4, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, { type: "text", text: "this one too" }]),
    queued(4, "typed in the TUI", {}), // older Claude: no origin
    queued(4, "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>", {
      commandMode: "task-notification",
      origin: { kind: "task-notification", producer: "session-task" },
    }),
    queued(4, "<task-notification>\n<task-id>a2</task-id>\n</task-notification>", { commandMode: "task-notification" }), // older Claude: no origin
    queued(4, '<cross-session-message from="uds:/run/s.sock">\nhello\n</cross-session-message>', { origin: { kind: "peer", body: "hello" }, isMeta: true }),
    queued(4, "from a peer, untagged", { origin: { kind: "peer" } }), // its origin alone keeps it out
    CLAUDE[7],
  ];

  test("#228: what you send while a turn runs is your message where Claude took it in, with its source line; a task's notice or a peer's message is not", async () => {
    const file = transcript("mid-turn.jsonl", MID_TURN);
    const page = await latest(file);
    expect(page.blocks.map(said)).toEqual([
      ["user", "QQ 私聊", "fix the typo"],
      ["tool", "c1", "teh typo"],
      ["user", "QQ 私聊", "also the title"],
      ["user", null, "this one too"],
      ["user", null, "typed in the TUI"],
      ["assistant", "Fixed it."],
    ]);
    // By the uuid it was sent with, as the user line it would have been (#513).
    expect(page.blocks[2]).toMatchObject({ at: `${offsets(file)[5]}.0`, time: Date.parse(T(4)), id: "u1" });
    expect(await lastSaid(transcript("mid-turn-last.jsonl", MID_TURN.slice(0, -1)))).toEqual({ role: "user", text: "typed in the TUI", at: Date.parse(T(4)) });
    expect(await lastSaid(transcript("mid-turn-last-src.jsonl", MID_TURN.slice(0, 6)))).toEqual({ role: "user", text: "also the title", at: Date.parse(T(4)), source: "QQ 私聊" });
  });

  test("#228: what you send while pi's turn runs (a steer) is your message where pi took it in, image and all", async () => {
    const steer = { type: "message", timestamp: T(4), message: { role: "user", content: [{ type: "text", text: "[来自 Telegram 私聊]\nalso the title" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } };
    const file = transcript("pi-steer.jsonl", [...PI.slice(0, 5), steer, PI[5]]);
    expect((await latest(file)).blocks.map(said)).toEqual([
      ["user", "QQ 私聊", "fix the typo"],
      ["thinking", "README first."],
      ["tool", "c1", "teh typo"],
      ["user", "Telegram 私聊", "also the title"],
      ["assistant", "Fixed it."],
    ]);
  });

  test("story 193: Claude's note that you pressed Esc is a system line, not your words, and does not count toward a page's 20", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => [
      { type: "user", timestamp: T(1), message: { role: "user", content: `q${i}` } },
      { type: "user", timestamp: T(2), message: { role: "user", content: [{ type: "text", text: `[Request interrupted by user${i % 2 ? " for tool use" : ""}]` }] } },
    ]).flat();
    const page = await latest(transcript("interrupted.jsonl", lines));
    expect(page.start).toBe(0);
    expect(page.blocks.slice(0, 4).map(said)).toEqual([
      ["user", null, "q0"],
      ["system", "你打断了回合"],
      ["user", null, "q1"],
      ["system", "你打断了回合"],
    ]);
  });

  test("story 197: a long tool argument, result, thought or system line comes cut to its start with its whole length; fullText has the whole", async () => {
    const long = (c: string) => `${c.repeat(2999)}end`;
    // As Claude writes down a result too large to keep: the start of it, and where the rest went.
    const persisted = `<persisted-output>\nOutput too large (629.3KB). Full output saved to: /home/u/.claude/projects/-w/s1/tool-results/c2.txt\n\nPreview (first 2KB):\n${"x".repeat(2048)}\n...\n</persisted-output>`;
    const file = transcript("long.jsonl", [
      { type: "user", timestamp: T(1), message: { role: "user", content: long("说") } },
      { type: "assistant", timestamp: T(2), message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Write", input: { file_path: "/w/a", content: long("w") } }] } },
      { type: "user", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: long("r"), is_error: true }] } },
      { type: "assistant", timestamp: T(4), message: { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "cat big" } }] } },
      { type: "user", timestamp: T(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: persisted }] } },
      { type: "message", timestamp: T(6), message: { role: "assistant", content: [{ type: "thinking", thinking: long("t") }, { type: "text", text: long("a") }] } },
      { type: "compaction", timestamp: T(7), summary: long("s") },
    ]);
    const [user, write, bash, thinking, assistant, system] = (await latest(file)).blocks as any[];
    // What you and the agent said comes whole.
    expect([user.text, assistant.text]).toEqual([long("说"), long("a")]);
    expect(user.length).toBeUndefined();
    const input = JSON.stringify({ file_path: "/w/a", content: long("w") }, null, 2);
    expect(write).toMatchObject({ input: input.slice(0, 2000), length: input.length, result: { text: "r".repeat(2000), length: 3002, error: true } });
    expect(bash.result).toMatchObject({ text: persisted.slice(0, 2000), length: persisted.length });
    expect(thinking).toMatchObject({ text: "t".repeat(2000), length: 3002 });
    expect(system).toMatchObject({ title: "压缩了对话", text: "s".repeat(2000), length: 3002 });

    expect(await fullText(file, write.at)).toBe(input);
    expect(await fullText(file, write.result.at)).toBe(long("r"));
    // Only what the transcript has: not the file Claude saved the rest in.
    expect(await fullText(file, bash.result.at)).toBe(persisted);
    expect(await fullText(file, thinking.at)).toBe(long("t"));
    expect(await fullText(file, system.at)).toBe(long("s"));
    // No block there.
    expect(await fullText(file, `${thinking.at.split(".")[0]}.7`)).toBeNull();
  });

  test("story 196: a tool call comes with its name and argument as a detailed tool line has them, nothing hidden, though its arguments come cut", async () => {
    const file = transcript("shown.jsonl", [
      {
        type: "assistant",
        timestamp: T(1),
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "c1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer abc1'" } },
            { type: "tool_use", id: "c2", name: "Write", input: { file_path: "/w/src/a.ts", content: "x".repeat(3000) } },
            { type: "tool_use", id: "c3", name: "mcp__github__get_issue", input: { number: 1 } },
          ],
        },
      },
      PI[3],
    ]);
    const tools = (await latest(file)).blocks.flatMap((b) => (b.kind === "tool" ? [b.shown] : []));
    expect(tools).toEqual([
      { name: "Bash", arg: "curl -H 'Authorization: Bearer abc1'", code: true },
      { name: "Write", arg: "src/a.ts", code: true },
      { name: "github.get_issue", arg: null, code: false },
      { name: "Read", arg: "README.md", code: true },
    ]);
  });

  /** Every page of the file back from its end, oldest first. */
  async function pagesBack(file: string) {
    const pages = [await latest(file)];
    while (pages[0]!.start > 0) pages.unshift(await messagePage(file, pages[0]!.start, "backward", "/w"));
    return pages;
  }
  /** Every page of the file forward from its start. */
  async function pagesForward(file: string) {
    const pages = [await messagePage(file, 0, "forward", "/w")];
    while (pages.at(-1)!.blocks.length) pages.push(await messagePage(file, pages.at(-1)!.end, "forward", "/w"));
    return pages.slice(0, -1);
  }
  const talk = (bs: Block[]) => bs.filter((b) => b.kind === "user" || b.kind === "assistant").length;

  test("story 200: a large transcript pages back from its end to its first line, 20 things said a page, each block once; and forward again", async () => {
    // 2000 turns of Claude's, each a question, a tool call and its result, and an answer, between
    // lines that are not the conversation; the api-request-blob ones the reader skips itself.
    const lines: unknown[] = [];
    const turn: (string | null)[][] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(
        { type: "user", timestamp: T(1), message: { role: "user", content: `[来自 QQ 私聊]\nq${i}` } },
        { type: "attachment", timestamp: T(1), attachment: { type: "date" } },
        { type: "api-request-blob", message: { role: "system", content: "x".repeat(500) } },
        { type: "assistant", timestamp: T(2), message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: `echo ${i}` } }] } },
        { type: "user", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `${i}\n` }] } },
        { type: "assistant", timestamp: T(4), message: { role: "assistant", content: [{ type: "text", text: `a${i}` }] } },
        { type: "system", subtype: "turn_duration", durationMs: 1, timestamp: T(4) },
      );
      turn.push(["user", "QQ 私聊", `q${i}`], ["tool", `c${i}`, `${i}\n`], ["assistant", `a${i}`]);
    }
    const file = transcript("large.jsonl", lines);

    const back = await pagesBack(file);
    expect(back.map((p) => talk(p.blocks))).toEqual(Array(200).fill(20));
    expect(back.flatMap((p) => p.blocks).map(said)).toEqual(turn);
    expect(new Set(back.flatMap((p) => p.blocks.map((b) => b.at))).size).toBe(6000);
    // Each page ends where the one after it starts.
    expect(back.slice(1).map((p) => p.start)).toEqual(back.slice(0, -1).map((p) => p.end));
    expect(back.at(-1)!.end).toBe(statSync(file).size);

    const forward = await pagesForward(file);
    expect(forward.flatMap((p) => p.blocks)).toEqual(back.flatMap((p) => p.blocks));
    expect(forward.every((p) => talk(p.blocks) <= 20)).toBe(true);
  }, 30_000);

  test("story 200: a long run of tool calls is cut at 200 blocks; a result whose call is on the page before goes with it by id", async () => {
    const call = (i: number) => ({ type: "message", timestamp: T(2), message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }] } });
    const result = (i: number) => ({ type: "message", timestamp: T(3), message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: `${i}` }], isError: false } });
    const lines: unknown[] = [{ type: "message", timestamp: T(1), message: { role: "user", content: [{ type: "text", text: "go" }] } }];
    for (let i = 0; i < 150; i++) lines.push(call(i), result(i));
    lines.push({ type: "message", timestamp: T(4), message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    const pages = await pagesBack(transcript("run.jsonl", lines));

    expect(pages).toHaveLength(2);
    // The newest page: the answer and the 199 lines before it, which begin with a result.
    expect(pages[1]!.blocks.map(said).slice(0, 2)).toEqual([
      ["result", "c50", "50"],
      ["tool", "c51", "51"],
    ]);
    expect(pages[1]!.blocks).toHaveLength(101);
    expect(pages[0]!.blocks.at(-1)).toMatchObject({ kind: "tool", id: "c50", result: null });
    expect(pages[0]!.blocks).toHaveLength(52);

    // One line with more blocks than a page holds is a page of its own.
    const many = Array.from({ length: 250 }, (_, i) => call(i).message.content[0]);
    const one = await latest(transcript("many.jsonl", [{ type: "message", timestamp: T(2), message: { role: "assistant", content: many } }]));
    expect([one.blocks.length, one.start]).toEqual([250, 0]);
  });

  test("story 200: from a page's end on, only what was written since; a line still being written waits", async () => {
    const file = transcript("growing-blocks.jsonl", PI.slice(0, 4));
    const page = await latest(file);
    expect(await messagePage(file, page.end, "forward", "/w")).toEqual({ blocks: [], start: page.end, end: page.end });

    const [result, answer] = PI.slice(4, 6).map((l) => JSON.stringify(l));
    appendFileSync(file, `${result}\n${answer!.slice(0, 20)}`);
    const next = await messagePage(file, page.end, "forward", "/w");
    // The call was on the page before: its result says which it goes with.
    expect(next.blocks.map(said)).toEqual([["result", "c1", "teh typo"]]);
    expect(next.end).toBe(page.end + Buffer.byteLength(result!) + 1);

    appendFileSync(file, `${answer!.slice(20)}\n`);
    expect((await messagePage(file, next.end, "forward", "/w")).blocks.map(said)).toEqual([["assistant", "Fixed it."]]);
  });

  test("#209: the last thing you or the agent said, on one line without Markdown's marks, cut short, with when; back past a long run of tool calls", async () => {
    // Claude's turn ends with a compaction's summary, which is not yours.
    expect(await lastSaid(transcript("last-claude.jsonl", CLAUDE))).toEqual({ role: "assistant", text: "Fixed it.", at: Date.parse(T(5)) });
    // Yours, without its source line, which says where it came from. The agent's answer half written waits.
    const file = transcript("last-pi.jsonl", PI.slice(0, 5));
    appendFileSync(file, JSON.stringify(PI[5]).slice(0, 20));
    expect(await lastSaid(file)).toEqual({ role: "user", text: "fix the typo", at: Date.parse(T(1)), source: "QQ 私聊" });

    const md = "## Done\n\nThe **fix** is in `a.ts`, see [the PR](https://example.com/1).\n\n" + "y".repeat(300);
    const lines: unknown[] = [{ type: "message", timestamp: T(2), message: { role: "assistant", content: [{ type: "text", text: md }] } }];
    for (let i = 0; i < 150; i++) {
      lines.push({ type: "message", timestamp: T(3), message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "true" } }] } });
      lines.push({ type: "message", timestamp: T(3), message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "" }], isError: false } });
    }
    expect(await lastSaid(transcript("last-long.jsonl", lines))).toEqual({ role: "assistant", text: ("Done The fix is in a.ts, see the PR. " + "y".repeat(300)).slice(0, 200) + "…", at: Date.parse(T(2)) });
    expect(await lastSaid(transcript("last-none.jsonl", PI.slice(0, 2)))).toBeNull();
  });

  test("stories 561, 562, 567, 568: your message's pictures and file come by their hashes, in place of the lines naming them, with no picture's data; an rh send to you in a shell call, its text and files, a here-document's too, none in another command's words or a here-document; the list's line says [图片] [文件]", async () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64));
    const data = Buffer.from("not really a picture").toString("base64");
    const picture = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const words = `[来自 网页]\n看这个\n[图片] /s/media/${a}\n[图片] /s/media/${b}\n[文件] notes.txt：/s/media/${c}`;
    const call = (id: string, command: string) => ({ type: "assistant", timestamp: T(2), message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
    const file = transcript("media.jsonl", [
      { type: "user", timestamp: T(1), message: { role: "user", content: [{ type: "text", text: words }, picture, picture] } },
      call("c1", "rh send me --file /w/shot.png 测试过了 2>&1"),
      call("c2", `cd /w && rh send me "$(cat <<'EOF'\n两行\nit's done\nEOF\n)"`),
      call("c3", "rh send w/other 别的槽位"),
      // Words of another command, and a here-document's lines, run nothing.
      call("c4", "echo rh send me hello"),
      call("c5", "cat > notes.md <<'EOF'\nrh send me 文档里的例子\nEOF"),
      // A # that begins a word, unquoted, comments out the rest of its line.
      call("c6", 'rh send me hello a#b "#" \\# # note'),
      call("c7", "rh send me --file out.png  # the chart"),
      call("c8", "# notify; rh send me hi"),
    ]);
    const { blocks } = await latest(file);
    expect(JSON.stringify(blocks)).not.toContain(data);
    expect(blocks[0]).toMatchObject({ kind: "user", source: "网页", text: "看这个", media: [{ kind: "image", hash: a }, { kind: "image", hash: b }, { kind: "file", hash: c, name: "notes.txt" }] });
    expect(blocks.slice(1).map((b) => (b.kind === "tool" ? b.send : b.kind))).toEqual([{ to: "me", text: "测试过了", files: ["/w/shot.png"] }, { to: "me", text: "两行\nit's done", files: [] }, undefined, undefined, undefined, { to: "me", text: "hello a#b # #", files: [] }, { to: "me", text: "", files: ["out.png"] }, undefined]);
    expect((await lastSaid(transcript("media-last.jsonl", [{ type: "user", timestamp: T(1), message: { role: "user", content: words } }])))?.text).toBe("看这个 [图片] [图片] [文件]");
    expect((await lastSaid(transcript("media-alone.jsonl", [{ type: "user", timestamp: T(1), message: { role: "user", content: `[图片] /s/media/${a}` } }])))?.text).toBe("[图片]");
  });

  test("#607: of your message under a quote, the list's line says your words, the quote's start with none, and that it quotes", async () => {
    const last = (name: string, content: string) => lastSaid(transcript(name, [{ type: "user", timestamp: T(1), message: { role: "user", content } }]));
    expect(await last("quoted.jsonl", `> 是一个拼写错误：${"长".repeat(300)}…\n> 第二行\n\n嗯`)).toMatchObject({ text: "嗯", quoted: true });
    expect(await last("quote-alone.jsonl", "> 好的…\n")).toMatchObject({ text: "好的…", quoted: true });
    // Its Markdown marks gone, as the queue shows a quote.
    expect(await last("quote-marks.jsonl", "> ```ts\n> const x = 1\n> ```\n> > 原话 *注意*…\n")).toMatchObject({ text: "const x = 1 原话 注意…" });
    // An old picture of yours quoted over IM, a picture for an answer: that picture, not the quote's path.
    const h = "a".repeat(64);
    expect(await last("quote-picture.jsonl", `> [图片] /s/media/${h}\n\n[图片] /s/media/${h}`)).toMatchObject({ text: "[图片]", quoted: true });
  });

  // Codex's records of the probe's two threads (codex-cli 0.162.1), both run in this directory.
  const CODEX_DIR = "/tmp/codex-probe/work/project";
  const CODEX_THREAD = join(FIXTURES, "codex/thread.jsonl");
  const CODEX_KILLED = join(FIXTURES, "codex/killed-mid-turn.jsonl");
  const tools = (bs: Block[]) => bs.flatMap((b) => (b.kind === "tool" ? [[b.name, b.shown, b.result?.error]] : []));

  test("story 507: Codex's record: what you and it said, its tool calls under its own names with their results, the compaction; nothing of what it sends the model", async () => {
    const page = await messagePage(CODEX_THREAD, Infinity, "backward", CODEX_DIR);
    expect(page.blocks.map(said)).toEqual([
      ["user", null, "Run the shell command `env | grep ^RHODIUM_ | sort`. Then use apply_patch to create hello.txt containing the line hi. Then reply with the single word: ok."],
      ["tool", "exec-00000000-0000-4000-8000-0177ff66ddc2", "RHODIUM_SLOT=probe-slot\nRHODIUM_SOCKET=/run/user/1000/rhodium/rh.sock\nRHODIUM_TOKEN=probe-token-not-secret\n"],
      ["tool", "exec-00000000-0000-4000-8000-0ce30ddee356", "Success. Updated the following files:\nA /tmp/codex-probe/work/project/hello.txt\n"],
      ["assistant", "ok"],
      ["user", null, "Which file did you create earlier in this conversation? Reply with just the file name."],
      ["assistant", "hello.txt"],
      ["system", "压缩了对话"],
      ["user", null, "Reply with the single word: pong."],
      ["assistant", "pong"],
    ]);
    // The command as typed, the last of `zsh -lc`'s words (architecture §6.4); the patch by its file.
    expect(tools(page.blocks)).toEqual([
      ["exec_command", { name: "exec_command", arg: "env | grep ^RHODIUM_ | sort", code: true }, false],
      ["apply_patch", { name: "apply_patch", arg: "hello.txt", code: true }, false],
    ]);
    // A result is a block of the call's own line, by which its whole text is read back.
    const exec = page.blocks.find((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool")!;
    expect(await fullText(CODEX_THREAD, exec.result!.at)).toStartWith("RHODIUM_SLOT=probe-slot\n");
    const pong = readFileSync(CODEX_THREAD, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.payload?.item?.type === "AgentMessage" && m.payload.item.content[0].text === "pong");
    expect(await lastSaid(CODEX_THREAD)).toEqual({ role: "assistant", text: "pong", at: Date.parse(pong.timestamp) });
  });

  test("story 507: a command Codex was killed in the middle of never makes its record: nothing shows it running", async () => {
    expect((await messagePage(CODEX_KILLED, Infinity, "backward", CODEX_DIR)).blocks.map(said)).toEqual([
      ["user", null, "Run the shell command `sleep 6 && touch late.txt`, then reply with the single word: ok."],
      ["user", null, "Without running anything: did your last command finish? Reply yes, no, or unknown."],
      ["assistant", "unknown"],
    ]);
  });

  test("story 507: Codex's thought summaries, a turn you stopped, a command that failed, its MCP, image and web search tools, and a subagent it started; an item it does not know gives nothing", async () => {
    // Lines as codex-cli 0.162.1 writes them; its web search is an extension of kind web.search.
    const item = (item: object) => ({ timestamp: T(1), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", item } });
    const file = transcript("codex-kinds.jsonl", [
      item({ type: "Reasoning", id: "rs_1", summary_text: [], raw_content: [] }),
      item({ type: "Reasoning", id: "rs_2", summary_text: ["Looking at the build.", "Then the tests."], raw_content: [] }),
      item({ type: "CommandExecution", id: "exec-1", command: ["/usr/bin/zsh", "-lc", "bun run build"], cwd: "file:///w", status: "failed", aggregated_output: "error: no such file\n", exit_code: 1, duration: { secs: 2, nanos: 500_000_000 } }),
      item({ type: "McpToolCall", id: "exec-2", server: "github", tool: "get_issue", arguments: { number: 1 }, status: "completed", result: { content: [{ type: "text", text: "Issue 1" }], isError: false } }),
      item({ type: "ImageView", id: "exec-3", path: "file:///w/shot.png" }),
      item({ type: "Extension", kind: "web.search", id: "exec-4", query: "bun glob", action: { type: "search", query: null, queries: ["bun glob"] }, results: [{ type: "text_result", title: "Glob", url: "https://bun.sh/docs/api/glob", snippet: "…" }] }),
      // A subagent it started, which is its spawn_agent call; its later back and forth is not a call.
      item({ type: "SubAgentActivity", id: "call_1", kind: "started", agent_thread_id: "t2", agent_path: "/root/spec_review" }),
      item({ type: "SubAgentActivity", id: "call_2", kind: "interacted", agent_thread_id: "t2", agent_path: "/root" }),
      item({ type: "SubAgentActivity", id: "subagent-completed-t2", kind: "completed", agent_thread_id: "t2", agent_path: "/root/spec_review" }),
      { timestamp: T(2), type: "event_msg", payload: { type: "turn_aborted", turn_id: "u", reason: "interrupted" } },
    ]);
    const page = await latest(file);
    expect(page.blocks.map(said)).toEqual([
      ["thinking", "Looking at the build.\n\nThen the tests."],
      ["tool", "exec-1", "error: no such file\n"],
      ["tool", "exec-2", "Issue 1"],
      ["tool", "exec-3", ""],
      ["tool", "exec-4", "Glob https://bun.sh/docs/api/glob"],
      ["tool", "call_1", ""],
      ["system", "你打断了回合"],
    ]);
    expect(tools(page.blocks)).toEqual([
      ["exec_command", { name: "exec_command", arg: "bun run build", code: true }, true],
      ["mcp__github__get_issue", { name: "github.get_issue", arg: null, code: false }, false],
      ["view_image", { name: "view_image", arg: "shot.png", code: true }, false],
      ["web_search", { name: "web_search", arg: "bun glob", code: true }, false],
      ["spawn_agent", { name: "spawn_agent", arg: null, code: false }, false],
    ]);
    expect(page.blocks.find((b) => b.kind === "tool" && b.id === "call_1")).toMatchObject({ input: JSON.stringify({ agent_path: "/root/spec_review" }, null, 2) });
    // A command's line is written once it ends: its call is when it began, its result when it ended.
    expect(page.blocks.find((b) => b.kind === "tool" && b.id === "exec-1")).toMatchObject({ time: Date.parse(T(1)) - 2500, result: { time: Date.parse(T(1)) } });
  });

  // No recorded transcript has a picture: these lines are as Claude, pi and codex-cli 0.162.1 write them.
  const ONE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const png = Buffer.from(ONE, "base64");
  const hash = new Bun.CryptoHasher("sha256").update(png).digest("hex");
  const media = join(tmp, "media");
  const results = (bs: Block[]) => bs.map((b) => (b.kind === "tool" ? b.result?.media : b.kind));

  test("story 563: a picture a tool's result carries, Claude's Read's and pi's, is kept in the media dir by its hash, the block having its address and never its data", async () => {
    const claude = transcript("read-claude.jsonl", [
      { type: "assistant", timestamp: T(1), message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/w/shot.png" } }] } },
      { type: "user", timestamp: T(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: [{ type: "image", source: { type: "base64", data: ONE, media_type: "image/png" } }] }] } },
    ]);
    const pi = transcript("read-pi.jsonl", [
      { type: "message", timestamp: T(1), message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "/w/shot.png" } }] } },
      { type: "message", timestamp: T(2), message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: ONE, mimeType: "image/png" }], isError: false } },
    ]);
    for (const file of [claude, pi]) {
      const { blocks } = await messagePage(file, Infinity, "backward", "/w", media);
      expect(JSON.stringify(blocks)).not.toContain(ONE);
      expect(results(blocks)).toEqual([[{ kind: "image", hash }]]);
    }
    expect(readFileSync(join(media, hash)).equals(png)).toBe(true);
  });

  test("story 563: Codex's view_image shows the picture only if it is in the slot's dir, its real path too, and a picture by its first bytes; any other, its path alone", async () => {
    const slot = join(tmp, "slot-563");
    mkdirSync(join(slot, "shots"), { recursive: true });
    const outside = join(tmp, "outside.png");
    writeFileSync(outside, png);
    mkdirSync(join(slot, "截图"));
    for (const name of ["shots/in.png", "a b.png", "截图/x.png"]) writeFileSync(join(slot, name), png);
    symlinkSync(outside, join(slot, "out.png"));
    writeFileSync(join(slot, "notes.png"), "not a picture\n");
    // Its path is a file: URL (Url::from_file_path): a space and a Chinese name come percent-encoded.
    const viewed = (path: string, i: number) => ({ timestamp: T(1), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", item: { type: "ImageView", id: `v${i}`, path: pathToFileURL(path).href } } });
    const file = transcript("codex-view.jsonl", ["shots/in.png", "a b.png", "截图/x.png", outside, "out.png", "notes.png", "gone.png"].map((p) => resolve(slot, p)).map(viewed));
    rmSync(join(media, hash), { force: true });
    const shown = (name: string) => [{ kind: "image" as const, hash, name }];
    expect(results((await messagePage(file, Infinity, "backward", slot, media)).blocks)).toEqual([shown("in.png"), shown("a b.png"), shown("x.png"), undefined, undefined, undefined, undefined]);
    expect(readFileSync(join(media, hash)).equals(png)).toBe(true);
  });
});

describe("claudeSettings", () => {
  // A conversation switched to the terminal at second 10: the headless agent's turn before it, the terminal's after.
  const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 1, 0, s)).toISOString();
  const since = Date.parse(at(10));
  const typed = (s: number, text: string) => ({ type: "user", timestamp: at(s), message: { role: "user", content: text } });
  const reply = (s: number, effort: string, model = "claude-opus-5-5", more: object = {}) => ({
    type: "assistant",
    isSidechain: false,
    timestamp: at(s),
    effort,
    perTurnEffort: effort,
    requestedModel: model,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ...more,
  });
  const ultra = (s: number, on: boolean) => ({ type: "attachment", isSidechain: false, timestamp: at(s), attachment: { type: on ? "ultra_effort_enter" : "ultra_effort_exit" } });
  const file = (name: string, lines: object[]) => {
    const f = join(tmp, name);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return f;
  };
  const HEADLESS = [typed(1, "[来自 QQ 私聊]\nhi"), reply(2, "high"), ultra(3, false)];

  test("the newest turn's first reply of the agent's own, from before a skill it loads; before the terminal, the turn before it", async () => {
    const f = file("skill.jsonl", [
      ...HEADLESS,
      typed(11, "use the skill"),
      // A subagent's reply, its own level, comes first.
      reply(12, "medium", "claude-haiku-5-5", { isSidechain: true }),
      reply(13, "xhigh", "claude-sonnet-5-5", { message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "lowfx" } }] } }),
      { type: "user", timestamp: at(14), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "Launching skill" }] } },
      { type: "user", isMeta: true, timestamp: at(14), message: { role: "user", content: [{ type: "text", text: "Reply ok." }] } },
      reply(15, "low", "claude-sonnet-5-5"),
      // A skill you started yourself: its turn runs at the skill's level throughout, and is passed over.
      typed(16, "<command-message>lowfx</command-message>\n<command-name>/lowfx</command-name>"),
      { type: "user", isMeta: true, timestamp: at(16), message: { role: "user", content: [{ type: "text", text: "Reply ok." }] } },
      reply(17, "low", "claude-sonnet-5-5"),
    ]);
    expect(await claudeSettings(f, since, "after")).toEqual({ effort: "xhigh", model: "claude-sonnet-5-5" });
    expect(await claudeSettings(f, since, "before")).toEqual({ effort: "high", model: "claude-opus-5-5" });
    // Only a skill's turn in the terminal, after one you stopped before any reply: no level of the terminal's own.
    const g = file("skill-only.jsonl", [...HEADLESS, typed(11, "go"), typed(12, "[Request interrupted by user]"), typed(16, "<command-name>/lowfx</command-name>"), reply(17, "low")]);
    expect(await claudeSettings(g, since, "after")).toEqual({});
  });

  test("a turn Claude compacted midway is still read from its first reply, not the skill's level after the summary", async () => {
    const f = file("compacted.jsonl", [
      ...HEADLESS,
      typed(11, "use the skill"),
      reply(12, "xhigh", "claude-opus-5-5", { message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "lowfx" } }] } }),
      { type: "user", timestamp: at(13), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "Launching skill" }] } },
      reply(14, "low"),
      { type: "system", subtype: "compact_boundary", timestamp: at(15) },
      { type: "user", isCompactSummary: true, timestamp: at(15), message: { role: "user", content: "This session is being continued from a previous conversation." } },
      reply(16, "low"),
    ]);
    expect(await claudeSettings(f, since, "after")).toEqual({ effort: "xhigh", model: "claude-opus-5-5" });
  });

  test("ultracode on or off as the terminal's newest marker says; none there, none told", async () => {
    expect(await claudeSettings(file("on.jsonl", [...HEADLESS, typed(11, "go"), ultra(11, true), reply(12, "xhigh")]), since, "after")).toEqual({ effort: "xhigh", model: "claude-opus-5-5", ultra: true });
    expect(await claudeSettings(file("off.jsonl", [ultra(1, true), typed(11, "go"), ultra(11, true), reply(12, "xhigh"), typed(13, "go"), ultra(13, false), reply(14, "high")]), since, "after")).toEqual({ effort: "high", model: "claude-opus-5-5", ultra: false });
    // The headless agent's marker is not the terminal's.
    expect(await claudeSettings(file("none.jsonl", [...HEADLESS, typed(11, "go"), reply(12, "xhigh")]), since, "after")).toEqual({ effort: "xhigh", model: "claude-opus-5-5" });
    expect(await claudeSettings(file("none.jsonl", [...HEADLESS, typed(11, "go"), reply(12, "xhigh")]), since, "before")).toEqual({ effort: "high", model: "claude-opus-5-5" });
  });

  test("no turn in the terminal, or none before it: nothing to tell", async () => {
    // Changed in the terminal and quit: only Claude's own words of it, which are not read.
    const quit = file("quit.jsonl", [
      ...HEADLESS,
      typed(11, "<command-name>/effort</command-name>"),
      typed(11, "<local-command-stdout>Set effort level to xhigh (this session only)</local-command-stdout>"),
    ]);
    expect(await claudeSettings(quit, since, "after")).toEqual({});
    const fresh = file("fresh.jsonl", [typed(11, "go"), reply(12, "xhigh")]);
    expect(await claudeSettings(fresh, since, "before")).toEqual({});
  });
});

describe("codexSettings", () => {
  // The recorded thread: its first turn on gpt-6-luna, the three after it on gpt-5.6-luna, all at low.
  const THREAD = join(FIXTURES, "codex/thread.jsonl");
  test("the newest turn's model and level, by the settings line Codex writes as it starts; before a time, the newest before it; none after its last turn", async () => {
    // The times are the thread's own: 6 seconds in, between its first turn and the next; 15 minutes in, after the last; a minute before it began.
    const began = startOf(THREAD).getTime();
    const since = began + 6_000;
    expect(await codexSettings(THREAD, since, "after")).toEqual({ model: "gpt-5.6-luna", effort: "low" });
    expect(await codexSettings(THREAD, since, "before")).toEqual({ model: "gpt-6-luna", effort: "low" });
    expect(await codexSettings(THREAD, began + 15 * 60_000, "after")).toEqual({});
    expect(await codexSettings(THREAD, began - 60_000, "before")).toEqual({});
  });
});

describe("piSettings", () => {
  // A pi session switched to the terminal at second 10: the headless agent's part before it, the terminal's after.
  const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 1, 0, s)).toISOString();
  const since = Date.parse(at(10));
  const model = (s: number, modelId: string) => ({ type: "model_change", id: `m${s}`, parentId: null, timestamp: at(s), provider: "deepseek", modelId });
  const level = (s: number, thinkingLevel: string) => ({ type: "thinking_level_change", id: `t${s}`, parentId: null, timestamp: at(s), thinkingLevel });
  const said = (s: number, role: string, more: object = {}) => ({ type: "message", id: `x${s}`, parentId: null, timestamp: at(s), message: { role, content: [{ type: "text", text: "ok" }], ...more } });
  const file = (name: string, lines: object[]) => {
    const f = join(tmp, name);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return f;
  };
  // As pi writes a session down: the model and level it starts on, a turn, and a level the headless agent set.
  const HEADLESS = [{ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: "/w" }, model(0, "deepseek-flash"), level(0, "high"), said(1, "user"), said(2, "assistant", { provider: "deepseek", model: "deepseek-flash" }), level(3, "low")];

  test("the newest model and level changes in the terminal's part, as provider/modelId; before it, the newest before", async () => {
    const f = file("pi-changed.jsonl", [...HEADLESS, level(11, "off"), model(12, "deepseek-v4-pro"), level(12, "high"), said(13, "user"), said(14, "assistant", { provider: "deepseek", model: "deepseek-v4-pro" })]);
    expect(await piSettings(f, since, "after")).toEqual({ effort: "high", model: "deepseek/deepseek-v4-pro" });
    expect(await piSettings(f, since, "before")).toEqual({ effort: "low", model: "deepseek/deepseek-flash" });
  });

  test("no change line in the terminal's part: nothing told, whatever model its replies name", async () => {
    // Under a virtual model, a reply names the model it ran on, while pi resumes the model_change's.
    const f = file("pi-same.jsonl", [...HEADLESS, said(11, "user"), said(12, "assistant", { provider: "deepseek", model: "deepseek-v4-pro" })]);
    expect(await piSettings(f, since, "after")).toEqual({});
    expect(await piSettings(f, since, "before")).toEqual({ effort: "low", model: "deepseek/deepseek-flash" });
  });

  test("a session first written down in the terminal: nothing before it", async () => {
    const f = file("pi-fresh.jsonl", [{ type: "session", version: 3, id: "s2", timestamp: at(11), cwd: "/w" }, model(11, "deepseek-flash"), level(11, "high"), said(12, "user")]);
    expect(await piSettings(f, since, "before")).toEqual({});
    expect(await piSettings(f, since, "after")).toEqual({ effort: "high", model: "deepseek/deepseek-flash" });
  });
});

describe("findConversations", () => {
  test("finds a Codex thread under $CODEX_HOME, not under ~/.codex, so a slot resumes it rather than starting anew", async () => {
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = join(tmp, "home-find");
    process.env.CODEX_HOME = join(tmp, "codex-home");
    try {
      const id = "00000000-0000-7000-8000-41fbaa1e424a";
      const day = join(process.env.CODEX_HOME, "sessions/2026/10/27");
      mkdirSync(day, { recursive: true });
      const file = join(day, `rollout-2026-10-27T17-35-08-${id}.jsonl`);
      writeFileSync(file, "{}\n");
      expect(await findConversations(id.slice(0, 8))).toEqual([{ agent: "codex", id, file }]);
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});

describe("Codex's threads", () => {
  // Codex keeps its records by the day they began, not by directory (architecture §6.4).
  const home = join(tmp, "home-codex");
  const codexHome = join(tmp, "codex-home-list");
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  beforeAll(() => Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome }));
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  const DIR = "/tmp/codex-probe/work/project"; // where the probe ran
  const THREAD = "00000000-0000-7000-8000-8d5c554c3185";
  const KILLED = "00000000-0000-7000-8000-535ba914e173";
  /** A copy of the probe's record of `from` as thread `id`, begun on a day of its own, its first line changed by meta. */
  function place(fixture: string, from: string, id: string, day: string, mtime: string, meta: object = {}): string {
    const dir = join(codexHome, "sessions", ...day.split("-"));
    const file = join(dir, `rollout-${day}T16-30-54-${id}.jsonl`);
    const [first, ...rest] = readFileSync(join(FIXTURES, "codex", fixture), "utf8").replaceAll(from, id).split("\n");
    const head = JSON.parse(first!);
    Object.assign(head.payload, meta);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, [JSON.stringify(head), ...rest].join("\n"));
    utimesSync(file, new Date(mtime), new Date(mtime));
    return file;
  }

  test("stories 508, 509: a directory's threads are those whose first line says they began there, not a subagent's; titled by the name Codex keeps for each, else what you said first", async () => {
    const thread = place("thread.jsonl", THREAD, THREAD, "2026-10-27", "2026-10-27T09:00:00Z");
    const killed = place("killed-mid-turn.jsonl", KILLED, KILLED, "2026-10-26", "2026-10-27T10:00:00Z");
    place("killed-mid-turn.jsonl", KILLED, "01a17c7e-0000-7000-8000-000000000001", "2026-10-27", "2026-10-27T11:00:00Z", { cwd: "/srv/other" });
    place("killed-mid-turn.jsonl", KILLED, "01a17c7e-0000-7000-8000-000000000002", "2026-10-27", "2026-10-27T11:00:00Z", { source: { subagent: "review" } });
    // Its names, the newest last (codex-cli 0.162.1's $CODEX_HOME/session_index.jsonl).
    const named = (id: string, name: string, at: string) => JSON.stringify({ id, thread_name: name, updated_at: at });
    writeFileSync(join(codexHome, "session_index.jsonl"), [named(THREAD, "Make hello", "2026-10-27T08:31:00Z"), named(KILLED.replace(/.$/, "0"), "Not this one", "2026-10-27T08:32:00Z"), named(THREAD, "Make hello.txt", "2026-10-27T08:33:00Z")].join("\n") + "\n");

    expect(await listConversations(DIR)).toEqual([
      {
        id: KILLED,
        agent: "codex",
        file: killed,
        startedAt: startOf(join(FIXTURES, "codex/killed-mid-turn.jsonl")),
        modifiedAt: new Date("2026-10-27T10:00:00Z"),
        title: "Run the shell command `sleep 6 && touch late.txt`, then reply with the single word: ok.",
      },
      { id: THREAD, agent: "codex", file: thread, startedAt: startOf(join(FIXTURES, "codex/thread.jsonl")), modifiedAt: new Date("2026-10-27T09:00:00Z"), title: "Make hello.txt" },
    ]);
    // Where rh import puts its slot.
    expect(await startedIn(thread)).toBe(DIR);
    // What rh read shows of it.
    expect(await recentMessages(DIR, "codex", KILLED, 2, 100)).toEqual([
      { role: "user", text: "Without running anything: did your last command finish? Reply yes, no, or unknown." },
      { role: "assistant", text: "unknown" },
    ]);
  });
});
