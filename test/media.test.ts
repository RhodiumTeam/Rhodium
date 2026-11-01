// Seam one: pictures, files and quotes from you reach the agent, and the agent's rh send me --file
// reaches you (product §5.4, architecture §8.3). Most tests run once on a QQ-like and once on a
// Telegram-like fake bot.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Injection } from "../src/fake-im";
import { imageType } from "../src/media";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, PROGRESS_PIECES, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

const ME = "you-id";
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let rhodium: Instance;
afterEach(() => rhodium?.cleanup()); // once only: a test without a rhodium leaves the last one's, cleaned

const LIKES = ["qq", "telegram"] as const;
type Like = (typeof LIKES)[number];

/** A rhodium whose bot b, QQ-like or Telegram-like, sends your messages to slot w/a. */
async function bot(like: Like, opts: InstanceOptions = {}): Promise<Daemon> {
  rhodium = newInstance({ bots: { b: { like, owner: ME, target: "w/a" } }, ...opts });
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  return daemon;
}

const say = (m: Omit<Injection, "chat" | "sender">) => rhodium.im.inject("b", { chat: ME, sender: ME, ...m });

/** Waits until the slot is idle again after your n-th message has had its turn. */
async function answered(n: number): Promise<void> {
  await until(() => frames().length >= n, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
}

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
/** The content of each user frame the fake claude was given, in order. */
const frames = (): Block[][] =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => m.message.content);
/** A frame's text, without the source line. */
const textOf = (content: Block[]) => withoutSource(content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
/** What is kept under state/media. */
const kept = () => (existsSync(join(rhodium.dir, "state/media")) ? readdirSync(join(rhodium.dir, "state/media")) : []);

for (const like of LIKES) {
  test(`stories 35, 36 (${like}): a picture you send reaches the agent as an image block, stored by its content`, async () => {
    await bot(like);
    await say({ text: "what is on this screen?", attachments: [{ kind: "image", name: "screen.png", data: PNG }] });
    await answered(1);

    const [content] = frames();
    expect(content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    const text = textOf(content!);
    expect(text).toContain("what is on this screen?");
    // Where it is kept, so the agent can use it again; the file is named by its hash.
    const path = /\[图片\] (\/\S+)/.exec(text)?.[1];
    expect(path).toBe(join(rhodium.dir, "state/media", new Bun.CryptoHasher("sha256").update(PNG).digest("hex")));
    expect(readFileSync(path!)).toEqual(PNG);
  }, 30_000);

  test(`story 35 (${like}): a file you send reaches the agent as a local path holding the same bytes, named by its hash whatever the platform calls it`, async () => {
    await bot(like);
    const csv = Buffer.from("name,count\nwicks,12\n");
    const other = Buffer.from("not the password file");
    await say({
      text: "sum the counts",
      attachments: [
        { kind: "file", name: "../../../.bashrc", data: csv },
        { kind: "file", name: "/etc/passwd", data: other },
      ],
    });
    await answered(1);

    const text = textOf(frames()[0]!);
    expect(text).toStartWith("sum the counts\n");
    const paths = [...text.matchAll(/^\[文件\] (.+)：(\/\S+)$/gm)].map((m) => [m[1], m[2]]);
    const hashed = (data: Buffer) => join(rhodium.dir, "state/media", new Bun.CryptoHasher("sha256").update(data).digest("hex"));
    expect(paths).toEqual([
      ["../../../.bashrc", hashed(csv)],
      ["/etc/passwd", hashed(other)],
    ]);
    expect(readFileSync(hashed(csv))).toEqual(csv);
    expect(readFileSync(hashed(other))).toEqual(other);
    expect(readdirSync(join(rhodium.dir, "state/media")).sort()).toEqual([basename(hashed(csv)), basename(hashed(other))].sort());
  }, 30_000);

  test(`${like}: a stranger's pictures and files are never kept`, async () => {
    await bot(like);
    const junk = { text: "look", attachments: [{ kind: "image" as const, name: "x.png", data: PNG }, { kind: "file" as const, name: "big.bin", data: Buffer.from("junk") }] };
    await rhodium.im.inject("b", { chat: "stranger", sender: "stranger", ...junk });
    // Yours after it, so the stranger's has been routed by the time yours reaches the agent.
    await say({ text: "hello" });
    await answered(1);

    expect(frames().map(textOf)).toEqual(["hello"]);
    expect(kept()).toEqual([]);
  }, 30_000);

  test(`${like}: an attachment that fails to download is logged by Rhodium's bot and chat, never the platform's ids: the board shows the log`, async () => {
    const daemon = await bot(like);
    await say({ text: "hello" });
    await answered(1);
    await say({ text: "this", attachments: [{ kind: "file", name: "a.bin", data: Buffer.from(""), fail: "HTTP 500" }] });
    await answered(2);

    expect(textOf(frames()[1]!)).toBe("this\n[文件没收到：a.bin，HTTP 500]");
    const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
    const chat = db.query<{ id: string }, []>("SELECT id FROM chat").get()!.id;
    db.close();
    expect(daemon.logs.filter((l) => l.msg === "download failed")).toEqual([{ msg: "download failed", bot: "b", chat, error: "HTTP 500" }]);
    expect(JSON.stringify(daemon.logs)).not.toContain(ME);
  }, 30_000);

  test(`story 35 (${like}): quoting a reply that streamed in, by its reference alone, the agent gets the whole reply`, async () => {
    await bot(like, { claude: { script: "progress-pause" } });
    await say({ text: "go" });
    await answered(1);
    // Telegram edits one message to the end; QQ sends it whole once the agent has said it all.
    const shown = PROGRESS_PIECES.join("").trimEnd();
    await until(async () => (await rhodium.im.log("b", ME)).at(-1)?.text === shown, 15_000); // the last edit is paced
    const [first] = await rhodium.im.log("b", ME);
    await say({ text: "and this?", quote: { ref: first!.messageId } });
    await answered(2);
    expect(textOf(frames()[1]!)).toBe(`${shown.replace(/^/gm, "> ")}\n\nand this?`);
  }, 30_000);

  test(`story 35 (${like}): quoting your old message, or Rhodium's reply, the agent gets the quoted text`, async () => {
    await bot(like);
    // Telegram brings the quoted text along; QQ gives only a reference, and Rhodium finds the text.
    const quote = (ref: string, text: string) => (like === "telegram" ? { ref, text } : { ref });
    const first = await say({ text: "the secret word is plum" });
    await answered(1);
    const [reply] = await rhodium.im.log("b", ME);
    expect(reply!.text).toBe("fake reply");

    await say({ text: "what did I say?", quote: quote(first.messageId, "the secret word is plum") });
    await answered(2);
    await say({ text: "and you?", quote: quote(reply!.messageId, "fake reply") });
    await answered(3);
    await say({ text: "and this?", quote: quote("no-such-message", "lost to time") });
    await answered(4);

    const [, mine, yours, unknown] = frames().map(textOf);
    expect(mine).toBe("> the secret word is plum\n\nwhat did I say?");
    expect(yours).toBe("> fake reply\n\nand you?");
    expect(unknown).toBe(like === "telegram" ? "> lost to time\n\nand this?" : "> （找不到引用的原文）\n\nand this?");
  }, 30_000);

  test(`${like}: a file rh send me --file took goes out as it was, though the agent deletes it the moment rh returns`, async () => {
    // The text first: on Telegram the file then waits its turn under the chat's rate limit.
    const script: Script = { on, steps: [...startTurn, { rh: ["send", "me", "--file", "notes.txt", "the notes"] }, { rm: "notes.txt" }, ...endTurn("done"), { goto: 0 }] };
    await bot(like, { claude: { script } });
    const notes = Buffer.from("12 wicks\n");
    writeFileSync(join(rhodium.dir, "w/notes.txt"), notes);
    await say({ text: "send me the notes" });
    await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.file), 15_000);

    const posts = await rhodium.im.log("b", ME);
    expect(posts.flatMap((p) => (p.file ? [{ ...p.file, data: Buffer.from(p.file.data, "base64") }] : []))).toEqual([{ kind: "file", name: "notes.txt", data: notes }]);
  }, 30_000);

  test(`${like}: rh send me --file of a file over the platform's limit, or of none, fails and sends nothing`, async () => {
    const calls = [
      ["send", "me", "--file", "huge.png"],
      ["send", "me", "--file", "huge.bin", "the dump"],
      ["send", "me", "--file", "missing.txt"],
    ];
    const script: Script = { on, steps: [...startTurn, ...calls.map((rh) => ({ rh })), ...endTurn("done"), { goto: 0 }] };
    await bot(like, { claude: { script } });
    // Sparse, so as big as that on paper only: over QQ's and Telegram's limits alike.
    for (const [name, size] of [["huge.png", 31 * 2 ** 20], ["huge.bin", 101 * 2 ** 20]] as const) {
      writeFileSync(join(rhodium.dir, "w", name), "");
      truncateSync(join(rhodium.dir, "w", name), size);
    }
    await say({ text: "send me the dumps" });
    await until(async () => (await rhodium.im.log("b", ME)).length >= 1, 15_000);
    await answered(1);

    const [run] = rhodium.claude.runs();
    expect(run!.rh.map((c) => [c.code, c.out])).toEqual(calls.map(() => [1, ""]));
    expect(run!.rh[0]!.err).toMatch(/huge\.png 有 31\.0MB，超过了平台对图片的上限/);
    expect(run!.rh[1]!.err).toMatch(/huge\.bin 有 101\.0MB，超过了平台对文件的上限/);
    expect(run!.rh[2]!.err).toContain("找不到文件");
    // So the turn's own reply is all that came, the text with the refused file included.
    expect((await rhodium.im.log("b", ME)).map((p) => p.text)).toEqual(["done"]);
  }, 30_000);
}

// Picture or file is the platform-neutral router's call; telegram.test.ts uploads each kind through the real adapter.
test("story 44: the agent's rh send me --file sends a picture as a picture and anything else as a file", async () => {
  const script: Script = {
    on,
    steps: [
      ...startTurn,
      // Paths are the agent's own, relative to its directory.
      { rh: ["send", "me", "--file", "chart.png"] },
      { rh: ["send", "me", "--file", "notes.txt", "here are the notes"] },
      ...endTurn("done"),
      { goto: 0 },
    ],
  };
  await bot("qq", { claude: { script } });
  const notes = Buffer.from("12 wicks\n");
  writeFileSync(join(rhodium.dir, "w/chart.png"), PNG);
  writeFileSync(join(rhodium.dir, "w/notes.txt"), notes);
  await say({ text: "send me the chart and the notes" });
  await until(async () => (await rhodium.im.log("b", ME)).length >= 3, 15_000);

  const [run] = rhodium.claude.runs();
  expect(run!.rh.map((c) => [c.code, c.err])).toEqual([[0, ""], [0, ""]]);
  const posts = (await rhodium.im.log("b", ME)).slice(0, 3);
  expect(posts.map((p) => ({ text: p.text, file: p.file && { ...p.file, data: Buffer.from(p.file.data, "base64") } }))).toEqual([
    { text: "", file: { kind: "image", name: "chart.png", data: PNG } },
    { text: "here are the notes", file: undefined },
    { text: "", file: { kind: "file", name: "notes.txt", data: notes } },
  ]);
}, 30_000);

test("a picture with a side over 8000 pixels, which Claude's API turns down, is shown to no agent: it goes as a path", () => {
  const png = (width: number, height: number) => {
    const d = Buffer.from(PNG);
    d.writeUInt32BE(width, 16);
    d.writeUInt32BE(height, 20);
    return d;
  };
  // Start of image, an APP0 segment, then a baseline frame header with its height and width.
  const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3]);
  const gif = (width: number, height: number) => Buffer.from([...Buffer.from("GIF89a"), width & 255, width >> 8, height & 255, height >> 8]);
  expect([png(1080, 8000), png(1080, 8001), png(8001, 10)].map(imageType)).toEqual(["image/png", null, null]);
  expect([jpeg(1080, 8000), jpeg(1080, 12000)].map(imageType)).toEqual(["image/jpeg", null]);
  expect([gif(8000, 1), gif(9000, 1)].map(imageType)).toEqual(["image/gif", null]);
});

test("a picture captioned ! goes to the agent: it is not /stop", async () => {
  await bot("qq");
  await say({ text: "!", attachments: [{ kind: "image", name: "screen.png", data: PNG }] });
  await answered(1);

  expect(frames()[0]).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
}, 30_000);

test("story 36: a picture you send to a pi slot reaches pi in its prompt's images", async () => {
  rhodium = newInstance({ bots: { b: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await say({ text: "what is on this screen?", attachments: [{ kind: "image", name: "screen.png", data: PNG }] });
  await until(async () => (await rhodium.im.log("b", ME)).length >= 1, 15_000);

  const prompts = rhodium.pi.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l))).filter((m) => m.type === "prompt");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(withoutSource(prompts[0].message)).toStartWith("what is on this screen?\n[图片] ");
}, 30_000);
