// What the board gives the topology view (spec web-topology, seam one): the bots, the chat windows
// and where each goes, the workspaces and slots in one answer; a slot's timeline; and a page of any
// one of its conversations, not only the current one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until } from "./instance";
import { saidThrough } from "../src/board";

const ME = "you-openid"; // your id under q
const TG_ME = "4242"; // and under t
const STRANGER = "stranger-openid";
const TOKEN = "tok-q-secret";

// w/a's claude does what its message says: a list of rh calls. Bot q (main, its private chat the
// main chat) goes to w/a, t (labelled Ms. T) to w/b, a pi.
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
const rhodium = newInstance({
  bots: { q: { like: "qq", owner: ME, target: "w/a", token: TOKEN }, t: { like: "telegram", owner: TG_ME, target: "w/b", label: "Ms. T" } },
  claude: { script: obey },
  toml: `mainChat = "q/${ME}"`,
});
let base = "";
beforeAll(async () => {
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a", "idle");
  await rhodium.ok("new", "w/b", "--agent", "pi");
});
afterAll(() => rhodium.cleanup());

async function get<T>(path: string): Promise<T> {
  const r = await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  expect(r.status).toBe(200);
  return (await r.json()) as T;
}

type Topology = {
  bots: { id: string; name: string; platform: string; main: boolean; conn: string | null; target: string | null; avatar: string | null }[];
  chats: { id: string; bot: string; kind: "private" | "group"; yours: boolean; name: string | null; main: boolean; avatar: string | null; verbose: boolean }[];
  bindings: { chat: string; slot: string; use: boolean }[];
  workspaces: { id: string; name: string }[];
  slots: { id: string; ref: string; name: string; workspace: string; parent: string | null; agent: string | null; mode: string; phase: string; state: string; group: string; lifetime: string; archived: boolean; contact: string | null }[];
};
const topology = () => get<Topology>("/api/topology");

/** Says text to bot in your private chat there, and waits for its reply. */
async function say(bot: "q" | "t", text: string): Promise<void> {
  const me = bot === "q" ? ME : TG_ME;
  const m = await rhodium.im.inject(bot, { chat: me, sender: me, text });
  await until(async () => (await rhodium.im.log(bot, me)).some((p) => p.replyTo === m.messageId), 15_000);
}

test("stories 212, 214-216, 238, 239: the topology has each bot, your chats and the main one, where each goes and how, and the slots with their state; no token or platform id", async () => {
  // A stranger's message leaves a chat on record, which the topology leaves out.
  await rhodium.im.inject("q", { chat: STRANGER, sender: STRANGER, text: "hi" });
  await say("t", "hello");
  await say("q", JSON.stringify([["spawn", "kid", "--agent", "pi", "do it"]]));
  // A stranger's chat with t picks w/a for itself (#291): drawn, a private chat like yours.
  await rhodium.ok("use", `t/${STRANGER}`, "w/a");
  await rhodium.ok("archive", "w/idle");

  // Each bot's avatar, fetched as rhodium starts (story 238); your private chats' as soon as they are there.
  await until(async () => {
    const t = await topology();
    return t.bots.every((b) => b.avatar !== null) && t.chats.filter((c) => c.avatar !== null).length === 2;
  }, 15_000);
  const g = await topology();
  const json = JSON.stringify(g);
  for (const secret of [ME, TG_ME, STRANGER, TOKEN]) expect(json).not.toContain(secret);

  // A bot goes by its label, as in its chats' source lines (#255).
  const [q, t] = ["q", "Ms. T"].map((n) => g.bots.find((b) => b.name === n)!);
  const slot = (ref: string) => g.slots.find((s) => s.ref === ref)!;
  const [a, b, kid, idle] = ["w/a", "w/b", "w/kid", "w/idle"].map(slot);
  expect(g.workspaces).toEqual([{ id: a!.workspace, name: "w" }]);
  expect(g.bots).toEqual([
    { id: q!.id, name: "q", platform: "fake", main: true, conn: "online", target: a!.id, avatar: expect.stringMatching(new RegExp(`^api/avatar\\?id=${q!.id}&v=`)) },
    { id: t!.id, name: "Ms. T", platform: "fake", main: false, conn: "online", target: b!.id, avatar: expect.stringMatching(new RegExp(`^api/avatar\\?id=${t!.id}&v=`)) },
  ]);
  // Yours have your avatar; a stranger's none.
  const chat = (bot: string, yours: boolean) => g.chats.find((c) => c.bot === bot && (c.avatar !== null) === yours)!;
  const [qMine, tMine, tStranger] = [chat(q!.id, true), chat(t!.id, true), chat(t!.id, false)];
  expect(g.chats).toHaveLength(3);
  expect(qMine).toEqual({ id: expect.any(String), bot: q!.id, kind: "private", yours: true, name: null, main: true, avatar: expect.stringMatching(new RegExp(`^api/avatar\\?id=${qMine.id}&v=`)), verbose: false });
  // Story 319: tool lines in full by default where the platform edits a message in place.
  expect(tMine).toMatchObject({ kind: "private", yours: true, name: null, main: false, verbose: true });
  expect(tStranger).toMatchObject({ kind: "private", yours: false, name: null, main: false, avatar: null });
  expect(g.bindings).toEqual(
    expect.arrayContaining([
      { chat: qMine.id, slot: a!.id, use: false },
      { chat: tMine.id, slot: b!.id, use: false },
      { chat: tStranger.id, slot: a!.id, use: true },
    ]),
  );
  expect(g.bindings).toHaveLength(3);

  expect(a).toEqual({ id: a!.id, ref: "w/a", name: "a", workspace: a!.workspace, parent: null, agent: "claude", mode: "headless", phase: expect.any(String), state: expect.any(String), group: expect.any(String), lifetime: "longterm", archived: false, contact: qMine.id });
  // A child no chat goes to has the chat going to its root; a slot with neither, the main chat.
  expect(kid).toMatchObject({ parent: a!.id, agent: "pi", lifetime: "oneoff", archived: false, contact: qMine.id });
  expect(idle).toMatchObject({ phase: "off", state: "未运行", group: "idle", archived: true, contact: qMine.id });
  expect(b!.contact).toBe(tMine.id);
}, 40_000);

test("story 370: a chat's binding is where routing sends its messages: /rh_use makes it its own, and back to the bot's default", async () => {
  await say("q", "/rh_use w/b");
  let g = await topology();
  const qMine = g.chats.find((c) => c.main)!;
  const ids = Object.fromEntries(g.slots.map((s) => [s.ref, s.id]));
  expect(g.bindings.find((x) => x.chat === qMine.id)).toEqual({ chat: qMine.id, slot: ids["w/b"]!, use: true });
  // Story 239: the event it leaves names the chat by Rhodium's id, on the slot's page too.
  expect(JSON.stringify(await get(`/api/slot?id=${ids["w/b"]}`))).not.toContain(ME);
  await say("q", "/rh_use -");
  g = await topology();
  expect(g.bindings.find((x) => x.chat === qMine.id)).toEqual({ chat: qMine.id, slot: ids["w/a"]!, use: false });
  // rh bind moves the bot's default, and its chats with it.
  await rhodium.ok("bind", "q", "w/b");
  g = await topology();
  expect(g.bots.find((b) => b.name === "q")!.target).toBe(ids["w/b"]!);
  expect(g.bindings.find((x) => x.chat === qMine.id)).toEqual({ chat: qMine.id, slot: ids["w/b"]!, use: false });
  await rhodium.ok("bind", "q", "w/a");
}, 40_000);

type Timeline = { id: string; short: string | null; agent: string; startedAt: number; lastWrite: number | null; title: string | null; current: boolean }[];
type Messages = { conversation: string | null; blocks: { kind: string; text?: string }[] };

test("stories 230, 231: a slot's timeline has each conversation, last active first, titled by what you said first; a page of an old one comes by its id", async () => {
  const b = (await topology()).slots.find((s) => s.ref === "w/b")!.id;
  // w/b's first conversation has "hello" from the first test.
  await say("t", "/new");
  await say("t", "second one");
  const { timeline } = await get<{ timeline: Timeline }>(`/api/slot?id=${b}`);
  expect(timeline.map((c) => [c.agent, c.title, c.current])).toEqual([
    ["pi", "second one", true],
    ["pi", "hello", false],
  ]);
  for (const c of timeline) {
    expect(c.short).toMatch(/^[0-9a-z-]{8}$/);
    expect(c.lastWrite).toBeGreaterThanOrEqual(c.startedAt);
  }
  expect(timeline[0]!.startedAt).toBeGreaterThan(timeline[1]!.startedAt);
  // By last activity (#282): the older one, written to since, comes first.
  const sessions = join(rhodium.home, ".pi/agent/sessions");
  const file = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((f) => f.includes(`_${timeline[1]!.short}`))!;
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(sessions, file), later, later);
  const after = (await get<{ timeline: Timeline }>(`/api/slot?id=${b}`)).timeline;
  expect(after.map((c) => c.title)).toEqual(["hello", "second one"]);
  expect(after[0]!.lastWrite).toBe(later.getTime());

  const old = await get<Messages>(`/api/messages?conversation=${timeline[1]!.id}`);
  expect(old.conversation).toBe(timeline[1]!.id);
  expect(old.blocks.filter((x) => x.kind === "user").map((x) => x.text)).toEqual(["hello"]);
  // The slot's current one, still by slot; slot is ignored with conversation.
  expect((await get<Messages>(`/api/messages?slot=${b}`)).conversation).toBe(timeline[0]!.id);
  expect((await get<Messages>(`/api/messages?slot=${b}&conversation=${timeline[1]!.id}`)).conversation).toBe(timeline[1]!.id);
  const r = await fetch(`${base}/api/messages?conversation=nope`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  expect(r.status).toBe(404);
}, 40_000);

test("story 230: a conversation nothing was said in yet has no title and no last write; with no agent session yet, no short id", async () => {
  const idle = (await topology()).slots.find((s) => s.ref === "w/idle")!.id;
  expect((await get<{ timeline: Timeline }>(`/api/slot?id=${idle}`)).timeline).toEqual([
    { id: expect.any(String), short: null, agent: "claude", startedAt: expect.any(Number), lastWrite: null, title: null, current: true },
  ]);
});

test("story 249: a source line names the bot and chat it came through: by its name, or the platform's only bot; a bot gone or one of several keeps only what the line says; rh send and reports are none", () => {
  const bots = [
    { id: "Q1", name: "main", platform: "qq" as const },
    { id: "Q2", name: "Echo Agent", platform: "qq" as const },
    { id: "T1", name: "tg", platform: "telegram" as const },
    { id: "F1", name: "fs", platform: "feishu" as const },
  ];
  expect(saidThrough("QQ Bot main 的私聊", bots)).toEqual({ platform: "qq", bot: "main", id: "Q1", private: true });
  expect(saidThrough("QQ Bot Echo Agent 的私聊，发送于 10-22 21:05", bots)).toEqual({ platform: "qq", bot: "Echo Agent", id: "Q2", private: true });
  // Written when Telegram had one bot: it still has.
  expect(saidThrough("Telegram 私聊，发送于 21:05", bots)).toEqual({ platform: "telegram", bot: "tg", id: "T1", private: true });
  expect(saidThrough("Telegram 聊天窗口", bots)).toEqual({ platform: "telegram", bot: "tg", id: "T1", private: false });
  // No space between 飞书 and 私聊: Chinese next to Chinese (docs/im-style.md §2).
  expect(saidThrough("飞书私聊，发送于 21:05", bots)).toEqual({ platform: "feishu", bot: "fs", id: "F1", private: true });
  // Written when QQ had one bot; it has two now: which, the line cannot say.
  expect(saidThrough("QQ 私聊", bots)).toEqual({ platform: "qq", bot: null, id: null, private: true });
  expect(saidThrough("QQ Bot old 的私聊", bots)).toEqual({ platform: "qq", bot: "old", id: null, private: true });
  expect(saidThrough(null, bots)).toBeNull(); // typed in the terminal
  for (const other of ["槽位 w/a，经 rh send", "Rhodium：子槽位汇报", "用户的终端，经 rh send", "QQ"]) expect(saidThrough(other, bots)).toBeNull();
});

test("stories 248, 249: your message through a bot has from: its platform, the bot's name and avatar; one rh send brought has none, its source line shown as it is", async () => {
  await say("q", "where from");
  const a = (await topology()).slots.find((s) => s.ref === "w/a")!.id;
  const q = (await topology()).bots.find((b) => b.name === "q")!;
  const mine = async () => (await topology()).chats.find((c) => c.bot === q.id && c.kind === "private")!.avatar;
  await until(async () => (await mine()) !== null, 15_000);
  type User = { kind: string; text?: string; source?: string | null; from?: unknown };
  const users = (await get<{ blocks: User[] }>(`/api/messages?slot=${a}`)).blocks.filter((b) => b.kind === "user");
  expect(users.find((b) => b.text === "where from")).toMatchObject({ source: "假 IM Bot q 的私聊", from: { platform: "fake", bot: "q", botAvatar: q.avatar, avatar: await mine() } });
  // One its record ties to no input: with one chat of yours under q, that chat's avatar.
  const projects = join(rhodium.home, ".claude/projects");
  const file = readdirSync(projects, { recursive: true, encoding: "utf8" }).map((f) => join(projects, f)).find((f) => f.endsWith(".jsonl") && readFileSync(f, "utf8").includes("where from"))!;
  appendFileSync(file, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: "[来自 假 IM Bot q 的私聊]\nby hand" } }) + "\n");
  expect((await get<{ blocks: User[] }>(`/api/messages?slot=${a}`)).blocks.at(-1)).toMatchObject({ text: "by hand", from: { avatar: await mine() } });
  // pi's slot w/b, which rh send told: no bot.
  await rhodium.ok("send", "w/b", "from the terminal");
  const b = (await topology()).slots.find((s) => s.ref === "w/b")!.id;
  await until(async () => (await get<{ blocks: User[] }>(`/api/messages?slot=${b}`)).blocks.some((x) => x.kind === "user" && x.text === "from the terminal"), 15_000);
  const sent = (await get<{ blocks: User[] }>(`/api/messages?slot=${b}`)).blocks.find((x) => x.kind === "user" && x.text === "from the terminal")!;
  expect(sent).toMatchObject({ source: expect.stringContaining("rh send"), from: null });
}, 40_000);

test("story 238: your private chat first there for a message to you, the main chat on a fresh install, has your avatar at once", async () => {
  const fresh = newInstance({ bots: { q: { like: "qq", owner: ME } }, toml: `mainChat = "q/${ME}"` });
  try {
    await fresh.start();
    const dir = join(fresh.dir, "state/avatars");
    const kept = () => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith(".tmp")) : []);
    // The bot's own, as rhodium starts: no chat with you yet.
    await until(() => kept().length === 1, 15_000);
    await fresh.ok("send", "me", "hello");
    await until(() => kept().length === 2, 15_000);
  } finally {
    await fresh.cleanup();
  }
}, 40_000);

test("#513: with two of your accounts under a bot, each of your messages has the avatar of the one it came from, in a Claude slot and a Codex one; a message its record ties to no input, none", async () => {
  const ALT = "alt-openid"; // your other account under q
  const two = newInstance({ bots: { q: { like: "qq", owner: [ME, ALT], target: "w/a" } } });
  try {
    const at = `http://${(await two.start()).logs.find((l) => l.msg === "ready")!.board}`;
    const api = async <T>(path: string) => (await (await fetch(at + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as T;
    await two.slots("a");
    await two.ok("new", "w/c", "--agent", "codex");
    const tell = async (who: string, text: string) => {
      const m = await two.im.inject("q", { chat: who, sender: who, text });
      await until(async () => (await two.im.log("q", who)).some((p) => p.replyTo === m.messageId), 15_000);
    };
    const chats = async () => (await api<Topology>("/api/topology")).chats;
    await tell(ME, "from main");
    const main = (await chats())[0]!.id;
    await tell(ALT, "from alt");
    for (const who of [ME, ALT]) await two.ok("use", `q/${who}`, "w/c");
    await tell(ME, "from main");
    await tell(ALT, "from alt");
    await until(async () => (await chats()).filter((c) => c.avatar !== null).length === 2, 15_000);
    const avatar = Object.fromEntries((await chats()).map((c) => [c.id === main ? "from main" : "from alt", c.avatar]));

    type User = { kind: string; text: string; source: string; from: { avatar: string | null; botAvatar: string | null } | null };
    const users = async (ref: string) => {
      const slot = (await api<Topology>("/api/topology")).slots.find((s) => s.ref === ref)!.id;
      return (await api<{ blocks: User[] }>(`/api/messages?slot=${slot}`)).blocks.filter((b) => b.kind === "user");
    };
    for (const ref of ["w/a", "w/c"]) {
      expect((await users(ref)).map((b) => [b.text, b.from?.avatar])).toEqual([
        ["from main", avatar["from main"]],
        ["from alt", avatar["from alt"]],
      ]);
    }

    // A message in Claude's record that no input of the conversation was sent as: whose chat it was is not known.
    const projects = join(two.home, ".claude/projects");
    const file = join(projects, readdirSync(projects, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(".jsonl"))!);
    const source = (await users("w/a"))[0]!.source;
    appendFileSync(file, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: `[来自 ${source}]\nby hand` } }) + "\n");
    expect((await users("w/a")).at(-1)).toMatchObject({ text: "by hand", from: { avatar: null, botAvatar: expect.any(String) } });
  } finally {
    await two.cleanup();
  }
}, 60_000);
