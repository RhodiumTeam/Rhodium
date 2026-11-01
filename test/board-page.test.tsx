// The board's page (web/): how it keeps itself live and pages through a conversation, against a fake
// event stream and fake answers, and what it shows for given answers, rendered to HTML. The HTTP
// tests in board.test.ts and build.test.ts cannot see these.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { BoardView, endRoom, facesRoom, keepOf, nextSlot, shrunk, SideList, squeeze, steady, type Row } from "../web/src/board";
import { boardKey, chatAt, clock, dotOf, Max, nextTheme, slotHash, THEME, type KeyLike } from "../web/src/common";
import { Jump, jumpList } from "../web/src/jump";
import { moment } from "../src/panels";
import { builds, Events, follow, heard, json, mayPrefetch, Messages, queryClient, refresh, reloadNow, unread, unsent, type Block, type BoardData, type Card, type MessagesData, type Sent, type SlotData, type SlotEvent } from "../web/src/data";
import { RhodiumView } from "../web/src/rhodium";
import { ahead, behind, ChatView, fullEsc, inTerminal, KEPT_BLOCKS, keepCollapsed, keepTerminalFont, sideCollapsed, sideWidth, SlotPage, terminalFont, visit, visits, type EscKey } from "../web/src/slot";
import { Details, EventRow, look } from "../web/src/details";
import { afterClose, retryIn } from "../web/src/terminal";
import { folded, kindOf } from "../web/src/tools";
import { shortText } from "../src/tool-line";
import { toast } from "../web/src/toast";
import { act, byPage, draft, forAgent, frame, givenBack, keepDraft, keyMode, Toasts } from "../web/src/write";
import { InfoCard, resetsIn, tone } from "../web/src/card";
import type { InfoCard as Info } from "../src/router";
import { answerText } from "../web/src/asks";
import { cut } from "../web/src/terminal";
import { AgentSheet, Answer, matching, ModelSheet } from "../web/src/palette";
import { Face } from "../web/src/faces";

/** The event streams the page opens. A stream the browser gives up on, as the HTML spec has it for
 *  any reply but 200, is CLOSED when its error fires; a dropped one is CONNECTING and retried by the
 *  browser itself. */
let streams: FakeEventSource[];
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  named: Record<string, (e: { data: string }) => void> = {};
  constructor(readonly url: string) {
    streams.push(this);
  }
  addEventListener(name: string, f: (e: { data: string }) => void) {
    this.named[name] = f;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(name?: string, data = "{}") {
    if (name) this.named[name]?.({ data });
    else this.onmessage?.({ data });
  }
  error(forGood: boolean) {
    this.readyState = forGood ? 2 : 0;
    this.onerror?.();
  }
  close() {
    this.readyState = 2;
  }
}

const real = globalThis.EventSource;
beforeEach(() => {
  streams = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  jest.useFakeTimers();
});
afterEach(() => {
  globalThis.EventSource = real;
  jest.useRealTimers();
});

/** The page following the stream, on slot's page if given: how often it fetched afresh, whether it
 *  says it is live, and how often the chat was told its transcript grew; told: all the chat was told. */
function following(slot?: string) {
  const seen = { changes: 0, live: false, grew: 0 };
  const told: [string, string?][] = [];
  const hear = (what: string, text?: string) => (told.push(text === undefined ? [what] : [what, text]), what === "grew" && seen.grew++);
  heard.add(hear);
  const stop = follow(
    () => seen.changes++,
    (on) => (seen.live = on),
    slot,
  );
  return { seen, told, stop: () => (stop(), heard.delete(hear)) };
}

test("story 140: when the browser gives up on the event stream (a 502 while rhodium restarts), the page opens a new one", () => {
  const { seen, stop } = following();
  expect(streams.map((s) => s.url)).toEqual(["api/events"]);
  streams[0]!.open();
  expect(seen).toMatchObject({ changes: 1, live: true });

  // A dropped connection: the browser retries it itself, so no second stream.
  streams[0]!.error(false);
  expect(seen.live).toBe(false);
  jest.advanceTimersByTime(30_000);
  expect(streams).toHaveLength(1);
  streams[0]!.open();

  // A 502: the browser closes the stream for good. The page opens another, which brings it up to date.
  streams[0]!.error(true);
  expect(seen.live).toBe(false);
  jest.advanceTimersByTime(10_000);
  expect(streams).toHaveLength(2);
  expect(streams[1]!.url).toBe("api/events");
  const changes = seen.changes;
  streams[1]!.open();
  expect(seen).toMatchObject({ changes: changes + 1, live: true });

  // And another, should that one get a 502 too.
  streams[1]!.error(true);
  jest.advanceTimersByTime(10_000);
  expect(streams).toHaveLength(3);
  stop();
});

/** The page's location and session storage while fn runs, which tell how often it loaded itself again. */
async function reloading(fn: (reloads: () => number) => Promise<void>) {
  const was = { location: globalThis.location, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
  let n = 0;
  const kept = new Map<string, string>();
  Object.assign(globalThis, {
    location: { reload: () => n++ },
    sessionStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, String(v)) },
  });
  try {
    await fn(() => n);
  } finally {
    Object.assign(globalThis, was);
  }
}

test("ADR-0013: the page's requests say they are its own (X-Requested-With); a 401, which Rhodium never answers, is a login proxy in front whose session ran out: the page loads itself again, which brings its login; not again within 10 s", async () => {
  await reloading(async (reloads) => {
    const sent: Headers[] = [];
    let answer = 200;
    globalThis.fetch = (async (_: string, init: RequestInit) => (sent.push(new Headers(init.headers)), new Response("{}", { status: answer }))) as unknown as typeof fetch;
    expect(await json("api/board")).toEqual({});
    expect(await act({ kind: "rh", argv: ["ws"] })).toEqual({} as never);
    expect(sent.map((h) => h.get("x-requested-with"))).toEqual(["XMLHttpRequest", "XMLHttpRequest"]);
    // Its own headers kept.
    expect(sent[1]!.get("content-type")).toBe("application/json");
    expect(reloads()).toBe(0);
    answer = 401;
    await expect(json("api/board")).rejects.toThrow("401");
    expect(reloads()).toBe(1);
    await expect(json("api/board")).rejects.toThrow("401");
    expect(reloads()).toBe(1);
    jest.advanceTimersByTime(10_000);
    await expect(json("api/board")).rejects.toThrow("401");
    expect(reloads()).toBe(2);
  });
});

test("ADR-0013: a stream the browser gives up on, which cannot say it is the page's nor tell a 401, asks api/ping as the page's own: a 401 loads the page again; else it opens a new stream", async () => {
  await reloading(async (reloads) => {
    const asked: [string, string | null][] = [];
    let answer = 502;
    globalThis.fetch = (async (url: string, init: RequestInit) => (asked.push([url, new Headers(init.headers).get("x-requested-with")]), new Response(null, { status: answer }))) as unknown as typeof fetch;
    const { stop } = following();
    streams[0]!.open();
    // Dropped and retried by the browser: nothing asked.
    streams[0]!.error(false);
    expect(asked).toEqual([]);
    streams[0]!.error(true);
    expect(asked).toEqual([["api/ping", "XMLHttpRequest"]]);
    await Promise.resolve();
    expect(reloads()).toBe(0);
    jest.advanceTimersByTime(3_000);
    expect(streams).toHaveLength(2);
    answer = 401;
    streams[1]!.error(true);
    await new Promise((r) => process.nextTick(r));
    expect(reloads()).toBe(1);
    stop();
  });
});

test("a burst of events brings the page up to date once; the clock, every minute", () => {
  const { seen, stop } = following();
  streams[0]!.open();
  for (let i = 0; i < 5; i++) streams[0]!.message();
  expect(seen.changes).toBe(1);
  jest.advanceTimersByTime(1_000);
  expect(seen.changes).toBe(2);
  // Done turns to idle with no event.
  jest.advanceTimersByTime(59_000);
  expect(seen.changes).toBe(3);
  stop();
  jest.advanceTimersByTime(60_000);
  expect(seen.changes).toBe(3);
});

test("stories 202, 204: on a slot's page the stream follows its transcript: as it grows, only the chat is told, the rest of the page not fetched afresh; so too on a new stream", () => {
  const { seen, stop } = following("S1");
  expect(streams.map((s) => s.url)).toEqual(["api/events?slot=S1"]);
  streams[0]!.open();
  streams[0]!.message("grew");
  streams[0]!.message("grew");
  jest.advanceTimersByTime(1_000);
  expect(seen).toEqual({ changes: 1, live: true, grew: 2 });

  streams[0]!.error(true);
  jest.advanceTimersByTime(10_000);
  expect(streams.map((s) => s.url)).toEqual(["api/events?slot=S1", "api/events?slot=S1"]);
  streams[1]!.message("grew");
  expect(seen.grew).toBe(3);
  stop();
});

test("story 203: on a slot's page the stream tells the chat what the agent writes, that its message is whole and that its process ended, and each time it opens, as it may have missed some", () => {
  const { told, stop } = following("S1");
  streams[0]!.open();
  streams[0]!.message("delta", '{"text":"half **wri"}');
  streams[0]!.message("said");
  streams[0]!.message("exit");
  streams[0]!.error(true);
  jest.advanceTimersByTime(10_000);
  streams[1]!.open();
  expect(told).toEqual([["open"], ["delta", "half **wri"], ["said"], ["exit"], ["open"]]);
  stop();
});

test("#356: each time the stream opens, it says the page rhodium serves, which those listening are told; dropped, the build is not known till it opens again", () => {
  const told: (string | null)[] = [];
  const hear = (entry: string | null) => told.push(entry);
  builds.add(hear);
  const { seen, stop } = following();
  streams[0]!.message("page", '{"entry":"./assets/index-A.js"}');
  streams[0]!.open();
  streams[0]!.error(true);
  jest.advanceTimersByTime(10_000);
  streams[1]!.message("page", '{"entry":"./assets/index-B.js"}');
  expect(told).toEqual(["./assets/index-A.js", null, "./assets/index-B.js"]);
  // Not an event of the event table: the page is not fetched afresh for it.
  jest.advanceTimersByTime(1_000);
  expect(seen.changes).toBe(1);
  stop();
  builds.delete(hear);
});

test("#356: a page whose rhodium serves another build loads itself again as it comes back in front, or loads, with nothing done since and nothing to lose; never within 10 s of the time before, nor twice for one build, nor with either build unknown", () => {
  const now = 1_000_000;
  const you = { back: true, busy: false };
  const never = { at: 0, build: null };
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", you, never, now)).toBe(true);
  expect(reloadNow("./assets/index-A.js", "./assets/index-A.js", you, never, now)).toBe(false);
  expect(reloadNow(null, "./assets/index-B.js", you, never, now)).toBe(false);
  expect(reloadNow("./assets/index-A.js", null, you, never, now)).toBe(false);
  // Reading, or anything done since it came in front: not under you.
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", { ...you, back: false }, never, now)).toBe(false);
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", { ...you, busy: true }, never, now)).toBe(false);
  // Loaded again for B already, and still not B, as from a cache: it stays; another build, once more.
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", you, { at: now - 60_000, build: "./assets/index-B.js" }, now)).toBe(false);
  expect(reloadNow("./assets/index-A.js", "./assets/index-C.js", you, { at: now - 60_000, build: "./assets/index-B.js" }, now)).toBe(true);
  // Loaded again lately for a file that would not load (vite:preloadError): not again so soon.
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", you, { at: now - 9_999, build: null }, now)).toBe(false);
  expect(reloadNow("./assets/index-A.js", "./assets/index-B.js", you, { at: now - 10_000, build: null }, now)).toBe(true);
});

test("#356: the page fetches ahead what you have yet to open, unless the browser saves data", () => {
  expect(mayPrefetch({} as Navigator)).toBe(true);
  expect(mayPrefetch({ connection: { saveData: false } } as unknown as Navigator)).toBe(true);
  expect(mayPrefetch({ connection: { saveData: true } } as unknown as Navigator)).toBe(false);
});

test("story 139: an older board answer that comes back after a newer one does not replace it", async () => {
  jest.useRealTimers();
  const replies: ((board: string) => void)[] = [];
  const board = new QueryObserver(queryClient, { queryKey: ["test-board"], queryFn: () => new Promise<string>((r) => replies.push(r)) });
  const unsubscribe = board.subscribe(() => {});
  replies[0]!("idle");
  await Bun.sleep(1);
  void refresh();
  void refresh();
  expect(replies).toHaveLength(3);
  replies[2]!("needs you");
  await Bun.sleep(1);
  replies[1]!("running");
  await Bun.sleep(1);
  expect(board.getCurrentResult().data).toBe("needs you");
  unsubscribe();
});

/** Slot S1's chat, whose answers from api/messages are pages[what it asks after the slot]; what it
 *  asked, in order. */
function chatOf(pages: Record<string, MessagesData>) {
  const asked: string[] = [];
  const log = new Messages("S1", async (url) => {
    const q = url.replace("api/messages?slot=S1", "");
    asked.push(q);
    return pages[q]!;
  });
  return { log, asked };
}
/** A page of conversation's blocks, each [its line's offset, what the agent said]. */
const page = (conversation: string, start: number, end: number, ...said: [number, string][]): MessagesData => ({
  conversation,
  start,
  end,
  blocks: said.map(([offset, text]) => ({ kind: "assistant", text, at: `${offset}.0`, time: null })),
});
const said = (log: Messages) => log.blocks.map((b) => ("text" in b ? b.text : b.kind));

test("story 200: a slot's chat opens at its newest page, and pages back above it to its first, each block once", async () => {
  const pages = {
    "": page("C1", 100, 200, [150, "newest"]),
    "&before=100": page("C1", 40, 100, [40, "older"], [70, "old"]),
    "&before=40": page("C1", 0, 40, [0, "first"]),
  };
  const { log, asked } = chatOf(pages);
  await log.newer();
  expect(said(log)).toEqual(["newest"]);

  // Scrolling to the top asks twice from the same place.
  await Promise.all([log.older(), log.older()]);
  expect(said(log)).toEqual(["older", "old", "newest"]);
  expect(log.start).toBe(40);

  // The slot has moved on to another conversation: its page does not go above this one's.
  pages["&before=40"] = page("C2", 0, 10, [0, "other"]);
  await log.older();
  expect(said(log)).toEqual(["older", "old", "newest"]);
  expect(log.start).toBe(40);

  pages["&before=40"] = page("C1", 0, 40, [0, "first"]);
  await log.older();
  expect(said(log)).toEqual(["first", "older", "old", "newest"]);
  expect(log.start).toBe(0); // nothing before the conversation's first line
  expect(asked).toEqual(["", "&before=100", "&before=100", "&before=40", "&before=40"]);
});

test("story 200: an event brings the blocks written since, each once, page after page; a new conversation starts the chat over from its newest page", async () => {
  const pages: Record<string, MessagesData> = {
    "": page("C1", 0, 100, [50, "first"]),
    "&after=100": page("C1", 100, 150, [120, "second"]),
    "&after=150": page("C1", 150, 150),
  };
  const { log, asked } = chatOf(pages);
  await log.newer();
  // Two updates ask from the same place.
  await Promise.all([log.newer(), log.newer()]);
  expect(said(log)).toEqual(["first", "second"]);
  expect(log.end).toBe(150);

  // A turn wrote more than a page: the pages come one after another, until one brings nothing new.
  pages["&after=150"] = page("C1", 150, 300, ...Array.from({ length: 20 }, (_, i): [number, string] => [150 + i, `said ${i}`]));
  pages["&after=300"] = page("C1", 300, 310, [300, "last"]);
  pages["&after=310"] = page("C1", 310, 310);
  asked.length = 0;
  await log.newer();
  expect(said(log).slice(-2)).toEqual(["said 19", "last"]);
  expect(asked).toEqual(["&after=150", "&after=300", "&after=310"]);

  // /new: the slot's conversation is another file, read from its end.
  pages["&after=310"] = page("C2", 0, 0);
  pages[""] = page("C2", 0, 30, [10, "fresh"]);
  await log.newer();
  expect(said(log)).toEqual(["fresh"]);
  expect([log.conversation, log.start, log.end]).toEqual(["C2", 0, 30]);
});

test("story 203: what the agent writes is a draft after the blocks, one a message, closed once the message is whole; each thing the agent said the transcript brings takes the place of the first closed one", async () => {
  const pages: Record<string, MessagesData> = {
    "": page("C1", 0, 100, [50, "first"]),
    "&after=100": page("C1", 100, 100),
  };
  const { log } = chatOf(pages);
  await log.newer();
  log.wrote("said"); // the end of a message whose text came before the stream
  log.wrote("delta", "sec");
  log.wrote("delta", "ond");
  log.wrote("said");
  log.wrote("delta", "thi");
  expect(log.drafts).toEqual([
    { text: "second", whole: true },
    { text: "thi", whole: false },
  ]);

  // The transcript brings what you said, then the second; the third is not whole yet.
  pages["&after=100"] = { conversation: "C1", start: 100, end: 160, blocks: [words(100, "user"), { kind: "assistant", text: "second", at: "140.0", time: null }] };
  pages["&after=160"] = page("C1", 160, 160);
  await log.newer();
  expect(said(log)).toEqual(["first", "go", "second"]);
  expect(log.drafts).toEqual([{ text: "thi", whole: false }]);
  pages["&after=160"] = page("C1", 160, 200, [170, "third"]);
  pages["&after=200"] = page("C1", 200, 200);
  await log.newer();
  expect(log.drafts).toEqual([{ text: "thi", whole: false }]);

  // The stream opened again: what it said while down is lost, and the transcript has it.
  log.wrote("open");
  expect(log.drafts).toEqual([]);

  // What it writes before the chat's first page comes: a whole draft may be on that page, so only the
  // one not whole stays.
  const fresh = chatOf({ "": page("C1", 0, 230, [210, "fourth"]) }).log;
  fresh.wrote("delta", "fourth");
  fresh.wrote("said");
  fresh.wrote("delta", "fif");
  await fresh.newer();
  expect(fresh.drafts).toEqual([{ text: "fif", whole: false }]);
});

test("story 203: the agent's process ends mid-message (rh stop, the emergency stop, /new, a crash): the draft not whole goes, as the next process writes anew; the slot moves to another conversation: all go", async () => {
  const pages: Record<string, MessagesData> = { "": page("C1", 0, 100, [50, "first"]), "&after=100": page("C1", 100, 100) };
  const { log } = chatOf(pages);
  await log.newer();
  log.wrote("delta", "whole");
  log.wrote("said");
  log.wrote("delta", "half");
  log.wrote("exit");
  expect(log.drafts).toEqual([{ text: "whole", whole: true }]);
  log.wrote("exit");
  expect(log.drafts).toEqual([{ text: "whole", whole: true }]);
  log.wrote("delta", "again");
  expect(log.drafts).toEqual([
    { text: "whole", whole: true },
    { text: "again", whole: false },
  ]);

  // /new while it writes: what it wrote was of the conversation left.
  pages["&after=100"] = page("C2", 0, 0);
  pages[""] = page("C2", 0, 0);
  await log.newer();
  expect([log.conversation, log.drafts]).toEqual(["C2", []]);
});

/** A tool call's block at offset, as Claude's: its result text, or null for none yet. */
const call = (offset: number, name: string, result: string | null = "ok", time: number | null = null): Block => ({
  kind: "tool",
  id: `c${offset}`,
  name,
  input: "{}",
  shown: { name, arg: null, code: false },
  result: result === null ? null : { at: `${offset + 1}.0`, time, text: result, error: false },
  at: `${offset}.0`,
  time,
});
const words = (offset: number, kind: "user" | "assistant" | "thinking" = "assistant"): Block =>
  kind === "user" ? { kind, text: "go", source: null, from: null, at: `${offset}.0`, time: null } : { kind, text: "…", at: `${offset}.0`, time: null };
/** What the chat shows for blocks: a fold as its line and what it holds, a call running by its id. */
const view = (blocks: Block[]) =>
  folded(blocks).map((s) =>
    s.kind === "fold" ? ["fold", shortText(s.line), s.steps.map((b) => (b.kind === "tool" ? b.name : b.kind))] : s.kind === "running" ? ["running", s.tool.id] : [s.kind],
  );

test("story 196: the tool calls and thoughts between two things said are one fold, its line as QQ's: runs as ×N, at most 4, not TodoWrite and the like", () => {
  const blocks = [words(0, "user"), call(1, "Read"), call(3, "Read"), call(5, "TodoWrite"), words(7, "thinking"), call(8, "Bash"), call(10, "Edit"), call(12, "Grep"), call(14, "Glob"), call(16, "Grep"), words(18)];
  expect(view(blocks)).toEqual([
    ["user"],
    ["fold", "Read ×2、Bash、Edit、Grep，另外 2 次", ["Read", "Read", "TodoWrite", "thinking", "Bash", "Edit", "Grep", "Glob", "Grep"]],
    ["assistant"],
  ]);
  // A system line between ends a fold. One with nothing but thoughts, or calls kept out of the line, names those.
  expect(view([words(0, "thinking"), { kind: "system", title: "压缩了对话", text: "", at: "1.0", time: null }, call(2, "TodoWrite"), words(4, "thinking"), words(5)])).toEqual([
    ["fold", "思考", ["thinking"]],
    ["system"],
    ["fold", "TodoWrite、思考", ["TodoWrite", "thinking"]],
    ["assistant"],
  ]);
});

test("stories 196, 200: a result whose call is on another page goes with it by id, once both are there", () => {
  const result: Block = { kind: "result", id: "c1", text: "done", error: false, at: "2.0", time: null };
  // The newest page begins with the result: it shows once its call does.
  expect(view([result, words(3)])).toEqual([["assistant"]]);
  const blocks = [words(0, "user"), call(1, "Bash", null), result, words(3)];
  expect(view(blocks)).toEqual([["user"], ["fold", "Bash", ["Bash"]], ["assistant"]]);
  expect((folded(blocks)[1] as { steps: { result: unknown }[] }).steps[0]!.result).toEqual({ text: "done", error: false, at: "2.0", time: null });
});

test("story 199: a call with no result yet at the end is running, on its own; parallel calls run until each has its result", () => {
  expect(view([words(0, "user"), call(1, "Read"), call(3, "Bash", null)])).toEqual([["user"], ["fold", "Read", ["Read"]], ["running", "c3"]]);
  // Called together: the first is still running when the second is done.
  expect(view([words(0, "thinking"), call(1, "Agent", null), call(2, "Agent", null)])).toEqual([["fold", "思考", ["thinking"]], ["running", "c1"], ["running", "c2"]]);
  expect(view([call(1, "Agent", null), call(2, "Agent")])).toEqual([["fold", "Agent", ["Agent"]], ["running", "c1"]]);
  // Something after it: it is not running, though it has no result, as when its turn was cut short.
  expect(view([call(1, "Bash", null), words(3)])).toEqual([["fold", "Bash", ["Bash"]], ["assistant"]]);
});

/** A view rendered as on the page at path, its answers taken from client. */
const render = (view: ReactNode, client = new QueryClient(), path = "/") =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Router hook={useHashLocation} ssrPath={path}>
        {view}
      </Router>
    </QueryClientProvider>,
  );
/** What a view shows, as text. */
const shown = (view: ReactNode) => render(view).replace(/<[^>]+>/g, " ");

/** Slot name in workspace w, idle, never active, with no last line. */
const card = (o: Partial<Card> & { name: string }, w = "w"): Card => ({
  id: `${w}/${o.name}`,
  ref: `${w}/${o.name}`,
  parent: null,
  agent: "claude",
  state: "空闲",
  lifetime: "longterm",
  turnEndedAt: null,
  archivedAt: null,
  last: null,
  bots: [],
  terminal: null,
  mode: "headless",
  activeAt: 0,
  pinnedAt: null,
  ...o,
});
type Groups = BoardData["workspaces"][number]["groups"];
const ws = (name: string, groups: Partial<Groups>, archived: Card[] = []): BoardData["workspaces"][number] => ({
  name,
  dir: `/home/${name}`,
  groups: { needsYou: [], running: [], done: [], idle: [], ...groups },
  archived,
});
const boardWith = (groups: Partial<Groups>, archived: Card[] = []): BoardData => ({ bots: [], workspaces: [ws("w", groups, archived)] });
/** What a view shows, as text with no spaces: the order things come in. */
const flat = (view: ReactNode) => shown(view).replace(/\s+/g, "");
const ago = (minutes: number) => Date.now() - minutes * 60_000;

test("stories 139, 146: the slots that need you are in one card on top by their full names; a workspace with more slots has a card of its own under its name, those with one share a card by full names, those with none are not there; archived ones are one fold at the bottom; no paths", () => {
  const data: BoardData = {
    bots: [],
    workspaces: [
      ws("a", { idle: [card({ name: "one", activeAt: ago(60) }, "a")] }),
      ws("b", { needsYou: [card({ name: "ask", state: "需要你" }, "b")], running: [card({ name: "work", state: "运行中", activeAt: ago(1) }, "b")], idle: [card({ name: "rest" }, "b")] }),
      ws("c", { done: [card({ name: "solo", turnEndedAt: ago(2), activeAt: ago(2) }, "c")] }),
      ws("d", { needsYou: [card({ name: "fell", state: "崩溃" }, "d")] }),
      ws("gone", {}, [card({ name: "old", archivedAt: ago(60) }, "gone")]),
    ],
  };
  // b's card first, the latest active; then the one c/solo and a/one share, the latest first.
  expect(flat(<BoardView data={data} />)).toBe("b/ask需要你d/fell崩溃bwork运行中restc/solo2分钟前结束a/one1小时前已归档1");
  expect(shown(<BoardView data={data} />)).not.toContain("/home/");
  expect(flat(<BoardView data={{ bots: [], workspaces: [ws("gone", {}, [card({ name: "old", archivedAt: 0 }, "gone")])] }} />)).toBe("没有在用的槽位。已归档1");
});

/** The board's cards, as layout() has them: what needs you, what is pinned, then each card, a
 *  workspace's after its name and a colon, and the archived; each row by the name it shows, a child's
 *  after a space for each step in. */
const cardsOf = (data: BoardData) => {
  const { needs, pinned, cards, archived } = steady(null, data);
  const names = (rows: Row[]) => rows.map((r) => " ".repeat(r.depth) + (r.full ? r.c.ref : r.c.name));
  return [names(needs), names(pinned), ...cards.map((x) => (x.name ? [`${x.name}:`, ...names(x.rows)] : names(x.rows))), names(archived)];
};

test("#506: blocks go by their latest activity, the latest first: a workspace with two or more top-level slots under its name, each other slot's tree by full names, those side by side sharing a card; in a block no running first, the latest first; what needs you counts for none", () => {
  const data: BoardData = {
    bots: [],
    workspaces: [
      ws("b", { done: [card({ name: "draft", turnEndedAt: ago(10), activeAt: ago(10) }, "b")] }),
      ws("d", { idle: [card({ name: "main", activeAt: ago(9 * 1440) }, "d")] }),
      ws("h", { needsYou: [card({ name: "dns", state: "需要你", activeAt: ago(0) }, "h")], idle: [card({ name: "backup", activeAt: ago(5 * 1440) }, "h")] }),
      ws("k", { idle: [card({ name: "solo", activeAt: ago(60) }, "k")] }),
      ws("q", { idle: [card({ name: "bot", activeAt: ago(15) }, "q")] }),
      ws("r", { running: [card({ name: "main", state: "运行中", activeAt: ago(30) }, "r")], done: [card({ name: "web", turnEndedAt: ago(20), activeAt: ago(20) }, "r")], idle: [card({ name: "docs", activeAt: ago(3 * 1440) }, "r")] }),
    ],
  };
  expect(cardsOf(data)).toEqual([["h/dns"], [], ["b/draft", "q/bot"], ["r:", "web", "main", "docs"], ["k/solo"], ["h:", "backup"], ["d/main"], []]);
});

test("#506: 置顶 is under 需要你, each pinned tree by when it was pinned, the first on top, by full names; one that needs you is in 需要你, its children staying in 置顶; what is pinned counts for no block. A heading with a pin, on the board and in the sidebar", () => {
  const data: BoardData = {
    bots: [],
    workspaces: [
      ws("b", { idle: [card({ name: "draft", activeAt: ago(10) }, "b")] }),
      ws("h", {
        needsYou: [card({ name: "dns", state: "需要你", pinnedAt: 1 }, "h")],
        idle: [card({ name: "probe", parent: "h/dns", activeAt: ago(2) }, "h"), card({ name: "x", pinnedAt: 3 }, "h"), card({ name: "other", activeAt: ago(600) }, "h")],
      }),
      ws("r", { idle: [card({ name: "main", pinnedAt: 2, activeAt: ago(300) }, "r"), card({ name: "kid", parent: "r/main", activeAt: ago(1) }, "r"), card({ name: "docs", activeAt: ago(60) }, "r"), card({ name: "web", activeAt: ago(30) }, "r")] }),
    ],
  };
  expect(cardsOf(data)).toEqual([["h/dns"], ["h/probe", "r/main", " kid", "h/x"], ["b/draft"], ["r:", "web", "docs"], ["h:", "other"], []]);
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  for (const html of [render(<BoardView data={data} />), render(<SideList from="list" />, client)]) {
    expect(html.match(/aria-label="置顶"/g)).toHaveLength(1);
    expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).toContain("h/dns需要你h/probe2分钟前r/main5小时前kid1分钟前h/xb/draft10分钟前");
  }
});

test("#506: a child in another workspace is under its parent by its full name, in its parent's workspace's card or the card its parent shares", () => {
  const data: BoardData = {
    bots: [],
    workspaces: [
      ws("h", { idle: [card({ name: "backup", parent: "r/main", activeAt: ago(5) }, "h"), card({ name: "dns", activeAt: ago(60) }, "h"), card({ name: "up", activeAt: ago(70) }, "h")] }),
      ws("r", { idle: [card({ name: "main", activeAt: ago(40) }, "r"), card({ name: "docs", activeAt: ago(50) }, "r")] }),
      ws("s", { idle: [card({ name: "solo", activeAt: ago(90) }, "s")] }),
      ws("t", { idle: [card({ name: "kid", parent: "s/solo", activeAt: ago(95) }, "t")] }),
    ],
  };
  expect(cardsOf(data)).toEqual([[], [], ["r:", "main", " h/backup", "docs"], ["h:", "dns", "up"], ["s/solo", " t/kid"], []]);
});

test("story 97: a child slot is right under its parent, indented, by its own name; one whose parent needs you stands alone", () => {
  const data = boardWith({
    needsYou: [card({ name: "boss", state: "需要你" })],
    running: [card({ name: "main", state: "运行中" }), card({ name: "kid", parent: "w/main", state: "运行中" }), card({ name: "orphan", parent: "w/boss", state: "运行中" })],
    idle: [card({ name: "other", last: { role: "assistant", text: "late", at: ago(0) } }), card({ name: "grandkid", parent: "w/kid" })],
  });
  const html = render(<BoardView data={data} />);
  expect(flat(<BoardView data={data} />)).toBe("w/boss需要你wmain运行中kid运行中grandkidorphan运行中otherlate");
  for (const [name, depth] of [["main", 0], ["kid", 1], ["grandkid", 2], ["orphan", 0]] as const) {
    expect(html).toMatch(new RegExp(`<div style="--d:${depth}"[^>]*><a[^>]*href="#/slot/w%2F${name}"`));
  }
  // In the shared card, a child of the same workspace goes by its own name, of another by its full one.
  const shared: BoardData = {
    bots: [],
    workspaces: [ws("d", { done: [card({ name: "main", turnEndedAt: ago(1) }, "d"), card({ name: "k1", parent: "d/main" }, "d")] }), ws("e", { idle: [card({ name: "k2", parent: "d/main" }, "e")] })],
  };
  expect(flat(<BoardView data={shared} />)).toBe("d/main1分钟前结束k1e/k2");
});

test("#209: each slot says its state in a word, and under it the last thing said, yours after 你：; one running but not in a turn says why there", () => {
  const data = boardWith({
    needsYou: [card({ name: "ask", state: "需要你", last: { role: "assistant", text: "部署到哪？", at: ago(1) } }), card({ name: "tui", state: "没能切回无头" })],
    running: [card({ name: "go", state: "运行中", activeAt: ago(1), last: { role: "user", text: "跑一下测试", at: ago(1) } }), card({ name: "wait", state: "等额度，预计 18:40 恢复", activeAt: ago(5) })],
    done: [card({ name: "fin", turnEndedAt: ago(18), activeAt: ago(18), last: { role: "assistant", text: "改好了", at: ago(18) } })],
    idle: [card({ name: "rest", activeAt: ago(60 * 25), last: { role: "assistant", text: "好的", at: ago(60 * 25) } })],
  });
  expect(flat(<BoardView data={data} />)).toBe("w/ask需要你部署到哪？w/tui需要你没能切回无头wgo运行中你：跑一下测试wait运行中等额度，预计18:40恢复fin18分钟前结束改好了rest昨天好的");
});

test("#209: a message a slot or Rhodium sent the agent, as a child's report, is not put after 你：", () => {
  const said = (name: string, source: string, text: string, at: number) => card({ name, activeAt: ago(at), last: { role: "user", text, at: ago(at), source } });
  const data = boardWith({ idle: [said("a", "Rhodium：子槽位汇报", "做完了", 1), said("b", "槽位 w/a，经 rh send", "看看", 2), said("c", "用户的终端，经 rh send", "嗯", 3)] });
  expect(flat(<BoardView data={data} />)).toBe("wa1分钟前做完了b2分钟前看看c3分钟前你：嗯");
});

test("#209: a workspace's card folded on this device stays folded, its name and how many slots it has left; storage that cannot be used folds none", () => {
  const data = boardWith({ running: [card({ name: "main", state: "运行中" })], idle: [card({ name: "side" })] });
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map([["folded:w", "1"]]);
  const storage = (getItem: (k: string) => string | null) => Object.defineProperty(globalThis, "localStorage", { value: { getItem }, configurable: true });
  try {
    storage((k) => stored.get(k) ?? null);
    expect(flat(<BoardView data={data} />)).toBe("w2");
    storage(() => {
      throw new Error("SecurityError");
    });
    expect(flat(<BoardView data={data} />)).toBe("wmain运行中side");
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("#206: a slot shows its agent by its logo, named for screen readers, not in words; one with none yet by its initial", () => {
  const html = render(<BoardView data={boardWith({ running: [card({ name: "c" }), card({ name: "p", agent: "pi" }), card({ name: "x", agent: "codex" })], idle: [card({ name: "none", agent: null })] })} />);
  expect(html.match(/<svg[^>]*role="img"[^>]*aria-label="Claude"/g)).toHaveLength(1);
  expect(html.match(/<svg[^>]*role="img"[^>]*aria-label="pi"/g)).toHaveLength(1);
  // Story 485: OpenAI's mark in the text's colour, which reads on dark too, loaded apart from the first screen.
  expect(html.match(/<span role="img" aria-label="Codex CLI" class="[^"]*bg-current[^"]*" style="mask:url\(\/openai.svg\) center \/ contain no-repeat"/g)).toHaveLength(1);
  expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/用 (claude|Claude|pi)/);
  expect(html).toMatch(/>N<\/span>/);
});

/** A text of n letters each px wide, a cut keeping keep of them before its "…", ell px. */
const letters = (n: number, keep = Math.min(3, n), each = 10, ell = 10) => ({ w: (k: number) => k * each, n, keep, ell });
const none = () => 0;

test("story 433: out of room, a full name's workspace gives way first, down to three letters and the \"…\", its box as wide as what shows; then the slot's own name", () => {
  // Letters 10px wide, the "/" 5px, the name 80px, the "…" 10px; no Bots.
  const name = letters(8, 8);
  expect(squeeze(300, letters(10), 5, name, none, 0)).toEqual({});
  // 65px left for the workspace: five letters and the "…", no gap before the "/".
  expect(squeeze(150, letters(10), 5, name, none, 0)).toEqual({ ws: 60 });
  // Less than three letters' room: three letters and the "…", the name gets the rest.
  expect(squeeze(100, letters(10), 5, name, none, 0)).toEqual({ ws: 40, name: 55 });
  // Three letters, or four that the "…" would make wider, are never cut.
  expect(squeeze(100, letters(3), 5, name, none, 0)).toEqual({ name: 65 });
  expect(squeeze(100, letters(4, 3, 10, 15), 5, name, none, 0)).toEqual({ name: 55 });
  // Widths in fractions of a pixel: the workspace's box rounds up, so the "…" fits; the name's down.
  expect(squeeze(100.5, letters(6, 3, 15.5, 15.5), 5, name, none, 0)).toEqual({ ws: 62, name: 33 });
});

test("story 439: out of room, the name gives way before the Bots after it: its workspace to three letters, its own name to some 6 letters, then fewer faces, the +N growing, then none at all", () => {
  // Rhodium/web-terminal, 10px letters, with two Bots' 18px faces after it: 46px.
  const faces = (k: number) => facesRoom(k, 2, 18);
  const at = (room: number) => squeeze(room, letters(7), 5, letters(12, keepOf("web-terminal")), faces, 2);
  expect(at(241)).toEqual({});
  // The workspace down to its least, then the own name, cut at a letter.
  expect(at(200)).toEqual({ ws: 40, name: 100 });
  // As in the sidebar at 288px with 需要你: the own name keeps 6 letters, a face gives way to a +1.
  expect(at(160)).toEqual({ ws: 40, name: 70, faces: 1 });
  expect(at(140)).toEqual({ ws: 40, name: 70, faces: 0 });
  // Not even the +2 fits: no faces at all, the own name has the rest.
  expect(at(120)).toEqual({ ws: 40, name: 75, faces: -1 });
  // A name of 7 letters or fewer is never cut: the faces give way right after the workspace.
  expect(squeeze(100, letters(7), 5, letters(3, keepOf("dev")), faces, 2)).toEqual({ ws: 40, faces: 0 });
  // One Bot: its face, 24px, or nothing, never a lone +1 (20px) that does not say which.
  const one = (room: number) => squeeze(room, letters(7), 5, letters(12, keepOf("web-terminal")), (k) => facesRoom(k, 1, 18), 1);
  expect(one(140)).toEqual({ ws: 40, name: 70 });
  expect(one(136)).toEqual({ ws: 40, name: 91, faces: -1 });
});

test("story 439: a cut name keeps some 6 letters, 4 Chinese characters; one of 7 or fewer keeps all", () => {
  expect(["web-terminal", "homehelp", "abcdefg", "研究所里很长很长的", "研究所", "ab研究所里很长"].map(keepOf)).toEqual([6, 6, 7, 4, 3, 4]);
});

test("story 438: Bots' faces take after a name 6px and 4px between, 18px each in two lines, 24px in one; at most 3, then a +N", () => {
  expect([facesRoom(2, 2, 18), facesRoom(3, 3, 24), facesRoom(3, 5, 24), facesRoom(0, 2, 18), facesRoom(-1, 2, 18), facesRoom(0, 0, 18)]).toEqual([46, 88, 106, 20, 0, 0]);
});

const bot = (id: string, name: string, platform: "qq" | "telegram", avatar: string | null = null) => ({ id, name, platform, avatar });

test("stories 437, 438: after a slot's name, in its order, the Bots whose chats land there: at most 3 then +N, each named when pointed at and to a screen reader; the state still last", () => {
  const data: BoardData = {
    bots: [bot("q", "QQ 主号", "qq", "api/avatar?id=q&v=1"), bot("t", "电报", "telegram"), bot("a", "A", "qq"), bot("b", "B", "qq"), bot("c", "C", "qq")],
    workspaces: [ws("w", { running: [card({ name: "two", state: "运行中", bots: ["q", "t"] }), card({ name: "five", state: "运行中", bots: ["q", "t", "a", "b", "c"] })], idle: [card({ name: "none" })] }, [card({ name: "old", archivedAt: ago(9), bots: ["t"] })])],
  };
  const html = render(<BoardView data={data} />);
  const faces = (name: string) => [...new RegExp(`href="#/slot/w%2F${name}".*?</a>`).exec(html)![0].matchAll(/role="img" aria-label="([^"]+)" title="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  expect(faces("two")).toEqual([["QQ 主号", "QQ 主号"], ["电报", "电报"]]);
  expect(faces("five")).toEqual([["QQ 主号", "QQ 主号"], ["电报", "电报"], ["A", "A"], ["B、C", "B、C"]]);
  expect(faces("none")).toEqual([]);
  expect(flat(<BoardView data={data} />)).toContain("five+2运行中");
  // A thin edge round the avatar; its mark ringed in the row's ground, not white.
  const two = new RegExp(`href="#/slot/w%2Ftwo".*?</a>`).exec(html)![0];
  expect(two).toMatch(/<img [^>]*class="[^"]*ring-1/);
  expect(two).toMatch(/<svg[^>]*aria-label="QQ"[^>]*class="[^"]*ring-\(--row\)/);
  expect(two).not.toContain("ring-white");
  // One line a slot: the name's column wider by the most faces any row has, three and a +2 at 24px.
  expect(html).toContain("--bw:106px");
  expect(render(<BoardView data={boardWith({ idle: [card({ name: "a" })] })} />)).toContain("--bw:0px");
  // In the sidebar too, after the name.
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  expect(render(<SideList from="list" />, client).replace(/<[^>]+>/g, "").replace(/\s+/g, "")).toContain("five+2运行中");
});

test("#255: beside a slot's chat on a wide screen, the list marks that slot's row", () => {
  const data = boardWith({ idle: [card({ name: "a" }), card({ name: "b" })] });
  const rows = (path: string) => render(<BoardView data={data} />, undefined, path).match(/<a [^>]*>/g)!;
  const open = rows("/slot/w%2Fb").filter((a) => a.includes('aria-current="page"'));
  expect(open).toHaveLength(1);
  expect(open[0]).toContain('href="#/slot/w%2Fb"');
  // Its ground the accent, not only under the pointer.
  expect(open[0]).toMatch(/class="[^"]* \[--row:var\(--accent\)\]/);
  expect(rows("/").filter((a) => a.includes("aria-current"))).toEqual([]);
});

test("stories 423, 427, 428: maximize mode's sidebar has no title nor the board's header: 新建槽位, 跳转 with its key and 导入 on top, then the board's slots in its order with no cards; a done one's time has no 结束", () => {
  const data: BoardData = {
    workspaces: [
      ws("a", { idle: [card({ name: "one", activeAt: ago(60) }, "a")] }),
      ws("b", { needsYou: [card({ name: "ask", state: "需要你" }, "b")], running: [card({ name: "work", state: "运行中", activeAt: ago(1) }, "b")], idle: [card({ name: "rest" }, "b")] }),
      ws("c", { done: [card({ name: "solo", turnEndedAt: ago(2), activeAt: ago(2) }, "c")] }),
      ws("d", { needsYou: [card({ name: "fell", state: "崩溃" }, "d")] }),
      ws("gone", {}, [card({ name: "old", archivedAt: ago(60) }, "gone")]),
    ],
    bots: [],
  };
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  const html = render(<SideList from="list" />, client, "/slot/b%2Fwork");
  expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).toBe("新建槽位跳转Ctrl+K导入b/ask需要你d/fell崩溃bwork运行中restc/solo2分钟前a/one1小时前已归档1");
  for (const s of ["列表", "拓扑图", "Rhodium"]) expect(html).not.toContain(s);
  expect(html).not.toMatch(/rounded-\[18px\]/); // no card
  // Each row opens its slot in maximize mode, from where the mode came; the open one is marked.
  const open = html.match(/<a [^>]*aria-current="page"[^>]*>/g)!;
  expect(open).toHaveLength(1);
  expect(open[0]).toContain('href="#/slot/b%2Fwork?full"');
  expect(render(<SideList from="topology" />, client, "/topology/slot/b%2Fwork")).toContain('href="#/topology/slot/c%2Fsolo?chat&amp;full"');
});

test("story 428: in the sidebar a workspace's slots are a little in under its tab, a child 16px further in under its parent", () => {
  const client = new QueryClient();
  client.setQueryData(["board"], boardWith({ running: [card({ name: "main", state: "运行中" }), card({ name: "kid", parent: "w/main", state: "运行中" })], idle: [card({ name: "other" }), card({ name: "grandkid", parent: "w/kid" })] }));
  const html = render(<SideList from="list" />, client);
  const pad = (name: string) => Number(new RegExp(`<a [^>]*href="#/slot/w%2F${name}\\?full"[^>]*style="padding-left:(\\d+)px`).exec(html)?.[1]);
  expect([pad("kid") - pad("main"), pad("grandkid") - pad("kid"), pad("other") - pad("main")]).toEqual([16, 16, 0]);
});

test("story 425: the sidebar's buttons shrink to a row of icons once scrolled past 87px and grow back only at the top; a list that scrolls at all gets room at its end to scroll past 87px, one that does not none", () => {
  expect([shrunk(false, 0), shrunk(false, 40), shrunk(false, 86), shrunk(false, 87), shrunk(false, 100)]).toEqual([false, false, false, true, true]);
  // Shrunk, scrolling to and fro keeps them so, till the very top.
  expect([shrunk(true, 100), shrunk(true, 40), shrunk(true, 1), shrunk(true, 0)]).toEqual([true, true, true, false]);
  // By how far the list scrolls without it: to 88px, a pixel to spare for a scroll position not whole.
  expect([endRoom(-20), endRoom(0), endRoom(1), endRoom(30), endRoom(88), endRoom(500)]).toEqual([0, 0, 87, 58, 0, 0]);
});

test("story 434: while the mouse is on a list, its cards and rows keep the order they had as it came, each as it is now; one new waits, one gone goes; once it leaves, the data's order", () => {
  const was: BoardData = {
    bots: [],
    workspaces: [
      ws("a", { idle: [card({ name: "a1", activeAt: ago(30) }, "a"), card({ name: "a2", activeAt: ago(40) }, "a")] }),
      ws("b", { running: [card({ name: "b1", state: "运行中", activeAt: ago(5) }, "b")], idle: [card({ name: "b2", activeAt: ago(50) }, "b")] }),
      ws("c", { idle: [card({ name: "c1", activeAt: ago(60) }, "c")] }),
    ],
  };
  // a2 runs, b2 needs you, b1 is gone and a3 is new.
  const now: BoardData = {
    bots: [],
    workspaces: [
      ws("a", { running: [card({ name: "a2", state: "运行中", activeAt: ago(0), last: { role: "assistant", text: "go", at: ago(0) } }, "a")], idle: [card({ name: "a1", activeAt: ago(30) }, "a"), card({ name: "a3" }, "a")] }),
      ws("b", { needsYou: [card({ name: "b2", state: "需要你" }, "b")] }),
      ws("c", { idle: [card({ name: "c1", activeAt: ago(60) }, "c")] }),
    ],
  };
  const seq = ({ needs, pinned, cards, archived }: ReturnType<typeof steady>) =>
    [needs, pinned, ...cards.map((x) => x.rows), archived].map((rows) => rows.map((r) => `${r.c.name}:${r.kind}${r.c.last ? `:${r.c.last.text}` : ""}`).join(" "));
  expect(seq(steady(null, was))).toEqual(["", "", "b1:running b2:idle", "a1:idle a2:idle", "c1:idle", ""]);
  expect(seq(steady(was, now))).toEqual(["", "", "b2:needs", "a1:idle a2:running:go", "c1:idle", ""]);
  expect(seq(steady(null, now))).toEqual(["b2:needs", "", "a2:running:go a1:idle a3:idle", "c1:idle", ""]);
});

/** Runs f with workspace names folded on this device. */
function foldedHere(names: string[], f: () => void) {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => (names.some((n) => k === `folded:${n}`) ? "1" : null) }, configurable: true });
  try {
    f();
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test("story 435: the open slot's row shows under its workspace's name folded, and under 已归档 folded, on the board and in the sidebar; no other row does", () => {
  const data = boardWith({ running: [card({ name: "main", state: "运行中" })], idle: [card({ name: "side" })] }, [card({ name: "old" })]);
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  const marked = (html: string) => html.match(/<a [^>]*aria-current="page"[^>]*>/g) ?? [];
  foldedHere(["w"], () => {
    expect(text(render(<BoardView data={data} />))).toBe("w2已归档1");
    const side = render(<BoardView data={data} />, undefined, "/slot/w%2Fside");
    expect(text(side)).toBe("w2side已归档1");
    expect(marked(side)).toHaveLength(1);
    expect(marked(side)[0]).toContain('href="#/slot/w%2Fside"');
    expect(text(render(<BoardView data={data} />, undefined, "/slot/w%2Fold"))).toBe("w2已归档1w/old");

    expect(text(render(<SideList from="list" />, client, "/slot/w%2Fside?full"))).toBe("新建槽位跳转Ctrl+K导入w2side已归档1");
    expect(text(render(<SideList from="topology" />, client, "/topology/slot/w%2Fold?chat&full"))).toBe("新建槽位跳转Ctrl+K导入w2已归档1w/old");
    expect(marked(render(<SideList from="list" />, client, "/slot/w%2Fold?full"))[0]).toContain('href="#/slot/w%2Fold?full"');
  });
});

test("story 436: a folded workspace with a slot running has a blue dot before how many slots it has, read out as 有在运行的, on the board and in the sidebar; one with none running, or unfolded, has none", () => {
  const client = new QueryClient();
  const dot = /aria-label="有在运行的"[^>]*><\/span>2<\/span>/;
  const views = (data: BoardData) => (client.setQueryData(["board"], data), [render(<BoardView data={data} />), render(<SideList from="list" />, client)]);
  const runs = boardWith({ running: [card({ name: "main", state: "运行中" })], idle: [card({ name: "side" })] });
  const rests = boardWith({ idle: [card({ name: "main" }), card({ name: "side" })] });
  foldedHere(["w"], () => {
    for (const html of views(runs)) expect(html).toMatch(dot);
    for (const html of views(rests)) expect(html).not.toContain("有在运行的");
  });
  for (const html of views(runs)) expect(html).not.toContain("有在运行的");
});

test("stories 415, 449: on a wide screen the chat's top bar has 放大, and 缩小 in its place in maximize mode; on a phone neither", () => {
  const bar = (max: { from: "list" | "topology"; full: boolean } | null) => render(<Max.Provider value={max && { ...max, collapsed: false, toggle() {} }}><ChatView d={slot()} log={chat()} live /></Max.Provider>);
  expect(bar({ from: "list", full: false })).toContain('aria-label="放大"');
  expect(bar({ from: "topology", full: true })).toContain('aria-label="缩小"');
  expect(bar({ from: "list", full: true })).not.toMatch(/放大|还原/);
  expect(bar(null)).not.toMatch(/放大|缩小|还原/);
});

test("story 430: the sidebar's width is kept on this device in px, 256 to 448; with none kept, one not a number, or storage that cannot be used, 288", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = (getItem: (k: string) => string | null) => Object.defineProperty(globalThis, "localStorage", { value: { getItem }, configurable: true });
  try {
    const kept = (v: string | null) => (storage((k) => (k === "side-width" ? v : null)), sideWidth());
    expect([kept("300"), kept("100"), kept("900"), kept(null), kept("wide")]).toEqual([300, 256, 448, 288, 288]);
    storage(() => {
      throw new Error("SecurityError");
    });
    expect(sideWidth()).toBe(288);
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("stories 441, 442, 444: ⌘K, or Ctrl+K off a Mac, is the jump box's; Alt+↑↓, Option on a Mac, the slot above or below; none of them while an input method composes", () => {
  const key = (o: Partial<KeyLike>, mac = false) => boardKey({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 75, ...o }, mac);
  expect([key({ ctrlKey: true }), key({ key: "K", ctrlKey: true }), key({ metaKey: true }, true)]).toEqual(["jump", "jump", "jump"]);
  // A Mac's Ctrl+K cuts to the line's end in a text box; elsewhere ⌘ is the system's.
  expect([key({ ctrlKey: true }, true), key({ metaKey: true }), key({ ctrlKey: true, shiftKey: true }), key({ ctrlKey: true, altKey: true }), key({})]).toEqual([null, null, null, null, null]);
  expect([key({ key: "ArrowUp", altKey: true }), key({ key: "ArrowDown", altKey: true }, true)]).toEqual(["up", "down"]);
  expect([key({ key: "ArrowDown" }), key({ key: "ArrowDown", altKey: true, shiftKey: true }), key({ key: "ArrowDown", altKey: true, ctrlKey: true }), key({ key: "ArrowLeft", altKey: true })]).toEqual([null, null, null, null]);
  // Safari tells an input method's keys by keyCode 229 alone.
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) expect([key({ ctrlKey: true, ...composing }), key({ key: "ArrowDown", altKey: true, ...composing })]).toEqual([null, null]);
});

/** w with slots that need you, run, are done and idle; f folded on this device, holding f/one, f/two;
 *  and old, archived. The list has them as a, b, c, d, then f's two, old folded at the bottom. */
const lot = (): BoardData => ({
  bots: [],
  workspaces: [
    ws("w", { needsYou: [card({ name: "a", state: "需要你" })], running: [card({ name: "b", state: "运行中" })], done: [card({ name: "c", turnEndedAt: ago(1) })], idle: [card({ name: "d", last: { role: "assistant", text: "部署好了", at: ago(5) } })] }, [card({ name: "old", archivedAt: ago(9) })]),
    ws("f", { idle: [card({ name: "one" }, "f"), card({ name: "two" }, "f")] }),
  ],
});
/** fn with workspace f folded on this device. */
function foldedF<T>(fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => (k === "folded:f" ? "1" : null) }, configurable: true });
  try {
    return fn();
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test("story 442: Alt+↑↓ goes to the slot above or below as the list shows them, round at the ends: none hidden in a folded workspace but the open one, which shows; none archived", () => {
  const data = lot();
  expect(foldedF(() => [nextSlot(data, "w/a", 1), nextSlot(data, "w/c", -1), nextSlot(data, "w/d", 1), nextSlot(data, "w/a", -1)])).toEqual(["w/b", "w/b", "w/a", "w/d"]);
  // The open one in the folded workspace counts; the other there does not.
  expect(foldedF(() => [nextSlot(data, "f/two", -1), nextSlot(data, "f/two", 1)])).toEqual(["w/d", "w/a"]);
  // Unfolded, both do.
  expect([nextSlot(data, "w/d", 1), nextSlot(data, "f/one", 1), nextSlot(data, "f/two", 1)]).toEqual(["f/one", "f/two", "w/a"]);
  // The open one archived: the first below, the last above.
  expect([nextSlot(data, "w/old", 1), nextSlot(data, "w/old", -1)]).toEqual(["w/a", "f/two"]);
  expect(nextSlot({ bots: [], workspaces: [] }, "w/a", 1)).toBeUndefined();
});

test("story 441: the jump box with nothing typed lists the slots opened lately in this tab, the latest first, not the open one, then the rest as the list has them; no archived", () => {
  const data = lot();
  const names = (typed: string, current: string, recent: string[]) => jumpList(data, typed, current, recent).map((r) => r.c.id);
  expect(names("", "w/b", ["w/b", "f/two", "w/old", "gone", "w/c"])).toEqual(["f/two", "w/c", "w/a", "w/d", "f/one"]);
  expect(names("  ", "", [])).toEqual(["w/a", "w/b", "w/c", "w/d", "f/one", "f/two"]);
});

test("story 441: typed, the jump box lists the slots whose name starts with it, then those whose name or workspace has it, then those whose last line has it; the archived too, after the rest", () => {
  const data = lot();
  data.workspaces[0]!.groups.idle.push(card({ name: "Owner" }), card({ name: "photo" }));
  const names = (typed: string) => jumpList(data, typed, "w/b", []).map((r) => [r.c.id, r.kind]);
  // Any case; the open one too, as it was asked for.
  expect(names("O")).toEqual([["w/Owner", "idle"], ["f/one", "idle"], ["w/photo", "idle"], ["f/two", "idle"], ["w/old", "archived"]]);
  expect(names("f/")).toEqual([["f/one", "idle"], ["f/two", "idle"]]);
  expect(names("部署")).toEqual([["w/d", "idle"]]);
  expect(names("b")).toEqual([["w/b", "running"]]);
  expect(names("zzz")).toEqual([]);
});

test("story 441: a jump box's row is the logo with its state's dot, the full name and the state; no Bot's face; the first picked", () => {
  const data = lot();
  data.bots = [{ id: "B1", name: "qq", platform: "qq", avatar: "/face.png" }];
  data.workspaces[0]!.groups.running[0]!.bots = ["B1"];
  const client = new QueryClient();
  client.setQueryData(["board"], data);
  const html = render(<Jump close={() => {}} />, client, "/slot/w%2Fd");
  expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).toBe("w/a需要你w/b运行中w/c1分钟前f/onef/two");
  expect(html).toContain('role="dialog" aria-label="跳转"');
  expect(html).not.toContain("<img");
  expect(html.split('role="option"').slice(1).map((o) => o.includes('aria-selected="true"'))).toEqual([true, false, false, false, false]);
  expect(html.match(/<svg[^>]*aria-label="Claude"/g)).toHaveLength(5);
});

test("stories 441, 442: a slot opens with the page as it is: maximized stays maximized from where it came, a split stays a split; the home opens it beside the list, the whole topology beside the topology; a phone, its chat", () => {
  const id = "w/x";
  expect(slotHash(id, "/slot/A?full", true)).toBe("#/slot/w%2Fx?full");
  expect(slotHash(id, "/slot/A", true)).toBe("#/slot/w%2Fx");
  expect(slotHash(id, "/topology/slot/A?chat&full", true)).toBe("#/topology/slot/w%2Fx?chat&full");
  expect(slotHash(id, "/topology/slot/A?chat", true)).toBe("#/topology/slot/w%2Fx?chat");
  expect(slotHash(id, "/", true)).toBe("#/slot/w%2Fx");
  expect(slotHash(id, "/rhodium", true)).toBe("#/slot/w%2Fx");
  expect(slotHash(id, "/topology", true)).toBe("#/topology/slot/w%2Fx?chat");
  expect(slotHash(id, "/topology/ws/W1?x", true)).toBe("#/topology/slot/w%2Fx?chat");
  expect(slotHash(id, "/topology/slot/A?chat", false)).toBe("#/slot/w%2Fx");
  expect(slotHash(id, "/topology", false)).toBe("#/slot/w%2Fx");
  // The chat open: beside the list or the topology, maximized or not; a phone shows the topology alone at a chat's address.
  expect([chatAt("/slot/w%2Fx?full", true), chatAt("/topology/slot/A?x&chat", true), chatAt("/topology/slot/A?chat", false), chatAt("/topology/slot/A", true), chatAt("/", true)]).toEqual(["w/x", "A", "", "", ""]);
});

test("story 432: whether the sidebar is collapsed is kept on this device for windows from 1280px and for narrower ones apart; never set, collapsed under 1280px; storage that cannot be used keeps none", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const width = Object.getOwnPropertyDescriptor(globalThis, "innerWidth");
  const stored = new Map<string, string>();
  const storage = (getItem: (k: string) => string | null) =>
    Object.defineProperty(globalThis, "localStorage", { value: { getItem, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) }, configurable: true });
  const at = (px: number) => (Object.defineProperty(globalThis, "innerWidth", { value: px, configurable: true }), sideCollapsed());
  try {
    storage((k) => stored.get(k) ?? null);
    expect([at(1280), at(1279)]).toEqual([false, true]);
    Object.defineProperty(globalThis, "innerWidth", { value: 1440, configurable: true });
    keepCollapsed(true);
    expect([at(1440), at(1180)]).toEqual([true, true]);
    at(1180);
    keepCollapsed(false);
    expect([at(1920), at(1024)]).toEqual([true, false]);
    storage(() => {
      throw new Error("SecurityError");
    });
    expect([at(1440), at(1180)]).toEqual([false, true]);
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    if (width) Object.defineProperty(globalThis, "innerWidth", width);
    else delete (globalThis as { innerWidth?: number }).innerWidth;
  }
});

test("stories 431, 444: ⌘B on a Mac, Ctrl+B elsewhere, is the sidebar's key, in where you type too; not while an input method picks a word, nor with Shift or Alt, nor the other system's", () => {
  const key = (o: Partial<KeyboardEvent>, mac: boolean) => boardKey({ key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 66, ...o }, mac);
  expect([key({ metaKey: true }, true), key({ ctrlKey: true }, false), key({ ctrlKey: true, key: "B" }, false)]).toEqual(["side", "side", "side"]);
  expect([key({ ctrlKey: true }, true), key({ metaKey: true }, false), key({}, false), key({ ctrlKey: true, key: "j" }, false)]).toEqual([null, null, null, null]);
  expect([key({ ctrlKey: true, shiftKey: true }, false), key({ ctrlKey: true, altKey: true }, false)]).toEqual([null, null]);
  // An input method's, as Safari tells it by keyCode 229 alone.
  expect([key({ ctrlKey: true, isComposing: true }, false), key({ metaKey: true, keyCode: 229 }, true)]).toEqual([null, null]);
});

test("stories 431, 449: in maximize mode the chat's top bar has 收起侧栏 in ‹'s place; collapsed, 展开侧栏, with an amber dot while a slot but this one needs you; out of it, ‹", () => {
  const client = new QueryClient();
  const bar = (max: { full: boolean; collapsed: boolean }, needs: string[] = []) => (
    client.setQueryData(["board"], boardWith({ needsYou: needs.map((name) => card({ name, state: "需要你" })) })),
    render(
      <Max.Provider value={{ from: "list", toggle() {}, ...max }}>
        <ChatView d={slot({ id: "w/c" })} log={chat()} live />
      </Max.Provider>,
      client,
    )
  );
  expect(bar({ full: true, collapsed: false }, ["ask"])).toContain('aria-label="收起侧栏"');
  expect(bar({ full: true, collapsed: false }, ["ask"])).not.toMatch(/全部槽位|返回|展开侧栏/);
  expect(bar({ full: true, collapsed: true })).toContain('aria-label="展开侧栏"');
  expect(bar({ full: true, collapsed: true }, ["ask"])).toContain('aria-label="展开侧栏，有需要你的"');
  // The one that needs you is this one, in sight already.
  expect(bar({ full: true, collapsed: true }, ["c"])).toContain('aria-label="展开侧栏"');
  expect(bar({ full: false, collapsed: false }, ["ask"])).toContain('aria-label="全部槽位"');
  expect(bar({ full: false, collapsed: false }, ["ask"])).not.toMatch(/侧栏/);
});

/** /api/slot's answer for slot S1, w/c. */
const slot = (o: Partial<SlotData> = {}): SlotData => ({ id: "S1", ref: "w/c", dir: "/w", agent: "claude", mode: "headless", phase: "running", state: "运行中", archivedAt: null, lifetime: "longterm", settings: [], model: null, effort: null, ultracode: false, pane: null, herdrLost: false, asks: [], gone: [], queue: [], process: null, timeline: [], commands: [], ...o });
type Ask = SlotData["asks"][number];
/** A question waiting on you, with one question of these options. */
const choice = (id: string, question: string, labels: string[], deadline: number | null = null): Ask => ({
  id,
  kind: "question",
  text: question,
  deadline,
  card: { questions: [{ question, options: labels.map((label) => ({ label })), multi: false }] },
});
const chat = (o: Partial<Messages> = {}) => Object.assign(new Messages("S1"), { loaded: true, conversation: "C1", ...o });

test("stories 205, 206, 304: a slot's chat names in its top bar the slot, its state and agent, its model on the bar's model button, and has its process, stderr and events in 详情", () => {
  const html = render(<ChatView d={slot({ model: "Opus", effort: "high" })} log={chat()} live />);
  const top = html.replace(/<[^>]+>/g, " ");
  for (const s of ["w/c", "运行中", "详情"]) expect(top).toContain(s);
  // The model and thinking level on the bar's button, the top bar no longer (story 304).
  expect(top).not.toContain("模型 Opus");
  expect(html).toMatch(/<button[^>]*aria-label="模型和思考强度"[^>]*>(?:(?!<\/button>)[^])*Opus(?:(?!<\/button>)[^])*high/);
  // The agent by its logo before the slot's name, as on its card; never in words (#206).
  expect(html).toMatch(/<h2[^>]*><svg[^>]*role="img"[^>]*aria-label="Claude"[^]*?w\/c<\/h2>/);
  expect(top).not.toMatch(/用 (Claude|pi)/);
  // With no model set by /model, the agent's default: only the state.
  const pi = render(<ChatView d={slot({ agent: "pi" })} log={chat()} live />);
  expect(pi).toMatch(/<h2[^>]*><svg[^>]*role="img"[^>]*aria-label="pi"/);
  expect(pi.replace(/<[^>]+>/g, " ")).not.toMatch(/用 (Claude|pi)|模型/);
  expect(top).not.toContain("已断开");

  const process = { unit: "rh-hold-C1", activeState: "active", subState: "running", pid: 42, exitStatus: 0, stderr: ["connection refused"] };
  const details = shown(<Details d={slot({ process })} />);
  for (const s of ["运行中，PID 42", "错误输出", "connection refused"]) expect(details).toContain(s);
});

test("story 407: Claude's default model shows on the bar's model button as 默认, the model it uses beside it in grey", () => {
  const html = render(<ChatView d={slot({ model: "默认（Opus 5.5）" })} log={chat()} live />);
  const button = /<button[^>]*aria-label="模型和思考强度"[^>]*>((?:(?!<\/button>)[^])*)<\/button>/.exec(html)![1]!;
  expect(button).toMatch(/默认<span class="[^"]*text-muted-foreground[^"]*">Opus 5.5<\/span>/);
  expect(button).not.toContain("（");
});

const ev = (o: Partial<SlotEvent> & { type: string }): SlotEvent => ({ seq: 1, at: 0, source: "agent", data: null, ...o });

test("story 253: each kind of event has its own icon and colour, errors red, and says what happened in one sentence", () => {
  const says = (o: Partial<SlotEvent> & { type: string }) => [look(ev(o)).kind, look(ev(o)).text, look(ev(o)).note ?? null];
  expect(says({ type: "im_routed", text: "build it", data: { reason: "开始新回合" } })).toEqual(["message", "build it", null]);
  // Not handed to the agent: why, after it.
  expect(says({ type: "im_routed", text: "1", why: "回答提问", data: { reason: "回答提问" } })).toEqual(["message", "1", "回答提问"]);
  // From the board, as from IM (spec web-write).
  expect(says({ type: "board_routed", text: "build it", data: { reason: "开始新回合", text: "build it" } })).toEqual(["message", "build it", null]);
  expect(says({ type: "ask", data: { kind: "permission", tool: "Bash" }, status: "open" })).toEqual(["ask", "审批 Bash，等你", null]);
  // The tool only for a permission: the others' are the agent's own plumbing.
  expect(says({ type: "ask", data: { kind: "question", tool: "AskUserQuestion" }, status: "delivered" })).toEqual(["ask", "选择题，已答", null]);
  expect(says({ type: "ask", data: { kind: "confirm", tool: "rh" }, status: "answered" })).toEqual(["ask", "确认请求，已答", null]);
  expect(says({ type: "ask", data: { kind: "plan" }, status: "timeout" })).toEqual(["ask", "计划确认，超时", null]);
  expect(says({ type: "ask", data: { kind: "confirm" }, status: "cancelled" })).toEqual(["ask", "确认请求，作废", null]);
  expect(says({ type: "ask_answered", data: { by: "im" } })).toEqual(["answered", "已回答", null]);
  expect(says({ type: "ask_answered", data: { by: "timeout" } })).toEqual(["answered", "超时，按默认作答", null]);
  expect(says({ type: "slot_state", text: "空闲" })).toEqual(["state", "空闲", null]);
  expect(says({ type: "final_reply" })).toEqual(["turn", "回合结束", null]);
  expect(says({ type: "send_me" })).toEqual(["sent", "agent 发给你一条消息", null]);
  expect(says({ type: "agent_crashed", data: { code: 1, signal: null } })).toEqual(["error", "崩溃，退出码 1", null]);
  expect(says({ type: "agent_crashed", data: { code: null, signal: "SIGKILL" } })).toEqual(["error", "崩溃，信号 SIGKILL", null]);
  expect(says({ type: "tui_failed", data: { error: "no pane" } })).toEqual(["error", "没能切到终端：no pane", null]);
  expect(says({ type: "tui_back_failed", data: { error: "pane 已关闭" } })).toEqual(["error", "没能切回无头：pane 已关闭", null]);
  expect(says({ type: "protocol_error", data: { reason: "bad_line", detail: "not JSON" } })).toEqual(["error", "看不懂 agent 说的话：not JSON", null]);
  expect(says({ type: "agent_missing", data: { error: "no claude" } })).toEqual(["error", "找不到 agent 程序：no claude", null]);
  expect(says({ type: "herdr_lost" })).toEqual(["error", "Herdr 断了", null]);
  expect(says({ type: "agent_stopped", data: { code: 0 } })).toEqual(["stopped", "agent 退出", null]);
  // What became of the slot, in your words: stopped with its icon, the rest as a state line (#255).
  expect(says({ type: "slot_stop" })).toEqual(["stopped", "停下", null]);
  expect(says({ type: "slot_agent", data: { agent: "pi" } })).toEqual(["state", "换了 agent", null]);
  expect(says({ type: "tui_switch", data: { interrupt: false } })).toEqual(["state", "切到终端", null]);
  expect(says({ type: "tui_opened", data: { tab: "t1", pane: "p1" } })).toEqual(["state", "终端已打开", null]);
  expect(says({ type: "tui_release" })).toEqual(["state", "切回无头", null]);
  expect(says({ type: "tui_back", data: { session: "s1", lost: null } })).toEqual(["state", "回到无头", null]);
  // One nobody has named yet: its name.
  expect(says({ type: "slot_renamed", data: { from: "a" } })).toEqual(["other", "slot_renamed", null]);

  // Each kind its own icon; errors red, asks amber, what the agent sent you blue, the rest grey.
  const html = (o: Partial<SlotEvent> & { type: string }) => render(<EventRow e={ev(o)} />);
  const kinds = ["im_routed", "ask", "ask_answered", "final_reply", "send_me", "agent_crashed", "agent_stopped"].map((type) => html({ type }).match(/<svg[^>]*class="([^"]*)"/)![1]!);
  expect(new Set(kinds.map((c) => c.match(/lucide-[\w-]+/)![0])).size).toBe(kinds.length);
  expect(kinds[5]).toContain("text-destructive");
  expect(html({ type: "herdr_lost" })).toContain("text-destructive");
  expect(kinds[1]).toContain("text-needs");
  expect(kinds[4]).toContain("text-running");
  for (const i of [0, 2, 3, 6]) expect(kinds[i]).toContain("text-muted-foreground");
  // A state is a quiet line across, with no icon; another event, its name, its data a tap away.
  expect(html({ type: "slot_state", text: "空闲" })).not.toContain("<svg");
  expect(html({ type: "slot_renamed", data: { from: "a" } })).toMatch(/<summary[^>]*>[^]*slot_renamed[^]*<\/summary>[^]*{&quot;from&quot;:&quot;a&quot;}/);
});

test("story 254: an event is a line with its time; what was sent for it is under it, marked only when it failed, its outcome is unknown or it waits", () => {
  const at = new Date("2026-10-23T10:42:05").getTime();
  const sends = (["sent", "failed", "unknown", "held"] as const).map((status) => ({ at, status, text: `${status} text` }));
  const html = render(<EventRow e={ev({ type: "im_routed", at, text: "build it", sends })} />);
  const text = html.replace(/<[^>]+>/g, " ");
  // The time as im-style §2.4 writes a past one: no seconds; another day's with its date.
  expect(text).not.toContain(clock(at));
  for (const s of ["build it", moment(at, Date.now()), "sent text", "failed text", "unknown text", "等你回话"]) expect(text).toContain(s);
  expect(text).not.toMatch(/已发|结局不明|失败/);
  expect(html).toMatch(/lucide-x[^"]*text-destructive[^]*failed text/);
  expect(html).toMatch(/text-needs[^]*unknown text/);
  // A process that ended, with nothing on stderr: one line, no stderr.
  const ended = shown(<Details d={slot({ process: { unit: "rh-hold-C1", activeState: "failed", subState: "failed", pid: null, exitStatus: 1, stderr: [] } })} />);
  expect(ended).toContain("已退出，退出码 1");
  expect(ended).not.toMatch(/rh-hold|failed|错误输出|\/w/);
});

test("story 252: 详情's events page back to the first, each once; the newest page again brings what is new and the latest as they are now; with none in common it starts over", async () => {
  const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev({ type: "final_reply", seq: from + i }));
  const pages: Record<string, SlotEvent[]> = { "": seqs(51, 100), "&before=51": seqs(1, 50), "&before=1": [] };
  const asked: string[] = [];
  const events = new Events("S1", async (url) => (asked.push(url.replace("api/slot-events?id=S1", "")), pages[url.replace("api/slot-events?id=S1", "")]!));
  expect(await events.older()).toBe(false); // nothing to go back from yet
  await events.newest();
  // Scrolling to the top asks twice from the same place.
  expect(await Promise.all([events.older(), events.older()])).toContain(true);
  expect(await events.older()).toBe(false);
  expect(await events.older()).toBe(false);
  expect(events.list.map((e) => e.seq)).toEqual(seqs(1, 100).map((e) => e.seq));
  expect(asked.filter((q) => q === "&before=1")).toHaveLength(1);

  // Three new events; one shown has its sends now.
  pages[""] = [...seqs(54, 100), ...seqs(101, 103)];
  pages[""][0] = { ...pages[""][0]!, sends: [{ at: 0, status: "sent", text: "hi" }] };
  await events.newest();
  expect(events.list.map((e) => e.seq)).toEqual(seqs(1, 103).map((e) => e.seq));
  expect(events.list[53]!.sends).toHaveLength(1);

  // The stream was down for more than a page: none in common.
  pages[""] = seqs(200, 249);
  await events.newest();
  expect(events.list.map((e) => e.seq)).toEqual(seqs(200, 249).map((e) => e.seq));
  pages["&before=200"] = seqs(150, 199);
  expect(await events.older()).toBe(true);
  expect(events.list).toHaveLength(100);
});

test("stories 248, 249: your message is a bubble with a thin border; through a bot, your avatar beside it and the bot's avatar and name over it; else its source line as it is; typed in the terminal, neither", () => {
  const user = (text: string, source: string | null, from: Extract<Block, { kind: "user" }>["from"]): Block => ({ kind: "user", text, source, from, at: `${text.length}.0`, time: 0 });
  const one = (b: Block) => render(<ChatView d={slot()} log={chat({ blocks: [b] })} live />);
  const bubble = (html: string) => html.match(/<p class="([^"]*)"[^>]*>hi<\/p>/)![1]!;

  const through = one(user("hi", "QQ Bot main 的私聊", { platform: "qq", bot: "main", botAvatar: "api/avatar?id=B&v=1", avatar: "api/avatar?id=C&v=2" }));
  expect(bubble(through)).toContain("border");
  expect(through).toContain('src="api/avatar?id=C&amp;v=2"');
  expect(through).toContain('src="api/avatar?id=B&amp;v=1"');
  expect(through.replace(/<[^>]+>/g, " ")).toContain("main");
  expect(through).not.toContain("的私聊");
  // The mark on the bot's avatar ringed in the ground, the page's, so no lighter ring on a dark one; one ring, its own thin one gone (#534).
  expect(through).toMatch(/<svg[^>]*aria-label="QQ"[^>]*class="[^"]*ring-2 ring-background"/);
  expect(through).not.toMatch(/ring-white|ring-border/);

  // No avatars: the platform's mark in their place.
  const bare = one(user("hi", "QQ 私聊", { platform: "qq", bot: null, botAvatar: null, avatar: null }));
  expect(bare).not.toContain("<img");
  expect(bare.match(/aria-label="QQ"/g)).toHaveLength(2);
  expect(bare).not.toContain("私聊");

  const sent = one(user("hi", "槽位 w/a，经 rh send", null));
  expect(sent.replace(/<[^>]+>/g, " ")).toContain("槽位 w/a，经 rh send");
  expect(sent).not.toMatch(/<img|aria-label="QQ"/);

  const typed = one(user("hi", null, null));
  expect(bubble(typed)).toContain("border");
  expect(typed).not.toMatch(/<img|aria-label="QQ"/);
});

test("#534: a Bot's connection dot shrinks with a small face, as its mark does, so the two leave the face's left half and more", () => {
  const dot = (size: number) => renderToStaticMarkup(<Face url="a.png" p="qq" size={size} conn="reconnecting" />).match(/aria-label="重连中" class="([^"]*)"/)![1]!.split(" ");
  expect(dot(18)).toContain("size-2");
  expect(dot(18)).not.toContain("size-2.5");
  expect(dot(28)).toContain("size-2.5");
});

test("stories 191, 195: a slot's chat shows what you and the agent said in order, each with its time and yours with where you said it; the agent's as Markdown, code in monospace", () => {
  const at = new Date("2026-10-23T10:42:05").getTime();
  const blocks: Block[] = [
    { kind: "user", text: "把错字改掉", source: "QQ 私聊", from: null, at: "0.0", time: at },
    { kind: "system", title: "压缩了对话", text: "", at: "50.0", time: at },
    { kind: "assistant", text: "改好了，**三处**：\n\n```sh\nbun test\n```", at: "100.0", time: at + 60_000 },
  ];
  const html = render(<ChatView d={slot()} log={chat({ blocks })} live />);
  const text = html.replace(/<[^>]+>/g, " ");
  expect(text.indexOf("把错字改掉")).toBeLessThan(text.indexOf("压缩了对话"));
  expect(text.indexOf("压缩了对话")).toBeLessThan(text.indexOf("改好了"));
  for (const s of ["QQ 私聊", clock(at), clock(at + 60_000)]) expect(text).toContain(s);
  expect(html).toContain('data-streamdown="strong"');
  // Tailwind sets pre in monospace.
  expect(html).toMatch(/<pre[^>]*>[\s\S]*bun test/);

  expect(shown(<ChatView d={slot()} log={chat({ conversation: null })} live />)).toContain("还没有对话");
  expect(shown(<ChatView d={slot()} log={chat()} live />)).toContain("对话里还没有消息");
});

test("stories 196, 197, 199: a slot's chat folds tool calls into a line, each call in it with its argument, its arguments and result; one cut offers 看全文; the call running is on its own, with how long", () => {
  const read = { ...call(10, "Read", "teh typo"), shown: { name: "Read", arg: "README.md", code: true }, input: '{\n  "file_path": "/w/README.md"\n}' } as Block & { kind: "tool" };
  read.result!.length = 3000;
  const bash = { ...call(20, "Bash", null, Date.now() - 12_000), shown: { name: "Bash", arg: "bun test", code: true } };
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), read, bash] })} live />);
  const text = html.replace(/<[^>]+>/g, " ");
  for (const s of ["README.md", "/w/README.md", "teh typo", "看全文", "共 3000 字", "正在跑", "bun test", "12 秒"]) expect(text).toContain(s);
  expect(html).toMatch(/<summary[^>]*>[^]*Read[^]*<\/summary>/);
  expect(text.indexOf("teh typo")).toBeLessThan(text.indexOf("正在跑"));
});

test("#206: each tool call is drawn with its kind's icon: in a fold's line, in its own line in the fold, and running; a thought with a brain", () => {
  const read = { ...call(10, "Read"), shown: { name: "Read", arg: "README.md", code: true } };
  const bash = { ...call(20, "bash", null, Date.now()), shown: { name: "Bash", arg: "bun test", code: true } };
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), read, words(15), words(16, "thinking"), words(17), bash] })} live />);
  const summaries = [...html.matchAll(/<summary[^>]*>([^]*?)<\/summary>/g)].map((m) => m[1]!);
  // The fold of Read and its line in it; the fold of the thought and its line.
  expect(summaries.filter((s) => s.includes("Read"))).toHaveLength(2);
  for (const s of summaries.filter((s) => s.includes("Read"))) expect(s).toContain("lucide-file-text");
  for (const s of summaries.filter((s) => s.includes("思考"))) expect(s).toContain("lucide-brain");
  const running = html.slice(html.indexOf("正在跑") - 1500, html.indexOf("正在跑"));
  expect(running).toContain("lucide-terminal");
});

test("#206, #495: a call that failed has a red icon and a red ⓧ, 出错 to screen readers, in its own line, and after its run in its fold's line", () => {
  const bash = { ...call(10, "Bash", "1 fail"), shown: { name: "Bash", arg: "bun test", code: true } } as Block & { kind: "tool" };
  bash.result!.error = true;
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), call(5, "Read"), bash, words(20)] })} live />);
  const [fold, read, failed] = [...html.matchAll(/<summary[^>]*>([^]*?)<\/summary>/g)].map((m) => m[1]!);
  for (const line of [fold!, failed!]) {
    expect(line).toMatch(/aria-label="出错"[^>]*text-destructive[^>]*><svg[^>]*lucide-circle-x/);
    expect(line).toMatch(/text-destructive[^>]*><svg[^>]*lucide-terminal/);
  }
  // A single call that failed: the ⓧ alone, no count, right after its name, no word.
  expect(fold!.replace(/<[^>]+>/g, "")).toBe("Read、Bash ");
  // Only the kind that failed is red, and a call that did not fail says nothing.
  expect(fold).toMatch(/text-tool-look[^>]*><svg[^>]*lucide-file-text/);
  expect(read).not.toContain("出错");
  expect(read).not.toContain("text-destructive");
});

test("#495: a fold's line never breaks 另外 N 次, its ⓧ with it, failed or not", () => {
  const glob = call(24, "Glob", "none") as Block & { kind: "tool" };
  glob.result!.error = true;
  const fold = (at: number, last: Block) => [call(at, "Read"), call(at + 2, "Grep"), call(at + 4, "Edit"), call(at + 6, "Bash"), last, call(at + 10, "Write")];
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), ...fold(2, call(10, "Glob")), words(15), ...fold(16, glob), words(30)] })} live />);
  const [fine, bad] = [...html.matchAll(/<summary[^>]*>([^]*?)<\/summary>/g)].map((m) => m[1]!).filter((s) => s.includes("另外"));
  expect(fine).toContain('<span class="whitespace-nowrap">另外 2 次</span>');
  expect(bad).toMatch(/<span class="whitespace-nowrap">另外 2 次 <span role="img" aria-label="出错 1 次"/);
});

test("#495: a fold's line never breaks a run's name from its ×N, nor so its ⓧ from its name", () => {
  const bash = call(14, "Bash", "1 fail") as Block & { kind: "tool" };
  bash.result!.error = true;
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), call(2, "Read"), call(4, "Read"), call(12, "Bash"), bash, call(16, "Edit"), words(20)] })} live />);
  const fold = [...html.matchAll(/<summary[^>]*>([^]*?)<\/summary>/g)].map((m) => m[1]!).find((s) => s.includes("、"))!;
  // The space before the ×N starts the nowrap span, so it never starts a line, which would indent the ×N.
  expect(fold).toContain('Read</span><span class="whitespace-nowrap"> ×2</span>、');
  expect(fold).toContain('Bash</span><span class="whitespace-nowrap"> ×2 <span role="img" aria-label="出错 1 次"');
});

test("#501: a fold's chevron sits at its row's right end, a step's too, its ⓧ by it; with a line that wraps, by its first line, as are its icons", () => {
  const bash = call(4, "Bash", "1 fail") as Block & { kind: "tool" };
  bash.result!.error = true;
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), call(2, "Read"), bash, words(10)] })} live />);
  const [fold, , step] = [...html.matchAll(/<summary class="([^"]*)">([^]*?)<\/summary>/g)].map((m) => [m[1]!.split(" "), m[2]!] as const);
  // At the top, 6px (wide: 4px) down: where a row of one line, 32px (28px) high, has them.
  expect(fold![0]).toEqual(expect.arrayContaining(["items-start", "py-1.5", "lg:py-1", "min-h-8", "lg:min-h-7"]));
  // The line takes the room the icons leave; the chevron after it, last, 3px down: by its first line.
  expect(fold![1]).toMatch(/<span class="min-w-0 flex-1">[^]*<\/span><svg[^>]*mt-\[3px\][^>]*>[^]*?<\/svg>$/);
  expect(step![1]).toMatch(/<span class="min-w-0 flex-1 truncate">[^]*<\/span><span role="img" aria-label="出错"[^]*<\/span><svg[^>]*lucide-chevron-right[^>]*>[^]*?<\/svg>$/);
});

test("#501: a fold's line wraps inside a name too long for a line, so the chat never scrolls sideways, a ⓧ kept with its ×N or its name's last part, never alone on a line", () => {
  const failing = (at: number, name: string) => {
    const c = call(at, name, "none") as Block & { kind: "tool" };
    c.result!.error = true;
    return c;
  };
  const long = "plugin_garden_wiki.fetch_page_contents";
  const html = render(
    <ChatView d={slot()} log={chat({ blocks: [words(0, "user"), call(2, long), call(4, long), failing(6, long), failing(7, "Edit"), words(10), failing(12, "gardenwiki.searchAllPagesByTitleAndTag"), words(20)] })} live />,
  );
  const [two, one] = [...html.matchAll(/group\/fold[^>]*><summary[^>]*>([^]*?)<\/summary>/g)].map((m) => m[1]!);
  // Only the names wrap anywhere, not the whole line, which a phone would then break before a 、.
  expect(two).toContain('<span class="min-w-0 flex-1"><span class="wrap-anywhere">');
  expect(two).toContain(`${long}</span><span class="whitespace-nowrap"> ×3 <span role="img" aria-label="出错 1 次"`);
  // With no ×N: its last part, after a . _ or - or from a capital, so a name that fits a line but not with its ⓧ
  // breaks there; else its last letter.
  expect(two).toContain('、<span class="wrap-anywhere">Edi</span><span class="whitespace-nowrap">t <span role="img" aria-label="出错"');
  expect(one).toContain('<span class="wrap-anywhere">gardenwiki.searchAll</span><span class="whitespace-nowrap">PagesByTitleAndTag <span role="img" aria-label="出错"');
});

test("#206: a tool call's kind, by its name as Claude or pi calls it", () => {
  const kinds = {
    read: ["Read", "NotebookRead", "read"],
    edit: ["Edit", "MultiEdit", "Write", "NotebookEdit", "edit", "write"],
    command: ["Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop", "Monitor", "bash"],
    search: ["Grep", "Glob", "grep", "find", "ls"],
    web: ["WebFetch", "WebSearch"],
    agent: ["Agent", "Task", "Workflow", "SendMessage"],
    todo: ["TodoWrite"],
    ask: ["AskUserQuestion", "ExitPlanMode"],
    mcp: ["mcp__github__get_pull_request", "mcp__claude_ai_Gmail__search"],
    other: ["Skill", "SomethingNew", ""],
  };
  for (const [kind, names] of Object.entries(kinds)) for (const name of names) expect([name, kindOf(name)]).toEqual([name, kind]);
});

test("story 203: a slot's chat shows what the agent is writing last, below the call running, as Markdown even half written", () => {
  const bash = { ...call(20, "Bash", null, Date.now()), shown: { name: "Bash", arg: "bun test", code: true } };
  const drafts = [
    { text: "测试过了", whole: true },
    { text: "接下来**改", whole: false },
  ];
  const html = render(<ChatView d={slot()} log={chat({ blocks: [words(0, "user"), bash], drafts })} live />);
  const text = html.replace(/<[^>]+>/g, " ");
  expect(text.indexOf("正在跑")).toBeLessThan(text.indexOf("测试过了"));
  expect(text.indexOf("测试过了")).toBeLessThan(text.indexOf("接下来"));
  expect(html).toMatch(/data-streamdown="strong"[^>]*>改</);
  expect(text).not.toContain("**");
});

test("story 191: a slot's chat opened again before the answers to the visit before came shows them once they come", async () => {
  jest.useRealTimers();
  const asked: { url: string; reply(body: unknown): Promise<void> }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((resolve) => asked.push({ url, reply: (body) => (resolve(Response.json(body)), Bun.sleep(1)) }))) as typeof fetch;
  try {
    const client = new QueryClient();
    // You open the slot's chat, and go back to all slots before its answers come. Then open it again.
    const before = visit("S1");
    new QueryObserver(client, before.query).subscribe(() => {})();
    const again = visit("S1");
    const chat = new QueryObserver(client, again.query);
    const leave = chat.subscribe(() => {});
    for (const a of asked) await a.reply(a.url.startsWith("api/slot") ? slot() : page("C1", 0, 10, [0, "hello"]));
    expect(chat.getCurrentResult().data?.ref).toBe("w/c");
    expect(said(again.log)).toEqual(["hello"]);
    leave();
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#236: a slot's chat seen lately opens again as it was, its answer there before any comes, and brings only the blocks written since; not what the agent was writing, nor once those seen since hold all the blocks kept", async () => {
  jest.useRealTimers();
  const asked: string[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = (async (url: string) => (asked.push(url), Response.json(url.startsWith("api/slot") ? slot({ id: "K1" }) : page("C1", 0, 10, [0, "hello"])))) as typeof fetch;
  try {
    const client = new QueryClient();
    const first = visit("K1");
    expect(first.query.initialData).toBeUndefined();
    await client.fetchQuery(first.query);
    first.log.wrote("delta", "half");
    for (const id of ["K2", "K3", "K4", "K5"]) visit(id);
    asked.length = 0;
    const again = visit("K1");
    expect(again.log).toBe(first.log);
    expect(said(again.log)).toEqual(["hello"]);
    expect(again.log.drafts).toEqual([]);
    expect(again.query.initialData?.ref).toBe("w/c");
    expect(again.query.queryKey).not.toEqual(first.query.queryKey);
    await client.fetchQuery(again.query);
    expect(asked).toEqual(["api/slot?id=K1", "api/messages?slot=K1&after=10"]);
    // Opened again while rhodium restarts: what was shown stays.
    globalThis.fetch = (async () => new Response(null, { status: 502 })) as unknown as typeof fetch;
    const failing = visit("K1");
    await client.fetchQuery(failing.query).catch(() => {});
    expect(client.getQueryState(failing.query.queryKey)?.status).toBe("error");
    expect(client.getQueryData<SlotData>(failing.query.queryKey)?.ref).toBe("w/c");
    // K6 holds all the blocks kept: the next slot seen pushes out K1, seen before it.
    transcripts({ K6: Array(KEPT_BLOCKS).fill("x") });
    await client.fetchQuery(visit("K6").query);
    visit("K2");
    expect(visit("K1").log).not.toBe(first.log);
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#356: a slot's chat brought ahead as you go to its row opens with what came, asked for once, even while it is still coming; one seen lately, or coming, is not brought again", async () => {
  jest.useRealTimers();
  const asked: { url: string; reply(body: unknown): Promise<void> }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((resolve) => asked.push({ url, reply: (body) => (resolve(Response.json(body)), Bun.sleep(1)) }))) as typeof fetch;
  const answer = async () => {
    for (const a of asked.splice(0)) await a.reply(a.url.startsWith("api/slot") ? slot({ id: "A1" }) : page("C1", 0, 10, [0, "hello"]));
  };
  try {
    const client = new QueryClient();
    // A finger down on its row: it starts coming; again, nothing more. You open it before it came.
    ahead("A1");
    ahead("A1");
    expect(asked.map((a) => a.url)).toEqual(["api/slot?id=A1", "api/messages?slot=A1"]);
    const open = visit("A1");
    const chat = new QueryObserver(client, open.query);
    const leave = chat.subscribe(() => {});
    await Bun.sleep(1);
    expect(asked).toHaveLength(2);
    await answer();
    for (let i = 0; i < 50 && !chat.getCurrentResult().data; i++) await Bun.sleep(1);
    expect(chat.getCurrentResult().data?.ref).toBe("w/c");
    expect(said(open.log)).toEqual(["hello"]);
    leave();
    // Seen lately: it opens as it was, and its visit brings what is new.
    ahead("A1");
    expect(asked).toEqual([]);
    // One that came while you looked elsewhere opens with it, then asks only for what was written since.
    ahead("A2");
    await answer();
    await Bun.sleep(1);
    const later = visit("A2");
    expect(said(later.log)).toEqual(["hello"]);
    expect(later.query.initialData?.ref).toBe("w/c");
    const fetching = client.fetchQuery(later.query);
    await Bun.sleep(1);
    expect(asked.map((a) => a.url)).toEqual(["api/slot?id=A2", "api/messages?slot=A2&after=10"]);
    await answer();
    await fetching;
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#356: a chat still coming ahead is waited for, not asked for again, by its page drawn twice, as React may throw a render away, nor by it opened again before it came, whose newest page asked for twice at once could land older", async () => {
  jest.useRealTimers();
  const asked: { url: string; reply(body: unknown): Promise<void> }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((resolve) => asked.push({ url, reply: (body) => (resolve(Response.json(body)), Bun.sleep(1)) }))) as typeof fetch;
  try {
    const client = new QueryClient();
    ahead("D1");
    // React throws the page's first render away and draws it again: only the second's query runs.
    visit("D1");
    const open = visit("D1");
    const leave = new QueryObserver(client, open.query).subscribe(() => {});
    await Bun.sleep(1);
    expect(asked.map((a) => a.url)).toEqual(["api/slot?id=D1", "api/messages?slot=D1"]);
    // You go back to all slots and open it again before it came.
    leave();
    const again = visit("D1");
    const chat = new QueryObserver(client, again.query);
    const close = chat.subscribe(() => {});
    await Bun.sleep(1);
    expect(asked).toHaveLength(2);
    for (const a of asked.splice(0)) await a.reply(a.url.startsWith("api/slot") ? slot({ id: "D1" }) : page("C1", 0, 10, [0, "hello"]));
    for (let i = 0; i < 50 && !chat.getCurrentResult().data; i++) await Bun.sleep(1);
    expect(chat.getCurrentResult().data?.ref).toBe("w/c");
    expect(said(again.log)).toEqual(["hello"]);
    close();
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#356: one chat is brought ahead at a time: another row's, or the mouse leaving the row, stops it, and its visit asks afresh; one that came stays", async () => {
  jest.useRealTimers();
  const asked: { url: string; signal?: AbortSignal | null }[] = [];
  const fetched = globalThis.fetch;
  // B1's come at once; the rest hang till stopped.
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    asked.push({ url, signal: init?.signal });
    if (url.includes("B1")) return Promise.resolve(Response.json(url.startsWith("api/slot") ? slot({ id: "B1" }) : page("C1", 0, 10, [0, "hello"])));
    return new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(new DOMException("stopped", "AbortError"))));
  }) as typeof fetch;
  const stopped = () => asked.filter((a) => a.signal?.aborted).map((a) => a.url);
  try {
    ahead("H1");
    ahead("B1");
    expect(stopped()).toEqual(["api/slot?id=H1", "api/messages?slot=H1"]);
    await Bun.sleep(5);
    // B1's came: the mouse leaving its row stops nothing, and it opens with what came.
    behind();
    expect(said(visit("B1").log)).toEqual(["hello"]);
    ahead("H2");
    behind();
    expect(stopped()).toEqual(["api/slot?id=H1", "api/messages?slot=H1", "api/slot?id=H2", "api/messages?slot=H2"]);
    asked.length = 0;
    void new QueryClient().fetchQuery(visit("H2").query).catch(() => {});
    await Bun.sleep(1);
    expect(asked.map((a) => [a.url, a.signal?.aborted ?? false])).toEqual([
      ["api/slot?id=H2", false],
      ["api/messages?slot=H2", false],
    ]);
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#356: a chat pressed on, still coming while its page's code comes, is not stopped by the mouse going on over rows, nor shares the link with theirs; once it came, rows bring theirs again", async () => {
  jest.useRealTimers();
  const asked: { url: string; signal?: AbortSignal | null; reply(body: unknown): void }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, fail) => {
      asked.push({ url, signal: init?.signal, reply: (body) => resolve(Response.json(body)) });
      init?.signal?.addEventListener("abort", () => fail(new DOMException("stopped", "AbortError")));
    })) as typeof fetch;
  try {
    // Rested on, then pressed on; the mouse goes on to the chat over the list still drawn, resting on another row.
    ahead("O1");
    ahead("O1", true);
    behind();
    ahead("O2");
    behind();
    expect(asked.map((a) => [a.url, a.signal?.aborted])).toEqual([
      ["api/slot?id=O1", false],
      ["api/messages?slot=O1", false],
    ]);
    for (const a of asked.splice(0)) a.reply(a.url.startsWith("api/slot") ? slot({ id: "O1" }) : page("C1", 0, 10, [0, "hello"]));
    await Bun.sleep(5);
    expect(said(visit("O1").log)).toEqual(["hello"]);
    ahead("O2");
    expect(asked.map((a) => a.url)).toEqual(["api/slot?id=O2", "api/messages?slot=O2"]);
  } finally {
    behind();
    globalThis.fetch = fetched;
  }
});

test("#356: a chat seen lately keeps its place while the mouse goes over other rows or a finger down on them brings theirs ahead", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  globalThis.fetch = (async (url: string) => Response.json(url.startsWith("api/slot") ? slot({ id: "P1" }) : page("C1", 0, 10, [0, "hello"]))) as typeof fetch;
  try {
    const seen = visit("P1");
    await new QueryClient().fetchQuery(seen.query);
    seen.place.top = 400;
    for (const id of ["P2", "P3", "P4", "P5", "P6", "P7"]) ahead(id);
    await Bun.sleep(5);
    const again = visit("P1");
    expect(again.log).toBe(seen.log);
    expect(again.place.top).toBe(400);
  } finally {
    globalThis.fetch = fetched;
  }
});

/** Answers as rhodium would for slots whose transcripts say lines, 10 bytes each, in conversation C1:
 *  the newest page, or what was written after=; a slot whose turn ended (in done) is idle. Each URL
 *  asked, in order. */
function transcripts(lines: Record<string, string[]>, done = new Set<string>()) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const id = decodeURIComponent(/[?&](?:id|slot)=([^&]+)/.exec(url)![1]!);
    if (url.startsWith("api/slot")) return Response.json(slot({ id, phase: done.has(id) ? "idle" : "running" }));
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    const all = (lines[id] ?? []).map((t, i): [number, string] => [i * 10, t]);
    return Response.json(page("C1", 0, all.length * 10, ...all.filter(([at]) => at >= after)));
  }) as typeof fetch;
  return asked;
}
/** The event stream says slot went to state (idle, waiting on you) in mode. */
const went = (slot: string, state = "idle", mode = "headless") => streams[0]!.message(undefined, JSON.stringify({ type: "slot_state", slot, trace: null, data: { state, mode } }));

test("#386: a slot's turn ended while you look elsewhere: its chat seen lately brings its answer and the blocks written since, keeping its place among those seen lately", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  const lines: Record<string, string[]> = { E1: ["hello"], E2: ["hello"], E3: ["hello"], E4: ["hello"], E5: ["hello"] };
  const done = new Set<string>();
  const asked = transcripts(lines, done);
  const { stop } = following();
  try {
    const client = new QueryClient();
    const logs: Record<string, Messages> = {};
    for (const id of Object.keys(lines)) {
      const v = visit(id);
      await client.fetchQuery(v.query);
      logs[id] = v.log;
    }
    // E1, seen least lately, and E3 end their turns.
    for (const id of ["E1", "E3"]) lines[id]!.push("done"), done.add(id);
    asked.length = 0;
    went("E1");
    went("E3", "waiting");
    await Bun.sleep(5);
    expect(asked.toSorted()).toEqual(["api/messages?slot=E1&after=10", "api/messages?slot=E1&after=20", "api/messages?slot=E3&after=10", "api/messages?slot=E3&after=20", "api/slot?id=E1", "api/slot?id=E3"]);
    expect(said(logs.E1!)).toEqual(["hello", "done"]);
    // E1 is still the one seen least lately: E6's blocks and E1's to E5's 7 are 2 too many, and the next
    // slot seen drops E1, not E2.
    lines.E6 = Array(KEPT_BLOCKS - 5).fill("x");
    await client.fetchQuery(visit("E6").query);
    // E3 opens as it is now, with no answer to wait for.
    const e3 = visit("E3");
    expect(visit("E2").log).toBe(logs.E2!);
    expect(e3.log).toBe(logs.E3!);
    expect(e3.query.initialData?.phase).toBe("idle");
    expect(said(e3.log)).toEqual(["hello", "done"]);
    expect(visit("E1").log).not.toBe(logs.E1!);
  } finally {
    stop();
    globalThis.fetch = fetched;
  }
});

test("#415: the chats seen lately are kept by the blocks they hold in all, not by how many: two dozen small ones all stay, a big one pushes out those seen least lately, and the one opened stays however big", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  const lines: Record<string, string[]> = { HUGE: Array(KEPT_BLOCKS + 10).fill("x"), BIG: Array(KEPT_BLOCKS - 10).fill("x") };
  const small = Array.from({ length: 24 }, (_, i) => `M${i}`);
  for (const id of small) lines[id] = ["hello"];
  transcripts(lines);
  try {
    const client = new QueryClient();
    const logs: Record<string, Messages> = {};
    const seen = async (id: string) => {
      const v = visit(id);
      await client.fetchQuery(v.query);
      logs[id] = v.log;
    };
    // Opened again and again, a chat holding more than all the blocks kept stays; the next one seen pushes it out.
    await seen("HUGE");
    expect(visit("HUGE").log).toBe(logs.HUGE!);
    expect(visit("HUGE").log).toBe(logs.HUGE!);
    for (const id of small) await seen(id);
    expect(visit("HUGE").log).not.toBe(logs.HUGE!);
    expect(visit("M0").log).toBe(logs.M0!);
    await seen("BIG");
    // Seen next, as BIG's 1990 blocks and the small ones' 24 make 14 too many: M1 to M14 go.
    visit("M23");
    expect(visit("M15").log).toBe(logs.M15!);
    expect(visit("M1").log).not.toBe(logs.M1!);
    expect(visit("BIG").log).toBe(logs.BIG!);
  } finally {
    globalThis.fetch = fetched;
  }
});

test("#386: a slot's turn ended while its chat is on screen, it is running or in the terminal, or the browser saves data: nothing is brought, the chat keeps itself", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  const lines: Record<string, string[]> = { F1: ["hello"], F2: ["hello"] };
  const asked = transcripts(lines);
  const { stop } = following();
  try {
    const open = visit("F1");
    const leave = new QueryObserver(queryClient, open.query).subscribe(() => {});
    await Bun.sleep(5);
    lines.F1!.push("done");
    asked.length = 0;
    went("F1");
    went("F2", "running");
    went("F2", "idle", "tui");
    await Bun.sleep(5);
    expect(asked).toEqual([]);
    // Gone from the screen, it is brought, but while the browser saves data.
    leave();
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    went("F1");
    await Bun.sleep(5);
    expect(asked).toEqual([]);
    delete (navigator as { connection?: unknown }).connection;
    went("F1");
    await Bun.sleep(5);
    expect(asked).toEqual(["api/slot?id=F1", "api/messages?slot=F1&after=10", "api/messages?slot=F1&after=20"]);
  } finally {
    delete (navigator as { connection?: unknown }).connection;
    stop();
    globalThis.fetch = fetched;
  }
});

test("#386: a slot not seen lately whose turn ended is brought as ahead brings it, one at a time, asked once however many events say so, and takes what is new as its next turn ends; none pushes out a chat seen lately, as one whose message failed", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  const lines: Record<string, string[]> = Object.fromEntries(["U1", "U2", "U3", "U4", "U5", "N1", "N2", "N3", "N4", "N5", "N6", "N7"].map((id) => [id, ["hello"]]));
  const asked = transcripts(lines);
  const { stop } = following();
  try {
    const client = new QueryClient();
    const u1 = visit("U1");
    await client.fetchQuery(u1.query);
    u1.log.sent = [{ id: "r1", text: "hi", words: "hi", files: [], from: 0, failed: "网络断了" }];
    for (const id of ["U2", "U3", "U4", "U5"]) await client.fetchQuery(visit(id).query);
    expect(unsent.any()).toBe(true);
    for (const id of ["N1", "N2", "N3", "N4", "N5", "N6"]) {
      went(id);
      await Bun.sleep(5);
    }
    expect(unsent.any()).toBe(true);
    // Replayed after the stream was down, or two slots at once: the first asked once, the rest not at all.
    asked.length = 0;
    went("N7");
    went("N7");
    went("N5");
    await Bun.sleep(5);
    expect(asked).toEqual(["api/slot?id=N7", "api/messages?slot=N7"]);
    expect(visit("U1").log).toBe(u1.log);
    // Its turn ends again before you open it: what came takes what is new.
    lines.N7!.push("done");
    went("N7");
    await Bun.sleep(5);
    const n7 = visit("N7");
    expect(said(n7.log)).toEqual(["hello", "done"]);
    expect(n7.query.initialData?.id).toBe("N7");
  } finally {
    stop();
    globalThis.fetch = fetched;
  }
});

test("#386: a chat brought as a slot's turn ended, still coming, is not stopped as a finger lifted off its row leaves it before the tap opens it: its newest page is asked for once; nor is one brought ahead taking what is new", async () => {
  jest.useRealTimers();
  const fetched = globalThis.fetch;
  const lines: Record<string, string[]> = { T1: ["hello"], T2: ["hello"] };
  transcripts(lines);
  const answer = globalThis.fetch;
  // Each URL as asked; the answers held till let go; stopped ones never answer.
  const asked: string[] = [];
  const held: (() => void)[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, fail) => {
      asked.push(url);
      held.push(() => resolve(answer(url, init)));
      init?.signal?.addEventListener("abort", () => fail(new DOMException("stopped", "AbortError")));
    })) as typeof fetch;
  const letGo = async () => {
    for (let i = 0; i < 10; i++) {
      for (const go of held.splice(0)) go();
      await Bun.sleep(1);
    }
  };
  const { stop } = following();
  try {
    const client = new QueryClient();
    went("T1");
    await Bun.sleep(1);
    // The finger lifted leaves its row, then the tap opens it.
    behind();
    const t1 = visit("T1");
    const leave = new QueryObserver(client, t1.query).subscribe(() => {});
    await letGo();
    leave();
    expect(asked).toEqual(["api/slot?id=T1", "api/messages?slot=T1"]);
    expect(said(t1.log)).toEqual(["hello"]);
    // One the mouse rested on came; its turn ends, and it is tapped while what is new comes.
    ahead("T2");
    await letGo();
    lines.T2!.push("done");
    asked.length = 0;
    went("T2");
    await Bun.sleep(1);
    behind();
    const t2 = visit("T2");
    const close = new QueryObserver(client, t2.query).subscribe(() => {});
    await letGo();
    close();
    expect(asked).toEqual(["api/slot?id=T2", "api/messages?slot=T2&after=10", "api/messages?slot=T2&after=20"]);
    expect(said(t2.log)).toEqual(["hello", "done"]);
  } finally {
    stop();
    globalThis.fetch = fetched;
  }
});

test("stories 289, 290, 291: each ask waiting on you is a card in place of the bar, oldest first, told apart by its icon and not a word; a choice has a button for each option and room for your own words, the rest their yes and no, and room for a reason where it is passed on", () => {
  const deadline = new Date("2026-10-23T10:42:05").getTime();
  const asks: Ask[] = [
    { ...choice("A1", "部署到哪个环境？", ["staging", "production"], deadline), card: { questions: [{ question: "部署到哪个环境？", options: [{ label: "staging" }, { label: "production", description: "线上" }], multi: false }] } },
    { id: "A2", kind: "permission", text: "", deadline: null, card: { head: "要运行这条命令", body: "git push", yes: "允许", no: "拒绝", told: true } },
    { id: "A3", kind: "plan", text: "", deadline: null, card: { head: "", body: "## 步骤\n\n1. **先**跑测试", markdown: true, yes: "批准", no: "不批准", told: true } },
    { id: "A4", kind: "confirm", text: "", deadline: null, card: { head: "切到 TUI 吗？", body: "", yes: "切到 TUI", no: "取消", told: false } },
  ];
  const html = render(<ChatView d={slot({ phase: "waiting", asks })} log={chat({ blocks: [{ kind: "assistant", text: "推上去之前问一下", at: "0.0", time: null }] })} live />);
  const text = html.replace(/<[^>]+>/g, " ");
  for (const s of ["选择题", "审批", "计划确认", "确认请求", "到 IM 里回答", "回编号"]) expect([s, text.includes(s)]).toEqual([s, false]);
  const order = ["推上去之前问一下", "部署到哪个环境？", `${clock(deadline)} 超时`, "staging", "production", "线上", "git push", "步骤", "切到 TUI 吗？"];
  expect(order.map((s) => text.indexOf(s))).toEqual(order.map((s) => text.indexOf(s)).toSorted((a, b) => a - b));
  expect(text.match(/超时/g)).toHaveLength(1);
  const icons = [...html.matchAll(/<section[^>]*>\s*<div[^>]*>\s*<svg[^>]*class="lucide lucide-([\w-]+)/g)].map((m) => m[1]);
  expect(icons).toHaveLength(4);
  expect(new Set(icons).size).toBe(4);
  for (const label of ["staging", "production", "允许", "拒绝", "批准", "不批准", "切到 TUI", "取消"]) expect(html).toMatch(new RegExp(`<button[^>]*>(<[^>]+>)*${label}`));
  expect(html).toMatch(/<pre[^>]*>git push<\/pre>/);
  // The plan as Markdown.
  expect(html).toMatch(/<h2[^>]*>步骤<\/h2>/);
  expect(html).toMatch(/<span [^>]*data-streamdown="strong"[^>]*>先<\/span>/);
  // Your own words for the choice; a reason with a no where it reaches the agent.
  expect(html.match(/placeholder="自己写"/g)).toHaveLength(1);
  expect(html.match(/placeholder="理由"/g)).toHaveLength(2);
});

test("story 265: the terminal key is at the left of the bar under where you type, whatever the phase; not once archived, where you type kept; not while an ask takes the bar's place, nor in the terminal", () => {
  const terminal = 'aria-label="切到终端"';
  for (const phase of ["off", "idle", "starting", "running", "waiting", "rate_limited", "crashed"] as const) {
    const html = render(<ChatView d={slot({ phase })} log={chat()} live />);
    const at = html.indexOf(terminal);
    // Under the box, left of the + and the key.
    expect([phase, html.indexOf("<textarea") < at, at < html.indexOf('aria-label="添加图片或文件"')]).toEqual([phase, true, true]);
  }
  // An archived one keeps where you type, as a message brings it back; it has no terminal key, as the topology's menu has none,
  // nor the agent and model buttons, whose sheets send /model and /effort on opening, which would bring it back.
  const archived = render(<ChatView d={slot({ phase: "off", archivedAt: 1 })} log={chat()} live />);
  expect([archived.includes("<textarea"), archived.includes(terminal), archived.includes('aria-label="模型和思考强度"'), archived.includes('aria-label="换 agent"')]).toEqual([true, false, false, false]);
  const asks = [choice("A1", "先跑测试，还是先提交？", ["测试", "提交"])];
  expect(render(<ChatView d={slot({ phase: "waiting", asks })} log={chat()} live />)).not.toContain(terminal);
  expect(render(<ChatView d={slot({ mode: "tui" })} log={chat()} live />)).not.toContain(terminal);
});

test("stories 340, 354: a slot in its pane shows the terminal in place of the chat, no banner nor herdr-web; the top bar's 更多 holds 改名, and 收回终端 once open; one still switching to it, or whose Herdr restarts, shows the chat", () => {
  const log = chat({ blocks: [{ kind: "assistant", text: "在终端里接着做", at: "0.0", time: null }] });
  const html = render(<ChatView d={slot({ mode: "tui", pane: "w4Q:p2" })} log={log} live />);
  expect([html.includes("在终端里接着做"), html.includes('aria-label="对话"'), html.includes('aria-label="终端"')]).toEqual([false, false, true]);
  expect(html).not.toMatch(/herdr-web|在终端里（pane/);
  expect(html).toMatch(/<button[^>]*aria-label="更多"/);
  for (const d of [slot({ mode: "tui" }), slot({ mode: "tui", pane: "w4Q:p2", herdrLost: true })]) {
    const chatShown = render(<ChatView d={d} log={log} live />);
    expect([chatShown.includes("在终端里接着做"), chatShown.includes('aria-label="终端"')]).toEqual([true, false]);
  }
  // What the menu holds shows once it opens; its button is all a page drawn on a server has.
  expect(render(<ChatView d={slot()} log={chat()} live />)).toMatch(/<button[^>]*aria-label="更多"/);
  expect(render(<ChatView d={slot()} log={chat()} live />)).not.toContain("收回终端");
});

test("stories 349, 352, 353: the web terminal, closed, asks for its slot afresh and connects again on 4000; says 已在别处打开 and waits on 4001; says why and connects again on 4002; connects again on anything else", () => {
  expect([4000, 4001, 4002, 1000, 1005, 1006, 1011, 4003].map(afterClose)).toEqual(["slot", "elsewhere", "why", "again", "again", "again", "again", "again"]);
});

test("story 353: the web terminal connects again at once, then 1 s on, twice as long each time, 30 s at most", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 40].map(retryIn)).toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});

test("story 340: the page draws the terminal for a slot in the terminal with its pane there and Herdr not restarting", () => {
  expect(inTerminal(slot({ mode: "tui", pane: "w4Q:p2" }))).toBe(true);
  expect(inTerminal(slot())).toBe(false);
  expect(inTerminal(slot({ mode: "tui" }))).toBe(false);
  expect(inTerminal(slot({ mode: "tui", pane: "w4Q:p2", herdrLost: true }))).toBe(false);
});

test("spec web-terminal: what you type goes in frames of 64KB at most as sent, in order, no character cut in two", () => {
  const frames = (text: string) => cut(text).map((d) => JSON.stringify({ t: "in", d }));
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  expect(frames("ls\r")).toEqual(['{"t":"in","d":"ls\\r"}']);
  expect(cut("")).toEqual([]);
  // Each kind of character at each place a frame may end: JSON's escapes, two, three and four bytes, a lone half.
  for (const unit of ["a", "\x1b", '"', "\n", "é", "中", "🙂", "\ud800"]) {
    for (const pad of [0, 1, 2, 3, 5]) {
      const text = "x".repeat(pad) + unit.repeat(70_000) + "end";
      const parts = cut(text);
      expect([unit, pad, parts.join("") === text, parts.length > 1, parts.every((p) => bytes(JSON.stringify({ t: "in", d: p })) <= 64 * 1024)]).toEqual([unit, pad, true, true, true]);
      // A frame full: the next character would not have fit.
      expect(bytes(frames(text)[0]!)).toBeGreaterThan(64 * 1024 - 12);
      if (unit === "🙂") expect(parts.every((p) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p))).toBe(true);
    }
  }
});

test("story 355: a slot in its pane opens to the terminal, the top bar's switch to the chat left of 更多; a slot showing the chat has none", () => {
  const html = render(<ChatView d={slot({ mode: "tui", pane: "w4Q:p2" })} log={chat()} live />);
  expect(html).toMatch(/<button[^>]*aria-label="对话记录"[^>]*>(?:(?!<\/button>).)*lucide-message-square-text/);
  expect(html.indexOf('aria-label="对话记录"')).toBeLessThan(html.indexOf('aria-label="更多"'));
  expect(html).not.toContain('aria-label="对话"');
  for (const d of [slot(), slot({ mode: "tui" }), slot({ mode: "tui", pane: "w4Q:p2", herdrLost: true })]) expect(render(<ChatView d={d} log={chat()} live />)).not.toContain('aria-label="对话记录"');
});

test("story 342: the web terminal's font size is kept on this device, 9 to 20 px; with none kept, one not a number, or storage that cannot be used, 13", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const kept = new Map<string, string>();
  const storage = (s: Partial<Storage>) => Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
  storage({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  try {
    expect(terminalFont()).toBe(13);
    expect([keepTerminalFont(14), terminalFont()]).toEqual([14, 14]);
    expect([keepTerminalFont(21), terminalFont()]).toEqual([20, 20]);
    expect([keepTerminalFont(8), terminalFont()]).toEqual([9, 9]);
    const keptAs = (v: string) => (kept.forEach((_, k) => kept.set(k, v)), terminalFont());
    expect([keptAs("30"), keptAs("3"), keptAs("wide")]).toEqual([20, 9, 13]);
    storage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect([keepTerminalFont(15), terminalFont()]).toEqual([15, 13]);
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("story 270: a running process's line in 详情 has the key that stops it; one exited has none", () => {
  const p = (activeState: string) => ({ unit: "rh-hold-C1", activeState, subState: "running", pid: 42, exitStatus: 0, stderr: [] });
  expect(render(<Details d={slot({ process: p("active") })} />)).toContain('aria-label="停掉进程"');
  expect(render(<Details d={slot({ process: p("failed") })} />)).not.toContain('aria-label="停掉进程"');
});

test("story 264: while a turn runs with asks waiting, the stop key is on the top card alone; with no turn running, none", () => {
  const stop = 'aria-label="停止"';
  const asks = [choice("A1", "先跑测试，还是先提交？", ["测试", "提交"]), choice("A2", "推到哪？", ["main", "dev"])];
  const html = render(<ChatView d={slot({ phase: "waiting", asks })} log={chat()} live />);
  expect(html.match(new RegExp(stop, "g"))).toHaveLength(1);
  expect(html.indexOf(stop)).toBeLessThan(html.indexOf("推到哪？"));
  // A confirm request needs no turn: it is answered with no stop key.
  expect(render(<ChatView d={slot({ phase: "idle", asks })} log={chat()} live />)).not.toContain(stop);
});

test("story 289: a card's answer is as you would reply in IM: the numbers picked, space apart, or your own words; several questions a line each, every one answered", () => {
  expect(answerText([[2]], [""])).toBe("2");
  expect(answerText([[3, 1]], [""])).toBe("1 3");
  expect(answerText([[1]], ["  都不要\n换一个 "])).toBe("都不要\n换一个");
  expect(answerText([[1, 3], []], ["", "明天\n早上"])).toBe("1 3\n明天 早上");
  expect(answerText([[1], []], ["", " "])).toBeNull();
  expect(answerText([[]], [""])).toBeNull();
});

test("story 289: a multiple choice's options are boxes to tick; a single choice's are not", () => {
  const card = {
    questions: [
      { question: "哪些水果？", options: [{ label: "苹果" }, { label: "梨" }], multi: true },
      { question: "什么时候？", options: [{ label: "现在" }, { label: "以后" }], multi: false },
    ],
  };
  const html = render(<ChatView d={slot({ phase: "idle", asks: [{ id: "A1", kind: "question", text: "", deadline: null, card }] })} log={chat()} live />);
  const options = [...html.matchAll(/<button type="button" aria-pressed[^>]*>(.*?)<\/button>/g)].map((m) => [m[1]!.replace(/<[^>]+>/g, ""), /lucide-square[" ]/.test(m[1]!)]);
  expect(options).toEqual([["苹果", true], ["梨", true], ["现在", false], ["以后", false]]);
});

test("stories 264, 272, 278: the chat ends in a place to type, whose key stops a turn under way while nothing is typed; with an ask waiting on you, the ask takes its place, the stop key left; in the terminal, nothing to type", () => {
  const stop = 'aria-label="停止"';
  const send = 'aria-label="发送"';
  const box = "<textarea";
  for (const phase of ["starting", "running", "waiting"] as const) {
    const html = render(<ChatView d={slot({ phase })} log={chat()} live />);
    expect([phase, html.includes(box), html.includes(stop), html.includes(send)]).toEqual([phase, true, true, false]);
  }
  for (const phase of ["off", "idle", "rate_limited", "crashed"] as const) {
    const html = render(<ChatView d={slot({ phase })} log={chat()} live />);
    expect([phase, html.includes(box), html.includes(stop), html.includes(send)]).toEqual([phase, true, false, true]);
  }
  const asks = [choice("A1", "先跑测试，还是先提交？", ["测试", "提交"])];
  const asked = render(<ChatView d={slot({ phase: "waiting", asks })} log={chat()} live />);
  expect([asked.includes(box), asked.includes(stop)]).toEqual([false, true]);
  const tui = render(<ChatView d={slot({ mode: "tui", phase: "off" })} log={chat()} live />);
  expect([tui.includes(box), tui.includes(stop), tui.includes(send)]).toEqual([false, false, false]);
});

test("stories 279, 282: only words for the agent show as a bubble of yours as you send them: ! before them goes; ! alone, a command and anything else the agent takes as a command show none", () => {
  expect(forAgent("hello", 0)).toBe("hello");
  expect(forAgent("!换个做法", 0)).toBe("换个做法");
  expect(forAgent("！ 换个做法", 0)).toBe("换个做法");
  expect(forAgent("", 1)).toBe("");
  expect(forAgent("!", 1)).toBe("");
  for (const t of ["!", "！", "/stop", "/rh_use", "/btw 还在吗", "!/compact"]) expect([t, forAgent(t, 0)]).toEqual([t, null]);
});

test("stories 294, 296: the palette lists every command; as you type on, those whose name starts with it, then those whose name has it, then those whose summary does, in Chinese too", () => {
  const commands = [
    { name: "new", summary: "开一段新对话", kind: "run" as const },
    { name: "compact", summary: "压缩上下文", kind: "run" as const },
    { name: "context", summary: "看上下文用了多少", kind: "run" as const },
    { name: "rh_agent", usage: "claude|pi [!]", summary: "换 agent", kind: "pick" as const },
    { name: "rh_tui", usage: "[!]", summary: "切到 TUI 接着聊", kind: "run" as const },
  ];
  const names = (q: string) => matching(commands, q).map((c) => c.name);
  expect(names("")).toEqual(["new", "compact", "context", "rh_agent", "rh_tui"]);
  expect(names("n")).toEqual(["new", "context", "rh_agent"]);
  expect(names("co")).toEqual(["compact", "context"]);
  expect(names("压缩")).toEqual(["compact"]);
  expect(names("上下文")).toEqual(["compact", "context"]);
  expect(names("TUI")).toEqual(["rh_tui"]);
  expect(names("对话")).toEqual(["new"]);
  expect(names("zz")).toEqual([]);
});

test("stories 297, 302, 412, 413: the page does some commands itself: /rh_agent, /model, /effort and /ultracode alone open the bar's sheets, as their buttons do, but /ultracode on pi; /rh_ls and /rh_help take you there; the rest go as typed", () => {
  const of = (words: string, agent: "claude" | "pi" = "claude") => byPage(words, agent);
  expect([of("/rh_agent"), of("/model"), of("/effort "), of("/ultracode"), of("/model haiku"), of("/rh_agent pi"), of("/status"), of("/constructor")]).toEqual(["agent", "model", "model", "model", null, null, null, null]);
  expect([of("/ultracode", "pi"), of("/model", "pi")]).toEqual([null, "model"]);
  expect([of("/rh_ls"), of("/rh_ls --all"), of("/rh_help"), of("/rh_lsx"), of("/rh_helps")]).toEqual(["ls", "ls", "help", null, null]);
});

test("stories 387, 390, 391: a query's answer and what to pick from go in the info card, the rest in a toast, whatever its lines", () => {
  const card = { command: "context", usedTokens: 1, maxTokens: 2 } as const;
  const panel = { head: ["换哪个模型？"], candidates: [{ label: "Opus", command: "/model opus" }] };
  expect([frame({ ok: true, text: "x", card }), frame({ ok: true, text: "x", panel }), frame({ ok: true, text: "两行\n的回执" }), frame({ ok: false, error: "x" })]).toEqual(["card", "card", "toast", "toast"]);
});

test("story 391: what to pick from is an info card in the page, not over it: its question on top, the rest of what it says, and the candidates, the one now ticked", () => {
  const r = { ok: true as const, text: "", panel: { head: ["回到哪段对话？", "现在：修<登录>"], candidates: [{ label: "修<登录>", command: "/resume s1", current: true }, { label: "写文档", command: "/resume s2" }] } };
  const html = renderToStaticMarkup(<Answer r={r} name="resume" close={() => {}} pick={async () => {}} />);
  expect(html).toMatch(/role="dialog" aria-label="回到哪段对话？"/);
  for (const words of ["现在：修&lt;登录&gt;", "写文档", 'aria-label="现在"', 'aria-label="关闭"']) expect(html).toContain(words);
  expect(html.match(/aria-label="现在"/g)).toHaveLength(1);
});

test("story 391: the model sheet and the agent sheet are info cards too, there only while open", () => {
  const send = () => new Promise<never>(() => {});
  expect(renderToStaticMarkup(<ModelSheet open close={() => {}} send={send} />)).toMatch(/role="dialog" aria-label="模型"/);
  expect(renderToStaticMarkup(<AgentSheet open close={() => {}} agent="claude" turn={false} send={send} />)).toMatch(/role="dialog" aria-label="Agent"/);
  expect(renderToStaticMarkup(<ModelSheet open={false} close={() => {}} send={send} />)).toBe("");
  expect(renderToStaticMarkup(<AgentSheet open={false} close={() => {}} agent="claude" turn={false} send={send} />)).toBe("");
});

test("story 394: a bar goes amber from 80%, red from 95%", () => {
  expect([79, 80, 94, 95].map(tone)).toEqual(["", "warn", "warn", "bad"]);
});

test("story 400: /context's card is a bar, the tokens out of the window and the percentage, what holds them folded, and 压缩", () => {
  const html = renderToStaticMarkup(
    <InfoCard card={{ command: "context", usedTokens: 186_000, maxTokens: 1_000_000, categories: [{ name: "消息", tokens: 132_000 }] }} close={() => {}} run={async () => {}} />,
  );
  for (const words of ["上下文", "186k / 1M", "19%", "压缩"]) expect(html).toContain(words);
  expect(html).not.toContain("消息");
  expect(html).toContain('aria-expanded="false"');
});

test("story 394: a window resets in how long within a day, at a moment further off, 已重置 once past", () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime();
  const h = 3_600_000;
  expect([resetsIn(now + 106 * 60_000, now), resetsIn(now + 23 * h, now), resetsIn(now + 66 * h, now), resetsIn(now - 1, now)]).toEqual(["1 小时 46 分", "23 小时", "10/27 06:00", "已重置"]);
});

test("story 407: Claude's default model shows on /status's card as 默认, the model it uses beside it in grey", () => {
  const card: Info = { command: "status", model: "默认（Opus 5.5）", effort: "high", context: null, ref: "w/a", agent: "claude", dir: "~/w", line: "空闲", actions: [] };
  const html = renderToStaticMarkup(<InfoCard card={card} close={() => {}} run={async () => {}} />);
  expect(html).toMatch(/默认<span class="[^"]*text-muted-foreground[^"]*">Opus 5.5<\/span>/);
  expect(html).not.toContain("（");
});

const SESSION = { cost: 15.35, tokens: { input: 1_800, output: 96_000, cacheRead: 18_200_000, cacheWrite: 612_000, total: 18_909_800 } };

test("stories 393-396: Claude's /usage card is a bar for each window, Claude's other ones too, then this conversation's cost at API prices and its tokens, their kinds folded", () => {
  const card: Info = {
    command: "usage",
    agent: "claude",
    limits: [
      { window: "5h", usedPercent: 28, resetsAt: Date.now() + 106 * 60_000 },
      { window: "7d", model: "Fable", usedPercent: 91, resetsAt: null },
    ],
    extra: { usedPercent: 24.6, used: 12.3, limit: 50, currency: "USD" },
    session: { ...SESSION, models: [{ name: "Opus 5.5", cost: 14.92, tokens: SESSION.tokens }] },
  };
  const html = renderToStaticMarkup(<InfoCard card={card} close={() => {}} run={async () => {}} />);
  for (const words of ["用量", "Claude 额度", "5 小时", "28%", "1 小时 46 分", "7 天 Fable", "91%", "额外用量", "$12.30 / $50.00", "当前对话", "$15.35", "等效 API 价格", "18.9M"]) expect(html).toContain(words);
  for (const folded of ["缓存读", "Opus 5.5"]) expect(html).not.toContain(folded);
  expect(html).not.toContain("压缩");
});

test("story 397: pi's /usage card is this conversation alone, its cost with nothing beside it", () => {
  const html = renderToStaticMarkup(<InfoCard card={{ command: "usage", agent: "pi", limits: [], session: SESSION }} close={() => {}} run={async () => {}} />);
  for (const words of ["当前对话", "$15.35", "18.9M"]) expect(html).toContain(words);
  for (const none of ["Claude 额度", "等效 API 价格"]) expect(html).not.toContain(none);
});

test("story 500: Codex's /usage card has its credits left to two places, and this conversation's tokens with no cost", () => {
  const card: Info = { command: "usage", agent: "codex", limits: [{ window: "7d", usedPercent: 35, resetsAt: null }], credits: 58572.7492495, session: { tokens: SESSION.tokens } };
  const html = renderToStaticMarkup(<InfoCard card={card} close={() => {}} run={async () => {}} />);
  for (const words of ["Codex 额度", "7 天", "35%", "credits 余额", "58572.75", "当前对话", "18.9M"]) expect(html).toContain(words);
  for (const none of ["费用", "$", "58,572"]) expect(html).not.toContain(none);
});

test("#419: the /usage card names the quota after the slot's agent, its logo beside it", () => {
  const card: Info = { command: "usage", agent: "pi", limits: [{ window: "5h", usedPercent: 28, resetsAt: null }], session: SESSION };
  const html = renderToStaticMarkup(<InfoCard card={card} close={() => {}} run={async () => {}} />);
  expect(html).toContain("pi 额度");
  expect(html).not.toContain("Claude");
});

test("story 306: 详情 has the slot's timeline, folded; each conversation but the one now has 回到这段, which a turn under way leaves untappable", () => {
  const ep = (id: string, current = false) => ({ id, short: id.toLowerCase(), agent: "claude" as const, startedAt: 0, lastWrite: 0, title: `t${id}`, current });
  const timeline = [ep("C2", true), ep("C1")];
  const backs = (phase: SlotData["phase"]) => render(<Details d={slot({ phase, timeline })} />).match(/<button[^>]*aria-label="回到这段"[^>]*>/g) ?? [];
  expect(backs("idle")).toHaveLength(1);
  expect(backs("idle")[0]).not.toContain('disabled=""');
  expect(backs("running")[0]).toContain('disabled=""');
  expect(render(<Details d={slot({ timeline })} />)).toMatch(/<details[^>]*><summary[^>]*>时间线<span[^>]*>2<\/span><\/summary>/);
});

/** A message of yours sent from the board, as the page keeps it until the transcript has it. */
const sent = (text: string, o: Partial<Sent> = {}): Sent => ({ id: text, text, words: text, files: [], from: 10, ...o });
const yours = (text: string, at: number, source: string | null = "网页"): Block => ({ kind: "user", text, source, from: null, at: `${at}.0`, time: 0 });

test("story 273: what you send shows at once as a faint bubble of yours, until the transcript has it; one not taken is red, why under it, with a retry", () => {
  const html = render(<ChatView d={slot()} log={chat({ sent: [sent("还有一件事"), sent("顺便看看日志", { failed: "w/c 有提问在等你，先答提问。" })] })} live />);
  const bubble = (text: string) => html.match(new RegExp(`<div class="([^"]*)"><p[^>]*>${text}</p>`))![1]!;
  expect(bubble("还有一件事")).toContain("opacity-");
  expect(bubble("顺便看看日志")).toContain("border-destructive");
  expect(html.match(/aria-label="重试"/g)).toHaveLength(1);
  // Its buttons under it, on the line with why, so the bubble keeps its width on a phone; pulled
  // out by their padding, so the retry icon sits on the bubble's right edge.
  expect(html).toMatch(/顺便看看日志<\/p><\/div><div class="-mr-3\.5 [^"]*"><p[^>]*>w\/c 有提问在等你，先答提问。<\/p><button[^>]*aria-label="不发了"/);

  // Each finds its own, in order, among yours from the board written since it was sent.
  const a = sent("again");
  const b = sent("again");
  expect(unread([a, b], [yours("again", 5), yours("again", 12)])).toEqual([b]);
  expect(unread([a, b], [yours("again", 12), yours("again", 14)])).toEqual([]);
  // Not one from IM, nor one whose words differ; a picture's line follows the words.
  expect(unread([a], [yours("again", 12, "QQ 私聊"), yours("other", 13)])).toEqual([a]);
  expect(unread([sent("看看这张图")], [yours("看看这张图\n[图片] /m/1", 12)])).toEqual([]);
  // The block that confirmed one confirms no other on later updates: two the same, or two with no words.
  for (const text of ["again", ""]) {
    const [c, d] = [sent(text), sent(text)];
    const blocks = [yours(text || "[图片] /m/1", 12)];
    expect(unread([c, d], blocks)).toEqual([d]);
    expect(unread([d], [...blocks, { kind: "assistant", text: "ok", at: "13.0", time: 0 }])).toEqual([d]);
  }
  // A red one stays until you retry it or let it go.
  const red = sent("again", { failed: "连不上 Rhodium。" });
  expect(unread([red], [yours("again", 12)])).toEqual([red]);
});

test("story 273: the transcript brings what you sent: its bubble goes, and the transcript's is there", async () => {
  jest.useRealTimers();
  const pages: MessagesData[] = [
    { conversation: "C1", blocks: [], start: 0, end: 10 },
    { conversation: "C1", blocks: [yours("还有一件事", 10)], start: 10, end: 20 },
    { conversation: "C1", blocks: [], start: 20, end: 20 },
  ];
  const log = new Messages("S1", async () => pages.shift()!);
  await log.newer();
  log.sent.push(sent("还有一件事", { from: log.end }));
  await log.newer();
  expect(log.sent).toEqual([]);
  expect(log.blocks).toHaveLength(1);
});

test("story 280: your message from the board is a bubble as one typed in the terminal: no avatar, no source", () => {
  const html = render(<ChatView d={slot()} log={chat({ blocks: [yours("hi", 0)] })} live />);
  expect(html).toContain(">hi</p>");
  expect(html).not.toMatch(/<img|网页/);
});

test("#512: in your bubbles, the transcript's and one still sending, a long run with no space (a path, a hash, a URL) breaks anywhere to fill each line; words, English too, break as before", () => {
  const path = "/var/lib/quokka/media/9f2c4e1ab07d3c58e6f1a2b4c9d0e7f3.png";
  const text = `截图（全屏）：${path} 看看 Rhodium 的 internationalization`;
  const html = render(<ChatView d={slot()} log={chat({ blocks: [yours(text, 0)], sent: [sent(text)] })} live />);
  expect(html.split(`>截图（全屏）：<span class="break-all">${path}</span> 看看 Rhodium 的 internationalization</p>`)).toHaveLength(3);
});

test("story 277: what you typed and did not send is kept by slot on this device; where it cannot be, there is none", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    keepDraft("S1", "写了一半");
    expect(draft("S1")).toBe("写了一半");
    expect(draft("S2")).toBe("");
    expect(shown(<ChatView d={slot()} log={chat()} live />)).toContain("写了一半");
    keepDraft("S1", "");
    expect(kept.size).toBe(0);
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  expect(draft("S1")).toBe("");
});

test("story 282: one key, whose icon says what pressing it does now: with no turn, send; with one, stop with nothing typed, queue what you typed, interrupt and send it with ! before it, and send a command Rhodium knows at once", () => {
  expect(keyMode(false, "hi", 0)).toBe("send");
  expect(keyMode(false, "", 0)).toBe("send");
  expect(keyMode(true, "", 0)).toBe("stop");
  expect(keyMode(true, "!", 0)).toBe("stop");
  expect(keyMode(true, "", 1)).toBe("queue");
  expect(keyMode(true, "顺便看看日志", 0)).toBe("queue");
  // A command the agent runs waits as words do.
  expect(keyMode(true, "/btw 还在吗", 0)).toBe("queue");
  expect(keyMode(true, "!换个做法", 0)).toBe("interrupt");
  expect(keyMode(true, "！ 换个做法", 0)).toBe("interrupt");
  expect(keyMode(true, "!", 1)).toBe("interrupt");
  // Those the board does elsewhere too: they only say where.
  for (const t of ["/stop", "/model", "/rh_agent pi", "/rh_use", "/rh-ls", "!/stop"]) expect([t, keyMode(true, t, 0)]).toEqual([t, "send"]);

  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    for (const [typed, label] of [["", "停止"], ["顺便看看日志", "排队"], ["!换个做法", "打断再发"], ["/stop", "发送"]]) {
      keepDraft("S1", typed!);
      expect([typed, render(<ChatView d={slot()} log={chat()} live />).match(/aria-label="(停止|排队|打断再发|发送)"/)?.[1]]).toEqual([typed, label]);
    }
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

/** What fullEsc makes of each step in turn, each step the page's fullscreen as the key comes, and the key. */
function escs(...steps: [full: Parameters<typeof fullEsc>[1], key: EscKey][]) {
  let held: number | null = null;
  return steps.map(([full, key]) => {
    const r = fullEsc(key, full, held);
    held = r.held;
    return r.then;
  });
}
const down = (at: number, more: Partial<EscKey> = {}): EscKey => ({ type: "keydown", at, repeat: false, composing: false, ...more });
const up = (at: number): EscKey => ({ type: "keyup", at, repeat: false, composing: false });

test("story 448: in fullscreen with Esc locked, a press counts once let go within half a second, sent on to where it was pressed; held longer, never", () => {
  expect(escs(["locked", down(0)], ["locked", up(120)])).toEqual(["drop", "send"]);
  expect(escs(["locked", down(0)], ["locked", up(499)])).toEqual(["drop", "send"]);
  expect(escs(["locked", down(0)], ["locked", up(500)])).toEqual(["drop", "pass"]);
  // Held, the browser sends it over and over; none counts, nor does the let-go, however soon after the last.
  expect(escs(["locked", down(0)], ["locked", down(400, { repeat: true })], ["locked", down(430, { repeat: true })], ["locked", down(2080, { repeat: true })], ["locked", up(2100)])).toEqual(["drop", "drop", "drop", "drop", "pass"]);
  // Held until the browser leaves fullscreen: what it sends on after does not count either, until let go.
  expect(escs(["locked", down(0)], [false, down(2000, { repeat: true })], [false, down(2030, { repeat: true })], [false, up(2200)], [false, down(3000)])).toEqual(["drop", "drop", "drop", "pass", "pass"]);
  // A press whose let-go never came, the window left meanwhile: the next press counts.
  expect(escs(["locked", down(0)], [false, down(9000)])).toEqual(["drop", "pass"]);
});

test("story 448: not in fullscreen, Esc counts as pressed; in fullscreen without the lock, the browser's to leave by, the page drops it", () => {
  expect(escs([false, down(0)], [false, up(100)])).toEqual(["pass", "pass"]);
  expect(escs([false, down(0)], [false, down(400, { repeat: true })], [false, up(900)])).toEqual(["pass", "pass", "pass"]);
  expect(escs(["unlocked", down(0)], ["unlocked", up(100)])).toEqual(["drop", "pass"]);
});

test("story 448: an input method's Esc, cancelling its word, goes as it is in fullscreen, not held back or sent again; nor is its let-go, which no longer says so", () => {
  for (const full of ["locked", "unlocked"] as const) expect([full, escs([full, down(0, { composing: true })], [full, up(100)])]).toEqual([full, ["pass", "pass"]]);
});

test("stories 283, 285, 286: the queue sits above where you type, with how many wait; each a line with 插话, 编辑 and 删除; paused, a pause sign with 继续, and 发送 for 插话; one with files has a clip and no 编辑; one Rhodium holds has only 删除, why under it", () => {
  const queue: SlotData["queue"] = [
    { id: "R1", text: "顺便看看日志", files: 0, reason: "web_queue" },
    { id: "R2", text: "看看这个", files: 1, reason: "web_queue" },
    { id: "R3", text: "换个做法", files: 0, reason: "after_interrupt" },
  ];
  // What is in the queue shows there, not as a faint bubble too.
  const html = render(<ChatView d={slot({ queue })} log={chat({ sent: [sent("顺便看看日志", { id: "R1" }), sent("还有一件事")] })} live />);
  const box = html.slice(html.indexOf('aria-label="待发队列"'));
  expect(html.indexOf("还有一件事")).toBeLessThan(html.indexOf('aria-label="待发队列"'));
  expect(html.match(/顺便看看日志/g)).toHaveLength(1);
  expect(box.replace(/^[^>]*>/, "").replace(/<[^>]+>/g, " ")).toMatch(/^\s*3\s+顺便看看日志/);
  const count = (label: string) => box.match(new RegExp(`aria-label="${label}"`, "g"))?.length ?? 0;
  expect([count("插话"), count("编辑"), count("删除"), count("继续"), count("附件")]).toEqual([2, 1, 3, 0, 1]);
  expect(box).toContain("等打断生效");
  const paused = render(<ChatView d={slot({ phase: "idle", queue: queue.slice(0, 1).map((q) => ({ ...q, reason: "web_paused" as const })) })} log={chat()} live />);
  const p = paused.slice(paused.indexOf('aria-label="待发队列"'), paused.indexOf("<textarea"));
  expect([p.includes('aria-label="继续"'), p.includes('aria-label="插话"'), p.includes('aria-label="发送"'), p.includes('aria-label="暂停了"')]).toEqual([true, false, true, true]);
  expect(render(<ChatView d={slot()} log={chat()} live />)).not.toContain("待发队列");
});

test("story 287: what Rhodium gives back from the queue goes where you type to that slot, after what is there, and a toast says why", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    keepDraft("S1", "写了一半");
    givenBack("S1", "顺便看看日志", "切到 TUI 了");
    givenBack("S1", "再跑一遍测试", "切到 TUI 了");
    expect(draft("S1")).toBe("写了一半\n顺便看看日志\n再跑一遍测试");
    expect(shown(<Toasts />)).toContain("切到 TUI 了");
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("story 256: a write's result shows in a toast at the bottom; one that went well goes after 3 s", () => {
  toast("已停下这一回合，对话留着。");
  expect(shown(<Toasts />)).toContain("已停下这一回合，对话留着。");
  jest.advanceTimersByTime(2_900);
  expect(shown(<Toasts />)).toContain("已停下这一回合，对话留着。");
  jest.advanceTimersByTime(200);
  expect(shown(<Toasts />)).not.toContain("已停下");
});

test("story 268: a toast with an undo has 撤销 and stays 8 s, a bar along its foot running out", () => {
  toast("已归档 w/c，对话保留。", false, { kind: "bind", unarchive: "S1", changes: [] });
  const html = render(<Toasts />);
  expect(html).toContain("撤销");
  expect(html).toMatch(/class="[^"]*animate-undo[^"]*" style="animation-delay:-?\d+ms"/);
  jest.advanceTimersByTime(7_900);
  expect(shown(<Toasts />)).toContain("已归档 w/c");
  jest.advanceTimersByTime(200);
  expect(shown(<Toasts />)).not.toContain("已归档");
});

test("story 257: a write whose answer is lost mid-body goes again with the same id; lost each time, it says 连不上", async () => {
  jest.useRealTimers();
  const lost = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("lost")) }));
  const sent: string[] = [];
  const fetched = globalThis.fetch;
  const answers = [lost, () => Response.json({ ok: true, text: "已停下这一回合，对话留着。" })];
  globalThis.fetch = (async (_: string, init: RequestInit) => (sent.push(init.body as string), answers.shift()!())) as unknown as typeof fetch;
  try {
    expect(await act({ kind: "common", slot: "S1", name: "stop" })).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]!);
    answers.push(lost, lost, lost);
    expect(await act({ kind: "common", slot: "S1", name: "stop" })).toEqual({ ok: false, error: "连不上 Rhodium。" });
  } finally {
    globalThis.fetch = fetched;
  }
});

test("spec web-write: what the agent says shows raw HTML as it is written, and links only to http or https; any other is plain words", () => {
  const text = '看 <img src=x onerror="alert(1)"> 这里，[点我](javascript:alert(1))，[官网](https://example.com/)，<b>粗</b>\n\n<script>alert(2)</script>';
  const blocks: Block[] = [{ kind: "assistant", text, at: "0.0", time: null }];
  const html = render(<ChatView d={slot()} log={chat({ blocks, drafts: [{ text, whole: false }] })} live />);
  expect(html).not.toMatch(/<img|<script|<b>|javascript:/);
  expect(html.match(/&lt;img src=x onerror=/g)).toHaveLength(2);
  expect(html.match(/&lt;script&gt;alert\(2\)/g)).toHaveLength(2);
  expect(html.match(/<a [^>]*href="https:\/\/example\.com\/"/g)).toHaveLength(2);
  expect(html).not.toMatch(/<a [^>]*>点我/);
  expect(html.replace(/<[^>]+>/g, "").match(/点我/g)).toHaveLength(2);
});

test("story 204: while the event stream is down, a slot's chat says 已断开 in its top bar", () => {
  expect(shown(<ChatView d={slot()} log={chat()} live={false} />)).toContain("已断开");
});

test("story 191: a slot's page draws its top bar, with the way back, before its answers come", () => {
  const html = render(<SlotPage id="S1" live={false} />);
  expect(html).toContain('aria-label="全部槽位"');
  expect(html).toContain("已断开");
});

test("a slot's page for a slot that is not there says so", async () => {
  jest.useRealTimers();
  // Its answer has come, and is drawn before asking again. The page is the visit after the last.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  await client.prefetchQuery({ queryKey: ["slot", "gone", visits + 1], queryFn: () => Promise.reject(Object.assign(new Error("404"), { status: 404 })) });
  expect(render(<SlotPage id="gone" live />, client)).toContain("没有这个槽位");
});

test("#255: a slot in the terminal names its pane nowhere; its top bar says TUI 模式", () => {
  const text = shown(<ChatView d={slot({ mode: "tui", state: "TUI 模式（pane w4Q:p2）", pane: "w4Q:p2", model: "Opus" })} log={chat()} live />);
  expect(text).not.toContain("w4Q:p2");
  expect(text).toContain("TUI 模式");
  expect(text).not.toContain("Opus");
});

test('no line strings its parts together with "·", "|" or wide spaces: it says them as a sentence, or puts each on its own line (im-style §1)', () => {
  const cut = { ...call(10, "Read"), shown: { name: "Read", arg: "README.md", code: true } } as Block & { kind: "tool" };
  cut.result!.length = 3000;
  const running = { ...call(20, "Bash", null, Date.now() - 12_000), shown: { name: "Bash", arg: "bun test", code: true } };
  const ask = choice("A1", "部署到哪个环境？", ["staging", "production"], Date.now() + 60_000);
  const process = { unit: "rh-hold-C1", activeState: "failed", subState: "failed", pid: 42, exitStatus: 1, stderr: ["boom"] };
  const board = shown(
    <BoardView
      data={{
        bots: [],
        workspaces: [
          ws("w", { needsYou: [card({ name: "boss", state: "需要你" })], running: [card({ name: "kid", parent: "w/boss", lifetime: "oneoff", last: { role: "user", text: "go", at: 0 } })] }),
          ws("x", { done: [card({ name: "one", turnEndedAt: 0 }, "x")] }, [card({ name: "old", archivedAt: 0 }, "x")]),
        ],
      }}
    />,
  );
  const chatPage = shown(<ChatView d={slot({ model: "Opus", asks: [ask] })} log={chat({ blocks: [words(0, "user"), cut, running] })} live={false} />);
  const details = shown(<Details d={slot({ process })} />);
  const rhodium = shown(<RhodiumView d={{ boot: 3, pid: 9, startedAt: 0, unit: "rhodium", bots: [], logs: [] }} />);
  for (const text of [board, chatPage, details, rhodium]) for (const joint of ["·", "|", "\u2003"]) expect(text).not.toContain(joint);
  expect(chatPage).toMatch(/已断开。\s*运行中\s/);
  for (const s of ["超时", "看全文（共 3000 字）", "12 秒"]) expect(chatPage).toContain(s);
  // How long the call has run is on its own, not strung on with a comma.
  expect(chatPage).not.toContain("，跑了");
  expect(rhodium).toMatch(/第 3 次启动，[^\n]+\nPID 9\n服务 rhodium/);
});

test("story 147: Rhodium's page lists each bot as connected or not, and its log", () => {
  const bots = [
    { name: "q", platform: "qq" as const, state: "online" as const },
    { name: "t", platform: "telegram" as const, state: "reconnecting" as const },
  ];
  const text = shown(<RhodiumView d={{ boot: 3, pid: 9, startedAt: 0, unit: "rhodium", bots, logs: [{ at: 0, line: "ready" }] }} />);
  for (const s of ["第 3 次启动", "q", "已连上", "t", "重连中", "ready"]) expect(text).toContain(s);
});

test("#286: the theme button goes 跟随系统, 浅色, 深色 and round again; the choice is kept on this device and set on the page, 跟随系统 keeping none; storage that cannot be used follows the system", () => {
  expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  const real = { localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
  const stored = new Map<string, string>();
  const root = { dataset: {} as Record<string, string> };
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true });
  try {
    define("document", { documentElement: root });
    define("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
    expect(THEME.get()).toBe("system");
    THEME.set("dark");
    expect([THEME.get(), root.dataset.theme]).toEqual(["dark", "dark"]);
    THEME.set("light");
    expect([THEME.get(), root.dataset.theme]).toEqual(["light", "light"]);
    THEME.set("system");
    expect([THEME.get(), root.dataset.theme, stored.size]).toEqual(["system", undefined, 0]);
    define("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(THEME.get()).toBe("system");
    THEME.set("dark");
    expect(root.dataset.theme).toBe("dark");
  } finally {
    for (const [name, d] of Object.entries(real)) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test("#286: the header's dot is green while the stream is open and the round trip is quick, amber over 300ms, grey while connecting or reconnecting", () => {
  expect([dotOf(true, null), dotOf(true, 38), dotOf(true, 300), dotOf(true, 301), dotOf(false, 38), dotOf(null, null)]).toEqual(["bg-done", "bg-done", "bg-done", "bg-needs", "bg-idle", "bg-idle"]);
});
