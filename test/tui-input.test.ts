// Whether a slot's terminal takes typing now (story 607, architecture §10.5): what Herdr says of the
// pane's agent and the bottom of its screen, as pane.read gives it with ANSI styles. Claude's screens are
// the ones recorded in test/fixtures/herdr/claude-screens.jsonl (Claude Code 2.1.325, Herdr 0.9.5).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inputState } from "../src/tui";

const screens: Record<string, { status: string; text: string; settings?: object }[]> = {};
for (const l of readFileSync(join(import.meta.dir, "fixtures/herdr/claude-screens.jsonl"), "utf8").split("\n").filter(Boolean)) {
  const s = JSON.parse(l);
  (screens[s.name] ??= []).push(s);
}
const screen = (name: string) => screens[name]![0]!.text;
/** The default screen's lines, with the input box's one line put as given: Claude's own escapes. */
const withBox = (box: string) => screen("empty").replace(/\n❯[^\n]*\r/, `\n${box}\r`);

test("story 607: Claude's recorded screens, default and fullscreen alike: a dialog's footer is dialog, whatever Herdr says; the box with only the grey hint, a queued message's hint or nothing is ready, idle or working; text in it is a draft", () => {
  const want: Record<string, string> = {
    empty: "ready", // the grey suggestion, dim
    "empty-bare": "ready",
    draft: "draft",
    working: "ready",
    queued: "ready", // "Press up to edit queued messages", dim too
    "vim-insert": "ready",
    permission: "dialog",
    trust: "dialog",
    status: "dialog", // Herdr says idle of /status
    "imports-dialog": "dialog",
  };
  const got = Object.fromEntries(Object.keys(want).map((n) => [n, [...new Set(screens[n]!.map((s) => inputState("claude", s.status, s.text)))].join()]));
  expect(got).toEqual(want);
  expect(screens.status![0]!.status).toBe("idle");
});

test("story 607: Herdr's word beside the screen: blocked over a plain screen is dialog, unknown over a footer is dialog, unknown alone is unknown, none yet is unknown; no screen or no box is unknown", () => {
  expect(inputState("claude", "blocked", screen("empty"))).toBe("dialog");
  expect(inputState("claude", "unknown", screen("permission"))).toBe("dialog");
  expect(inputState("claude", "unknown", screen("empty"))).toBe("unknown");
  expect(inputState("claude", undefined, screen("empty"))).toBe("unknown");
  expect(inputState("claude", "idle", undefined)).toBe("unknown");
  expect(inputState("claude", "idle", "")).toBe("unknown");
  expect(inputState("claude", "idle", "just some output\r\nno box at all")).toBe("unknown");
});

test("story 607: a footer's words mid-line and in another case are still a footer; the words in the box itself are not", () => {
  const footer = screen("empty").replace(/\r\n[^\n]*$/, "\r\n  press 1 or ENTER TO CONFIRM, esc TO CLOSE");
  expect(inputState("claude", "idle", footer)).toBe("dialog");
  expect(inputState("claude", "idle", withBox("❯ press Enter to go on, Esc to cancel"))).toBe("draft");
  // Only whole words: a status line you set up, below the box, says "center to".
  const status = screen("empty").replace(/\r\n[^\n]*$/, "\r\n  main · Move center to the left");
  expect(inputState("claude", "idle", status)).toBe("ready");
});

test("story 607: with no rule on the screen only its last three lines are looked at for a footer: output higher up that says Enter to is no dialog", () => {
  const output = ["Press Enter to continue", "line a", "", "line b", "line c"].join("\r\n");
  expect(inputState("claude", "idle", output)).toBe("unknown");
  expect(inputState("claude", "idle", `${output}\r\n  Enter to confirm`)).toBe("dialog");
});

test("story 607: a box whose first line is ❯ alone with text below is a draft; the hint is told by its dim style, not its words", () => {
  expect(inputState("claude", "idle", withBox(`❯ \r\nsecond line of a draft`))).toBe("draft");
  expect(inputState("claude", "idle", withBox(`❯ Press up to edit queued messages`))).toBe("draft");
  expect(inputState("claude", "idle", withBox(`❯ \x1b[0m\x1b[2mPress up to edit queued messages\x1b[0m`))).toBe("ready");
  // A colour whose numbers hold a 2 is not dim.
  expect(inputState("claude", "idle", withBox(`❯ \x1b[0m\x1b[38;2;2;2;2mmy words\x1b[0m`))).toBe("draft");
});

// Codex's and pi's screens, recorded in test/fixtures/herdr/codex-screens.jsonl (codex-cli 0.166.0) and
// pi-screens.jsonl (pi 1.5.0), Herdr 0.9.5, 2026-11-15 (story 615).
const recorded = (agent: string) =>
  Object.fromEntries(
    readFileSync(join(import.meta.dir, `fixtures/herdr/${agent}-screens.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [JSON.parse(l).name, JSON.parse(l) as { status: string; text: string; typed?: string }]),
  );

test("story 615: Codex's recorded screens: the box with only its grey placeholder is ready, idle or working, a steered message gone up into the history too; text in it is a draft; the approval dialog, and the file popup over the box, are dialogs", () => {
  const codex = recorded("codex");
  const want: Record<string, string> = {
    empty: "ready",
    working: "ready",
    "working-steered": "ready",
    typed: "draft",
    "blank-line-typed": "draft",
    "working-typed": "draft",
    "long-typed": "draft", // [Pasted Content N chars], not grey
    "multi-typed": "draft",
    "scrolled-typed": "draft",
    "emoji-typed": "draft",
    "narrow-fits-typed": "draft",
    approval: "dialog",
    "approval-typed": "dialog",
    "at-popup-typed": "dialog", // its hint line, enter/tab insert · esc close, just above the box
  };
  const got: Record<string, string> = Object.fromEntries(Object.keys(want).map((n) => [n, inputState("codex", codex[n]!.status, codex[n]!.text)]));
  expect(got).toEqual(want);
  // Herdr says idle of the popup: the screen alone tells it.
  expect(codex["at-popup-typed"]!.status).toBe("done");
});

test("story 615: pi's recorded screens: the box between its last two rules, the top one holding Working or how many lines are above; empty is ready, idle or working, a steered message shown above it too; text in it, or a selector in its place, is a draft", () => {
  const pi = recorded("pi");
  const want: Record<string, string> = {
    empty: "ready",
    working: "ready",
    "working-steered": "ready",
    typed: "draft",
    "working-typed": "draft",
    "long-typed": "draft",
    "lines-typed": "draft",
    "scrolled-typed": "draft",
    "emoji-typed": "draft",
    "esc-restored": "draft", // the steered message put back in the box by Esc
    resume: "draft", // /resume's selector where the box was: not empty, so not typed into
  };
  const got: Record<string, string> = Object.fromEntries(Object.keys(want).map((n) => [n, inputState("pi", pi[n]!.status, pi[n]!.text)]));
  expect(got).toEqual(want);
  // Herdr's blocked is a dialog over any screen; no box is unknown.
  expect(inputState("pi", "blocked", pi.empty!.text)).toBe("dialog");
  expect(inputState("pi", "idle", "some output\r\nno rules")).toBe("unknown");
  expect(inputState("codex", "idle", "some output\r\nno box")).toBe("unknown");
});
