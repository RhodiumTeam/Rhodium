// The message box's ↑↓ through what you said in the slot (spec web-import-composer "输入历史", story 650):
// where each key leaves you, and what the page adds as you send.
import { expect, test } from "bun:test";
import { recalled, walk, withSent } from "../web/src/write";

const said = ["第三句", "第二句", "第一句"]; // newest first, as GET /api/history gives them
const step = (keys: ("up" | "down")[], from = -1) => keys.reduce((at, k) => walk(said, at, k), from);

test("story 650: ↑ goes back one at a time from your draft (-1) and stops at the oldest; ↓ comes forward and, past the newest, back to the draft and no further", () => {
  expect(step(["up"])).toBe(0);
  expect(step(["up", "up", "up", "up"])).toBe(2);
  expect(step(["up", "up", "down"])).toBe(0);
  expect(step(["up", "up", "down", "down"])).toBe(-1);
  expect(step(["down"])).toBe(-1);
  // Edited, what was brought back is the draft: ↑ starts at the newest again.
  expect(step(["up"], -1)).toBe(0);
  expect(walk([], -1, "up")).toBe(-1);
});

test("story 650: what you send goes first, the same as the newest once, the newest 100 kept", () => {
  expect(withSent(said, "第四句")).toEqual(["第四句", ...said]);
  expect(withSent(said, "第三句")).toEqual(said);
  const many = Array.from({ length: 100 }, (_, i) => `m${i}`);
  expect(withSent(many, "new")).toEqual(["new", ...many.slice(0, 99)]);
});

test("story 650: what you send is kept as the transcript shows it, ! gone; not a command, nor a ! the terminal's agent runs in its shell (#737), which ↑ would bring back as words for it", () => {
  expect(recalled("  你好 ", 0, "claude", false)).toBe("你好");
  expect(recalled("!git status", 0, "claude", false)).toBe("git status");
  expect(recalled("/compact", 0, "claude", false)).toBeUndefined();
  expect(recalled("!", 0, "claude", false)).toBeUndefined();
  expect(recalled("!git status", 0, "claude", true)).toBeUndefined();
  expect(recalled("! ls", 0, "pi", true)).toBeUndefined();
  expect(recalled("你好", 0, "pi", true)).toBe("你好");
  // Codex's ! could not be probed: it goes to it as words, which its transcript keeps.
  expect(recalled("!git status", 0, "codex", true)).toBe("git status");
});
