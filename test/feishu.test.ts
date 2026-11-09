// The Feishu adapter on the official SDK, its apiRoot pointed at the fake Feishu (test/feishu-api.ts),
// as far as the fake copies Feishu: what Feishu itself shows on a phone is checked by hand
// (docs/spec/feishu.md "你来验收").
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard } from "../src/board";
import { loadConfig } from "../src/config";
import type { InboundMessage, SendResult } from "../src/contracts";
import { FeishuAdapter } from "../src/feishu";
import type { Posted } from "../src/fake-im";
import { slashMenu } from "../src/commands";
import { clockAt } from "../src/prompt";
import type { Script } from "./fake-agent/fake-agent";
import { asking, endTurn, on, PROGRESS_PIECES, startTurn } from "./fake-agent/scripts";
import { APP, CHAT, feishuApi, ME, SECRET } from "./feishu-api";
import { openStore } from "../src/store";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

let api: ReturnType<typeof feishuApi>;
let stop: (() => Promise<unknown>) | undefined;
let rhodium: Instance | undefined;
afterEach(async () => {
  await stop?.();
  await rhodium?.cleanup();
  api?.stop();
  [stop, rhodium] = [undefined, undefined];
});

const logs: string[] = [];
// The messages listen() handed on, as rhodium's inbound table: the bot's seen() asks it.
const taken = new Set<string>();
type More = Partial<ConstructorParameters<typeof FeishuAdapter>[3]>;
/** A Feishu bot B1 on the fake, its sends given up after timeoutMs; more: its other options. */
function adapter(secret = SECRET, timeoutMs?: number, more: More = {}): FeishuAdapter {
  logs.length = 0;
  taken.clear();
  const seen = (_chat: string, id: string) => taken.has(id);
  return new FeishuAdapter("B1", "fs", { platform: "feishu", appId: APP, secret, apiRoot: api.url }, { editEvery: 3000, log: (m) => logs.push(m), seen, ...(timeoutMs && { timeoutMs }), ...more });
}

/** The bot listening: its messages one by one, each then taken in, and what connected heard. */
function listen(bot: FeishuAdapter) {
  const heard: (true | string | undefined)[] = [];
  const it = bot.messages((up, error) => heard.push(up || error))[Symbol.asyncIterator]();
  stop = () => it.return!();
  const next = async () => {
    const m = (await it.next()).value as InboundMessage;
    taken.add(m.messageId);
    return m;
  };
  return { heard, next };
}

const recorded = readFileSync(join(import.meta.dir, "fixtures/feishu/session.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { ev: string; name?: string; res?: any; event?: { message?: { message_type: string; content: string; message_id: string; parent_id?: string } } });
/** The first message of the type recorded. */
const recordedMessage = (type: string) => recorded.find((r) => r.event?.message?.message_type === type)!.event!.message!;
/** The content of the first message of the type recorded. */
const content = (type: string) => recordedMessage(type).content;
// A 1x1 PNG.
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

test("a Feishu bot needs its App ID and secret", () => {
  api = feishuApi();
  expect(() => new FeishuAdapter("B1", "fs", { platform: "feishu", appId: APP }, { editEvery: 3000 })).toThrow(/bots.fs.secret/);
  expect(() => new FeishuAdapter("B1", "fs", { platform: "feishu", secret: SECRET }, { editEvery: 3000 })).toThrow(/bots.fs.appId/);
});

test("story 455: your text comes to rhodium as you wrote it, from you in your chat, at the time you sent it; Feishu hears it was taken only once rhodium asks for the next", async () => {
  api = feishuApi();
  const { heard, next } = listen(adapter());
  const first = next();
  await api.connected();
  const sent = api.say("你好 :OK: <b>");
  expect(await first).toEqual({ bot: "B1", chat: ME, messageId: sent.message_id, sender: ME, text: "你好 :OK: <b>", at: Number(sent.create_time) });
  await Bun.sleep(200);
  expect(api.acks).toEqual([]);
  const second = next();
  await until(() => api.acks.length === 1);
  expect(api.acks).toEqual([{ event_id: sent.event_id, event_type: "im.message.receive_v1", code: 200 }]);
  expect(heard).toEqual([true]);
  api.say("再见");
  expect((await second).text).toBe("再见");
});

test("story 455: your rich text comes as text: the title and a line a paragraph, links with their address, @ as @name, code fenced, a rule as ---, a blank paragraph a blank line, no styles", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  // As recorded: a line, a "- " that is plain text, and a bold one.
  api.message("post", content("post"));
  expect((await next()).text).toBe("1\n- 2\n33");
  api.message("post", {
    title: "标题",
    content: [
      [{ tag: "text", text: "看 ", style: ["bold"] }, { tag: "a", text: "文档", href: "https://a.b/c" }, { tag: "text", text: " 和 " }, { tag: "a", text: "https://x.y", href: "https://x.y" }],
      [{ tag: "at", user_id: "@_user_1", user_name: "张三" }, { tag: "text", text: " 你看" }, { tag: "emotion", emoji_type: "SMILE" }],
      [{ tag: "code_block", language: "GO", text: "func main() {\n}\n" }],
      [{ tag: "hr" }],
      [{ tag: "img", image_key: "img_1" }],
      [],
      [{ tag: "text", text: "完" }],
    ],
  });
  expect((await next()).text).toBe("标题\n看 文档（https://a.b/c） 和 https://x.y\n@张三 你看[SMILE]\n```go\nfunc main() {\n}\n```\n---\n\n完");
});

test("a message in a group, or of a kind Rhodium does not take, is acked and not handed on; one rhodium can't read is acked as failed, for Feishu to push again", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const got = next();
  const group = api.say("群里的", { chat_type: "group", chat_id: "oc_group" });
  await until(() => api.acks.length === 1);
  // Its content need not be JSON, as a forward's is not.
  const other = api.message("location", "Location");
  await until(() => api.acks.length === 2);
  const broken = api.message("text", "{not json");
  await until(() => api.acks.length === 3);
  api.say("私聊的");
  expect((await got).text).toBe("私聊的");
  expect(api.acks.map((a) => [a.event_id, a.code])).toEqual([
    [group.event_id, 200],
    [other.event_id, 200],
    [broken.event_id, 500],
  ]);
});

test("the bot tells rhodium it is connected once the long connection is up, not when it drops, and connected when it is back", async () => {
  api = feishuApi();
  const { heard } = listen(adapter());
  await until(() => heard.length === 1);
  api.drop();
  await until(() => heard.length === 3, 10_000);
  expect(heard).toEqual([true, expect.any(String), true]);
  expect(api.connects).toHaveLength(2);
});

test("story 468: each try to reconnect that fails tells rhodium once more it is not connected, and no more often than that", async () => {
  api = feishuApi();
  const { heard } = listen(adapter());
  await until(() => heard.length === 1);
  api.link.down = true;
  api.drop();
  // The drop, and two tries that failed.
  await until(() => heard.length === 4, 10_000);
  expect(heard).toEqual([true, expect.any(String), expect.any(String), expect.any(String)]);
  expect(api.link.refused).toBeGreaterThanOrEqual(2);
  api.link.down = false;
  await until(() => heard.at(-1) === true, 10_000);
  expect(heard.filter((h) => h !== true).length).toBeLessThanOrEqual(api.link.refused + 1);
}, 15_000);

test("credentials Feishu turns down: not connected, with Feishu's reason and never the secret, tried again after a wait", async () => {
  api = feishuApi();
  const { heard } = listen(adapter("wrong-secret-never-logged"));
  await until(() => heard.length === 2, 10_000);
  expect(heard).toEqual([expect.stringContaining("incorrect app secret"), expect.stringContaining("incorrect app secret")]);
  expect(logs.filter((l) => l.includes("wrong-secret-never-logged"))).toEqual([]);
  expect(api.connects).toEqual([]);
});

// ---- Backfill (spec "补拉"): each time the long connection comes up. ----

const LIST = "/open-apis/im/v1/messages";
const lists = () => api.calls.filter((c) => c.method === "GET" && c.path === LIST);
const ago = (ms: number) => ({ create_time: String(Date.now() - ms) });

test("story 466: once connected the bot hands on what you sent in your private chat while it could not hear, oldest first, page after page; not its own, nor one taken back, nor anything before since or over 24 h old", async () => {
  api = feishuApi();
  // Half a second into a second: the list's start_time is in seconds.
  const since = Math.floor((Date.now() - 60_000) / 1000) * 1000 + 500;
  const bot = adapter(SECRET, undefined, { chat: CHAT, since });
  api.say("接入前", ago(70_000));
  api.say("接入前那一秒", { create_time: String(since - 100) });
  // The bot's own, of a type that would be read if it were yours.
  await fetch(`${api.url}${LIST}?receive_id_type=open_id`, { method: "POST", body: JSON.stringify({ receive_id: ME, msg_type: "text", content: JSON.stringify({ text: "Bot 的字" }) }) });
  // One you took back.
  api.say("撤回了", ago(55_000));
  api.history.at(-1)!.deleted = true;
  const yours = Array.from({ length: 60 }, (_, i) => api.say(`第 ${i} 句`, ago(50_000 - i)));
  const { next } = listen(bot);
  const got: InboundMessage[] = [];
  for (let i = 0; i < 60; i++) got.push(await next());
  expect(got.map((m) => [m.messageId, m.text, m.at])).toEqual(yours.map((m, i) => [m.message_id, `第 ${i} 句`, Number(m.create_time)]));
  expect(got[0]).toMatchObject({ bot: "B1", chat: ME, sender: ME });
  expect(lists().map((c) => c.query)).toEqual([
    { container_id_type: "chat", container_id: CHAT, start_time: String(Math.floor(since / 1000)), end_time: expect.any(String), sort_type: "ByCreateTimeAsc", page_size: "50" },
    expect.objectContaining({ page_token: "50" }),
  ]);
  // Over 24 h ago, with since long before.
  await stop!();
  api.stop();
  api = feishuApi();
  const old = adapter(SECRET, undefined, { chat: CHAT, since: 0 });
  api.say("一天前", ago(25 * 3600_000));
  api.say("刚才", ago(1000));
  expect((await listen(old).next()).text).toBe("刚才");
});

test("story 466: without your private chat's id the bot backfills nothing; a send's answer gives it, kept for the next rhodium, and one that changed replaces it", async () => {
  api = feishuApi();
  const kept: string[] = [];
  const { heard } = listen(adapter(SECRET, undefined, { saveChat: (c) => kept.push(c) }));
  await until(() => heard.length === 1);
  await Bun.sleep(300);
  expect(lists()).toEqual([]);
  await stop!();
  api.stop();

  api = feishuApi();
  const bot = adapter(SECRET, undefined, { chat: "oc_old", saveChat: (c) => kept.push(c) });
  const { next } = listen(bot);
  await until(() => lists().length === 1);
  expect(lists()[0]!.query.container_id).toBe("oc_old");
  await bot.send(ME, { text: "一" });
  await bot.send(ME, { text: "二" });
  expect(kept).toEqual([CHAT]);
  api.link.down = true;
  api.drop();
  await until(() => !api.up());
  const m = api.say("断线时发的");
  api.link.down = false;
  expect((await next()).messageId).toBe(m.message_id);
  expect(lists().map((c) => c.query.container_id)).toEqual(["oc_old", CHAT]);
}, 15_000);

test("story 467: a message rhodium took in already, backfilled or pushed again, is acked and not handed on again", async () => {
  api = feishuApi();
  const bot = adapter(SECRET, undefined, { chat: CHAT });
  const first = api.say("一");
  const { next } = listen(bot);
  expect((await next()).text).toBe("一");
  // Feishu pushes it again, with a new event id, while rhodium waits for the next.
  const second = next();
  const again = api.say("一", { message_id: first.message_id, create_time: first.create_time });
  await until(() => api.acks.some((a) => a.event_id === again.event_id));
  expect(api.acks.find((a) => a.event_id === again.event_id)!.code).toBe(200);
  api.say("二");
  expect((await second).text).toBe("二");
  // Back after a drop, the backfill lists both again.
  const third = next();
  api.drop();
  await until(() => lists().length === 2, 10_000);
  api.say("三");
  expect((await third).text).toBe("三");
}, 15_000);

test("story 466: a message pushed while the bot backfills waits for the backfill, so what you sent first comes first", async () => {
  api = feishuApi();
  api.say("断线时发的");
  api.link.listDelay = 500;
  const { next } = listen(adapter(SECRET, undefined, { chat: CHAT }));
  await until(() => lists().length === 1);
  await api.connected();
  api.say("连上后发的");
  expect((await next()).text).toBe("断线时发的");
  expect((await next()).text).toBe("连上后发的");
});

test("a backfill Feishu turns down is logged and not tried again; what is pushed still comes", async () => {
  api = feishuApi();
  api.say("断线时发的");
  api.next.push({ how: "flood", reset: 0 });
  const { next } = listen(adapter(SECRET, undefined, { chat: CHAT }));
  await until(() => lists().length === 1);
  api.say("连上后发的");
  expect((await next()).text).toBe("连上后发的");
  expect(lists()).toHaveLength(1);
  expect(logs.filter((l) => l.includes("230020"))).toHaveLength(1);
});

const sends = () => api.sent.map(({ method, receive_id, receive_id_type, msg_type, card }) => ({ method, receive_id, receive_id_type, msg_type, card }));
/** The card a message is sent as: its body element, the summary shown in the chat list. */
const card = (element: object, summary: string) => ({ schema: "2.0", config: { update_multi: true, width_mode: "fill", summary: { content: summary } }, body: { elements: [element] } });
const markdown = (content: string) => ({ tag: "markdown", content });
const plain = (content: string) => ({ tag: "div", text: { tag: "plain_text", content } });

test("stories 456, 458: a message goes as a card to your open_id: Markdown in a markdown element, Rhodium's own text in a plain one; its summary the last line with text, cut to 50", async () => {
  api = feishuApi();
  const bot = adapter();
  const long = "长".repeat(60);
  const r = await bot.send(ME, { text: `第一行\n${long}\n\n`, markdown: `**第一行**\n${long}` });
  expect(r).toEqual({ status: "sent", messageId: api.sent[0]!.message_id });
  expect(await bot.send(ME, { text: "已配对。" })).toMatchObject({ status: "sent" });
  expect(sends()).toEqual([
    { method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "interactive", card: card(markdown(`**第一行**\n${long}`), "长".repeat(50)) },
    { method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "interactive", card: card(plain("已配对。"), "已配对。") },
  ]);
});

test("story 459: a card whose Markdown Feishu turns down goes again as plain text, sent and edited alike", async () => {
  api = feishuApi();
  const bot = adapter();
  api.next.push({ how: "refuse", method: "POST" });
  expect(await bot.send(ME, { text: "four tables", markdown: "| a |" })).toMatchObject({ status: "sent" });
  api.next.push({ how: "refuse", method: "PATCH" });
  expect(await bot.edit(ME, "om_9", { text: "four tables, more", markdown: "| a | b |" })).toEqual({ status: "sent", messageId: "om_9" });
  expect(api.sent.map((s) => [s.method, s.card.body.elements[0]])).toEqual([
    ["POST", plain("four tables")],
    ["PATCH", plain("four tables, more")],
  ]);
  expect(api.calls.map((c) => c.method)).toEqual(["POST", "POST", "PATCH", "PATCH"]);
});

test("an edit replaces the whole card", async () => {
  api = feishuApi();
  expect(await adapter().edit(ME, "om_9", { text: "done", markdown: "**done**" })).toEqual({ status: "sent", messageId: "om_9" });
  expect(api.sent).toEqual([{ method: "PATCH", message_id: "om_9", card: card(markdown("**done**"), "done") }]);
});

test("story 469: out of the month's quota (99991403, HTTP 429) a send or an edit fails for its quota, tried once", async () => {
  api = feishuApi();
  const bot = adapter();
  api.next.push({ how: "quota" }, { how: "quota" });
  expect(await bot.send(ME, { text: "hi", markdown: "hi" })).toEqual({ status: "failed", error: expect.stringContaining("99991403"), quota: true });
  expect(await bot.edit(ME, "om_9", { text: "hi", markdown: "hi" })).toEqual({ status: "failed", error: expect.stringContaining("99991403"), quota: true });
  expect(api.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
});

test("over the rate limit Feishu took nothing: the bot waits the seconds it gives and tries again, three tries at most", async () => {
  api = feishuApi();
  const bot = adapter();
  api.next.push({ how: "flood", reset: 1 });
  expect(await bot.send(ME, { text: "hi" })).toMatchObject({ status: "sent" });
  const [a, b] = api.calls;
  expect(b!.at - a!.at).toBeGreaterThanOrEqual(900);
  api.next.push({ how: "busy", reset: 0 }, { how: "flood", reset: 0 }, { how: "busy", reset: 0 });
  expect(await bot.send(ME, { text: "hi" })).toEqual({ status: "failed", error: expect.stringContaining("99991400"), flood: true });
  // Past a minute's wait it gives up at once.
  api.next.push({ how: "flood", reset: 61 });
  expect(await bot.edit(ME, "om_9", { text: "hi" })).toEqual({ status: "failed", error: expect.stringContaining("230020"), flood: true });
  expect(api.calls).toHaveLength(6);
});

test("credentials Feishu turns down fail a send, and the SDK's error is logged by its message, without the request that carried the secret", async () => {
  api = feishuApi();
  // Another app: the SDK keeps the token it got by App ID, for every client in the process.
  const bot = new FeishuAdapter("B1", "fs", { platform: "feishu", appId: "cli_fedcba9876543210", secret: "wrong-secret-never-logged", apiRoot: api.url }, { editEvery: 3000, log: (m) => logs.push(m) });
  logs.length = 0;
  expect(await bot.send(ME, { text: "hi" })).toEqual({ status: "failed", error: expect.stringContaining("10014") });
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.filter((l) => /wrong-secret|app_secret|config/.test(l))).toEqual([]);
});

test("any other refusal fails; a server error or no answer may have arrived, so it is unknown", async () => {
  api = feishuApi();
  const bot = adapter(SECRET, 500);
  api.next.push({ how: "denied" }, { how: "error" }, { how: "timeout" });
  const results: SendResult[] = [];
  for (let i = 0; i < 3; i++) results.push(await bot.send(ME, { text: "hi" }));
  expect(results).toEqual([
    { status: "failed", error: expect.stringContaining("230013") },
    { status: "unknown", error: expect.stringContaining("500") },
    { status: "unknown", error: expect.stringContaining("timeout") },
  ]);
  expect(logs.filter((l) => l.includes(SECRET))).toEqual([]);
});

test("a token Feishu takes the connection for and never answers gives the send up after timeoutMs, as unknown, rather than hold up every bot's sends", async () => {
  api = feishuApi();
  api.token.hangs = true;
  // Another app: the SDK would not ask again for a token it has.
  const bot = new FeishuAdapter("B1", "fs", { platform: "feishu", appId: "cli_00000000000000a1", secret: SECRET, apiRoot: api.url }, { editEvery: 3000, log: (m) => logs.push(m), timeoutMs: 500 });
  expect(await bot.send(ME, { text: "hi" })).toEqual({ status: "unknown", error: expect.stringContaining("timeout") });
  expect(api.calls).toEqual([]);
}, 10_000);

test("taking the buttons off a card the bot does not know fails", async () => {
  api = feishuApi();
  expect(await adapter().dropButtons(ME, "om_9")).toMatchObject({ status: "failed" });
  expect(api.calls).toEqual([]);
});

// ---- Pictures, files and other messages (stories 462-465). ----

test("story 462: a picture, a sticker, a file and a video you send come as attachments, fetched only once rhodium asks: by the message and its key, a picture as an image, the rest as a file, named as the message has it", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const key = (type: string, field: string) => JSON.parse(content(type))[field] as string;
  const name = JSON.parse(content("file")).file_name as string;
  const video = { file_key: "file_v3_v", image_key: "img_v3_v", file_name: "片段.mp4", duration: 3000 };
  const bytes = { image: PNG, sticker: new Uint8Array([0xff, 0xd8, 0xff]), file: new Uint8Array([1, 2, 3]), media: new Uint8Array([4, 5]) };
  api.files.set(key("image", "image_key"), bytes.image);
  api.files.set(key("sticker", "file_key"), bytes.sticker);
  api.files.set(key("file", "file_key"), bytes.file);
  api.files.set(video.file_key, bytes.media);
  const sent = [api.message("image", content("image")), api.message("sticker", content("sticker")), api.message("file", content("file")), api.message("media", video)];
  const got: InboundMessage[] = [];
  for (let i = 0; i < 4; i++) got.push(await next());
  expect(got.map(({ text, attachments }) => ({ text, attachments: attachments!.map(({ kind, name }) => ({ kind, name })) }))).toEqual([
    { text: "", attachments: [{ kind: "image", name: undefined }] },
    { text: "", attachments: [{ kind: "image", name: undefined }] },
    { text: "", attachments: [{ kind: "file", name }] },
    { text: "", attachments: [{ kind: "file", name: "片段.mp4" }] },
  ]);
  expect(api.downloads).toEqual([]);
  const fetched = [];
  for (const m of got) fetched.push(await m.attachments![0]!.fetch());
  expect(fetched).toEqual([bytes.image, bytes.sticker, bytes.file, bytes.media]);
  expect(api.downloads).toEqual([
    { message_id: sent[0]!.message_id, key: key("image", "image_key"), type: "image" },
    { message_id: sent[1]!.message_id, key: key("sticker", "file_key"), type: "image" },
    { message_id: sent[2]!.message_id, key: key("file", "file_key"), type: "file" },
    { message_id: sent[3]!.message_id, key: video.file_key, type: "file" },
  ]);
});

test("story 462: the pictures in your rich text come as attachments, by the message and each one's key", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  api.files.set("img_a", PNG);
  const m = api.message("post", { title: "", content: [[{ tag: "text", text: "两张：" }], [{ tag: "img", image_key: "img_a" }], [{ tag: "img", image_key: "img_b" }, { tag: "text", text: "完" }]] });
  const got = await next();
  expect(got.text).toBe("两张：\n完");
  expect(got.attachments!.map((a) => a.kind)).toEqual(["image", "image"]);
  expect(await got.attachments![0]!.fetch()).toEqual(PNG);
  // One Feishu won't give fails with its reason, for rhodium to say so.
  await expect(got.attachments![1]!.fetch()).rejects.toThrow("234003");
  expect(api.downloads.map((d) => [d.message_id, d.key, d.type])).toEqual([
    [m.message_id, "img_a", "image"],
    [m.message_id, "img_b", "image"],
  ]);
});

test("story 465: a voice message comes as one, with no text, nothing fetched", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const m = api.message("audio", content("audio"));
  expect(await next()).toEqual({ bot: "B1", chat: ME, messageId: m.message_id, sender: ME, text: "", at: Number(m.create_time), voice: true });
  expect(api.downloads).toEqual([]);
});

test("story 463: a reply names the message it replies to, for rhodium to find its text", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const reply = recordedMessage("post");
  api.message("post", reply.content, { parent_id: reply.parent_id });
  expect(await next()).toMatchObject({ text: "1\n- 2\n33", quote: { ref: reply.parent_id } });
  api.say("no reply");
  expect((await next()).quote).toBeUndefined();
});

test("story 455: a note you add to a forward comes as text, not as the HTML Feishu writes it in: a line a paragraph, no tags, &lt; and the like as characters; so in a forward", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  // As Feishu sent one on 2026-10-26: a text replying to the forward it was added to.
  api.message("text", { text: "<p>这里是什么？</p>" }, { parent_id: "om_forward" });
  expect(await next()).toMatchObject({ text: "这里是什么？", quote: { ref: "om_forward" } });
  api.say("<p>a &lt; <b>b</b> &amp;&amp; c</p><p>第二行<br>第三行</p>");
  expect((await next()).text).toBe("a < b && c\n第二行\n第三行");
  const now = Date.now();
  const note = { message_id: "om_c1", upper_message_id: "om_note", msg_type: "text", create_time: String(now), sender: { id: ME }, body: { content: JSON.stringify({ text: "<p>这里是什么？</p>" }) } };
  api.forwards.set("om_note", [recordedForward().items[0], note]);
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_note" });
  expect((await next()).text).toBe(`[合并转发，1 条]\n我 ${at(now)}：这里是什么？`);
});

/** The forward recorded and its messages as message.get gave them, but from you and from this bot as
 *  the fake has them: the recording's ids were replaced by hand. */
function recordedForward() {
  const event = recordedMessage("merge_forward");
  const items = (recorded.find((r) => r.ev === "api" && r.name === "message.get")!.res.data.items as any[]).map((i) => ({ ...i, sender: { ...i.sender, id: i.sender.id_type === "app_id" ? APP : ME } }));
  return { event, items };
}
const at = (ms: string | number) => clockAt(Number(ms), Date.now());

test("story 464: a forward comes as its messages' text, one a line: you as 我, this bot as Bot, each at its time; pictures not fetched, cards as such", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const { event, items } = recordedForward();
  api.forwards.set(event.message_id, items);
  api.message("merge_forward", event.content, { message_id: event.message_id });
  const got = await next();
  const [, text, card1, card2, mine, bots] = items;
  expect(got.text).toBe(
    [
      "[合并转发，5 条]",
      `我 ${at(text.create_time)}：${JSON.parse(text.body.content).text}`,
      `Bot ${at(card1.create_time)}：[卡片]`,
      `Bot ${at(card2.create_time)}：[卡片]`,
      `我 ${at(mine.create_time)}：[图片，没取]`,
      `Bot ${at(bots.create_time)}：[图片，没取]`,
    ].join("\n"),
  );
  expect(got.attachments).toBeUndefined();
  expect(api.downloads).toEqual([]);
});

test("story 464: in a forward others are A, B by who comes first; a second line, and a forward in it, indented two spaces; files, videos and voice named; at most 50 messages", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const today = Date.now();
  const before = new Date(2026, 9, 25, 9, 1).getTime();
  let n = 0;
  const item = (upper: string, msg_type: string, content: object | string, sender: string, time = today, id = `om_c${++n}`) => ({
    body: { content: typeof content === "string" ? content : JSON.stringify(content) },
    chat_id: "oc_other",
    create_time: String(time),
    deleted: false,
    message_id: id,
    msg_type,
    sender: { id: sender, id_type: "open_id", sender_type: "user", tenant_key: "tenant_0" },
    update_time: String(time),
    updated: false,
    upper_message_id: upper,
  });
  const top = { ...item("", "merge_forward", "Merged and Forwarded Message", ME, today, "om_top"), upper_message_id: undefined };
  const items = [
    top,
    item("om_top", "text", { text: "好的\n第二行" }, "ou_a"),
    item("om_top", "file", { file_key: "file_1", file_name: "报告.pdf" }, "ou_b"),
    item("om_top", "merge_forward", "Merged and Forwarded Message", "ou_a", today, "om_inner"),
    item("om_inner", "text", { text: "方案在群公告里" }, "ou_c", before),
    item("om_inner", "post", { title: "", content: [[{ tag: "text", text: "看图" }], [{ tag: "img", image_key: "img_1" }]] }, ME, before),
    item("om_top", "media", { file_key: "file_2", image_key: "img_2", file_name: "a.mp4" }, ME),
    item("om_top", "audio", { file_key: "file_3", duration: 1000 }, ME),
    item("om_top", "sticker", { file_key: "v3_1" }, "ou_b"),
  ];
  api.forwards.set("om_top", items);
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_top" });
  expect((await next()).text).toBe(
    [
      "[合并转发，6 条]",
      `A ${at(today)}：好的`,
      "  第二行",
      `B ${at(today)}：[文件 报告.pdf，没取]`,
      `A ${at(today)}：[合并转发，2 条]`,
      `  C ${at(before)}：方案在群公告里`,
      `  我 ${at(before)}：看图`,
      "    [图片，没取]",
      `我 ${at(today)}：[视频，没取]`,
      `我 ${at(today)}：[语音]`,
      `B ${at(today)}：[表情包，没取]`,
    ].join("\n"),
  );

  // Past 50, the rest are counted.
  const many = [top, ...Array.from({ length: 53 }, (_, i) => item("om_top", "text", { text: String(i + 1) }, ME))];
  api.forwards.set("om_many", many.map((i) => ({ ...i, ...(i === top ? { message_id: "om_many" } : { upper_message_id: "om_many" }) })));
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_many" });
  const lines = (await next()).text.split("\n");
  expect([lines[0], lines[50], lines[51], lines.length]).toEqual(["[合并转发，53 条]", `我 ${at(today)}：50`, "还有 3 条没展开", 52]);
});

test("story 464: a forward Feishu won't give says so, apart from an empty one", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  api.forwards.set("om_empty", [recordedForward().items[0]]);
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_empty" });
  expect((await next()).text).toBe("[合并转发，0 条]");
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_gone" });
  expect((await next()).text).toBe("[合并转发，没取到]");
  expect(logs.filter((l) => l.includes("230001"))).toHaveLength(1);
});

test("messages are handed on in the order Feishu pushed them, a forward that takes a while to fetch included", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  api.forwards.set("om_f", [recordedForward().items[0]]);
  api.next.push({ how: "flood", method: "GET", reset: 1 });
  api.message("merge_forward", "Merged and Forwarded Message", { message_id: "om_f" });
  api.say("after it");
  expect((await next()).text).toBe("[合并转发，0 条]");
  expect((await next()).text).toBe("after it");
});

test("story 462: a picture goes out uploaded, then as an image message; a file uploaded with its name and Feishu's type for it, then as a file message", async () => {
  api = feishuApi();
  const bot = adapter();
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-"));
  try {
    const kept = (data: Uint8Array) => {
      const path = join(dir, new Bun.CryptoHasher("sha256").update(data).digest("hex"));
      writeFileSync(path, data);
      return path;
    };
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const log = new Uint8Array([0x6c, 0x6f, 0x67]);
    const results = [
      await bot.send(ME, { text: "", file: { kind: "image", path: kept(PNG), name: "chart.png" } }),
      await bot.send(ME, { text: "", file: { kind: "file", path: kept(pdf), name: "报告.PDF" } }),
      await bot.send(ME, { text: "", file: { kind: "file", path: kept(log), name: "run.log" } }),
    ];
    expect(api.uploads.map(({ kind, fields, bytes }) => ({ kind, fields, bytes }))).toEqual([
      { kind: "image", fields: { image_type: "message" }, bytes: PNG },
      { kind: "file", fields: { file_type: "pdf", file_name: "报告.PDF" }, bytes: pdf },
      { kind: "file", fields: { file_type: "stream", file_name: "run.log" }, bytes: log },
    ]);
    const [image, file, other] = api.uploads.map((u) => u.key);
    expect(sends()).toEqual([
      { method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "image", card: { image_key: image } },
      { method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "file", card: { file_key: file } },
      { method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "file", card: { file_key: other } },
    ]);
    expect(results).toEqual(api.sent.map((s) => ({ status: "sent", messageId: s.message_id })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an upload that fails or never answers sent nothing, so the file fails, for its quota where that is why; one over the rate limit is tried again", async () => {
  api = feishuApi();
  const bot = adapter(SECRET, 500);
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-"));
  try {
    const path = join(dir, "f");
    writeFileSync(path, "data");
    const file = { kind: "file" as const, path, name: "f.txt" };
    api.next.push({ how: "timeout" }, { how: "quota" }, { how: "denied" });
    const results: SendResult[] = [];
    for (let i = 0; i < 3; i++) results.push(await bot.send(ME, { text: "", file }));
    expect(results).toEqual([
      { status: "failed", error: expect.stringContaining("timeout") },
      { status: "failed", error: expect.stringContaining("99991403"), quota: true },
      { status: "failed", error: expect.stringContaining("230013") },
    ]);
    expect(api.sent).toEqual([]);
    api.next.push({ how: "flood", reset: 0 });
    expect(await bot.send(ME, { text: "", file })).toMatchObject({ status: "sent" });
    expect(api.uploads.map((u) => Buffer.from(u.bytes).toString())).toEqual(["data"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a picture Feishu turns down, say one too tall, goes up again as a file and out as a file message; one out of quota, over the rate limit or unanswered is not tried again", async () => {
  api = feishuApi();
  const bot = adapter(SECRET, 500);
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-"));
  try {
    const path = join(dir, "p");
    writeFileSync(path, PNG);
    const file = { kind: "image" as const, path, name: "tall.png" };
    api.next.push({ how: "resolution" });
    expect(await bot.send(ME, { text: "", file })).toMatchObject({ status: "sent" });
    expect(api.uploads.map(({ kind, fields, bytes }) => ({ kind, fields, bytes }))).toEqual([{ kind: "file", fields: { file_type: "stream", file_name: "tall.png" }, bytes: PNG }]);
    expect(sends()).toEqual([{ method: "POST", receive_id: ME, receive_id_type: "open_id", msg_type: "file", card: { file_key: api.uploads[0]!.key } }]);
    expect(logs.filter((l) => l.includes("234039"))).toHaveLength(1);
    api.next.push({ how: "quota" }, { how: "flood", reset: 61 }, { how: "timeout" });
    const results: SendResult[] = [];
    for (let i = 0; i < 3; i++) results.push(await bot.send(ME, { text: "", file }));
    expect(results).toEqual([
      { status: "failed", error: expect.stringContaining("99991403"), quota: true },
      { status: "failed", error: expect.stringContaining("230020"), flood: true },
      { status: "failed", error: expect.stringContaining("timeout") },
    ]);
    expect(api.uploads).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("story 454: the bot's avatar comes from its info; your name and avatar from the contact book, once the app may read them, else neither", async () => {
  api = feishuApi();
  const bot = adapter();
  const bytes = (s: string) => new TextEncoder().encode(s);
  expect(await bot.profile(null)).toEqual({ bot: bytes("fake bot avatar") });
  expect(await bot.profile(ME)).toEqual({ bot: bytes("fake bot avatar") });
  api.contact.granted = true;
  expect(await bot.profile(ME)).toEqual({ bot: bytes("fake bot avatar"), you: bytes("fake you-240 avatar"), name: "你" });
  expect(logs).toEqual([]);
});

test("a profile Feishu won't give is none, and why is logged without the secret", async () => {
  api = feishuApi();
  // Another app: the SDK keeps the token it got by App ID, for every client in the process.
  const bot = new FeishuAdapter("B1", "fs", { platform: "feishu", appId: "cli_fedcba9876543211", secret: "wrong-secret-never-logged", apiRoot: api.url }, { editEvery: 3000, log: (m) => logs.push(m) });
  logs.length = 0;
  expect(await bot.profile(ME)).toEqual({});
  expect(logs.filter((l) => l.startsWith("cannot get "))).toEqual([expect.stringMatching(/^cannot get the bot's info: HTTP 400 10014/), expect.stringMatching(/^cannot get your name and avatar: HTTP 400 10014/)]);
  expect(logs.filter((l) => /wrong-secret|app_secret|config/.test(l))).toEqual([]);
});

/** A row of buttons as a card has it: a column set, a column for each button, as wide as its label. */
const row = (...buttons: [label: string, data: string, muted?: true][]) => ({
  tag: "column_set",
  flex_mode: "flow",
  columns: buttons.map(([label, data, muted]) => ({
    tag: "column",
    width: "auto",
    elements: [{ tag: "button", text: { tag: "plain_text", content: label }, type: muted ? "default" : "primary", behaviors: [{ type: "callback", value: { d: data } }] }],
  })),
});

test("story 460: a card's buttons follow its text, each row a column set; a choice primary, cancel default; one that would fill the input box a button as any other", async () => {
  api = feishuApi();
  const bot = adapter();
  expect(bot.capabilities.buttons).toBe(true);
  const buttons = [
    { label: "允许", data: "ask:A1:1", row: 1 },
    { label: "拒绝", data: "ask:A1:2", row: 1 },
    { label: "改名", data: "/rh_rename", fill: "/rh_rename " },
    { label: "取消", data: "cancel", muted: true as const },
  ];
  expect(await bot.send(ME, { text: "允许吗？", markdown: "**允许吗？**", buttons })).toMatchObject({ status: "sent" });
  expect(await bot.edit(ME, "om_9", { text: "已选", buttons: buttons.slice(3) })).toMatchObject({ status: "sent" });
  expect(api.sent.map((s) => s.card.body.elements)).toEqual([
    [markdown("**允许吗？**"), row(["允许", "ask:A1:1"], ["拒绝", "ask:A1:2"]), row(["改名", "/rh_rename"]), row(["取消", "cancel", true])],
    [plain("已选"), row(["取消", "cancel", true])],
  ]);
});

test("story 460: your press comes to rhodium with the text of the card pressed; Feishu gets the notice answerPress gives as a toast, in the press's answer", async () => {
  api = feishuApi();
  const bot = adapter();
  const { next } = listen(bot);
  await api.connected();
  await bot.send(ME, { text: "要运行这条命令，允许吗？", buttons: [{ label: "允许", data: "ask:A1:1" }] });
  const card = api.sent[0]!.message_id;
  const before = Date.now();
  const id = api.press(card, "ask:A1:1");
  const m = await next();
  expect(m).toEqual({ bot: "B1", chat: ME, messageId: id, sender: ME, text: "", at: expect.any(Number), button: { data: "ask:A1:1", message: card, text: "要运行这条命令，允许吗？" } });
  expect(m.at).toBeGreaterThanOrEqual(before);
  await Bun.sleep(100);
  expect(api.acks).toEqual([]);
  await bot.answerPress(ME, id, "这个按钮已经失效了");
  await until(() => api.acks.length === 1);
  expect(api.acks).toEqual([{ event_id: id, event_type: "card.action.trigger", code: 200, data: { toast: { type: "info", content: "这个按钮已经失效了" } } }]);
});

test("story 460: a press answered with no notice gets {} at once; one not answered within 2.5 s gets {}, and a notice after that is not shown", async () => {
  api = feishuApi();
  const bot = adapter();
  const { next } = listen(bot);
  await api.connected();
  const quick = api.press("om_9", "x");
  const t0 = Date.now();
  await next();
  await bot.answerPress(ME, quick, "");
  await until(() => api.acks.length === 1);
  expect(Date.now() - t0).toBeLessThan(1000);
  const slow = api.press("om_9", "y");
  const t1 = Date.now();
  await next();
  await until(() => api.acks.length === 2, 4_000);
  expect(Date.now() - t1).toBeGreaterThanOrEqual(2400);
  await bot.answerPress(ME, slow, "晚了");
  await Bun.sleep(200);
  expect(api.acks.map((a) => [a.event_id, a.data])).toEqual([
    [quick, {}],
    [slow, {}],
  ]);
}, 10_000);

test("story 460: a press by someone else, on a card passed on to them, comes from them in their chat, not yours; one on a card the bot does not know comes without its text", async () => {
  api = feishuApi();
  const { next } = listen(adapter());
  await api.connected();
  const id = api.press("om_9", "ask:A1:1", { sender: "ou_other" });
  expect(await next()).toEqual({ bot: "B1", chat: "ou_other", messageId: id, sender: "ou_other", text: "", at: expect.any(Number), button: { data: "ask:A1:1", message: "om_9" } });
});

test("story 460: taking a card's buttons off edits it to what it last showed, with none; a card the bot does not know, say after a restart, fails", async () => {
  api = feishuApi();
  const bot = adapter();
  await bot.send(ME, { text: "选一个", markdown: "**选一个**", buttons: [{ label: "A", data: "a" }] });
  const id = api.sent[0]!.message_id;
  await bot.edit(ME, id, { text: "选一个，第 2 页", markdown: "**选一个**，第 2 页", buttons: [{ label: "B", data: "b" }] });
  expect(await bot.dropButtons(ME, id)).toEqual({ status: "sent", messageId: id });
  expect(api.sent.at(-1)).toEqual({ method: "PATCH", message_id: id, card: card(markdown("**选一个**，第 2 页"), "选一个，第 2 页") });
  expect(await adapter().dropButtons(ME, id)).toEqual({ status: "failed", error: expect.any(String) });
  expect(api.sent).toHaveLength(3);
});

test("the bot knows the last 500 cards it sent or edited: past that, the oldest one's buttons can't be taken off, nor does a press on it carry its text", async () => {
  api = feishuApi();
  const bot = adapter();
  const { next } = listen(bot);
  await api.connected();
  for (let i = 0; i < 500; i++) await bot.send(ME, { text: `第 ${i} 张`, buttons: [{ label: "A", data: "a" }] });
  const [first, second] = api.sent.map((s) => s.message_id);
  // The first, edited, is one of the last 500 again; the second is the oldest once one more is sent.
  await bot.edit(ME, first!, { text: "改过的", buttons: [{ label: "A", data: "a" }] });
  await bot.send(ME, { text: "又一张" });
  api.press(second!, "a");
  expect((await next()).button).toEqual({ data: "a", message: second! });
  expect(await bot.dropButtons(ME, second!)).toMatchObject({ status: "failed" });
  expect(await bot.dropButtons(ME, first!)).toMatchObject({ status: "sent" });
  expect(api.sent.at(-1)!.card.body.elements).toEqual([plain("改过的")]);
}, 20_000);

test("story 461: the / menu pushed makes the commands missing, in its order, changes those described otherwise, and deletes Rhodium's it no longer has; the app's own stay", async () => {
  api = feishuApi();
  api.command("deploy", "the app's own");
  api.command("stop", "an old description");
  api.command("ultracode", "开关 ultracode"); // Claude's alone
  const menu = slashMenu("pi");
  await adapter().setMenu(menu);
  const stop = menu.find((i) => i.command === "/stop")!;
  expect(api.commands.map((c) => [c.command, c.description.default_value])).toEqual([
    ["deploy", "the app's own"],
    ["stop", stop.description],
    ...menu.filter((i) => i !== stop).map((i) => [i.command.slice(1), i.description]),
  ]);
  // Pushed again as it is, nothing changes: the menu is only listed.
  const ids = api.commands.map((c) => c.command_id);
  api.menuCalls.length = 0;
  await adapter().setMenu(menu);
  expect(api.commands.map((c) => c.command_id)).toEqual(ids);
  expect(api.menuCalls).toEqual(["GET"]);
});

test("a / menu Feishu turns down fails, for rhodium to push again later", async () => {
  api = feishuApi();
  const bot = new FeishuAdapter("B1", "fs", { platform: "feishu", appId: "cli_00000000000000c3", secret: "wrong-secret-never-logged", apiRoot: api.url }, { editEvery: 3000, log: () => {} });
  await expect(bot.setMenu(slashMenu("claude"))).rejects.toThrow(/10014/);
});

// ---- The whole chain: rhodium with a Feishu bot on the fake, or the fake IM like Feishu. ----

/** Slot w/a, the target of Feishu bot fs on the fake; its cards edited at most every 400 ms.
 *  durations: more lines of [durations]. */
async function withFeishu(opts: InstanceOptions = {}, durations: string[] = []): Promise<Daemon> {
  const fs = ["[bots.fs]", 'platform = "feishu"', `appId = "${APP}"`, `secret = "${SECRET}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'];
  rhodium = newInstance({ ...opts, toml: ["[durations]", 'feishuEdit = "400ms"', ...durations, ...fs, opts.toml ?? ""].join("\n") });
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  await api.connected();
  return daemon;
}

/** What the fake claude was asked, user frame by user frame, source lines and all. */
const asked = () =>
  rhodium!.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => m.message.content[0].text as string);

/** What the progress scripts' turn shows in the end: its tools, then its reply; and in Markdown. */
const PROGRESS_SHOWN = `[🔧 Read] notes.txt\n[🔧 Bash] ls\n\n${PROGRESS_PIECES.join("").trimEnd()}`;
const PROGRESS_MD = `> [🔧 Read] \`notes.txt\`  \n> [🔧 Bash] \`ls\`\n\n${PROGRESS_PIECES.join("").trimEnd()}`;

test("stories 455, 456, 458, 467: through Feishu you talk with the slot; its turn is one card, sent once and then edited, at most every editEvery; Feishu pushing your message again does not reach the agent twice", async () => {
  api = feishuApi();
  await withFeishu({ claude: { script: "progress-fast" } });
  const m = api.say("look around");
  await until(() => api.sent.at(-1)?.card.body.elements[0].content === PROGRESS_MD, 15_000);
  const [first, ...edits] = api.sent;
  expect(first).toMatchObject({ method: "POST", receive_id: ME, receive_id_type: "open_id" });
  expect(edits.length).toBeGreaterThanOrEqual(1);
  expect(edits.every((e) => e.method === "PATCH" && e.message_id === first!.message_id)).toBe(true);
  const gaps = api.calls.slice(1).map((c, i) => c.at - api.calls[i]!.at);
  expect(gaps.filter((ms) => ms < 390)).toEqual([]);
  expect(api.sent.at(-1)!.card.config.summary).toEqual({ content: PROGRESS_PIECES.at(-1)!.slice(0, 50) });
  expect(asked()).toEqual(["[来自 飞书私聊]\nlook around"]);

  // Feishu pushes the same message again, with a new event id: acked, and not handed to the agent.
  const acked = api.acks.length;
  api.say("look around", { message_id: m.message_id, create_time: m.create_time });
  await until(() => api.acks.length > acked);
  await Bun.sleep(500);
  expect(asked()).toHaveLength(1);
  expect(api.sent.filter((s) => s.method === "POST")).toHaveLength(1);
}, 30_000);

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
/** Each user frame the fake claude was given: its text without the source line, and its pictures. */
const frames = () =>
  rhodium!.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => ({ text: withoutSource((m.message.content as Block[]).filter((b) => b.type === "text").map((b) => b.text).join("\n")), images: (m.message.content as Block[]).filter((b) => b.type === "image").map((b) => b.source) }));
/** Waits for the agent to have had n of your messages, and to be done with the last. */
async function answered(n: number): Promise<void> {
  await until(() => frames().length >= n, 15_000);
  await until(async () => (await rhodium!.state("w/a")) === "空闲", 15_000);
}
const hashed = (data: Uint8Array) => join(rhodium!.dir, "state/media", new Bun.CryptoHasher("sha256").update(data).digest("hex"));

test("stories 462, 463, 465: through Feishu a picture and a file you send reach the agent, kept by their content; replying to Rhodium's card brings its text; a voice message is answered and kept from the agent", async () => {
  api = feishuApi();
  await withFeishu();
  api.say("hi");
  await answered(1);
  await until(() => api.sent.at(-1)?.card.body?.elements[0].content === "fake reply", 15_000);
  const card = api.sent[0]!.message_id;

  api.files.set("img_k", PNG);
  api.message("image", { image_key: "img_k" });
  await answered(2);
  const log = new TextEncoder().encode("12 wicks\n");
  api.files.set("file_k", log);
  api.message("file", { file_key: "file_k", file_name: "日志.txt" });
  await answered(3);
  api.say("这里再展开", { parent_id: card });
  await answered(4);
  api.message("audio", { file_key: "file_v", duration: 3000 });
  await until(() => api.sent.some((s) => JSON.stringify(s.card).includes("暂不支持语音")), 15_000);
  await Bun.sleep(300);

  const [, image, file, reply] = frames();
  expect(image).toEqual({ text: `[图片] ${hashed(PNG)}`, images: [{ type: "base64", media_type: "image/png", data: Buffer.from(PNG).toString("base64") }] });
  expect(file).toEqual({ text: `[文件] 日志.txt：${hashed(log)}`, images: [] });
  expect(readFileSync(hashed(log))).toEqual(Buffer.from(log));
  expect(reply!.text).toBe("> fake reply\n\n这里再展开");
  expect(frames()).toHaveLength(4);
  expect(api.downloads.map((d) => [d.key, d.type])).toEqual([
    ["img_k", "image"],
    ["file_k", "file"],
  ]);
}, 60_000);

test("story 462: the agent's rh send me --file sends a picture and a PDF through Feishu, each uploaded and then a message of its own, after the text", async () => {
  api = feishuApi();
  const script: Script = { on, steps: [...startTurn, { rh: ["send", "me", "--file", "chart.png", "--file", "report.pdf", "both"] }, ...endTurn("done"), { goto: 0 }] };
  await withFeishu({ claude: { script } });
  const pdf = new TextEncoder().encode("%PDF-1.4\n");
  writeFileSync(join(rhodium!.dir, "w/chart.png"), PNG);
  writeFileSync(join(rhodium!.dir, "w/report.pdf"), pdf);
  api.say("send me both");
  await until(() => api.sent.filter((s) => s.msg_type !== "interactive").length === 2, 15_000);

  expect(api.uploads.map(({ kind, fields, bytes }) => ({ kind, fields, bytes }))).toEqual([
    { kind: "image", fields: { image_type: "message" }, bytes: PNG },
    { kind: "file", fields: { file_type: "pdf", file_name: "report.pdf" }, bytes: pdf },
  ]);
  const posts = api.sent.filter((s) => s.method === "POST").map((s) => [s.msg_type, s.msg_type === "interactive" ? s.card.body.elements[0].text?.content ?? s.card.body.elements[0].content : s.card]);
  const both = posts.findIndex(([, c]) => typeof c === "string" && c.includes("both"));
  expect(both).toBeGreaterThanOrEqual(0);
  expect(posts.slice(both + 1, both + 3)).toEqual([
    ["image", { image_key: api.uploads[0]!.key }],
    ["file", { file_key: api.uploads[1]!.key }],
  ]);
}, 30_000);

test("stories 466, 467: what you send while rhodium can't hear reaches the agent once it is back, saying when you sent it; Feishu pushing it again later does not reach the agent twice", async () => {
  api = feishuApi();
  await withFeishu({}, ['sentAtAfter = "1s"']);
  // The bot's reply names your private chat, which it backfills from then on.
  api.say("先说一句");
  await until(() => api.sent.length > 0, 15_000);
  api.link.down = true;
  api.drop();
  await until(() => !api.up());
  const m = api.say("断线时发的");
  await Bun.sleep(1200);
  api.link.down = false;
  await until(() => asked().length === 2, 15_000);
  expect(asked()[1]).toMatch(/^\[来自 飞书私聊，发送于 \d\d:\d\d\]\n断线时发的$/);
  const acked = api.acks.length;
  api.say("断线时发的", { message_id: m.message_id, create_time: m.create_time });
  await until(() => api.acks.length > acked);
  await Bun.sleep(500);
  expect(asked()).toHaveLength(2);
}, 30_000);

test("story 466: restarted, the bot backfills nothing rhodium took in before; nor once renamed, a new bot to rhodium with nothing on record", async () => {
  api = feishuApi();
  await withFeishu();
  api.say("一");
  // Not just sent: rhodium keeps your chat's id, which it backfills by, from Feishu's answer. Stopped
  // before it reads that, it has no chat to backfill.
  const db = new Database(join(rhodium!.dir, "state/rh.db"), { readonly: true });
  await until(() => db.query("SELECT 1 FROM meta WHERE id LIKE 'feishuChat:%'").all().length > 0, 15_000);
  db.close();
  for (const name of ["fs", "fs2"]) {
    await rhodium!.stop();
    writeFileSync(rhodium!.config, readFileSync(rhodium!.config, "utf8").replace(/\[bots\.fs2?\]/, `[bots.${name}]`));
    const lists = api.calls.filter((c) => c.method === "GET").length;
    await rhodium!.start();
    await until(() => api.calls.filter((c) => c.method === "GET").length > lists, 10_000);
  }
  api.say("二");
  await until(() => asked().length === 2, 15_000);
  // Under its new name it is still the config's one Feishu bot: the old name's row counts for nothing (#598).
  expect(asked()).toEqual(["[来自 飞书私聊]\n一", "[来自 飞书私聊]\n二"]);
}, 30_000);

const TG_ME = "you-tg";
const LEAD = "飞书私聊那边发不出去，改发在这里。\n\n";

/** What bot t posted in your chat with it, once the last of it shows text. */
async function lastShows(text: string, bot: string, chat: string): Promise<Posted[]> {
  await until(async () => (await rhodium!.im.log(bot, chat)).at(-1)?.text === text, 15_000);
  return rhodium!.im.log(bot, chat);
}

test("story 469: out of Feishu's quota, the turn's card goes through your other bot instead, saying why on top, and the turn edits it there; Feishu was asked once", async () => {
  api = feishuApi();
  await withFeishu({ bots: { t: { like: "telegram", owner: TG_ME } }, claude: { script: "progress-fast" } });
  api.next.push({ how: "quota" });
  api.say("look around");
  const posts = await lastShows(LEAD + PROGRESS_SHOWN, "t", TG_ME);
  expect(posts[0]!.kind).toBe("send");
  expect(posts[0]!.text).toStartWith(LEAD);
  expect(posts.slice(1).every((p) => p.kind === "edit" && p.messageId === posts[0]!.messageId && p.text.startsWith(LEAD))).toBe(true);
  expect(api.calls.map((c) => c.method)).toEqual(["POST"]);
  // The next turn tries Feishu again.
  api.say("again");
  await until(() => api.sent.length > 0 && api.sent.at(-1)?.card.body.elements[0].content === PROGRESS_MD, 15_000);
}, 30_000);

test("story 469: through a bot that can't edit (QQ), the card refused for Feishu's quota is one message, not a reply to yours on Feishu, and the turn's last text one more", async () => {
  api = feishuApi();
  const d = await withFeishu({ bots: { q: { like: "qq", owner: TG_ME } }, claude: { script: "progress-fast" } });
  api.next.push({ how: "quota" });
  api.say("look around");
  const posts = await lastShows(LEAD + PROGRESS_SHOWN, "q", TG_ME);
  expect(posts.map((p) => p.kind)).toEqual(["send", "send"]);
  expect(posts[0]!.text).toStartWith(LEAD);
  // The one on Feishu alone failed: QQ was never asked to reply to your Feishu message.
  expect(posts[0]!.replyTo).toBeUndefined();
  expect(d.logs.filter((l) => l.msg === "send failed")).toHaveLength(1);
  await Bun.sleep(500);
  expect(await rhodium!.im.log("q", TG_ME)).toHaveLength(2);
}, 30_000);

// Feishu's quota runs out mid-turn, as it most likely does: an edit is turned down, and the new card
// the turn sends instead goes through the other bot.
test("story 469: out of Feishu's quota on an edit, the turn goes on through your other bot, which edits; Feishu was asked to send, edit, and send once more", async () => {
  api = feishuApi();
  await withFeishu({ bots: { t: { like: "telegram", owner: TG_ME } }, claude: { script: "progress-fast" } });
  api.next.push({ how: "quota", method: "PATCH" }, { how: "quota", method: "POST" });
  api.say("look around");
  const posts = await lastShows(LEAD + PROGRESS_SHOWN, "t", TG_ME);
  expect(posts[0]!.kind).toBe("send");
  expect(posts.slice(1).every((p) => p.kind === "edit" && p.messageId === posts[0]!.messageId && p.text.startsWith(LEAD))).toBe(true);
  expect(api.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "POST"]);
}, 30_000);

test("story 469: out of Feishu's quota on an edit, through a bot that can't edit (QQ) the turn is one message, and its last text one more", async () => {
  api = feishuApi();
  await withFeishu({ bots: { q: { like: "qq", owner: TG_ME } }, claude: { script: "progress-fast" } });
  api.next.push({ how: "quota", method: "PATCH" }, { how: "quota", method: "POST" });
  api.say("look around");
  const posts = await lastShows(LEAD + PROGRESS_SHOWN, "q", TG_ME);
  expect(posts.map((p) => p.kind)).toEqual(["send", "send"]);
  expect(posts[0]!.text).toStartWith(LEAD);
  expect(api.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "POST"]);
}, 30_000);

test("story 469: with two Feishu bots and no other, a card refused for the quota goes through the other once, not back and forth; once the turn is over Feishu is asked no more", async () => {
  api = feishuApi();
  // A second app on the fake: its long connection is turned down, which leaves it able to send.
  const fs2 = ["[bots.fs2]", 'platform = "feishu"', 'appId = "cli_00000000000000b2"', `secret = "${SECRET}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`];
  await withFeishu({ claude: { script: "progress-fast" }, toml: fs2.join("\n") });
  api.next.push(...Array.from({ length: 1000 }, () => ({ how: "quota" as const })));
  api.say("look around");
  await until(() => asked().length === 1, 15_000);
  await until(async () => (await rhodium!.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(1000);
  const calls = api.calls.length;
  await Bun.sleep(2000);
  expect(api.calls.length).toBe(calls);
}, 30_000);

test("story 456: on the fake IM like Feishu, the turn's message is edited at most every editEvery", async () => {
  rhodium = newInstance({ bots: { f: { like: "feishu", owner: ME, target: "w/a" } }, claude: { script: "progress-fast" }, toml: '[durations]\nfeishuEdit = "500ms"' });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("f", { chat: ME, sender: ME, text: "look around" });
  const posts = await lastShows(PROGRESS_SHOWN, "f", ME);
  expect(posts.filter((p) => p.kind === "edit").length).toBeGreaterThanOrEqual(1);
  const gaps = posts.slice(1).map((p, i) => p.at - posts[i]!.at);
  expect(gaps.filter((ms) => ms < 490)).toEqual([]);
}, 30_000);

test("story 319: the board shows a Feishu chat writing tool lines in full by default, as a platform that edits its message; QQ's short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-"));
  try {
    const bots = `[bots.fs]\nplatform = "feishu"\nappId = "${APP}"\nsecret = "${SECRET}"\n[bots.q]\nplatform = "qq"\nappId = "1"\n`;
    writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n${bots}`, { mode: 0o600 });
    const store = openStore(join(dir, "rh.db"));
    store.tx((tx) => {
      for (const [name, platform] of [["fs", "feishu"], ["q", "qq"]] as const) {
        const bot = tx.insert("bot", { platform, name, isMain: 0, owners: JSON.stringify([ME]) }).id;
        tx.insert("chat", { bot, platformChatId: ME });
      }
    });
    const server = serveBoard(store, loadConfig(join(dir, "config.toml")));
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/topology`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
      const g = (await res.json()) as { bots: { id: string; name: string; platform: string }[]; chats: { bot: string; verbose: boolean }[] };
      const verbose = (name: string) => g.chats.find((c) => c.bot === g.bots.find((b) => b.name === name)!.id)!.verbose;
      expect(g.bots.find((b) => b.name === "fs")!.platform).toBe("feishu");
      expect([verbose("fs"), verbose("q")]).toEqual([true, false]);
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stories 460, 82: through Feishu an ask's options are buttons on its card; your press is answered, reaches the agent, and the card shows the answer with no buttons; pressed again, it says it no longer works", async () => {
  api = feishuApi();
  await withFeishu({ claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  api.say("build it");
  const asks = () => api.sent.filter((s) => s.card.body.elements.length > 1);
  await until(() => asks().length > 0, 15_000);
  const ask = asks()[0]!;
  const buttons = ask.card.body.elements.slice(1).map((r: any) => r.columns.map((c: any) => [c.elements[0].text.content, c.elements[0].behaviors[0].value.d]));
  expect(buttons.map((r: string[][]) => r.map(([label]) => label))).toEqual([["允许", "拒绝"]]);
  const first = api.press(ask.message_id, buttons[0][0][1]);
  await until(() => api.sent.some((s) => s.card.body.elements[0].content?.includes("answered")), 15_000);
  await until(() => api.sent.some((s) => s.method === "PATCH" && s.message_id === ask.message_id && s.card.body.elements.length === 1), 15_000);
  expect(api.acks.find((a) => a.event_id === first)!.data).toEqual({});
  const again = api.press(ask.message_id, buttons[0][0][1]);
  await until(() => api.acks.some((a) => a.event_id === again), 5_000);
  expect(api.acks.find((a) => a.event_id === again)!.data).toEqual({ toast: { type: "info", content: "这个按钮已经失效了" } });
  expect(asked()).toHaveLength(1);
}, 30_000);

test("story 461: rhodium pushes the / menu of the agent your Feishu chat goes to, and pushes it anew as you switch agents", async () => {
  api = feishuApi();
  await withFeishu();
  const menu = (agent: "claude" | "pi") => slashMenu(agent).map((i) => i.command.slice(1)).sort();
  const names = () => api.commands.map((c) => c.command).sort();
  await until(() => Bun.deepEquals(names(), menu("claude")), 10_000);
  api.say("/rh_agent pi");
  await until(() => Bun.deepEquals(names(), menu("pi")), 10_000);
}, 30_000);

test("story 460: on the fake IM like Feishu, a panel's press shows its next step in place at once, not after editEvery", async () => {
  rhodium = newInstance({ bots: { f: { like: "feishu", owner: ME, target: "w/a" } }, toml: '[durations]\nfeishuEdit = "10s"' });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await rhodium.im.inject("f", { chat: ME, sender: ME, text: "/rh_use" });
  await until(async () => (await rhodium!.im.shown("f", ME)).length === 1, 15_000);
  const [panel] = await rhodium.im.shown("f", ME);
  await rhodium.im.press("f", ME, panel!, "w/b");
  await until(async () => (await rhodium!.im.shown("f", ME))[0]?.text === "这里的消息交给谁？\n已选：w/b", 5_000);
}, 30_000);
