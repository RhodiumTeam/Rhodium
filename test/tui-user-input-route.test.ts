// Your own messages typed into a slot's terminal, seen from the router (stories 623, 624, docs/spec/tui-user-input.md
// "测试决定"): what you hear when one cannot go in at once, and when not; a slot whose pane is yet to open refuses it;
// one typed and not known to have got there is told of once, at once only when it came from IM.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type Decision, type State } from "../src/router";
import type { Slot } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-tui-user-input-route-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const now = Date.parse("2026-11-16T12:00:00Z");
const ctx: Ctx = {
  now,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: loadConfig(join(dir, "config.toml")),
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => true,
  retarget: () => null,
  dropBot: () => {},
  inboundOf: () => [],
};
const held = ctx.config.durations.tuiHeld;

/** Slot w/a in the terminal with type-in on, its pane open and its screen ready unless told; your chat ch goes to it. */
function state(o: Partial<Slot> = {}, more: Partial<State> = {}): State {
  const a = { id: "a", workspace: "w", name: "a", dir: "/w", mode: "tui", state: "off", conversation: "ca", parent: null, lifetime: "longterm", archivedAt: null };
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [{ ...a, herdrPane: "p1", tuiPid: 42, typeIn: 1, tuiInput: "ready", herdrLostAt: null, tuiHeldNotice: null, ...o }],
    conversations: [{ id: "ca", slot: "a", agent: "claude", sessionId: "s", startedAt: 0, progress: null }],
    bots: [{ id: "q", platform: "qq", name: "q", isMain: 1, owners: JSON.stringify(["me"]), pairCode: null, pairUntil: null, pairAdd: null, defaultTarget: "a" }],
    chats: [{ id: "ch", bot: "q", platformChatId: "me", target: null, panel: null, verbose: null, contactedAt: null }],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [], typed: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
    ...more,
  } as unknown as State;
}
const im = (s: State, text = "看下测试") => route(s, { kind: "im", message: { bot: "q", chat: "me", messageId: "m", sender: "me", text, at: now } }, ctx);
const told = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [JSON.parse(w.row.payload as string).text as string] : []));
const typedIn = (d: Decision) => d.writes.some((w) => w.op === "insert" && w.table === "agentInput");

test("story 623: a dialog, a screen not made out, Herdr away: yours waits, and you hear so, after the colon what it waits for", () => {
  const cases: [Partial<Slot>, string][] = [
    [{ tuiInput: "dialog" }, "终端里开着一个对话框。关掉就打进去，回复照常发回这里。"],
    [{ tuiInput: "unknown" }, "认不出终端里的画面。认出来就打进去，也可以切回无头再交给它。"],
    [{ herdrLostAt: now - 1000 }, "Herdr 正在重启。回来以后接着打；它的进程没了，就切回无头再交给它。"],
  ];
  for (const [o, why] of cases) {
    const d = im(state(o));
    expect([o, typedIn(d), told(d)]).toEqual([o, true, [`w/a 在终端里，这条先排着：${why}`]]);
  }
});

test("story 623: yours behind one being typed, the screen ready, waits unsaid", () => {
  const typing = { id: "i0", conversation: "ca", source: "human", status: "writing", queueReason: "tui", typedAt: now - 500, typed: "x", body: "x", trace: "t0" };
  const d = im(state({}, { queued: [typing] as never }));
  expect([typedIn(d), told(d)]).toEqual([true, []]);
});

test("story 621: a slot switching to the terminal, its pane not open, or one that could not switch back, its agent gone, refuses yours as ever", () => {
  for (const o of [{ herdrPane: null }, { tuiPid: null }]) {
    const d = im(state(o));
    expect([o, typedIn(d)]).toEqual([o, false]);
    expect(told(d)[0]).toContain("这条没交给它。");
  }
});

/** One typed into w/a's terminal 31 s ago, past durations.tuiConfirm, not known to have got there. */
const unknown = (o: object = {}) => ({ id: "i1", conversation: "ca", source: "human", status: "unknown", queueReason: "tui", typedAt: now - 31_000, typed: "[来自 网页]\n网页来的", body: "[来自 网页]\n网页来的", trace: "b1", noticedAt: null, resentAt: null, ...o });
const clock = (s: State, at = now) => route(s, { kind: "clock", timer: "tui_unconfirmed", key: "i1" }, { ...ctx, now: at });

test("story 624: one from the board marked unknown is not told of at once, only after durations.tuiHeld; one from IM is, its box read first", () => {
  const board = clock(state({}, { typed: [unknown()] as never }));
  expect([told(board), board.effects]).toEqual([[], [{ kind: "timer", timer: "tui_unconfirmed", key: "i1", at: now - 31_000 + held }]]);
  const s = state({}, { typed: [unknown({ typed: "[来自 q 私聊]\n在不在", body: "[来自 q 私聊]\n在不在", trace: "m1" })] as never, chatOf: { i1: "ch" } });
  expect(clock(s).effects).toEqual([{ kind: "tui_peek", slot: "a", input: "i1" }]);
  expect(told(route(s, { kind: "tui_peeked", input: "i1", inBox: false }, ctx))).toEqual(["打进 w/a 终端的这条尚未确认收到，没有再发：\n“在不在”\n要再发，到网页上点“重发”。"]);
});

test("story 624: yours told of at once is not told of again once durations.tuiHeld is up", () => {
  const s = state({}, { typed: [unknown({ noticedAt: now - 30_000 })] as never, chatOf: { i1: "ch" } });
  const d = clock(s, now - 31_000 + held);
  expect([told(d), d.writes, d.effects]).toEqual([[], [], []]);
  expect(told(route(s, { kind: "tui_peeked", input: "i1", inBox: false }, { ...ctx, now: now - 31_000 + held }))).toEqual([]);
});

test("product §5.9: yours still waiting for the terminal when its agent exits goes to the headless agent, and counts as written where you sent it", () => {
  const wait = (id: string, trace: string) => ({ id, conversation: "ca", source: "human", status: "queued", queueReason: "tui", typedAt: null, typed: null, body: "x", trace });
  const s = state({}, { queued: [wait("i1", "m1"), wait("i2", "b2")] as never, chatOf: { i1: "ch" } });
  const d = route(s, { kind: "tui_back", slot: "a", back: { session: "s" } }, ctx);
  const patches = d.writes.flatMap((w) => (w.op === "update" && (w.table === "chat" || w.table === "slot") ? [[w.table, w.where.id, w.patch]] : []));
  expect(patches).toContainEqual(["chat", "ch", { contactedAt: now }]);
  expect(patches).toContainEqual(["slot", "a", { imAt: now }]);
  expect(patches).toContainEqual(["slot", "a", { webAt: now }]);
});

test("product §5.3: yours typed into an archived slot's terminal, from IM or the board, brings the slot back", () => {
  const s = state({ archivedAt: now - 1000 });
  for (const d of [im(s), route(s, { kind: "board", id: "r", act: { kind: "say", slot: "a", text: "看下测试" } }, ctx)]) {
    expect(typedIn(d)).toBe(true);
    expect(d.events.filter((e) => e.type === "slot_unarchived").map((e) => e.slot)).toEqual(["a"]);
    expect(d.writes).toContainEqual({ op: "update", table: "slot", where: { id: "a" }, patch: { archivedAt: null, activeAt: now } });
  }
});
