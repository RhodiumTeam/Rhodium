// Parts adapted from qq-cli's test/qq.test.ts (github.com/Rhapsody0x1/qq-cli).
// MIT License, Copyright (c) 2026 Rhapsody0x1; full notice in src/qq.ts.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, MediaFileType, QQBot, type MessageResponse, type SendMessageOptions } from "@tencent-connect/qqbot-nodejs";
import type { ServerWebSocket } from "bun";
import type { InboundMessage } from "../src/contracts";
import { QQ_ROW, slashMenu } from "../src/commands";
import { kept } from "../src/daemon";
import { msgSeq, QQAdapter, qqClient, qqSession, type QQClient } from "../src/qq";
import { literal } from "../src/render";
import { openStore } from "../src/store";

const creds = { platform: "qq" as const, appId: "1", secret: "s" };

/** Stands in for the SDK's QQBot: records sends and uploads, lets a test push events and fail starts. */
function fakeClient(o: { send?: (opts: SendMessageOptions) => Promise<MessageResponse> } = {}) {
  const sent: SendMessageOptions[] = [];
  const uploads: Parameters<QQClient["uploadMedia"]>[0][] = [];
  const acks: [string, number][] = [];
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const client = {
    on(event: string, h: (...a: any[]) => void) {
      (handlers[event] ??= []).push(h);
      return client;
    },
    start: (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener("abort", () => r())),
    async send(opts: SendMessageOptions) {
      sent.push(opts);
      return o.send ? o.send(opts) : { id: `out${sent.length}`, timestamp: 0 };
    },
    async uploadMedia(opts: Parameters<QQClient["uploadMedia"]>[0]) {
      uploads.push(opts);
      return { file_uuid: "u", file_info: `info${uploads.length}`, ttl: 60 };
    },
    async acknowledgeInteraction(id: string, code: number) {
      acks.push([id, code]);
    },
    api: { getToken: async () => "T" },
  } as QQClient;
  const emit = (event: string, ...a: unknown[]) => handlers[event]?.forEach((h) => h(...a));
  return { client, sent, uploads, acks, emit };
}

/** download: how attachments are fetched; by default every URL holds its own name's bytes. */
const adapter = (client: QQClient, delays?: number[], download = async (url: string) => new TextEncoder().encode(url)) =>
  new QQAdapter("bot1", "dev", creds, { client, delays, log: () => {}, download });

// Adapted from "deliver: no last msg → active" and "daemon send uses the latest msg_id as a passive reply".
test("send: a reply to an inbound message goes passive, anything else goes active", async () => {
  const { client, sent } = fakeClient();
  const a = adapter(client);
  expect(await a.send("U1", { text: "x", seq: 7 })).toEqual({ status: "sent", messageId: "out1" });
  expect(await a.send("U1", { text: "y", seq: 8, replyTo: "M7" })).toEqual({ status: "sent", messageId: "out2" });
  expect(sent.map((s) => [s.target, s.content])).toEqual([
    [{ scope: "c2c", targetId: "U1" }, "x"],
    [{ scope: "c2c", targetId: "U1", msgId: "M7" }, "y"],
  ]);
});

test("the same outbound record sent twice passes the SDK the same msg_seq", async () => {
  const { client, sent } = fakeClient();
  const a = adapter(client);
  const record = "01JB5Z8Q9W3X4Y5Z6A7B8C9D0E"; // outbound ids are ULIDs
  for (let i = 0; i < 2; i++) await a.send("U1", { text: "x", replyTo: "M1", seq: msgSeq(record) });
  const [first, second] = sent.map((s) => s.extra?.msg_seq);
  expect(first).toBe(msgSeq(record));
  expect(second).toBe(first);
  expect(msgSeq("01JB5Z8Q9W3X4Y5Z6A7B8C9D0F")).not.toBe(first);
  for (const id of ["", "a", record, "z".repeat(100)]) {
    expect(msgSeq(id)).toBeGreaterThanOrEqual(1);
    expect(msgSeq(id)).toBeLessThanOrEqual(2 ** 31 - 1); // QQ took 100000 (probe 13); the SDK's own stop at 65535
  }
});

test("the replies to one message get msg_seqs of their own, so QQ drops none of them as a resend", () => {
  // QQ dedupes on msg_id + msg_seq (probe 13); a message takes 20 replies and more (probe 12).
  const records = Array.from({ length: 1000 }, (_, i) => `01JB5Z8Q9W3X4Y5Z6A7B8C${String(i).padStart(4, "0")}`);
  expect(new Set(records.map(msgSeq)).size).toBe(records.length);
});

test("a message without seq is refused, so the SDK never falls back to a random msg_seq", async () => {
  const { client, sent } = fakeClient();
  const r = await adapter(client).send("U1", { text: "x", replyTo: "M1" });
  expect(r.status).toBe("failed");
  expect(sent).toEqual([]);
});

test("the real SDK puts our msg_seq on the wire instead of its random one", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app/getAppAccessToken") return Response.json({ access_token: "t", expires_in: 7200 });
      bodies.push(await req.json());
      return Response.json({ id: "srv1", timestamp: 0 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const bot = new QQBot({ appId: "1", appSecret: "s", baseUrl: url, tokenBaseUrl: url });
    const a = adapter(bot);
    expect(await a.send("U1", { text: "x", replyTo: "M1", seq: 4242 })).toEqual({ status: "sent", messageId: "srv1" });
    await a.send("U1", { text: "x", replyTo: "M1", seq: 4242 });
    expect(bodies).toEqual([
      { msg_id: "M1", content: "x", msg_seq: 4242, msg_type: 0 },
      { msg_id: "M1", content: "x", msg_seq: 4242, msg_type: 0 },
    ]);
  } finally {
    server.stop(true);
  }
});

/** The real SDK against a local stand-in for QQ's API: what reaches the wire, request by request. */
async function onTheWire(run: (bot: QQBot) => Promise<unknown>): Promise<{ method: string; path: string; body: unknown }[]> {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app/getAppAccessToken") return Response.json({ access_token: "t", expires_in: 7200 });
      requests.push({ method: req.method, path, body: await req.json() });
      return Response.json({ id: "srv1", timestamp: 0 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await run(new QQBot({ appId: "1", appSecret: "s", baseUrl: url, tokenBaseUrl: url }));
    return requests;
  } finally {
    server.stop(true);
  }
}

const callback = (id: string, label: string, data: string, style = 1) => ({
  id,
  render_data: { label, visited_label: `✓ ${label}`, style },
  action: { type: 1, permission: { type: 2 }, data },
});

test("story 75: buttons go as a keyboard of callback buttons in their rows, each with its label and data; pressed, it reads ✓", async () => {
  const buttons = [
    { label: "允许", data: "ask:A1:1", row: 0 },
    { label: "拒绝", data: "ask:A1:2", row: 0 },
  ];
  const [plain, md, none] = await onTheWire(async (bot) => {
    await adapter(bot).send("U1", { text: "审批？", seq: 7, replyTo: "M1", buttons });
    await adapter(bot).send("U1", { text: "审批？", markdown: "**审批？**", seq: 8, replyTo: "M1", buttons });
    await adapter(bot).send("U1", { text: "审批？", seq: 9, replyTo: "M1" });
  });
  const keyboard = { content: { rows: [{ buttons: [callback("1", "允许", "ask:A1:1"), callback("2", "拒绝", "ask:A1:2")] }] } };
  // QQ shows a keyboard on a Markdown message only (2026-10-22, on a phone), so plain text with
  // buttons goes as Markdown too; plain text without any goes as it did.
  expect(plain!.body).toEqual({ msg_id: "M1", msg_type: 2, markdown: { content: "审批？" }, keyboard, msg_seq: 7 });
  expect(md!.body).toEqual({ msg_id: "M1", msg_type: 2, markdown: { content: "**审批？**" }, keyboard, msg_seq: 8 });
  expect(none!.body).toEqual({ msg_id: "M1", content: "审批？", msg_seq: 9, msg_type: 0 });
});

test("the button marked ★, the one in use when the panel was sent, reads ✓ and its label without the ★ once pressed: ✓ is only for a button you pressed", async () => {
  const [sent] = await onTheWire(async (bot) => {
    await adapter(bot).send("U1", { text: "模型？", seq: 1, buttons: [{ label: "★ opus", data: "m:1", row: 0 }, { label: "sonnet", data: "m:2", row: 0 }, { label: "★ 4. haiku", data: "m:3", row: 0 }] });
  });
  const rendered = (label: string, visited_label: string) => ({ render_data: { label, visited_label, style: 1 } });
  expect(sent!.body).toMatchObject({ keyboard: { content: { rows: [{ buttons: [rendered("★ opus", "✓ opus"), rendered("sonnet", "✓ sonnet"), rendered("★ 4. haiku", "✓ 4. haiku")] }] } } });
});

/** What a Markdown reader shows of md, Bun's GFM one standing in for QQ's: its text, a line break for
 *  each hard break, a blank line between paragraphs. Throws on anything it shows as formatting.
 *  Where the two differ, the phone test (2026-10-22) wins, and the literal() tests above hold it:
 *  Bun shows `\[` as `[` and keeps the space after an escape, QQ shows the backslash and eats the
 *  space. A no-break space and a zero-width one show as a space and nothing. */
function shownAs(md: string): string {
  const html = Bun.markdown.html(md);
  const formatting = html.match(/<(?!\/?p>|br \/>)[^>]*>/g);
  if (formatting) throw new Error(`shown as formatting: ${formatting.join(" ")}\n${html}`);
  return html
    .replace(/<br \/>\n/g, "\n")
    .replace(/<\/p>\n<p>/g, "\n\n")
    .replace(/<\/?p>\n?/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("\u00a0", " ")
    .replaceAll("\u200b", "");
}

test("Rhodium's own text with buttons shows on QQ as written: what Markdown takes as formatting is escaped, and each line break stays", async () => {
  const text = [
    "# 不是标题",
    "*重要*、**粗**、_斜_、~~删~~、`代码`、[链接](https://x.y)、<https://x.y>、a\\b、x_y_z",
    "> 不是引用",
    "- 不是列表",
    "+ 也不是",
    "1. 不是编号",
    "2) 也不是",
    "",
    "    缩进的命令 a*b*c",
    "===",
    "&amp; 原样",
    "",
    "[注意]: 不是链接定义",
    "[注意] 不是链接",
  ].join("\n");
  expect(() => shownAs(text)).toThrow(); // as it is, it would not show as written
  const [sent] = await onTheWire(async (bot) => void (await adapter(bot).send("U1", { text, seq: 7, replyTo: "M1", buttons: [{ label: "好", data: "ok" }] })));
  expect(shownAs((sent!.body as any).markdown.content)).toBe(text);
});

// The message looked at on a phone (2026-10-22). As it then went, every escape showed as written but
// ate the space after it ("*星号*_下划线_", "#井号开头"), and `\[方括号\]` showed its backslashes; the
// hard breaks, the blank line and the no-break-space indent showed right.
test("the message from the phone test goes so that QQ shows it as written", () => {
  const text = ["按钮测试 E（转义）", "第二行：*星号* _下划线_ `反引号` [方括号]", "# 井号开头", "> 大于号开头", "- 减号开头", "1. 数字加点开头", "    四个空格缩进", "", "空一行之后的最后一行"].join("\n");
  expect(literal(text)).toBe(
    "按钮测试 E（转义）  \n" +
      "第二行：\\*星号\\*\u00a0\\_下划线\\_\u00a0\\`反引号\\`\u00a0[方括号]  \n" +
      "\\#\u00a0井号开头  \n" +
      "\\>\u00a0大于号开头  \n" +
      "\\-\u00a0减号开头  \n" +
      "1\\.\u00a0数字加点开头  \n" +
      "\u00a0\u00a0\u00a0\u00a0四个空格缩进\n" +
      "\n" +
      "空一行之后的最后一行",
  );
});

// On a phone (2026-10-22) QQ ate the one space right after an escape: `\* a` showed as `*a`.
test("a space right after an escape goes as a no-break space, which QQ keeps", () => {
  expect(literal("*星号* _下划线_ x")).toBe("\\*星号\\*\u00a0\\_下划线\\_\u00a0x");
  expect(literal("# 井号\n1. 数字")).toBe("\\#\u00a0井号  \n1\\.\u00a0数字");
  expect(literal("a\\ b, a\\b c")).toBe("a\\\\\u00a0b, a\\\\b c"); // the space after `b` follows no escape
  // A line ending in an escape: the hard break's two spaces stay whole after a no-break space.
  expect(literal("a*\nb")).toBe("a\\*\u00a0  \nb");
});

// On a phone (2026-10-22) QQ showed `\[` and `\]` with their backslash.
test("square brackets go as written; a `](` or `]:` that would make a link is broken by a zero-width space", () => {
  expect(literal("[方括号] [甲][乙]")).toBe("[方括号] [甲][乙]");
  expect(literal("[链接](https://x.y) ![图](a.png)")).toBe("[链接]\u200b(https://x.y) ![图]\u200b(a.png)");
  expect(literal("[注意]: 这行不消失")).toBe("[注意]\u200b: 这行不消失");
});

test("im-style §11: a muted button is grey, a fill button puts its text in the input box, and a button with no row has one of its own", async () => {
  const buttons = [
    { label: "用 abcd1234", data: "/rh_import abcd1234 --name abcd1234" },
    { label: "自己起名…", data: "/rh_import abcd1234 --name …", fill: "/rh_import abcd1234 --name " },
    { label: "下一页", data: "page:2:/rh_import", muted: true as const },
  ];
  const [sent] = await onTheWire(async (bot) => void (await adapter(bot).send("U1", { text: "叫什么？", seq: 7, replyTo: "M1", buttons })));
  expect((sent!.body as any).keyboard.content.rows).toEqual([
    { buttons: [callback("1", "用 abcd1234", "/rh_import abcd1234 --name abcd1234")] },
    { buttons: [{ id: "2", render_data: { label: "自己起名…", visited_label: "✓ 自己起名…", style: 1 }, action: { type: 2, permission: { type: 2 }, data: "/rh_import abcd1234 --name ", enter: false } }] },
    { buttons: [callback("3", "下一页", "page:2:/rh_import", 0)] },
  ]);
});

test("a copy button goes as a command button that fills the input box with its text, unsent", async () => {
  const [sent] = await onTheWire(async (bot) => void (await adapter(bot).send("U1", { text: "崩溃了", seq: 7, replyTo: "M1", buttons: [{ label: "复制", data: "帮我看下测试", copy: true }] })));
  const button = { id: "1", render_data: { label: "复制", visited_label: "✓ 复制", style: 1 }, action: { type: 2, permission: { type: 2 }, data: "帮我看下测试", enter: false } };
  expect(sent!.body).toMatchObject({ keyboard: { content: { rows: [{ buttons: [button] }] } } });
});

type Frame = { op: number; s?: number; t?: string; d?: unknown };

/** QQ as the real SDK sees it: a token, the gateway's address, and a gateway that says HELLO and
 *  keeps how each connection starts, IDENTIFY (op 2, a new session) or RESUME (op 6). answer is
 *  what the gateway does next. */
function fakeQQ(answer: (ws: ServerWebSocket<unknown>, start: Frame) => void) {
  const starts: Frame[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const path = new URL(req.url).pathname;
      if (path === "/app/getAppAccessToken") return Response.json({ access_token: "t", expires_in: 7200 });
      if (path === "/gateway") return Response.json({ url: `ws://127.0.0.1:${server.port}/ws` });
      return srv.upgrade(req) ? undefined : new Response("", { status: 404 });
    },
    websocket: {
      open: (ws) => void send(ws, { op: 10, d: { heartbeat_interval: 45_000 } }),
      message(ws, data) {
        const frame: Frame = JSON.parse(String(data));
        if (frame.op !== 2 && frame.op !== 6) return; // heartbeats
        starts.push(frame);
        answer(ws, frame);
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { starts, server, sdk: { baseUrl: url, tokenBaseUrl: url } };
}

const send = (ws: ServerWebSocket<unknown>, frame: Frame) => ws.send(JSON.stringify(frame));

/** A rhodium store in a temp dir, and a QQ adapter on the real SDK that keeps its gateway session there. */
function withStore() {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-qq-"));
  const store = openStore(join(dir, "rh.db"));
  const rhodium = (sdk: { baseUrl: string; tokenBaseUrl: string }) =>
    new QQAdapter("bot1", "dev", creds, {
      client: qqClient("dev", creds, () => {}, { ...sdk, sessionPersistence: qqSession(kept(store), creds.appId, "dev") }),
      log: () => {},
    });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, rhodium, cleanup };
}

test("after a restart the QQ bot resumes its gateway session, so QQ sends again what came while rhodium was down", async () => {
  const qq = fakeQQ((ws, start) => {
    if (start.op === 6) return send(ws, { op: 0, s: 3, t: "RESUMED", d: {} });
    send(ws, { op: 0, s: 1, t: "READY", d: { session_id: "S1" } });
    send(ws, { op: 0, s: 2, t: "C2C_MESSAGE_CREATE", d: { id: "M1", content: "hi", timestamp: "", author: { user_openid: "U1" } } });
  });
  const { rhodium, cleanup } = withStore();
  try {
    // No session on record: a new one.
    const first = rhodium(qq.sdk).messages()[Symbol.asyncIterator]();
    expect((await first.next()).value!.messageId).toBe("M1");
    await first.return!();
    // The next rhodium takes up that session after the last frame it got.
    let up = false;
    const second = rhodium(qq.sdk).messages((u) => (up ||= u))[Symbol.asyncIterator]();
    await until(() => up);
    await second.return!();
    expect(qq.starts).toEqual([
      { op: 2, d: expect.objectContaining({ token: "QQBot t" }) },
      { op: 6, d: { token: "QQBot t", session_id: "S1", seq: 2 } },
    ]);
  } finally {
    qq.server.stop(true);
    cleanup();
  }
});

test("a session the SDK takes as invalid is dropped and put on record as an event; the next rhodium starts a new one", async () => {
  const qq = fakeQQ((ws, start) => start.op === 6 && ws.close(4009, "session timed out"));
  const { store, rhodium, cleanup } = withStore();
  const lost = () => store.events(0).filter((e) => e.type === "qq_session_lost");
  try {
    qqSession(kept(store), creds.appId, "dev").save({ sessionId: "S1", lastSeq: 7 });
    const first = rhodium(qq.sdk).messages()[Symbol.asyncIterator]();
    await until(() => lost().length > 0);
    await first.return!();
    const second = rhodium(qq.sdk).messages()[Symbol.asyncIterator]();
    await until(() => qq.starts.length === 2);
    await second.return!();
    expect(qq.starts.map((f) => f.op)).toEqual([6, 2]);
    // What came while it was down may be gone: QQ sends it again only on a resume.
    expect(lost()).toMatchObject([{ source: "im", data: { bot: "dev" } }]);
  } finally {
    qq.server.stop(true);
    cleanup();
  }
});

const path = "/v2/users/U1/messages";
const timeout = new ApiError(`Request timeout [${path}]: exceeded 30000ms`, 0, path);
const gatewayError = new ApiError(`调用发生异常，请稍候重试（${path}），请稍后重试`, 504, path);
const deduped = new ApiError(`API Error [${path}]: 消息被去重，请检查请求msgseq`, 400, path, 40054005, "消息被去重，请检查请求msgseq");

/** An error as a send gives it: your openid in the path shows as <chat>. */
const shown = (e: Error) => e.message.replaceAll("U1", "<chat>");

/** A client whose sends get these answers in turn: an error is thrown, a response returned. */
const answering = (...answers: (Error | MessageResponse)[]) =>
  fakeClient({ send: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; } });

test("an active message that times out is unknown, not failed: it may have arrived; it goes only once", async () => {
  for (const err of [timeout, new ApiError(`Network error [${path}]: socket hang up`, 0, path), gatewayError]) {
    const { client, sent } = answering(err, { id: "out", timestamp: 0 });
    expect(await adapter(client).send("U1", { text: "x", seq: 1 })).toEqual({ status: "unknown", error: shown(err) });
    // Whether QQ dedupes a message with no msg_id by its msg_seq is untested.
    expect(sent).toHaveLength(1);
    // Nor a reply to a button press, which names the press by event_id, not msg_id.
    const press = answering(err, { id: "out", timestamp: 0 });
    expect(await adapter(press.client).send("U1", { text: "x", seq: 1, replyTo: "event:I1" })).toEqual({ status: "unknown", error: shown(err) });
    expect(press.sent).toHaveLength(1);
  }
});

test("a passive reply that may not have arrived goes once more under the same msg_seq: through, or dropped by QQ as a resend, it is sent", async () => {
  const through = answering(timeout, { id: "srv2", timestamp: 0 });
  expect(await adapter(through.client).send("U1", { text: "x", seq: 9, replyTo: "M1" })).toEqual({ status: "sent", messageId: "srv2" });
  expect(through.sent.map((s) => [s.target.msgId, s.extra?.msg_seq])).toEqual([["M1", 9], ["M1", 9]]);
  // QQ took the first after all, and drops the second (probe 13): sent, with no id of QQ's to quote it by.
  const dropped = answering(gatewayError, deduped);
  expect(await adapter(dropped.client).send("U1", { text: "x", seq: 9, replyTo: "M1" })).toEqual({ status: "sent" });
  expect(dropped.sent.map((s) => s.extra?.msg_seq)).toEqual([9, 9]);
});

test("a passive reply goes once more, no more: unknown again stays unknown, and so does one refused the second time", async () => {
  const twice = answering(timeout, timeout, { id: "out", timestamp: 0 });
  expect(await adapter(twice.client).send("U1", { text: "x", seq: 9, replyTo: "M1" })).toEqual({ status: "unknown", error: shown(timeout) });
  expect(twice.sent).toHaveLength(2);
  // The first may have arrived: refused the second time, it stays unknown, not out of quota, so the
  // daemon does not resend it as an active message (architecture §7.4).
  const quota = new ApiError(`API Error [${path}]: msg limit`, 400, path, 40034128, "msg limit");
  for (const no of [quota, new ApiError(`API Error [${path}]: forbidden`, 403, path), new Error("Failed to get access_token: {}")]) {
    const refused = answering(timeout, no);
    expect(await adapter(refused.client).send("U1", { text: "x", seq: 9, replyTo: "M1" })).toEqual({ status: "unknown", error: expect.any(String) });
    expect(refused.sent).toHaveLength(2);
  }
  // Dropped on the first try, its seq taken by another reply to the message: out of quota as before,
  // so it goes again as an active message.
  const clash = answering(deduped, { id: "out", timestamp: 0 });
  expect(await adapter(clash.client).send("U1", { text: "x", seq: 9, replyTo: "M1" })).toEqual({ status: "failed", error: `40054005 ${shown(deduped)}`, quota: true });
  expect(clash.sent).toHaveLength(1);
});

test("the real SDK: a passive reply whose gateway errored goes again with the same msg_seq, and QQ's dedupe answer counts as sent", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/app/getAppAccessToken") return Response.json({ access_token: "t", expires_in: 7200 });
      bodies.push(await req.json());
      // As QQ answered probe 13's resend.
      if (bodies.length === 1) return new Response("<html>504 Gateway Time-out</html>", { status: 504, headers: { "content-type": "text/html" } });
      return Response.json({ code: 40054005, message: "消息被去重，请检查请求msgseq" }, { status: 400 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const a = adapter(new QQBot({ appId: "1", appSecret: "s", baseUrl: url, tokenBaseUrl: url }));
    expect(await a.send("U1", { text: "x", replyTo: "M1", seq: 2 ** 31 - 1 })).toEqual({ status: "sent" });
    expect(bodies).toEqual([
      { msg_id: "M1", content: "x", msg_seq: 2 ** 31 - 1, msg_type: 0 },
      { msg_id: "M1", content: "x", msg_seq: 2 ** 31 - 1, msg_type: 0 },
    ]);
  } finally {
    server.stop(true);
  }
});

test("story 73: Markdown goes as a Markdown message; one QQ turns down, say for a bot not approved for Markdown, goes again as plain text", async () => {
  const noMarkdown = new ApiError(`API Error [${path}]: markdown not allowed`, 400, path, 40034090, "markdown not allowed");
  const { client, sent } = fakeClient({ send: (o) => (o.markdown ? Promise.reject(noMarkdown) : Promise.resolve({ id: "out", timestamp: 0 })) });
  const a = adapter(client);
  expect(await a.send("U1", { text: "**x**", markdown: "**x**", seq: 7, replyTo: "M1" })).toEqual({ status: "sent", messageId: "out" });
  expect(sent.map((s) => [s.markdown?.content ?? null, s.content ?? null, s.target.msgId])).toEqual([
    ["**x**", null, "M1"],
    [null, "**x**", "M1"],
  ]);
  // The plain text goes with a msg_seq of its own: QQ might take the first as used.
  expect(sent[1]!.extra?.msg_seq).not.toBe(sent[0]!.extra?.msg_seq);
  // From msgSeq's range too, top included.
  const plainSeq = async (seq: number) => {
    const c = fakeClient({ send: (o) => (o.markdown ? Promise.reject(noMarkdown) : Promise.resolve({ id: "out", timestamp: 0 })) });
    await adapter(c.client).send("U1", { text: "x", markdown: "x", seq, replyTo: "M1" });
    return c.sent[1]!.extra?.msg_seq;
  };
  expect(await plainSeq(100_000)).toBeWithin(65536, 2 ** 31);
  expect(await plainSeq(2 ** 31 - 1)).toBeWithin(1, 2 ** 31 - 1);
  // Markdown QQ takes goes as is.
  const ok = fakeClient();
  expect(await adapter(ok.client).send("U1", { text: "**x**", markdown: "**x**", seq: 7 })).toEqual({ status: "sent", messageId: "out1" });
  expect(ok.sent.map((s) => [s.msgType, s.markdown])).toEqual([[2, { content: "**x**" }]]);
});

test("buttons on Markdown QQ turns down are written under the plain text, since QQ shows no keyboard on it: an ask's a number each, a command's and a copy button's as their text", async () => {
  const noMarkdown = new ApiError(`API Error [${path}]: markdown not allowed`, 400, path, 40034090, "markdown not allowed");
  const { client, sent } = fakeClient({ send: (o) => (o.markdown ? Promise.reject(noMarkdown) : Promise.resolve({ id: "out", timestamp: 0 })) });
  const a = adapter(client);
  const ask = [{ label: "允许", data: "ask:A1:1", row: 0 }, { label: "拒绝", data: "ask:A1:2", row: 0 }];
  expect(await a.send("U1", { text: "要运行这条命令，允许吗？\n\nmake\n\n回别的话算拒绝，并转告它。", seq: 7, replyTo: "M1", buttons: ask })).toEqual({ status: "sent", messageId: "out" });
  const notice = [{ label: "复制", data: "帮我看下测试为什么挂了", copy: true as const }];
  await a.send("U1", { text: "w/a 崩溃了。", seq: 8, replyTo: "M1", buttons: notice });
  const named = [{ label: "用 abcd1234", data: "/rh_import abcd1234 --name abcd1234" }, { label: "自己起名…", data: "/rh_import abcd1234 --name …", fill: "/rh_import abcd1234 --name " }];
  await a.send("U1", { text: "导入成槽位，叫什么？", seq: 9, replyTo: "M1", buttons: named });
  // /status while an ask waits: a reply of 1 would answer the ask (the router reads a number as its
  // answer first), so 停止 is written as its command; 取消 is the same as not replying.
  const status = [{ label: "停止", data: "/stop" }, { label: "取消", data: "cancel", row: 1, muted: true as const }];
  await a.send("U1", { text: "w/a 正在运行。", seq: 10, replyTo: "M1", buttons: status });
  const plain = sent.filter((s) => !s.markdown);
  expect(plain.map((s) => s.content)).toEqual([
    "要运行这条命令，允许吗？\n\nmake\n\n回别的话算拒绝，并转告它。\n\n1. 允许\n2. 拒绝\n\n回编号选一个。",
    "w/a 崩溃了。\n\n复制：帮我看下测试为什么挂了",
    // A button that fills the input box has nothing to fill without a keyboard.
    "导入成槽位，叫什么？\n\n用 abcd1234：/rh_import abcd1234 --name abcd1234",
    "w/a 正在运行。\n\n停止：/stop",
  ]);
  expect(plain.map((s) => s.keyboard)).toEqual([undefined, undefined, undefined, undefined]);
});

test("Markdown whose reply may have arrived is not sent again as plain text when the second try is refused", async () => {
  const forbidden = new ApiError(`API Error [${path}]: forbidden`, 403, path);
  const { client, sent } = answering(gatewayError, forbidden, { id: "out", timestamp: 0 });
  expect(await adapter(client).send("U1", { text: "**x**", markdown: "**x**", seq: 9, replyTo: "M1" })).toEqual({ status: "unknown", error: shown(forbidden) });
  expect(sent.map((s) => [s.markdown?.content ?? null, s.extra?.msg_seq])).toEqual([["**x**", 9], ["**x**", 9]]);
});

// Adapted from "deliver: passive rejected by server": the platform's code goes along so the
// renderer can tell a used-up passive reply from other refusals and resend as active.
test("an error names your chat <chat>, not by the openid in QQ's API path: errors reach the log, which the board shows", async () => {
  const logged: string[] = [];
  const logging = (client: QQClient) => new QQAdapter("bot1", "dev", creds, { client, log: (m) => void logged.push(m), download: async () => new Uint8Array() });
  const refused = new ApiError(`API Error [${path}]: msg limit`, 400, path, 40034024, "msg limit");
  const files = "/v2/users/U1/files";
  const upload = fakeClient();
  upload.client.uploadMedia = () => Promise.reject(new ApiError(`API Error [${files}]: too big`, 400, files, 40093002, "too big"));
  const errors = [
    // A passive reply goes again, logged; Markdown turned down goes again as plain text, logged.
    await logging(answering(timeout, timeout).client).send("U1", { text: "x", seq: 1, replyTo: "M1" }),
    await logging(answering(refused, refused).client).send("U1", { text: "x", markdown: "x", seq: 1 }),
    await logging(upload.client).send("U1", { text: "", seq: 1, file: { kind: "file", path: "/state/media/cc", name: "big.bin" } }),
  ].map((r) => r.status !== "sent" && r.error);
  expect(errors).toEqual([
    "Request timeout [/v2/users/<chat>/messages]: exceeded 30000ms",
    "40034024 API Error [/v2/users/<chat>/messages]: msg limit",
    "upload: API Error [/v2/users/<chat>/files]: too big",
  ]);
  expect(logged).toHaveLength(2);
  expect(logged.join("\n")).not.toContain("U1");
});

test("a send the platform refuses is failed, with the platform's code, and counts as out of quota: the passive reply's, or the bot's active messages", async () => {
  const refused = new ApiError(`API Error [${path}]: msg limit`, 400, path, 40034024, "msg limit");
  const { client } = fakeClient({ send: () => Promise.reject(refused) });
  // As qq-cli has it: the message's passive replies are gone, so it can go out as an active one.
  expect(await adapter(client).send("U1", { text: "x", seq: 1, replyTo: "M1" })).toEqual({
    status: "failed",
    error: `40034024 ${shown(refused)}`,
    quota: true,
  });
  // An active one goes through another bot instead (product §5.5).
  expect(await adapter(client).send("U1", { text: "x", seq: 1 })).toEqual({ status: "failed", error: `40034024 ${shown(refused)}`, quota: true });
  // Getting a token fails before anything is sent.
  const noToken = fakeClient({ send: () => Promise.reject(new Error("Failed to get access_token: {}")) });
  expect((await adapter(noToken.client).send("U1", { text: "x", seq: 1 })).status).toBe("failed");
});

const inbound = (o: object) => ({
  rawEventType: "C2C_MESSAGE_CREATE", kind: "c2c", senderId: "U1", content: "hi", messageId: "M1",
  timestamp: "2026-10-18T09:00:00+08:00", ...o,
});

test("private messages come out with their message id, sender and chat; group messages do not", async () => {
  const { client, emit } = fakeClient();
  const it = adapter(client).messages()[Symbol.asyncIterator]();
  emit("message", {}, inbound({ kind: "group", senderId: "M9", groupOpenid: "G", messageId: "G1" }));
  emit("message", {}, inbound({ content: " hello ", messageId: "M1" }));
  emit("message", {}, inbound({ messageId: "M2", timestamp: "" }));
  expect((await it.next()).value).toEqual({
    bot: "bot1",
    chat: "U1",
    messageId: "M1",
    sender: "U1",
    text: "hello",
    at: Date.parse("2026-10-18T01:00:00Z"),
  });
  const second = (await it.next()).value!;
  expect(second.messageId).toBe("M2");
  expect(Math.abs(second.at - Date.now())).toBeLessThan(5000); // no platform time: when we got it
  await it.return!();
});

test("a word that names a command, like new, comes as typed: sent while an ask is open, it answers the ask, not /new (product §5.8)", async () => {
  // A command picked from the / panel comes with its "/" (tried on the dev bot, 2026-10-21).
  const { client, emit } = fakeClient();
  const it = adapter(client).messages()[Symbol.asyncIterator]();
  const texts = ["new", " stop ", "rh_use w/a", "/rh_ls"];
  for (const content of texts) emit("message", {}, inbound({ content }));
  const got: string[] = [];
  for (const _ of texts) got.push((await it.next()).value!.text);
  expect(got).toEqual(["new", "stop", "rh_use w/a", "/rh_ls"]);
  await it.return!();
});

test("pictures and files come not yet downloaded: each is fetched only when rhodium asks", async () => {
  const { client, emit } = fakeClient();
  const fetched: string[] = [];
  const download = async (url: string) => (fetched.push(url), new TextEncoder().encode(`bytes of ${url}`));
  const it = adapter(client, undefined, download).messages()[Symbol.asyncIterator]();
  emit("message", {}, inbound({
    content: "look",
    attachments: [
      { content_type: "image/png", url: "https://x/1", filename: "a.png" },
      { content_type: "application/pdf", url: "//x/2", filename: "../b.pdf" },
    ],
  }));
  const m: InboundMessage = (await it.next()).value;
  expect(m.text).toBe("look");
  expect(fetched).toEqual([]); // a stranger's never are (architecture §8.3)
  const got = await Promise.all(m.attachments!.map(async ({ kind, name, fetch }) => ({ kind, name, data: new TextDecoder().decode(await fetch()) })));
  expect(got).toEqual([
    { kind: "image", name: "a.png", data: "bytes of https://x/1" },
    { kind: "file", name: "../b.pdf", data: "bytes of //x/2" },
  ]);
  await it.return!();
});

// Hand-written after the SDK's InboundAttachment (voice_wav_url, asr_refer_text) and qq-cli's use of
// it (src/daemon.ts): QQ sends a voice message with no text, its own transcript on the attachment.
const voice = (o: object = {}) => ({
  content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?fileid=V1", filename: "V1.amr",
  voice_wav_url: "https://multimedia.nt.qq.com.cn/download?fileid=V1&spec=wav", ...o,
});

test("a voice message comes as QQ's transcript of it, marked as one; the recording still comes as a file", async () => {
  const { client, emit } = fakeClient();
  const it = adapter(client).messages()[Symbol.asyncIterator]();
  emit("message", {}, inbound({ content: "", attachments: [voice({ asr_refer_text: "明天九点提醒我开会" })] }));
  emit("message", {}, inbound({ content: "", messageId: "M2", attachments: [voice()] })); // QQ made out no words
  const heard: InboundMessage = (await it.next()).value;
  expect(heard.text).toBe("[语音转写] 明天九点提醒我开会");
  expect(heard.attachments!.map(({ kind, name }) => ({ kind, name }))).toEqual([{ kind: "file", name: "V1.amr" }]);
  const unheard: InboundMessage = (await it.next()).value;
  expect(unheard.text).toBe("");
  expect(unheard.attachments!.map(({ kind, name }) => ({ kind, name }))).toEqual([{ kind: "file", name: "V1.amr" }]);
  await it.return!();
});

test("a quote comes as the quoted message's index, and each message brings its own for a later quote", async () => {
  const { client, emit } = fakeClient();
  const it = adapter(client).messages()[Symbol.asyncIterator]();
  emit("message", {}, inbound({ content: "what about this?", msgIdx: "REFIDX_9", refMsgIdx: "REFIDX_7" }));
  expect((await it.next()).value).toMatchObject({ text: "what about this?", ref: "REFIDX_9", quote: { ref: "REFIDX_7" } });
  await it.return!();
});

test("a picture or file goes up first, then as a media message with our msg_seq; the reply's index comes back for quotes", async () => {
  const { client, sent, uploads } = fakeClient({ send: async () => ({ id: "srv1", timestamp: 0, ext_info: { ref_idx: "REFIDX_3" } }) });
  const a = adapter(client);
  // Paths are rhodium's copies, named by hash; the name is the agent's.
  expect(await a.send("U1", { text: "", seq: 7, replyTo: "M1", file: { kind: "image", path: "/state/media/aa", name: "chart.png" } })).toEqual({
    status: "sent",
    messageId: "srv1",
    ref: "REFIDX_3",
  });
  await a.send("U1", { text: "", seq: 8, file: { kind: "file", path: "/state/media/bb", name: "notes.txt" } });
  expect(uploads).toMatchObject([
    { target: { scope: "c2c", targetId: "U1" }, fileType: MediaFileType.IMAGE, localPath: "/state/media/aa", srvSendMsg: false },
    { target: { scope: "c2c", targetId: "U1" }, fileType: MediaFileType.FILE, localPath: "/state/media/bb", fileName: "notes.txt", srvSendMsg: false },
  ]);
  expect(sent).toEqual([
    { target: { scope: "c2c", targetId: "U1", msgId: "M1" }, msgType: 7, media: { file_info: "info1" }, extra: { msg_seq: 7 } },
    { target: { scope: "c2c", targetId: "U1" }, msgType: 7, media: { file_info: "info2" }, extra: { msg_seq: 8 } },
  ]);
});

test("a file that fails to upload is failed and never sent: it was not a message yet", async () => {
  const { client, sent } = fakeClient();
  const path = "/v2/users/U1/files";
  client.uploadMedia = () => Promise.reject(new ApiError(`API Error [${path}]: too big`, 400, path, 40093002, "too big"));
  const r = await adapter(client).send("U1", { text: "", seq: 1, replyTo: "M1", file: { kind: "file", path: "/state/media/cc", name: "big.bin" } });
  expect(r).toEqual({ status: "failed", error: expect.stringContaining("too big") });
  expect(sent).toEqual([]);
});

/** A button press as QQ delivers it in a private chat (probe 15): no id of the message it was on. */
const press = (o: object = {}) => ({
  id: "I1", type: 11, scene: "c2c", chat_type: 2, timestamp: "2026-10-21T14:53:46+08:00", user_openid: "U1", version: 1,
  data: { type: 11, resolved: { button_data: "ask:A1:1", button_id: "1" } }, ...o,
});

test("a button press is answered to QQ at once with code 0, and comes out with its data; one outside a private chat does not", async () => {
  const { client, emit, acks } = fakeClient();
  const it = adapter(client).messages()[Symbol.asyncIterator]();
  emit("interaction", {}, press({ id: "G1", scene: "group", chat_type: 1, user_openid: undefined, group_openid: "G" }));
  emit("interaction", {}, press());
  // QQ waits 3 s for the answer, so it goes before rhodium even looks at the press.
  expect(acks).toEqual([["G1", 0], ["I1", 0]]);
  expect((await it.next()).value).toEqual({
    bot: "bot1",
    chat: "U1",
    messageId: "event:I1",
    sender: "U1",
    text: "",
    at: Date.parse("2026-10-21T06:53:46Z"),
    button: { data: "ask:A1:1", message: "" },
  });
  await it.return!();
});

test("a reply to a button press is a passive reply by the event's id, as QQ takes one to a press", async () => {
  const [reply] = await onTheWire((bot) => adapter(bot).send("U1", { text: "已回答：允许", seq: 9, replyTo: "event:I1" }));
  expect(reply).toEqual({ method: "POST", path: "/v2/users/U1/messages", body: { content: "已回答：允许", msg_seq: 9, event_id: "I1", msg_type: 0 } });
});

test("story 83: words for a press come as a reply to it, QQ having nowhere else to show them; a press answered with none gets nothing", async () => {
  const { client, sent, acks } = fakeClient();
  const a = adapter(client);
  await a.answerPress("U1", "event:I1", "");
  expect(sent).toEqual([]);
  await a.answerPress("U1", "event:I2", "已失效");
  expect(sent).toEqual([{ target: { scope: "c2c", targetId: "U1" }, content: "已失效", extra: { msg_seq: msgSeq("event:I2"), event_id: "I2" } }]);
  expect(acks).toEqual([]); // the press itself was answered as it came in
  const refused = fakeClient({ send: () => Promise.reject(new ApiError("API Error: event_id expired", 400, "/v2/users/U1/messages", 40034026)) });
  await expect(adapter(refused.client).answerPress("U1", "event:I3", "已失效")).rejects.toThrow(/40034026/);
});

test("words for a press go as an active message when QQ turns the press's event_id down, as the dev bot's did", async () => {
  // 2026-10-22 on the dev bot: 40034025 请求参数event_id无效 for the interaction's own id.
  const { client, sent } = fakeClient({
    send: async (opts) => {
      if (opts.extra?.event_id) throw new ApiError("API Error: 请求参数event_id无效", 400, "/v2/users/U1/messages", 40034025);
      return { id: "out", timestamp: 0 };
    },
  });
  await adapter(client).answerPress("U1", "event:I1", "这个按钮已经失效了");
  expect(sent.at(-1)).toEqual({ target: { scope: "c2c", targetId: "U1" }, content: "这个按钮已经失效了", extra: { msg_seq: expect.any(Number) } });
});

async function until(cond: () => boolean) {
  for (const t0 = Date.now(); !cond(); await Bun.sleep(5)) {
    if (Date.now() - t0 > 3000) throw new Error("timed out waiting");
  }
}

/** A client whose first `fails` starts reject the way the SDK's do on a fatal close. */
function flakyClient(fails: number) {
  const fake = fakeClient();
  const starts: number[] = [];
  const start = fake.client.start;
  fake.client.start = (signal) => {
    starts.push(Date.now());
    return starts.length <= fails ? Promise.reject(new Error("Gateway closed (4914): offline")) : start(signal);
  };
  return { ...fake, starts };
}

test("a bot's connection error stays inside its adapter: it backs off, reconnects, and messages flow again", async () => {
  const bad = flakyClient(2);
  const good = fakeClient();
  const logs: string[] = [];
  const a = new QQAdapter("bot1", "dev", creds, { client: bad.client, delays: [40, 120], log: (m) => logs.push(m) });
  const b = adapter(good.client);
  const fromA = a.messages()[Symbol.asyncIterator]();
  const fromB = b.messages()[Symbol.asyncIterator]();

  // The other bot keeps working while this one is down.
  good.emit("message", {}, inbound({ messageId: "B1" }));
  expect((await fromB.next()).value!.messageId).toBe("B1");

  await until(() => bad.starts.length === 3);
  const [s0, s1, s2] = bad.starts as [number, number, number];
  expect(s1 - s0).toBeGreaterThanOrEqual(35);
  expect(s2 - s1).toBeGreaterThanOrEqual(110); // the wait grows
  expect(logs.join("\n")).toContain("4914");

  bad.emit("message", {}, inbound({ messageId: "A1" }));
  expect((await fromA.next()).value!.messageId).toBe("A1");
  await Promise.all([fromA.return!(), fromB.return!()]);
});

test("each start the SDK gives up on is a failed try for rhodium to count, with its error, and ready is one that got through", async () => {
  const bad = flakyClient(2);
  const heard: (string | undefined | true)[] = [];
  const a = new QQAdapter("bot1", "dev", creds, { client: bad.client, delays: [10], log: () => {} });
  const it = a.messages((up, error) => heard.push(up || error))[Symbol.asyncIterator]();
  await until(() => bad.starts.length === 3);
  bad.emit("ready");
  expect(heard).toEqual([expect.stringContaining("4914"), expect.stringContaining("4914"), true]);
  await it.return!();
});

test("the wait starts over after a good connection, and stopping the iteration stops the retries", async () => {
  const { client, emit } = fakeClient();
  const starts: { at: number; signal: AbortSignal }[] = [];
  client.start = async (signal) => {
    starts.push({ at: Date.now(), signal });
    if (starts.length === 1) throw new Error("no network");
    if (starts.length === 2) {
      emit("ready", {}); // up for a while, then closed for good
      await Bun.sleep(10);
      throw new Error("Gateway closed (4915): banned");
    }
    await new Promise((r) => signal.addEventListener("abort", r));
  };
  const it = adapter(client, [30, 2000]).messages()[Symbol.asyncIterator]();
  await until(() => starts.length === 3);
  expect(starts[2]!.at - starts[1]!.at).toBeLessThan(1500); // the first wait again, not the second
  await it.return!();
  expect(starts[2]!.signal.aborted).toBe(true);
  await Bun.sleep(100);
  expect(starts.length).toBe(3);
});

test("story 147: connected hears the gateway come up, drop and come back, and start giving up", async () => {
  const { client, emit } = fakeClient();
  let starts = 0;
  client.start = async (signal) => {
    if (++starts === 1) throw new Error("no network");
    await new Promise((r) => signal.addEventListener("abort", r));
  };
  const heard: boolean[] = [];
  const it = adapter(client, [10]).messages((up) => heard.push(up))[Symbol.asyncIterator]();
  await until(() => starts === 2);
  expect(heard).toEqual([false]);
  emit("ready", {});
  emit("disconnected", { code: 4009, reason: "session timed out", willReconnect: true });
  emit("resumed", {});
  expect(heard).toEqual([false, true, false, true]);
  await it.return!();
});

/** Stands in for the SDK's ApiClient on api.bot.qq.com: records each request; panels are what
 *  GET /v2/panels lists. */
function fakeMenuApi(panels: { panel_id: string; panel?: { remark?: string } }[] = []) {
  const requests: { token: string; method: string; path: string; body?: unknown }[] = [];
  const api = {
    async request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
      requests.push({ token, method, path, ...(body !== undefined && { body }) });
      return (method === "GET" ? { records: panels } : method === "POST" ? { panel_id: "new" } : {}) as T;
    },
  };
  return { api, requests };
}

const item = (command: string, description = `about ${command}`) => ({ command, description });

test("story 323: setRow puts the row in the custom menu: a flat button its Chinese name and command, a folder a menu with its sub_menu_items", async () => {
  const { api, requests } = fakeMenuApi();
  const a = new QQAdapter("bot1", "dev", creds, { client: fakeClient().client, log: () => {}, menuApi: api });
  await a.setRow(QQ_ROW);
  const send = (name: string, command: string) => ({ type: "send_message", name, send_message: command });
  expect(requests).toEqual([
    {
      token: "T",
      method: "PUT",
      path: "/v2/menu",
      body: {
        menu: {
          items: [
            send("停止", "/stop"),
            send("槽位", "/rh_ls"),
            send("切换", "/rh_use"),
            send("换 agent", "/rh_agent"),
            send("帮助", "/rh_help"),
            { type: "menu", name: "终端", sub_menu_items: [send("切到 TUI", "/rh_tui"), send("切回无头", "/rh_release")] },
            {
              type: "menu",
              name: "更多",
              sub_menu_items: [send("改名", "/rh_rename"), send("归档", "/rh_archive"), send("导入", "/rh_import"), send("默认槽位", "/rh_bind"), send("工具行详略", "/rh_verbose")],
            },
          ],
        },
      },
    },
  ]);
});

test("story 326: setMenu puts a Claude slot's 11 commands in a / panel of Rhodium's own, made the first time, and leaves the custom menu alone", async () => {
  const { api, requests } = fakeMenuApi([{ panel_id: "theirs", panel: { remark: "qq-cli" } }]);
  const a = new QQAdapter("bot1", "dev", creds, { client: fakeClient().client, log: () => {}, menuApi: api });
  await a.setMenu(slashMenu("claude"));
  expect((requests.at(-1)!.body as { panel: { items: unknown[] } }).panel.items).toHaveLength(11);
  requests.length = 0;
  await a.setMenu([item("/stop"), item("/rh_import")]);
  expect(requests).toEqual([
    { token: "T", method: "GET", path: "/v2/panels?scope=c2c&limit=50" },
    {
      token: "T",
      method: "POST",
      path: "/v2/panels",
      body: {
        scope: "c2c",
        target_type: "all",
        panel: {
          remark: "rhodium",
          items: [
            { type: "command", name: "/stop", desc: "about /stop" },
            { type: "command", name: "/rh_import", desc: "about /rh_import" },
          ],
        },
      },
    },
  ]);
});

test("setMenu changes the panel marked rhodium in place and leaves every other panel alone", async () => {
  const { api, requests } = fakeMenuApi([
    { panel_id: "theirs", panel: { remark: "qq-cli" } },
    { panel_id: "ours", panel: { remark: "rhodium" } },
  ]);
  const a = new QQAdapter("bot1", "dev", creds, { client: fakeClient().client, log: () => {}, menuApi: api });
  await a.setMenu([item("/new")]);
  expect(requests.filter((r) => r.path.startsWith("/v2/panels/") || r.method === "POST")).toEqual([
    { token: "T", method: "PUT", path: "/v2/panels/ours", body: { panel: { remark: "rhodium", items: [{ type: "command", name: "/new", desc: "about /new" }] } } },
  ]);
});

test("a panel description over QQ's 30 characters, a Chinese one counting 2, is cut short to fit", async () => {
  const { api, requests } = fakeMenuApi();
  const a = new QQAdapter("bot1", "dev", creds, { client: fakeClient().client, log: () => {}, menuApi: api });
  await a.setMenu([item("/new", "开一段新对话，不带之前的上下文"), item("/rh_tui", "切到 TUI 模式，在 Herdr 里接着同一段对话")]);
  const post = requests.find((r) => r.method === "POST")!.body as { panel: { items: { desc: string }[] } };
  expect(post.panel.items.map((i) => i.desc)).toEqual(["开一段新对话，不带之前的上下文", "切到 TUI 模式，在 Herdr 里接…"]);
});

test("an edit is refused without calling the platform: QQ can only append", async () => {
  const { client, sent } = fakeClient();
  const r = await adapter(client).edit("U1", "out1", { text: "x", seq: 1 });
  expect(r.status).toBe("failed");
  expect(sent).toEqual([]);
});

test("credentials come only from the bot's own config entry, never from qq-cli's (story 157)", () => {
  // qq-cli reads QQBOT_APP_ID / QQBOT_APP_SECRET from the env and from $XDG_CONFIG_HOME/qq-cli/config.env.
  const cfg = mkdtempSync(join(tmpdir(), "rhodium-test-qq-"));
  mkdirSync(join(cfg, "qq-cli"));
  writeFileSync(join(cfg, "qq-cli", "config.env"), "QQBOT_APP_ID=OLD\nQQBOT_APP_SECRET=old\n");
  const planted = { XDG_CONFIG_HOME: cfg, QQBOT_APP_ID: "OLD", QQBOT_APP_SECRET: "old" };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    expect(qqClient("dev", { platform: "qq", appId: "NEW", secret: "s" }).getCredentials()).toEqual({
      appId: "NEW",
      clientSecret: "s",
    });
    expect(() => qqClient("dev", { platform: "qq" })).toThrow(/bots\.dev.*appId/);
    expect(() => qqClient("dev", { platform: "qq", appId: "NEW" })).toThrow(/bots\.dev.*secret/);
    expect(() => new QQAdapter("bot1", "dev", { platform: "qq" })).toThrow(/bots\.dev/);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("capabilities match architecture §8.1: append only, buttons shown on Markdown only, up to 11 (8 choices and a row of 上一页、下一页、取消), passive quota, one global / panel of 20 and the custom menu for the row, files up to the SDK's limits, Markdown", () => {
  expect(adapter(fakeClient().client).capabilities).toEqual({
    progress: "append",
    buttons: "markdown",
    maxButtons: 11,
    copy: 256,
    sendLimit: { kind: "qq_quota" },
    menu: { scope: "global", maxItems: 20, row: "custom_menu" },
    maxTextLength: 2000,
    maxFileBytes: { image: 30 * 2 ** 20, file: 100 * 2 ** 20 },
    markdown: { extensions: ["heading"], literal: true },
  });
});
