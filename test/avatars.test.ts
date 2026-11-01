// Avatars and your Telegram name (spec web-topology "头像"): each adapter's profile, against local
// stand-ins for the platforms' HTTP APIs, and the board serving what was kept. What the platforms
// themselves answer is not in automated tests: acceptance finds it changed.
import { afterAll, expect, test } from "bun:test";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAvatars } from "../src/avatars";
import { serveBoard } from "../src/board";
import { loadConfig } from "../src/config";
import type { ImAdapter, Profile } from "../src/contracts";
import { QQAdapter } from "../src/qq";
import { openStore } from "../src/store";
import { TelegramAdapter } from "../src/telegram";
import { BOARD_LOGIN } from "./instance";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const OPENID = "OPENID-never-logged";
const APP = "102000";
const TOKEN = "123456:tg-token-never-logged";
const TG_ME = 4242;

const tmp = mkdtempSync(join(tmpdir(), "rhodium-test-avatars-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A local HTTP server answering by path; requests has each path asked for. */
function stand(answer: (path: string, req: Request) => Response | Promise<Response>) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const { pathname, search } = new URL(req.url);
      requests.push(pathname + search);
      return answer(pathname, req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** The QQ adapter on the real SDK, its API, token and avatar CDN at a stand-in. */
function qq(answer: (path: string) => Response) {
  const api = stand((path) => (path === "/app/getAppAccessToken" ? Response.json({ access_token: "t", expires_in: 7200 }) : answer(path)));
  const logs: string[] = [];
  const client = new QQBot({ appId: APP, appSecret: "s", baseUrl: api.url, tokenBaseUrl: api.url });
  const adapter = new QQAdapter("B1", "q", { platform: "qq", appId: APP, secret: "s" }, { client, cdn: api.url, log: (m) => logs.push(m) });
  return { adapter, api, logs };
}

test("story 234, 235: a QQ bot's own avatar comes by /users/@me on the SDK's token; yours from the avatar CDN by the bot's appId and your openid; no name", async () => {
  const { adapter, api } = qq((path) => {
    if (path === "/users/@me") return Response.json({ id: "x", username: "main", avatar: `${api.url}/bot.png` });
    if (path === "/bot.png") return new Response(PNG);
    if (path === `/qqapp/${APP}/${OPENID}/100`) return new Response(JPEG);
    return new Response("no", { status: 404 });
  });
  try {
    expect(await adapter.profile(OPENID)).toEqual({ bot: PNG, you: JPEG });
  } finally {
    api.stop();
  }
});

test("story 238: QQ's default penguin, X-Info: notexist, is no avatar; a failure is none, logged without your openid or any address", async () => {
  const { adapter, api, logs } = qq((path) => {
    if (path === "/users/@me") return new Response("down", { status: 502 });
    return new Response(JPEG, { headers: { "X-Info": "notexist" } });
  });
  try {
    expect(await adapter.profile(OPENID)).toEqual({});
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) for (const secret of [OPENID, api.url, "127.0.0.1"]) expect(l).not.toContain(secret);
  } finally {
    api.stop();
  }
});

/** The Telegram adapter at a stand-in for the Bot API: the bot is 777, you TG_ME; each has photos as
 *  given, by size, each size its own file; files has what each file_id downloads as. */
function telegram(photos: Record<number, { width: number; file: string }[]>, files: Record<string, Uint8Array<ArrayBuffer>>, chat: object | null) {
  const api = stand(async (path, req) => {
    const file = /^\/file\/bot[^/]+\/(.+)$/.exec(path)?.[1];
    if (file) return files[file] ? new Response(files[file]) : new Response("Not Found", { status: 404 });
    const method = path.split("/").at(-1);
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const ok = (result: unknown) => Response.json({ ok: true, result });
    if (method === "getMe") return ok({ id: 777, is_bot: true, first_name: "Rhodium", username: "rhodium_bot" });
    if (method === "getUserProfilePhotos") {
      const sizes = photos[Number(body.user_id)] ?? [];
      return ok({ total_count: sizes.length ? 1 : 0, photos: sizes.length ? [sizes.map((s) => ({ file_id: s.file, file_unique_id: s.file, width: s.width, height: s.width }))] : [] });
    }
    if (method === "getFile") return ok({ file_id: body.file_id, file_unique_id: body.file_id, file_path: `photos/${body.file_id}` });
    if (method === "getChat") return chat ? ok({ id: TG_ME, type: "private", ...chat }) : Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
    return Response.json({ ok: false, error_code: 404, description: "Not Found" });
  });
  const logs: string[] = [];
  const adapter = new TelegramAdapter("B2", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: (m) => logs.push(m) });
  return { adapter, api, logs };
}

test("stories 234, 235: a Telegram avatar is the smallest size of at least 160px, else the largest, downloaded by rhodium; your name is your first and last names, else @username", async () => {
  const sizes = (...widths: number[]) => widths.map((width) => ({ width, file: `f${width}` }));
  const files = { "photos/f160": PNG, "photos/f320": JPEG, "photos/f120": JPEG };
  const { adapter, api } = telegram({ 777: sizes(320, 640, 160), [TG_ME]: sizes(80, 120) }, files, { first_name: "Alex", last_name: "Chen" });
  try {
    expect(await adapter.profile(String(TG_ME))).toEqual({ bot: PNG, you: JPEG, name: "Alex Chen" });
  } finally {
    api.stop();
  }
  const only = telegram({}, {}, { username: "alex" });
  try {
    expect(await only.adapter.profile(String(TG_ME))).toEqual({ name: "@alex" });
  } finally {
    only.api.stop();
  }
});

test("stories 238, 239: a Telegram avatar that fails is none, logged without the token, your user id or the file's address", async () => {
  const { adapter, api, logs } = telegram({ 777: [{ width: 200, file: "gone" }], [TG_ME]: [{ width: 200, file: "gone" }] }, {}, null);
  try {
    expect(await adapter.profile(String(TG_ME))).toEqual({});
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) for (const secret of [TOKEN, String(TG_ME), "photos/", api.url]) expect(l).not.toContain(secret);
  } finally {
    api.stop();
  }
});

test("stories 234, 235, 238, 239: kept avatars and your Telegram name come to the topology by Rhodium's ids, at an address that changes with the picture; one that fails keeps the last; /api/avatar is yours only", async () => {
  const dir = join(tmp, "board");
  writeFileSync(join(tmp, "config.toml"), `stateDir = "${dir}"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n[bots.t]\nplatform = "fake"\nlike = "telegram"\nsocket = "/nowhere"\n`, { mode: 0o600 });
  const cfg = loadConfig(join(tmp, "config.toml"));
  const store = openStore(join(tmp, "rh.db"));
  const server = serveBoard(store, cfg);
  try {
    const { bot, chat } = store.tx((tx) => {
      const bot = tx.insert("bot", { platform: "fake", name: "t", isMain: 0, owners: JSON.stringify([String(TG_ME)]) }).id;
      const chat = tx.insert("chat", { bot, platformChatId: String(TG_ME) }).id;
      return { bot, chat };
    });
    let profile: Profile = { bot: PNG, you: JPEG, name: "Alex" };
    const adapters = new Map<string, Pick<ImAdapter, "profile">>([[bot, { profile: async () => profile }]]);
    const get = (path: string, login = BOARD_LOGIN) => fetch(`http://127.0.0.1:${server.port}/${path}`, { headers: { "Tailscale-User-Login": login } });
    type Topology = { bots: { id: string; avatar: string | null }[]; chats: { id: string; name: string | null; avatar: string | null }[] };
    const topology = async () => (await (await get("api/topology")).json()) as Topology;

    expect((await topology()).bots[0]!.avatar).toBeNull();
    await refreshAvatars(store, cfg, adapters);
    const first = await topology();
    expect(first.chats[0]).toMatchObject({ id: chat, name: "Alex" });
    const [botAt, youAt] = [first.bots[0]!.avatar!, first.chats[0]!.avatar!];
    expect(botAt).toStartWith(`api/avatar?id=${bot}&`);
    const image = await get(botAt);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    expect(new Uint8Array(await (await get(youAt)).arrayBuffer())).toEqual(JPEG);
    expect((await get(botAt, "someone@else")).status).toBe(403);
    expect((await get("api/avatar?id=nope")).status).toBe(404);
    expect((await get("api/avatar?id=../rh.db")).status).toBe(404);

    // Nothing comes this time: the last stays. Then a new picture: a new address.
    profile = {};
    await refreshAvatars(store, cfg, adapters);
    expect(await topology()).toEqual(first);
    profile = { bot: JPEG };
    await refreshAvatars(store, cfg, adapters);
    const then = await topology();
    expect(then.bots[0]!.avatar).not.toBe(botAt);
    expect(then.chats[0]!.avatar).toBe(youAt);
    expect(new Uint8Array(await (await get(then.bots[0]!.avatar!)).arrayBuffer())).toEqual(JPEG);
    // Kept under the state directory, by Rhodium's ids.
    expect(existsSync(join(dir, "avatars", bot))).toBe(true);
    expect(readFileSync(join(dir, "avatars", chat))).toEqual(Buffer.from(JPEG));
    expect(JSON.stringify(then)).not.toContain(String(TG_ME));
  } finally {
    server.stop(true);
    store.close();
  }
});
