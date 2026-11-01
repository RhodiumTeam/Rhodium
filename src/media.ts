// Pictures and files (architecture §8.3). What comes in is kept under the state dir, named by
// its content's hash: the platform's file name is only ever a label, never part of a path.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { InboundMessage } from "./contracts";

/** Writes data to <dir>/<sha256 hex> unless it is there already, and returns that path. */
export function saveMedia(dir: string, data: Uint8Array): string {
  const path = join(dir, new Bun.CryptoHasher("sha256").update(data).digest("hex"));
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Whole or not at all: a crash mid-write must not leave a truncated file under the hash.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
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

/** The media type an agent can be shown this picture as, from its first bytes; null if it can't. */
export function imageType(data: Uint8Array): string | null {
  if (data.length > MAX_IMAGE_BYTES) return null;
  const type = MAGIC.find(([, is]) => is(data))?.[0] ?? null;
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

/** A message's words without the lines mediaLine wrote for what it carries kept, which end it; and how
 *  many those are. */
export function withoutMedia(body: string): { text: string; files: number } {
  const lines = body.split("\n");
  let n = lines.length;
  while (n > 0 && /^\[(图片|文件)\] .*\/[0-9a-f]{64}$/.test(lines[n - 1]!)) n--;
  return { text: lines.slice(0, n).join("\n"), files: lines.length - n };
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
