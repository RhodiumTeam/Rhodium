// The board's slot buttons (spec web-write, its seventh ticket): a batch of new targets for chats and
// bots, done only if each was as the page saw it; one line in each chat whose messages now go
// elsewhere, as rh use and rh bind at a terminal say too; and an archive the page can undo. Seen from
// seam one, through the board's HTTP.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { BOARD_LOGIN, boardAct, newInstance, until } from "./instance";

const ME = "you-openid";
const STRANGER = "stranger-openid";
// Bots q and t send your private chats to w/a by default.
const rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
let base = "";
beforeAll(async () => {
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a", "b", "c");
  // Your private chats, and a stranger's chat with t, each on record once it says something.
  for (const [bot, who] of [["q", ME], ["t", ME], ["t", STRANGER]] as const) await rhodium.im.inject(bot, { chat: who, sender: who, text: "hi" });
  await until(async () => (await texts("q")).length > 0 && (await texts("t")).length > 0, 15_000);
}, 30_000);
afterAll(() => rhodium.cleanup());

type Reply = { ok: true; text: string; undo?: unknown } | { ok: false; error: string };
const act = async (a: unknown): Promise<Reply> => (await boardAct(base, a)).json() as Promise<Reply>;
type Topology = { bots: { id: string; name: string; target: string | null }[]; chats: { id: string; bot: string; kind: string; verbose: boolean }[]; bindings: { chat: string; slot: string; use: boolean }[]; slots: { id: string; ref: string; archived: boolean }[] };
const topology = async () => (await fetch(`${base}/api/topology`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<Topology>;
/** The ids the page has: your private chat with each bot, each bot, and the slots by ref. */
async function ids() {
  const g = await topology();
  const bot = (name: string) => g.bots.find((b) => b.name === name)!.id;
  const mine = (name: string) => g.chats.find((c) => c.bot === bot(name) && c.kind === "private")!.id;
  return { g, q: bot("q"), t: bot("t"), qMine: mine("q"), tMine: mine("t"), slot: Object.fromEntries(g.slots.map((s) => [s.ref, s.id])) as Record<"w/a" | "w/b" | "w/c", string> };
}
const where = (g: Topology, chat: string) => g.bindings.find((b) => b.chat === chat);
const texts = async (bot: string, chat = ME) => (await rhodium.im.log(bot, chat)).map((p) => p.text);
/** Waits until the bot has said what in the chat, and says how many times it has. */
async function said(bot: string, what: string, chat = ME): Promise<number> {
  await until(async () => (await texts(bot, chat)).includes(what), 15_000);
  await Bun.sleep(300); // a second one would be on its way by now
  return (await texts(bot, chat)).filter((t) => t === what).length;
}

test("story 260: a batch from the board goes through as one when each change was as the page saw it; each chat whose messages now go elsewhere hears it once, a stranger's following the bot's default not at all", async () => {
  const { q, t, qMine, tMine, slot } = await ids();
  const r = await act({
    kind: "bind",
    changes: [
      { chat: qMine, from: { slot: slot["w/a"], use: false }, to: slot["w/b"] },
      { bot: t, from: slot["w/a"], to: slot["w/c"] },
    ],
  });
  expect(r.ok).toBe(true);
  expect(await said("q", "这里的消息改交给 w/b。")).toBe(1);
  expect(await said("t", "这里的消息改交给 w/c。")).toBe(1);
  expect(await texts("t", STRANGER)).not.toContainEqual(expect.stringContaining("改交给"));
  const { g } = await ids();
  expect(where(g, qMine)).toEqual({ chat: qMine, slot: slot["w/b"], use: true });
  expect(where(g, tMine)).toEqual({ chat: tMine, slot: slot["w/c"], use: false });
  expect(g.bots.find((b) => b.id === q)!.target).toBe(slot["w/a"]!);
  expect(g.bots.find((b) => b.id === t)!.target).toBe(slot["w/c"]!);

  // A chat moved back to its bot's default, which moves in the same batch: one line, where it ends.
  const back = await act({
    kind: "bind",
    changes: [
      { bot: q, from: slot["w/a"], to: slot["w/c"] },
      { chat: qMine, from: { slot: slot["w/b"], use: true }, to: null },
    ],
  });
  expect(back.ok).toBe(true);
  expect(await said("q", "这里改回默认，消息交给 w/c。")).toBe(1);
  expect(where((await ids()).g, qMine)).toEqual({ chat: qMine, slot: slot["w/c"], use: false });
}, 30_000);

test("story 260: a batch one of whose changes is no longer as the page saw it, another tab having changed it, is not done at all; the error says which chat goes where now", async () => {
  const { t, qMine, tMine, g, slot } = await ids();
  const was = await texts("q");
  const r = await act({
    kind: "bind",
    changes: [
      { chat: tMine, from: { slot: slot["w/c"], use: false }, to: slot["w/a"] },
      { chat: qMine, from: { slot: slot["w/a"], use: false }, to: slot["w/b"] }, // it goes to w/c now
      { bot: t, from: slot["w/c"], to: slot["w/b"] },
    ],
  });
  expect(r).toEqual({ ok: false, error: "假 IM Bot q 的私聊已经改交给 w/c，这一批都没改。" });
  expect((await ids()).g.bindings).toEqual(g.bindings);
  expect((await ids()).g.bots).toEqual(g.bots);
  await Bun.sleep(300);
  expect(await texts("q")).toEqual(was);
  // A bot's default as much.
  const bot = await act({ kind: "bind", changes: [{ bot: t, from: slot["w/a"], to: slot["w/b"] }] });
  expect(bot).toEqual({ ok: false, error: "假 IM Bot t 的默认目标已经改成 w/c，这一批都没改。" });
});

test("story 260: rh use and rh bind at a terminal say so in each chat whose messages now go elsewhere; the reply names the chat, never by its platform id", async () => {
  await rhodium.ok("bind", "q", "w/a");
  expect(await said("q", "这里的消息改交给 w/a。")).toBe(1);
  const use = await rhodium.ok("use", `q/${ME}`, "w/b");
  expect(use).toBe("假 IM Bot q 的私聊的消息改交给 w/b。\n");
  expect(await said("q", "这里的消息改交给 w/b。")).toBe(2);
  expect(await rhodium.ok("use", `q/${ME}`, "-")).toBe("假 IM Bot q 的私聊的消息改回 Bot q 的默认槽位 w/a。\n");
  expect(await said("q", "这里改回默认，消息交给 w/a。")).toBe(1);
  // A default moving tells your private chat, which follows it, and not the stranger's.
  await rhodium.ok("bind", "t", "w/b");
  expect(await said("t", "这里的消息改交给 w/b。")).toBe(1);
  expect(await texts("t", STRANGER)).not.toContainEqual(expect.stringContaining("改交给"));
  // From IM, the chat it came from has the reply alone.
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/rh_bind w/a" });
  await until(async () => (await texts("t")).includes("这个 Bot 的默认槽位改成 w/a。单独选过槽位的窗口不受影响。"), 15_000);
  await Bun.sleep(300);
  expect(await texts("t")).not.toContain("这里的消息改交给 w/a。");
}, 30_000);

test("stories 268, 269: an archive from the board comes with its undo; sent back, the slot is back and each chat it took back points at it again, said there; or, a chat changed meanwhile, nothing is undone, and 恢复 brings the slot back alone", async () => {
  const { qMine, slot } = await ids();
  await rhodium.ok("use", `q/${ME}`, "w/c");
  const archived = await act({ kind: "rh", argv: ["archive", slot["w/c"]] });
  expect(archived).toEqual({
    ok: true,
    text: "已归档 w/c，对话保留。",
    undo: { kind: "bind", unarchive: slot["w/c"], changes: [{ chat: qMine, from: { slot: slot["w/a"], use: false }, to: slot["w/c"] }] },
  });
  await said("q", "w/c 归档了，这里的消息改交给 w/a。");
  const undone = await act((archived as { undo: unknown }).undo);
  expect(undone).toEqual({ ok: true, text: "已恢复 w/c。" });
  expect(await said("q", "这里的消息改交给 w/c。")).toBe(2);
  const { g } = await ids();
  expect(g.slots.find((s) => s.ref === "w/c")!.archived).toBe(false);
  expect(where(g, qMine)).toEqual({ chat: qMine, slot: slot["w/c"], use: true });

  const again = (await act({ kind: "rh", argv: ["archive", slot["w/c"]] })) as { undo: unknown };
  await rhodium.ok("use", `q/${ME}`, "w/b");
  expect(await act(again.undo)).toEqual({ ok: false, error: "假 IM Bot q 的私聊已经改交给 w/b，没有撤销。w/c 还在已归档里，能从那里恢复。" });
  expect((await ids()).g.slots.find((s) => s.ref === "w/c")!.archived).toBe(true);
  expect(await act({ kind: "rh", argv: ["unarchive", slot["w/c"]] })).toEqual({ ok: true, text: "已恢复 w/c。" });
  const now = await ids();
  expect(now.g.slots.find((s) => s.ref === "w/c")!.archived).toBe(false);
  expect(where(now.g, qMine)!.slot).toBe(slot["w/b"]!);
}, 30_000);

test("story 270: the board stops a slot's process by its id, saying which by name", async () => {
  const { slot } = await ids();
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "wake" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await act({ kind: "rh", argv: ["stop", slot["w/a"]] })).toEqual({ ok: true, text: "正在停止 w/a，对话保留。" });
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
}, 30_000);

test("story 319: the board switches how a chat writes tool lines, as /rh_verbose does there, saying nothing there; the topology says which", async () => {
  const { qMine, tMine } = await ids();
  const verbose = async (chat: string) => (await topology()).chats.find((c) => c.id === chat)!.verbose;
  expect([await verbose(qMine), await verbose(tMine)]).toEqual([false, true]);
  const was = await texts("q");
  expect(await act({ kind: "verbose", chat: qMine, on: true })).toEqual({ ok: true, text: expect.stringMatching(/^工具行改成详细/) });
  expect(await act({ kind: "verbose", chat: tMine, on: false })).toEqual({ ok: true, text: expect.stringMatching(/^工具行改成简略/) });
  expect([await verbose(qMine), await verbose(tMine)]).toEqual([true, false]);
  expect(await act({ kind: "verbose", chat: "nope", on: true })).toEqual({ ok: false, error: "没有这个聊天窗口。" });
  await Bun.sleep(300);
  expect(await texts("q")).toEqual(was);
});

/** Bot q sends to w/a and t to w/b, your private chat with each following; then what each bot has said
 *  there so far, once it had its say. */
async function followDefaults() {
  await rhodium.ok("bind", "q", "w/a");
  await rhodium.ok("bind", "t", "w/b");
  for (const bot of ["q", "t"]) await rhodium.rh(["use", `${bot}/${ME}`, "-"]);
  await Bun.sleep(300);
  return { q: (await texts("q")).length, t: (await texts("t")).length };
}
/** What each bot has said in your private chat since mark, once it had its say. */
async function since(mark: { q: number; t: number }, said = true) {
  if (said) await until(async () => (await texts("q")).length > mark.q && (await texts("t")).length > mark.t, 15_000);
  await Bun.sleep(300);
  return { q: (await texts("q")).slice(mark.q), t: (await texts("t")).slice(mark.t) };
}

test("story 379: a batch from the board swapping two chats' slots makes each its own pick of what the other had; each chat hears it once", async () => {
  const mark = await followDefaults();
  const { q, t, qMine, tMine, slot } = await ids();
  const r = await act({
    kind: "bind",
    changes: [
      { chat: qMine, from: { slot: slot["w/a"], use: false }, to: slot["w/b"] },
      { chat: tMine, from: { slot: slot["w/b"], use: false }, to: slot["w/a"] },
    ],
  });
  expect(r.ok).toBe(true);
  expect(await since(mark)).toEqual({ q: ["这里的消息改交给 w/b。"], t: ["这里的消息改交给 w/a。"] });
  const { g } = await ids();
  expect([where(g, qMine), where(g, tMine)]).toEqual([
    { chat: qMine, slot: slot["w/b"], use: true },
    { chat: tMine, slot: slot["w/a"], use: true },
  ]);
  expect([q, t].map((id) => g.bots.find((b) => b.id === id)!.target)).toEqual([slot["w/a"], slot["w/b"]]);
}, 30_000);

test("story 379: a batch from the board swapping two Bots' defaults moves both, the chats following them with them; each hears it once", async () => {
  const mark = await followDefaults();
  const { q, t, qMine, tMine, slot } = await ids();
  const r = await act({
    kind: "bind",
    changes: [
      { bot: q, from: slot["w/a"], to: slot["w/b"] },
      { bot: t, from: slot["w/b"], to: slot["w/a"] },
    ],
  });
  expect(r.ok).toBe(true);
  expect(await since(mark)).toEqual({ q: ["这里的消息改交给 w/b。"], t: ["这里的消息改交给 w/a。"] });
  const { g } = await ids();
  expect([q, t].map((id) => g.bots.find((b) => b.id === id)!.target)).toEqual([slot["w/b"], slot["w/a"]]);
  expect([where(g, qMine), where(g, tMine)]).toEqual([
    { chat: qMine, slot: slot["w/b"], use: false },
    { chat: tMine, slot: slot["w/a"], use: false },
  ]);
}, 30_000);

test("story 383: a chat the board puts on its Bot's default slot picks it as its own, no longer following the default; its messages go where they went, so it hears nothing", async () => {
  const mark = await followDefaults();
  const { qMine, slot } = await ids();
  const r = await act({ kind: "bind", changes: [{ chat: qMine, from: { slot: slot["w/a"], use: false }, to: slot["w/a"] }] });
  expect(r.ok).toBe(true);
  expect(where((await ids()).g, qMine)).toEqual({ chat: qMine, slot: slot["w/a"], use: true });
  expect(await since(mark, false)).toEqual({ q: [], t: [] });
}, 30_000);
