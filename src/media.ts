// Pictures and files (architecture §8.3). What comes in is kept under the state dir, named by
// its content's hash: the platform's file name is only ever a label, never part of a path.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { InboundMessage } from "./contracts";

/** Writes data to <dir>/<sha256 hex> unless it is there already, and returns that path. One there
 *  already is stored again: it is kept as long again from now (architecture §7.8). */
export function saveMedia(dir: string, data: Uint8Array): string {
  const path = join(dir, new Bun.CryptoHasher("sha256").update(data).digest("hex"));
  if (existsSync(path)) {
    const now = new Date();
    utimesSync(path, now, now);
  } else writeWhole(path, data);
  return path;
}

/** Writes data to path whole or not at all: a crash mid-write must not leave a truncated file under its name. */
function writeWhole(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The copy of a picture being made now: copies are made one at a time, each when the one before is
 *  done, so a small server's memory does not jump (spec web-images "媒体接口"). */
let making: Promise<unknown> = Promise.resolve();

/** Keeps at to the copy make gives, made once the one being made is done; to, or null if make gives
 *  none or fails. One there by then, asked for twice at once, is not made again. */
export function makeCopy(to: string, make: () => Promise<Uint8Array | null>): Promise<string | null> {
  const made = making.then(async () => {
    if (existsSync(to)) return to;
    const bytes = await make();
    if (!bytes) return null;
    writeWhole(to, bytes);
    return to;
  });
  making = made.catch(() => {});
  return made.catch(() => null);
}

/** A picture with more pixels than this is not decoded to make a copy of it: some 256 MB at 4 bytes a pixel. */
// ponytail: one cap, about a 64 MP photo; lower it if a small server runs short as one is made.
export const MAX_PIXELS = 1 << 26;

/** The longest side a picture goes to an agent with: Claude's, past which its servers shrink it anyway. */
const AGENT_SIDE = 2576;

/** Where the picture kept at path goes to an agent from (architecture §8.3): one with a side over
 *  AGENT_SIDE, a copy shrunk to that, in its own format (a GIF's first frame as a PNG), kept beside it
 *  under agent/ by the same hash; else, or where that copy comes out no smaller, or the picture has
 *  more than MAX_PIXELS, the picture itself. */
export async function forAgent(path: string): Promise<string> {
  const to = join(dirname(path), "agent", basename(path));
  if (existsSync(to)) return to;
  const sides = await new Bun.Image(path, { maxPixels: MAX_PIXELS }).metadata().catch(() => null);
  if (!sides || Math.max(sides.width, sides.height) <= AGENT_SIDE) return path;
  const made = await makeCopy(to, async () => {
    const bytes = await new Bun.Image(path, { maxPixels: MAX_PIXELS }).resize(AGENT_SIDE, AGENT_SIDE, { fit: "inside" }).bytes();
    return bytes.length < statSync(path).size ? bytes : null;
  });
  return made ?? path;
}

// Claude takes these four as image blocks; anything else goes to the agent as a file.
const MAGIC: [string, (d: Uint8Array) => boolean][] = [
  ["image/png", (d) => d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47],
  ["image/jpeg", (d) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff],
  ["image/gif", (d) => d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46],
  ["image/webp", (d) => Buffer.from(d.subarray(0, 4)).toString() === "RIFF" && Buffer.from(d.subarray(8, 12)).toString() === "WEBP"],
];

/** Bigger than this (about 5 MB in base64, the API's limit) a picture goes as a file the agent can Read. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** The API turns down a picture with a side longer than this; so might every later turn that resends it. */
const MAX_SIDE = 8000;

/** A picture's media type by its first bytes alone, whatever its size: one of the four in MAGIC; null
 *  for anything else, which the board serves as a download (spec web-images "安全"). */
export const pictureType = (data: Uint8Array): string | null => MAGIC.find(([, is]) => is(data))?.[0] ?? null;

/** The media type an agent can be shown this picture as, from its first bytes; null if it can't. */
export function imageType(data: Uint8Array): string | null {
  if (data.length > MAX_IMAGE_BYTES) return null;
  const type = pictureType(data);
  // ponytail: WebP's sides are not read (three header layouts); add them if WebPs that tall turn up.
  if (type === null || type === "image/webp") return type;
  const s = sides(data);
  return s && Math.max(...s) <= MAX_SIDE ? type : null;
}

/** A PNG's, GIF's or JPEG's width and height from its header; null if it can't be read. */
function sides(d: Uint8Array): number[] | null {
  const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  try {
    if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)]; // IHDR
    if (b[0] === 0x47) return [b.readUInt16LE(6), b.readUInt16LE(8)];
    // JPEG: segment after segment up to the frame header, SOF0 to SOF15 less DHT, JPG and DAC.
    for (let i = 2; b[i] === 0xff; i += 2 + b.readUInt16BE(i + 2)) {
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
  } catch {} // cut short
  return null;
}

/** Downloads a message's attachments one at a time, stores them and notes where each went; a
 *  picture the agent can be shown gets its media type. One that fails to download is named in the
 *  text instead; one that can't be stored is logged and left without a path. log says which message:
 *  the platform's ids stay out of the log, which the board shows. */
export async function storeAttachments(dir: string, m: InboundMessage, log: (msg: string, f: Record<string, unknown>) => void): Promise<InboundMessage> {
  if (!m.attachments?.length) return m;
  let text = m.text;
  const attachments: NonNullable<InboundMessage["attachments"]> = [];
  for (const a of m.attachments) {
    let data: Uint8Array;
    try {
      data = await a.fetch();
    } catch (err) {
      const why = String((err as Error)?.message ?? err);
      log("download failed", { error: why });
      // Telegram's Bot API hands over files up to 20 MB only.
      text += `${text && "\n"}[${a.kind === "image" ? "图片" : "文件"}没收到：${a.name ? `${a.name}，` : ""}${why}]`;
      continue;
    }
    try {
      const mimeType = a.kind === "image" ? imageType(data) : null;
      attachments.push({ ...a, path: saveMedia(dir, data), ...(mimeType && { mimeType }) });
    } catch (err) {
      log("cannot store an attachment", { error: String(err) });
      attachments.push(a);
    }
  }
  return { ...m, text, attachments };
}

/** How an attachment shows in the text the agent gets, and in the text kept for quotes. */
export function mediaLine(a: { kind: "image" | "file"; name?: string; path?: string }): string {
  const where = a.path ?? "（没存下来）";
  return a.kind === "image" ? `[图片] ${where}` : `[文件] ${a.name ?? "（没有名字）"}：${where}`;
}

/** A picture or file in a message block (spec web-images "消息块里的图和 rh send 的话"): its kind, its
 *  content's SHA-256, which is its address on the board (GET /api/media), the name it came with, and a
 *  picture's width and height where they can be read. Never its bytes. */
export type Media = { kind: "image" | "file"; hash: string; name?: string; w?: number; h?: number };

/** A line mediaLine wrote for a kept file, read back; null for any other line. */
function mediaOf(line: string): Media | null {
  // A file's name is all before the last ：, its path all after it.
  const m = /^(?:\[图片\] |\[文件\] (.*)：).*\/([0-9a-f]{64})$/.exec(line);
  return !m ? null : m[1] === undefined ? { kind: "image", hash: m[2]! } : { kind: "file", hash: m[2]!, name: m[1] };
}

/** A message's words without the lines mediaLine wrote for what it carries kept, which end it; how
 *  many those are, and what each is. */
export function withoutMedia(body: string): { text: string; files: number; media: Media[] } {
  const lines = body.split("\n");
  const media: Media[] = [];
  for (let m; lines.length && (m = mediaOf(lines.at(-1)!)); lines.pop()) media.unshift(m);
  return { text: lines.join("\n"), files: media.length, media };
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** What rh send --file sends a path as: a picture by its extension, else a file. */
export const fileKind = (path: string): "image" | "file" => (IMAGE_EXT.has(extname(path).toLowerCase()) ? "image" : "file");

/** Copies the regular file at path into dir by its hash, so what goes out is what it holds now,
 *  whatever becomes of it later. null if there is no such file. One over max bytes is not copied:
 *  only its size comes back. */
export function keepFile(dir: string, path: string, max: number): { size: number; path?: string } | null {
  let data: Uint8Array;
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    if (s.size > max) return { size: s.size }; // never read: it may not fit in memory
    data = readFileSync(path);
  } catch {
    return null;
  }
  // It may have grown since.
  return data.length > max ? { size: data.length } : { size: data.length, path: saveMedia(dir, data) };
}
