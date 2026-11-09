// Where rh send to you goes (stories 575-578; product §5.9, architecture §8.7): by default where you
// last wrote to the slot, the board too while a page of it is in front; or the platform or bot the
// agent names, falling back to the default when that cannot send; the receipt says where it went.
import { expect, setSystemTime, test } from "bun:test";
import { until } from "./instance";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inFront, serveBoard, type Fronts } from "../src/board";
import { loadConfig } from "../src/config";
import { movedTo } from "../src/daemon";
import type { AgentEvent, BoardAct } from "../src/contracts";
import { QQ_CAPABILITIES, TELEGRAM_CAPABILITIES } from "../src/platforms";
import { route, type Ctx, type Decision, type State } from "../src/router";
import { openStore, type Ask, type Bot, type Chat, type Slot } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-send-to-"));
/** Bots q and q2 on QQ, t on Telegram; whose rows go by the same names. */
function config(more = "") {
  const file = join(dir, `config-${crypto.randomUUID()}.toml`);
  writeFileSync(file, `stateDir = "${dir}"\n${more}\n[bots.q]\nplatform = "qq"\n[bots.q2]\nplatform = "qq"\n[bots.t]\nplatform = "telegram"\n`, { mode: 0o600 });
  return loadConfig(file);
}
const CONFIG = config();

const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  now: 1_000,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: CONFIG,
  capabilities: (bot) => (bot === "t" ? TELEGRAM_CAPABILITIES : QQ_CAPABILITIES),
  keepFile: (path) => ({ size: 1, path: `/media/${path.split("/").pop()}` }),
  diskFree: () => Infinity,
  herdr: () => true,
  front: () => false,
  retarget: () => null,
  inboundOf: () => [],
  ...o,
});

const slot = (id: string, o: Partial<Slot> = {}) =>
  ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "running", conversation: id, parent: null, lifetime: "longterm", archivedAt: null, token: id, turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null, reported: null, webAt: null, ...o }) as Slot;
const bot = (id: string, platform: string, o: Partial<Bot> = {}) => ({ id, name: id, platform, defaultTarget: "x", owners: JSON.stringify(["me"]), connState: "online", ...o }) as Bot;
const chat = (id: string, bot: string, o: Partial<Chat> = {}) => ({ id, bot, platformChatId: "me", target: null, contactedAt: null, ...o }) as Chat;

/** Slots a, its child c, and x, which the bots go to by default; your private chats with each bot. */
function state(o: { slots?: Slot[]; bots?: Bot[]; chats?: Chat[] } = {}): State {
  const slots = o.slots ?? [slot("a"), slot("c", { parent: "a" }), slot("x")];
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots,
    conversations: slots.map((s) => ({ id: s.id, slot: s.id, agent: "claude", sessionId: s.id, startedAt: 0, progress: null })),
    bots: o.bots ?? [bot("q", "qq"), bot("q2", "qq"), bot("t", "telegram")],
    chats: o.chats ?? [],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
}

/** rh send from slot from, with these words after send. */
function send(s: State, argv: string[], c = ctx(), from = "a"): { d: Decision; reply: string } {
  const d = route(s, { kind: "rh", id: "r", caller: { token: from, pid: null, tty: false, cwd: "/w" }, argv: ["send", ...argv] }, c);
  const r = d.effects.find((e) => e.kind === "rh_reply")!.reply;
  return { d, reply: r.ok ? r.text : r.error };
}
/** The chats the decision sends to, each once, and the texts. */
const sentTo = (d: Decision) => [...new Set(d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [w.row.chat as string] : [])))];
const texts = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [JSON.parse(w.row.payload as string).text as string] : []));
const sentMe = (d: Decision) => d.events.find((e) => e.type === "send_me")!;

test("story 576: rh send qq goes to the QQ private chat going to the slot, the latest you wrote in of several; else to its root slot; else the one you used last; else the main chat", () => {
  // q2 goes to c, q to its root a, written in later: c's own is first.
  const own = [chat("q", "q", { target: "a", contactedAt: 9 }), chat("q2", "q2", { target: "c", contactedAt: 5 }), chat("t", "t", { target: "c", contactedAt: 20 })];
  expect(sentTo(send(state({ chats: own }), ["qq", "hi"], ctx(), "c").d)).toEqual(["q2"]);
  // None goes to c: its root's.
  const root = [chat("q", "q", { target: "a", contactedAt: 1 }), chat("q2", "q2", { contactedAt: 9 }), chat("t", "t", { target: "c" })];
  expect(sentTo(send(state({ chats: root }), ["qq", "hi"], ctx(), "c").d)).toEqual(["q"]);
  // None goes to it or its root: the one you wrote in last, which says whose it is.
  const last = [chat("q", "q", { contactedAt: 1 }), chat("q2", "q2", { contactedAt: 9 }), chat("t", "t", { target: "a", contactedAt: 20 })];
  const { d, reply } = send(state({ chats: last }), ["qq", "hi"]);
  expect([sentTo(d), texts(d), reply]).toEqual([["q2"], ["〔w/a〕\nhi"], "已发到 QQ Bot q2 的私聊。"]);
  // No QQ chat of yours: the main chat, on QQ.
  const main = ctx({ config: config('mainChat = "q/group-1"') });
  const there = send(state({ chats: [chat("t", "t", { target: "a" })] }), ["qq", "hi"], main);
  expect(there.reply).toBe("已发到 QQ Bot q 的聊天窗口。");
});

test("story 576: a platform's name wins over a bot of that name; a bot's name sends from that bot; --file follows either", () => {
  const c = ctx({ config: config("[bots.qq]\nplatform = \"telegram\"") });
  const s = state({ bots: [bot("q", "qq"), bot("qq", "telegram"), bot("t", "telegram")], chats: [chat("q", "q"), chat("qq", "qq", { contactedAt: 9 }), chat("t", "t", { target: "a" })] });
  expect(sentTo(send(s, ["qq", "hi"], c).d)).toEqual(["q"]);
  const { d } = send(s, ["t", "--file", "/w/shot.png", "hi"], c);
  expect([sentTo(d), texts(d)]).toEqual([["t"], ["hi", ""]]);
  expect(sentMe(d).data).toEqual({ files: [{ kind: "image", hash: "shot.png", name: "shot.png" }] });
});

test("story 575: you wrote to the slot on the board last: with a page in front it stays on the board, no outbound; with none, it goes to the contact chat", () => {
  const s = state({ slots: [slot("a", { webAt: 10 })], chats: [chat("q", "q", { target: "a", contactedAt: 5 })] });
  const web = send(s, ["me", "--file", "/w/shot.png", "done"], ctx({ front: () => true }));
  expect([sentTo(web.d), web.reply]).toEqual([[], "留在网页上，没发 IM。"]);
  expect(sentMe(web.d)).toMatchObject({ slot: "a", data: { web: true, files: [{ kind: "image", hash: "shot.png", name: "shot.png" }] } });
  const away = send(s, ["me", "done"]);
  expect([sentTo(away.d), away.reply]).toEqual([["q"], "网页没开在前台，已发到 QQ Bot q 的私聊。"]);
  expect(sentMe(away.d).data).toBeUndefined();
  // You wrote in IM after: there, page or not.
  const im = state({ slots: [slot("a", { webAt: 10 })], chats: [chat("q", "q", { target: "a", contactedAt: 15 })] });
  expect(sentTo(send(im, ["me", "done"], ctx({ front: () => true })).d)).toEqual(["q"]);
  // No chat goes to it: the board, if you wrote there; else the main chat.
  const none = state({ slots: [slot("a", { webAt: 10 })], chats: [chat("q", "q", { target: "x", contactedAt: 50 })] });
  expect(sentTo(send(none, ["me", "done"], ctx({ front: () => true })).d)).toEqual([]);
});

test("story 576: rh send web stays on the board, a page in front or not", () => {
  const { d, reply } = send(state({ chats: [chat("q", "q", { target: "a", contactedAt: 5 })] }), ["web", "done"]);
  expect([sentTo(d), reply, sentMe(d).data]).toEqual([[], "留在网页上，没发 IM。", { web: true }]);
});

test("story 577: the receipt of some of rh send's messages moved spaces a chat name in Latin from the words before it", () => {
  expect(movedTo(1, 2, "QQ 私聊", "Telegram 私聊")).toBe("有 1 条在 QQ 私聊发不出去，改发到了 Telegram 私聊。");
  expect(movedTo(2, 2, "QQ 私聊", "飞书私聊")).toBe("QQ 私聊发不出去，改发到了飞书私聊。");
});

test("story 576: a destination that cannot send, by no chat of yours there, a faulted bot or QQ's quota, falls back to the default, and the receipt says so", () => {
  const chats = [chat("t", "t", { target: "a", contactedAt: 5 })];
  const none = send(state({ chats, bots: [bot("q", "qq", { owners: null }), bot("t", "telegram")] }), ["qq", "hi"]);
  expect([sentTo(none.d), none.reply]).toEqual([["t"], "QQ 发不出去：没有能发的私聊。改按默认规则发：已发到 Telegram 私聊。"]);
  const faulted = send(state({ chats: [...chats, chat("q", "q")], bots: [bot("q", "qq", { connState: "faulted" }), bot("t", "telegram")] }), ["q", "hi"]);
  expect([sentTo(faulted.d), faulted.reply]).toEqual([["t"], "QQ Bot q 发不出去：Bot 故障。改按默认规则发：已发到 Telegram 私聊。"]);
  const quota = ctx({ config: { ...CONFIG, limits: { ...CONFIG.limits, qqActive: 0 } } });
  const out = send(state({ chats: [...chats, chat("q", "q", { contactedAt: 1 })] }), ["qq", "hi"], quota);
  expect([sentTo(out.d), out.reply]).toEqual([["t"], "QQ 发不出去：额度不够。改按默认规则发：已发到 Telegram 私聊。"]);
});

test("story 581: a QQ bot's active count started on a longer period than the one configured starts afresh, on the configured one", () => {
  const window = CONFIG.durations.qqActiveWindow;
  const spent = (resetsAt: number) => {
    const s = state({ chats: [chat("q", "q", { target: "a", contactedAt: 5 })] });
    s.quotas = [{ id: "qa", machine: "", kind: "qq_active", owner: "q", used: CONFIG.limits.qqActive, resetsAt }];
    return send(s, ["q", "hi"]);
  };
  // Counted on 30 days when the config said so: today's period is new.
  const old = spent(ctx().now + 30 * 86_400_000);
  expect(old.reply).toBe("已发到 QQ Bot q 的私聊。");
  expect(old.d.writes).toContainEqual({ op: "update", table: "quota", where: { id: "qa" }, patch: { kind: "qq_active", owner: "q", used: 0, resetsAt: ctx().now + window } });
  // A period as long as the configured one still counts.
  expect(spent(ctx().now + window).reply).toStartWith("QQ Bot q 发不出去：额度不够。");
});

test("story 578: a child you are not talking to sends to a destination named, and its report then leaves out that it told you nothing", () => {
  const s = state({ chats: [chat("t", "t", { target: "a", contactedAt: 5 })] });
  expect(send(s, ["me", "hi"], ctx(), "c").reply).toContain("rh send me 被拒绝");
  const { d, reply } = send(s, ["telegram", "hi"], ctx(), "c");
  expect(reply).toBe("已发到 Telegram 私聊。");
  expect(d.writes).toContainEqual({ op: "update", table: "slot", where: { id: "c" }, patch: { turnToldYou: 1 } });
  const report = (told: 1 | null) => {
    const s = state({ slots: [slot("a", { state: "idle" }), slot("c", { parent: "a", turnInbound: "in", turnToldYou: told })] });
    const d = route(s, { kind: "agent", event: { conv: "c", type: "turn_end", reply: "done" } as AgentEvent }, ctx());
    return d.writes.flatMap((w) => (w.op === "insert" && w.table === "agentInput" ? [w.row.body as string] : []))[0]!;
  };
  expect(report(null)).toContain("它没有直接告诉用户。");
  expect(report(1)).not.toContain("它没有直接告诉用户");
  // Its next turn told you nothing yet.
  const start = route(state({ slots: [slot("a"), slot("c", { parent: "a", state: "idle", turnToldYou: 1 })] }), { kind: "agent", event: { conv: "c", type: "turn_start" } as AgentEvent }, ctx());
  expect(start.writes.find((w) => w.table === "slot" && w.op === "update" && w.where.id === "c" && "turnToldYou" in w.patch)).toBeDefined();
});

test("story 578: a child's rh send to a destination named that does not go out, failing or turned down with no other bot to take it, takes back that it told you (#615)", () => {
  const child = (turnStartedAt: number) => slot("c", { parent: "a", turnToldYou: 1, turnStartedAt });
  const s = state({ slots: [slot("a"), child(5)], chats: [chat("t", "t", { target: "a", contactedAt: 5 })] });
  const payload = send(s, ["telegram", "hi"], ctx(), "c").d.writes.find((w) => w.op === "insert" && w.table === "outbound")!.row.payload as string;
  const back = { op: "update", table: "slot", where: { id: "c" }, patch: { turnToldYou: null } } as const;
  expect(route(s, { kind: "send_failed", payload }, ctx()).writes).toContainEqual(back);
  const alone = { ...s, bots: [bot("t", "telegram")] };
  expect(route(alone, { kind: "refused", outbound: "o", chat: "t", inbound: null, payload, quota: false }, ctx()).writes).toContainEqual(back);
  // Failing only once its turn is over, say held for QQ's quota, it leaves the next turn's alone.
  expect(route({ ...s, slots: [slot("a"), child(9)] }, { kind: "send_failed", payload }, ctx()).writes).not.toContainEqual(back);
});

test("story 575: your message the slot took from the board, a common command or an answer there marks when you last wrote to it there; one turned away does not", () => {
  const ask = { id: "k", slot: "a", kind: "permission", requestId: "r1", prompt: JSON.stringify({ tool: "Bash", input: { command: "ls" } }), status: "open", forwardedTo: null, listNo: null, pickedAt: null, pushedAt: 1 } as Ask;
  const act = (s: Slot, act: BoardAct) => route({ ...state({ slots: [s] }), asks: act.kind === "answer" ? [ask] : [] }, { kind: "board", id: "b1", act }, ctx()).writes;
  const marked = expect.objectContaining({ table: "slot", where: { id: "a" }, patch: expect.objectContaining({ webAt: 1_000 }) });
  expect(act(slot("a", { state: "idle" }), { kind: "say", slot: "a", text: "hi" })).toContainEqual(marked);
  expect(act(slot("a"), { kind: "common", slot: "a", name: "stop" })).toContainEqual(marked);
  expect(act(slot("a"), { kind: "say", slot: "a", text: "/compact" })).toContainEqual(marked);
  expect(act(slot("a", { state: "waiting" }), { kind: "answer", ask: "k", text: "1" })).toContainEqual(marked);
  expect(JSON.stringify(act(slot("a", { mode: "tui" }), { kind: "say", slot: "a", text: "hi" }))).not.toContain("webAt");
});

test("story 576: no bot may be named me or web", () => {
  for (const name of ["me", "web"]) {
    const d = route(state(), { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv: ["bot", name, "telegram", "w/a"] }, ctx());
    expect(d.effects.find((e) => e.kind === "rh_reply")!.reply).toEqual({ ok: false, error: `Bot 不能叫 ${name}：rh send ${name} 另有用处。` });
    expect(() => config(`[bots.${name}]\nplatform = "telegram"`)).toThrow(`config: bots.${name}: a bot may not be named me or web, which rh send takes for you; rename it`);
  }
});

test("story 575: each page of the board open says whether it is in front, by its event stream's id; a page gone, or silent past 70 s, is in front no more", async () => {
  const file = join(dir, "board.toml");
  writeFileSync(file, `stateDir = "${dir}/state"\n[herdr]\nsession = "rhodium-test-none"\n[board]\nport = 0\nauth = "none"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "board.db"));
  const fronts: Fronts = new Map();
  const server = serveBoard(store, loadConfig(file), new Set(), join(dir, "none"), undefined, fronts);
  const at = `http://127.0.0.1:${server.port}`;
  const say = (stream: string, front: string, site = "same-origin") => fetch(`${at}/api/front`, { method: "POST", headers: { "sec-fetch-site": site }, body: new URLSearchParams({ stream, front }) });
  const anyFront = () => inFront(fronts);
  try {
    const ac = new AbortController();
    const r = await fetch(`${at}/api/events`, { signal: ac.signal });
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    let first = "";
    while (!first.includes("\n\n")) first += (await reader.read()).value;
    const { stream } = JSON.parse(/^data: (.*)$/m.exec(first)![1]!);
    expect([fronts.has(stream), anyFront()]).toEqual([true, false]);
    expect((await say(stream, "1", "cross-site")).status).toBe(403);
    expect(anyFront()).toBe(false);
    expect((await say(stream, "1")).status).toBe(204);
    expect(anyFront()).toBe(true);
    await say(stream, "");
    expect(anyFront()).toBe(false);
    await say(stream, "1");
    // A page that dropped off without saying so, its device asleep say: it says so again every 30 s.
    setSystemTime(Date.now() + 69_000);
    expect(anyFront()).toBe(true);
    setSystemTime(Date.now() + 2_000);
    expect(anyFront()).toBe(false);
    await say(stream, "1");
    expect(anyFront()).toBe(true);
    setSystemTime();
    // One never opened, or closed since, says nothing.
    await say("elsewhere", "1");
    expect(fronts.has("elsewhere")).toBe(false);
    ac.abort();
    await until(() => !fronts.has(stream));
    expect(anyFront()).toBe(false);
  } finally {
    setSystemTime();
    server.stop(true);
    store.close();
  }
});
