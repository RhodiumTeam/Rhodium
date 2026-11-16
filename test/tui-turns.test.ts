// A turn in the terminal read off the agent's transcript (stories 618, 625, architecture §10.6): where
// it starts for your message typed in, what of it is the agent's words, a tool call, the turn cut short
// or over, and which words are its final reply. Played against the probe runs recorded in
// test/fixtures/herdr/turns.jsonl (2026-11-16, Claude Code 2.1.325 on haiku, codex-cli 0.166.0 at low
// effort, pi 1.5.0 on its default model, Herdr 0.9.5): each run's Herdr status changes, the keys
// pressed, and the transcript lines a turn is read from.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../src/contracts";
import { heard, noReply, reads, turnLine, type Heard } from "../src/tui";

type Step = { t: number; status?: string; act?: string; line?: any };
type Run = { name: string; agent: AgentKind; headless?: string; steps: Step[] };
const runs: Record<string, Run> = Object.fromEntries(
  readFileSync(join(import.meta.dir, "fixtures/herdr/turns.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [JSON.parse(l).name, JSON.parse(l)]),
);

/** What the run's transcript says of the turn begun by the message typed (its first user line's text,
 *  or the one given): where it started, and from there on the words, the reply, and how it ended. */
function play(run: Run, typed = firstSaid(run)) {
  const lines = run.steps.flatMap((s) => (s.line ? [s.line] : []));
  const at = Date.parse(lines[0].timestamp) - 1000;
  const start = lines.findIndex((v) => reads(run.agent, typed, at, v));
  let h: Heard = { spoke: start >= 0 && noReply(run.agent, lines[start]) };
  let ended: "end" | "cut" | undefined;
  for (const v of lines.slice(start + 1)) {
    const k = turnLine(run.agent, v);
    if (!k || ended) continue;
    h = heard(h, k);
    if (k.cut) ended = "cut";
    else if (k.end) ended = "end";
  }
  return { start, lines, ...h, ended };
}
const firstSaid = (run: Run): string => {
  const v = run.steps.find((s) => s.line && (s.line.type === "user" || s.line.message?.role === "user" || s.line.payload?.role === "user"))!.line;
  const c = v.message?.content ?? v.payload?.content;
  return typeof c === "string" ? c : c.map((b: any) => b.text).join("\n");
};

test("probe 1: in every run Herdr said working before the agent's first words or call reached the transcript, never a second or more after: two idle reads in a row after the last line written end a turn", () => {
  for (const run of Object.values(runs)) {
    const working = run.steps.find((s) => s.status === "working" || s.status === "blocked")?.t;
    const first = run.steps.find((s) => s.line && turnLine(run.agent, s.line) && (turnLine(run.agent, s.line)!.said !== undefined || turnLine(run.agent, s.line)!.acted))?.t;
    if (first === undefined || working === undefined) continue;
    expect([run.name, working < first + 1000]).toEqual([run.name, true]);
  }
});

test("probes 2, 6, story 618: Claude's turn starts at your user line, ends at its turn_duration line, and its final reply is its last words, the headless agent's for the same prompt", () => {
  const short = play(runs["claude-short"]!);
  expect([short.start >= 0, short.reply, short.ended]).toEqual([true, "x", "end"]);
  const tool = play(runs["claude-tool"]!);
  expect([tool.spoke, tool.reply, tool.ended]).toEqual([true, runs["claude-tool"]!.headless, "end"]);
});

test("probe 3, story 625: a message typed into Claude while it works on a turn with no tool calls is queued, then run after the turn's end as a user line of its own: that line starts its turn, the enqueue line not, and the reply is that turn's", () => {
  const run = runs["claude-queue"]!;
  const second = "[来自 Telegram 私聊]\nReply with just the letter y.";
  const p = play(run, second);
  const kinds = p.lines.map((v) => v.operation ?? v.subtype ?? v.type);
  // Recorded: the last turn's words, the dequeue, its turn_duration, then the second as a user line.
  expect(kinds.slice(kinds.indexOf("dequeue"))).toEqual(["dequeue", "assistant", "assistant", "turn_duration", "user", "assistant", "turn_duration"]);
  expect(p.lines[p.start].type).toBe("user");
  expect([p.reply, p.ended]).toEqual(["y", "end"]);
  // And the first message's turn ends before the second's starts, with its own reply.
  const first = play(run);
  expect([first.ended, first.reply?.startsWith("The sea")]).toEqual(["end", true]);
});

test("story 632: a / or ! command typed bare starts its turn at the line the agent wrote it as (#737 probes, Claude Code 2.1.325, pi 1.5.0): a Claude skill's command line, then its words, to its turn_duration; a ! command's shell input line, then its word on the output", () => {
  const greet = play(runs["claude-greet-args"]!, "/greet hello world");
  expect([greet.lines[greet.start]?.type, greet.reply, greet.ended]).toEqual(["user", "greet ok: hello world", "end"]);
  const bang = play(runs["claude-bang2"]!, "!echo hi2");
  expect([bang.lines[bang.start]?.message?.content, bang.reply, bang.ended]).toEqual(["<bash-input>echo hi2</bash-input>", "`echo hi2` returned `hi2`.", "end"]);
  // Typed while it worked: each runs after the turn, as a turn of its own.
  const q = runs["claude-queued-cmd"]!;
  expect([play(q, "/greet queued").reply, play(q, "/greet queued").ended]).toEqual(["greet ok: queued", "end"]);
  expect([play(q, "!echo q").reply, play(q, "!echo q").ended]).toEqual(["`echo q` returned `q`.", "end"]);
  const skill = play(runs["pi-skill"]!, "/skill:greet hello world");
  expect([skill.start >= 0, skill.reply]).toEqual([true, "greet ok: hello world"]);
});

test("story 632: a command that calls no model, Claude's /context or pi's ! (#737 probes), starts a turn that has done its part at once: two idle reads end it, with no final reply", () => {
  for (const [name, typed] of [["claude-context", "/context"], ["pi-bang2", "!echo hi2"], ["pi-queued", "!echo q"]] as const) {
    const p = play(runs[name]!, typed);
    expect([name, p.start >= 0, p.spoke, p.reply, p.ended]).toEqual([name, true, true, undefined, undefined]);
  }
  // A model's turn has not.
  const greet = runs["claude-greet-args"]!.steps.flatMap((s) => (s.line ? [s.line] : []));
  expect(greet.some((v) => noReply("claude", v))).toBe(false);
});

test("probe 5: No picked in Claude's permission dialog writes [Request interrupted by user for tool use], before its turn_duration: the turn is cut short, no final reply", () => {
  const run = runs["claude-deny2"]!;
  const lines = run.steps.flatMap((s) => (s.line ? [s.line] : []));
  const k = lines.map((v) => turnLine("claude", v));
  expect(k.findIndex((x) => x?.cut)).toBeLessThan(k.findIndex((x) => x?.end));
  expect(runs["claude-deny-pre"]!.steps.some((s) => s.status === "blocked")).toBe(true);
});

test("probes 5, 6: pi's final reply is its last words, as headless; Esc during a tool, after a sentence, writes an assistant message stopped by an error saying aborted, Esc before any words one stopped as aborted: both cut the turn short", () => {
  const tool = play(runs["pi-tool"]!);
  expect([tool.reply, tool.ended]).toEqual([runs["pi-tool"]!.headless, undefined]);
  const late = play(runs["pi-esc-tool"]!);
  expect([late.spoke, late.ended]).toEqual([true, "cut"]);
  const early = play(runs["pi-esc-early"]!);
  expect([early.spoke, early.ended]).toEqual([false, "cut"]);
});

test("probes 2, 6: Codex's turn ends at task_complete, its final reply the words marked final_answer, not the commentary before its command: the message the headless driver reports (final_answer first)", () => {
  const before = play(runs["codex-tool"]!);
  expect([before.start >= 0, before.reply?.trim(), before.ended]).toEqual([true, "I will read the file.", undefined]);
  const after = runs["codex-tool-approved"]!;
  const lines = [...before.lines.slice(before.start + 1), ...after.steps.flatMap((s) => (s.line ? [s.line] : []))];
  let h: Heard = { spoke: false };
  for (const v of lines) {
    const k = turnLine("codex", v);
    if (k) h = heard(h, k);
  }
  expect(h.reply).toBe("hello");
  expect(lines.map((v) => turnLine("codex", v)?.end).filter(Boolean)).toEqual([true]);
});

test("story 619: a tool call is read off the raw line with its whole input, its result by the call's id; Codex writes both in one line, with what the headless driver gives (codexCall)", () => {
  const raw = (name: string) => runs[name]!.steps.flatMap((s) => (s.line ? [s.line] : []));
  const all = (name: string) => raw(name).map((v) => turnLine(runs[name]!.agent, v)).filter((k) => k?.calls || k?.results);
  // The ids as recorded, from the raw call; each result line refers to its call by it.
  const call = (name: string, type: string) => {
    const content: any[] = raw(name).find((v) => v.message?.content?.some?.((b: any) => b.type === type)).message.content;
    return { ...content.find((b) => b.type === type), said: content.find((b) => b.type === "text")?.text };
  };
  const claude = call("claude-tool", "tool_use");
  expect(all("claude-tool")).toEqual([{ acted: true, calls: [{ id: claude.id, name: claude.name, input: claude.input }] }, { results: [claude.id] }]);
  const pi = call("pi-tool", "toolCall");
  expect(all("pi-tool")).toEqual([
    { said: pi.said, acted: true, calls: [{ id: pi.id, name: pi.name, input: pi.arguments }] },
    { results: [pi.id] },
  ]);
  const { id } = raw("codex-tool-approved").find((v) => v.payload?.item?.type === "CommandExecution").payload.item;
  expect(all("codex-tool-approved")).toEqual([{ acted: true, calls: [{ id, name: "exec_command", input: { command: "cat note.txt" } }], results: [id] }]);
  // A tool's result alone says nothing of the turn's words.
  expect(heard({ spoke: false }, { results: ["x"] })).toEqual({ spoke: false });
});
