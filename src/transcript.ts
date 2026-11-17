// Transcript reader: pages through an agent's own transcript file (Claude's, pi's or
// Codex's, one JSON object per line) by byte offset, never loading the whole file, and
// lists the conversations a directory has. Read-only: Rhodium never writes these files.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plain, quoteOf, type AgentKind, type Used } from "./contracts";
import { pictureType, saveMedia, withoutMedia, type Media } from "./media";
import { splitSource, withoutSource } from "./prompt";
import { clip, describe as shownCall } from "./render";
import type { Call } from "./tool-line";

export interface Entry {
  /** Byte offset of the line in the file. */
  offset: number;
  /** The line exactly as written, without its newline. */
  raw: string;
  type?: string;
  role?: string;
  content?: unknown;
}

export interface Page {
  entries: Entry[];
  /** Offset of the first entry: read backward from here for the page before. */
  start: number;
  /** Offset just past the last entry: read forward from here for the page after. */
  end: number;
}

const CHUNK = 64 * 1024;
const NL = 0x0a;

/**
 * Reads up to `limit` complete lines starting at byte offset `at` ("forward"),
 * or ending at `at` ("backward"; pass Infinity for the end of the file).
 * `at` must be 0, Infinity, or a `start`/`end` from an earlier page.
 * A last line still being written (no newline yet) is never returned.
 * Claude's api-request-blob lines are skipped and don't count toward `limit`.
 */
export async function readPage(file: string, at: number, limit: number, direction: "forward" | "backward"): Promise<Page> {
  const fh = await open(file, "r");
  try {
    if (direction === "forward") return await readForward(fh, at, limit);
    const page = await readBackward(fh, Math.min(at, (await fh.stat()).size), limit);
    // Lines skipped in that span left the page short: keep going back.
    while (page.entries.length < limit && page.start > 0) {
      const more = await readBackward(fh, page.start, limit - page.entries.length);
      page.entries.unshift(...more.entries);
      page.start = more.start;
    }
    return page;
  } finally {
    await fh.close();
  }
}

// Walks back to the newlines that bound the last `limit` complete lines before
// `at`, then reads those lines forward.
async function readBackward(fh: FileHandle, at: number, limit: number): Promise<Page> {
  const nls: number[] = [];
  const buf = Buffer.alloc(CHUNK);
  let pos = at;
  while (pos > 0 && nls.length <= limit) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    await fh.read(buf, 0, len, pos);
    for (let i = buf.lastIndexOf(NL, len - 1); i !== -1 && nls.length <= limit; i = i > 0 ? buf.lastIndexOf(NL, i - 1) : -1) {
      nls.push(pos + i);
    }
  }
  if (nls.length === 0) return { entries: [], start: 0, end: 0 };
  return await readForward(fh, nls.length > limit ? nls[limit]! + 1 : 0, Infinity, nls[0]! + 1);
}

// Reads lines from `from` until `limit` entries are kept or the next line starts at `until`.
async function readForward(fh: FileHandle, from: number, limit: number, until = Infinity): Promise<Page> {
  const entries: Entry[] = [];
  const buf = Buffer.alloc(CHUNK);
  let pending: Buffer[] = []; // bytes of the line being assembled
  let lineStart = from;
  let pos = from;
  while (entries.length < limit && lineStart < until) {
    const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
    if (bytesRead === 0) break;
    let i = 0;
    while (entries.length < limit && lineStart < until) {
      const nl = buf.indexOf(NL, i);
      if (nl === -1 || nl >= bytesRead) break;
      pending.push(buf.subarray(i, nl));
      const entry = toEntry(lineStart, Buffer.concat(pending).toString("utf8"));
      if (entry.type !== "api-request-blob") entries.push(entry);
      pending = [];
      lineStart = pos + nl + 1;
      i = nl + 1;
    }
    if (entries.length < limit && lineStart < until) pending.push(Buffer.from(buf.subarray(i, bytesRead)));
    pos += bytesRead;
  }
  return { entries, start: entries[0]?.offset ?? from, end: lineStart };
}

// Lines are untyped JSON written by the agent; anything but an object is not understood.
function parseObject(raw: string): any {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? fromCodex(asUser(v)) : undefined;
  } catch {
    return undefined;
  }
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// Codex's lines as pi's would be, which the rest of this file reads (architecture §6.4, §7.7): its
// first line, a header with the directory; what you and it said, its thought summaries, and its tool
// calls, each with its result, from its item_completed events; its compaction; your stopping a turn.
// Its other lines are not the conversation: response_item is what it sends the model.
function fromCodex(v: any): any {
  const p = v.payload;
  if (v.type === "session_meta") return { type: "session", timestamp: v.timestamp, cwd: p?.cwd, subagent: Boolean(p?.source?.subagent), branch: p?.git?.branch };
  if (v.type !== "event_msg") return v;
  if (p?.type === "turn_aborted") return { type: "system", subtype: "turn_aborted", timestamp: v.timestamp };
  const item = p?.type === "item_completed" ? p.item : undefined;
  const said = (role: string, content: unknown[]) => ({ type: "message", timestamp: v.timestamp, message: { role, content } });
  switch (item?.type) {
    case "UserMessage": // client_id: the input it was sent as (clientUserMessageId)
      return { ...said("user", list(item.content)), uuid: item.client_id };
    case "AgentMessage": // its text blocks are "Text"
      return said("assistant", list(item.content).map((c) => ({ type: "text", text: c?.text })));
    case "Reasoning":
      return said("assistant", [{ type: "thinking", thinking: list(item.summary_text).join("\n\n") }]);
    case "ContextCompaction":
      return { type: "compaction", timestamp: v.timestamp };
  }
  const call = item && codexCall(item);
  return call ? said("assistant", [{ type: "toolCall", id: item.id, ...call }]) : v;
}

/** A tool item of Codex's record as a call, by the name its model calls the tool by (architecture
 *  §6.4's table): what it was given, and its output. null for one not known. Only those 0.162.1 was
 *  seen writing: no rollout here had a plan or a dynamic tool's call. */
export function codexCall(item: any): { name: string; arguments: unknown; output: { text: string; error: boolean }; took?: number } | null {
  const failed = item.status !== undefined && item.status !== "completed";
  switch (item.type) {
    case "CommandExecution": // what ran, the last of `zsh -lc`'s words; took: how long it ran, in ms
      return {
        name: "exec_command",
        arguments: { command: list(item.command).at(-1) },
        output: { text: String(item.aggregated_output ?? ""), error: failed },
        took: (item.duration?.secs ?? 0) * 1000 + Math.round((item.duration?.nanos ?? 0) / 1e6),
      };
    case "FileChange": // by path: an add's content, an update's unified_diff
      return {
        name: "apply_patch",
        arguments: { changes: Object.entries(item.changes ?? {}).map(([path, change]) => ({ path, ...(change as object) })) },
        output: { text: `${item.stdout ?? ""}${item.stderr ?? ""}`, error: failed },
      };
    case "McpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, arguments: item.arguments ?? {}, output: { text: joined(item.result?.content) || (item.error ? JSON.stringify(item.error) : ""), error: failed || item.result?.isError === true } };
    case "ImageView":
      return { name: "view_image", arguments: { path: pathOf(String(item.path)) }, output: { text: "", error: false } };
    case "Extension": // its web search, in 0.162.1
      if (item.kind !== "web.search") return null;
      return { name: "web_search", arguments: { query: item.query }, output: { text: list(item.results).map((r) => [r?.title, r?.url].filter(Boolean).join(" ")).join("\n"), error: false } };
    case "SubAgentActivity": // a subagent it started is its spawn_agent; their later back and forth is not a call
      if (item.kind !== "started") return null;
      return { name: "spawn_agent", arguments: { agent_path: item.agent_path }, output: { text: "", error: false } };
  }
  return null;
}

/** The path a file: URL names, decoded (Codex writes a path as one, Url::from_file_path); any other
 *  string as it is. */
function pathOf(s: string): string {
  try {
    return fileURLToPath(s);
  } catch {
    return s;
  }
}

// What you send while a turn runs, Claude records once it takes it in as an attachment, not a user
// line; a task's notice and another session's message come the same way. Yours (origin human, or
// none on a line older Claude wrote) reads as the user line it would have been, by the uuid it was sent with.
function asUser(v: any): any {
  const a = v.type === "attachment" ? v.attachment : undefined;
  if (a?.type !== "queued_command" || a.isMeta || (a.origin?.kind ?? "human") !== "human") return v;
  return { ...v, type: "user", uuid: a.source_uuid, message: { role: "user", content: a.prompt } };
}

// A long message Rhodium typed into a terminal, which Claude took for a paste and wrapped whole in its
// tag (architecture §7.7, §10.5): with a source line first inside, as if not wrapped.
function unwrapped(said: string): string {
  const m = /^\s*<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>\s*$/.exec(said);
  return m && splitSource(m[1]!).source !== null ? m[1]! : said;
}

// Claude and pi both nest role and content in `message`.
function toEntry(offset: number, raw: string): Entry {
  const entry: Entry = { offset, raw };
  const v = parseObject(raw);
  if (!v) return entry;
  const msg = v.message && typeof v.message === "object" ? v.message : v;
  if (typeof v.type === "string") entry.type = v.type;
  if (typeof msg.role === "string") entry.role = msg.role;
  if (msg.content !== undefined) entry.content = msg.content;
  return entry;
}

// ---- Message blocks: the conversation as the board's page shows it (architecture §7.7). ----

/** A tool call's result. text: its text, only its start where length (the whole's) is given. media:
 *  the pictures it carries, by address (spec web-images "消息块里的图和 rh send 的话"). */
export type Result = { at: string; time: number | null; text: string; length?: number; error: boolean; media?: Media[] };
/** An rh send to you in a shell call (sendOf): where to, its text and its --file paths as written; and
 *  what it sent, by address, once the board has found its send_me event (spec web-images): none, text
 *  alone, [] then. Without it, it may never have run. */
export type Send = { to: string; text: string; files: string[]; media?: Media[] };
/** A local picture an agent's message shows, as checked (architecture §8.3): its copy, by address; why
 *  it did not pass; pending, a headless slot's block just written whose row the main loop has yet to
 *  write, or one whose copy could not be kept; gone, its copy pruned. */
export type LocalImage = Media | { why: string } | { pending: true } | { gone: true };
/** What an agent's message refers to on this machine, by path as decoded (src/local.ts): each picture's
 *  check, and whether each link gives a file to download, is a code reference, or neither. */
export type Local = { images: Record<string, LocalImage>; links: Record<string, "file" | "code" | "none"> };
type Body =
  /** id: what the agent's record names it by, where that is what Rhodium sent it as: Claude's uuid
   *  (frameUuid of its input's id), Codex's client_id (its input's id). media: what it carried, in
   *  place of the lines that say so at its end (architecture §8.3). */
  | { kind: "user"; text: string; source: string | null; id?: string; media?: Media[] }
  /** local: what it refers to on this machine, which the board adds. */
  | { kind: "assistant"; text: string; local?: Local }
  | { kind: "thinking"; text: string; length?: number }
  /** input: its arguments as JSON, only their start where length is given; shown: its name and argument
   *  as a detailed tool line has them; result: if on the same page; send: the rh send to you it runs. */
  | { kind: "tool"; id: string; name: string; input: string; length?: number; shown: Call; result: Result | null; send?: Send }
  /** The result of a call on another page, which it goes with by id. */
  | ({ kind: "result"; id: string } & Omit<Result, "at" | "time">)
  | { kind: "system"; title: string; text: string; length?: number };
/** A block of the conversation. at: where it is, the byte offset of its line, a dot, and its place
 *  among that line's blocks; time: when the line was written, a Codex call's when it began. */
export type Block = Body & { at: string; time: number | null };

/** Blocks a page gives, with where to read on from: back from start, forward from end. */
type MessagePage = { blocks: Block[]; start: number; end: number };

const CLIP = 2000; // characters of a tool's arguments or result, a thought or a system line a page gives
const MESSAGES = 20; // things you or the agent said on a page
const BLOCKS = 200; // blocks on a page

/** text, cut to its first max characters, with its whole length then. */
function clipped(text: string, max: number): { text: string; length?: number } {
  const head = text.length > max ? clip(text, max) : text;
  return head.length < text.length ? { text: head, length: text.length } : { text };
}

/** The text of a message's text blocks, or the content itself if it is text. */
const joined = (content: unknown) => texts(content).join("\n\n");

/** Where a page keeps the pictures tool results carry: the media dir, and the transcript file, by
 *  which with a block's place what was kept there is remembered. */
type Keep = { media: string; file: string };

/** The addresses of the pictures in the results read so far, by file and place (Keep): a line never
 *  changes once written, so each is decoded or copied once. */
// ponytail: grows by one entry, about 200 bytes, per result with pictures read since rhodium started; drop the oldest if that grows.
const kept = new Map<string, Media[]>();

/** The blocks of a transcript line, Claude's, pi's or Codex's: what you said, what the agent said and thought,
 *  its tool calls and their results, and the system lines worth a line (architecture §7.7's table).
 *  Other lines give none; one that is not a JSON object gives a system line. Tool calls' paths are
 *  shown relative to dir, the slot's. With keep, the pictures results carry are kept and given by
 *  address; without, none are. */
function blocksOf(offset: number, raw: string, max: number, dir: string, keep?: Keep): Block[] {
  const blocks: Block[] = [];
  const v = parseObject(raw);
  const time = typeof v?.timestamp === "string" ? Date.parse(v.timestamp) || null : null;
  const add = (b: Body, when = time) => blocks.push({ ...b, at: `${offset}.${blocks.length}`, time: when });
  // The pictures of the result about to be added, as find keeps them in the media dir; once a place,
  // but for one that could not be read or kept now (gone, the disk full), tried again next time.
  const pictures = (find: (media: string) => Media[]) => {
    if (!keep) return {};
    const key = `${keep.file}\0${offset}.${blocks.length}`;
    let found = kept.get(key);
    if (!found)
      try {
        kept.set(key, (found = find(keep.media)));
      } catch {
        found = [];
      }
    return found.length ? { media: found } : {};
  };
  const inlined = (content: unknown) => (list(content).some((c) => c?.type === "image") ? pictures((media) => decoded(content, media)) : {});
  if (!v) return add({ kind: "system", title: "看不懂的一行", ...clipped(raw, max) }), blocks;
  const msg = v.message && typeof v.message === "object" ? v.message : {};
  const items: any[] = Array.isArray(msg.content) ? msg.content : [];
  // Claude's lines go by type; pi's messages by role.
  switch (v.type === "message" ? msg.role : v.type) {
    case "user": {
      // Not yours: what Claude adds, as a skill's text or the summary of the conversation it compacted.
      if (v.isMeta || v.isCompactSummary) break;
      for (const r of items.filter((i) => i?.type === "tool_result")) {
        add({ kind: "result", id: String(r.tool_use_id), ...clipped(joined(r.content), max), error: r.is_error === true, ...inlined(r.content) });
      }
      const w = yourWords(msg);
      if (w === "interrupted") add({ kind: "system", title: "你打断了回合", text: "" });
      else if (w) add({ kind: "user", text: w.text, source: w.source, ...(w.media.length && { media: w.media }), ...(typeof v.uuid === "string" && { id: v.uuid }) });
      break;
    }
    case "assistant":
      for (const i of items) {
        if (i?.type === "text" && typeof i.text === "string" && i.text.trim()) add({ kind: "assistant", text: i.text });
        // Claude's are mostly empty.
        if (i?.type === "thinking" && typeof i.thinking === "string" && i.thinking.trim()) add({ kind: "thinking", ...clipped(i.thinking, max) });
        if (i?.type === "tool_use" || i?.type === "toolCall") {
          const given = i.input ?? i.arguments ?? {};
          const input = clipped(JSON.stringify(given, null, 2), max);
          const shown = shownCall(String(i.name), given, dir, false);
          const send = SHELLS.has(String(i.name)) && typeof given.command === "string" ? sendOf(given.command) : null;
          // Codex's is written with its result once it ends (fromCodex): when it began, by how long it ran.
          const began = time !== null && typeof i.took === "number" ? time - i.took : time;
          add({ kind: "tool", id: String(i.id), name: String(i.name), input: input.text, ...(input.length && { length: input.length }), shown, result: null, ...(send && { send }) }, began);
          if (i.output) add({ kind: "result", id: String(i.id), ...clipped(i.output.text, max), error: i.output.error, ...(i.name === "view_image" && pictures((media) => viewed(String(given.path), dir, media))) });
        }
      }
      break;
    case "toolResult":
      add({ kind: "result", id: String(msg.toolCallId), ...clipped(joined(msg.content), max), error: msg.isError === true, ...inlined(msg.content) });
      break;
    case "system": // pi's system prompt has no subtype
      if (v.subtype === "compact_boundary") add({ kind: "system", title: "压缩了对话", text: "" });
      if (v.subtype === "api_error") add({ kind: "system", title: "API 报错", ...clipped(String(v.error?.formatted ?? v.error?.message ?? ""), max) });
      if (v.subtype === "local_command") add({ kind: "system", title: "本地命令的输出", ...clipped(String(v.content ?? ""), max) });
      if (v.subtype === "turn_aborted") add({ kind: "system", title: "你打断了回合", text: "" }); // Codex's (fromCodex)
      break;
    case "compaction":
      add({ kind: "system", title: "压缩了对话", ...clipped(String(v.summary ?? ""), max) });
      break;
    case "model_change":
      add({ kind: "system", title: `换模型：${v.provider}/${v.modelId}`, text: "" });
      break;
  }
  return blocks;
}

/** What you said on a user line that is yours (not isMeta nor isCompactSummary), as its block has it:
 *  its words, the source line gone, and the files it carried; "interrupted" for Claude's note that you
 *  pressed Esc; null for none. Not what Claude writes in tags, as typedText skips: a task's notice, a
 *  slash command and its output, IDE context. What you pasted is in tags too, and is yours. */
// ponytail: text you typed starting with "<" is skipped too.
function yourWords(msg: any): "interrupted" | { text: string; source: string | null; media: Media[] } | null {
  const all = texts(msg.content);
  // Claude's note that you pressed Esc, alone on its line.
  if (all.length === 1 && /^\[Request interrupted by user( for tool use)?\]$/.test(all[0]!)) return "interrupted";
  const said = unwrapped(all.filter((t) => !/^\s*<(?!pasted_content\b)/.test(t)).join("\n\n"));
  if (!said.trim()) return null;
  const { source, text: body } = splitSource(said);
  const { text, media } = withoutMedia(body);
  return { text, source, media };
}

/** What you and the agent said on a line, parsed (parseObject), each as its block has it (architecture
 *  §7.10 "哪些字算正文"): your words, the agent's text. No tool call or result, thought, picture or
 *  metadata. */
function spoken(v: any): { role: "user" | "assistant"; text: string }[] {
  const msg = v.message && typeof v.message === "object" ? v.message : {};
  switch (v.type === "message" ? msg.role : v.type) {
    case "user": {
      const w = v.isMeta || v.isCompactSummary ? null : yourWords(msg);
      return w && w !== "interrupted" ? [{ role: "user", text: w.text }] : [];
    }
    case "assistant":
      return list(msg.content)
        .filter((i) => i?.type === "text" && typeof i.text === "string" && i.text.trim())
        .map((i) => ({ role: "assistant", text: i.text }));
  }
  return [];
}

/** The pictures in a tool result's content, Claude's image blocks with a base64 source and pi's with
 *  data, decoded and kept in media by their hash. */
function decoded(content: unknown, media: string): Media[] {
  return list(content).flatMap((c) => {
    const data = c?.type === "image" ? (c.source?.type === "base64" ? c.source.data : c.data) : undefined;
    return typeof data === "string" ? [{ kind: "image" as const, hash: basename(saveMedia(media, Buffer.from(data, "base64"))) }] : [];
  });
}

/** The biggest file Codex's view_image looked at that a page copies. */
const VIEWED_MAX = 50 * 2 ** 20;

/** The picture Codex's view_image looked at, copied into media by its hash (spec web-images "安全"):
 *  only a regular file whose real path, links followed, is in the slot's dir, and that is one of the
 *  four pictures by its first bytes. None for any other, whose path alone the page shows; throws for
 *  one gone. */
function viewed(path: string, dir: string, media: string): Media[] {
  const real = realpathSync(resolve(dir, path));
  if (!real.startsWith(join(realpathSync(dir), "/"))) return [];
  const s = statSync(real);
  if (!s.isFile() || s.size > VIEWED_MAX) return [];
  const data = readFileSync(real);
  return pictureType(data) ? [{ kind: "image", hash: basename(saveMedia(media, data)), name: basename(real) }] : [];
}

/** The tools that run a shell command: Claude's, pi's and Codex's. */
const SHELLS = new Set(["Bash", "bash", "exec_command"]);
/** A slot's id, which rh send takes for a slot as it does w/name. */
const SLOT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The first rh send to you in a shell command (spec web-images "消息块里的图和 rh send 的话"): the word
 *  after send, me, a platform's or a bot's name, and not a slot's, with a / or its id; its --file paths
 *  as written; and its text, its other words, read as the shell would, quoted or not, a here-document
 *  in $(cat <<EOF …) as one. null for a command with none. */
// ponytail: no $VAR nor $(…) but that one is expanded, and only the first rh send is read; parse the
// shell fully if agents write them otherwise.
export function sendOf(command: string): Omit<Send, "media"> | null {
  const flat = command
    .replace(/("?)\$\(cat\s*<<-?\s*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*\n?\s*\)\1/g, (...m) => `'${m[4].replaceAll("'", "'\\''")}'`)
    // Any other here-document is what a command reads, not commands: gone, the rest of its line kept.
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$3");
  const words = shellWords(flat);
  for (let i = 0; i + 2 < words.length; i++) {
    const [rh, send, to] = words.slice(i, i + 3);
    if (!(rh === "rh" || rh?.endsWith("/rh")) || send !== "send") continue;
    // A command's own words, not another's, as echo's.
    if (i > 0 && words[i - 1] !== null && !["then", "do", "else", "!", "{"].includes(words[i - 1]!)) continue;
    if (!to || to.includes("/") || SLOT_ID.test(to)) return null;
    const files: string[] = [];
    let j = i + 3;
    for (; words[j] === "--file" && words[j + 1]; j += 2) files.push(words[j + 1]!);
    const rest: string[] = [];
    for (; words[j] !== undefined && words[j] !== null; j++) rest.push(words[j]!);
    return { to, text: rest.join(" "), files };
  }
  return null;
}

/** A shell command's words as the shell reads them: quotes and backslashes undone, comments gone, null
 *  where an operator or a newline ends a command. */
function shellWords(s: string): (string | null)[] {
  const out: (string | null)[] = [];
  let w: string | null = null; // the word being read
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const close = (q: string, from: number) => (s.indexOf(q, from) < 0 ? s.length : s.indexOf(q, from));
    if (c === "\\") {
      if (s[i + 1] !== "\n") w = (w ?? "") + (s[i + 1] ?? "");
      i++;
    } else if (c === "'") {
      w = (w ?? "") + s.slice(i + 1, (i = close("'", i + 1)));
    } else if (c === "$" && s[i + 1] === "'") {
      // ANSI-C quoting: \n and \t, a backslash keeping the rest.
      let t = "";
      for (i += 2; i < s.length && s[i] !== "'"; i++) t += s[i] === "\\" ? ({ n: "\n", t: "\t" }[s[++i]!] ?? s[i] ?? "") : s[i];
      w = (w ?? "") + t;
    } else if (c === '"') {
      let t = "";
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] !== "\\" || !'"\\$`\n'.includes(s[i + 1] ?? "x")) t += s[i];
        else if (s[++i] !== "\n") t += s[i];
      }
      w = (w ?? "") + t;
    } else if (c === "#" && w === null) {
      i = close("\n", i) - 1; // a comment, to its line's end, which still ends a command
    } else if (c === " " || c === "\t" || ";&|()<>\n".includes(c)) {
      // A file descriptor's number against a redirection, as 2 in 2>&1, is no word.
      if (w !== null && !("<>".includes(c) && /^\d+$/.test(w))) out.push(w);
      w = null;
      if (c !== " " && c !== "\t") out.push(null);
    } else w = (w ?? "") + c;
  }
  if (w !== null) out.push(w);
  return out;
}

/** Each result goes with its call on the page, if that is there. */
function paired(blocks: Block[]): Block[] {
  const calls = new Map(blocks.flatMap((b) => (b.kind === "tool" ? [[b.id, b] as const] : [])));
  return blocks.filter((b) => {
    if (b.kind !== "result") return true;
    const call = calls.get(b.id);
    if (!call || call.result) return true;
    const { kind, id, ...result } = b;
    call.result = result;
    return false;
  });
}

/**
 * A page of the conversation in file, as blocks: back from byte offset at ("backward"; Infinity for
 * the end of the file), or forward from it, up to MESSAGES things you or the agent said with the
 * blocks between them, BLOCKS at most. at must be 0, Infinity, or a start or end of an earlier page.
 * Pages end at lines: only one line with more than BLOCKS blocks is a page with more. dir: the slot's.
 * media: the media dir, where the pictures tool results carry are kept; without it, none are given.
 */
export async function messagePage(file: string, at: number, direction: "forward" | "backward", dir: string, media?: string): Promise<MessagePage> {
  const lines: Block[][] = [];
  let [messages, count] = [0, 0];
  let [start, end] = [at, at];
  read: for (let pos = at, first = true; ; first = false) {
    const page = await readPage(file, pos, 50, direction);
    if (direction === "backward" && first) [start, end] = [page.end, page.end];
    for (const e of direction === "forward" ? page.entries : page.entries.toReversed()) {
      const blocks = blocksOf(e.offset, e.raw, CLIP, dir, media ? { media, file } : undefined);
      const m = blocks.filter((b) => b.kind === "user" || b.kind === "assistant").length;
      if (count && (messages + m > MESSAGES || count + blocks.length > BLOCKS)) {
        if (direction === "forward") end = e.offset;
        break read;
      }
      lines.push(blocks);
      [messages, count] = [messages + m, count + blocks.length];
      if (direction === "backward") start = e.offset;
    }
    if (direction === "forward") end = pos = page.end;
    else start = pos = page.start;
    if (!page.entries.length || (direction === "backward" && page.start === 0)) break;
  }
  if (direction === "backward") lines.reverse();
  return { blocks: paired(lines.flat()), start, end };
}

const LAST = 200; // characters of the last thing said that lastSaid gives

/** The last thing you or the agent said in file, as a page has it, and when: on one line, without
 *  Markdown's marks for headings, bold, code, links and pictures, cut to LAST characters; a user message's
 *  source too, as its source line names it, and whether it quotes. null if neither has said anything.
 *  Reads back from the end only as far as that. */
export async function lastSaid(file: string): Promise<(Message & { at: number | null; source?: string; quoted?: true }) | null> {
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 50, "backward");
    for (const e of page.entries.toReversed()) {
      const b = blocksOf(e.offset, e.raw, CLIP, "").findLast((b): b is Extract<Block, { kind: Message["role"] }> => b.kind === "user" || b.kind === "assistant");
      // What your message carried, after its words (architecture §7.7).
      const carried = b?.kind === "user" ? (b.media ?? []).map((m) => (m.kind === "image" ? " [图片]" : " [文件]")).join("") : "";
      // Under a quote, your words, as the queue shows them (#607); with none, what it carried, else
      // the quote's start, as the queue shows it.
      const q = b?.kind === "user" ? quoteOf(b.text) : null;
      const words = q ? q.rest.trim() || (carried ? "" : plain(q.quote)) : (b?.text ?? "");
      const text = b && oneLine(words.replace(/^ {0,3}#{1,6}\s+/gm, "").replace(/\*\*|`/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") + carried);
      if (b && text) return { role: b.kind, text: clip(text, LAST, "…"), at: b.time, ...(b.kind === "user" && b.source && { source: b.source }), ...(q && { quoted: true as const }) };
    }
    if (page.start === 0 || !page.entries.length) return null;
    at = page.start;
  }
}

/** Whether a user message's source line names you, as the board's list has it (architecture §7.7):
 *  none, or not another slot's (槽位 …) nor Rhodium's own (a report, a confirm's result). */
export const fromYou = (source: string | null | undefined) => !/^(槽位 |Rhodium)/.test(source ?? "");

/** Gives take what you said in file (fromYou), newest first, as your words alone: no source line,
 *  quote or files; till take says it has enough, or past deadline (ms since the epoch). Reads back
 *  from the end only as far as that. Says whether take wants more. */
export async function yoursSaid(file: string, take: (words: string) => boolean, deadline: number): Promise<boolean> {
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 50, "backward");
    for (const e of page.entries.toReversed()) {
      for (const b of blocksOf(e.offset, e.raw, Infinity, "").toReversed()) {
        if (b.kind !== "user" || !fromYou(b.source)) continue;
        const words = (quoteOf(b.text)?.rest ?? b.text).trim();
        if (words && !take(words)) return false;
      }
    }
    if (Date.now() > deadline) return false;
    if (page.start === 0 || !page.entries.length) return true;
    at = page.start;
  }
}

/** What Claude ran the newest turn in file on, by the turn's first reply of the agent's own (not a
 *  subagent's): its effort level and full model id. Later replies may be at the level of a skill the
 *  turn loaded, and a turn begun with a slash command, which may start a skill, is passed over. Of
 *  the turns since `since` (ms since the epoch) with ultracode on or off as the newest marker since
 *  then says, if one does ("after"); or of those before it ("before"). Nothing for what no line tells
 *  (architecture §10.1). */
export async function claudeSettings(file: string, since: number, side: "after" | "before"): Promise<Used> {
  let first: any; // the turn's earliest reply walked back to so far
  let found: any;
  let ultra: boolean | undefined;
  const told = () => ({
    ...(found && { effort: found.effort, ...(typeof found.requestedModel === "string" && { model: found.requestedModel }) }),
    ...(ultra !== undefined && { ultra }),
  });
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 100, "backward");
    for (const e of page.entries.toReversed()) {
      let v: any;
      try {
        v = JSON.parse(e.raw);
      } catch {
        continue;
      }
      const t = Date.parse(v?.timestamp); // NaN for lines without one, which count on neither side
      if (side === "after" && t < since) return told();
      const marker = v?.type === "attachment" && v.attachment?.type;
      if (side === "after" && ultra === undefined && (marker === "ultra_effort_enter" || marker === "ultra_effort_exit")) ultra = marker === "ultra_effort_enter";
      if (!found && !v?.isSidechain) {
        if (v?.type === "assistant" && typeof v.effort === "string") {
          if (side === "after" || t < since) first = v;
        } else if (v?.type === "user" && !v.isMeta && !v.isCompactSummary) {
          // Claude's own user lines are passed over, as in blocksOf: a skill's text, the summary of a compaction midway.
          const results = Array.isArray(v.message?.content) && v.message.content.some((b: any) => b?.type === "tool_result");
          // A prompt you typed began the turn; a slash command's line, or Claude's output for one, did not.
          if (typedText(v.message?.content) !== undefined) found = first;
          if (!results) first = undefined;
        }
      }
      if (found && (side === "before" || ultra !== undefined)) return told();
    }
    if (page.start === 0 || !page.entries.length) return told();
    at = page.start;
  }
}

/** What pi ran on in file, by its newest change lines, which pi writes only on a real change: the
 *  thinking level, and the model as provider/modelId. Not a reply's model, which under a virtual model
 *  is the one it ran on, while pi resumes the model_change's. Of the lines since `since` (ms since the
 *  epoch, "after"), or of those before it ("before"); or the oldest of those since ("first"), what pi
 *  started a new session there on. Nothing for what no line tells (architecture §6.3). */
// ponytail: file order, not the parentId chain: wrong only once you branch with /tree in the terminal; walk the chain if that matters.
export async function piSettings(file: string, since: number, side: "after" | "before" | "first"): Promise<Used> {
  const told: Used = {};
  const first = side === "first";
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 100, "backward");
    for (const e of page.entries.toReversed()) {
      const v = parseObject(e.raw);
      const t = Date.parse(v?.timestamp); // NaN for lines without one, which count on neither side
      if (side !== "before" && t < since) return told;
      if (!(side === "before" ? t < since : t >= since)) continue;
      if (v?.type === "thinking_level_change" && (first || told.effort === undefined) && typeof v.thinkingLevel === "string") told.effort = v.thinkingLevel;
      if (v?.type === "model_change" && (first || told.model === undefined) && typeof v.provider === "string" && typeof v.modelId === "string") told.model = `${v.provider}/${v.modelId}`;
      if (!first && told.effort !== undefined && told.model !== undefined) return told;
    }
    if (page.start === 0 || !page.entries.length) return told;
    at = page.start;
  }
}

/** What Codex ran the newest turn in file on: its model and level, from the settings line it writes
 *  as each turn starts (turn_context, architecture §6.4). Of the turns since `since` (ms since the
 *  epoch, "after"), or of those before it ("before"). Nothing for what no line tells. */
export async function codexSettings(file: string, since: number, side: "after" | "before"): Promise<Used> {
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 100, "backward");
    for (const e of page.entries.toReversed()) {
      const v = parseObject(e.raw);
      if (v?.type !== "turn_context") continue;
      const t = Date.parse(v.timestamp);
      if (side === "after" && !(t >= since)) return {};
      if (side === "before" && !(t < since)) continue;
      const { model, effort } = v.payload ?? {};
      return { ...(typeof model === "string" && { model }), ...(typeof effort === "string" && { effort }) };
    }
    if (page.start === 0 || !page.entries.length) return {};
    at = page.start;
  }
}

/** What a transcript says of its context and, Codex's, of the quota (architecture §7.11): the context of
 *  the newest answer's request, none once compacted after it; the limit only where the file has it
 *  (Codex's). rateLimits: the bucket of Codex's newest token_count, no older than its newest answer's,
 *  named as account/rateLimits/read names one. at: the line's time, ms. */
export type TranscriptMeter = {
  context?: { usedTokens: number; maxTokens: number | null; at: number };
  rateLimits?: { bucket: Record<string, unknown>; at: number };
};

const num = (v: unknown) => (typeof v === "number" ? v : 0);
/** A Codex rate_limits window as account/rateLimits/read has it. */
const codexWindow = (w: any) => w && { usedPercent: w.used_percent, windowDurationMins: w.window_minutes, resetsAt: w.resets_at };

/** What file, the agent's transcript, says of its context and quota, read back from its end (TranscriptMeter). */
export async function meterIn(file: string, agent: AgentKind): Promise<TranscriptMeter> {
  const found: TranscriptMeter = {};
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 100, "backward");
    for (const e of page.entries.toReversed()) {
      let v: any;
      try {
        v = JSON.parse(e.raw);
      } catch {
        continue;
      }
      const time = Date.parse(v?.timestamp);
      if (agent === "codex") {
        const p = v?.type === "event_msg" && v.payload?.type === "token_count" ? v.payload : undefined;
        if (!p) continue;
        const r = p.rate_limits;
        if (!found.rateLimits && r) {
          const c = r.credits;
          const bucket = { limitId: r.limit_id ?? "codex", primary: codexWindow(r.primary), secondary: codexWindow(r.secondary), ...(c && { credits: { hasCredits: c.has_credits, balance: c.balance } }) };
          found.rateLimits = { bucket, at: time };
        }
        // Stop at the newest answer's count: a quota older than it is stale, and on an API key, where no
        // line has one, going on would read the whole file on every change to it.
        const last = p.info?.last_token_usage;
        if (last) return { ...found, context: { usedTokens: num(last.total_tokens), maxTokens: p.info.model_context_window ?? null, at: time } };
        continue;
      }
      // A compaction since the newest answer: what that answer carried is no longer what the context holds.
      if (v?.type === "compaction" || (v?.type === "system" && v.subtype === "compact_boundary")) return found;
      const m = v?.message;
      const u = m?.role === "assistant" ? m.usage : undefined;
      // pi's errored and aborted answers carry no real count, as pi's own getAssistantUsage holds.
      if (!u || v.isSidechain || m.model === "<synthetic>" || m.stopReason === "error" || m.stopReason === "aborted") continue;
      const used = agent === "claude" ? num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens) : (u.totalTokens ?? num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite));
      if (!used) continue;
      return { context: { usedTokens: used, maxTokens: null, at: time } };
    }
    if (page.start === 0 || !page.entries.length) return found;
    at = page.start;
  }
}

/** The whole text of the block at `at` in file, where a page gives only its start: a tool call's
 *  arguments, a result, a thought, a system line. null if there is no block there. */
export async function fullText(file: string, at: string): Promise<string | null> {
  const [offset, i] = at.split(".").map(Number) as [number, number];
  const [e] = (await readPage(file, offset, 1, "forward")).entries;
  const b = e?.offset === offset ? blocksOf(offset, e.raw, Infinity, "")[i] : undefined; // no dir: only the text is wanted
  return !b ? null : b.kind === "tool" ? b.input : b.text;
}

export interface Conversation {
  id: string;
  agent: AgentKind;
  file: string;
  startedAt: Date;
  modifiedAt: Date;
  /** What the /resume list calls it (architecture §6.3, §7.7): pi's latest session name, or Codex's
   *  thread name, else the opening of the first message the user typed, on one line; "" if there is none. */
  title: string;
}

const OPENING = 100; // characters of the first user message kept

/** How each agent keeps its transcripts. root: the folder, given HOME, with them all; folder: the
 *  folder under it of the conversations started in an absolute dir, if it keeps one per directory;
 *  idOf: the session id of a file; glob: the files under root of the ids starting with prefix; named:
 *  it names a conversation with lines of its own, the last one counting (describe); nameOf: the name it
 *  keeps for one apart from its file; settings: what it ran on. */
type Format = {
  root: (home: string) => string;
  folder: ((dir: string) => string) | null;
  idOf: (file: string) => string;
  glob: (prefix: string) => string;
  named: boolean;
  nameOf?: (id: string) => Promise<string | undefined>;
  settings: (file: string, since: number, side: "after" | "before") => Promise<Used>;
};

// Read HOME on every call (os.homedir() caches it) so tests can point it elsewhere.
const userHome = () => process.env.HOME || homedir();
const codexHome = (home: string) => process.env.CODEX_HOME || join(home, ".codex");

const FORMATS: Record<AgentKind, Format> = {
  claude: {
    root: (home) => join(home, ".claude/projects"),
    folder: (dir) => claudeProjectDir(dir),
    idOf: (file) => basename(file, ".jsonl"),
    glob: (prefix) => `*/${prefix}*.jsonl`,
    named: false,
    settings: claudeSettings,
  },
  // pi names files "<created>_<session id>.jsonl", in --<dir with / as ->--.
  pi: {
    root: (home) => join(home, ".pi/agent/sessions"),
    folder: (dir) => `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    idOf: (file) => basename(file, ".jsonl").replace(/^[^_]*_/, ""),
    glob: (prefix) => `*/*_${prefix}*.jsonl`,
    named: true,
    settings: piSettings,
  },
  // Codex files go by the day they began, not by directory: $CODEX_HOME/sessions/YYYY/MM/DD/
  // rollout-<local time>-<thread id>.jsonl, whose first line says where (architecture §6.4).
  codex: {
    root: (home) => join(codexHome(home), "sessions"),
    folder: null,
    idOf: (file) => basename(file, ".jsonl").slice(-36),
    glob: (prefix) => `*/*/*/rollout-????-??-??T??-??-??-${prefix}*.jsonl`,
    named: false,
    nameOf: codexName,
    settings: codexSettings,
  },
};

/** The name Codex keeps for thread id, the newest: a line in $CODEX_HOME/session_index.jsonl each time
 *  it is named (codex-cli 0.162.1; its terminal names its threads itself). Its records have none. */
// ponytail: reads the whole index, a short line a name; read it from its end if it grows large.
async function codexName(id: string): Promise<string | undefined> {
  return (await codexNames(id)).get(id);
}

/** The names Codex keeps for its threads, the newest of each, by thread id: of only the one that has
 *  id, if given. */
async function codexNames(id?: string): Promise<Map<string, string>> {
  const index = await Bun.file(join(codexHome(userHome()), "session_index.jsonl"))
    .text()
    .catch(() => ""); // none yet
  const names = new Map<string, string>();
  for (const line of index.split("\n")) {
    const v = !id || line.includes(id) ? parseObject(line) : undefined;
    const name = typeof v?.thread_name === "string" && oneLine(v.thread_name);
    if (typeof v?.id === "string" && (!id || v.id === id)) name ? names.set(v.id, name) : names.delete(v.id);
  }
  return names;
}

/** What the agent ran on in its transcript file, of the lines since `since` or before it: claudeSettings, piSettings, codexSettings. */
export const settingsIn = (agent: AgentKind, file: string, since: number, side: "after" | "before"): Promise<Used> => FORMATS[agent].settings(file, since, side);

/** Every agent's conversations started in `dir`, most recently modified first. */
export async function listConversations(dir: string): Promise<Conversation[]> {
  dir = resolve(dir);
  const files = await Promise.all((Object.keys(FORMATS) as AgentKind[]).map(async (agent) => (await startedThere(dir, agent)).map((file) => describe(file, agent, FORMATS[agent].idOf(file)))));
  const list = await Promise.all(files.flat().map((p) => p.catch(gone)));
  return list.filter((c) => c !== undefined).sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/** undefined for a file deleted (Claude cleans up old ones) after it was listed. */
function gone(e: any): undefined {
  if (e?.code === "ENOENT") return undefined;
  throw e;
}

/** The agent's transcripts of the conversations started in the absolute dir: its folder's; for Codex,
 *  its files whose first line says so, but a subagent's, which is part of its parent's thread, as
 *  Claude's subagents' files are not in the folder. */
// ponytail: reads the first line of each of Codex's files at each look; keep them by mtime if that gets slow.
async function startedThere(dir: string, agent: AgentKind): Promise<string[]> {
  const f = FORMATS[agent];
  if (f.folder) return jsonlFiles(join(f.root(userHome()), f.folder(dir)));
  const heads = await Promise.all(
    (await globbed(agent, "")).map(async (file) => {
      const [first] = (await readPage(file, 0, 1, "forward").catch(gone))?.entries ?? [];
      const head = first && parseObject(first.raw);
      return head?.type === "session" && head.cwd === dir && !head.subagent ? file : undefined;
    }),
  );
  return heads.filter((h) => h !== undefined);
}

/** The agent's transcript file of conversation id, started in dir; null if there is none. Codex's, by
 *  its id alone, which no other directory's thread has. */
export async function transcriptFile(dir: string, agent: AgentKind, id: string): Promise<string | null> {
  const f = FORMATS[agent];
  const files = f.folder ? await jsonlFiles(sessionsDir(resolve(dir), agent)) : await globbed(agent, id);
  return files.find((file) => f.idOf(file) === id) ?? null;
}

/** The transcripts of the conversations whose id starts with prefix (hex digits and "-" only), in
 *  whatever directory each was started: every agent's, each with its agent and full id. */
export async function findConversations(prefix: string): Promise<{ agent: AgentKind; id: string; file: string }[]> {
  if (!/^[0-9a-f-]+$/i.test(prefix)) throw new Error(`not a conversation id: ${prefix}`); // no glob syntax
  const found: { agent: AgentKind; id: string; file: string }[] = [];
  for (const agent of Object.keys(FORMATS) as AgentKind[]) for (const file of await globbed(agent, prefix)) found.push({ agent, id: FORMATS[agent].idOf(file), file });
  return found;
}

/** The agent's transcripts of the ids starting with prefix, which has no glob syntax, in any directory. */
async function globbed(agent: AgentKind, prefix: string): Promise<string[]> {
  const f = FORMATS[agent];
  const files: string[] = [];
  try {
    for await (const file of new Bun.Glob(f.glob(prefix)).scan({ cwd: f.root(userHome()), absolute: true })) files.push(file);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e; // the agent has none at all
  }
  return files;
}

/** Whether the agent has a transcript of conversation id, in whatever directory it was started. */
export async function hasTranscript(agent: AgentKind, id: string): Promise<boolean> {
  return (await findConversations(id)).some((c) => c.agent === agent && c.id === id);
}

/** The directory the conversation in file was started in: the first cwd its lines record, as
 *  Claude's lines and pi's session header do. Not the name of its directory, which Claude cuts short. */
export async function startedIn(file: string): Promise<string | null> {
  for (let at = 0; ; ) {
    const page = await readPage(file, at, 100, "forward");
    if (!page.entries.length) return null;
    for (const e of page.entries) {
      const cwd = parseObject(e.raw)?.cwd;
      if (typeof cwd === "string") return cwd;
    }
    at = page.end;
  }
}

/** Where the agent keeps the transcripts of conversations started in the (absolute) dir: Codex, all of them in one. */
export function sessionsDir(dir: string, agent: AgentKind): string {
  return join(FORMATS[agent].root(userHome()), FORMATS[agent].folder?.(dir) ?? "");
}

export type Message = { role: "user" | "assistant"; text: string };

/**
 * The last `count` messages of the agent's session started in dir, oldest first: what the agent
 * was told and what it replied, each on one line and cut to `max` characters. Tool calls and
 * results, and what Claude records beside them, are left out. None if there is no transcript yet.
 */
export async function recentMessages(dir: string, agent: AgentKind, session: string, count: number, max: number): Promise<Message[]> {
  const file = await transcriptFile(dir, agent, session);
  const out: Message[] = [];
  try {
    for (let at = Infinity; file && out.length < count; ) {
      const page = await readPage(file, at, 100, "backward");
      for (const e of page.entries.reverse()) {
        const m = message(e, max);
        if (m && out.length < count) out.unshift(m);
      }
      if (page.start === 0 || !page.entries.length) break;
      at = page.start;
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  return out;
}

function message(e: Entry, max: number): Message | undefined {
  if ((e.type !== "user" && e.type !== "assistant" && e.type !== "message") || (e.role !== "user" && e.role !== "assistant")) return;
  const text = e.role === "assistant" ? oneLine(texts(e.content).join(" ")) : parseObject(e.raw)?.isMeta ? undefined : typedText(e.content, true);
  return text ? { role: e.role, text: clip(text, max, "…") } : undefined;
}

// As Claude Code 2.1 names ~/.claude/projects/<dir>: long names are cut and
// suffixed with a hash of the full path.
function claudeProjectDir(dir: string): string {
  const name = dir.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let h = 0;
  for (let i = 0; i < dir.length; i++) h = ((h << 5) - h + dir.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(dir, e.name));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** The conversation in file, as the /resume list has it. */
export async function describe(file: string, agent: AgentKind, id: string): Promise<Conversation> {
  const modifiedAt = (await stat(file)).mtime;
  let startedAt: Date | undefined;
  let first: string | undefined;
  // A session name, as pi's set with /name and renamed at will: the last one counts, so it reads to the end.
  let name = await FORMATS[agent].nameOf?.(id);
  const named = FORMATS[agent].named;
  for (let at = 0; startedAt === undefined || first === undefined || named; ) {
    const page = await readPage(file, at, 100, "forward");
    if (page.entries.length === 0) break;
    at = page.end;
    for (const e of page.entries) {
      if (named && e.type === "session_info") {
        const n = parseObject(e.raw)?.name;
        if (typeof n === "string") name = oneLine(n) || undefined;
        continue;
      }
      const typed = first === undefined && e.role === "user" && (e.type === "user" || e.type === "message");
      if (startedAt !== undefined && !typed) continue;
      const v = parseObject(e.raw);
      if (startedAt === undefined && typeof v?.timestamp === "string") startedAt = new Date(v.timestamp);
      if (typed && !v?.isMeta) first = typedText(e.content);
    }
  }
  const title = name ?? (first && clip(first, OPENING));
  return { id, agent, file, startedAt: startedAt ?? modifiedAt, modifiedAt, title: title ?? "" };
}

/** The text blocks of a message's content, or the content itself if it is text. */
const texts = (content: unknown): string[] =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string)
      : [];
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

// The text of a user message if a person typed it. Claude also records slash
// commands, command output, notices and IDE context as user messages, or as
// text blocks beside the typed one, wrapped in tags. Text the user pasted is
// wrapped too, in <pasted_content id="…"> … </pasted_content id="…">, and is kept.
// The source line Rhodium starts a message with is not typed, so it goes, unless
// source: rh read shows where each message came from (architecture §6.1).
// ponytail: typed text that itself starts with "<" is skipped too.
function typedText(content: unknown, source = false): string | undefined {
  const line = texts(content)
    .map((t) => oneLine((source ? t : withoutSource(t)).replace(/<\/?pasted_content\b[^>]*>/g, " ")))
    .filter((t) => !t.startsWith("<"))
    .join(" ");
  return line || undefined;
}

// ---- What the import list shows of a conversation, and searching it (architecture §7.10). ----

/** What the board keeps of a transcript file it read, by its path: how far it read, and the file's size
 *  and time of change then; the sources of its title; how many things you and the agent said; the git
 *  branch it was on; what you last said, on one line, and the start of the agent's last reply; the
 *  directory it was started in, and for Codex whether it is a subagent's. */
type Summary = {
  read: number;
  size: number;
  mtime: number;
  custom?: string;
  ai?: string;
  named?: string;
  first?: string;
  count: number;
  branch?: string;
  you?: string;
  reply?: string;
  cwd?: string;
  subagent?: boolean;
};

// ponytail: about 1KB a file read, never dropped; drop the least used if thousands of files make it big.
const summaries = new Map<string, Summary>();

const MB = 1 << 20;
const YOU = 200; // characters of what you last said kept
const REPLY = 400; // characters of the start of the agent's last reply kept
/** How Claude's metadata lines start (api-request, last-prompt, its titles…); what you and it said start {"parentUuid". */
const META = Buffer.from('{"type":"');

/** Calls fn with each complete line of file from byte offset from, and its offset, till fn says stop
 *  (true). Gives the offset just past the last line read. Throws once signal aborts, checked before
 *  each block. */
async function eachLine(file: string, from: number, fn: (line: Buffer, at: number) => boolean | void, signal?: AbortSignal): Promise<number> {
  const fh = await open(file, "r");
  try {
    let carry = Buffer.alloc(0);
    let at = from; // where carry starts
    for (let pos = from; ; ) {
      if (signal?.aborted) throw signal.reason;
      const buf = Buffer.alloc(MB);
      const { bytesRead } = await fh.read(buf, 0, MB, pos);
      if (!bytesRead) return at;
      pos += bytesRead;
      const all = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let nl = all.indexOf(NL); nl !== -1; nl = all.indexOf(NL, start)) {
        if (fn(all.subarray(start, nl), at + start)) return at + nl + 1;
        start = nl + 1;
      }
      carry = Buffer.from(all.subarray(start));
      at += start;
    }
  } finally {
    await fh.close();
  }
}

/** Takes in one line of agent's transcript into s. */
function takeIn(s: Summary, agent: AgentKind, line: Buffer): void {
  // Claude's metadata, but its titles, unparsed: api-request lines carry the whole history.
  if (agent === "claude" && line.subarray(0, META.length).equals(META) && !/^\{"type":"(ai|custom)-title"/.test(line.toString("latin1", 0, 30))) return;
  const v = parseObject(line.toString("utf8"));
  if (!v) return;
  if (s.cwd === undefined && typeof v.cwd === "string") s.cwd = v.cwd;
  if (v.type === "session" && v.subagent) s.subagent = true;
  // Claude's on most lines, HEAD when detached; Codex's on its first.
  if (typeof v.gitBranch === "string" || (v.type === "session" && typeof v.branch === "string")) s.branch = v.gitBranch ?? v.branch;
  if (v.type === "custom-title" && typeof v.customTitle === "string") s.custom = oneLine(v.customTitle) || undefined;
  if (v.type === "ai-title" && typeof v.aiTitle === "string") s.ai = oneLine(v.aiTitle) || undefined;
  if (v.type === "session_info" && typeof v.name === "string") s.named = oneLine(v.name) || undefined;
  for (const m of spoken(v)) {
    s.count++;
    if (m.role === "assistant") s.reply = clip(m.text.trim(), REPLY, "…");
    const words = m.role === "user" && oneLine(m.text);
    if (!words) continue;
    s.first ??= clip(words, OPENING, "…");
    s.you = clip(words, YOU, "…");
  }
}

/** The summary of agent's transcript file, read on from where it was last read if the file only grew,
 *  else afresh. Throws for a file that cannot be read, and once signal aborts, keeping nothing read. */
async function summaryOf(file: string, agent: AgentKind, signal?: AbortSignal): Promise<Summary> {
  const { size, mtimeMs } = await stat(file);
  let s = summaries.get(file);
  if (!s || size < s.size || mtimeMs < s.mtime) s = { read: 0, size: 0, mtime: 0, count: 0 };
  if (size !== s.size || mtimeMs !== s.mtime) {
    const n: Summary = { ...s, size, mtime: mtimeMs };
    n.read = await eachLine(file, s.read, (line) => takeIn(n, agent, line), signal);
    s = n;
  }
  summaries.set(file, s);
  return s;
}

/** Files known to have something you or the agent said; of the others, the size and time of change they had when found with none. */
const spoke = new Map<string, true | string>();

/** Whether agent's transcript file has something you or the agent said, read only as far as the first:
 *  the folder's counts (GET /api/folder) need no more. */
async function hasMessage(file: string, agent: AgentKind): Promise<boolean> {
  if (spoke.get(file) === true || (summaries.get(file)?.count ?? 0) > 0) return true;
  const { size, mtimeMs } = await stat(file);
  const stamp = `${size} ${mtimeMs}`;
  if (spoke.get(file) === stamp) return false;
  let found = false;
  const s: Summary = { read: 0, size: 0, mtime: 0, count: 0 };
  await eachLine(file, 0, (line) => (takeIn(s, agent, line), (found = s.count > 0)));
  spoke.set(file, found || stamp);
  return found;
}

/** A conversation's title as the import list has it (architecture §7.10): Claude's /rename name, else
 *  the one it gave it; pi's session name; Codex's thread name (named); else what you said first. */
const titleOf = (s: Summary, named?: string) => s.custom ?? s.ai ?? s.named ?? named ?? s.first ?? "";

/** text with ASCII letters lower-cased, its length kept: search is blind to their case alone. */
const fold = (text: string) => text.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** Where a full-text search hit, in what you or the agent said: about 30 characters before the words
 *  and 60 after, on one line, … where cut; the words from from to to. */
export type Hit = { text: string; from: number; to: number };

/** The bit of text around words at, length n long, that a hit shows. */
export function hitIn(text: string, at: number, n: number): Hit {
  const [from, to] = [Math.max(0, at - 30), Math.min(text.length, at + n + 60)];
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const before = (from > 0 ? "…" : "") + flat(text.slice(from, at)).trimStart();
  const words = flat(text.slice(at, at + n));
  return { text: before + words + flat(text.slice(at + n, to)).trimEnd() + (to < text.length ? "…" : ""), from: before.length, to: before.length + words.length };
}

/** Finds the bytes of the words, as written in a JSON string, in a block of lines: a function giving
 *  where, from an offset on, -1 for nowhere. Any hit may be in the wrong case, or in no message: a
 *  sieve for what is checked after. */
function sieve(words: string): (block: Buffer, from: number) => number {
  const raw = Buffer.from(JSON.stringify(words).slice(1, -1));
  const bytes = raw.toString("latin1");
  // No ASCII letter, as most Chinese words: the bytes themselves.
  if (!/[A-Za-z]/.test(bytes)) return (block, from) => block.indexOf(raw, from);
  // The longest run with no letter, of three bytes at least (a Chinese character): those bytes.
  const run = bytes.split(/[A-Za-z]+/).reduce((a, b) => (b.length > a.length ? b : a));
  if (run.length >= 3) {
    const part = Buffer.from(run, "latin1");
    return (block, from) => block.indexOf(part, from);
  }
  // Letters and short marks: a regex blind to case over the block read as latin1, a byte a character.
  const re = new RegExp(bytes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let text = "";
  let of: Buffer | null = null;
  return (block, from) => {
    if (of !== block) [of, text] = [block, block.toString("latin1")];
    re.lastIndex = from;
    return re.exec(text)?.index ?? -1;
  };
}

/** Where words are in what you or the agent said in agent's transcript file, the first place: the bit
 *  around them, or null for none. Reads it 1MB at a time, giving way between them; stops once signal
 *  aborts. A sieve first, then the line it hit is parsed and its messages searched. */
async function hitInFile(file: string, agent: AgentKind, words: string, signal?: AbortSignal): Promise<Hit | null> {
  const find = sieve(words);
  const folded = fold(words);
  const fh = await open(file, "r");
  try {
    let carry = Buffer.alloc(0);
    for (let pos = 0; ; ) {
      if (signal?.aborted) throw signal.reason;
      const buf = Buffer.alloc(MB);
      const { bytesRead } = await fh.read(buf, 0, MB, pos);
      if (!bytesRead) return null;
      pos += bytesRead;
      const all = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = all.lastIndexOf(NL) + 1; // complete lines; the rest waits for the next block
      const block = all.subarray(0, end);
      carry = Buffer.from(all.subarray(end));
      for (let i = find(block, 0); i !== -1; ) {
        const start = block.lastIndexOf(NL, i) + 1;
        const nl = block.indexOf(NL, i);
        i = find(block, nl + 1);
        if (agent === "claude" && block.subarray(start, start + META.length).equals(META)) continue;
        const v = parseObject(block.toString("utf8", start, nl));
        for (const m of v ? spoken(v) : []) {
          const at = fold(m.text).indexOf(folded);
          if (at !== -1) return hitIn(m.text, at, words.length);
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    await fh.close();
  }
}

/** A conversation as the import list has it: its id and file; the directory it was started in, if its
 *  record says; its title, when it last changed, how many things you and the agent said, its branch,
 *  what you last said and the start of the agent's last reply; where a search hit the words in a
 *  message. */
export type Listed = { id: string; file: string; dir?: string; title: string; at: number; count: number; branch?: string; you?: string; reply?: string; hit?: Hit };

/** A search: its words, trimmed, and whether it looks in what was said too, not only the title. */
export type Search = { words: string; full: boolean };

/** agent's conversation in file as listed, if search (if any) finds it; else null. names: Codex's
 *  thread names. */
export async function listed(file: string, agent: AgentKind, search?: Search, names?: Map<string, string>, signal?: AbortSignal): Promise<Listed | null> {
  const s = await summaryOf(file, agent, signal);
  const id = FORMATS[agent].idOf(file);
  const title = titleOf(s, names?.get(id));
  let hit: Hit | null = null;
  if (search && !fold(title).includes(fold(search.words)) && !(search.full && (hit = await hitInFile(file, agent, search.words, signal)))) return null;
  const branch = s.branch === "HEAD" ? undefined : s.branch;
  return { id, file, title, at: s.mtime, count: s.count, ...(s.cwd && { dir: s.cwd }), ...(branch && { branch }), ...(s.you && { you: s.you }), ...(s.reply && { reply: s.reply }), ...(hit && { hit }) };
}

/** How many conversations an import list page has. */
const PAGE = 10;

/** A page of agent's conversations to import (architecture §7.10): started in the absolute dir, or in
 *  any directory with no dir; with something said, not one skip names, found by search if any; the
 *  newest first. From after cursor, a page's own, on. Stops past budget ms with what it has found,
 *  partial then, having looked at one file at least; on signal aborting, throws. cursor: where the next
 *  page starts, while there are more files. */
export async function importable(
  agent: AgentKind,
  o: { dir?: string; search?: Search; cursor?: string; skip: (id: string) => boolean; signal?: AbortSignal; budget?: number },
): Promise<{ list: Listed[]; cursor?: string; partial?: true }> {
  const until = Date.now() + (o.budget ?? 2_000);
  const paths = o.dir ? await startedThere(o.dir, agent) : await globbed(agent, "");
  const files = (await Promise.all(paths.map(async (file) => ({ file, mtime: (await stat(file).catch(gone))?.mtimeMs }))))
    .filter((f): f is { file: string; mtime: number } => f.mtime !== undefined)
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const [mtime, after] = o.cursor ? [Number(o.cursor.slice(0, o.cursor.indexOf(" "))), o.cursor.slice(o.cursor.indexOf(" ") + 1)] : [Infinity, ""];
  const rest = files.filter((f) => f.mtime < mtime || (f.mtime === mtime && f.file > after));
  const names = agent === "codex" ? await codexNames() : undefined;
  const list: Listed[] = [];
  const cursor = (f: { file: string; mtime: number }) => `${f.mtime} ${f.file}`;
  for (const [i, f] of rest.entries()) {
    if (list.length === PAGE) return { list, cursor: cursor(rest[i - 1]!) };
    if (o.signal?.aborted) throw o.signal.reason;
    if (!o.skip(FORMATS[agent].idOf(f.file))) {
      const c = await listed(f.file, agent, o.search, names, o.signal).catch(gone);
      // A Codex subagent's thread is its parent's (startedThere leaves it out of a directory's).
      if (c && c.count > 0 && !summaries.get(f.file)?.subagent) list.push(c);
    }
    if (Date.now() > until && i + 1 < rest.length) return { list, cursor: cursor(f), partial: true };
  }
  return { list };
}

/** How many of agent's conversations started in the absolute dir have something said and are not ones
 *  skip names, and when the newest last changed, as GET /api/folder has them. None for none. */
export async function conversationsIn(dir: string, agent: AgentKind, skip: (id: string) => boolean): Promise<{ count: number; at: number } | undefined> {
  let [count, at] = [0, 0];
  for (const file of await startedThere(dir, agent)) {
    if (skip(FORMATS[agent].idOf(file))) continue;
    const mtime = await stat(file).then((s) => s.mtimeMs, gone);
    if (mtime === undefined || !(await hasMessage(file, agent).catch(gone))) continue;
    [count, at] = [count + 1, Math.max(at, mtime)];
  }
  return count ? { count, at } : undefined;
}
