import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { Capabilities, ImAdapter, InboundMessage, SendResult } from "../src/contracts";
import { FakeBot, FakeIm, FakeImClient, fakeCapabilities, fakeLike, type PlatformBotOptions } from "../src/fake-im";
import { QQAdapter, type QQClient } from "../src/qq";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-fake-im-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const open: { close(): void }[] = [];
afterEach(() => open.splice(0).reverse().forEach((x) => x.close()));

let n = 0;
/** The platform runs here in the test process, as in whole-system tests; rhodium's adapters connect to it. */
function platform() {
  const path = join(dir, `im-${n++}.sock`);
  const im = new FakeIm(path);
  open.push(im);
  /** Rhodium's adapter for the bot the platform knows as name; a new one is a restarted rhodium. */
  const connect = (opts: { id?: string; name: string; capabilities: Capabilities }) => {
    const bot = new FakeBot(path, { id: "B1", ...opts });
    open.push(bot);
    return bot;
  };
  /** Set the bot up on the platform, then connect rhodium to it. */
  const fake = (opts: PlatformBotOptions & { id?: string }) => {
    im.bot(opts);
    return connect(opts);
  };
  return { im, client: new FakeImClient(path), fake, connect };
}

/** Pull the next inbound message, failing instead of hanging when none comes. */
function inbox(bot: ImAdapter) {
  const it = bot.messages()[Symbol.asyncIterator]();
  return () =>
    Promise.race([
      it.next().then((r) => r.value as InboundMessage),
      Bun.sleep(1000).then(() => {
        throw new Error("no inbound message within 1s");
      }),
    ]);
}

test("an injected message comes out of the bot's inbound stream with its message id, sender and chat", async () => {
  const { fake, client } = platform();
  const bot = fake({ id: "B1", name: "main", capabilities: fakeLike.telegram });
  const next = inbox(bot);

  const { messageId } = await client.inject("main", { chat: "c1", sender: "u1", text: "hello" });

  expect(await next()).toMatchObject({ bot: "B1", chat: "c1", sender: "u1", messageId, text: "hello" });
});

test("the same platform message id injected twice comes out twice; dedup is Rhodium's job", async () => {
  const { fake, client } = platform();
  const next = inbox(fake({ name: "main", capabilities: fakeLike.qq }));

  await client.inject("main", { chat: "c1", sender: "u1", text: "hi", messageId: "qq-77" });
  await client.inject("main", { chat: "c1", sender: "u1", text: "hi", messageId: "qq-77" });

  expect((await next()).messageId).toBe("qq-77");
  expect((await next()).messageId).toBe("qq-77");
});

test("images, files, quotes and button presses come through", async () => {
  const { fake, client } = platform();
  const next = inbox(fake({ name: "main", capabilities: fakeLike.telegram }));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);

  await client.inject("main", {
    chat: "c1",
    sender: "u1",
    text: "look",
    attachments: [
      { kind: "image", data: png },
      { kind: "file", name: "../notes.txt", data: new TextEncoder().encode("笔记") },
    ],
    quote: { ref: "m9", text: "earlier" },
  });
  await client.inject("main", { chat: "c1", sender: "u1", text: "", button: { data: "allow:r1", message: "m3" } });

  const media = await next();
  const attachments = await Promise.all(media.attachments!.map(async ({ fetch, ...a }) => ({ ...a, data: await fetch() })));
  expect(attachments).toEqual([
    { kind: "image", data: png },
    { kind: "file", name: "../notes.txt", data: new TextEncoder().encode("笔记") },
  ]);
  expect(media.quote).toEqual({ ref: "m9", text: "earlier" });
  expect((await next()).button).toEqual({ data: "allow:r1", message: "m3" });
});

/** The platform message id of a send that went through. */
function sent(r: SendResult): string {
  if (r.status !== "sent") throw new Error(`expected sent, got ${r.status}: ${r.error}`);
  return r.messageId!;
}

test("sends, edits, buttons and menus read back from the socket, per chat and in order", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  const allow = [{ label: "Allow", data: "allow:r1" }];

  const id = sent(await bot.send("c1", { text: "working…", replyTo: "m1" }));
  const other = sent(await bot.send("c2", { text: "elsewhere" }));
  expect(await bot.edit("c1", id, { text: "done", buttons: allow })).toEqual({ status: "sent", messageId: id });
  await bot.setMenu([{ command: "rh_use", description: "switch slot" }], "c1");
  await bot.setMenu([{ command: "new", description: "new conversation" }]);

  expect(await client.log("main", "c1")).toMatchObject([
    { kind: "send", messageId: id, text: "working…", replyTo: "m1" },
    { kind: "edit", messageId: id, text: "done", buttons: allow },
  ]);
  expect(await client.log("main", "c2")).toMatchObject([{ kind: "send", messageId: other, text: "elsewhere" }]);
  expect(await client.log("main", "c3")).toEqual([]);
  // A chat's own menu wins; other chats see the bot-wide one.
  expect(await client.menu("main", "c1")).toEqual([{ command: "rh_use", description: "switch slot" }]);
  expect(await client.menu("main", "c2")).toEqual([{ command: "new", description: "new conversation" }]);
});

test("the next sends can be set to succeed, fail or time out; a timed-out send still reached the chat", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  await client.next("main", "ok");
  await client.next("main", "fail");
  await client.next("main", "timeout");

  const a = sent(await bot.send("c1", { text: "a" }));
  expect(await bot.send("c1", { text: "b" })).toMatchObject({ status: "failed" });
  expect(await bot.send("c1", { text: "c" })).toMatchObject({ status: "unknown" });
  const d = sent(await bot.send("c1", { text: "d" })); // the queue is used up

  const log = await client.log("main", "c1");
  expect(log.map((p) => p.text)).toEqual(["a", "c", "d"]);
  expect(log.map((p) => p.messageId)).toContain(a);
  expect(log.map((p) => p.messageId)).toContain(d);
});

test("a send set to hang reaches the chat, and its request gets no answer for as long as the bot waits", async () => {
  const { fake, client, connect } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.qq });
  await client.next("main", "hang");
  let answered = false;
  void bot.send("c1", { text: "a" }).then(() => (answered = true));
  await Bun.sleep(300);
  expect((await client.log("main", "c1")).map((p) => p.text)).toEqual(["a"]);
  expect(answered).toBe(false);
  // The bot hanging up, as a rhodium killed mid-send does, ends it; the next send goes as ever.
  bot.close();
  sent(await connect({ name: "main", capabilities: fakeLike.qq }).send("c1", { text: "b" }));
});

test("an outcome set for edits waits for the next edit and leaves sends alone", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  await client.next("main", "fail", "edit");

  const id = sent(await bot.send("c1", { text: "a" }));
  expect(await bot.edit("c1", id, { text: "b" })).toMatchObject({ status: "failed" });
  expect(await bot.edit("c1", id, { text: "c" })).toMatchObject({ status: "sent" });
  expect((await client.log("main", "c1")).map((p) => p.text)).toEqual(["a", "c"]);
});

test("the socket turns down a malformed outcome or connection request instead of quietly doing nothing", async () => {
  const { fake, client } = platform();
  fake({ name: "main", capabilities: fakeLike.telegram });

  await expect(client.next("main", "maybe" as never)).rejects.toThrow(/outcome/);
  await expect(client.next("main", "fail", "edits" as never)).rejects.toThrow(/on/);
  await expect(client.connection("main", "false" as never)).rejects.toThrow(/up/);
});

test("set to QQ, the platform refuses edits, taking buttons off, more buttons than it shows, and per-chat menus; it takes presses", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.qq });
  const id = sent(await bot.send("c1", { text: "a" }));

  expect(await bot.edit("c1", id, { text: "b" })).toMatchObject({ status: "failed" });
  const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `${i + 1}`, data: `${i + 1}` }));
  const pick = sent(await bot.send("c1", { text: "pick", buttons: buttons(11) }));
  expect(await bot.send("c1", { text: "pick more", buttons: buttons(12) })).toMatchObject({ status: "failed" });
  expect(await bot.dropButtons("c1", pick)).toMatchObject({ status: "failed" });
  await expect(bot.setMenu([{ command: "new", description: "new conversation" }], "c1")).rejects.toThrow();
  await client.inject("main", { chat: "c1", sender: "u1", text: "", button: { data: "1", message: "" } });

  expect((await client.log("main", "c1")).map((p) => [p.kind, p.text])).toEqual([["send", "a"], ["send", "pick"]]);
  expect(await client.menu("main", "c1")).toBeNull();
});

test("set to QQ, the platform shows a keyboard on a Markdown message only, as QQ does (2026-10-22): buttons on plain text are marked hidden, and cannot be pressed", async () => {
  const { im, client, connect } = platform();
  im.bot({ name: "main", capabilities: fakeLike.qq });
  // An adapter that sends plain text with buttons, as Rhodium's QQ adapter did before.
  const before = connect({ name: "main", capabilities: fakeLike.telegram });
  const buttons = [{ label: "允许", data: "ask:A1:1" }];
  await before.send("c1", { text: "允许吗？", buttons });
  await before.send("c1", { text: "允许吗？", markdown: "允许吗？", buttons });
  const [plain, md] = await client.log("main", "c1");
  expect([plain!.buttonsHidden, md!.buttonsHidden]).toEqual([true, undefined]);
  await expect(client.press("main", "c1", plain!, "允许")).rejects.toThrow(/no keyboard/);
  await expect(client.press("main", "c1", md!, "允许")).resolves.toMatchObject({ messageId: expect.any(String) });

  // Rhodium's QQ-like bot sends a message with buttons as Markdown that shows its text as written, as the QQ adapter does.
  const bot = connect({ name: "main", capabilities: fakeLike.qq });
  await bot.send("c1", { text: "*允许*吗？", buttons });
  await bot.send("c1", { text: "*好*" });
  expect((await client.log("main", "c1")).slice(2)).toEqual([
    expect.objectContaining({ text: "*允许*吗？", markdown: "\\*允许\\*吗？", buttons }),
    expect.not.objectContaining({ markdown: expect.anything() }),
  ]);
  expect((await client.log("main", "c1"))[2]!.buttonsHidden).toBeUndefined();
});

test("a fake bot like QQ has the real QQ adapter's capability table", () => {
  const client = { on: () => client, start: async () => {}, send: async () => ({ id: "", timestamp: 0 }), api: { getToken: async () => "" } } as unknown as QQClient;
  expect(fakeLike.qq).toEqual(new QQAdapter("b", "q", { platform: "qq" }, { client }).capabilities);
});

test("both platforms refuse text over their length limit and menus over their item limit", async () => {
  for (const caps of [fakeLike.qq, fakeLike.telegram]) {
    const { fake } = platform();
    const bot = fake({ name: "main", capabilities: caps });
    expect(await bot.send("c1", { text: "x".repeat(caps.maxTextLength) })).toMatchObject({ status: "sent" });
    expect(await bot.send("c1", { text: "x".repeat(caps.maxTextLength + 1) })).toMatchObject({ status: "failed" });
    const items = Array.from({ length: caps.menu.maxItems + 1 }, (_, i) => ({ command: `c${i}`, description: "" }));
    await expect(bot.setMenu(items)).rejects.toThrow();
    await expect(bot.setMenu(items.slice(1))).resolves.toBeUndefined();
  }
});

test("set to QQ, each inbound message allows 20 passive replies within the window by default; active sends are not counted", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.qq, passiveWindowMs: 60_000 });
  const { messageId: m1 } = await client.inject("main", { chat: "c1", sender: "u1", text: "go" });

  await client.next("main", "timeout"); // the platform took it, so it counts
  expect(await bot.send("c1", { text: "r0", replyTo: m1 })).toMatchObject({ status: "unknown" });
  const replies = Array.from({ length: 20 }, (_, i) => `r${i}`);
  for (const text of replies.slice(1)) sent(await bot.send("c1", { text, replyTo: m1 }));
  // Refused for the quota, as QQ does, so rhodium can tell it from other refusals.
  expect(await bot.send("c1", { text: "r20", replyTo: m1 })).toMatchObject({ status: "failed", quota: true });

  // No replies to a message the platform never delivered to this chat, or one past the window.
  expect(await bot.send("c1", { text: "x", replyTo: "nope" })).toMatchObject({ status: "failed", quota: true });
  expect(await bot.send("c2", { text: "x", replyTo: m1 })).toMatchObject({ status: "failed", quota: true });
  const old = await client.inject("main", { chat: "c1", sender: "u1", text: "old", at: Date.now() - 61_000 });
  expect(await bot.send("c1", { text: "late", replyTo: old.messageId })).toMatchObject({ status: "failed", quota: true });
  // Refused for anything else, it is not about the quota.
  expect(await bot.send("c1", { text: "x".repeat(fakeLike.qq.maxTextLength + 1), replyTo: m1 })).toEqual({
    status: "failed",
    error: `fake-im: text is over ${fakeLike.qq.maxTextLength} characters`,
  });

  sent(await bot.send("c1", { text: "active" }));
  expect((await client.log("main", "c1")).map((p) => p.text)).toEqual([...replies, "active"]);
});

test("a QQ-like bot can be set to allow fewer passive replies than its default 20", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.qq, passiveReplies: 1 });
  const { messageId } = await client.inject("main", { chat: "c1", sender: "u1", text: "go" });
  sent(await bot.send("c1", { text: "r0", replyTo: messageId }));
  expect(await bot.send("c1", { text: "r1", replyTo: messageId })).toMatchObject({ status: "failed", quota: true });
});

test("set to Telegram, replies are not counted", async () => {
  const { fake } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  for (let i = 0; i < 6; i++) sent(await bot.send("c1", { text: `r${i}`, replyTo: "m-from-yesterday" }));
});

test("while a bot's connection is down nothing gets through either way; other bots carry on", async () => {
  const { fake, client } = platform();
  const bot = fake({ id: "B1", name: "main", capabilities: fakeLike.telegram });
  const other = fake({ id: "B2", name: "second", capabilities: fakeLike.qq });
  const next = inbox(bot);
  const id = sent(await bot.send("c1", { text: "a" }));

  await client.connection("main", false);
  await expect(client.inject("main", { chat: "c1", sender: "u1", text: "lost" })).rejects.toThrow(/connected/);
  expect(await bot.send("c1", { text: "b" })).toMatchObject({ status: "failed" });
  expect(await bot.edit("c1", id, { text: "b" })).toMatchObject({ status: "failed" });
  await expect(bot.setMenu([])).rejects.toThrow(/connected/);
  sent(await other.send("c1", { text: "fine" }));

  await client.connection("main", true);
  await client.inject("main", { chat: "c1", sender: "u1", text: "back" });
  expect((await next()).text).toBe("back");
  sent(await bot.send("c1", { text: "c" }));
  expect((await client.log("main", "c1")).map((p) => p.text)).toEqual(["a", "c"]);
});

test("a bot set never to connect before rhodium starts gets nothing through until it is let in", async () => {
  const { im, client, connect } = platform();
  im.bot({ name: "main", capabilities: fakeLike.telegram });
  await client.connection("main", false);

  const bot = connect({ name: "main", capabilities: fakeLike.telegram });
  const next = inbox(bot);
  await expect(bot.setMenu([{ command: "new", description: "new conversation" }])).rejects.toThrow(/connected/);
  expect(await bot.send("c1", { text: "a" })).toMatchObject({ status: "failed" });
  await expect(client.inject("main", { chat: "c1", sender: "u1", text: "lost" })).rejects.toThrow(/connected/);

  await client.connection("main", true);
  await client.inject("main", { chat: "c1", sender: "u1", text: "in" });
  expect((await next()).text).toBe("in");
});

test("the platform outlives a rhodium restart: ids keep counting, old messages can still be edited and replied to, and the log is kept", async () => {
  const { im, client, connect } = platform();
  im.bot({ name: "tg", capabilities: fakeLike.telegram });
  im.bot({ name: "qq", capabilities: fakeLike.qq, passiveReplies: 4 });
  const tg = connect({ name: "tg", capabilities: fakeLike.telegram });
  const qq = connect({ name: "qq", capabilities: fakeLike.qq });
  const { messageId: asked } = await client.inject("qq", { chat: "c1", sender: "u1", text: "go" });
  expect((await inbox(qq)()).messageId).toBe(asked);
  const progress = sent(await tg.send("c1", { text: "working…" }));
  for (const text of ["r1", "r2"]) sent(await qq.send("c1", { text, replyTo: asked }));
  await client.next("tg", "fail");

  // kill -9: rhodium's adapters are gone, the platform is not; a new rhodium connects again.
  tg.close();
  qq.close();
  const tg2 = connect({ name: "tg", capabilities: fakeLike.telegram });
  const qq2 = connect({ name: "qq", capabilities: fakeLike.qq });

  const { messageId: fresh } = await client.inject("qq", { chat: "c1", sender: "u1", text: "again" });
  expect(new Set([asked, progress, fresh]).size).toBe(3);
  // Taken by the old rhodium but never finished with, so it comes again; dedup is Rhodium's job.
  const next = inbox(qq2);
  expect((await next()).messageId).toBe(asked);
  expect((await next()).messageId).toBe(fresh);

  expect(await tg2.edit("c1", progress, { text: "done" })).toMatchObject({ status: "failed" }); // queued before
  sent(await tg2.edit("c1", progress, { text: "done" }));
  for (const text of ["r3", "r4"]) sent(await qq2.send("c1", { text, replyTo: asked }));
  expect(await qq2.send("c1", { text: "r5", replyTo: asked })).toMatchObject({ status: "failed" });
  expect((await client.log("tg", "c1")).map((p) => p.text)).toEqual(["working…", "done"]);
  expect((await client.log("qq", "c1")).map((p) => p.text)).toEqual(["r1", "r2", "r3", "r4"]);
});

test("rhodium's adapter keeps trying until the platform is there", async () => {
  const path = join(dir, `im-${n++}.sock`);
  const bot = new FakeBot(path, { id: "B1", name: "main", capabilities: fakeLike.telegram });
  open.push(bot);
  const first = inbox(bot)();
  expect(await bot.send("c1", { text: "a" })).toMatchObject({ status: "failed" });
  await Bun.sleep(150);

  const im = new FakeIm(path);
  open.push(im);
  im.bot({ name: "main", capabilities: fakeLike.telegram });
  await new FakeImClient(path).inject("main", { chat: "c1", sender: "u1", text: "up now" });
  expect((await first).text).toBe("up now");
});

test("generated message ids never take an id a test picks", async () => {
  const { fake, client } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  for (const messageId of ["m1", "m2", "1", "2"]) await client.inject("main", { chat: "c1", sender: "u1", text: "", messageId });

  const ids = [sent(await bot.send("c1", { text: "a" })), (await client.inject("main", { chat: "c1", sender: "u1", text: "" })).messageId];
  for (const id of ids) expect(["m1", "m2", "1", "2"]).not.toContain(id);
});

test("the config file enables several fake bots, each set to look like QQ or Telegram", async () => {
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[durations]\nqqPassiveWindow = "2s"\n\n` +
      `[bots.qq]\nplatform = "fake"\nlike = "qq"\n\n[bots.tg]\nplatform = "fake"\nlike = "telegram"\n`,
  );
  chmodSync(path, 0o600);
  const config = loadConfig(path, { HOME: dir });
  const { fake, client } = platform();
  const [qq, tg] = Object.entries(config.bots).map(([name, bot]) =>
    fake({ id: name, name, capabilities: fakeCapabilities(bot), passiveWindowMs: config.durations.qqPassiveWindow }),
  );

  const m = await client.inject("qq", { chat: "c1", sender: "u1", text: "hi", at: Date.now() - 3000 });
  expect(await qq!.send("c1", { text: "late", replyTo: m.messageId })).toMatchObject({ status: "failed" });
  const id = sent(await tg!.send("c1", { text: "a" }));
  sent(await tg!.edit("c1", id, { text: "b" }));

  expect(() => fakeCapabilities({ platform: "fake" })).toThrow(/like/);
  expect(() => fakeCapabilities({ platform: "fake", like: "wechat" })).toThrow(/like/);
});

test("editing a message the bot never sent in that chat fails", async () => {
  const { fake } = platform();
  const bot = fake({ name: "main", capabilities: fakeLike.telegram });
  const id = sent(await bot.send("c1", { text: "a" }));

  expect((await bot.edit("c2", id, { text: "b" })).status).toBe("failed");
  expect((await bot.edit("c1", "nope", { text: "b" })).status).toBe("failed");
});
