import { expect, test } from "bun:test";
import { folded } from "../web/src/tools";
import { isYourTick, ticksOf, visibleTicks } from "../web/src/ticks";
import type { Block } from "../web/src/data";

test("ticks follow your user messages in folded blocks and pair each with its reply", () => {
  const user = (at: string, text: string, source: string | null = null): Block => ({ kind: "user", at, text, time: null, from: null, source });
  const answer = (at: string, text: string): Block => ({ kind: "assistant", at, text, time: null });
  const tool = (at: string): Block => ({ kind: "tool", at, time: null, id: at, name: "Bash", input: "{}", shown: { name: "Bash", arg: "ls", code: true }, result: { at, time: null, text: "ok", error: false } });
  const shown = folded([
    answer("0", "Earlier reply"),
    user("1", "First\nsecond"),
    tool("1.5"),
    answer("2", "Reply\ncontinues"),
    user("3", "Before internal", "网页"),
    user("4", "Task", "槽位 w/b，经 rh send"),
    answer("5", "Internal reply"),
    user("6", "Subagent report", "Rhodium：子槽位汇报"),
    answer("7", "Report reply"),
    user("8", "Confirm", "Rhodium：确认结果"),
    user("9", "From QQ", "QQ 私聊"),
    user("10", "From terminal", "用户的终端，经 rh send"),
    answer("11", "Later"),
  ]);
  expect(ticksOf(shown).map((t) => [t.at, t.text, t.reply])).toEqual([
    ["1", "First\nsecond", "Reply\ncontinues"],
    ["3", "Before internal", undefined],
    ["9", "From QQ", undefined],
    ["10", "From terminal", "Later"],
  ]);
  expect(isYourTick({ kind: "user", at: "a", text: "hi", time: null, from: null, source: "槽位 w/b，经 rh send" })).toBe(false);
  expect(isYourTick({ kind: "user", at: "b", text: "hi", time: null, from: null, source: "Rhodium：子槽位汇报" })).toBe(false);
  expect(isYourTick({ kind: "user", at: "c", text: "hi", time: null, from: null, source: "用户的终端，经 rh send" })).toBe(true);
});

test("dense ticks stay within seventy percent of the height around the current item", () => {
  expect(visibleTicks(10, 5, 300, false)).toEqual({ first: 0, count: 10, step: 9 });
  expect(visibleTicks(100, 50, 60, false)).toEqual({ first: 43, count: 14, step: 3 });
  expect(visibleTicks(100, 99, 60, false).first).toBe(86);
});
