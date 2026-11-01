// How the page gets its data from rhodium's board (src/board.ts, which has what each path answers)
// and keeps it live.
import { QueryClient } from "@tanstack/react-query";
import type { Block, MessagesData, SlotEvent } from "../../src/board";
import { FROM_BOARD } from "../../src/contracts";

export type { Block, BoardData, Card, Command, Episode, MessagesData, RhodiumData, SlotData, SlotEvent, TopologyData } from "../../src/board";

/** When the page last loaded itself again, and for which build, as this tab keeps it; null for
 *  storage that cannot be used. */
export function lastReload(): { at: number; build: string | null } | null {
  try {
    return { at: Number(sessionStorage.getItem("reloaded")), build: sessionStorage.getItem("reloadedFor") };
  } catch {
    return null;
  }
}
/** Loads the page again, at the same address, for build if given. Stamps first, so storage that throws
 *  means no reload, not a loop. */
export function reload(build: string | null) {
  try {
    sessionStorage.setItem("reloaded", String(Date.now()));
    if (build) sessionStorage.setItem("reloadedFor", build);
  } catch {
    return;
  }
  location.reload();
}
/** Loads the page again, unless it did within 10 s, for whatever reason: one that comes back the same
 *  never loops (reloadNow). */
export function reloadAgain() {
  const last = lastReload();
  if (last && Date.now() - last.at >= 10_000) reload(null);
}

/** fetch, saying the request is the page's own (X-Requested-With): a login proxy in front of the board
 *  (ADR-0013) whose session ran out then answers 401, not with its login page, as Cloudflare Access
 *  does. Rhodium itself never answers 401, so the page loads itself again, which brings the login. */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-requested-with", "XMLHttpRequest");
  const r = await fetch(url, { ...init, headers });
  if (r.status === 401) reloadAgain();
  return r;
}

/** Asks whether the login of a proxy in front still holds, as request does, when the event stream or
 *  the terminal could not connect: neither can say it is the page's, nor tell a 401. */
export const loginHolds = () => void request("api/ping", { cache: "no-store" }).catch(() => {});

/** GETs a path of the API; an answer other than 200 throws, with its status. init: as for one fetched
 *  ahead, its low priority, which gives way to the rest, or its signal, which stops it. */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await request(url, { cache: "no-store", ...init });
  if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

/** The answers shown. A failed one is not retried: the next event or the clock asks again. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Fetches afresh what is shown. A request still out is dropped, so an answer that comes back late
 *  never replaces a newer one. */
export const refresh = () => queryClient.invalidateQueries();

/** What is told what the stream of the slot whose page it is says of its conversation (architecture
 *  §7.7), its chat: grew, its transcript grew; delta, with text, the agent wrote that; said, the message
 *  it wrote is whole; exit, its process ended; open, the stream opened, which it may have been down,
 *  missing some. */
export const heard = new Set<(what: string, text?: string) => void>();

/** How many things heard has been told: a chat drawn again with none told since it went missed nothing. */
export let heardCount = 0;
const tell = (what: string, text?: string) => (heardCount++, heard.forEach((f) => f(what, text)));

/** What is told each event of the event table the stream brings, as it comes: a chat takes back what
 *  Rhodium gave back from its queue (story 287). */
export const seen = new Set<(e: { type: string; slot: string | null; trace: string | null; data: unknown }) => void>();

/** What is told the page rhodium serves, each time the event stream opens: the script its HTML loads
 *  first, which names its build; null with none built. */
export const builds = new Set<(entry: string | null) => void>();

/** How many of the page's POSTs are still out (web/src/write.tsx post), as a send with a picture going
 *  up a slow link: what loading the page again would cut off. */
export const posting = { count: 0 };

/** Whether a message you sent failed and waits, red to try again, in a chat the page keeps (web/src/slot.tsx
 *  says): one loading the page again would lose. */
export const unsent = { any: () => false };

/** Whether the page loads itself again now (architecture §2): mine and served, the entry script of its
 *  own build and of the one rhodium serves. Only when you are back: it came in front, or loaded, and
 *  you have done nothing since; and busy with nothing (typing, a sheet or menu open, a send going).
 *  Never within 10 s of the time before (last.at), for whatever reason, nor twice for one build
 *  (last.build): a page loaded again that still differs, as from a cache, never loops. */
export function reloadNow(mine: string | null, served: string | null, you: { back: boolean; busy: boolean }, last: { at: number; build: string | null }, now: number): boolean {
  return mine !== null && served !== null && served !== mine && served !== last.build && now - last.at >= 10_000 && you.back && !you.busy;
}

/** Whether the page may fetch ahead what you have yet to open (#356): not while the browser saves data. */
export const mayPrefetch = (nav: Navigator = navigator) => !(nav as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

let idle: Promise<void> | undefined;
/** Resolves once the page has loaded, the API has no answer out and the browser is idle; asked first,
 *  it starts looking. */
export const settled = () =>
  (idle ??= new Promise<void>((resolve) => {
    const look = () => {
      if (document.readyState !== "complete" || queryClient.isFetching()) return void setTimeout(look, 200);
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 2_000 });
      else setTimeout(resolve, 200);
    };
    look();
  }));

/** Fetches ahead, one at a time and at low priority, the files of the chat and the topology view the
 *  first screen did not load, as its HTML lists them (web/vite.config.ts), into the browser's cache: once
 *  the page is idle, each when the API has no answer out. Not while the browser saves data. Says whether
 *  every one came. */
export async function prefetch(): Promise<boolean> {
  const files = document.querySelector<HTMLMetaElement>('meta[name="later"]')?.content.split(" ").filter(Boolean) ?? [];
  await settled();
  let all = true;
  for (const f of files) {
    while (queryClient.isFetching()) await new Promise((r) => setTimeout(r, 500));
    if (!mayPrefetch()) return false;
    const came = await request(f, { priority: "low" })
      .then(async (r) => (await r.blob(), r.ok))
      .catch(() => false);
    all &&= came;
  }
  return all;
}

/** Calls changed() whenever what the page shows may have changed: when the event stream opens, as
 *  events may have been missed, after each burst of events, and every minute, as the clock moves
 *  slots from done to idle with no event. live(on) says whether the stream is open. On slot's page,
 *  the stream also says what heard is told. Returns a function that stops it all. */
export function follow(changed: () => void, live: (on: boolean) => void, slot?: string): () => void {
  let events: EventSource;
  let burst: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    events = new EventSource(slot ? `api/events?slot=${encodeURIComponent(slot)}` : "api/events");
    events.onopen = () => (live(true), changed(), tell("open"));
    events.onmessage = (m) => {
      clearTimeout(burst);
      burst = setTimeout(changed, 200);
      const e = JSON.parse(m.data);
      if (e.type) seen.forEach((f) => f(e));
    };
    events.addEventListener("page", (e) => {
      const { entry } = JSON.parse((e as MessageEvent<string>).data) as { entry: string | null };
      builds.forEach((f) => f(entry));
    });
    // Not in the event table: told to the chat alone, and the rest of the page stays.
    for (const what of ["grew", "delta", "said", "exit"]) {
      events.addEventListener(what, (e) => {
        const { text } = JSON.parse((e as MessageEvent<string>).data) as { text?: string };
        tell(what, text);
      });
    }
    events.onerror = () => {
      live(false);
      // Rhodium may come back with another build, or none: not known till the stream opens again.
      builds.forEach((f) => f(null));
      // The browser retries a dropped stream itself, but gives up for good on any reply other than
      // 200, such as tailscale serve's 502 while rhodium restarts, or a login proxy's redirect to its
      // login. Then open a new one; its onopen brings the page up to date, so nothing is missed.
      if (events.readyState !== EventSource.CLOSED) return;
      loginHolds();
      retry = setTimeout(connect, 3000);
    };
  };
  connect();
  const minute = setInterval(changed, 60_000);
  return () => {
    events.close();
    clearTimeout(burst);
    clearTimeout(retry);
    clearInterval(minute);
  };
}

/** A message of yours sent from this page (story 273), until the transcript has it: id, its request's,
 *  which a retry sends again; words, as you typed them; text, what the transcript will show of them;
 *  files, what you attached; from, where the transcript ended as you sent it. failed: why it was not
 *  taken, or is not known to be. */
export type Sent = { id: string; text: string; words: string; files: File[]; from: number; failed?: string };

/** Those sent not yet in the transcript: each finds its own, in order, among your messages from the
 *  board written since it was sent, by its words, which what you attached follows. A failed one stays.
 *  Those after one found are sent after its message, so no later update takes that one for theirs. */
export function unread(sent: Sent[], blocks: Block[]): Sent[] {
  let past = 0;
  return sent.filter((s) => {
    s.from = Math.max(s.from, past);
    if (s.failed !== undefined) return true;
    const b = blocks.find((b) => b.kind === "user" && b.source === FROM_BOARD && line(b) >= s.from && b.text.startsWith(s.text));
    if (!b) return true;
    past = line(b) + 1;
    return false;
  });
}

/** A slot's conversation as shown: its message blocks (architecture §7.7), and where the pages before
 *  and after them begin. Blocks paged back stay as new ones come. After them, drafts: what the agent
 *  writes ahead of its transcript, a message each, whole once it is done. Each thing the agent said
 *  that the transcript brings takes the place of the first whole one. Last, what you sent from here
 *  that the transcript has yet to bring. */
export class Messages {
  conversation: string | null = null;
  blocks: Block[] = [];
  drafts: { text: string; whole: boolean }[] = [];
  sent: Sent[] = [];
  /** How many drafts have begun: one begun is new, one that goes is not. */
  begun = 0;
  start = 0;
  end = 0;
  /** Whether the newest page has come. */
  loaded = false;

  /** of: a conversation of the slot's, by id, rather than its current one. */
  constructor(
    private readonly slot: string,
    private readonly get: (url: string) => Promise<MessagesData> = json,
    private readonly of?: string,
  ) {}

  private get url() {
    return this.of ? `api/messages?conversation=${encodeURIComponent(this.of)}` : `api/messages?slot=${encodeURIComponent(this.slot)}`;
  }

  /** Brings the blocks written since; the newest page at first, or once the slot has a new conversation. */
  async newer(): Promise<void> {
    // A turn may write many pages between two events, which come only as it starts and ends: read on
    // until a page brings nothing new.
    while (this.loaded) {
      const p = await this.get(`${this.url}&after=${this.end}`);
      if (p.conversation !== this.conversation) break;
      if (p.end <= this.end) return;
      // Two updates may ask from the same place: each block goes in once.
      const added = p.blocks.filter((b) => line(b) >= this.end);
      this.blocks = [...this.blocks, ...added];
      this.end = p.end;
      for (const b of added) if (b.kind === "assistant" && this.drafts[0]?.whole) this.drafts.shift();
      this.sent = unread(this.sent, this.blocks);
    }
    const p = await this.get(this.url);
    // A whole draft may be on the page. Another conversation's drafts are of the one left; what you
    // sent may be in the new one, from its start.
    const other = this.loaded && p.conversation !== this.conversation;
    const drafts = other ? [] : this.drafts.filter((d) => !d.whole);
    if (other) for (const s of this.sent) s.from = 0;
    Object.assign(this, { conversation: p.conversation, blocks: p.blocks, start: p.start, end: p.end, loaded: true, drafts });
    this.sent = unread(this.sent, this.blocks);
  }

  /** Takes what the stream says the agent writes (heard): delta, text; said, the message is whole; exit,
   *  its process ended, and the draft not whole goes, as the transcript never has it and the next
   *  process writes anew; open, the stream opened, which may have missed some, and the drafts go. The
   *  transcript has it all. */
  wrote(what: string, text = ""): void {
    const last = this.drafts.at(-1);
    if (what === "open") this.drafts = [];
    else if (what === "exit" && last && !last.whole) this.drafts.pop();
    else if (what === "said" && last) last.whole = true;
    else if (what === "delta" && last && !last.whole) last.text += text;
    else if (what === "delta") {
      this.drafts.push({ text, whole: false });
      this.begun++;
    }
  }

  /** Brings the page before the blocks shown. */
  async older(): Promise<void> {
    const p = await this.get(`${this.url}&before=${this.start}`);
    if (p.conversation !== this.conversation) return;
    this.blocks = [...p.blocks.filter((b) => line(b) < this.start), ...this.blocks];
    this.start = Math.min(this.start, p.start);
  }
}

/** Where a block's line begins in the transcript: its at up to the dot. */
const line = (b: Block) => parseInt(b.at);

/** A slot's events in 详情 (spec web-topology): oldest first, the newest page as it is now and the
 *  pages before it, brought as you scroll up. */
export class Events {
  list: SlotEvent[] = [];
  /** Whether the slot's first event has come. */
  first = false;

  constructor(
    private readonly slot: string,
    private readonly get: (url: string) => Promise<SlotEvent[]> = json,
  ) {}

  private get url() {
    return `api/slot-events?id=${encodeURIComponent(this.slot)}`;
  }

  /** Brings the newest page: the events after those shown, and those shown on it as they are now,
   *  say a send's outcome. With none in common, as after the stream was down for a page of events,
   *  it starts over from it. */
  async newest(): Promise<void> {
    const page = await this.get(this.url);
    const from = page[0]?.seq ?? Infinity;
    if (from <= (this.list.at(-1)?.seq ?? -Infinity)) this.list = [...this.list.filter((e) => e.seq < from), ...page];
    else Object.assign(this, { list: page, first: false });
  }

  /** Brings the page before the events shown; says whether there may be more. */
  async older(): Promise<boolean> {
    const start = this.list[0]?.seq;
    if (start === undefined || this.first) return false;
    const page = await this.get(`${this.url}&before=${start}`);
    // Brought meanwhile, or started over: ask again from where it is now.
    if (this.list[0]?.seq !== start) return true;
    if (!page.length) {
      this.first = true;
      return false;
    }
    this.list = [...page, ...this.list];
    return true;
  }
}
