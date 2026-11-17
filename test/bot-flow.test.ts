// The bot-making flow in rhodium, through the board's interface (spec web-bots, architecture §8.5.1):
// start one, read its state, hand it what was pasted, cancel it. QQ's QR service is a stand-in
// preloaded into rhodium; Telegram's Bot API and Feishu are local stand-ins (test/bot-api.ts,
// test/feishu-api.ts). No page yet: the wizard is another ticket's.
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { qrSvg } from "../src/bot-flow";
import { loadConfig } from "../src/config";
import { botApi } from "./bot-api";
import { APP, BOT, feishuApi, ME, SECRET } from "./feishu-api";
import { QR } from "./fake-qq-connect";
import { BOARD_LOGIN, newInstance, until, type Daemon, type Instance } from "./instance";

const TOKEN = "123456:pasted-token-never-shown";
const MAIN = join(import.meta.dir, "../src/main.ts");
const FAKE_QQ = join(import.meta.dir, "fake-qq-connect.ts");

let rhodium: Instance;
let api: ReturnType<typeof botApi> | undefined;
let fs: ReturnType<typeof feishuApi> | undefined;
afterEach(async () => {
  await rhodium?.cleanup();
  api?.stop();
  fs?.stop();
  [api, fs] = [undefined, undefined];
});

type View = { id: string; name: string; platform: string; state: string; url?: string; svg?: string; expires?: number; error?: string; code?: string; until?: number; target?: string; log?: unknown };
type Reply = { ok: true; text: string; flow: View } | { ok: false; error: string };

/** The board at base, as its own page asks it; every answer's text kept in said. Events: what its event stream told. */
function board(base: string) {
  const own = { "Tailscale-User-Login": BOARD_LOGIN, "sec-fetch-site": "same-origin" };
  const said: string[] = [];
  const call = async (path: string, init: RequestInit = {}): Promise<Reply> => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...own, ...(init.body && { "content-type": "application/json" }) } });
    const text = await r.text();
    said.push(text);
    return JSON.parse(text);
  };
  const events: string[] = [];
  const ac = new AbortController();
  void fetch(`${base}/api/events`, { headers: own, signal: ac.signal })
    .then(async (r) => {
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) events.push(chunk);
    })
    .catch(() => {});
  return {
    said,
    events,
    close: () => ac.abort(),
    start: (body: object) => call("/api/bots/flow", { method: "POST", body: JSON.stringify(body) }),
    get: (id: string) => call(`/api/bots/flow?id=${id}`),
    paste: (id: string, credentials: object) => call("/api/bots/flow/credentials", { method: "POST", body: JSON.stringify({ id, ...credentials }) }),
    cancel: (id: string) => call(`/api/bots/flow?id=${id}`, { method: "DELETE" }),
    /** The flow's state, once check takes it. */
    async once(id: string, check: (v: View) => boolean, timeoutMs = 15_000): Promise<View> {
      let last: View | undefined;
      await until(async () => {
        const r = await call(`/api/bots/flow?id=${id}`);
        return r.ok && check((last = r.flow));
      }, timeoutMs);
      return last!;
    },
  };
}

async function started(d: Daemon): Promise<string> {
  return `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
}

/** The files under dir that hold s anywhere in their bytes. */
const filesWith = (dir: string, s: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name), "latin1").includes(Buffer.from(s).toString("latin1")))
    .map((e) => join(e.parentPath, e.name));

/** s is in no answer, event, log line or file rhodium keeps. */
function nowhere(s: string, b: ReturnType<typeof board>, d: Daemon) {
  expect(b.said.join("\n")).not.toContain(s);
  expect(b.events.join("")).not.toContain(s);
  expect(JSON.stringify(d.logs)).not.toContain(s);
  expect(filesWith(join(rhodium.dir, "state"), s)).toEqual([]);
}

/** The dark modules of the QR code qrcode-terminal draws for text at a terminal, as "x y", its border left out. */
function terminalModules(text: string): Set<string> {
  let drawn = "";
  require("qrcode-terminal").generate(text, { small: true }, (s: string) => (drawn = s));
  const rows = drawn.split("\n").slice(1, -1);
  const dark = new Set<string>();
  rows.forEach((line, i) =>
    [...line.slice(1, -1)].forEach((ch, x) => {
      if (ch === "▄" || ch === " ") dark.add(`${x} ${2 * i}`);
      if (ch === "▀" || ch === " ") dark.add(`${x} ${2 * i + 1}`);
    }),
  );
  return dark;
}

test("story 674: the QR code as an SVG picture is the one rh draws at the terminal, with a light border round it", () => {
  const svg = qrSvg(QR.url);
  expect(svg).toStartWith("<svg ");
  const pad = 4;
  const dark = new Set([...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${Number(m[1]) - pad} ${Number(m[2]) - pad}`));
  expect(dark).toEqual(terminalModules(QR.url));
});

test("stories 672, 674, 675, 677: a QQ flow from the board: a name, a platform or a slot that won't do is turned down at once; one that will gets an id and a QR code, a new one when it expires, each told as bot_flow; the scan writes the bot in, the scanner as its owner, and the flow is done", async () => {
  // The new bot's made-up AppID never reaches QQ: its requests go to a proxy that is not there.
  const env = { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: "me-under-q", target: "w/a" } }, env });
  const d = await rhodium.start([process.execPath, "--preload", FAKE_QQ, MAIN]);
  await rhodium.slots("a");
  const b = board(await started(d));
  const before = readFileSync(rhodium.config, "utf8");

  expect(await b.start({ name: "t.1", platform: "qq", target: "w/a" })).toEqual({ ok: false, error: expect.stringMatching(/^Bot\ 名字只能由英文字母、数字和\ _\ \-\ 组成/) });
  expect(await b.start({ name: "q2", platform: "wechat", target: "w/a" })).toEqual({ ok: false, error: expect.stringMatching(/^平台只能是\ qq、telegram\ 或\ feishu：wechat/) });
  expect(await b.start({ name: "q2", platform: "qq", target: "w/nope" })).toEqual({ ok: false, error: "没有槽位 w/nope。" });
  expect(await b.start({ name: "q", platform: "qq", target: "w/a" })).toEqual({ ok: false, error: "已经有 Bot q。" });
  // A flow named rm would be rh bot rm q: it is turned down before it reaches the router.
  expect(await b.start({ name: "rm", platform: "q" })).toEqual({ ok: false, error: "Bot 不能叫 rm：rh bot rm 是去掉 Bot 用的。" });
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);

  const r = await b.start({ name: "q2", platform: "qq", target: "w/a" });
  if (!r.ok) throw new Error(r.error);
  expect(r.flow).toMatchObject({ name: "q2", platform: "qq", state: "scan" });
  expect(r.flow.log).toBeUndefined(); // rh's lines, not the page's
  // One name, one flow at a time.
  expect(await b.start({ name: "q2", platform: "qq", target: "w/a" })).toEqual({ ok: false, error: expect.stringContaining("Bot q2 正在建") });

  // The first QR code expires; its stand-in is scanned. Done, the bot is in the config, the scanner its owner.
  const done = await b.once(r.flow.id, (v) => v.state === "done");
  expect(done).toMatchObject({ state: "done", name: "q2", target: "w/a" });
  expect(done.svg).toBeUndefined();
  expect(loadConfig(rhodium.config).bots.q2).toEqual({ platform: "qq", appId: QR.appId, secret: QR.secret, owner: QR.openid, target: "w/a" });
  // Each QR code was told, the new one after the one that expired.
  const told = b.events.join("").match(/^event: bot_flow\ndata: .*$/gm) ?? [];
  expect(told.length).toBeGreaterThanOrEqual(3);
  expect(told.every((e) => e.endsWith(JSON.stringify({ id: r.flow.id })))).toBe(true);
  b.close();
  nowhere(QR.secret, b, d);
}, 60_000);

test("story 675: the board sees the QR code change as one expires: its link and picture", async () => {
  fs = feishuApi();
  fs.scan.expire = 1000; // every link expires unscanned
  rhodium = newInstance();
  const d = await rhodium.start();
  await rhodium.slots("a");
  const b = board(await started(d));
  const r = await b.start({ name: "fs", platform: "feishu", target: "w/a", apiRoot: fs.url });
  if (!r.ok) throw new Error(r.error);
  const first = await b.once(r.flow.id, (v) => v.url !== undefined);
  expect(first.state).toBe("scan");
  expect(first.url).toStartWith("https://open.feishu.cn/page/launcher?user_code=FAKE-");
  expect(first.svg).toBe(qrSvg(first.url!));
  expect(first.expires).toBeGreaterThan(Date.now() + 3_500_000); // an hour, as Feishu gives it
  const next = await b.once(r.flow.id, (v) => v.url !== first.url);
  expect(next.svg).toBe(qrSvg(next.url!));

  // Cancelled: the scan stops, nothing is written, and the name is free again.
  const before = readFileSync(rhodium.config, "utf8");
  expect(await b.cancel(r.flow.id)).toMatchObject({ ok: true, flow: { state: "cancelled" } });
  await Bun.sleep(300);
  const links = fs.scan.links;
  await Bun.sleep(500);
  expect(fs.scan.links).toBe(links);
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
  expect((await b.get(r.flow.id)) as unknown).toMatchObject({ ok: true, flow: { state: "cancelled" } });
  expect(await b.start({ name: "fs", platform: "feishu", target: "w/a", apiRoot: fs.url })).toMatchObject({ ok: true });
  b.close();
}, 60_000);

test("story 677: a scan that brings back no account of yours writes the bot in and waits for its pairing, with a code; your code sent, the flow is done; the bot took your message at once", async () => {
  fs = feishuApi();
  fs.scan.by = BOT;
  rhodium = newInstance();
  const d = await rhodium.start();
  await rhodium.slots("a");
  const b = board(await started(d));
  const r = await b.start({ name: "fs", platform: "feishu", target: "w/a", apiRoot: fs.url });
  if (!r.ok) throw new Error(r.error);
  const pairing = await b.once(r.flow.id, (v) => v.state === "pairing");
  // Checked apart: toMatchObject puts its matchers in place of what they matched.
  expect([pairing.code?.length, typeof pairing.until, pairing.target]).toEqual([8, "number", "w/a"]);
  expect(loadConfig(rhodium.config).bots.fs).toEqual({ platform: "feishu", appId: APP, secret: SECRET, apiRoot: fs.url, target: "w/a" });
  await fs.connected();
  fs.say(pairing.code!);
  expect(await b.once(r.flow.id, (v) => v.state === "done")).toMatchObject({ state: "done", target: "w/a" });
  // The reply goes out after the flow is told done.
  await until(() => fs!.sent.some((m) => JSON.stringify(m.card).includes("已配对")));
  b.close();
  nowhere(SECRET, b, d);
}, 60_000);

test("story 676: a Telegram token pasted on the board: one Telegram turns down gets why and the flow waits on, nothing written; a good one is written in and the flow waits for its pairing; the token is in no answer, event, log or file but the config", async () => {
  api = botApi({ token: TOKEN });
  rhodium = newInstance();
  const d = await rhodium.start();
  await rhodium.slots("a");
  const b = board(await started(d));
  const before = readFileSync(rhodium.config, "utf8");
  const r = await b.start({ name: "t", platform: "telegram", target: "w/a", apiRoot: api.url });
  if (!r.ok) throw new Error(r.error);
  expect(r.flow.state).toBe("paste");

  const wrong = await b.paste(r.flow.id, { token: "999:not-a-bot" });
  expect(wrong).toEqual({ ok: false, error: expect.stringMatching(/^Telegram\ 不认这个\ token：/) });
  expect(await b.get(r.flow.id)).toMatchObject({ ok: true, flow: { state: "paste", error: expect.stringMatching(/^Telegram\ 不认这个\ token：/) } });
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
  expect(b.said.join("\n")).not.toContain("999:not-a-bot");

  const right = await b.paste(r.flow.id, { token: TOKEN });
  expect(right).toMatchObject({ ok: true });
  const pairing = await b.once(r.flow.id, (v) => v.state === "pairing");
  expect(pairing.error).toBeUndefined();
  expect(loadConfig(rhodium.config).bots.t).toEqual({ platform: "telegram", token: TOKEN, apiRoot: api.url, target: "w/a" });
  api.say(pairing.code!);
  await b.once(r.flow.id, (v) => v.state === "done");
  // Pasted again once the flow is past it: turned down.
  expect(await b.paste(r.flow.id, { token: TOKEN })).toMatchObject({ ok: false });
  b.close();
  nowhere(TOKEN, b, d);
}, 60_000);

test("story 676: a Feishu App ID checked once with its secret is not taken again with a wrong one: no token kept from the first check lets it through", async () => {
  fs = feishuApi();
  rhodium = newInstance();
  const d = await rhodium.start();
  await rhodium.slots("a");
  const b = board(await started(d));
  const first = await b.start({ name: "fs", platform: "feishu", target: "w/a", paste: true, apiRoot: fs.url });
  if (!first.ok) throw new Error(first.error);
  expect(await b.paste(first.flow.id, { appId: APP, secret: SECRET })).toMatchObject({ ok: true });
  await b.once(first.flow.id, (v) => v.state === "pairing");

  const before = readFileSync(rhodium.config, "utf8");
  const second = await b.start({ name: "fs2", platform: "feishu", target: "w/a", paste: true, apiRoot: fs.url });
  if (!second.ok) throw new Error(second.error);
  expect(await b.paste(second.flow.id, { appId: APP, secret: "mistyped-secret" })).toEqual({ ok: false, error: expect.stringMatching(/^飞书不认这组\ App\ ID\ 和密钥：/) });
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
  b.close();
}, 60_000);

test("architecture §11: the flow's paths take the board's own page alone", async () => {
  rhodium = newInstance();
  const d = await rhodium.start();
  await rhodium.slots("a");
  const base = await started(d);
  const json = { "content-type": "application/json" };
  const tries: [string, RequestInit][] = [
    ["/api/bots/flow", { method: "POST", headers: json, body: JSON.stringify({ name: "t", platform: "telegram", target: "w/a" }) }],
    ["/api/bots/flow?id=x", {}],
    ["/api/bots/flow?id=x", { method: "DELETE" }],
    ["/api/bots/flow/credentials", { method: "POST", headers: json, body: JSON.stringify({ id: "x", token: TOKEN }) }],
  ];
  for (const [path, init] of tries) {
    for (const h of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example.com" }, {}] as Record<string, string>[]) {
      const r = await fetch(`${base}${path}`, { ...init, headers: { "Tailscale-User-Login": BOARD_LOGIN, ...(init.headers as object), ...h } });
      expect([path, init.method, h, r.status]).toEqual([path, init.method, h, 403]);
    }
  }
  expect(readFileSync(rhodium.config, "utf8")).not.toContain("[bots.t]");
}, 30_000);
