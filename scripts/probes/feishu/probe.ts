// Feishu, before the spec (round 33): makes the dev app by scan, then walks you through a guided
// session inside Feishu, one card per step, and records every event and API answer.
//
// Usage: bun scripts/probes/feishu/probe.ts [--fake]
//
// Live:
// - The dev app's credentials are in ~/.config/rhodium-dev/feishu-dev.json (0600). Missing, the
//   probe makes the app by scan first: the QR code goes to /tmp/rhodium-test-feishu-probe/qr.png and
//   the link to link.txt there, both rewritten when a link expires unscanned (Feishu gives each an
//   hour; 7 links at most). On the page, pick the dev app, Rhodium 测试机, or 新建 (a new app) if it
//   is gone; never another existing app, which may be connected elsewhere.
// - The scan is the plain flow, no appPreset or addons: with them, on 2026-10-26, the page made the
//   app but the polling never got its credentials. The plain flow's template already has the bot,
//   the long connection, the message event and the card callback; the scopes are Feishu's default.
// - Then it reads the bot, the granted scopes and your name and avatar, sets the / menu, connects
//   over the long connection and sends you, the scanner, one card per step, each with a 跳过 button
//   and a 10-minute timeout. Only you get messages. It stops on two timeouts in a row, and before
//   touching an app whose name lacks "Rhodium" (one picked on the scan page instead of a new one).
// - Out: /tmp/rhodium-test-feishu-probe/log.jsonl (every event and API answer, secrets taken out,
//   appended run after run), summary.md (what each step found, this run), and the files you sent.
//   Lines copied from it into test/fixtures/feishu/ then need `bun scripts/probes/synth.ts`.
// - Run it as a test unit: systemd-run --user --unit=rhodium-test-feishu-probe --same-dir bun scripts/probes/feishu/probe.ts
//
// --fake: the same script against fake.ts, a local Feishu with you scripted in, times cut a
// hundredfold; out in /tmp/rhodium-test-feishu-probe/fake/, credentials included. Exits 1 if a
// step timed out or a check failed.
import * as lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import zlib from "node:zlib";
import { slashMenu } from "../../../src/commands";

const fake = process.argv.includes("--fake");
const OUT = fake ? "/tmp/rhodium-test-feishu-probe/fake" : "/tmp/rhodium-test-feishu-probe";
const CRED = fake ? `${OUT}/feishu-dev.json` : `${homedir()}/.config/rhodium-dev/feishu-dev.json`;
const ms = (live: number) => (fake ? Math.round(live / 100) : live);
const MIN = 60_000;
const STEP = ms(10 * MIN);

/** What Rhodium uses, and your name and avatar (round 33): compared with the scopes Feishu granted. */
const SCOPES = [
  "im:message.p2p_msg:readonly", // your messages to the bot
  "im:message:send_as_bot", // sending
  "im:message:update", // editing a card
  "im:message:readonly", // history for the backfill, a merged forward's messages, downloads
  "im:resource", // uploads and downloads
  "application:bot.basic_info:read", // the bot's name and avatar
  "application:app_slash_command:read", // the / menu
  "application:app_slash_command:write",
  "contact:contact.base:readonly", // your name and avatar
  "contact:user.base:readonly",
];

if (fake) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const f = fake ? (await import("./fake")).fakeFeishu(0.01) : undefined;
if (f) lark.defaultHttpInstance.interceptors.request.use((c) => ((c.url = c.url?.replace("https://accounts.feishu.cn", f.url)), c));
const domain = f?.url ?? lark.Domain.Feishu;

// ---- Records ----

const secrets: string[] = [];
const REDACT = new Set(["token", "tenant_access_token", "app_secret", "AppSecret", "client_secret", "appSecret"]);
function note(ev: string, data: object = {}) {
  let line = JSON.stringify({ t: new Date().toISOString(), ev, ...data }, (k, v) =>
    REDACT.has(k) ? "<redacted>" : v?.type === "Buffer" && Array.isArray(v.data) ? `<${v.data.length} bytes>` : v,
  );
  for (const s of secrets) line = line.replaceAll(s, "<secret>");
  appendFileSync(`${OUT}/log.jsonl`, line.replace(/\bt-[\w.-]{16,}/g, "<tenant-token>") + "\n");
}
const lines: string[] = [];
/** A line of summary.md, written out at once so a stopped run keeps what it found. */
function sum(line: string) {
  lines.push(line);
  writeFileSync(`${OUT}/summary.md`, lines.join("\n") + "\n");
}
const say = (text: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${text}`);
const sdkLog = Object.fromEntries(
  ["error", "warn", "info", "debug", "trace"].map((level) => [level, (...msg: unknown[]) => note("sdk", { level, msg: msg.map((m) => (m instanceof Error ? m.message : m)) })]),
) as unknown as lark.Logger;

const calls: Record<string, number> = {};
type Result<T> = { ok: true; data: T } | { ok: false; error: any };
/** One API call, recorded with its answer; a code other than 0, as a thrown error, is not ok. */
async function api<T>(name: string, call: () => Promise<T>): Promise<Result<T>> {
  calls[name] = (calls[name] ?? 0) + 1;
  const t0 = Date.now();
  try {
    const data = await call();
    const code = (data as any)?.code;
    note("api", { name, ms: Date.now() - t0, res: data });
    return code === undefined || code === 0 ? { ok: true, data } : { ok: false, error: data };
  } catch (e: any) {
    let data = e?.response?.data;
    if (typeof data?.pipe === "function") data = Buffer.concat(await Array.fromAsync(data as AsyncIterable<Buffer>)).toString();
    const error = { status: e?.response?.status, data, message: String(e?.message ?? e) };
    note("api", { name, ms: Date.now() - t0, error });
    return { ok: false, error };
  }
}
const brief = (e: any) => [e?.status, e?.data?.code ?? e?.code, e?.data?.msg ?? e?.msg ?? e?.message].filter((x) => x !== undefined).join(" ");

// ---- The scan ----

type Creds = { appId: string; appSecret: string; brand: string; ownerOpenId: string; createdAt: string };

/** The QR code of text as a grayscale PNG, 8 pixels a module. qrcode-terminal draws rh bot's QR codes. */
function qrPng(text: string): Buffer {
  const QRCode = require("qrcode-terminal/vendor/QRCode");
  const qr = new QRCode(-1, require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel").M);
  qr.addData(text);
  qr.make();
  const n: number = qr.getModuleCount();
  const px = 8;
  const size = (n + 8) * px; // a quiet zone of 4 modules
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, c] = [Math.floor(y / px) - 4, Math.floor(x / px) - 4];
      if (r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c)) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const head = Buffer.alloc(13); // width, height, 8-bit grayscale
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function scan(): Promise<Creds> {
  say("扫码页会问选已有应用还是新建：选 Rhodium 测试机；没有它就新建。");
  for (let link = 1; link <= 7; link++) {
    try {
      const r = await lark.registerApp({
        source: "rhodium-probe",
        onQRCodeReady: ({ url, expireIn }) => {
          writeFileSync(`${OUT}/qr.png`, qrPng(url));
          writeFileSync(`${OUT}/link.txt`, url + "\n");
          note("qr", { link, expireIn, url });
          say(`QR ${link}/7 in ${OUT}/qr.png, link in ${OUT}/link.txt, good for ${Math.round(expireIn / 60)} min`);
        },
        onStatusChange: (s) => note("scan", { ...s }),
      });
      note("scanned", { appId: r.client_id, user_info: r.user_info });
      if (r.user_info?.tenant_brand === "lark") throw new Error("scanned with a Lark account; only domestic Feishu is supported");
      const creds = { appId: r.client_id, appSecret: r.client_secret, brand: r.user_info?.tenant_brand ?? "", ownerOpenId: r.user_info?.open_id ?? "", createdAt: new Date().toISOString() };
      mkdirSync(dirname(CRED), { recursive: true, mode: 0o700 });
      writeFileSync(CRED, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
      chmodSync(CRED, 0o600);
      say(`app ${creds.appId} saved in ${CRED}`);
      return creds;
    } catch (e: any) {
      note("scan-error", { code: e?.code, description: e?.description, message: e?.message });
      if (e?.code !== "expired_token") throw e;
    }
  }
  throw new Error("all 7 links expired unscanned");
}

const creds: Creds = existsSync(CRED) ? JSON.parse(readFileSync(CRED, "utf8")) : await scan();
secrets.push(creds.appSecret);
let owner = creds.ownerOpenId;
sum(`# Feishu probe ${new Date().toISOString()}${fake ? " (fake)" : ""}\n\napp ${creds.appId}, brand ${creds.brand}, scanner ${owner}\n`);

// ---- Inbound ----

type Msg = { message_id: string; message_type: string; content: string; parent_id?: string; root_id?: string; chat_id: string; create_time: string; sender: string; pushes: number[] };
type In = { msg: Msg } | { press: Record<string, string> };
const seen = new Map<string, Msg>(); // by message_id: Feishu pushes at least once
let chatId: string | undefined;
let waiter: ((i: In) => boolean) | undefined;
const deliver = (i: In) => waiter?.(i) || note("stray", i);

const dispatcher = new lark.EventDispatcher({ logger: sdkLog, loggerLevel: lark.LoggerLevel.info }).register({
  "im.message.receive_v1": async (d: any) => {
    const m = d.message;
    const lag = Date.now() - Number(m.create_time);
    const known = seen.get(m.message_id);
    note("message", { lag, again: !!known, event: d });
    if (known) return void known.pushes.push(Date.now());
    const msg: Msg = { ...m, sender: d.sender?.sender_id?.open_id, pushes: [Date.now()] };
    seen.set(m.message_id, msg);
    chatId ??= m.chat_id;
    deliver({ msg });
  },
  "card.action.trigger": async (d: any) => {
    const value: Record<string, string> = d.action?.value ?? {};
    note("press", { lag: Date.now() - Number(d.create_time) / 1000, event: d }); // a press's create_time is in microseconds
    deliver({ press: value });
    return { toast: { type: "info", content: `收到：${value.choice ?? "?"}` } };
  },
});

let ws: lark.WSClient | undefined;
/** A new long connection; true once it is up. */
async function connect(): Promise<boolean> {
  const t0 = Date.now();
  const ready = Promise.withResolvers<boolean>();
  ws = new lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain,
    logger: sdkLog,
    loggerLevel: lark.LoggerLevel.info,
    onReady: () => ready.resolve(true),
    onError: (e) => (note("ws-error", { message: e.message }), ready.resolve(false)),
    onReconnecting: () => note("ws-reconnecting"),
    onReconnected: () => note("ws-reconnected"),
  });
  // The SDK hands on only frames of type event; should a press come as type card, it is noted and handled the same.
  const handle = (ws as any).handleEventData.bind(ws);
  (ws as any).handleEventData = (data: { headers: { key: string; value: string }[] }) => {
    const type = data.headers.find((h) => h.key === "type");
    if (type && type.value !== "event") (note("frame", { type: type.value }), (type.value = "event"));
    return handle(data);
  };
  void ws.start({ eventDispatcher: dispatcher });
  const up = await Promise.race([ready.promise, Bun.sleep(30_000).then(() => false)]);
  note("ws", { up, ms: Date.now() - t0 });
  return up;
}

// ---- Outbound ----

type Button = { label: string; value: Record<string, string> };
/** A JSON 2.0 card: one markdown element, then a row of callback buttons. */
const card = (md: string, buttons: Button[] = [], wide = false) => ({
  schema: "2.0",
  config: { update_multi: true, ...(wide && { width_mode: "fill" }) },
  body: {
    elements: [
      { tag: "markdown", content: md },
      ...(buttons.length
        ? [{ tag: "column_set", flex_mode: "flow", columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [{ tag: "button", text: { tag: "plain_text", content: b.label }, type: b.label === "跳过" ? "default" : "primary", behaviors: [{ type: "callback", value: b.value }] }] })) }]
        : []),
    ],
  },
});

async function send(content: object, type = "interactive"): Promise<string | undefined> {
  const r = await api(`message.create ${type}`, () => client.im.v1.message.create({ params: { receive_id_type: "open_id" }, data: { receive_id: owner, msg_type: type, content: JSON.stringify(content), uuid: randomUUID() } }));
  if (!r.ok) return void say(`send failed: ${brief(r.error)}`);
  chatId ??= r.data.data?.chat_id;
  return r.data.data?.message_id;
}
const patch = (id: string, c: object) => api("message.patch", () => client.im.v1.message.patch({ path: { message_id: id }, data: { content: JSON.stringify(c) } }));

/** Waits for the first inbound that pick takes, or the timeout. */
function wait<T>(pick: (i: In) => T | undefined, timeout = STEP): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => ((waiter = undefined), resolve(undefined)), timeout);
    waiter = (i) => {
      const got = pick(i);
      if (got === undefined) return false;
      clearTimeout(timer);
      waiter = undefined;
      resolve(got);
      return true;
    };
  });
}

type Got = { id?: string; msg?: Msg; choice?: string };
let timeouts = 0;
let streak = 0; // timeouts in a row
/** A step's card with its choices and 跳过; then your press, or a message that want takes. */
async function step(id: string, text: string, choices: string[] = [], want?: (m: Msg) => boolean): Promise<Got> {
  say(`step ${id}`);
  const sent = await send(card(text, [...choices, "跳过"].map((c) => ({ label: c, value: { step: id, choice: c } }))));
  if (!sent) return (sum(`- ${id}: card not sent`), {});
  const got = await wait<Got>((i) => ("press" in i ? (i.press.step === id ? { choice: i.press.choice } : undefined) : want?.(i.msg) ? { msg: i.msg } : undefined));
  if (!got) timeouts++;
  streak = got ? 0 : streak + 1;
  sum(`- ${id}: ${!got ? "timed out" : got.choice ? `pressed ${got.choice}` : `${got.msg!.message_type} ${got.msg!.message_id}, ${got.msg!.content.slice(0, 300)}`}`);
  if (streak === 2) throw new Error("two steps in a row timed out: you are away, or nothing comes in (is the app on the long connection?)");
  return { id: sent, ...got };
}
const media = (m: Msg) => m.message_type !== "text";
const anything = () => true;
const fields = (m: Msg) => JSON.parse(m.content) as Record<string, any>;

/** Downloads a message's file into OUT; its path, or undefined. */
async function download(m: Msg, key: string, type: "image" | "file", name: string): Promise<string | undefined> {
  const path = `${OUT}/in-${m.message_id}-${name}`;
  const r = await api(`messageResource.get ${type}`, async () => {
    const res = await client.im.v1.messageResource.get({ path: { message_id: m.message_id, file_key: key }, params: { type } });
    await res.writeFile(path);
    return { bytes: statSync(path).size, headers: res.headers };
  });
  sum(`  - download ${type}: ${r.ok ? `${r.data.bytes} bytes, ${r.data.headers?.["content-type"]}` : brief(r.error)}`);
  return r.ok ? path : undefined;
}

/** Sends a downloaded file back as Rhodium sends one: upload, then an image or file message. A stream,
 *  as the SDK's examples have it: a Buffer goes as a form field with no file name. */
async function echo(path: string, kind: "image" | "file", name: string): Promise<boolean> {
  const up =
    kind === "image"
      ? await api("image.create", () => client.im.v1.image.create({ data: { image_type: "message", image: createReadStream(path) } }))
      : await api("file.create", () => client.im.v1.file.create({ data: { file_type: "stream", file_name: name, file: createReadStream(path) } }));
  const key = up.ok ? (up.data as Record<string, string> | null)?.[`${kind}_key`] : undefined;
  const sent = key ? await send({ [`${kind}_key`]: key }, kind) : undefined;
  sum(`  - sent back as ${kind}: ${sent ? "yes" : up.ok ? "upload gave no key" : brief(up.error)}`);
  return !!sent;
}

const fetchInfo = async (url: string | undefined) => {
  if (!url) return "no url";
  try {
    const r = await fetch(url);
    return `${r.status} ${r.headers.get("content-type")} ${(await r.arrayBuffer()).byteLength} bytes`;
  } catch (e) {
    return String(e);
  }
};

// ---- The session ----

const client = new lark.Client({ appId: creds.appId, appSecret: creds.appSecret, domain, logger: sdkLog, loggerLevel: lark.LoggerLevel.info });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (sum(`- stopped by ${sig}`), process.exit(130)));

// First, over the API alone: the bot, the scopes Feishu granted, your name and avatar, the / menu.
const bot = await api("bot.info", () => client.request({ method: "GET", url: "/open-apis/bot/v3/info" }));
sum(`## Facts\n\n- bot info: ${bot.ok ? `${bot.data.bot?.app_name}, open_id ${bot.data.bot?.open_id}, avatar ${await fetchInfo(bot.data.bot?.avatar_url)}` : brief(bot.error)}`);
// An app picked on the scan page instead of a new one may be in use elsewhere, lark-cli's say: Feishu
// would split its events between the two connections, and the / menu would change there.
if (bot.ok && !String(bot.data.bot?.app_name).includes("Rhodium"))
  throw new Error(`the app is ${bot.data.bot?.app_name}, not the dev app: delete ${CRED} and scan again, picking Rhodium 测试机 or 新建`);
const scopes = await api("scope.list", () => client.application.v6.scope.list({}));
if (scopes.ok) {
  const all = scopes.data.data?.scopes ?? [];
  const granted = all.filter((s) => s.grant_status === 1).map((s) => s.scope_name);
  sum(`- scopes: ${granted.length} granted of ${all.length} listed`);
  sum(`  - asked for, not granted: ${SCOPES.filter((s) => !granted.includes(s)).join(", ") || "none"}`);
  sum(`  - granted, not asked for: ${granted.filter((s) => !SCOPES.includes(s)).join(", ") || "none"}`);
  sum(`  - listed, not granted: ${all.filter((s) => s.grant_status !== 1).map((s) => s.scope_name).join(", ") || "none"}`);
} else sum(`- scopes: ${brief(scopes.error)}`);
const user = await api("contact.user.get", () => client.contact.v3.user.get({ path: { user_id: owner }, params: { user_id_type: "open_id" } }));
const you = user.ok ? user.data.data?.user : undefined;
sum(`- you by contact API: ${user.ok ? `name ${you?.name ?? "(none)"}, avatar_240 ${await fetchInfo(you?.avatar?.avatar_240)}` : brief(user.error)}`);
const SLASH = "/open-apis/application/v7/app_slash_commands";
const menuAt = Date.now();
await api("slash.list", () => client.request({ method: "GET", url: SLASH }));
const made: string[] = [];
for (const item of slashMenu("claude")) {
  const r = await api("slash.create", () => client.request({ method: "POST", url: SLASH, data: { command: item.command.slice(1), description: { default_value: item.description } } }));
  made.push(`${item.command} ${r.ok ? "ok" : brief(r.error)}`);
}
const listed = await api("slash.list", () => client.request({ method: "GET", url: SLASH }));
sum(`- slash commands: ${made.join("; ")}; list after: ${listed.ok ? JSON.stringify(listed.data.data).slice(0, 300) : brief(listed.error)}\n\n## Steps\n`);
if (!(await connect())) throw new Error("the long connection did not come up; see log.jsonl");

// 1. Text; if the card can't reach you, a message from you first, and you are its sender.
let hello = await step("hello", "Rhodium 探针开始了：一步步试飞书 Bot，十几分钟。每步都能点“跳过”。\n\n**第 1 步**：随便发一句话。", [], anything);
if (!hello.id) {
  say("The first card did not go out. In Feishu, find Rhodium 测试机 and send it a message.");
  const first = await wait((i) => ("msg" in i ? i.msg : undefined));
  if (!first) throw new Error("no message came; see log.jsonl");
  hello = { msg: first };
  owner = first.sender;
}
if (hello.msg) sum(`  - sender ${hello.msg.sender}, ${hello.msg.sender === creds.ownerOpenId ? "the scanner's open_id" : "NOT the scanner's open_id"}; p2p chat ${chatId}`);

// 2. A Rhodium-like card, edited in place every 3 s for 30 s; then whether its text can be copied, and how it looks.
const SAMPLE = [
  "**Rhodium 卡片样例**",
  "",
  "> [🔧 Read、Edit ×2、Bash]",
  "",
  "改好了 `src/render.ts`。路径：~/Rhodium/src/render.ts 和 /home/user/Rhodium-wt/feishu-probe/scripts/probes/feishu/probe.ts",
  "",
  "- 列表一项",
  "- 第二项：**粗体**、*斜体*、~~删除线~~、[链接](https://open.feishu.cn)",
  "  - 嵌套的一项",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "| 文件 | 改动 |",
  "|---|---|",
  "| render.ts | +12 −3 |",
  "| 一个很长的中文单元格，看它换不换行 | 0 |",
  "",
  "```ts",
  "const v: Vec<T> = a || b; // $HOME *不是斜体* <details>",
  "```",
  "",
  "下面 E1 到 E10 各占一行。符号都该原样显示：不变成粗体、斜体、标题、列表、表情或颜色，也看不到反斜杠和 &amp;#42; 这样的转义。",
  "E1 \\*不是斜体\\*",
  "E2 &#42;不是斜体&#42;",
  "E3 snake_case_name 和 __init__.py",
  "E4 Vec<T>、Option<String> 和 <details>",
  "E5 a &reg b &copy c &amp; d",
  "E6 $HOME、$5 到 $10、$x^2$",
  "E7 a || b、x == y、~~",
  "E8 下一行该是井号开头的普通字：",
  "\\# 不是标题",
  "E9 1\\. 不是列表",
  "E10 :OK: 和 <font color='red'>不是红字</font>",
  "",
  "很长的一行：" + "飞书卡片里一行很长的中文会怎么折行".repeat(6) + "averyveryverylongidentifierwithoutanyspaces".repeat(3) + " https://example.com/" + "a/".repeat(40),
].join("\n");
const sample = (n: number) => SAMPLE + Array.from({ length: n }, (_, i) => `\n\n第 ${i + 1} 次改写（每 3 秒一次，共 10 次）。`).join("");
say("step card: edits");
const cardId = await send(card(sample(0), [], true));
const edits: string[] = [];
for (let i = 1; cardId && i <= 10; i++) {
  await Bun.sleep(ms(3000));
  const t0 = Date.now();
  const r = await patch(cardId, card(sample(i), [], true));
  edits.push(r.ok ? `${Date.now() - t0} ms` : brief(r.error));
}
sum(`- card: ${cardId ? `10 edits every 3 s: ${edits.join(", ")}` : "not sent"}`);
await step("copy-phone", "**第 2 步**：上面这张卡片每 3 秒改写一次，共 30 秒。\n\n手机上，长按卡片里的字，能选中复制吗？", ["能", "不能"]);
await step("copy-desktop", "电脑版飞书上，卡片里的字能选中复制吗？", ["能", "不能", "没有电脑版"]);
const render = await step("render", "对照卡片里的 E1 到 E10 和其余部分，哪里显示得不对？都对就点“都对”；不对就直接发文字或截图。", ["都对"], anything);
// Your screenshots, kept to look at.
const keep = async (m: Msg) => void (m.message_type === "image" && (await download(m, fields(m).image_key, "image", "feedback.png")));
if (render.msg) {
  await keep(render.msg);
  await send(card("收到。还要补充就接着发，说完点“说完了”。", [{ label: "说完了", value: { step: "more", choice: "说完了" } }]));
  for (let m; (m = await wait<Msg | "done">((i) => ("press" in i ? (i.press.step === "more" ? "done" : undefined) : i.msg))) && m !== "done"; ) {
    sum(`  - and ${m.message_type} ${m.message_id}, ${m.content.slice(0, 300)}`);
    await keep(m);
  }
}

// 3. A press: its toast, and the buttons taken off after.
const press = await step("press", "**第 3 步**：点下面任一按钮。", ["按钮 A", "按钮 B"]);
if (press.id && press.choice && press.choice !== "跳过") {
  const r = await patch(press.id, card(`**第 3 步**：点下面任一按钮。\n\n你点了“${press.choice}”，按钮去掉了。`));
  sum(`  - buttons taken off: ${r.ok ? "ok" : brief(r.error)}`);
  await step("toast", `刚才点完，弹出“收到：${press.choice}”的提示了吗？按钮去掉了吗？`, ["都有", "没弹提示", "按钮还在"]);
}

// 4. Downtime: the probe goes away for 90 s while you send a message; then the backfill, and later pushes.
say("step downtime");
await send(card("**第 4 步**：探针马上下线 90 秒。看到这条就发一句话，比如“断线时发的”。90 秒后它回来，会告诉你。"));
const closedAt = Date.now();
ws?.close({ force: true });
note("ws-closed");
await Bun.sleep(ms(90_000));
const back = await connect();
const openedAt = Date.now();
if (!back) throw new Error("the long connection did not come back; see log.jsonl");
const history: any[] = [];
const end = Math.floor(Date.now() / 1000);
let page: string | undefined;
if (chatId) do {
  const r = await api("message.list", () => client.im.v1.message.list({ params: { container_id_type: "chat", container_id: chatId!, start_time: String(end - 24 * 3600), end_time: String(end), sort_type: "ByCreateTimeAsc", page_size: 50, ...(page && { page_token: page }) } }));
  if (!r.ok) break;
  history.push(...(r.data.data?.items ?? []));
  page = r.data.data?.has_more ? r.data.data.page_token : undefined;
} while (page);
const yours = history.filter((m) => m.sender?.sender_type === "user");
const during = yours.filter((m) => +m.create_time >= closedAt && +m.create_time <= openedAt);
const unpushed = yours.filter((m) => !seen.has(m.message_id));
sum(`- downtime: away ${Math.round((openedAt - closedAt) / 1000)} s; backfill listed ${history.length} messages in 24 h, ${yours.length} yours, ${during.length} sent while away, ${unpushed.length} of yours never pushed so far: ${unpushed.map((m) => `${m.message_id} ${m.body?.content}`).join("; ")}`);
const text = (m: any) => (m.msg_type === "text" ? JSON.parse(m.body?.content ?? "{}").text : m.msg_type);
await send(card(during.length ? `回来了。断线时你发的话，翻历史找到了：${during.map(text).join("、")}。飞书会不会补推，后面几分钟里记着，接着做下一步。` : "回来了。翻历史没找到断线时你发的话。"));

// 5-11. What you can send: each kind, as Feishu gives it.
const image = await step("image", "**第 5 步**：发一张图片，截图就行。", [], media);
let echoed = "";
if (image.msg?.message_type === "image") {
  const path = await download(image.msg, fields(image.msg).image_key, "image", "image");
  if (path && (await echo(path, "image", "image.png"))) echoed = "上面是你的图片，探针下载后又传回来的。\n\n";
}
const file = await step("file", `${echoed}**第 6 步**：发一个文件，什么都行。`, [], media);
echoed = "";
if (file.msg?.message_type === "file") {
  const name = fields(file.msg).file_name ?? "file";
  const path = await download(file.msg, fields(file.msg).file_key, "file", name);
  if (path && (await echo(path, "file", name))) echoed = "上面是你的文件，探针下载后又传回来的。\n\n";
}
const audio = await step("audio", `${echoed}**第 7 步**：发一条语音，说两三秒。`, [], media);
if (audio.msg?.message_type === "audio") await download(audio.msg, fields(audio.msg).file_key, "file", "audio.opus");
const sticker = await step("sticker", "**第 8 步**：发一个表情包（表情面板里的贴纸，不是文字里的小表情）。", [], media);
if (sticker.msg?.message_type === "sticker") await download(sticker.msg, fields(sticker.msg).file_key, "image", "sticker");
const forward = await step("forward", "**第 9 步**：选两三条消息合并转发到这里。这个对话里的也行：长按一条，点“多选”，勾几条，再点“合并转发”。", [], media);
if (forward.msg) {
  const r = await api("message.get", () => client.im.v1.message.get({ path: { message_id: forward.msg!.message_id } }));
  const items = r.ok ? (r.data.data?.items ?? []) : [];
  sum(`  - its messages: ${r.ok ? items.map((m) => `${m.upper_message_id ? "child" : "top"} ${m.msg_type} ${m.body?.content?.slice(0, 120)}`).join("; ") : brief(r.error)}`);
}
const reply = await step("reply", "**第 10 步**：长按上面任意一条消息，点“回复”，随便回一句。", [], anything);
if (reply.msg) {
  sum(`  - parent_id ${reply.msg.parent_id ?? "none"}, root_id ${reply.msg.root_id ?? "none"}`);
  if (reply.msg.parent_id) {
    const r = await api("message.get", () => client.im.v1.message.get({ path: { message_id: reply.msg!.parent_id! } }));
    const parent = r.ok ? r.data.data?.items?.[0] : undefined;
    sum(`  - the parent: ${parent ? `${parent.msg_type} by ${parent.sender?.sender_type}, ${parent.body?.content?.slice(0, 200)}` : brief(r.ok ? "none" : r.error)}`);
  }
}
await step("post", "**第 11 步**：发一条带格式的消息：点输入框旁的“Aa”，加个标题或把一个词加粗，再发。", [], anything);

// 12. The / menu, set before step 1; Feishu clients take about 5 minutes to show it.
const fresh = Date.now() - menuAt < 5 * MIN ? "（菜单设好还不到 5 分钟，可能还没出现。）" : "";
await step("slash", `**第 12 步**：在输入框里打“/”，看有没有 Rhodium 的命令菜单。有就选 /rh_help 发出来；没有就点“没有菜单”。${fresh}`, ["没有菜单"], anything);

// Later pushes of what you sent while away: Feishu retries 15 s, 5 min, 1 h and 6 h after the first push.
const last = Math.max(0, ...during.map((m) => +m.create_time));
const until = last + ms(6 * MIN);
if (during.length && Date.now() < until) {
  await send(card(`最后等飞书补推断线时那句话，约 ${Math.ceil((until - Date.now()) / MIN)} 分钟，不用操作。`));
  say(`waiting ${Math.round((until - Date.now()) / 1000)} s for pushes`);
  await Bun.sleep(until - Date.now());
}
for (const m of during) {
  const got = seen.get(m.message_id);
  const at = (t: number) => `${Math.round((t - +m.create_time) / 1000)} s after sending, ${Math.round((t - openedAt) / 1000)} s after reconnecting`;
  sum(`- pushed while away: ${m.message_id}: ${got ? got.pushes.map(at).join("; ") : "never pushed"}`);
}
const lags = [...seen.values()].map((m) => m.pushes[0]! - +m.create_time).sort((a, b) => a - b);
sum(`- push lag after sending, first pushes: min ${lags[0]} ms, median ${lags[lags.length >> 1]} ms, max ${lags.at(-1)} ms`);
sum(`- pushed more than once: ${[...seen.values()].filter((m) => m.pushes.length > 1).map((m) => `${m.message_id} ${m.pushes.length} times`).join(", ") || "none"}`);
await send(card("探针跑完了，谢谢。结果在这台机器的 /tmp/rhodium-test-feishu-probe/。"));
sum(`\n## API calls\n\n${Object.entries(calls).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
ws?.close({ force: true });

if (f) {
  const fails = [
    timeouts && `${timeouts} steps timed out`,
    !f.toasts.length && "no toast came back",
    !during.length && "the backfill missed the message sent while away",
    !during.some((m) => seen.get(m.message_id)) && "the message sent while away was never pushed",
    f.counts.patches < 11 && `${f.counts.patches} patches`,
    f.counts.uploads < 2 && `${f.counts.uploads} uploads`,
    f.commands.length !== slashMenu("claude").length && `${f.commands.length} slash commands`,
  ].filter(Boolean);
  f.stop();
  say(fails.length ? `FAKE RUN FAILED: ${fails.join(", ")}` : "fake run ok");
  process.exit(fails.length ? 1 : 0);
}
say(`done; ${OUT}/summary.md`);
process.exit(0);
