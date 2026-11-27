// The local pictures and file links in what an agent said, on this machine's disk (architecture §8.3
// "回复里的本机图片和文件链接"): what a message refers to, the one path check, and the reply picture table,
// where each picture is checked once, its copy kept, by the main loop as the message is whole or by
// the board as it reads a block with no row.
import fs, { openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { codeRef, decoded, elsewhere, inPage, linkWords } from "./local";
import { driveRoot, insideDirectory, localCandidate, localDrivePath } from "./paths";
import { keepFile, pictureType } from "./media";
import { fenced } from "./render";
import type { ReplyImage, Tx } from "./store";

/** What a message refers to on this machine. path: as decoded (src/local.ts). code: a link to a line,
 *  only words. words: a picture's words or a link's name, as written. */
export type LocalRef = { kind: "image" | "link" | "code"; path: string; words: string };

// A code span, else a picture or link: its target in angle brackets or with no space, a title maybe after it.
// ponytail: no nested brackets in the words, no bare parentheses in the target, no reference-style links;
// the page's Markdown library has them all. Such a picture has no result and shows as its words.
// Nor a character reference in the target (&amp;), nor a fence opened on a list item's own line (src/render.ts fenced).
const REFS = /(`+)[\s\S]*?(?<!`)\1(?!`)|(!?)\[((?:[^\[\]\\\n]|\\.)*)\]\(\s*(<(?:[^<>\\\n]|\\.)*>|(?:[^()<\s\\]|\\.)+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** The local pictures and links in what an agent said, in order, outside its code, and the text with
 *  each as to writes it: not the addresses elsewhere nor the links to a place in the page
 *  (src/local.ts), told by the target as Markdown gives it, its angle brackets off and its backslash
 *  escapes undone. */
function scan(text: string, to?: (r: LocalRef) => string): { refs: LocalRef[]; text: string } {
  const refs: LocalRef[] = [];
  let open: string | null = null;
  const lines = text.split("\n").map((line) => {
    const was = open;
    open = fenced(open, line);
    if (was !== null || open !== null) return line;
    return line.replace(REFS, (whole: string, code?: string, bang?: string, words?: string, at?: string) => {
      if (code || at === undefined) return whole;
      const target = at.replace(/^<([\s\S]*)>$/, "$1").replace(/\\([!-/:-@[-`{-~])/g, "$1");
      if (!target || elsewhere(target) || (!bang && inPage(target))) return whole;
      const path = decoded(target);
      const ref: LocalRef = { kind: bang ? "image" : codeRef(path) ? "code" : "link", path, words: words! };
      refs.push(ref);
      return to ? to(ref) : whole;
    });
  });
  return { refs, text: lines.join("\n") };
}

/** The local pictures and links in what an agent said, in order. */
export const localRefs = (text: string): LocalRef[] => scan(text).refs;

/** What an agent said as it goes to IM, before it is rendered or cut up (architecture §8.3): a local
 *  picture is its words, or its file's name with none; a local link, or a code reference, its name
 *  and path (linkWords). Again until nothing changes, for a link around a picture; so text rewritten
 *  already, as a turn's message that grows, stays as it is. */
export function forIm(text: string): string {
  const once = scan(text, (r) => (r.kind === "image" ? r.words || basename(r.path) : linkWords(r.words, r.path))).text;
  return once === text ? text : forIm(once);
}

/** The biggest file a reply's picture or link gives. */
export const MAX_LOCAL = 50 << 20;

/** Why a path did not pass the check, as the page and IM say it. */
export type Why = "不在槽位目录或 /tmp 里" | "找不到文件" | "不是图片" | "超过 50MB";

/** The path check, the one for pictures and links, the page and IM: the path, as decoded, a file://
 *  off it, ~/ the home of rhodium's user, a relative one from the slot's directory dir, is a regular
 *  file of at most MAX_LOCAL whose real path, symlinks resolved, is inside dir's or /tmp's (the local temp directory on Windows); as a
 *  picture, one of the four kinds by its first bytes. real: that real path, to read. */
export function checkLocal(dir: string, path: string, image: boolean): { real: string } | { why: Why } {
  const windows = process.platform === "win32";
  let target = path.replace(/^file:\/\//i, "");
  if (windows && /^file:\/\//i.test(path)) {
    // A local file URL has an empty authority and a drive, e.g. file:///C:/work.
    if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1);
    if (!driveRoot.test(target)) return { why: "不在槽位目录或 /tmp 里" };
  }
  target = target.replace(windows ? /^~(?=[\\/])/ : /^~(?=\/)/, () => homedir());
  const candidate = localCandidate(dir, target);
  if (!candidate) return { why: "不在槽位目录或 /tmp 里" };
  let real: string;
  let size: number;
  const head = Buffer.alloc(12);
  try {
    real = fs.realpathSync(candidate);
    if (windows && !driveRoot.test(localDrivePath(real))) return { why: "不在槽位目录或 /tmp 里" };
    const s = fs.statSync(real);
    if (!s.isFile()) return { why: "找不到文件" };
    size = s.size;
  } catch {
    return { why: "找不到文件" };
  }
  const inside = [dir, windows ? tmpdir() : "/tmp"].some((root) => {
    if (windows && !driveRoot.test(root)) return false;
    try {
      const base = fs.realpathSync(root);
      return insideDirectory(base, real);
    } catch {
      return false;
    }
  });
  if (!inside) return { why: "不在槽位目录或 /tmp 里" };
  if (size > MAX_LOCAL) return { why: "超过 50MB" };
  if (!image) return { real };
  try {
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { why: "找不到文件" };
  }
  return pictureType(head) ? { real } : { why: "不是图片" };
}

/** How far the main loop's row may be from when its block was written: it checks as the message is
 *  whole, a little after. Within it a headless slot's block with no row waits for the main loop. */
export const NEAR = 60_000;

/** The row of a block written at time, among the rows of its conversation and path: the board's own
 *  for just that time, else the main loop's nearest it, within NEAR. The board's go by the very time,
 *  or the later of two blocks close together would take the earlier one's row and never be checked. */
export function rowFor(rows: ReplyImage[], time: number | null): ReplyImage | undefined {
  const own = rows.find((r) => r.by === "board" && r.at === time);
  if (own || time === null) return own;
  const far = (r: ReplyImage) => Math.abs(r.at! - time);
  return rows.filter((r) => r.by === "loop" && r.at !== null && far(r) <= NEAR).sort((a, b) => far(a) - far(b))[0];
}

/** Checks the picture at path now and keeps a copy of one that passes in media by its hash: what its
 *  row says; null for one that passed whose copy could not be kept, a full disk say, which gets no row
 *  and is checked again next time. */
function looked(media: string, dir: string, path: string): Pick<ReplyImage, "hash" | "why" | "name"> | null {
  const name = basename(path);
  const ok = checkLocal(dir, path, true);
  if ("why" in ok) return { hash: null, why: ok.why, name };
  try {
    const kept = keepFile(media, ok.real, MAX_LOCAL);
    if (!kept) return { hash: null, why: "找不到文件", name };
    return kept.path ? { hash: basename(kept.path), why: null, name: basename(ok.real) } : { hash: null, why: "超过 50MB", name };
  } catch {
    return null;
  }
}

/** The main loop's, as an agent's message is whole: checks each local picture in it once and writes
 *  its row, at now. Says whether it wrote any, which the board tells the pages waiting for them. */
export function saidPictures(tx: Tx, media: string, conversation: string, text: string, now: number): boolean {
  const paths = new Set(localRefs(text).flatMap((r) => (r.kind === "image" ? [r.path] : [])));
  const slot = paths.size ? tx.get("conversation", conversation)?.slot : undefined;
  const dir = slot && tx.get("slot", slot)?.dir;
  if (!dir) return false;
  let wrote = false;
  for (const path of paths) {
    const found = looked(media, dir, path);
    if (found) wrote = !!tx.insert("replyImage", { conversation, path, at: now, by: "loop", ...found });
  }
  return wrote;
}

/** The board's, as it reads a block written at time with a local picture that has no row: checks it
 *  now and writes its row, at the block's time. The row there by then, as another page's that read it
 *  at once, is the answer, and this check's is dropped. null: its copy could not be kept. */
export function readPicture(tx: Tx, media: string, dir: string, conversation: string, path: string, time: number | null): ReplyImage | null {
  const found = looked(media, dir, path);
  return found && (rowFor(tx.find("replyImage", { conversation, path }), time) ?? tx.insert("replyImage", { conversation, path, at: time, by: "board", ...found }));
}

/** What a turn's end is given of a local picture in its final reply, for IM: why it did not pass the
 *  check, or its copy in media, how big, and the file's name. */
export type Checked = { why: Why } | { copy: string; size: number; name: string };

/** The main loop's, as a turn ends with reply: each local picture in it, by its path, as checked. last:
 *  the agent's message last written whole and when it was checked (saidPictures): the same text, its
 *  rows are the answer, so IM sends the copies the page shows; else the reply is checked now, with
 *  rows of its own. A picture with no row, its copy not kept, is left out. */
export function replyPictures(tx: Tx, media: string, conversation: string, reply: string, last: { text: string; at: number } | undefined, now: number): Record<string, Checked> {
  const paths = new Set(localRefs(reply).flatMap((r) => (r.kind === "image" ? [r.path] : [])));
  if (!paths.size) return {};
  const same = last?.text === reply;
  const at = same ? last!.at : now;
  if (!same) saidPictures(tx, media, conversation, reply, now);
  const found: Record<string, Checked> = {};
  for (const path of paths) {
    const row = tx.find("replyImage", { conversation, path }).find((r) => r.by === "loop" && r.at === at);
    if (!row) continue;
    try {
      found[path] = row.hash ? { copy: join(media, row.hash), size: statSync(join(media, row.hash)).size, name: row.name } : { why: row.why as Why };
    } catch {
      // The copy is gone: as one not kept.
    }
  }
  return found;
}
