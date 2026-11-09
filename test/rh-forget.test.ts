// rh forget (product §5.11, architecture §9.9, #485): Rhodium forgets a chat of a bot, with its own
// target, its settings and its messages in and out; the account writing again comes back as a new chat.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { askGone, route, type Ctx, type State } from "../src/router";
import type { Slot } from "../src/store";
import { BOARD_LOGIN, newInstance, until, type Instance } from "./instance";

const A = "owner-a"; // two accounts of yours under q
const B = "owner-b";

let rhodium: Instance | undefined;
afterEach(() => rhodium?.cleanup());

test("story 549: rh forget drops the chat, its own target and its messages in and out, and the topology no longer draws it; the account writing again is a new chat on the bot's default", async () => {
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: [A, B], target: "w/a" } } }));
  const board = `http://${(await r.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await r.slots("a", "b");
  const say = (who: string, text: string) => r.im.inject("q", { chat: who, sender: who, text });
  await say(A, "/rh_use a");
  await say(B, "/rh_use b");
  await until(async () => (await r.im.log("q", B)).length > 0, 15_000);
  const read = <T>(sql: string): T[] => {
    const db = new Database(join(r.dir, "state/rh.db"), { readonly: true });
    try {
      return db.query(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const chatOf = (who: string) => read<{ id: string; target: string | null }>(`SELECT id, target FROM chat WHERE platformChatId = '${who}'`)[0];
  const old = chatOf(B)!.id;
  const avatar = join(r.dir, "state/avatars", old);
  await until(() => existsSync(avatar), 15_000);
  writeFileSync(`${avatar}.name`, "B"); // as Telegram gives your name
  // The QQ quota of a reply to each of B's messages, kept by the message's id.
  const passive = `SELECT owner FROM quota WHERE kind = 'qq_passive' AND owner IN (${read<{ id: string }>(`SELECT id FROM inbound WHERE chat = '${old}'`).map((m) => `'${m.id}'`).join()})`;
  expect(read(passive).length).toBeGreaterThan(0);

  expect(await r.ok("forget", `q/${B}`)).toBe("已忘掉假 IM Bot 的一个私聊。\n");
  expect(read(passive)).toEqual([]);
  expect(read(`SELECT id FROM inbound WHERE chat = '${old}' UNION ALL SELECT id FROM outbound WHERE chat = '${old}'`)).toEqual([]);
  expect(chatOf(B)).toBeUndefined();
  expect(read("SELECT data FROM event WHERE type = 'chat_forgotten'")).toEqual([{ data: JSON.stringify({ bot: "q" }) }]);
  expect([existsSync(avatar), existsSync(`${avatar}.name`)]).toEqual([false, false]);
  const topology = (await (await fetch(`${board}/api/topology`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as { chats: { id: string }[] };
  expect(topology.chats.map((c) => c.id)).toEqual([chatOf(A)!.id]);

  await say(B, "again");
  await until(() => r.claude.runs().some((run) => run.env.RHODIUM_SLOT === "w/a" && run.stdin.some((l) => l.includes("again"))), 15_000);
  expect(chatOf(B)!.id).not.toBe(old);
  expect(chatOf(B)!.target).toBeNull();
}, 60_000);

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-rh-forget-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const config = { ...loadConfig(join(dir, "config.toml")), mainChat: { bot: "t", chat: "main" } };
const ctx: Ctx = {
  now: Date.parse("2026-10-29T12:00:00Z"),
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config,
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => true,
  retarget: () => null,
  inboundOf: () => [],
};

test("story 549: rh forget refuses a chat not on record, the main chat, one a running turn began in, one an unanswered ask went to, one with a message still queued, and an agent's own contact window; another an agent asks you for", () => {
  const slot = (id: string, o: Partial<Slot> = {}) =>
    ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "idle", conversation: null, parent: null, lifetime: "longterm", archivedAt: null, token: null, turnChat: null, rhWindowAt: null, ...o }) as Slot;
  const chat = (id: string) => ({ id, bot: "t", platformChatId: id, target: null, contactedAt: null });
  const state = {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot("a", { token: "agent" }), slot("busy", { turnChat: "turn" })],
    bots: [{ id: "t", name: "t", platform: "telegram", defaultTarget: "a", owners: JSON.stringify(["me"]) }],
    chats: ["main", "me", "turn", "ask", "queued", "free"].map(chat),
    asks: [{ id: "k", slot: "busy", kind: "question", status: "open", forwardedTo: "ask", prompt: "{}" }],
    chatOf: { input: "queued" },
    ...{ conversations: [], holders: [], queued: [], quotas: [], held: [], hints: [], listed: [], unsure: [] },
    ...{ quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
  const forget = (id: string, token: string | null = null) => {
    const d = route(state, { kind: "rh", id: "r", caller: { token, pid: null, tty: true, cwd: "/" }, argv: ["forget", `t/${id}`] }, ctx);
    const reply = d.effects.find((e) => e.kind === "rh_reply")!.reply;
    return reply.ok ? reply.text : reply.error;
  };
  expect([forget("nope"), forget("main"), forget("turn"), forget("ask"), forget("queued"), forget("me", "agent"), forget("free", "agent")]).toEqual([
    "Rhodium 没记着这个窗口。",
    "这是主窗口，不能忘掉。要换主窗口，改配置文件里的 mainChat。",
    "这个窗口开始的回合还在跑，等它跑完再忘掉。",
    "有推到这个窗口的提问还没答，先答掉，网页上也能答。",
    "有从这个窗口发来的消息还在排队，等它交给 agent 再忘掉。",
    "这是你联系用户的窗口。",
    "已请用户确认：rh forget t/free。用户的决定会作为一条消息发给你，不用等；超时没确认视为拒绝。",
  ]);
});

test("the board says an ask answered in a chat since forgotten was answered, not withdrawn", () => {
  expect([askGone({ bots: [], chats: [] }, ctx, "forgotten"), askGone({ bots: [], chats: [] }, ctx, null)]).toEqual(["已回答", "提问已撤回"]);
});
