// Where rh send to you goes (stories 575-578; product §5.9, architecture §8.7): by default where you
// last wrote to the slot, the board too while a page of it is in front; or the platform or bot the
// agent names, falling back to the default when that cannot send; the receipt says where it went.
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { until } from "./instance";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
afterAll(() => rmSync(dir, { recursive: true, force: true }));
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
  dropBot: () => {},
  inboundOf: () => [],
  ...o,
});

const slot = (id: string, o: Partial<Slot> = {}) =>
  ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "running", conversation: id, parent: null, lifetime: "longterm", archivedAt: null, token: id, turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null, reported: null, webAt: null, imAt: null, ...o }) as Slot;
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
  // c's parent is archived, so it is a child no more and may send; its root is still a.
  const slots = [slot("a", { archivedAt: 1 }), slot("c", { parent: "a" }), slot("x")];
  // q2 goes to c, q to its root a, written in later: c's own is first.
  const own = [chat("q", "q", { target: "a", contactedAt: 9 }), chat("q2", "q2", { target: "c", contactedAt: 5 }), chat("t", "t", { target: "c", contactedAt: 20 })];
  expect(sentTo(send(state({ slots, chats: own }), ["qq", "hi"], ctx(), "c").d)).toEqual(["q2"]);
  // None goes to c: its root's.
  const root = [chat("q", "q", { target: "a", contactedAt: 1 }), chat("q2", "q2", { contactedAt: 9 }), chat("t", "t", { target: "c" })];
  expect(sentTo(send(state({ slots, chats: root }), ["qq", "hi"], ctx(), "c").d)).toEqual(["q"]);
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

const UNPUSHED = "用户正在网页上看，没推送到 IM。这条消息已在网页上整条显示，回复里不用再写一遍。";

test("story 593: rh send me is pushed to the contact chat, but while you wrote to the slot on the board last and a page is in front: then no outbound, its files and unread on the board, and the receipt says so", () => {
  const chats = [chat("q", "q", { target: "a", contactedAt: 50 })];
  const s = state({ slots: [slot("a", { webAt: 10 })], chats });
  const web = send(s, ["me", "--file", "/w/shot.png", "done"], ctx({ front: () => true }));
  expect([sentTo(web.d), web.reply]).toEqual([[], UNPUSHED]);
  expect(sentMe(web.d)).toMatchObject({ slot: "a", data: { web: true, files: [{ kind: "image", hash: "shot.png", name: "shot.png" }] } });
  // The page in the back: pushed, the receipt with nothing before 已发到.
  const away = send(s, ["me", "done"]);
  expect([sentTo(away.d), away.reply]).toEqual([["q"], "已发到 QQ Bot q 的私聊。"]);
  expect(sentMe(away.d).data).toBeUndefined();
  // Story 594: by the slot's own time in IM, not the chat's, which another slot's message may have moved.
  expect(sentTo(send(state({ slots: [slot("a", { webAt: 10, imAt: 15 })], chats: [chat("q", "q", { target: "a", contactedAt: 5 })] }), ["me", "done"], ctx({ front: () => true })).d)).toEqual(["q"]);
  // Never written to on the board, as every slot is after the upgrade: pushed.
  expect(sentTo(send(state({ slots: [slot("a")], chats }), ["me", "done"], ctx({ front: () => true })).d)).toEqual(["q"]);
  // A destination named is pushed all the same; one that can't send goes by rh send me's rule.
  expect(sentTo(send(s, ["qq", "done"], ctx({ front: () => true })).d)).toEqual(["q"]);
  const faulted = send({ ...s, bots: [bot("q", "qq", { connState: "faulted" }), bot("t", "telegram")] }, ["qq", "done"], ctx({ front: () => true }));
  expect([sentTo(faulted.d), faulted.reply]).toEqual([[], `QQ 发不出去：Bot 故障。改照 rh send me 的规则发：${UNPUSHED}`]);
});

test("story 598: rh send web is gone: refused with how to write it now, from a slot, a child or your terminal, and nothing is sent or kept", () => {
  const GONE = "rh send web 已经去掉了。要说的话写在回复里，网页上看得到；图片在回复里写成 ![说明](绝对路径)。";
  const s = state({ chats: [chat("q", "q", { target: "a", contactedAt: 5 })] });
  for (const from of ["a", "c", "nobody"]) {
    const { d, reply } = send(s, ["web", "--file", "/w/shot.png", "done"], ctx(), from);
    expect([reply, sentTo(d), d.events.filter((e) => e.type === "send_me")]).toEqual([GONE, [], []]);
  }
});

test("story 577: the receipt of some of rh send's messages moved spaces a chat name in Latin from the words before it", () => {
  expect(movedTo(1, 2, "QQ 私聊", "Telegram 私聊")).toBe("有 1 条在 QQ 私聊发不出去，改发到了 Telegram 私聊。");
  expect(movedTo(2, 2, "QQ 私聊", "飞书私聊")).toBe("QQ 私聊发不出去，改发到了飞书私聊。");
});

test("story 576: a destination that cannot send, by no chat of yours there, a faulted bot or QQ's quota, falls back to the default, and the receipt says so", () => {
  const chats = [chat("t", "t", { target: "a", contactedAt: 5 })];
  const none = send(state({ chats, bots: [bot("q", "qq", { owners: null }), bot("t", "telegram")] }), ["qq", "hi"]);
  expect([sentTo(none.d), none.reply]).toEqual([["t"], "QQ 发不出去：没有能发的私聊。改照 rh send me 的规则发：已发到 Telegram 私聊。"]);
  const faulted = send(state({ chats: [...chats, chat("q", "q")], bots: [bot("q", "qq", { connState: "faulted" }), bot("t", "telegram")] }), ["q", "hi"]);
  expect([sentTo(faulted.d), faulted.reply]).toEqual([["t"], "QQ Bot q 发不出去：Bot 故障。改照 rh send me 的规则发：已发到 Telegram 私聊。"]);
  const quota = ctx({ config: { ...CONFIG, limits: { ...CONFIG.limits, qqActive: 0 } } });
  const out = send(state({ chats: [...chats, chat("q", "q", { contactedAt: 1 })] }), ["qq", "hi"], quota);
  expect([sentTo(out.d), out.reply]).toEqual([["t"], "QQ 发不出去：额度不够。改照 rh send me 的规则发：已发到 Telegram 私聊。"]);
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

const NO_WORDS = (word: string) => `rh send ${word} 被拒绝：你是子槽位，不能直接给用户发消息。把结果写在最终回复里。要发给别的槽位，写全名“工作区/槽位”。`;

test("story 590: a child's rh send of words to you is refused, by me, a platform's or a bot's name, a chat bound to it or not, with no outbound and no notice; with its parent archived it goes", () => {
  for (const chats of [[chat("t", "t", { target: "a" })], [chat("t", "t", { target: "c" })]]) {
    for (const word of ["me", "qq", "t"]) {
      const { d, reply } = send(state({ chats }), [word, "hi"], ctx(), "c");
      expect([reply, d.writes.filter((w) => w.table === "outbound"), d.events.filter((e) => e.type === "send_me")]).toEqual([NO_WORDS(word), [], []]);
    }
    expect(send(state({ chats }), ["qq", "--file", "/w/a.txt"], ctx(), "c").reply).toBe(NO_WORDS("qq"));
  }
  // To a slot it sends as ever, its parent too.
  expect(send(state(), ["w/a", "hi"], ctx(), "c").reply).toBe("已发给 w/a。");
  // Its parent archived while it runs: a child no more, at once.
  const gone = state({ slots: [slot("a", { archivedAt: 1 }), slot("c", { parent: "a" })], chats: [chat("t", "t", { target: "c" })] });
  expect(send(gone, ["me", "hi"], ctx(), "c").reply).toBe("已发到 Telegram 私聊。");
});

test("story 591: a child sends you a file alone while you talk to it directly, by a chat bound to it, a turn you began, or its terminal; with words, or with none of these, it is refused", () => {
  const bound = [chat("t", "t", { target: "c" })];
  const file = (s: State, ...more: string[]) => send(s, ["me", "--file", "/w/log.txt", ...more], ctx(), "c");
  const sent = file(state({ chats: bound }));
  expect([sentTo(sent.d), sent.reply]).toEqual([["t"], "已发到 Telegram 私聊。"]);
  expect(file(state({ chats: bound }), "the log").reply).toBe("rh send me 被拒绝：你是子槽位，发文件时不能带文字。去掉文字再发一次，要说的话写在回复里。");
  // No chat bound to it, in a turn no message of yours began: with words or without.
  const up = [chat("t", "t", { target: "a" })];
  for (const more of [[], ["the log"]]) expect(file(state({ chats: up }), ...more).reply).toBe("rh send me --file 被拒绝：用户现在没有直接找你。把文件的路径写在最终回复里。");
  const child = (o: Partial<Slot>) => state({ slots: [slot("a"), slot("c", { parent: "a", ...o })], chats: up });
  expect(file(child({ turnChat: "t", turnInbound: "in" })).reply).toBe("已发到 Telegram 私聊。");
  expect(file(child({ mode: "tui" })).reply).toBe("已发到 Telegram 私聊。");
});

test("story 597: a child's rh send with nothing to send gets the child's usage, with no platform's nor bot's name; another slot's gets the other", () => {
  expect(send(state(), ["me"], ctx(), "c").reply).toBe("用法：rh send me --file <路径>... | <工作区/槽位> <文字>|-");
  expect(send(state(), ["me"]).reply).toContain("<Bot 名>");
});

test("story 599: rh send to a name with no / that is no platform's nor bot's says to write the slot's full name, whoever writes it", () => {
  const said = "看不懂 foo。给槽位发消息要写全名“工作区/槽位”，例如 rh send Rhodium/pi 你好。";
  expect(send(state(), ["foo", "hi"]).reply).toBe(said);
  expect(send(state(), ["foo", "hi"], ctx(), "c").reply).toBe(said);
  // A slot's id still goes, as a button too long with its name writes it.
  expect(send(state(), ["x", "hi"]).reply).toBe("已发给 w/x。");
});

/** The slot's turn ends with this reply: what went out, and the final_reply event, if any. */
function ends(s: State, conv: string, reply: string | undefined, c = ctx()) {
  const d = route(s, { kind: "agent", event: { conv, type: "turn_end", reply } as AgentEvent }, c);
  const reports = d.writes.flatMap((w) => (w.op === "insert" && w.table === "agentInput" ? [w.row.body as string] : []));
  return { to: sentTo(d), texts: texts(d), reports, final: d.events.find((e) => e.type === "final_reply"), d };
}

test("story 592: a child with a chat bound to it has the final reply of a turn no message of yours began sent there, in one message, with no report; an empty one is not sent; nor one you watch on the board", () => {
  const bound = (o: Partial<Slot> = {}, chats = [chat("t", "t", { target: "c", contactedAt: 5 })]) => state({ slots: [slot("a", { state: "idle" }), slot("c", { parent: "a", ...o })], chats });
  const sent = ends(bound(), "c", "all **12** wicks trimmed");
  expect([sent.to, sent.texts, sent.reports]).toEqual([["t"], ["all **12** wicks trimmed"], []]);
  expect(sent.final).toMatchObject({ slot: "c" });
  expect(sent.final!.data).toBeUndefined();
  // One trace for the event and what went out.
  expect(sent.d.writes.find((w) => w.op === "insert" && w.table === "outbound")!.row.trace).toBe(sent.final!.trace!);
  expect(ends(bound(), "c", " ").to).toEqual([]);
  // You wrote to it on the board last, a page in front: not pushed, and no final_reply, so it is unread there.
  const watched = ends(bound({ webAt: 10 }), "c", "done", ctx({ front: () => true }));
  expect([watched.to, watched.final]).toEqual([[], undefined]);
  // rh stop cut the turn short: nothing.
  const stopped = { ...bound(), holders: [{ conversation: "c", stopRequested: 1 }] } as unknown as State;
  expect(ends(stopped, "c", "done").to).toEqual([]);
});

test("story 592: with no chat bound to it the child reports to its parent, without 它没有直接告诉用户, and you get nothing; a slot that is no child sends no reply of such a turn", () => {
  const up = ends(state({ slots: [slot("a", { state: "idle" }), slot("c", { parent: "a" })], chats: [chat("t", "t", { target: "a" })] }), "c", "done");
  expect([up.to, up.final]).toEqual([[], undefined]);
  expect(up.reports).toEqual(["[来自 Rhodium：子槽位汇报]\n子槽位 w/c 完成了。最后一条回复的开头：done\n看它的状态和最近的对话：rh read w/c"]);
  const own = ends(state({ slots: [slot("a")], chats: [chat("t", "t", { target: "a" })] }), "a", "done");
  expect([own.to, own.final]).toEqual([[], undefined]);
});

test("story 592: the bound chat's bot can't send: the reply goes through another bot, led by where it was for and by the child's name, and its event says so for your quote", () => {
  const s = state({ slots: [slot("a", { state: "idle" }), slot("c", { parent: "a" })], bots: [bot("q", "qq", { connState: "faulted" }), bot("t", "telegram")], chats: [chat("q", "q", { target: "c" }), chat("t", "t")] });
  const moved = ends(s, "c", "done");
  expect([moved.to, moved.texts]).toEqual([["t"], ["QQ Bot q 的私聊那边发不出去，改发在这里。\n\n〔w/c〕\ndone"]]);
  expect(moved.final!.data).toEqual({ named: true });
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
  // rh send web is gone, so neither sentence may say it still has a use.
  const why: Record<string, [string, string]> = {
    me: ["Bot 不能叫 me：rh send me 另有用处。", "rh send me is to you"],
    web: ["Bot 不能叫 web：还在跑的 agent 可能照旧写 rh send web。", "an agent still running may write rh send web, which is gone"],
  };
  for (const name of ["me", "web"]) {
    const d = route(state(), { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv: ["bot", name, "telegram", "w/a"] }, ctx());
    expect(d.effects.find((e) => e.kind === "rh_reply")!.reply).toEqual({ ok: false, error: why[name]![0] });
    expect(() => config(`[bots.${name}]\nplatform = "telegram"`)).toThrow(`config: bots.${name}: a bot may not be named ${name}: ${why[name]![1]}; rename it`);
  }
});

test("story 575: each page of the board open says whether it is in front, by its event stream's id; a page gone, or silent past 70 s, is in front no more", async () => {
  const file = join(dir, "board.toml");
  writeFileSync(file, `stateDir = "${dir}/state"\n[herdr]\nsession = "rhodium-test-none"\n[board]\nport = 0\nauth = "none"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "board.db"));
  const fronts: Fronts = new Map();
  const server = serveBoard(store, loadConfig(file), new Set(), join(dir, "none"), undefined, fronts).servers[0]!;
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
