// 未读 and 跑完提醒 (spec web-maximize "未读和跑完提醒怎么做"): what the page makes of the event stream's
// turn ends, against fake events, a fake document and a fake Notification; and the dots, rendered to HTML.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { BoardView, SideList } from "../web/src/board";
import { queryClient, seen, type BoardData, type Card } from "../web/src/data";
import { askOnce, remindBy, watch, type Here } from "../web/src/unread";

const g = globalThis as Record<string, unknown>;
/** Sets globalThis's name to value till the test ends. */
const given: [string, PropertyDescriptor | undefined][] = [];
const stub = (name: string, value: unknown) => (given.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]), Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }));

/** The page as watch() asks it, which a test changes; the slots it opened. */
let here: Here;
let opened: string[];
let stop: () => void;
/** The page's document: its title, and what it tells as the page comes in front or goes. */
let doc: EventTarget & { title: string };
/** The counts the app's badge was set to. */
let badges: number[];
/** The notifications shown. */
let shown: FakeNotification[];
/** What this browser's pages keep in localStorage. */
let storage: Map<string, string>;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static asked = 0;
  static throws = false;
  static requestPermission = async () => (FakeNotification.asked++, FakeNotification.permission);
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    if (FakeNotification.throws) throw new TypeError("Illegal constructor");
    shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

const card = (name: string, more: Partial<Card> = {}): Card => ({ id: `w/${name}`, ref: `w/${name}`, name, parent: null, agent: "claude", state: "空闲", lifetime: "longterm", turnEndedAt: Date.now(), archivedAt: null, last: null, bots: [], terminal: null, mode: "headless", activeAt: 0, pinnedAt: null, ...more });
const board = (cards: Card[], running: Card[] = []): BoardData => ({ bots: [], workspaces: [{ name: "w", dir: "/w", groups: { needsYou: [], running, done: cards, idle: [] }, archived: [] }] });

beforeEach(() => {
  here = { chat: "", visible: true, focused: true };
  opened = [];
  badges = [];
  shown = [];
  storage = new Map();
  doc = Object.assign(new EventTarget(), { title: "Rhodium" });
  Object.assign(FakeNotification, { permission: "granted", asked: 0, throws: false });
  stub("document", doc);
  stub("navigator", { setAppBadge: async (n: number) => void badges.push(n) });
  stub("Notification", FakeNotification);
  stub("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  const data = board([card("a", { last: { role: "assistant", text: "改好了，测试都过了。".repeat(10), at: Date.now() } }), card("b"), card("c")]);
  stub("fetch", async () => Response.json(data));
  queryClient.setQueryData(["board"], data);
  stop = watch(
    () => here,
    (slot) => opened.push(slot),
  );
});
afterEach(() => {
  stop();
  queryClient.clear();
  for (const [name, was] of given.splice(0).reverse()) {
    if (was) Object.defineProperty(globalThis, name, was);
    else delete g[name];
  }
});

/** The stream brings an event of the event table; a slot_state in a turn your message on the board began if web. */
const tell = (type: string, slot: string, state?: string, web = false) => seen.forEach((f) => f({ type, slot, trace: null, data: state ? { state, mode: "headless", ...(web && { web }) } : null }));
/** Slot's turn runs and ends: begun by your message on the board; or from IM, its final reply sent there; or by an internal message. */
const turn = (slot: string, by: "web" | "im" | "inside" = "web") => (tell("slot_state", slot, "running", by === "web"), by === "im" && tell("final_reply", slot), tell("slot_state", slot, "idle", by === "web"));
/** What the page heard settles: a reminder fetches the board first. */
const settle = () => new Promise((r) => setTimeout(r, 5));
/** As the page changes: another chat opened, or it comes in front or goes. */
const go = (chat: string) => ((here.chat = chat), dispatchEvent(new Event("hashchange")));
const front = (visible: boolean) => ((here.visible = visible), doc.dispatchEvent(new Event("visibilitychange")));

/** A view rendered as on the page at path, its answers taken from client. */
const render = (view: ReactNode, client = new QueryClient(), path = "/") =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Router hook={useHashLocation} ssrPath={path}>
        {view}
      </Router>
    </QueryClientProvider>,
  );
/** Whether slot's row in html has the unread dot. */
const dot = (html: string, slot: string) => new RegExp(`href="#/slot/${encodeURIComponent(slot)}[^"]*"(?:(?!</a>).)*aria-label="未读"`).test(html);

test("stories 470, 473: a turn ending while its chat is not open marks the slot unread, in the list, the sidebar and the title; opening its chat clears it", () => {
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
  turn("w/b");
  expect(doc.title).toBe("(2) Rhodium");
  const data = queryClient.getQueryData<BoardData>(["board"])!;
  const list = render(<BoardView data={data} />);
  expect([dot(list, "w/a"), dot(list, "w/b"), dot(list, "w/c")]).toEqual([true, true, false]);
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  const side = render(<SideList from="list" />, client, "/slot/w%2Fc");
  expect([dot(side, "w/a"), dot(side, "w/c")]).toEqual([true, false]);

  go("w/a");
  expect(doc.title).toBe("(1) Rhodium");
  expect(dot(render(<BoardView data={data} />), "w/a")).toBe(false);
  // Open while the page is not in front: it clears once the page comes back.
  front(false);
  go("w/b");
  expect(doc.title).toBe("(1) Rhodium");
  front(true);
  expect(doc.title).toBe("Rhodium");
  expect(badges).toEqual([1, 2, 1, 0]);
});

test("story 470: a turn ending with its chat open and the page in front is not unread; with the page hidden, it is", () => {
  go("w/a");
  turn("w/a");
  expect(doc.title).toBe("Rhodium");
  front(false);
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
  // Unread again as it ends again: still one.
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 471: a turn whose final reply went to IM is not unread; the next one, with none, is", () => {
  turn("w/a", "im");
  expect(doc.title).toBe("Rhodium");
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 471: a turn that sent its result to IM with rh send me is neither unread nor reminded of, a question after it or not; the next one, with none, is", async () => {
  front(false);
  tell("slot_state", "w/a", "running");
  tell("send_me", "w/a");
  tell("slot_state", "w/a", "waiting");
  tell("slot_state", "w/a", "running");
  tell("slot_state", "w/a", "idle");
  await settle();
  expect([doc.title, shown.length]).toEqual(["Rhodium", 0]);
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 575: a turn whose rh send stayed on the board (web) is unread all the same, a question after it or not, its final reply in IM or not", () => {
  const web = (slot: string) => seen.forEach((f) => f({ type: "send_me", slot, trace: null, data: { web: true } }));
  tell("slot_state", "w/a", "running");
  web("w/a");
  tell("slot_state", "w/a", "waiting");
  tell("slot_state", "w/a", "running");
  tell("slot_state", "w/a", "idle");
  expect(doc.title).toBe("(1) Rhodium");
  tell("slot_state", "w/b", "running");
  web("w/b");
  tell("final_reply", "w/b");
  tell("slot_state", "w/b", "idle");
  expect(doc.title).toBe("(2) Rhodium");
});

test("story 471: your /compact, a turn of its own on Claude with no reply, is neither unread nor reminded of; the next turn, with none, is", async () => {
  front(false);
  tell("slot_state", "w/a", "running");
  tell("compacted", "w/a");
  tell("slot_state", "w/a", "idle");
  await settle();
  expect([doc.title, shown.length]).toEqual(["Rhodium", 0]);
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 471: an rh send me outside a turn, as a background job's report after it ended, does not keep the next turn from counting", () => {
  tell("slot_state", "w/a", "idle");
  tell("send_me", "w/a");
  turn("w/a");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 470: only a turn the page saw end counts: running to idle, by the stream, or by the board for a slot the stream said nothing of yet", () => {
  // Running on the board as the page opened.
  queryClient.setQueryData(["board"], board([card("c")], [card("a", { state: "运行中" })]));
  tell("slot_state", "w/a", "idle");
  expect(doc.title).toBe("(1) Rhodium");
  // Idle on the board, or not on it: no turn seen.
  tell("slot_state", "w/c", "idle");
  tell("slot_state", "w/x", "idle");
  // Starting and back to idle, as a process brought up for a command; crashed.
  tell("slot_state", "w/b", "starting");
  tell("slot_state", "w/b", "idle");
  tell("slot_state", "w/c", "running");
  tell("slot_state", "w/c", "crashed");
  tell("slot_state", "w/c", "idle");
  expect(doc.title).toBe("(1) Rhodium");
});

test("story 474: a turn ending while the page is hidden or not focused shows a reminder, one per slot: the slot's name, the reply's start; a click opens the slot", async () => {
  turn("w/a");
  await settle();
  expect(shown).toHaveLength(0);

  here.focused = false;
  turn("w/a");
  await settle();
  expect(shown.map((n) => [n.title, n.options])).toEqual([["w/a", { body: `${"改好了，测试都过了。".repeat(6)}…`, tag: "w/a" }]]);
  here.focused = true;
  front(false);
  turn("w/b");
  await settle();
  // No reply on the board's line: no body.
  expect(shown.map((n) => [n.title, n.options])).toEqual([
    ["w/a", { body: `${"改好了，测试都过了。".repeat(6)}…`, tag: "w/a" }],
    ["w/b", { tag: "w/b" }],
  ]);
  shown[0]!.onclick!();
  expect(opened).toEqual(["w/a"]);
  expect(shown[0]!.closed).toBe(true);

  // A final reply to IM: none.
  turn("w/c", "im");
  await settle();
  expect(shown).toHaveLength(2);
});

test("#493: only a turn your message on the board began, on any page, is reminded of: one an internal message began is unread all the same; yours, an internal one running on from it unseen, is", async () => {
  front(false);
  turn("w/a", "inside");
  await settle();
  expect([doc.title, shown.length]).toEqual(["(1) Rhodium", 0]);
  // A report that waited for your turn's end ran on from it: the stream saw the internal one end alone.
  tell("slot_state", "w/b", "running", true);
  tell("slot_state", "w/b", "idle");
  await settle();
  expect(shown.map((n) => n.options.tag)).toEqual(["w/b"]);
});

test("#493: a reminder goes once seen: its chat open with the page in front, or a turn your message on the board began, on any page; not one an internal message began", async () => {
  front(false);
  turn("w/a");
  turn("w/b");
  await settle();
  go("w/a");
  expect(shown.map((n) => n.closed)).toEqual([false, false]);
  front(true);
  expect(shown.map((n) => n.closed)).toEqual([true, false]);
  tell("slot_state", "w/b", "running");
  tell("slot_state", "w/b", "idle");
  expect(shown[1]!.closed).toBe(false);
  tell("slot_state", "w/b", "running", true);
  expect(shown[1]!.closed).toBe(true);
});

test("#493: a slot needing you, as an ask of any turn comes with the page hidden or not focused, is reminded of, 需要你 its body, till the ask is answered or withdrawn; not one whose ask waits for its turn's end, off the board's 需要你", async () => {
  stub("fetch", async () => Response.json({ bots: [], workspaces: [{ name: "w", dir: "/w", groups: { needsYou: [card("a")], running: [card("b", { state: "运行中" })], done: [], idle: [] }, archived: [] }] }));
  tell("ask", "w/a");
  await settle();
  expect(shown).toHaveLength(0);
  front(false);
  tell("ask", "w/a");
  tell("ask", "w/b");
  await settle();
  expect(shown.map((n) => [n.title, n.options])).toEqual([["w/a", { body: "需要你", tag: "w/a" }]]);
  tell("ask_answered", "w/a");
  expect(shown[0]!.closed).toBe(true);
  // Withdrawn unanswered, as by /stop: the slot leaves waiting.
  tell("slot_state", "w/a", "waiting");
  tell("ask", "w/a");
  await settle();
  tell("slot_state", "w/a", "idle");
  expect(shown.map((n) => n.closed)).toEqual([true, true]);
});

test("story 474: no reminder while another of this browser's Rhodium pages is in front, its window focused: you see the turn end there; once that page goes, one", async () => {
  // The other page, a module of its own as in its own tab, hearing the same stream.
  const other = (await import(`../web/src/unread.ts?${"other"}`)) as typeof import("../web/src/unread");
  const there: Here = { chat: "", visible: true, focused: true };
  const stopThere = other.watch(
    () => there,
    () => {},
  );
  try {
    front(false);
    turn("w/a");
    await settle();
    expect(shown).toHaveLength(0);
    // Its window loses the focus: this page reminds, as does that one, of the one notification.
    there.focused = false;
    dispatchEvent(new Event("blur"));
    turn("w/b");
    await settle();
    expect(shown.map((n) => n.options.tag)).toEqual(["w/b", "w/b"]);
    // Back in front, and closed there: this page alone.
    there.focused = true;
    dispatchEvent(new Event("focus"));
    turn("w/c");
    await settle();
    expect(shown).toHaveLength(2);
    dispatchEvent(new Event("pagehide"));
    stopThere();
    turn("w/c");
    await settle();
    expect(shown.map((n) => n.options.tag)).toEqual(["w/b", "w/b", "w/c"]);
  } finally {
    stopThere();
  }
});

test("story 475: no reminder without leave, nor where the browser cannot show one from the page (Android's Chrome)", async () => {
  front(false);
  for (const permission of ["default", "denied"] as const) {
    FakeNotification.permission = permission;
    turn("w/a");
    await settle();
  }
  FakeNotification.permission = "granted";
  FakeNotification.throws = true;
  turn("w/b");
  await settle();
  expect(shown).toHaveLength(0);
  // Unread all the same.
  expect(doc.title).toBe("(2) Rhodium");
});

test("story 475: leave is asked once on this device, at the first send; never again once denied or dismissed; not where the browser cannot show one, nor storage keep that it asked", async () => {
  const stored = new Map<string, string>();
  stub("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
  FakeNotification.permission = "default";
  askOnce();
  // Dismissed: still default, never asked again.
  askOnce();
  expect(FakeNotification.asked).toBe(1);
  // The probe: a browser with no leave yet shows nothing, which the fake does not keep.
  shown.length = 0;

  // Denied, on a device that never asked: not asked.
  stored.clear();
  FakeNotification.permission = "denied";
  askOnce();
  expect(FakeNotification.asked).toBe(1);

  // Android's Chrome: its constructor throws.
  FakeNotification.permission = "default";
  FakeNotification.throws = true;
  askOnce();
  expect(FakeNotification.asked).toBe(1);

  // Storage that cannot be used: it would ask at every send.
  FakeNotification.throws = false;
  stub("localStorage", {
    getItem: () => {
      throw new Error("SecurityError");
    },
  });
  askOnce();
  expect(FakeNotification.asked).toBe(1);
});

test("#491: reminders turned off on this device remind of nothing, a turn's end nor 需要你, and leave is not asked at the first send; turned on with no leave yet, it is asked then, not again at a send", async () => {
  front(false);
  await remindBy(false);
  stub("fetch", async () => Response.json({ bots: [], workspaces: [{ name: "w", dir: "/w", groups: { needsYou: [card("a")], running: [], done: [], idle: [] }, archived: [] }] }));
  turn("w/a");
  tell("ask", "w/a");
  await settle();
  expect(shown).toHaveLength(0);
  FakeNotification.permission = "default";
  askOnce();
  expect(FakeNotification.asked).toBe(0);

  // Dismissed as it is asked: still default, and a send does not ask again.
  expect(await remindBy(true)).toBe("default");
  askOnce();
  expect(FakeNotification.asked).toBe(1);
  FakeNotification.permission = "granted";
  turn("w/a");
  await settle();
  expect(shown.map((n) => n.title)).toEqual(["w/a"]);
});
