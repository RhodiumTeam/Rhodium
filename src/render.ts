// The renderer (architecture §2, §8.2): what a turn shows in a chat, from its agent events, written
// as docs/im-style.md §3 says. Pure: no network or database; the time comes in through View.
// edit() is how a platform that edits a message in place (Telegram) shows a turn: one message, in the
// order things happened. append() is how one that can only add messages (QQ) does: a message each
// time the agent finishes saying something, the tool calls before it in a line on top.
import { homedir } from "node:os";
import type { AgentEvent, Capabilities } from "./contracts";
import { named, NOT_TOOLS, runs, shortLine, type Call } from "./tool-line";

/** A part of a turn: something the agent said, done once it is whole; or the tool calls between two. */
type Part = { text: string; done?: true } | { tools: Call[] };

export type Progress = {
  parts: Part[];
  // The tool call that started and has not ended yet, and since when.
  running: { id: string; call: Call; since: number } | null;
  // Edit platforms: where the turn's message starts, past what the messages it moved on from show:
  // a part, and how far into it (characters of text, calls of tools).
  from: [number, number];
  // Edit platforms: what the turn's message was last given to show.
  shown: string;
  // Append platforms: the parts before this went out, or wait in kept.
  sent: number;
  // Append platforms: messages that wait for the turn's end, the quota's room used up.
  kept: string[];
  // The tool calls in no tool line (their ids), as they showed some other way: those that asked you
  // first, as asks; a step a message that stopped showed, as all it had (moveOn). An older Rhodium
  // saved it as asked (router.ts progressOf).
  hidden?: string[];
};

/** How a chat shows a turn: detailed tool lines or short ones (/rh_verbose), the slot's directory
 *  that paths are written relative to, the time now, and the platform. toolsOnly: the agent's rh send
 *  me took the turn over in this chat, so what it says from then on is not shown, its tool lines are
 *  (im-style §3.4). */
export type View = { verbose: boolean; dir: string; now: number; caps: Capabilities; toolsOnly?: boolean };
/** A message: its plain text, and the same in the platform's Markdown where it has one. */
export type Msg = { text: string; markdown?: string };

export const start = (): Progress => ({ parts: [], running: null, from: [0, 0], shown: "", sent: 0, kept: [] });

/** Keeps the tool call (its id, if the agent says) out of the tool lines, as it shows some other way:
 *  the call an ask is about shows as the ask (im-style §3.1). */
export const hide = <P extends Progress>(p: P, id: string | undefined): P => (id ? { ...p, hidden: [...(p.hidden ?? []), id] } : p);

/** Folds one agent event into the turn's progress. */
export function track(p: Progress, e: AgentEvent, v: View): Progress {
  const parts = p.parts.slice();
  const last = parts.at(-1);
  const talking = last && "text" in last && !last.done ? last : undefined;
  // What the agent says next is a new part: a step still running is over by then.
  if (e.type === "text_delta") {
    if (talking) parts[parts.length - 1] = { text: talking.text + e.text };
    else parts.push({ text: e.text });
    return { ...p, parts, running: null };
  }
  if (e.type === "tool_start") return NOT_TOOLS.has(e.name) ? p : { ...p, running: { id: e.id, call: describe(e.name, e.input, v.dir), since: v.now } };
  if (e.type !== "item") return p;
  const item = e.item;
  if (item.kind === "message") {
    // The whole of the message the text so far began, else another one.
    if (!talking) return { ...p, parts: [...parts, { text: item.text, done: true }], running: null };
    const i = parts.length - 1;
    parts[i] = { text: item.text, done: true };
    const moved = p.from[0] === i && !item.text.startsWith(talking.text.slice(0, p.from[1]));
    return { ...p, parts, running: null, from: moved ? [i, 0] : p.from };
  }
  const running = p.running && (!item.id || p.running.id === item.id) ? null : p.running;
  if (NOT_TOOLS.has(item.name) || (item.id && p.hidden?.includes(item.id))) return { ...p, running };
  const call = describe(item.name, item.input, v.dir);
  if (last && "tools" in last) parts[parts.length - 1] = { tools: [...last.tools, call] };
  else parts.push({ tools: [call] });
  return { ...p, parts, running };
}

// ---- Tool lines (im-style §3.1). ----

const ARG = 40; // the most characters of a tool's argument
const LINE = 60; // the most characters of a detailed tool line
const MAX_LINES = 10; // a tool part with more detailed lines than this is one short line

// What looks like a secret, as *** (docs/im-style.md §3.1): a tool line goes to the IM platform's servers.
const SECRETS: [RegExp, string][] = [
  [/\b(?:sk-|ghp_)[\w-]+/g, "***"],
  [/\b(Bearer\s+)[^\s"']+/gi, "$1***"],
  [/(--token(?:=|\s+))("[^"]*"|'[^']*'|\S+)/g, "$1***"],
  [/(\b\w*(?:key|token|secret|password)\w*=)("[^"]*"|'[^']*'|[^\s&"']+)/gi, "$1***"],
];
const redact = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);

/** Characters as you see them, an emoji one. */
const width = (s: string) => [...new Intl.Segmenter().segment(s)].length;

/** A tool call as its tool line shows it (im-style §3.1's table). hide: what looks like a secret is
 *  ***, as it goes to the IM platform's servers; the board, yours alone, shows it all (ADR-0013). */
export function describe(name: string, input: unknown, dir: string, hide = true): Call {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { name: `${mcp[1]}.${mcp[2]}`, arg: null, code: false };
  // pi's bash is Bash; Codex's exec_command stays as it is (im-style §3.1).
  const shown = /^[a-z]+$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  const given = (typeof input === "object" && input) || {};
  const str = (key: string) => {
    const v = (given as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() ? (hide ? redact(v) : v) : null;
  };
  const asCode = (arg: string | null) => ({ name: shown, arg: arg && clip(arg, ARG, "…"), code: true });
  const asText = (arg: string | null) => ({ name: shown, arg: arg && clip(arg, ARG, "…"), code: false });
  switch (shown) {
    case "Bash":
    case "exec_command": {
      const command = str("command");
      if (command && !command.includes("\n") && width(command) <= ARG) return asCode(command);
      return str("description") ? asText(str("description")) : asCode(command && command.replace(/\s+/g, " "));
    }
    case "apply_patch": {
      const paths = ((given as { changes?: { path?: unknown }[] }).changes ?? []).flatMap((c) => (typeof c?.path === "string" ? [c.path] : []));
      return { name: shown, arg: paths[0] ? `${shortPath(paths[0], dir)}${paths.length > 1 ? ` 等 ${paths.length} 个文件` : ""}` : null, code: true };
    }
    case "Read":
    case "view_image":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const path = str("file_path") ?? str("notebook_path") ?? str("path");
      return { name: shown, arg: path && shortPath(path, dir), code: true };
    }
    case "Grep":
    case "Glob":
      return asCode(str("pattern"));
    case "WebSearch":
    case "web_search":
      return asCode(str("query"));
    case "WebFetch":
      return asCode(str("url")?.replace(/^https:\/\//, "") ?? null);
    case "Agent":
    case "Task":
      return asText(str("description"));
    case "Skill":
      return asCode(str("skill"));
    default:
      return { name: shown, arg: null, code: false };
  }
}

/** A path relative to the slot's directory, else with ~ for home; over ARG, its head and last two
 *  parts with … between, else its head and file name, else …/ and its file name (im-style §2.4). */
function shortPath(path: string, dir: string): string {
  const home = homedir();
  const p = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  if (width(p) <= ARG) return p;
  const parts = p.replace(/\/+$/, "").split("/"); // a directory's trailing / would leave an empty name
  const head = parts[0] === "~" || parts[0] === "" ? 2 : 1;
  const cuts = [
    parts.length > head + 2 && [...parts.slice(0, head), "…", ...parts.slice(-2)],
    parts.length > head + 1 && [...parts.slice(0, head), "…", ...parts.slice(-1)],
    parts.length > 1 && ["…", ...parts.slice(-1)],
  ];
  for (const cut of cuts) if (cut && width(cut.join("/")) <= ARG) return cut.join("/");
  return clip(p, ARG, "…");
}

/** Text set as inline code, whatever backticks it has. */
function codeSpan(s: string): string {
  const fence = "`".repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** A tool line: the plain text, and the Markdown. */
type Line = [string, string];

/** An argument as a tool line's Markdown shows it. */
const argMd = (arg: string, isCode: boolean, v: View) => (isCode ? codeSpan(arg) : (markdown(arg, v.caps) ?? arg));

/** The tool lines of a run of calls: one a tool, with its arguments, as many as fit in LINE
 *  characters; or, short or over MAX_LINES, one line of names. */
function toolLines(calls: Call[], v: View): Line[] {
  const rs = runs(calls);
  if (!rs.length) return [];
  if (!v.verbose || rs.length > MAX_LINES) {
    const line = `[🔧 ${shortLine(calls)}]`;
    return [[line, line]];
  }
  return rs.map((r) => {
    let line: Line = [`[🔧 ${named(r)}]`, `[🔧 ${named(r)}]`];
    for (const [i, arg] of r.args.entries()) {
      const sep = i ? "、" : " ";
      if (width(line[0] + sep + arg) > LINE) return [`${line[0]}…`, `${line[1]}…`];
      line = [line[0] + sep + arg, line[1] + sep + argMd(arg, r.code, v)];
    }
    return line;
  });
}

const MINUTE = 60_000;

/** The step still running, the tool part's last line: for how long, once that is a minute or more. */
function runningLine(r: NonNullable<Progress["running"]>, v: View): Line {
  const m = Math.floor((v.now - r.since) / MINUTE);
  const took = m < 1 ? "" : m < 60 ? `（${m} 分钟）` : `（${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}）`;
  const arg = v.verbose ? r.call.arg : null;
  const head = `[🔧 ${r.call.name}] `;
  if (arg === null) return [`${head}正在运行${took}`, `${head}正在运行${took}`];
  return [`${head}${arg}，正在运行${took}`, `${head}${argMd(arg, r.call.code, v)}，正在运行${took}`];
}

/** The step still running as a detailed tool line says it, plain: /status's (docs/im-style.md §7.1). */
export const runningText = (r: NonNullable<Progress["running"]>, now: number): string => runningLine(r, { verbose: true, dir: "", now, caps: {} as Capabilities })[0];

/** Agent text as a part of a message shows it: without the blank lines around it. */
const clean = (text: string) => text.replace(/^\n+/, "").trimEnd();

// ---- Platforms that edit a message (Telegram): one message, in the order things happened (im-style §3.3). ----

/** One part of the turn's message: plain, in Markdown, and which part of the turn it is. */
type Block = { text: string; md: string; part: number };

/** The turn's parts from the position from on, and, if live, the step still running. A tool part is
 *  a quote in Markdown; text from partway into a code block opens it again. */
function blocks(p: Progress, from: [number, number], v: View, live: boolean): Block[] {
  const out: Block[] = [];
  const tools = (calls: Call[], running: Progress["running"], part: number) => {
    const lines = toolLines(calls, v);
    if (running) lines.push(runningLine(running, v));
    if (lines.length) out.push({ text: lines.map((l) => l[0]).join("\n"), md: lines.map((l) => `> ${l[1]}`).join("  \n"), part });
  };
  const running = live ? p.running : null;
  p.parts.forEach((part, i) => {
    if (i < from[0]) return;
    const at = i === from[0] ? from[1] : 0;
    if ("tools" in part) return tools(part.tools.slice(at), i === p.parts.length - 1 ? running : null, i);
    if (v.toolsOnly) return;
    const text = clean(resume(part.text, at, v.caps.maxTextLength));
    if (text) out.push({ text, md: markdown(text, v.caps) ?? text, part: i });
  });
  // A step that started after the agent said something is a tool part of its own.
  if (running && !(p.parts.at(-1) && "tools" in p.parts.at(-1)!)) tools([], running, p.parts.length);
  return out;
}

const join = (bs: Block[], caps: Capabilities): Msg => {
  const text = bs.map((b) => b.text).join("\n\n");
  return caps.markdown ? { text, markdown: bs.map((b) => b.md).join("\n\n") } : { text };
};

/** The messages the turn shows from p.from on: the turn's message last, those it outgrew before it,
 *  each cut between parts, else, a part alone over the limit, at a line break; and where the last starts. */
function layout(p: Progress, v: View, live: boolean): { msgs: Msg[]; from: [number, number] } {
  const max = v.caps.maxTextLength;
  const msgs: Msg[] = [];
  for (let from = p.from; ; ) {
    const bs = blocks(p, from, v, live);
    let n = 0;
    for (let len = -2; n < bs.length && len + 2 + bs[n]!.text.length <= max; n++) len += 2 + bs[n]!.text.length;
    if (n === bs.length) return { msgs: [...msgs, join(bs, v.caps)], from };
    if (n > 0) {
      msgs.push(join(bs.slice(0, n), v.caps));
      from = [bs[n]!.part, 0];
      continue;
    }
    // ponytail: a tool part is at most MAX_LINES lines, so only text gets this long.
    const part = p.parts[bs[0]!.part];
    const [first, next] = part && "text" in part ? pieces(part.text, max, bs[0]!.part === from[0] ? from[1] : 0) : [];
    if (!next) return { msgs: [...msgs, join(bs, v.caps)], from };
    msgs.push(join([{ ...bs[0]!, text: clean(first!.text), md: markdown(clean(first!.text), v.caps) ?? "" }], v.caps));
    from = [bs[0]!.part, next.at];
  }
}

/**
 * One event on a platform that edits one message in place (e null: the clock moved on): what the
 * turn's message should show now, nothing when it shows that already. Text that outgrows the
 * platform's limit goes on in new messages: out[0] is for the turn's message, which keeps the part
 * that fits; the rest are new messages, the last of them the turn's message from then on.
 */
export function edit(p: Progress, e: AgentEvent | null, v: View): { progress: Progress; out: Msg[] } {
  const next = e ? track(p, e, v) : p;
  const { msgs, from } = layout(next, v, true);
  const last = msgs.at(-1)!;
  if (msgs.length === 1 && (!last.text || last.text === p.shown)) return { progress: next, out: [] };
  return { progress: { ...next, from, shown: last.text }, out: msgs };
}

/** The turn's message once nothing more goes to it: as it was, without the step still running. One
 *  that showed only that step keeps it, done: a message can't be empty. */
export function freeze(p: Progress, v: View): Msg {
  const m = layout(p, v, false).msgs[0]!;
  return m.text || !p.running ? m : layout({ ...p, parts: [...p.parts, { tools: [p.running.call] }] }, v, false).msgs[0]!;
}

/** On a platform that edits, once something else went to the chat mid-turn, say an ask or a picture:
 *  the turn's message stays as it is, and what comes after it goes in a new message, under that (story 72).
 *  The step it showed running stays with it: an ask's waits for you, it does not run. */
export function moveOn(p: Progress, v: View): Progress {
  const i = p.parts.length - 1;
  const last = p.parts[i];
  // One that showed only that step keeps it, done (freeze): no tool line after shows it again.
  const done = p.running && !layout(p, v, false).msgs[0]!.text ? hide(p, p.running.id) : p;
  return { ...done, from: last ? [i, "text" in last ? last.text.length : last.tools.length] : [0, 0], shown: "", running: null };
}

/** rh send me took the turn over, and then your message joined it (product §5.5): what the agent said
 *  until now and has not shown, here from the turn's message on (edits) or from what it sent last,
 *  goes, so dropping toolsOnly shows what it says from now on and none of that. */
export function hush<P extends Progress>(p: P, v: View): P {
  const [at, from] = v.caps.progress === "edit" ? p.from : [p.sent, 0];
  const parts = p.parts.map((x, i) => (i < at || !("text" in x) ? x : { text: i === at ? x.text.slice(0, from) : "", done: true as const }));
  return { ...p, parts };
}

/** The turn's last messages on a platform that edits: all of it, the final reply its last part (it
 *  is the agent's last message), without the step still running. The first goes in place of the
 *  turn's message; more follow it where the turn outgrew it. */
export function finishEdit(p: Progress, reply: string | undefined, v: View): Msg[] {
  const talked = p.parts.some((x) => "text" in x && x.text.trim());
  const all = talked || !reply ? p : { ...p, parts: [...p.parts, { text: reply, done: true as const }] };
  return layout(all, v, false).msgs.filter((m) => m.text.trim());
}

// ---- Platforms that only add messages (QQ): a message each thing said (im-style §3.2). ----

/** What the agent said, with the tool calls before it in a line on top. */
function said(calls: Call[], text: string, v: View): string {
  const lines = toolLines(calls, v).map((l) => l[0]).join("\n");
  return lines && text ? `${lines}\n\n${text}` : lines || text;
}

/** The parts from p.sent through end as messages: one each thing said; only its tool line once rh
 *  send me took the turn over (View). Tool calls after the last of it are left out. */
function spoken(p: Progress, end: number, v: View): string[] {
  const out: string[] = [];
  let calls: Call[] = [];
  for (const part of p.parts.slice(p.sent, end + 1)) {
    if ("tools" in part) calls = [...calls, ...part.tools];
    else if (clean(part.text)) {
      const m = said(calls, v.toolsOnly ? "" : clean(part.text), v);
      if (m) out.push(m);
      calls = [];
    }
  }
  return out;
}

/**
 * One event on a platform that can only add messages. room: how many messages the turn may still
 * send before its end. What the agent said goes out once something comes after it, in pieces that
 * fit the platform's limit; the last of it waits for the turn's end, as the final reply. Once the
 * room is used up, what it says waits too, for finish.
 */
export function append(p: Progress, e: AgentEvent, v: View, room: number): { progress: Progress; sends: string[] } {
  const next = track(p, e, v);
  // A tool call started, even one that asks you (no tool line), comes after what was said.
  let end = next.parts.length - (next.running || e.type === "tool_start" ? 1 : 2);
  const spoke = (x: Part) => "text" in x && clean(x.text);
  while (end >= next.sent && !spoke(next.parts[end]!)) end--;
  if (end < next.sent) return { progress: next, sends: [] };
  const sends: string[] = [];
  const kept = [...next.kept];
  for (const m of spoken(next, end, v)) {
    const pieces = chunkText(m, v.caps.maxTextLength);
    if (!kept.length && pieces.length <= room - sends.length) sends.push(...pieces);
    else kept.push(m);
  }
  return { progress: { ...next, sent: end + 1, kept }, sends };
}

/** The turn's last messages on a platform that only adds them: what it said and has not sent, the
 *  last of it the final reply; with what waited, in one message where that fits, else with a line
 *  saying how much waited. A turn that said nothing shows its tools and says so. One rh send me took
 *  over (View) says none of it: the tools not sent yet, those after the final reply too, go in one line. */
export function finish(p: Progress, reply: string | undefined, v: View): string[] {
  const max = v.caps.maxTextLength;
  const calls = p.parts.slice(p.sent).flatMap((x) => ("tools" in x ? x.tools : []));
  const all = [...p.kept];
  if (v.toolsOnly) {
    if (calls.length) all.push(said(calls, "", v));
  } else if (p.parts.some((x) => "text" in x && clean(x.text))) all.push(...spoken(p, p.parts.length - 1, v));
  else if (reply?.trim() || calls.length) all.push(said(calls, reply?.trim() ? clean(reply) : "这一回合没有回复文字。", v));
  if (all.length <= 1) return chunkText(all[0] ?? "", max);
  const joined = all.join("\n\n");
  if (joined.length <= max) return [joined];
  return chunkText(`中间还有 ${all.length - 1} 段话没发出来，看板上能看到。\n\n${all.at(-1)}`, max);
}

// ---- Text over a platform's limit, in pieces (story 74). Adapted from qq-cli's chunkText (MIT,
// notice in src/qq.ts), and taught about code fences. ----

// A backtick fence's info string has no backticks (CommonMark): ```a``` opens inline code, not a fence.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
/** The backticks or tildes of the fence a line opens. */
const run = (open: string) => FENCE.exec(open)![1]!;

/** The fence open after line, given the one open before it (null for none). */
function fenced(open: string | null, line: string): string | null {
  const fence = FENCE.exec(line)?.[1];
  if (!fence) return open;
  if (open === null) return line.trimStart();
  return line.trim() === fence && fence[0] === run(open)[0] && fence.length >= run(open).length ? null : open;
}

/** The line that opened the code fence still open at offset at of text, if any. */
const fenceAt = (text: string, at: number): string | null => text.slice(0, at).split("\n").reduce(fenced, null);

/** The fence line open, if it and its closing line take no more than half of a max-character
 *  piece; else null, and the text is cut like any other. */
const fits = (open: string | null, max: number) => (open !== null && open.length + run(open).length + 2 <= max / 2 ? open : null);

/** text from offset at on, opening again the code fence that offset is inside, as pieces does. */
function resume(text: string, at: number, max: number): string {
  const open = at ? fits(fenceAt(text, at), max) : null;
  return (open === null ? "" : `${open}\n`) + text.slice(at);
}

/** Where to cut text so its first part fits in limit: the last line break, else the last space,
 *  else limit itself, never inside a surrogate pair. */
function cutAt(text: string, limit: number): number {
  limit = Math.max(2, limit);
  let cut = text.lastIndexOf("\n", limit);
  if (cut < limit / 2) cut = text.lastIndexOf(" ", limit);
  if (cut < limit / 2) cut = limit;
  if (cut === limit && /[\uD800-\uDBFF]/.test(text[cut - 1]!)) cut--;
  return cut;
}

/** text from offset from, in pieces of at most max characters. A piece cut inside a code fence
 *  closes it, and the next one opens it again with the same line, so each piece is whole Markdown;
 *  unless the fence's lines would take over half a piece, when it is cut like any other text.
 *  at: where each piece's own text starts in text. */
function pieces(text: string, max: number, from = 0): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (let at = from; ; ) {
    const open = fits(fenceAt(text, at), max);
    const head = open === null ? "" : `${open}\n`;
    const rest = text.slice(at);
    if (head.length + rest.length <= max) return [...out, { at, text: head + rest }];
    let cut = cutAt(rest, max - head.length);
    let close = fits(fenceAt(text, at + cut), max);
    if (close !== null) {
      cut = cutAt(rest, max - head.length - run(close).length - 1);
      close = fits(fenceAt(text, at + cut), max);
    }
    out.push({ at, text: head + rest.slice(0, cut) + (close === null ? "" : `\n${run(close)}`) });
    at += cut;
    if (text[at] === "\n") at++;
  }
}

/** The first max characters of text as you see them, never half of one, nor of an emoji; more
 *  goes after them when that leaves some out. */
export function clip(text: string, max: number, more = ""): string {
  let out = "";
  let n = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (n++ === max) return out + more;
    out += segment;
  }
  return out;
}

/** Text cut up to fit the platform's longest message, max characters; the pieces go out one a message. */
export function chunkText(text: string, max: number): string[] {
  return pieces(text, max)
    .map((p) => p.text)
    .filter((t) => t.trim());
}

// ---- Markdown by the platform's capability table (story 73). ----

// start: the text opens its line.
const ESCAPES: Record<NonNullable<Capabilities["markdown"]>["extensions"][number], (s: string, start: boolean) => string> = {
  html: (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
  math: (s) => s.replaceAll("$", "\\$"),
  spoiler: (s) => s.replaceAll("||", "\\|\\|"),
  mark: (s) => s.replaceAll("==", "\\=\\="),
  // After html's: the entity's & is not to be escaped again.
  emoji: (s) => s.replace(/:(?=[\w+-]+:)/g, "&#58;"),
  // After an indent, a > and a list's mark; no space follows the escape, so QQ eats none (literal).
  heading: (s, start) => (start ? s.replace(/^(\s*(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)?)(?=#+[^\s#])/, "$1\\") : s),
};
// A code span, else a run of text with no backticks, else backticks that open no span.
const SPANS = /(`+)[\s\S]*?(?<!`)\1(?!`)|[^`]+|`+/g;
// A code span, else a link [text](to), its text maybe with code in it; not a picture's ![...](...).
const LINKS = /(`+)[\s\S]*?(?<!`)\1(?!`)|(?<!!)\[([^\]\n]*)\]\(\s*<?([^()\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * Agent text in the platform's Markdown, undefined where it shows plain text only. The syntax the
 * platform adds to GFM is escaped outside code, so an agent's plain words show as written.
 */
// ponytail: an indented code block counts as text; agents fence their code.
export function markdown(text: string, caps: Capabilities | undefined): string | undefined {
  const md = caps?.markdown;
  if (!md) return undefined;
  const escape = (s: string, start: boolean) => md.extensions.reduce((t, x) => ESCAPES[x](t, start), s);
  const unlink = (s: string) => (md.links === "http" ? s.replace(LINKS, (m, code, label: string, to: string) => (code || /^https?:\/\//i.test(to) ? m : label)) : s);
  let open: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const inside = open !== null;
      open = fenced(open, line);
      if (inside || open !== null) return line;
      return unlink(line).replace(SPANS, (part, _ticks, at: number) => (part.startsWith("`") ? part : escape(part, at === 0)));
    })
    .join("\n");
}

/** Plain text, Rhodium's own, as QQ Markdown that shows it as written: a backslash before what its
 *  syntax (bot.qq.com's Markdown docs) would take as formatting, a line's indent as no-break spaces
 *  (else 4 spaces open a code block, where a backslash shows), and each line break a hard one, two
 *  spaces before it, as in those docs. As seen on a phone (2026-10-22), QQ eats the space right after
 *  an escape, so that one goes as a no-break space; and it shows a backslash before [ or ], so a
 *  link's `](` or a link definition's `]:` is broken by a zero-width space instead. */
// ponytail: the phone test covered \* \_ \` \# \> \- 1\. only; \~ \< \& \+ \= 1\) are as CommonMark has them.
export function literal(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[\\`*_~<]|&(?=#?\w+;)/g, "\\$&")
        .replace(/\](?=[(:])/g, "]\u200b")
        .replace(/^[ \t]+(?=\S)/, (indent) => indent.replaceAll(" ", "\u00a0").replaceAll("\t", "\u00a0".repeat(4)))
        .replace(/^(\s*)([#>+=-]|\d+(?=[.)]))/, (_, indent: string, mark: string) => (/\d/.test(mark) ? `${indent}${mark}\\` : `${indent}\\${mark}`))
        .trimEnd()
        // At a line's end the no-break space goes first, keeping the hard break's two spaces whole.
        .replace(/(\\\S)(?: |$)|\\\S/g, (escape, spaced?: string) => (spaced ? `${spaced}\u00a0` : escape)),
    )
    .join("\n")
    .replace(/(?<=.)\n(?=.)/g, "  \n");
}

// A query reply (docs/im-style.md §7) is written with md`...`: its formatting comes from the template
// alone, every value put in shows as written (architecture §8.2). The template's marks become these,
// which no value has, till queryMarkdown or plain says them as the platform shows them.
const BOLD = "\uE000";
const CODE = "\uE001";
const H2 = "\uE002";
const H3 = "\uE003";
const MARKS = /[\uE000-\uE003]/g;

/** A query reply: the template's ## and ### at a line's start, **bold** and `code` are its formatting;
 *  the values, a slot's name, a path, a model's, are words, whatever they hold. A value that is a
 *  query reply itself keeps its formatting. */
export function md(template: TemplateStringsArray, ...values: (string | number)[]): string {
  const marked = template.map((t, i) =>
    t
      .replace(i ? /(?<=\n)(#{2,3}) /g : /(?<=^|\n)(#{2,3}) /g, (_, h: string) => `${h.length === 2 ? H2 : H3} `)
      .replaceAll("**", BOLD)
      .replaceAll("`", CODE),
  );
  return marked.reduce((out, t, i) => out + String(values[i - 1]) + t);
}

/** A query reply's plain text, for where Markdown is turned down (story 411): its words, no marks. */
export const plain = (q: string): string => q.replace(/[\uE002\uE003] /g, "").replace(MARKS, "");

/** Words with nothing in them taken as GFM's formatting, nor as what the platform adds to it
 *  (extensions); start: they open a line, where a block's mark would be taken as one. */
function gfmLiteral(words: string, extensions: NonNullable<Capabilities["markdown"]>["extensions"], start: boolean): string {
  // The platform's own first, so a line's start sees its escape, not a mark to escape again.
  const escaped = extensions.reduce((t, x) => ESCAPES[x](t, start), words.replace(/[\\`*_~[\]]/g, "\\$&"));
  return !start ? escaped : escaped.replace(/^(\s*)([#>+=-]|\d+(?=[.)]))/, (_, indent: string, mark: string) => (/\d/.test(mark) ? `${indent}${mark}\\` : `${indent}\\${mark}`));
}

/** A query reply in the platform's Markdown, undefined where it shows plain text only: the template's
 *  headings and bold as they are, each line break a hard one, the rest shown as written. On QQ that is
 *  literal's escaping, a directory with no code; elsewhere GFM's, a directory as code. */
export function queryMarkdown(q: string, caps: Capabilities | undefined): string | undefined {
  if (!caps?.markdown) return undefined;
  const marks = (t: string) => t.replace(MARKS, (m) => (m === BOLD ? "**" : m === H2 ? "##" : "###"));
  if (caps.markdown.literal) return marks(literal(q.replaceAll(CODE, "")));
  const { extensions } = caps.markdown;
  const code = (v: string) => {
    const fence = "`".repeat(Math.max(0, ...(v.match(/`+/g) ?? []).map((r) => r.length)) + 1);
    const pad = /^`|`$/.test(v) ? " " : "";
    return `${fence}${pad}${v}${pad}${fence}`;
  };
  return q
    .split("\n")
    .map((line) => marks(line.split(CODE).map((part, i) => (i % 2 ? code(part) : gfmLiteral(part, extensions, i === 0))).join("")))
    .join("\n")
    .replace(/(?<=.)\n(?=.)/g, "  \n");
}
