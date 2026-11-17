// The local pictures and file links of what an agent says, on their way to IM (stories 595-597;
// architecture §8.3, docs/im-style.md §3.6): rewritten before rendering and cutting up; the final
// reply's pictures after it, a message each, with a line for each one that did not go.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { AgentEvent, Capabilities } from "../src/contracts";
import { feishuCapabilities, QQ_CAPABILITIES, TELEGRAM_CAPABILITIES } from "../src/platforms";
import { forIm, replyPictures, saidPictures, type Checked } from "../src/reply-images";
import { append, edit, finish, start, type View } from "../src/render";
import { route, type Ctx, type Decision, type Payload, type State } from "../src/router";
import { openStore, type Bot, type Chat, type Slot } from "../src/store";
import { endTurn, on, saying, startTurn, toolCall } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-reply-pictures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n[bots.q]\nplatform = "qq"\n[bots.t]\nplatform = "telegram"\n[bots.f]\nplatform = "feishu"\n`, { mode: 0o600 });
const CONFIG = loadConfig(join(dir, "config.toml"));
const CAPS: Record<string, Capabilities> = { q: QQ_CAPABILITIES, t: TELEGRAM_CAPABILITIES, f: feishuCapabilities(1000) };

test("stories 596, 597: a local picture leaves its words, a local link its name and path; addresses elsewhere, places in the page and code stay as written", () => {
  expect(forIm("登录页改好了：![登录页截图](/tmp/login.png)\n\n改动在 [auth.ts](src/auth.ts) 里，入口是 [登录函数](src/auth.ts#L42)。")).toBe(
    "登录页改好了：登录页截图\n\n改动在 src/auth.ts 里，入口是 登录函数（src/auth.ts#L42）。",
  );
  expect(forIm("[`auth.ts`](src/auth.ts) [a.ts:12](a.ts:12) [auth.ts:42](src/auth.ts#L42) ![](/tmp/%E6%88%AA%E5%9B%BE.png)")).toBe("src/auth.ts a.ts:12 auth.ts:42（src/auth.ts#L42） 截图.png");
  // A link around a picture: its words once, with the path.
  expect(forIm("[![首页](/tmp/a.png)](/tmp/a.png)")).toBe("首页（/tmp/a.png）");
  const kept = "[邮件](mailto:a@b.c) ![x](https://e.example/a.png) [docs](https://e.example) [见上文](#安装) `![a](/tmp/a.png)`\n```\n![a](/tmp/a.png)\n```";
  expect(forIm(kept)).toBe(kept);
});

const view = (caps: Capabilities): View => ({ verbose: false, dir: "/w", now: 0, caps });
const delta = (text: string) => ({ conv: "a", type: "text_delta", text }) as AgentEvent;
const whole = (text: string) => ({ conv: "a", type: "item", item: { kind: "message", text } }) as AgentEvent;

test("what the agent says as the turn goes is rewritten too: as it streams into the turn's message, and in each message QQ adds", () => {
  const first = edit(start(), delta("see ![sh"), view(TELEGRAM_CAPABILITIES));
  expect(edit(first.progress, delta("ot](/tmp/a.png) and [notes](notes.md)"), view(TELEGRAM_CAPABILITIES)).out.at(-1)!.text).toBe("see shot and notes（notes.md）");
  const said = append(start(), whole("see ![shot](/tmp/a.png)"), view(QQ_CAPABILITIES), 5);
  expect(append(said.progress, { conv: "a", type: "tool_start", id: "t1", name: "Read", input: {} } as AgentEvent, view(QQ_CAPABILITIES), 5).sends).toEqual(["see shot"]);
});

test("a long reply is rewritten before it is cut up: no piece holds half a picture's mark, with Markdown or without", () => {
  const reply = Array.from({ length: 40 }, (_, i) => `第 ${i} 行 ![图 ${i}](/tmp/pictures/一张名字很长的图片-${i}.png) 和 [说明 ${i}](notes/notes-${i}.md)`).join("\n");
  for (const markdown of [QQ_CAPABILITIES.markdown, null]) {
    const pieces = finish(start(), reply, view({ ...QQ_CAPABILITIES, maxTextLength: 200, markdown }));
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("\n")).not.toMatch(/!\[|\]\(|\.png/);
    expect(pieces.join("\n")).toContain("图 39 和 说明 39（notes/notes-39.md）");
  }
});

// ---- The router: the final reply's pictures. ----

const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  now: 1_000,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: CONFIG,
  capabilities: (bot) => CAPS[bot],
  keepFile: () => null,
  diskFree: () => Infinity,
  herdr: () => true,
  front: () => false,
  retarget: () => null,
  dropBot: () => {},
  inboundOf: () => [],
  ...o,
});
const slot = (id: string, o: Partial<Slot> = {}) =>
  ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "running", conversation: id, parent: null, lifetime: "longterm", archivedAt: null, token: id, turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null, reported: null, webAt: null, imAt: null, ...o }) as Slot;
const bot = (id: string, platform: string, o: Partial<Bot> = {}) => ({ id, name: id, platform, defaultTarget: "a", owners: JSON.stringify(["me"]), connState: "online", ...o }) as Bot;
const chat = (id: string, o: Partial<Chat> = {}) => ({ id, bot: id, platformChatId: "me", target: null, contactedAt: null, ...o }) as Chat;
const ok = (name: string, size = 100): Checked => ({ copy: `/media/${name}`, size, name });

/** Slot a in a turn you began in the chat with bot on (q, t or f), with passive replies left on QQ. */
function turn(on: string, pictures: State["pictures"], o: { slot?: Partial<Slot>; progress?: object; passive?: number } = {}): State {
  const slots = [slot("a", { turnChat: on, turnInbound: "in", ...o.slot })];
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots,
    conversations: [{ id: "a", slot: "a", agent: "claude", sessionId: "a", startedAt: 0, progress: o.progress ? JSON.stringify(o.progress) : null }],
    bots: [bot("q", "qq"), bot("t", "telegram"), bot("f", "feishu")],
    chats: [chat("q"), chat("t"), chat("f")],
    quotas: [{ id: "p", kind: "qq_passive", owner: "in", used: CONFIG.limits.qqPassiveReplies - (o.passive ?? 20), resetsAt: null }],
    ...{ holders: [], queued: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {}, pictures },
  } as unknown as State;
}
const ends = (s: State, reply: string, conv = "a") => route(s, { kind: "agent", event: { conv, type: "turn_end", reply } as AgentEvent }, ctx());
const out = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [{ ...(JSON.parse(w.row.payload as string) as Payload), chat: w.row.chat, status: w.row.status }] : []));
/** What went out: a picture by its name, a text as it is. */
const sent = (d: Decision) => out(d).map((p) => (p.file ? `<${p.file.name}>` : p.text));

test.each(["q", "t", "f"])("story 595: the final reply's local pictures follow it on %s, a message each in the reply's order, its words in their place; a path written twice goes once", (on) => {
  const d = ends(turn(on, { "/w/一.png": ok("一.png"), "/tmp/截图.png": ok("截图.png") }), "改好了：![首页](/w/一.png)\n再看 ![](/tmp/截图.png) 和 ![又是首页](/w/一.png)");
  expect(sent(d)).toEqual(["改好了：首页\n再看 截图.png 和 又是首页", "<一.png>", "<截图.png>"]);
  expect(out(d).slice(1).map((p) => [p.file, p.picture, p.markdown])).toEqual([
    [{ kind: "image", path: "/media/一.png", name: "一.png" }, "首页", undefined],
    [{ kind: "image", path: "/media/截图.png", name: "截图.png" }, "截图.png", undefined],
  ]);
});

test("story 595: of 12 pictures 10 go; those that did not pass the check, or are over the platform's limit, or whose copy was not kept, get a line each after the reply, in its order, the count over 10 last", () => {
  const many = Array.from({ length: 12 }, (_, i) => `![图${i}](/w/${i}.png)`).join(" ");
  const over = ends(turn("t", Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/w/${i}.png`, ok(`${i}.png`)]))), many);
  expect(sent(over)).toEqual([`${Array.from({ length: 12 }, (_, i) => `图${i}`).join(" ")}\n\n还有 2 张图片没发：一条回复最多发 10 张。`, ...Array.from({ length: 10 }, (_, i) => `<${i}.png>`)]);
  const pictures = { "/etc/a.png": { why: "不在槽位目录或 /tmp 里" }, "/w/gone.png": { why: "找不到文件" }, "/w/a.txt": { why: "不是图片" }, "/w/huge.png": { why: "超过 50MB" }, "/w/big.png": ok("big.png", 10 * 2 ** 20 + 1), "/w/ok.png": ok("ok.png") } as const;
  const d = ends(turn("t", pictures), "![外面](/etc/a.png) ![](/w/gone.png) ![文本](/w/a.txt) ![巨大](/w/huge.png) ![大图](/w/big.png) ![好的](/w/ok.png) ![盘满](/w/full.png)");
  expect(sent(d)).toEqual([
    "外面 gone.png 文本 巨大 大图 好的 盘满\n\n" +
      "图片“外面”没发：不在槽位目录或 /tmp 里。  \n图片“gone.png”没发：找不到文件。  \n图片“文本”没发：不是图片。  \n图片“巨大”没发：超过 50MB。  \n图片“大图”没发：超过了平台对图片的上限 10MB。  \n图片“盘满”没发：上传失败。",
    "<ok.png>",
  ]);
});

test("story 595: no pictures, nor their lines, for a turn rh send me took over; a reply with none goes as ever", () => {
  expect(sent(ends(turn("t", { "/w/a.png": ok("a.png") }, { slot: { turnSentMe: 1 } }), "看 ![图](/w/a.png)"))).toEqual([]);
  expect(sent(ends(turn("q", {}), "done"))).toEqual(["done"]);
});

test("story 595: on QQ a final reply that went out mid-turn still has its pictures sent at the turn's end, the lines in a message of their own before them", () => {
  const reply = "看 ![图](/w/a.png) 和 ![没了](/w/gone.png)";
  const progress = { ...start(), parts: [{ text: forIm(reply), done: true }, { tools: [] }], sent: 1 };
  const d = ends(turn("q", { "/w/a.png": ok("a.png"), "/w/gone.png": { why: "找不到文件" } }, { progress }), reply);
  expect(sent(d)).toEqual(["图片“没了”没发：找不到文件。", "<a.png>"]);
});

test("story 595: on QQ a picture takes a reply of the turn's as its text does: with too few, what is left waits for your next message, the text first", () => {
  const d = ends(turn("q", { "/w/a.png": ok("a.png"), "/w/b.png": ok("b.png") }, { passive: 2 }), "![一](/w/a.png) ![二](/w/b.png)");
  // The reply on the passive reply that may go, the pictures as active messages.
  expect(out(d).map((p) => [p.file?.name ?? p.text, p.status])).toEqual([["一 二", "pending"], ["a.png", "pending"], ["b.png", "pending"]]);
  const none = route({ ...turn("q", { "/w/a.png": ok("a.png") }, { passive: 2 }), quotas: [{ id: "p", kind: "qq_passive", owner: "in", used: CONFIG.limits.qqPassiveReplies - 2, resetsAt: null }, { id: "x", kind: "qq_active", owner: "q", used: CONFIG.limits.qqActive, resetsAt: 2_000 }] } as unknown as State, { kind: "agent", event: { conv: "a", type: "turn_end", reply: "![一](/w/a.png)" } as AgentEvent }, ctx({ capabilities: (b) => (b === "q" ? QQ_CAPABILITIES : undefined) }));
  expect(out(none).map((p) => [p.file?.name ?? p.text, p.status])).toEqual([["一", "pending"], ["完成，回任意字查看", "pending"], ["a.png", "held"]]);
});

test("story 595: a picture whose upload the platform turned down gets a line after it in that chat; one that failed for good after another bot was tried too", () => {
  const payload = JSON.stringify({ text: "", file: { kind: "image", path: "/media/a.png", name: "a.png" }, picture: "登录页截图" } satisfies Payload);
  const failed = route(turn("t", null), { kind: "send_failed", payload, chat: "t", inbound: "in", trace: "in" }, ctx());
  expect(out(failed).map((p) => [p.chat, p.text, p.markdown])).toEqual([["t", "图片“登录页截图”没发：上传失败。", undefined]]);
  // Refused on QQ with no other bot to take it.
  const alone = { ...turn("q", null), bots: [bot("q", "qq")], chats: [chat("q")] } as State;
  const refused = route(alone, { kind: "refused", outbound: "o", chat: "q", inbound: null, payload, quota: false }, ctx());
  expect(sent(refused)).toEqual(["图片“登录页截图”没发：上传失败。"]);
  // On QQ with one passive reply left and no active message: the line waits behind the hint.
  const last = { ...turn("q", null, { passive: 1 }), quotas: [{ id: "p", kind: "qq_passive", owner: "in", used: CONFIG.limits.qqPassiveReplies - 1, resetsAt: null }, { id: "x", kind: "qq_active", owner: "q", used: CONFIG.limits.qqActive, resetsAt: 2_000 }] } as unknown as State;
  const waits = out(route(last, { kind: "send_failed", payload, chat: "q", inbound: "in", trace: "in" }, ctx({ capabilities: (b) => (b === "q" ? QQ_CAPABILITIES : undefined) })));
  expect(waits.map((p) => [p.text, p.status, !!p.hint, !!p.hintedBy])).toEqual([["完成，回任意字查看", "pending", true, false], ["图片“登录页截图”没发：上传失败。", "held", false, true]]);
  // Any other message that failed says nothing.
  expect(sent(route(turn("t", null), { kind: "send_failed", payload: JSON.stringify({ text: "hi" }), chat: "t", inbound: "in", trace: "in" }, ctx()))).toEqual([]);
});

test("stories 592, 595: a bound child's reply of a turn no message of yours began brings its pictures too", () => {
  const s = { ...turn("t", { "/w/a.png": ok("a.png"), "/w/gone.png": { why: "找不到文件" } }), slots: [slot("a", { state: "idle" }), slot("c", { parent: "a" })], chats: [chat("t", { target: "c" })] } as State;
  s.conversations.push({ ...s.conversations[0]!, id: "c", slot: "c" });
  expect(sent(ends(s, "好了 ![图](/w/a.png) ![没了](/w/gone.png)", "c"))).toEqual(["好了 图 没了\n\n图片“没了”没发：找不到文件。", "<a.png>"]);
});

test("story 596: rh send's words to you are rewritten, and bring no picture", () => {
  const s = { ...turn("t", { "/w/a.png": ok("a.png") }), slots: [slot("a")], chats: [chat("t", { target: "a" })] } as State;
  const d = route(s, { kind: "rh", id: "r", caller: { token: "a", pid: null, tty: false, cwd: "/w" }, argv: ["send", "me", "看 ![图](/w/a.png) 和 [笔记](notes.md)"] }, ctx());
  expect(sent(d)).toEqual(["看 图 和 笔记（notes.md）"]);
});

// ---- The main loop: what a turn's end is given of its reply's pictures. ----

test("the turn's end gets each picture's check and copy: that of the message just written when the reply is the same text, else checked now; none for a copy that was not kept", () => {
  const home = join(dir, "slot");
  mkdirSync(home);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  writeFileSync(join(home, "截图.png"), png);
  const store = openStore(join(dir, "rh.db"));
  const media = join(dir, "media");
  const conversation = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: tx.insert("workspace", { name: "w", dir: home }).id, name: "a", dir: home, mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "claude", sessionId: "s1", startedAt: 0 }).id;
    tx.update("slot", { id }, { conversation });
    return conversation;
  });
  const reply = "![图](截图.png) ![没了](gone.png)";
  const rows = () => store.tx((tx) => tx.find("replyImage", {})).length;
  store.tx((tx) => saidPictures(tx, media, conversation, reply, 5));
  // The file changed since the message was written: the copy kept then is the one sent.
  writeFileSync(join(home, "截图.png"), Buffer.concat([png, Buffer.alloc(4)]));
  const same = store.tx((tx) => replyPictures(tx, media, conversation, reply, { text: reply, at: 5 }, 9));
  expect(same).toEqual({ "截图.png": { copy: expect.stringContaining(media), size: 16, name: "截图.png" }, "gone.png": { why: "找不到文件" } });
  expect(rows()).toBe(2);
  // Not the text last written: checked now, with rows of its own.
  const fresh = store.tx((tx) => replyPictures(tx, media, conversation, reply, { text: "something else", at: 5 }, 9));
  expect(fresh["截图.png"]).toMatchObject({ size: 20 });
  expect(rows()).toBe(4);
  // The copy could not be kept: no row, and nothing for the router, which says 上传失败.
  writeFileSync(media + "-file", "");
  expect(store.tx((tx) => replyPictures(tx, media + "-file", conversation, reply, undefined, 12))).toEqual({ "gone.png": { why: "找不到文件" } });
  store.close();
});

// ---- End to end, on a QQ-like fake bot. ----

let rhodium: Instance | undefined;
afterEach(() => rhodium?.cleanup());

test("story 595: a turn from QQ: what it says midway brings no picture; the final reply's picture, by a Chinese name, follows it, the missing one named after the text; an upload turned down gets its line, one that may have gone gets none", async () => {
  const ME = "you-openid";
  const steps = [...startTurn, saying("先看 ![草图](截图.png)"), toolCall("toolu_read", "Read", { file_path: "notes.txt" }), ...endTurn("好了 ![](截图.png) ![没了](gone.png) [笔记](notes.md)"), { goto: 0 }];
  // No active messages: the upload's line goes as a reply to the message its picture answered.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps } }, toml: "[limits]\nqqActive = 0" });
  await rhodium.start();
  await rhodium.slots("a");
  writeFileSync(join(rhodium.dir, "w/截图.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));
  const turn = async (n: number) => {
    await rhodium!.im.inject("q", { chat: ME, sender: ME, text: "go" });
    await until(async () => (await rhodium!.im.log("q", ME)).length >= n && (await rhodium!.state("w/a")) === "空闲", 15_000);
    await Bun.sleep(300); // nothing more comes
    return (await rhodium!.im.log("q", ME)).map((p) => (p.file ? `<${p.file.name} ${Buffer.byteLength(p.file.data, "base64")}>` : p.text));
  };
  const first = ["先看 草图", "[🔧 Read]\n\n好了 截图.png 没了 笔记（notes.md）\n\n图片“没了”没发：找不到文件。", "<截图.png 16>"];
  expect(await turn(3)).toEqual(first);
  // The platform turns the picture down: a line after it.
  for (const outcome of ["ok", "ok", "fail"] as const) await rhodium.im.next("q", outcome, "send");
  expect(await turn(6)).toEqual([...first, first[0]!, first[1]!, "图片“截图.png”没发：上传失败。"]);
  // The bot never hears back: it may have gone, so no line.
  for (const outcome of ["ok", "ok", "timeout"] as const) await rhodium.im.next("q", outcome, "send");
  expect((await turn(9)).slice(6)).toEqual(first);
}, 60_000);
