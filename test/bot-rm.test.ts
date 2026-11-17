// rh bot rm (architecture §14.8, spec web-bots stories 684, 685) and the main chat set by itself when
// there is none (architecture §8.5.1, story 680). The bots are fake bots on the fake IM platform, but
// for one on Telegram's stand-in (test/bot-api.ts), as its adapter must stop polling.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type State } from "../src/router";
import type { Slot } from "../src/store";
import { botApi, ME as TG_ME } from "./bot-api";
import { QR } from "./fake-qq-connect";
import { newInstance, until, type Instance } from "./instance";

const ME_Q = "me-under-q";
const ME_T = "me-under-t";

let rhodium: Instance | undefined;
let api: ReturnType<typeof botApi> | undefined;
afterEach(async () => {
  await rhodium?.cleanup();
  api?.stop();
  [rhodium, api] = [undefined, undefined];
});

/** Rows of rhodium's database. */
function rows<T>(r: Instance, sql: string): T[] {
  const db = new Database(join(r.dir, "state/rh.db"), { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

test("story 685: rh bot rm disconnects the bot and takes its table out of the config file, the rest as written; its row stays, its pairing, default target and pushed menus cleared", async () => {
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" }, t: { like: "telegram", target: "w/a" } }, toml: `mainChat = "q/${ME_Q}"` }));
  await r.start();
  await r.slots("a", "b");
  // t is paired, pointed at w/b, has its menus and a code still out.
  const code = (await r.ok("pair", "t")).match(/配对码：(\S+)/)![1]!;
  await r.im.inject("t", { chat: ME_T, sender: ME_T, text: code });
  await until(async () => (await r.im.log("t", ME_T)).some((p) => p.text === "已配对，以后 Bot t 只认这个账号。"), 15_000);
  await r.ok("bind", "t", "w/b");
  await r.ok("pair", "t", "--add");
  await until(async () => (await r.im.menu("t", ME_T)) !== null, 15_000);
  expect(await r.im.connected("t")).toBe(true);
  const before = readFileSync(r.config, "utf8");

  expect(await r.ok("bot", "rm", "t")).toBe("已去掉 Bot t：断开了连接，从配置文件里删掉了它。平台上的 Bot 本身还在，要删得到平台上删。\n");
  // The file is as it was but for t's table, the last one.
  expect(readFileSync(r.config, "utf8")).toBe(before.slice(0, before.indexOf("\n[bots.t]")));
  expect(Object.keys(loadConfig(r.config).bots)).toEqual(["q"]);
  expect(statSync(r.config).mode & 0o777).toBe(0o600);
  // Disconnected, and it stays so: nothing it gets reaches a slot.
  await until(async () => !(await r.im.connected("t")), 15_000);
  await r.im.inject("t", { chat: ME_T, sender: ME_T, text: "still there?" });
  await Bun.sleep(1500);
  expect(await r.im.connected("t")).toBe(false);
  expect(r.claude.runs().some((run) => run.stdin.some((l) => l.includes("still there?")))).toBe(false);
  // The row stays for its chats and messages to point at; what a new bot of its name must not take over is gone.
  expect(rows(r, "SELECT owners, pairCode, pairUntil, pairAdd, defaultTarget, menuHash, rowHash FROM bot WHERE name = 't'")).toEqual([
    { owners: null, pairCode: null, pairUntil: null, pairAdd: null, defaultTarget: null, menuHash: null, rowHash: null },
  ]);
  expect(rows(r, "SELECT data FROM event WHERE type = 'bot_removed'")).toEqual([{ data: JSON.stringify({ bot: "t" }) }]);
  // q goes on.
  expect(await r.im.connected("q")).toBe(true);
  expect(await r.rh(["bot", "rm", "t"])).toMatchObject({ code: 1, err: "rh: 没有 Bot t。\n" });
}, 60_000);

test("story 685: a Telegram bot taken out stops polling Telegram", async () => {
  api = botApi({ token: "123456:token" });
  const toml = [`mainChat = "q/${ME_Q}"`, "[bots.tg]", 'platform = "telegram"', 'token = "123456:token"', `apiRoot = "${api.url}"`, `owner = "${TG_ME}"`, 'target = "w/a"'].join("\n");
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" } }, toml }));
  await r.start();
  await r.slots("a");
  await until(() => api!.polls.length > 1, 15_000);
  await r.ok("bot", "rm", "tg");
  const polls = api.polls.length;
  api.say("anyone?");
  await Bun.sleep(1500);
  expect(api.polls.length).toBe(polls);
  expect(r.claude.runs()).toEqual([]);
}, 30_000);

test("stories 684, 685: rh bot rm turns down the main bot and a bot the config has not, and changes nothing", async () => {
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" } }, toml: `mainChat = "q/${ME_Q}"` }));
  await r.start();
  await r.slots("a");
  const before = readFileSync(r.config, "utf8");
  expect(await r.rh(["bot", "rm", "q"])).toMatchObject({ code: 1, err: "rh: Bot q 是主 Bot，主窗口在它上面，不能去掉。要去掉它，先改配置文件里的 mainChat。\n" });
  expect(await r.rh(["bot", "rm", "nope"])).toMatchObject({ code: 1, err: "rh: 没有 Bot nope。\n" });
  expect(await r.rh(["bot", "rm"])).toMatchObject({ code: 1 });
  expect(readFileSync(r.config, "utf8")).toBe(before);
  expect(await r.im.connected("q")).toBe(true);
}, 30_000);

test("story 685: a config file rh bot rm cannot take the table out of cleanly stays as it was, the bot still connected", async () => {
  const r = (rhodium = newInstance({ bots: { t: { like: "telegram", target: "w/a" } } }));
  await r.start();
  await r.slots("a");
  const broken = `nonsense = true\n${readFileSync(r.config, "utf8")}`; // edited since rhodium read it
  writeFileSync(r.config, broken);
  const out = await r.rh(["bot", "rm", "t"]);
  expect(out.code).toBe(1);
  expect(out.err).toStartWith("rh: 没能从配置文件里删掉 Bot t：");
  expect(readFileSync(r.config, "utf8")).toBe(broken);
  expect(await r.im.connected("t")).toBe(true);
}, 30_000);

test("story 685: a bot made under the name of one rh bot rm took out takes its row over, on its own platform", async () => {
  const TOKEN = "123456:token";
  api = botApi({ token: TOKEN });
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" }, t: { like: "telegram", target: "w/a" } }, toml: `mainChat = "q/${ME_Q}"` }));
  await r.start();
  await r.slots("a");
  await r.ok("bot", "rm", "t");
  const made = await r.rh(["bot", "t", "telegram", "w/a", "--api-root", api.url], { type: `${TOKEN}\n` });
  expect(made.code).toBe(0);
  expect(rows(r, "SELECT platform FROM bot WHERE name = 't'")).toEqual([{ platform: "telegram" }]);
}, 30_000);

// ---- The main chat, set by itself when the config has none (story 680). ----

test("story 680: with no main chat, a bot's first pairing makes your private chat with it the main chat, at once; a later pairing, or another bot's, leaves it", async () => {
  const r = (rhodium = newInstance({ bots: { t: { like: "telegram", target: "w/a" }, u: { like: "telegram", target: "w/a" } } }));
  await r.start();
  await r.slots("a");
  const pair = async (bot: string, who: string, ...more: string[]) => {
    const code = (await r.ok("pair", bot, ...more)).match(/配对码：(\S+)/)![1]!;
    await r.im.inject(bot, { chat: who, sender: who, text: code });
    await until(async () => (await r.im.log(bot, who)).some((p) => p.text?.startsWith("已配对")), 15_000);
  };
  await pair("t", ME_T);
  await until(() => loadConfig(r.config).mainChat !== null, 15_000);
  expect(loadConfig(r.config).mainChat).toEqual({ bot: "t", chat: ME_T });
  expect(readFileSync(r.config, "utf8")).toStartWith(`stateDir = `);
  expect(readFileSync(r.config, "utf8")).toContain(`\nmainChat = "t/${ME_T}"\n`);
  // Rhodium has it now: the main bot can't be taken out.
  expect(await r.rh(["bot", "rm", "t"])).toMatchObject({ code: 1 });
  const once = readFileSync(r.config, "utf8");
  await pair("t", "another-me", "--add");
  await pair("u", "me-under-u");
  await Bun.sleep(500);
  expect(readFileSync(r.config, "utf8")).toBe(once);
}, 60_000);

test("story 680: a pairing with a main chat in the config leaves the file as it was", async () => {
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" }, t: { like: "telegram", target: "w/a" } }, toml: `mainChat = "q/${ME_Q}"` }));
  await r.start();
  await r.slots("a");
  const before = readFileSync(r.config, "utf8");
  const code = (await r.ok("pair", "t")).match(/配对码：(\S+)/)![1]!;
  await r.im.inject("t", { chat: ME_T, sender: ME_T, text: code });
  await until(async () => (await r.im.log("t", ME_T)).some((p) => p.text === "已配对，以后 Bot t 只认这个账号。"), 15_000);
  await Bun.sleep(500);
  expect(readFileSync(r.config, "utf8")).toBe(before);
}, 30_000);

test("story 680: a main chat that can't be written is logged, and the pairing goes through", async () => {
  const r = (rhodium = newInstance({ bots: { t: { like: "telegram", target: "w/a" } } }));
  const daemon = await r.start();
  await r.slots("a");
  const before = readFileSync(r.config, "utf8");
  const code = (await r.ok("pair", "t")).match(/配对码：(\S+)/)![1]!;
  chmodSync(dirname(r.config), 0o500); // no file can be made beside it
  try {
    await r.im.inject("t", { chat: ME_T, sender: ME_T, text: code });
    await until(async () => (await r.im.log("t", ME_T)).some((p) => p.text === "已配对，以后 Bot t 只认这个账号。"), 15_000);
    await until(() => daemon.logs.some((l) => l.msg === "cannot write the main chat into the config"), 15_000);
  } finally {
    chmodSync(dirname(r.config), 0o700);
  }
  expect(readFileSync(r.config, "utf8")).toBe(before);
  expect(await r.ok("pair", "t", "--list")).toContain(ME_T);
}, 30_000);

test("story 680: with no main chat, a QQ bot whose scan names you makes your private chat with it the main chat", async () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
  const r = (rhodium = newInstance({ env }));
  // The scan is rhodium's, so QQ's QR service stand-in is preloaded into it.
  await r.start([process.execPath, "--preload", join(import.meta.dir, "fake-qq-connect.ts"), join(import.meta.dir, "../src/main.ts")]);
  await r.slots("a");
  const made = await r.rh(["bot", "q2", "qq", "w/a"]);
  expect({ code: made.code, err: made.err }).toEqual({ code: 0, err: "" });
  await until(() => loadConfig(r.config).mainChat !== null, 15_000);
  expect(loadConfig(r.config).mainChat).toEqual({ bot: "q2", chat: QR.openid });
}, 30_000);

// ---- Who may: an agent's rh bot rm asks you; the board sends only rh bot rm <name>. ----

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-bot-rm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const config = {
  ...loadConfig(join(dir, "config.toml")),
  mainChat: { bot: "q", chat: "me" },
  bots: { q: { platform: "qq" as const }, t: { platform: "telegram" as const } },
};
const ctx: Ctx = {
  now: Date.parse("2026-11-17T12:00:00Z"),
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config,
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => true,
  retarget: () => null,
  dropBot: () => {},
  inboundOf: () => [],
};
const slot = { id: "a", workspace: "w", name: "a", dir: "/w", mode: "headless", state: "idle", conversation: null, parent: null, lifetime: "longterm", archivedAt: null, token: "agent", turnChat: null } as unknown as Slot;
const state = {
  workspaces: [{ id: "w", name: "w", dir: "/w" }],
  slots: [slot],
  bots: [
    { id: "q", name: "q", platform: "qq", defaultTarget: "a", owners: JSON.stringify(["me"]) },
    { id: "t", name: "t", platform: "telegram", defaultTarget: "a", owners: JSON.stringify(["me"]) },
    { id: "g", name: "g", platform: "qq", defaultTarget: null, owners: null }, // taken out by rh bot rm
  ],
  chats: [{ id: "main", bot: "q", platformChatId: "me", target: null, contactedAt: null }],
  asks: [],
  chatOf: {},
  ...{ conversations: [], holders: [], queued: [], quotas: [], held: [], hints: [], listed: [], unsure: [] },
  ...{ quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
} as unknown as State;
const said = (d: ReturnType<typeof route>) => {
  const reply = d.effects.find((e) => e.kind === "rh_reply")?.reply;
  return reply ? (reply.ok ? reply.text : reply.error) : null;
};
const byAgent = (...argv: string[]) => said(route(state, { kind: "rh", id: "r", caller: { token: "agent", pid: null, tty: false, cwd: "/" }, argv }, ctx));

test("story 685: an agent's rh bot rm asks you first, the main bot's is turned down at once, and only you make a bot", () => {
  expect([byAgent("bot", "rm", "t"), byAgent("bot", "rm", "q"), byAgent("bot", "x", "telegram", "w/a")]).toEqual([
    "已请用户确认：rh bot rm t。用户的决定会作为一条消息发给你，不用等；超时没确认视为拒绝。",
    "Bot q 是主 Bot，主窗口在它上面，不能去掉。要去掉它，先改配置文件里的 mainChat。",
    "rh bot 只有用户本人能用，agent 调用一律拒绝。",
  ]);
});

test("story 684: the board may send rh bot rm <name>, and no other rh bot", () => {
  const board = (...argv: string[]) => route(state, { kind: "board", id: crypto.randomUUID(), act: { kind: "rh", argv } }, ctx);
  expect(board("bot", "rm", "t").effects.filter((e) => e.kind === "drop_bot")).toEqual([{ kind: "drop_bot", bot: "t" }]);
  for (const argv of [["bot", "x", "telegram", "w/a"], ["bot", "rm", "t", "--paste"], ["bot", "rm"]]) expect(said(board(...argv))).toBe(`看板不做 rh ${argv.join(" ")}。`);
});

test("story 684: the board names the bot to take out by its Rhodium id, as its page may show a label; elsewhere only the name does", () => {
  const dropped: string[] = [];
  const byId = { ...state, bots: [...state.bots, { id: "u-id", name: "u", platform: "qq", defaultTarget: "a", owners: null }] } as unknown as State;
  const withU = { ...ctx, config: { ...config, bots: { ...config.bots, u: { platform: "qq" as const } } }, dropBot: (name: string) => void dropped.push(name) };
  const d = route(byId, { kind: "board", id: crypto.randomUUID(), act: { kind: "rh", argv: ["bot", "rm", "u-id"] } }, withU);
  expect([said(d), d.effects.filter((e) => e.kind === "drop_bot"), dropped]).toEqual(["已去掉 Bot u：断开了连接，从配置文件里删掉了它。平台上的 Bot 本身还在，要删得到平台上删。", [{ kind: "drop_bot", bot: "u-id" }], ["u"]]);
  // The main bot by its id is still the main bot.
  expect(said(route(byId, { kind: "board", id: crypto.randomUUID(), act: { kind: "rh", argv: ["bot", "rm", "q"] } }, withU))).toBe("Bot q 是主 Bot，主窗口在它上面，不能去掉。要去掉它，先改配置文件里的 mainChat。");
  const byYou = said(route(byId, { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv: ["bot", "rm", "u-id"] }, withU));
  expect(byYou).toBe("没有 Bot u-id。");
});

test("story 685: a bot rh bot rm took out gets no pairing code, and rh bot rm <platform> says no bot can be named rm", () => {
  const byYou = (...argv: string[]) => said(route(state, { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv }, ctx));
  expect([byYou("pair", "g"), byYou("pair", "g", "--add")]).toEqual(["没有 Bot g。", "没有 Bot g。"]);
  expect(byYou("bot", "rm", "qq")).toBe("没有 Bot qq。Bot 不能叫 rm：rh bot rm 是去掉 Bot 用的。");
});
