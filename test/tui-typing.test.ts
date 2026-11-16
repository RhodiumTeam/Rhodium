// Typing internal messages into a slot's terminal (stories 606, 608-614, architecture §10.5): what is
// typed, the look before Enter, whether a long one fits the box, and the trace in the transcript that
// says Claude got it. Claude's screens with text written into the box are the ones recorded in
// test/fixtures/herdr/claude-typed-screens.jsonl (Claude Code 2.1.325, Herdr 0.9.5).
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fitsBox, inBox, inputState, traced, typedFrom, vim } from "../src/tui";
import { claudeProjectDir, type Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { request } from "../src/herdr";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance } from "./instance";

type Screen = { name: string; status: string; typed?: string; rows: number; cols?: number; text: string };
const load = (file: string): Record<string, Screen> =>
  Object.fromEntries(
    readFileSync(join(import.meta.dir, "fixtures/herdr", file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [JSON.parse(l).name, JSON.parse(l)]),
  );
const typed = load("claude-typed-screens.jsonl");
const plain = load("claude-screens.jsonl");

test("story 610: what is typed is the body, its source line first; control characters go but tab and newline, CR and CRLF become newlines, escape sequences go whole, and the invisible characters Claude drops on Enter go; joiners in an emoji stay", () => {
  expect(typedFrom("[来自 槽位 w/b，经 rh send]\nhello")).toBe("[来自 槽位 w/b，经 rh send]\nhello");
  const dirty = "[来自 槽位 w/b，经 rh send]\na\rb\r\nc\x03d\x1b[201~e\x1b]0;title\x07f​g‮h⁦i\u{e0041}j­k⁠l\tm\x7fn\x9bo";
  expect(typedFrom(dirty)).toBe("[来自 槽位 w/b，经 rh send]\na\nb\ncdefghijkl\tmno");
  expect(typedFrom("[来自 槽位 w/b，经 rh send]\n⚠️ 好 👨‍👩‍👧 家")).toBe("[来自 槽位 w/b，经 rh send]\n⚠️ 好 👨‍👩‍👧 家");
  // One with no source line on its first line is never typed: so nothing typed starts with / or !.
  expect(typedFrom("/clear")).toBeNull();
  expect(typedFrom("!rm -rf x")).toBeNull();
  expect(typedFrom("\x1b[0m/clear")).toBeNull();
  // A last backslash with Enter is a newline in Claude's box: a space after it, so Enter sends.
  expect(typedFrom("[来自 槽位 w/b，经 rh send]\nC:\\dir\\")).toBe("[来自 槽位 w/b，经 rh send]\nC:\\dir\\ ");
});

test("story 608: the look before Enter: the box holds just what was written, one line or three, tabs and emoji as recorded, idle or working, default or fullscreen; or Claude's one placeholder for it, of lines or of a long line", () => {
  for (const name of ["typed", "typed-3-lines", "typed-emoji-tab", "typed-working", "fullscreen-typed", "typed-4-lines", "typed-870-chars", "typed-5-lines-working-queued", "fullscreen-typed-5-lines"]) {
    const s = typed[name]!;
    expect([name, inBox("claude", s.text, s.typed!)]).toEqual([name, true]);
  }
  // The placeholder alone, whatever was written: Rhodium's count and Claude's may differ at the edge.
  expect(inBox("claude", typed["typed-4-lines"]!.text, "[来自 槽位 w/b，经 rh send]\none line")).toBe(true);
});

test("story 608: not before Enter: other text in the box, your words joined to it, a placeholder with more beside it, a dialog over it, an empty box, a long text Claude's box cannot show whole", () => {
  const s = typed["typed"]!;
  expect(inBox("claude", s.text, "[来自 槽位 w/b，经 rh send]\n别的")).toBe(false);
  expect(inBox("claude", s.text.replace("收到一行。", "收到一行。我自己的半句"), s.typed!)).toBe(false);
  expect(inBox("claude", typed["typed-4-lines"]!.text.replace("+3 lines]", "+3 lines] and more"), s.typed!)).toBe(false);
  expect(inBox("claude", typed["typed-then-permission-renamed"]!.text, typed["typed-then-permission-renamed"]!.typed!)).toBe(false);
  expect(inBox("claude", plain["empty-bare"]!.text, s.typed!)).toBe(false);
  const narrow = typed["typed-narrow-790-chars"]!;
  expect(inBox("claude", narrow.text, narrow.typed!)).toBe(false);
});

test("stories 607, 611: a rule with the session's name in it (/rename) still bounds the box, and a dialog over such a screen is still a dialog; digits written into a permission dialog changed nothing there", () => {
  expect(inputState("claude", "done", typed["empty-renamed"]!.text)).toBe("ready");
  expect(inputState("claude", "idle", typed["typed-then-permission-renamed"]!.text)).toBe("dialog");
  expect(inputState("claude", "blocked", typed["permission-after-digits"]!.text)).toBe("dialog");
});

test("story 611: with Claude's editorMode vim, only the INSERT mark makes an empty box ready: NORMAL shows none, and is as a draft", () => {
  expect(inputState("claude", "idle", plain["vim-insert"]!.text, true)).toBe("ready");
  expect(inputState("claude", "idle", plain["vim-normal"]!.text, true)).toBe("draft");
  expect(inputState("claude", "idle", plain["vim-normal"]!.text)).toBe("ready");
  expect(inputState("claude", "idle", plain["empty-bare"]!.text, true)).toBe("draft");
});

test("story 611: Claude's editorMode is read in its order: managed, the process's --settings (inline or a file, `--settings X` or `--settings=X`), the slot's local, project, your settings, then ~/.claude.json; the first that sets it wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "rh-vim-"));
  const dir = join(root, "w");
  const home = join(root, "home");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  /** A process whose command line is claude's with these flags, once it shows; `; :` keeps sh from exec'ing sleep. */
  const run = async (...flags: string[]) => {
    const p = Bun.spawn(["sh", "-c", "sleep 30; :", "claude", ...flags], { cwd: dir });
    procs.push(p);
    await until(async () => readFileSync(`/proc/${p.pid}/cmdline`, "utf8").includes("claude"), 5_000);
    return p.pid;
  };
  try {
    const bare = await run();
    expect(vim(dir, bare, home)).toBe(false);
    // The legacy key, which Claude falls back to when no settings file sets it.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ editorMode: "vim" }));
    expect(vim(dir, bare, home)).toBe(true);
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ editorMode: "normal" }));
    expect(vim(dir, bare, home)).toBe(false);
    // The flag: inline, a file relative to the process's directory (`..` too), `=` form; one without the key falls through.
    expect(vim(dir, await run("--settings", JSON.stringify({ editorMode: "vim" })), home)).toBe(true);
    writeFileSync(join(root, "flag.json"), JSON.stringify({ editorMode: "vim" }));
    expect(vim(dir, await run("--settings", "../flag.json"), home)).toBe(true);
    expect(vim(dir, await run(`--settings=${join(root, "flag.json")}`), home)).toBe(true);
    expect(vim(dir, await run("--settings", JSON.stringify({ ultracode: true })), home)).toBe(false);
    // The flag over the slot's own settings.
    writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify({ editorMode: "vim" }));
    expect(vim(dir, bare, home)).toBe(true);
    expect(vim(dir, await run("--settings", JSON.stringify({ editorMode: "normal" })), home)).toBe(false);
    // A process gone: its flag unread, the files still.
    expect(vim(dir, 2 ** 22 + 1, home)).toBe(true);
  } finally {
    for (const p of procs) p.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("story 610: a text Claude does not fold, near three lines and 800 characters of Chinese, does not fit a phone-narrow pane's box; half of it fits a wide one's; one Claude folds always fits", () => {
  const narrow = typed["typed-narrow-790-chars"]!;
  expect(fitsBox("claude", narrow.typed!, narrow.text, narrow.rows)).toBe(false);
  const half = narrow.typed!.split("\n").slice(0, 2).join("\n");
  expect(fitsBox("claude", half, typed["typed"]!.text, 40)).toBe(true); // 119 columns
  expect(fitsBox("claude", half, narrow.text, narrow.rows)).toBe(false);
  expect(fitsBox("claude", typed["typed"]!.typed!, narrow.text, narrow.rows)).toBe(true);
  // Four lines fold into a placeholder: one line of box, however narrow.
  expect(fitsBox("claude", `${narrow.typed!}\nmore`, narrow.text, narrow.rows)).toBe(true);
});

test("story 613: the trace in Claude's transcript: a user line or an enqueue line holding the whole of what was typed, whitespace aside, unwrapped from the paste tag; not one older than a second before typing, nor a dequeue, nor another text", () => {
  const at = Date.parse("2026-01-01T00:00:10.000Z");
  const line = (o: object) => JSON.stringify({ timestamp: "2026-01-01T00:00:10.500Z", ...o });
  const t = "[来自 槽位 w/b，经 rh send]\n⚠️ 注意\t✔️ 好 👨‍👩‍👧 家";
  // Claude puts four spaces for the tab.
  expect(traced("claude", t, at, [line({ type: "user", message: { role: "user", content: "[来自 槽位 w/b，经 rh send]\n⚠️ 注意    ✔️ 好 👨‍👩‍👧 家" } })])).toBe(true);
  const long = "[来自 Rhodium：子槽位汇报]\n第二行\n第三行\n第四行\n第五行";
  const wrapped = `\n\n<pasted_content id="2dd9">\n${long}\n</pasted_content id="2dd9">\n`;
  expect(traced("claude", long, at, [line({ type: "user", message: { role: "user", content: wrapped } })])).toBe(true);
  expect(traced("claude", long, at, [line({ type: "user", message: { role: "user", content: [{ type: "text", text: wrapped }] } })])).toBe(true);
  expect(traced("claude", long, at, [line({ type: "queue-operation", operation: "enqueue", content: wrapped.trim() })])).toBe(true);
  // Your words joined to it: it got there all the same.
  expect(traced("claude", t, at, [line({ type: "user", message: { role: "user", content: `我的半句${t}` } })])).toBe(true);
  // A standalone joiner Claude dropped on Enter.
  expect(traced("claude", "[来自 槽位 w/b，经 rh send]\na‍b", at, [line({ type: "user", message: { role: "user", content: "[来自 槽位 w/b，经 rh send]\nab" } })])).toBe(true);
  expect(traced("claude", long, at, [line({ type: "queue-operation", operation: "dequeue", content: long })])).toBe(false);
  expect(traced("claude", long, at, [line({ type: "user", message: { role: "user", content: "[来自 Rhodium：子槽位汇报]\n第二行" } })])).toBe(false);
  expect(traced("claude", long, at, [JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:08.000Z", message: { role: "user", content: long } })])).toBe(false);
  expect(traced("claude", long, at, ["not json"])).toBe(false);
});

test("story 631: from the board, a / or ! command for Claude or pi is typed bare, with no source line; an internal one never is", () => {
  expect(typedFrom("/greet hello world", true)).toBe("/greet hello world");
  expect(typedFrom("!echo hi\x03", true)).toBe("!echo hi");
  expect(typedFrom("plain words", true)).toBeNull();
  expect(typedFrom("/greet hello world")).toBeNull();
});

test("story 631: the look before Enter for a / command in Claude (2.1.325): the box holds it, its list of commands gone once it has arguments, or the one picked in the list the one typed; not when the list picks another, where Enter would run that one", () => {
  for (const name of ["slash-typed", "slash-list-same"]) expect([name, inBox("claude", typed[name]!.text, typed[name]!.typed!)]).toEqual([name, true]);
  const other = typed["slash-list-other"]!;
  expect(inputState("claude", other.status, other.text)).toBe("draft");
  expect(inBox("claude", other.text, other.typed!)).toBe(false);
  // The same screens with a message of yours typed: no list check for words not led by /.
  expect(inBox("claude", typed["slash-typed"]!.text, "[来自 网页]\n/greet hello world")).toBe(false);
});

test("story 631: a ! command in Claude (2.1.325) turns its box to shell mode, its mark ! for ❯: the box holds the command, or the command and the rest of one in its history it suggests, which Enter leaves out (probe); empty shell mode is a draft, and a message is never matched there", () => {
  const bang = typed["bang-typed"]!;
  expect(inBox("claude", bang.text, bang.typed!)).toBe(true);
  expect(inBox("claude", bang.text, "printf ok")).toBe(false);
  expect(inBox("claude", bang.text, "[来自 网页]\nprintf ok")).toBe(false);
  const ghost = typed["bang-ghost-typed"]!;
  expect(ghost.typed).toBe("!echo hi");
  expect(inBox("claude", ghost.text, ghost.typed!)).toBe(true);
  expect(inBox("claude", ghost.text, "!echo hi3")).toBe(false);
  const empty = typed["bang-empty"]!;
  expect(inputState("claude", empty.status, empty.text)).toBe("draft");
  expect(inputState("claude", bang.status, bang.text)).toBe("draft");
});

test("story 631: the trace of a / or ! command in Claude's transcript (2.1.325): a skill's command line, a built-in's local command line, the shell input line; while it works its enqueue line, the ! left out; not the output lines", () => {
  const at = Date.parse("2026-01-01T00:00:10.000Z");
  const line = (o: object) => JSON.stringify({ timestamp: "2026-01-01T00:00:10.500Z", ...o });
  const user = (content: string) => line({ type: "user", message: { role: "user", content } });
  expect(traced("claude", "/greet hello world", at, [user("<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>hello world</command-args>")])).toBe(true);
  expect(traced("claude", "/greet hello world", at, [user("<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>hello</command-args>")])).toBe(false);
  expect(traced("claude", "/context", at, [line({ type: "system", subtype: "local_command", content: "<command-name>/context</command-name>\n  <command-message>context</command-message>\n  <command-args></command-args>" })])).toBe(true);
  expect(traced("claude", "/context", at, [line({ type: "system", subtype: "local_command", content: "<local-command-stdout>/context all to expand</local-command-stdout>" })])).toBe(false);
  expect(traced("claude", "!echo hi", at, [user("<bash-input>echo hi</bash-input>")])).toBe(true);
  // Tags written in a message of yours are words, not a command.
  const literal = "[来自 网页]\nExplain <command-name>/context</command-name>";
  expect(traced("claude", literal, at, [user(literal)])).toBe(true);
  expect(traced("claude", "!echo hi", at, [user("<bash-stdout>echo hi</bash-stdout><bash-stderr></bash-stderr>")])).toBe(false);
  expect(traced("claude", "/greet queued", at, [line({ type: "queue-operation", operation: "enqueue", content: "/greet queued" })])).toBe(true);
  expect(traced("claude", "!echo q", at, [line({ type: "queue-operation", operation: "enqueue", content: "echo q" })])).toBe(true);
  expect(traced("claude", "!echo q", at, [line({ type: "queue-operation", operation: "enqueue", content: "echo q and more" })])).toBe(false);
});

test("story 631: pi (1.5.0) shows a /skill: or ! command in its box as typed; its trace a skill's user message with the arguments after it, or a bashExecution message", () => {
  for (const name of ["skill-typed", "bang-typed"]) expect([name, inBox("pi", pi[name]!.text, pi[name]!.typed!)]).toEqual([name, true]);
  const at = Date.parse("2026-01-01T00:00:10.000Z");
  const msg = (message: object) => JSON.stringify({ timestamp: "2026-01-01T00:00:10.500Z", type: "message", message });
  const skill = '<skill name="greet" location="/work/.pi/skills/greet/SKILL.md">\nReply with exactly one line.\n</skill>\n\nhello world';
  expect(traced("pi", "/skill:greet hello world", at, [msg({ role: "user", content: [{ type: "text", text: skill }] })])).toBe(true);
  expect(traced("pi", "/skill:greet bye", at, [msg({ role: "user", content: [{ type: "text", text: skill }] })])).toBe(false);
  expect(traced("pi", "!echo hi2", at, [msg({ role: "bashExecution", command: "echo hi2", output: "hi2\n" })])).toBe(true);
  expect(traced("pi", "!echo hi2", at, [msg({ role: "bashExecution", command: "echo hi", output: "hi\n" })])).toBe(false);
});

// Codex's and pi's (story 615): codex-cli 0.166.0 and pi 1.5.0, Herdr 0.9.5, 2026-11-15.
const codex = load("codex-screens.jsonl");
const pi = load("pi-screens.jsonl");

test("story 615: the look before Enter in Codex and pi: the box holds just what was written, two lines or five, tabs and emoji as recorded, idle or working; or the agent's one placeholder: Codex's of a long text, pi's of a long text or of many lines", () => {
  for (const [agent, screens, names] of [
    ["codex", codex, ["typed", "blank-line-typed", "working-typed", "multi-typed", "emoji-typed", "long-typed", "narrow-fits-typed"]],
    ["pi", pi, ["typed", "working-typed", "multi-typed", "emoji-typed", "long-typed", "lines-typed", "narrow-fits-typed"]],
  ] as const) {
    for (const name of names) {
      const s = screens[name]!;
      expect([agent, name, inBox(agent, s.text, s.typed!)]).toEqual([agent, name, true]);
    }
  }
  // Each agent's own placeholder only.
  expect(inBox("pi", codex["long-typed"]!.text.replace("Pasted Content", "paste #1"), "x")).toBe(false);
  expect(inBox("codex", typed["typed-4-lines"]!.text, "x")).toBe(false);
});

test("story 615: not before Enter in Codex and pi: other text, a box scrolled past its top, Codex's approval dialog with digits written into it, its file popup over the box, an emoji with a variation selector Codex garbles on screen", () => {
  expect(inBox("codex", codex.typed!.text, "[来自 槽位 w/b，经 rh send]\n别的")).toBe(false);
  expect(inBox("pi", pi.typed!.text, "[来自 槽位 w/b，经 rh send]\n别的")).toBe(false);
  for (const [agent, screens] of [["codex", codex], ["pi", pi]] as const) {
    for (const name of ["scrolled-typed", "narrow-cut-typed"]) expect([agent, name, inBox(agent, screens[name]!.text, screens[name]!.typed!)]).toEqual([agent, name, false]);
  }
  expect(inBox("codex", codex["approval-typed"]!.text, "1 2 3")).toBe(false);
  expect(inBox("codex", codex["at-popup-typed"]!.text, codex["at-popup-typed"]!.typed!)).toBe(false);
  expect(inBox("codex", codex["emoji-vs16-typed"]!.text, codex["emoji-vs16-typed"]!.typed!)).toBe(false);
  expect(inBox("pi", pi.empty!.text, pi.typed!.typed!)).toBe(false);
});

test("story 615: Codex's dialog is a footer under its box, or a popup's hint just above it: your words in the box, or its last answer's line above the box, that read like a footer are no dialog", () => {
  // The message's own last line reads like a footer.
  const body = "第一段。\nPress Enter to confirm 那一步我没做。";
  const words = codex.typed!.text.replace("  请回复一句：收到。", `  第一段。\r\n  Press Enter to confirm 那一步我没做。`);
  const t = `[来自 槽位 w/b，经 rh send]\n${body}`;
  expect(inputState("codex", "idle", words)).toBe("draft");
  expect(inBox("codex", words, t)).toBe(true);
  // Its last answer's line just above the box, with no Worked for line under it.
  const long = codex["long-typed"]!;
  const answer = long.text.replace("• done. PLUM", "• Press enter to confirm, or esc to cancel.").replace(/ {2}Worked for 32s[^\n]*/, " ");
  expect(inputState("codex", "done", answer)).toBe("draft");
  expect(inBox("codex", answer, long.typed!)).toBe(true);
  // A trailing $word opens the skills popup, its hint "enter insert · esc close": Enter would take a skill.
  const skill = codex["at-popup-typed"]!.text.replace("enter/tab insert · esc close · ↑/↓ select · ←/→ filter", "enter insert · esc close").replace("看看 @hel", "看看 $a");
  expect(inputState("codex", "done", skill)).toBe("dialog");
  expect(inBox("codex", skill, "[来自 槽位 w/b，经 rh send]\n看看 $a")).toBe(false);
  // In a pane under 32 columns Codex cuts the hint with an ellipsis: still the popup.
  const cut = codex["at-popup-typed"]!.text.replace(/enter\/tab.*filter/, "enter/tab\x1b[0m\x1b[2m insert · \x1b[0m\x1b[1mesc\x1b[0m\x1b[2m cl…");
  expect(cut).not.toBe(codex["at-popup-typed"]!.text);
  expect(inputState("codex", "done", cut)).toBe("dialog");
  expect(inBox("codex", cut, codex["at-popup-typed"]!.typed!)).toBe(false);
});

test("story 615: Codex at ultra effort draws its prompt mark », recorded: its empty box is ready, under an earlier message of yours (›) too; the text in it is a draft, held whole", () => {
  const [empty, typed] = [codex["ultra-empty"]!, codex["ultra-typed"]!];
  expect(inputState("codex", "idle", empty.text)).toBe("ready");
  expect(inputState("codex", "idle", typed.text)).toBe("draft");
  expect(inBox("codex", typed.text, typed.typed!)).toBe(true);
  expect(inBox("codex", typed.text, "[来自 槽位 w/b，经 rh send]\n别的")).toBe(false);
  const below = (t: string) => t.replace(" \r\n \r\n\x1b[0m\x1b[1m\x1b[38;2;186;130;255m»", "› an earlier message of yours\r\n \r\n\x1b[0m\x1b[1m\x1b[38;2;186;130;255m»");
  expect(below(empty.text)).not.toBe(empty.text);
  expect(inputState("codex", "idle", below(empty.text))).toBe("ready");
  expect(inBox("codex", below(typed.text), typed.typed!)).toBe(true);
});

test("story 615: Codex with a blank status row (status_line ['git-branch'] outside a Git repository): a typed blank line stays in the box, its hint row shown or blank", () => {
  const s = codex["status-blank-typed"]!;
  expect(inBox("codex", s.text, s.typed!)).toBe(true);
  // With no startup warnings its hint row is blank under a draft too, as in typed: no footer at all.
  const bare = s.text.replace(/\n[^\n]*f2 [^\n]*$/, "\n ");
  expect(bare).not.toBe(s.text);
  expect(inBox("codex", bare, s.typed!)).toBe(true);
  expect(inputState("codex", "idle", bare)).toBe("draft");
  // The no-footer box still holds just what was typed.
  expect(inBox("codex", bare, "[来自 槽位 w/b，经 rh send]\n第一段。")).toBe(false);
  // Nor do its words read as a dialog's footer there.
  const footerish = bare.replace("  第二段。", "  Press enter to confirm the choice.");
  expect(footerish).not.toBe(bare);
  expect(inputState("codex", "idle", footerish)).toBe("draft");
  expect(inBox("codex", footerish, "[来自 槽位 w/b，经 rh send]\n第一段。\n\nPress enter to confirm the choice.")).toBe(true);
});

test("story 615: whether Codex's and pi's box shows a text whole in a phone-narrow pane: the one recorded whole fits, the one cut off does not; one each folds into its placeholder always fits", () => {
  for (const [agent, screens] of [["codex", codex], ["pi", pi]] as const) {
    const [fits, cut] = [screens["narrow-fits-typed"]!, screens["narrow-cut-typed"]!];
    expect([agent, fitsBox(agent, fits.typed!, fits.text, fits.rows)]).toEqual([agent, true]);
    expect([agent, fitsBox(agent, cut.typed!, cut.text, cut.rows)]).toEqual([agent, false]);
    expect([agent, fitsBox(agent, screens["scrolled-typed"]!.typed!, screens["scrolled-typed"]!.text, screens["scrolled-typed"]!.rows)]).toEqual([agent, false]);
  }
  expect(fitsBox("codex", "x".repeat(1001), codex["narrow-cut-typed"]!.text, 30)).toBe(true);
  expect(fitsBox("pi", Array(11).fill("x").join("\n"), pi["narrow-cut-typed"]!.text, 30)).toBe(true);
});

test("story 615: the trace in Codex's rollout is a user message response item, and in pi's session a user message, holding the whole of what was typed, pi's tab as four spaces; not Codex's developer message, nor an older one", () => {
  const at = Date.parse("2026-01-01T00:00:10.000Z");
  const stamp = "2026-01-01T00:00:10.400Z";
  const t = "[来自 槽位 w/b，经 rh send]\n⚠️ 警告\t制表 ✔️ 👨‍👩‍👧 end";
  const cx = (role: string, text: string, timestamp = stamp) => JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  expect(traced("codex", t, at, [cx("user", t)])).toBe(true);
  // Typed without its variation selectors, which Codex garbles on screen.
  expect(traced("codex", t, at, [cx("user", t.replace(/\uFE0F/g, ""))])).toBe(true);
  expect(traced("codex", t, at, [cx("developer", t)])).toBe(false);
  expect(traced("codex", t, at, [cx("user", t, "2026-01-01T00:00:08.000Z")])).toBe(false);
  const pl = (role: string, text: string) => JSON.stringify({ timestamp: stamp, type: "message", message: { role, content: [{ type: "text", text }] } });
  expect(traced("pi", t, at, [pl("user", t.replace("\t", "    "))])).toBe(true);
  expect(traced("pi", t, at, [pl("assistant", t)])).toBe(false);
  // Neither agent takes Claude's lines.
  expect(traced("pi", t, at, [JSON.stringify({ timestamp: stamp, type: "user", message: { role: "user", content: t } })])).toBe(false);
});

// ---- The whole of it: rhodium with a fake Herdr, whose pane shows a recorded Claude screen. ----

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
let rhodium: Instance;
let board = "";
afterEach(() => rhodium?.cleanup());

/** An instance with a fake Herdr whose bot q goes to w/a, and w/a switched to the terminal after a turn,
 *  its pane showing Claude's empty box; returns the pane, the transcript file of its session, and the slot's id. */
async function inTerminal(toml = "", screen = "empty-bare", confirm = "3s") {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey }, herdr: true, toml: `[durations]\ntuiHeld = "3s"\ntuiConfirm = "${confirm}"\n${toml}` });
  const daemon = await rhodium.start();
  board = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  const pane = (await herdr("session.snapshot")).snapshot.panes[0].pane_id as string;
  await show(pane, screen, "idle");
  const id = (await fromBoard("/api/board")).workspaces[0].groups;
  const slot = (Object.values(id).flat() as { id: string; name: string }[]).find((c) => c.name === "a")!.id;
  const file = join(rhodium.home, ".claude/projects", claudeProjectDir(join(rhodium.dir, "w")), `${session}.jsonl`);
  return { pane, file, slot };
}
/** A request to the fake Herdr; its error answer throws, so a screen set on a pane that is gone fails here. */
const herdr = (method: string, params: object = {}) => request(rhodium.herdr.socket, method, params);
const fromBoard = async (path: string) => (await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
/** Shows a recorded screen in the pane, the default one's, or a screen given whole, with what Herdr says. */
const show = (pane: string, screen: string, status: string) => herdr("fake.set_screen", { pane_id: pane, text: plain[screen]?.text ?? typed[screen]?.text ?? screen, status });
const calls = async (method: string) => ((await herdr("fake.calls")).calls as { method: string; params: any }[]).filter((c) => c.method === method);
const queue = async (slot: string) => (await fromBoard(`/api/slot?id=${slot}`)).queue as { id: string; text: string; from: string; wait?: string; unsure?: true }[];
/** Appends lines to the transcript as Claude writes them, stamped now. */
function write(file: string, ...lines: object[]) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.map((l) => JSON.stringify({ timestamp: new Date().toISOString(), ...l }) + "\n").join(""));
}
const userLine = (content: string) => ({ type: "user", message: { role: "user", content } });
/** An assistant line stamped ms ago, as Claude writes one at its stream's end, stamped at its start. */
const older = (ms: number) => ({ type: "assistant", timestamp: new Date(Date.now() - ms).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "…" }] } });
function rows(sql: string): any[] {
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}
const notices = async () => (await rhodium.im.log("q", ME)).map((p) => p.text).filter((t) => t.includes("尚未确认收到") || t.includes("还没交给它"));

test("stories 606, 608, 613: rh send to a Claude slot in the terminal says it is typed in; with the box empty two looks running, the text alone goes in, then Enter once the box holds just it; its user line in the transcript takes it, its words cleared, off the queue", async () => {
  const { pane, file, slot } = await inTerminal();
  expect(await rhodium.ok("send", "w/a", "hello\nworld")).toContain("已发给 w/a。它在 TUI 里，等输入框空着、没有对话框时打进去。");
  const want = "[来自 用户的终端，经 rh send]\nhello\nworld";
  await until(async () => (await calls("pane.send_keys")).length > 0, 10_000);
  const all = ((await herdr("fake.calls")).calls as { method: string; params: any }[]).filter((c) => c.params?.pane_id === pane);
  const wrote = all.findIndex((c) => c.method === "pane.send_input");
  expect(all[wrote]!.params).toEqual({ pane_id: pane, text: want, keys: [] });
  // Two reads of the screen before it, at least, and one after it before Enter.
  expect(all.slice(0, wrote).filter((c) => c.method === "pane.read").length).toBeGreaterThanOrEqual(2);
  const enter = all.findIndex((c) => c.method === "pane.send_keys");
  expect(all[enter]!.params).toEqual({ pane_id: pane, keys: ["enter"] });
  expect(all.slice(wrote, enter).some((c) => c.method === "pane.read")).toBe(true);
  expect((await queue(slot)).map((q) => q.wait)).toEqual(["正在打进去"]);
  write(file, userLine(want));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  expect(rows("SELECT status, body, typed FROM agentInput WHERE queueReason = 'tui'")).toEqual([{ status: "taken", body: null, typed: null }]);
}, 60_000);

test("#737: an rh send whose body is a / or ! command is typed with its source line first, the command on the next line, never bare as yours from the board is", async () => {
  const { pane, file, slot } = await inTerminal();
  for (const [i, body] of ["/compact", "!echo hi"].entries()) {
    await rhodium.ok("send", "w/a", body);
    await until(async () => (await calls("pane.send_keys")).length === i + 1, 10_000);
    const want = `[来自 用户的终端，经 rh send]\n${body}`;
    expect((await calls("pane.send_input"))[i]!.params).toEqual({ pane_id: pane, text: want, keys: [] });
    write(file, userLine(want));
    await until(async () => (await queue(slot)).length === 0, 5_000);
  }
}, 60_000);

test("stories 606, 613: Claude working with its box empty, or with a message of its own queued, is typed into all the same, and the enqueue line takes it; a long one wrapped in the paste tag too", async () => {
  const { pane, file, slot } = await inTerminal("", "working");
  await show(pane, "working", "working");
  await rhodium.ok("send", "w/a", "first");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  write(file, { type: "queue-operation", operation: "enqueue", content: "[来自 用户的终端，经 rh send]\nfirst" });
  await until(async () => (await queue(slot)).length === 0, 5_000);
  await show(pane, "queued", "working");
  const long = "a\nb\nc\nd";
  await rhodium.ok("send", "w/a", long);
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
  write(file, { type: "queue-operation", operation: "enqueue", content: `<pasted_content id="1">\n[来自 用户的终端，经 rh send]\n${long}\n</pasted_content id="1">` });
  await until(async () => (await queue(slot)).length === 0, 5_000);
}, 60_000);

test("story 611: nothing is written while the box has text, a dialog is open, Claude's vim mode shows no INSERT, Herdr says unknown, or /status is open under Herdr's idle; written once the screen is fine again", async () => {
  const { pane, slot } = await inTerminal("", "draft");
  await show(pane, "draft", "idle");
  await rhodium.ok("send", "w/a", "wait for it");
  for (const [screen, status, wait] of [
    ["draft", "idle", "等输入框空出来"],
    ["permission", "blocked", "等对话框关掉"],
    ["status", "idle", "等对话框关掉"],
    ["empty-bare", "unknown", "认不出画面"],
  ] as const) {
    await show(pane, screen, status);
    await until(async () => (await queue(slot))[0]?.wait === wait, 5_000);
    await Bun.sleep(1500);
    expect([screen, (await calls("pane.send_input")).length]).toEqual([screen, 0]);
  }
  // vim: the slot's settings say so; the empty box shows no INSERT, which NORMAL looks like.
  mkdirSync(join(rhodium.dir, "w/.claude"), { recursive: true });
  writeFileSync(join(rhodium.dir, "w/.claude/settings.json"), JSON.stringify({ editorMode: "vim" }));
  await show(pane, "vim-normal", "idle");
  await until(async () => (await queue(slot))[0]?.wait === "等输入框空出来", 5_000);
  await Bun.sleep(1500);
  expect((await calls("pane.send_input")).length).toBe(0);
  await show(pane, "vim-insert", "idle");
  await until(async () => (await calls("pane.send_input")).length === 1, 5_000);
}, 60_000);

test("stories 608, 611, 613: a dialog that comes as the text goes in stops Enter: unknown at once, 已投递，尚未确认收到 on the board with 重发; you hear once past durations.tuiHeld; sent again, it is typed again once the box is empty and taken by its trace", async () => {
  const { pane, file, slot } = await inTerminal();
  await herdr("fake.on_input", { pane_id: pane, text: typed["typed-then-permission-renamed"]!.text, status: "blocked" });
  await rhodium.ok("send", "w/a", "into a dialog");
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  expect(await queue(slot)).toMatchObject([{ text: "into a dialog", from: "用户的终端", wait: "已投递，尚未确认收到", unsure: true }]);
  expect(await calls("pane.send_keys")).toEqual([]);
  await until(async () => (await notices()).length === 1, 10_000);
  expect((await notices())[0]).toBe("投递到 w/a 终端的这条，3 秒了尚未确认收到，没有再发：\n“[来自 用户的终端，经 rh send] into a dialog”\n要再发，到网页上点“重发”。");
  // Sent again: the dialog gone, the box empty, it goes in again, and in.
  await show(pane, "empty-bare", "idle");
  const id = (await queue(slot))[0]!.id;
  expect(await (await boardAct(board, { kind: "queued", slot, op: "resend", input: id })).json()).toEqual({ ok: true, text: "等输入框空出来就再打进去。" });
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await calls("pane.send_input")).length).toBe(2);
  write(file, userLine("[来自 用户的终端，经 rh send]\ninto a dialog"));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  await Bun.sleep(3500);
  expect(await notices()).toHaveLength(1);
}, 60_000);

test("stories 608, 612: a look before Enter whose reads hang stops at 2 s: unknown, no Enter; the notice past durations.tuiHeld says it is still in the box; a trace after that still takes it", async () => {
  const { pane, file, slot } = await inTerminal();
  // Herdr hangs only in the look before Enter, from the text on.
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 50, after: "pane.send_input" });
  await rhodium.ok("send", "w/a", "hangs");
  await until(async () => (await calls("pane.send_input")).length === 1, 10_000);
  const at = Date.now();
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  expect(Date.now() - at).toBeLessThan(4_000);
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 0 });
  expect((await calls("pane.send_keys")).length).toBe(0);
  await until(async () => (await notices()).length === 1, 10_000);
  expect((await notices())[0]).toEndWith("\n它还在输入框里，到终端里按回车发出去，或者删掉。");
  write(file, userLine("[来自 用户的终端，经 rh send]\nhangs"));
  await until(async () => (await queue(slot)).length === 0, 10_000);
}, 60_000);

test("story 612: typed and Entered with no trace in durations.tuiConfirm (30 s) is unknown; a trace after that still takes it", async () => {
  const { file, slot } = await inTerminal();
  await rhodium.ok("send", "w/a", "quiet");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await queue(slot))[0]?.wait).toBe("正在打进去");
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  write(file, userLine("[来自 用户的终端，经 rh send]\nquiet"));
  await until(async () => (await queue(slot)).length === 0, 10_000);
}, 60_000);

test("stories 608, 612: pane_not_found on the text puts it back in the queue, typed again; a send_keys whose connection closes leaves it being typed, Enter never pressed again, its trace taking it; Claude's one placeholder in the box is Entered", async () => {
  const { pane, file, slot } = await inTerminal();
  await herdr("fake.fail", { method: "pane.send_input", how: "error", code: "pane_not_found" });
  await herdr("fake.fail", { method: "pane.send_keys", how: "close" });
  await rhodium.ok("send", "w/a", "two lines\nof it");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await calls("pane.send_input")).length).toBe(2);
  await Bun.sleep(1500);
  expect((await calls("pane.send_keys")).length).toBe(1);
  expect(rows("SELECT status FROM agentInput WHERE queueReason = 'tui'")).toEqual([{ status: "writing" }]);
  write(file, userLine("[来自 用户的终端，经 rh send]\ntwo lines\nof it"));
  await until(async () => (await queue(slot)).length === 0, 10_000);
  // Claude folds it into a placeholder, whatever Rhodium counted. (The Enter that closed is the fake's none.)
  await show(pane, "empty-bare", "idle");
  await herdr("fake.on_input", { pane_id: pane, text: typed["typed-4-lines"]!.text, status: "idle" });
  await rhodium.ok("send", "w/a", "short");
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
}, 60_000);

test("story 610: over 2000 characters, the body goes in the media dir and two lines are typed: the source line and where to read it", async () => {
  const { slot } = await inTerminal();
  const body = "长".repeat(2500);
  await rhodium.ok("send", "w/a", body);
  await until(async () => (await calls("pane.send_input")).length === 1, 10_000);
  const text: string = (await calls("pane.send_input"))[0]!.params.text;
  const [line, said, more] = text.split("\n");
  expect([line, more]).toEqual(["[来自 用户的终端，经 rh send]", undefined]);
  const path = /^这条消息有 2500 字，全文在 (\S+)，先读它。$/.exec(said!)![1]!;
  expect(path.startsWith(join(rhodium.dir, "state/media/"))).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(body);
  expect((await queue(slot))[0]!.text).toBe(body);
}, 60_000);

test("story 614: back to headless, what was never typed goes to the headless agent; what was typed and not found stays unknown on the board, never given it, till sent again from there", async () => {
  const { pane, slot } = await inTerminal();
  await herdr("fake.on_input", { pane_id: pane, text: plain["draft"]!.text, status: "idle" });
  await rhodium.ok("send", "w/a", "typed, lost");
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  await rhodium.ok("send", "w/a", "never typed");
  await until(async () => (await queue(slot))[1]?.wait === "等输入框空出来", 5_000);
  const headless = () => rhodium.claude.runs().filter((r) => r.argv[0] === "-p").flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => m.message.content[0].text as string));
  const before = headless().length;
  for (let i = 0; i < 2; i++) await herdr("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(() => headless().length === before + 1, 15_000);
  expect(headless().at(-1)).toContain("never typed");
  expect(await queue(slot)).toMatchObject([{ text: "typed, lost", wait: "已投递，尚未确认收到", unsure: true }]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const id = (await queue(slot))[0]!.id;
  expect(await (await boardAct(board, { kind: "queued", slot, op: "resend", input: id })).json()).toEqual({ ok: true, text: "已重发。" });
  await until(() => headless().length === before + 2, 15_000);
  expect(headless().at(-1)).toContain("typed, lost");
  expect(await queue(slot)).toEqual([]);
}, 60_000);

test("story 614: rhodium killed after Enter, before the trace: not typed again once back, and its trace then takes it; one dropped from the board is gone", async () => {
  const { pane, file, slot } = await inTerminal();
  await rhodium.ok("send", "w/a", "across a restart");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  await rhodium.kill9();
  // Its trace while rhodium is down, an older-stamped line written after it (architecture §10.5).
  write(file, userLine("[来自 用户的终端，经 rh send]\nacross a restart"), older(10_000));
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await until(async () => (await queue(slot)).length === 0, 10_000);
  expect((await calls("pane.send_input")).length).toBe(1);
  expect((await calls("pane.send_keys")).length).toBe(1);
  // A typed one taken off the board.
  await show(pane, "empty-bare", "idle");
  await herdr("fake.fail", { method: "pane.send_keys", how: "close" });
  await rhodium.ok("send", "w/a", "drop me");
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
  const id = (await queue(slot))[0]!.id;
  expect(await (await boardAct(board, { kind: "queued", slot, op: "drop", input: id })).json()).toEqual({ ok: true, text: "删掉了。" });
  expect(await queue(slot)).toEqual([]);
}, 60_000);

test("story 613: Claude writes lines out of time order: an enqueue line followed by an older-stamped assistant line still takes it, and so does a trace after more such lines", async () => {
  const { pane, file, slot } = await inTerminal("", "working");
  await show(pane, "working", "working");
  await rhodium.ok("send", "w/a", "while it works");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  write(file, { type: "queue-operation", operation: "enqueue", content: "[来自 用户的终端，经 rh send]\nwhile it works" }, older(10_000));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  await rhodium.ok("send", "w/a", "next");
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
  write(file, older(20_000));
  await Bun.sleep(1500);
  write(file, { type: "queue-operation", operation: "enqueue", content: "[来自 用户的终端，经 rh send]\nnext" });
  await until(async () => (await queue(slot)).length === 0, 5_000);
}, 60_000);

test("story 611: a box read empty once and with text at the next read is not typed into; two empty reads running are", async () => {
  const { pane, slot } = await inTerminal("", "draft");
  await show(pane, "draft", "idle");
  await rhodium.ok("send", "w/a", "wait for two");
  await until(async () => (await queue(slot))[0]?.wait === "等输入框空出来", 5_000);
  for (let i = 0; i < 2; i++) {
    const reads = (await calls("pane.read")).length;
    await herdr("fake.set_screen", { pane_id: pane, text: plain["empty-bare"]!.text, status: "idle", then: { text: plain["draft"]!.text } });
    await until(async () => (await calls("pane.read")).length > reads + 1, 5_000);
  }
  expect((await calls("pane.send_input")).length).toBe(0);
  await show(pane, "empty-bare", "idle");
  await until(async () => (await calls("pane.send_input")).length === 1, 5_000);
}, 60_000);

test("story 612: the next is not typed while the one before is typed and not found under durations.tuiConfirm; once that is unknown, it is", async () => {
  const { slot } = await inTerminal("", "empty-bare", "6s");
  await rhodium.ok("send", "w/a", "one");
  await until(async () => (await calls("pane.send_input")).length === 1, 10_000);
  const at = Date.now();
  await until(async () => (await calls("pane.send_keys")).length === 1, 5_000);
  await rhodium.ok("send", "w/a", "two");
  await until(async () => (await calls("pane.send_input")).length === 2, 15_000);
  expect(Date.now() - at).toBeGreaterThanOrEqual(5_000);
  expect((await queue(slot)).map((q) => q.text)).toEqual(["one", "two"]);
  expect((await queue(slot))[0]!.unsure).toBe(true);
}, 60_000);

test("story 608: at the look before Enter, Herdr saying blocked or unknown alone stops Enter, the box holding just what was written", async () => {
  const { pane, slot } = await inTerminal();
  for (const [n, status] of [[1, "blocked"], [2, "unknown"]] as const) {
    await show(pane, "empty-bare", "idle");
    await herdr("fake.on_input", { pane_id: pane, status });
    await rhodium.ok("send", "w/a", status);
    await until(async () => (await queue(slot)).filter((q) => q.unsure).length === n, 10_000);
    expect([status, (await calls("pane.send_keys")).length]).toEqual([status, 0]);
  }
}, 60_000);

test("story 613: sent again while still in the box, it is not typed; its trace then takes it, and once the box is empty nothing more is typed", async () => {
  const { pane, file, slot } = await inTerminal();
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 50, after: "pane.send_input" });
  await rhodium.ok("send", "w/a", "still there");
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 0 });
  const id = (await queue(slot))[0]!.id;
  expect(await (await boardAct(board, { kind: "queued", slot, op: "resend", input: id })).json()).toEqual({ ok: true, text: "等输入框空出来就再打进去。" });
  await Bun.sleep(1500);
  expect((await calls("pane.send_input")).length).toBe(1);
  write(file, userLine("[来自 用户的终端，经 rh send]\nstill there"));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  await show(pane, "empty-bare", "idle");
  await Bun.sleep(2500);
  expect((await calls("pane.send_input")).length).toBe(1);
}, 60_000);

test("stories 613, 614: unknown, then a /clear in the terminal and back to headless, then into the terminal again: sent again, it is typed into the conversation the terminal has now, and taken by its trace there", async () => {
  const { pane, slot } = await inTerminal();
  await herdr("fake.on_input", { pane_id: pane, text: plain["draft"]!.text, status: "idle" });
  await rhodium.ok("send", "w/a", "across a clear");
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  const fresh = crypto.randomUUID();
  await herdr("pane.report_agent_session", { pane_id: pane, source: "claude", agent: "claude", agent_session_id: fresh });
  for (let i = 0; i < 2; i++) await herdr("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  expect((await queue(slot)).map((q) => q.unsure)).toEqual([true]);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  const now = (await herdr("session.snapshot")).snapshot.panes[0].pane_id as string;
  await show(now, "empty-bare", "idle");
  const id = (await queue(slot))[0]!.id;
  expect(await (await boardAct(board, { kind: "queued", slot, op: "resend", input: id })).json()).toEqual({ ok: true, text: "等输入框空出来就再打进去。" });
  await until(async () => (await calls("pane.send_keys")).some((c) => c.params.pane_id === now), 10_000);
  expect((await calls("pane.send_input")).at(-1)!.params.pane_id).toBe(now);
  write(join(dirname(join(rhodium.home, ".claude/projects", claudeProjectDir(join(rhodium.dir, "w")), "x")), `${fresh}.jsonl`), userLine("[来自 用户的终端，经 rh send]\nacross a clear"));
  await until(async () => (await queue(slot)).length === 0, 5_000);
}, 60_000);

test("story 614: rhodium killed once marked being typed, before the text went, and again after the text, before Enter: neither typed again nor Entered once back; unknown 30 s on", async () => {
  const { slot } = await inTerminal();
  await herdr("fake.fail", { method: "pane.send_input", how: "hang" });
  await rhodium.ok("send", "w/a", "before the text");
  await until(async () => (await calls("pane.send_input")).length === 1, 10_000);
  await rhodium.kill9();
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await until(async () => (await queue(slot))[0]?.unsure === true, 10_000);
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 50, after: "pane.send_input" });
  await rhodium.ok("send", "w/a", "before Enter");
  await until(async () => (await calls("pane.send_input")).length === 2, 10_000);
  await rhodium.kill9();
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 0 });
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await until(async () => (await queue(slot)).every((q) => q.unsure) && (await queue(slot)).length === 2, 10_000);
  expect((await calls("pane.send_input")).length).toBe(2);
  expect((await calls("pane.send_keys")).length).toBe(0);
}, 60_000);

test("story 605: several waiting past durations.tuiHeld when a /rh_tui's pane opens on an empty box are typed one by one; no notice comes while they go in", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: [...startTurn, { sleep: 4000 }, ...endTurn("slow"), { goto: 0 }] } }, herdr: true, toml: '[durations]\ntuiHeld = "1s"' });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "take your time" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/rh_tui" });
  const words = ["m1", "m2", "m3", "m4"];
  for (const w of words) await rhodium.ok("send", "w/a", w);
  // The pane of the tab named after the slot: the tab a new workspace comes with is the only one for a
  // moment first, till the bridge closes it, and a screen set there is lost.
  let pane = "";
  await until(async () => {
    const { tabs, panes } = (await herdr("session.snapshot")).snapshot;
    const tab = tabs.find((t: { label: string }) => t.label === "a")?.tab_id;
    pane = panes.find((p: { tab_id: string }) => p.tab_id === tab)?.pane_id ?? "";
    return pane !== "";
  }, 15_000);
  await show(pane, "empty-bare", "idle");
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);
  const file = join(rhodium.home, ".claude/projects", claudeProjectDir(join(rhodium.dir, "w")), `${session}.jsonl`);
  // Each Entered is found in the transcript at once, as Claude writes it.
  let traced = 0;
  await until(async () => {
    const entered = (await calls("pane.send_keys")).length;
    for (; traced < entered; traced++) write(file, userLine(`[来自 用户的终端，经 rh send]\n${words[traced]}`));
    return traced === words.length;
  }, 40_000);
  await Bun.sleep(1500);
  expect((await notices()).filter((t) => t.includes("还没交给它"))).toEqual([]);
}, 60_000);

test("story 614: a trace written in the last second before the terminal's agent exits takes what was typed, by the last look in the transcript on the way back", async () => {
  const { pane, file, slot } = await inTerminal();
  await rhodium.ok("send", "w/a", "just in time");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  write(file, userLine("[来自 用户的终端，经 rh send]\njust in time"));
  for (let i = 0; i < 2; i++) await herdr("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  expect(await queue(slot)).toEqual([]);
  expect(rows("SELECT status FROM agentInput WHERE queueReason = 'tui'")).toEqual([{ status: "taken" }]);
}, 60_000);
