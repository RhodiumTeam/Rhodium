// A slot's chat (product §7, spec web-chat): what you and the agent said, newest at the bottom, paged
// back as you scroll up. Its process, stderr and last events, which say whether a slot that seems
// stuck is thinking or broken, are in 详情. On a wide screen it is to the right of the board. The page
// loads this only once you open a slot. A slot in the terminal shows its pane instead (spec web-terminal).
import { useQuery } from "@tanstack/react-query";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { AArrowDown, AArrowUp, ALargeSmall, Archive, ArchiveRestore, Ellipsis, Expand, FoldVertical, Maximize2, MessageSquareText, Minimize2, Network, PanelLeftClose, PanelLeftOpen, Pencil, Settings, Shrink, SquarePen, SquareTerminal, Trash2 } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { useLocation } from "wouter";
import { cn } from "cn";
import { AgentLogo, breakLong, clock, flagged, goHash, Max, THEME, THEME_ICON, THEMES, TopBar, useBoardKey, useTheme, WIDE } from "./common";
import { flash, openSlot, SideList } from "./board";
import { Badge } from "./components/ui/badge";
import { buttonVariants } from "./components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";
import { FROM_BOARD, type Platform } from "../../src/contracts";
import { heard, json, mayPrefetch, Messages, queryClient, seen, heardCount, unsent, type Block, type BoardData, type SlotData } from "./data";
import { Details } from "./details";
import { Face, Mark } from "./faces";
import { Stick, type Place } from "./stick";
import { Fold, folded, MARKDOWN, Running, type Shown } from "./tools";
import { canRemind, reminding, remindBy, useUnreadBut } from "./unread";
import { Asks } from "./asks";
import { inTurn } from "./timeline";
import { act, attach, Composer, Connecting, givenBack, keep, kept, Pending, Pick, Queue, Remove, Rename, TakeBack, told, Toasts, useAct, type Choice } from "./write";

// Its code, with ghostty-web's, comes only for a slot in the terminal (story 344).
const TerminalView = lazy(() => import("./terminal"));

/** Whether the chat shows the slot's pane (story 340): in the terminal, its pane there, Herdr not restarting. */
export const inTerminal = (d: SlotData) => d.mode === "tui" && d.pane !== null && !d.herdrLost;

/** How many visits to slots' pages there have been. */
export let visits = 0;

/** How many blocks the chats seen lately hold in all, at most (#415): a newest page has a few dozen, each
 *  block's text clipped (src/transcript.ts), so some 3 to 5 MB, the newest pages of two or three dozen slots. */
export const KEPT_BLOCKS = 2000;

/** What make made, by key, as long as all of them weigh at most most: once over, those least lately asked
 *  for go, but never the one just asked for, however much it weighs. Weighed as one is asked for, so what
 *  came since counts from the next. In memory only: a page loaded again starts over. peek(key) gives
 *  the one kept, neither making nor moving it; values, all kept. */
function lately<T>(make: (key: string) => T, weigh: (it: T) => number, most: number) {
  const kept = new Map<string, T>();
  const get = (key: string): T => {
    const it = kept.get(key) ?? make(key);
    kept.delete(key);
    kept.set(key, it);
    let all = 0;
    for (const v of kept.values()) all += weigh(v);
    for (const [k, v] of kept) {
      if (all <= most || v === it) break;
      all -= weigh(v);
      kept.delete(k);
    }
    return it;
  };
  return Object.assign(get, { peek: (key: string) => kept.get(key), values: () => [...kept.values()] });
}

/** A slot's chat: the conversation as shown, the slot's last answer, and where it was scrolled to;
 *  coming, while they are being brought. */
const chat = (id: string, log = new Messages(id)) => ({ log, d: undefined as (SlotData & { blocks: Block[] }) | undefined, place: { top: null, fresh: false } as Place, coming: undefined as Promise<void> | undefined });
/** The one chat ahead brought last, till its visit takes it: apart from those seen lately, which rows
 *  gone over would push out (#356). stop stops what is still coming. */
let early: { id: string; it: ReturnType<typeof chat>; stop: AbortController } | undefined;
/** The chats of the slots seen lately. */
const chats = lately(
  (id) => {
    const it = early?.id === id ? early.it : chat(id);
    if (early?.id === id) early = undefined;
    return it;
  },
  (c) => c.log.blocks.length,
  KEPT_BLOCKS,
);
// A message that failed waits in them, red to try again: the page does not load itself again (web/src/main.tsx).
unsent.any = () => chats.values().some((c) => c.log.sent.some((s) => s.failed !== undefined));

/** What is still coming of a chat pressed on (ahead's open), till it came. */
let opening: Promise<void> | undefined;

/** Brings slot id's answer and newest page ahead of its visit, as you go to its row (#356), unless its
 *  chat was seen lately or is coming already. One at a time: the one before, still coming, stops. open:
 *  pressed on, as you open it, or brought as its turn ended. Till it came, the mouse going on to the
 *  chat over rows, as over the list still drawn while the chat's page comes, stops it not, nor brings
 *  theirs alongside. */
export function ahead(id: string, open = false): void {
  if (opening) return;
  if (!chats.peek(id) && early?.id !== id) {
    behind();
    const stop = new AbortController();
    // Till they come: the chat's later asks are its own.
    let signal: AbortSignal | undefined = stop.signal;
    const it = chat(id, new Messages(id, (url) => json(url, { signal })));
    early = { id, it, stop };
    it.coming = Promise.all([json<SlotData>(`api/slot?id=${encodeURIComponent(id)}`, { signal }), it.log.newer()])
      .then(([d]) => void (it.d ??= { ...d, blocks: it.log.blocks }))
      .catch(() => {})
      .finally(() => ((it.coming = undefined), (signal = undefined)));
  }
  if (open && early?.id === id && early.it.coming) opening = early.it.coming.then(() => (opening = undefined));
}

/** A slot's turn ended, as it went idle or waits on you, while its chat is not on screen (none of its
 *  visits' queries is observed): its chat is brought now, likely the one opened next (#386). One seen
 *  lately, or brought ahead, takes its answer and the blocks written since in place: among those seen
 *  lately it keeps its place, and what it brings counts at the next visit. Another comes as ahead
 *  brings it, unless ahead brings one already. Not one being brought, as when the stream, back, replays
 *  events; nor one in the terminal, whose chat does not show; nor while the browser saves data. What
 *  it brings is as one pressed on (opening): a finger lifted off a row leaves it before the tap opens it. */
seen.add(({ type, slot, data }) => {
  const { state, mode } = (data ?? {}) as { state?: string; mode?: string };
  if (type !== "slot_state" || !slot || (state !== "idle" && state !== "waiting") || mode === "tui" || !mayPrefetch()) return;
  if (queryClient.getQueryCache().find({ queryKey: ["slot", slot], exact: false, type: "active" })) return;
  const it = chats.peek(slot) ?? (early?.id === slot ? early.it : undefined);
  if (!it) return void (early?.it.coming || ahead(slot, true));
  if (it.coming) return;
  it.coming = Promise.all([json<SlotData>(`api/slot?id=${encodeURIComponent(slot)}`, { priority: "low" }), it.log.newer()])
    .then(([d]) => void (it.d = { ...d, blocks: it.log.blocks }))
    .catch(() => {})
    .finally(() => (it.coming = undefined));
  if (it === early?.it) opening = it.coming.then(() => (opening = undefined));
});

/** Stops what ahead is still bringing, as the mouse leaves the row, and drops it: its visit asks afresh.
 *  What came stays, and what is coming of one pressed on. */
export function behind(): void {
  if (!early?.it.coming || opening) return;
  early.stop.abort();
  early = undefined;
}

/** Slot id in the terminal as its card on the board has it, the rest empty: drawn so, its top bar and
 *  terminal show and connect at once on a first visit, as from the list, not after /api/slot answers,
 *  which fills in the rest. undefined for one not in the terminal, or with no card. */
function fromCard(id: string): (SlotData & { blocks: Block[] }) | undefined {
  const c = queryClient
    .getQueryData<BoardData>(["board"])
    ?.workspaces.flatMap((w) => Object.values(w.groups).flat())
    .find((c) => c.id === id);
  if (!c?.terminal) return undefined;
  const { ref, agent, state, archivedAt, lifetime, terminal } = c;
  return { id, ref, agent, state, archivedAt, lifetime, mode: "tui", pane: terminal, herdrLost: false, dir: "", phase: "idle", settings: [], model: null, effort: null, ultracode: false, asks: [], gone: [], queue: [], process: null, timeline: [], commands: [], blocks: [] };
}

/** heardCount as each chat last heard: one drawn again at the same count missed nothing. */
const left = new WeakMap<Messages, number>();

/** A visit to a slot's page: its conversation as last seen, drawn at once, or on a first visit a slot
 *  in the terminal as its card has it (fromCard); and the query that keeps the page up to date, which
 *  brings the blocks written since with each update; a new conversation starts over. What the agent
 *  was writing is kept only if the stream told nothing since the chat went, as when it is drawn again
 *  in a new place for the same stream (#285); else the stream brings it anew. Each visit has a query
 *  of its own: a visit sharing one with the visit before, whose answer is still out, would get that
 *  answer, which brought the blocks into the other visit's conversation, as when the chat had dropped
 *  from those seen lately meanwhile. */
export function visit(id: string) {
  const kept = chats(id);
  const { log, place } = kept;
  if (left.get(log) !== heardCount) log.drafts = [];
  const query = {
    queryKey: ["slot", id, ++visits],
    // blocks: so the page draws again when there are new ones.
    queryFn: async () => {
      // What is still being brought, by ahead or as a slot's turn ended, is the answer, waited for by
      // every query that asks before it came, not asked for again: a page drawn twice, as React may
      // throw a render away, would ask twice, and a newest page asked for twice at once could land older.
      if (kept.coming && (await kept.coming, kept.d)) return kept.d;
      return (kept.d = { ...(await Promise.all([json<SlotData>(`api/slot?id=${encodeURIComponent(id)}`), log.newer()]))[0], blocks: log.blocks });
    },
    // Not placeholderData, which goes once an answer fails, as while rhodium restarts. Stale at once,
    // so asked afresh.
    initialData: kept.d ?? fromCard(id),
  };
  return { log, query, place };
}

// Maximize mode's sidebar's width in px: at first, the least and the most it is dragged to. The most
// stays under the list's one-line threshold (40rem), so no width turns it back into the list.
const SIDE = { size: 288, min: 256, max: 448 };
// Wider than the narrowest phone's list (20.5rem), the sidebar's rows are the phone's.
const PHONE = 328;
// The split's left at first and its most, in %; its least in px, the narrowest phone's, which the
// board's header and rows are made for (story 422).
const SPLIT = { size: 40, max: 70, min: 360 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// The sidebar's most at this window's width: the chat keeps the narrowest phone's 360px beside it,
// though never the sidebar narrower than its least (spec web-maximize "宽度和改窗口").
const sideMost = () => clamp(innerWidth - SPLIT.min, SIDE.min, SIDE.max);
const resized = (f: () => void) => (addEventListener("resize", f), () => removeEventListener("resize", f));

/** The sidebar's width as this device keeps it, in px; with none kept, or storage that cannot be used, 288. */
export function sideWidth(): number {
  const px = Number(kept(() => localStorage, "side-width") ?? NaN);
  return Number.isFinite(px) ? clamp(px, SIDE.min, SIDE.max) : SIDE.size;
}

// From this wide a window the sidebar is open at first, narrower collapsed; whether it is, kept for each apart.
const ROOMY = 1280;
const collapsedKey = () => `side-collapsed-${innerWidth >= ROOMY ? "wide" : "narrow"}`;

/** Whether the sidebar is collapsed, as this device last left it at a window as wide as this one; never
 *  left, or storage that cannot be used, collapsed under 1280px. */
export function sideCollapsed(): boolean {
  const v = kept(() => localStorage, collapsedKey());
  return v === null ? innerWidth < ROOMY : v === "1";
}
/** Keeps whether the sidebar is collapsed, for windows as wide as this one. */
export const keepCollapsed = (on: boolean) => keep(() => localStorage, collapsedKey(), on ? "1" : "0");

// The web terminal's font size in px (spec web-terminal "尺寸和字号"): at first, the least and the most.
const FONT = { size: 13, min: 9, max: 20 };
/** The web terminal's font size as this device keeps it, in px; with none kept, or storage that cannot be used, 13. */
export function terminalFont(): number {
  const px = Number(kept(() => localStorage, "terminal-font") ?? NaN);
  return Number.isFinite(px) ? clamp(Math.round(px), FONT.min, FONT.max) : FONT.size;
}
/** Keeps px, within 9 to 20, as this device's web terminal font size; what it keeps. */
export function keepTerminalFont(px: number): number {
  const v = clamp(px, FONT.min, FONT.max);
  keep(() => localStorage, "terminal-font", v === FONT.size ? null : String(v));
  return v;
}

/** A wide screen's split: on the left the list or the topology (board), where the chat was opened from
 *  (from), on the right the chat, the line between them dragged, or moved by the arrow keys, to move it;
 *  the left 40% at first and on a double click, kept for the tab: back from maximize mode, or from the
 *  other view, it is there. In maximize mode (full, spec web-maximize) the left is the sidebar instead,
 *  the line moving it alone, 288px at first and on a double click, kept on this device: a wider window
 *  widens only the chat. The sidebar collapses to nothing and expands again by the chat's button or ⌘B,
 *  or dragged past half its least. Either way the chat stays where it is in the page, never drawn
 *  afresh (#285). The screen's height, so the left scrolls on its own. */
export function Split({ from, full, board, chat }: { from: "list" | "topology"; full: boolean; board: ReactNode; chat: ReactNode }) {
  const [pct, setPct] = useState(() => clamp(Number(kept(() => sessionStorage, "split")) || SPLIT.size, 0, SPLIT.max));
  const [px, setPx] = useState(sideWidth);
  // Drawn no wider than the window leaves room for; kept as it is.
  const most = useSyncExternalStore(resized, sideMost);
  const shown = Math.min(px, most);
  const [dragging, setDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(() => full && sideCollapsed());
  // Sliding, as the button or the key collapsed or expanded it, till the slide is over. Not as a drag
  // did, which the sidebar follows, nor into maximize mode, which lays it out at once.
  const [slide, setSlide] = useState(false);
  // Collapsed as this device left it, read into maximize mode and as the page loads: a window dragged
  // across 1280px leaves it as it is.
  const [was, setWas] = useState(full);
  if (was !== full) (setWas(full), setSlide(false), full && setCollapsed(sideCollapsed()));
  const side = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  /** Collapses the sidebar (on) or expands it, kept on this device. Collapsing, the focus in it or on
   *  its line, which hide with it, or in nothing as after a drag, goes to where you type on a computer,
   *  not left out of sight. */
  const collapse = (on: boolean, eased = true) => {
    setCollapsed(on);
    setSlide(eased);
    keepCollapsed(on);
    const at = document.activeElement;
    if (!on || (at && at !== document.body && !side.current?.contains(at) && at !== line.current)) return;
    (at as HTMLElement | null)?.blur();
    if (matchMedia("(pointer: fine)").matches) right.current?.querySelector("textarea")?.focus();
  };
  const max = useMemo(() => ({ from, full, collapsed: full && collapsed, toggle: () => collapse(!collapsed) }), [from, full, collapsed]);
  useBoardKey("side", full ? max.toggle : undefined);
  // Kept once a drag is over; the size at first, as none.
  useEffect(() => void (dragging || keep(() => localStorage, "side-width", px === SIDE.size ? null : String(px))), [px, dragging]);
  useEffect(() => void (dragging || keep(() => sessionStorage, "split", pct === SPLIT.size ? null : String(pct))), [pct, dragging]);
  // Back from maximize mode to the list, its row of the slot open last flashes; the topology fits its
  // camera to that slot by its address.
  const [at] = useLocation();
  const wasFull = useRef(full);
  useEffect(() => {
    if (wasFull.current && !full && from === "list") flash(openSlot(at));
    wasFull.current = full;
  }, [full]);
  // The sidebar's width as a drag began, which it opens at again once the drag collapsed it.
  const began = useRef(px);
  /** The line moved to x px from the page's left; dragged (drag) past half the sidebar's least, it
   *  collapses, and back out in the same drag it opens. */
  const to = (x: number, drag = false) => {
    if (!full) return setPct(clamp((x / innerWidth) * 100, (SPLIT.min / innerWidth) * 100, SPLIT.max));
    if (drag && x < SIDE.min / 2) return collapsed || (setPx(began.current), collapse(true, false));
    if (collapsed) collapse(false, false);
    setPx(clamp(Math.round(x), SIDE.min, most));
  };
  // Collapsing, its rows and the line stay drawn till the slide is over, then hide, so Tab never goes
  // in; expanding, they show at once. Laid out at its own width, the sidebar slides in and out whole
  // under the left's edge, no text moving.
  const ease = full && slide && !dragging && (collapsed ? "[transition:width_150ms_ease-out,visibility_0s_150ms]" : "[transition:width_150ms_ease-out]");
  const gone = full && collapsed && "invisible";
  return (
    <Max.Provider value={max}>
      <div className={cn("flex h-dvh", dragging && "cursor-col-resize select-none")}>
        <div
          ref={side}
          style={full ? { width: collapsed ? 0 : shown } : { width: `${pct}%`, minWidth: SPLIT.min }}
          onTransitionEnd={(e) => e.target === e.currentTarget && setSlide(false)}
          // Clipped, not hidden: a row scrolled to never scrolls it sideways.
          className={cn("h-full flex-none", full ? "flex justify-end overflow-clip bg-sidebar motion-reduce:transition-none" : "overflow-y-auto", ease, gone)}
        >
          {full ? (
            <div style={{ width: shown }} className="flex h-full flex-none flex-col">
              <div className="min-h-0 flex-1">
                <SideList from={from} wide={shown > PHONE} />
              </div>
              <SideSettings />
            </div>
          ) : (
            board
          )}
        </div>
        <div
          ref={line}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={full ? "侧栏宽度" : "分栏宽度"}
          aria-valuenow={Math.round(full ? shown : pct)}
          onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), (began.current = px), setDragging(true))}
          onPointerMove={(e) => dragging && to(e.clientX, true)}
          onLostPointerCapture={() => setDragging(false)}
          // The focus stays where it was, in the chat.
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={() => (full ? setPx(SIDE.size) : setPct(SPLIT.size))}
          onKeyDown={(e) => {
            const by = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
            // The window's width as it is now: it may have changed since this was drawn.
            if (by) (e.preventDefault(), to((full ? shown : Math.max((pct / 100) * innerWidth, SPLIT.min)) + by));
          }}
          // A finger's drag moves the line, not the page.
          className={cn("group relative z-10 -mx-1 flex w-2 flex-none cursor-col-resize touch-none items-center justify-center outline-none motion-reduce:transition-none", ease, gone)}
        >
          <div className="h-full w-px bg-border transition-colors group-hover:bg-ring/60 group-focus-visible:w-0.5 group-focus-visible:bg-ring" />
          {!full && <div className="absolute h-6 w-1 rounded-lg bg-border transition-colors group-hover:bg-ring/60" />}
        </div>
        {/* The jump box goes over it. */}
        <div data-chat ref={right} className="relative min-w-0 flex-1">
          {chat}
        </div>
      </div>
    </Max.Provider>
  );
}

/** Maximize mode's settings (spec web-maximize "设置", #491): a gear at the sidebar's bottom left, under
 *  the list, which opens a card above it. Only here: the home's header has the theme already. */
function SideSettings() {
  return (
    <div className="flex-none border-t border-border/70 px-2 py-1.5">
      <Popover.Root>
        <Popover.Trigger aria-label="设置" title="设置" className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <Settings className="size-4" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} collisionPadding={8} className="z-[70]">
            <Popover.Popup className="grid w-64 gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
              <SettingsCard />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The settings card: the theme, the same as the home header's button picks, and, where the page can
 *  show one, whether this device reminds you as turns end. Turned on with no leave yet, it asks for it
 *  in that click; denied, it says where to allow it again, as the page cannot ask once more. */
function SettingsCard() {
  const theme = useTheme();
  const [can] = useState(canRemind);
  const [leave, setLeave] = useState(() => (can ? Notification.permission : "denied"));
  const [on, setOn] = useState(reminding);
  const checked = on && leave === "granted";
  return (
    <>
      <div className="flex items-center justify-between">
        主题
        <div className="inline-flex overflow-hidden rounded-lg border">
          {THEMES.map((t) => {
            const [Icon, label] = THEME_ICON[t];
            return (
              <button key={t} aria-label={label} title={label} aria-pressed={theme === t} onClick={() => THEME.set(t)} className={cn("grid h-8 w-9 place-items-center transition-colors", theme === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </div>
      {can && (
        <div>
          <div className="flex items-center justify-between">
            通知
            <button
              role="switch"
              aria-checked={checked}
              aria-label="通知"
              disabled={leave === "denied"}
              onClick={async () => {
                const now = await remindBy(!checked);
                setOn(!checked);
                setLeave(now);
              }}
              className="group mr-0.5 h-5 w-9 rounded-full bg-input p-0.5 transition-colors aria-checked:bg-running"
            >
              <span className="block size-4 rounded-full bg-background shadow-xs transition-transform group-aria-checked:translate-x-4" />
            </button>
          </div>
          {leave === "denied" && <p className="mt-1 text-xs text-muted-foreground">要在浏览器的网站设置里重新允许</p>}
        </div>
      )}
    </>
  );
}

/** Maximize mode's button that collapses or expands the sidebar, in the chat's top bar where ‹ is (‹
 *  goes home, little wanted there). Collapsed, an amber dot on it, clear of the icon's lines, says a slot
 *  but this one needs you; else a green one, that one is unread. */
function SideToggle({ slot }: { slot: string }) {
  const { collapsed, toggle } = useContext(Max)!;
  const { data } = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board") });
  const needs = collapsed && !!data?.workspaces.some((w) => w.groups.needsYou.some((c) => c.id !== slot));
  const unread = useUnreadBut(slot) && collapsed && !needs;
  return (
    <button aria-label={collapsed ? (needs ? "展开侧栏，有需要你的" : unread ? "展开侧栏，有未读的" : "展开侧栏") : "收起侧栏"} onClick={toggle} className="focus-child -my-0.5 -ml-2 grid size-11 shrink-0 place-items-center">
      <span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "relative")}>
        {collapsed ? <PanelLeftOpen className="size-4.5" /> : <PanelLeftClose className="size-4.5" />}
        {(needs || unread) && <span className={cn("absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background", needs ? "bg-needs" : "bg-done")} />}
      </span>
    </button>
  );
}

/** A press or let-go of Esc, as fullEsc reads it. composing: an input method's, cancelling its word. */
export type EscKey = { type: string; at: number; repeat: boolean; composing: boolean };

/** What the page does with an Esc (spec web-maximize "真全屏"): passes it as it is, drops it, or, at
 *  its let-go, sends the press on to where it was pressed; and when the press it holds back went
 *  down. full: the page's fullscreen, locked when Esc is the page's and held long to leave (Chrome,
 *  Edge). Locked, a press counts once let go within half a second: one held to leave never also stops
 *  the turn. Else the browser takes Esc to leave; one that comes anyway is dropped. Held until the
 *  browser leaves, the Esc it goes on sending is not a press either. An input method's goes as it is:
 *  sent again it would no longer say so, and would stop the turn; so is its let-go. */
export function fullEsc(e: EscKey, full: "locked" | "unlocked" | false, held: number | null): { then: "pass" | "drop" | "send"; held: number | null } {
  if (e.type === "keyup") return { then: held !== null && e.at - held < 500 ? "send" : "pass", held: null };
  if (e.composing) return { then: "pass", held };
  if (!full) return held !== null && e.repeat ? { then: "drop", held } : { then: "pass", held: null };
  if (full === "unlocked") return { then: "drop", held: null };
  return { then: "drop", held: e.repeat ? held : e.at };
}

type Locks = { lock(keys: string[]): Promise<void>; unlock(): void };
const keyboard = () => (navigator as Navigator & { keyboard?: Locks }).keyboard;
let locked = false;
let held: { at: number; target: EventTarget } | null = null;
const watchFull = (changed: () => void) => (document.addEventListener("fullscreenchange", changed), () => document.removeEventListener("fullscreenchange", changed));

/** Esc while the page is in fullscreen, or held on from it, as fullEsc says. */
// ponytail: a press held back is sent again as made by the page, not the user: an Esc handler that
// ever checks isTrusted misses it; hand it on by a call then.
function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape" || !e.isTrusted) return;
  const full = document.fullscreenElement ? (locked ? "locked" : "unlocked") : false;
  const r = fullEsc({ type: e.type, at: e.timeStamp, repeat: e.repeat, composing: e.isComposing || e.keyCode === 229 }, full, held?.at ?? null);
  const target = held?.target;
  if (r.held !== (held?.at ?? null)) held = r.held === null ? null : { at: r.held, target: e.target! };
  if (r.then === "drop") {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  if (r.then === "send") target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, composed: true }));
  if (!full && !held) watchEsc(false);
}
const watchEsc = (on: boolean) => ["keydown", "keyup"].forEach((t) => (on ? addEventListener : removeEventListener)(t, onEsc as EventListener, true));

/** Out of fullscreen: Esc is the page's as pressed again, once any press held on from it is let go. */
function leftFull() {
  if (document.fullscreenElement) return;
  locked = false;
  keyboard()?.unlock();
  if (!held) watchEsc(false);
}

/** The whole page in the browser's fullscreen, Esc locked to it where the browser can: both asked in the tap. */
async function fullscreen() {
  const going = document.documentElement.requestFullscreen().then(() => true, () => false);
  const lock = keyboard()?.lock(["Escape"]).then(() => true, () => false);
  if (!(await going)) return void keyboard()?.unlock();
  watchEsc(true);
  document.addEventListener("fullscreenchange", leftFull);
  locked = !!(await lock) && !!document.fullscreenElement;
}

/** The slot's page, as last seen if it was lately. Its top bar is there before its answers come, and
 *  when they cannot. */
export function SlotPage({ id, live, graph = true }: { id: string; live: boolean | null; graph?: boolean }) {
  const [{ log, query, place }] = useState(() => visit(id));
  const { data, error } = useQuery(query);
  const gone = (error as { status?: number } | null)?.status === 404;
  if (data && !gone) return <ChatView d={data} log={log} place={place} live={live} graph={graph} />;
  return (
    <>
      <TopBar live={live} />
      {gone && <p className="mt-6 px-4 text-muted-foreground">没有这个槽位。</p>}
    </>
  );
}

/** The chat fills the screen under its top bar. It opens at the newest, or at place, and stays there
 *  as blocks come; scrolled up, it brings the pages before without moving what you read, and new
 *  blocks show 新消息. graph: its top bar has the way to the topology on this slot, as it does but
 *  beside the topology. On a wide screen its top bar has 放大, or 缩小 in maximize mode (Max), as a
 *  medium screen's always has. */
export function ChatView({ d, log, place, live, graph = true }: { d: SlotData; log: Messages; place?: Place; live: boolean | null; graph?: boolean }) {
  const [, redraw] = useState(0);
  const [, setLocation] = useLocation();
  const max = useContext(Max);
  // Back, to the topology this chat was opened from; else the topology on this slot, back from which is
  // here. A wide screen's puts the topology on this slot in the list's or the sidebar's place, the chat
  // staying, in place of the step, as the header's tab does (story 421); a medium one's is a phone's.
  const fromGraph = typeof history !== "undefined" && history.state?.up === "topology"; // no history: drawn on a server, as in tests
  const toGraph = () =>
    max && matchMedia(WIDE).matches ? goHash(`#/topology/slot/${encodeURIComponent(d.id)}?chat`, true) : fromGraph ? history.back() : setLocation(`/topology/slot/${encodeURIComponent(d.id)}`, { state: { up: `chat:${d.id}` } });
  // Opened beside the topology, or from it: its back goes there. Beside it on a page loaded so, there
  // is no step to go back to: the chat closes in place.
  const close = () => {
    const { vp, ...state } = history.state ?? {}; // the camera fits the view's new width afresh
    goHash(flagged(flagged(location.hash, "chat", false), "full", false), true, state);
  };
  // The list's row flashes as this chat is gone: the sidebar's, gone with it, does not take the flash.
  const flashOut = useRef(false);
  useEffect(() => () => void (flashOut.current && flash(d.id)), [d.id]);
  // Maximizing is a step of its own (full in its state), so back goes to the split. 缩小 right after it is
  // back; after another slot was opened in maximize mode, or on a page loaded so, in place of the step,
  // the topology's camera not kept: it fits the slot open last afresh. Not up: back from maximize mode is
  // not the topology. A medium screen has no split: 缩小 goes to where the chat was opened from, the list,
  // its row flashing, or the topology on this slot; right after it opened from there (up), back.
  const fill = () => {
    if (!max?.full) return goHash(flagged(location.hash, "full", true), false, { full: true });
    if (!matchMedia(WIDE).matches) {
      flashOut.current = max.from === "list";
      return history.state?.up === max.from ? history.back() : max.from === "list" ? goHash("#/", true) : close();
    }
    if (history.state?.full) return history.back();
    const { vp, ...state } = history.state ?? {};
    goHash(flagged(location.hash, "full", false), true, state);
  };
  const back = fromGraph ? () => history.back() : graph ? undefined : close;
  // 改名 turns the title into a box (story 267).
  const [renaming, setRenaming] = useState(false);
  // 收回终端 asks first, in a dialog that outlives the menu (story 354).
  const [taking, setTaking] = useState(false);
  // And 删除 (story 536).
  const [removing, setRemoving] = useState(false);
  const terminal = inTerminal(d);
  // The slot whose chat shows in place of its terminal (story 355): none once another slot opens here,
  // or this one leaves the terminal, so a slot opens to the terminal.
  const [reads, setReads] = useState<string | null>(null);
  if (reads !== null && (!terminal || reads !== d.id)) setReads(null);
  const reading = terminal && reads === d.id;
  const [font, setFont] = useState(terminalFont);
  const [, run] = useAct();
  const isFull = useSyncExternalStore(watchFull, () => !!document.fullscreenElement, () => false);
  // The caret back where you type on a computer (spec web-maximize "焦点"): the menu gives it back to
  // nothing, where a short Esc would stop nothing.
  const root = useRef<HTMLDivElement>(null);
  const typeHere = () => void (matchMedia("(pointer: fine)").matches && root.current?.querySelector("textarea")?.focus());
  const more: Choice[] = [
    // As /new and /compact do (story 305): a slot in the terminal or archived has neither. Neither keeps
  // the rest waiting: /compact's answer may take long.
    ...(d.mode === "headless" && d.archivedAt === null
      ? [
          { icon: SquarePen, label: "开新对话", run: () => void act({ kind: "common", slot: d.id, name: "new" }).then(told) },
          { icon: FoldVertical, label: "压缩上下文", run: () => void act({ kind: "common", slot: d.id, name: "compact" }).then(told) },
        ]
      : []),
    { icon: Pencil, label: "改名", run: () => setRenaming(true) },
    ...(d.mode === "tui" && d.pane !== null ? [{ icon: SquareTerminal, label: "收回终端", run: () => setTaking(true) }] : []),
    // A wide or medium screen's, where the browser has fullscreen.
    ...(max && typeof document !== "undefined" && document.fullscreenEnabled ? [isFull ? { icon: Shrink, label: "退出全屏", run: () => void document.exitFullscreen().then(typeHere) } : { icon: Expand, label: "全屏", run: () => void fullscreen().then(typeHere) }] : []),
    // Not one in the terminal, as /rh_ls's details offer none (story 268); nor 删除 it, which rh rm refuses.
    ...(d.archivedAt !== null
      ? [
          { icon: ArchiveRestore, label: "恢复", run: () => void run({ kind: "rh", argv: ["unarchive", d.id] }) },
          ...(d.mode === "headless" ? [{ icon: Trash2, label: "删除", run: () => setRemoving(true) }] : []),
        ]
      : d.mode === "headless"
        ? [{ icon: Archive, label: "归档", run: () => void run({ kind: "rh", argv: ["archive", d.id] }) }]
        : []),
  ];
  // Named nowhere on the page (#255).
  const state = d.pane ? d.state.replace(`（pane ${d.pane}）`, "") : d.state;
  const turn = inTurn(d);
  // Something at the bottom clear of the screen's edge: where you type. Asks waiting on you take its place.
  const bottom = d.mode === "headless" && !d.asks.length;
  const changed = () => redraw((n) => n + 1);

  // Its transcript grew: bring the blocks written since, and only them. One not brought comes next time.
  // And once now, for what grew while the chat was not yet drawn to be told.
  useEffect(() => {
    const more = () => void log.newer().then(() => redraw((n) => n + 1), () => {});
    // Marked as it hears, as the chat drawn in its new place visits before this one goes.
    const hear = (what: string, text?: string) => (left.set(log, heardCount), what === "grew" ? more() : (log.wrote(what, text), redraw((n) => n + 1)));
    heard.add(hear);
    left.set(log, heardCount);
    more();
    return () => void heard.delete(hear);
  }, [log]);

  // One taken off the queue, here or elsewhere, leaves no faint bubble; one Rhodium gave back goes back
  // where you type (story 287).
  useEffect(() => {
    const back = (e: { type: string; slot: string | null; trace: string | null; data: unknown }) => {
      const data = e.data as { text?: unknown; why?: unknown } | null;
      if (e.type !== "input_returned" || e.slot !== d.id) return;
      log.sent = log.sent.filter((s) => s.id !== e.trace);
      if (typeof data?.text === "string") givenBack(d.id, data.text, String(data.why));
      redraw((n) => n + 1);
    };
    seen.add(back);
    return () => void seen.delete(back);
  }, [d.id, log]);

  // The page before, if the conversation has one.
  const older = async () => {
    const start = log.start;
    if (start <= 0) return false;
    await log.older();
    return log.start !== start;
  };

  // Files dropped on the chat are attached where you type (#286); the browser opens none.
  const files = (e: DragEvent) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), true);
  return (
    <div ref={root} className="flex h-dvh flex-col" onDragOver={files} onDrop={(e) => files(e) && attach(d.id, [...e.dataTransfer.files])}>
      <TopBar
        title={
          renaming ? (
            <span className="flex items-center">
              {d.agent && <AgentLogo agent={d.agent} className="mr-1.5" />}
              <Rename d={d} done={() => setRenaming(false)} />
            </span>
          ) : (
            <>
              {d.agent && <AgentLogo agent={d.agent} className="mr-1.5" />}
              {d.ref}
            </>
          )
        }
        sub={state}
        live={live}
        back={back}
        lead={max?.full ? <SideToggle slot={d.id} /> : undefined}
      >
        {/* Each a 44px target around the button you see, the bar no taller. */}
        {graph && (
          <button aria-label="拓扑图" onClick={toGraph} className="focus-child -my-0.5 grid size-11 shrink-0 place-items-center">
            <span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm", className: "text-running" }))}>
              <Network className="size-4.5" />
            </span>
          </button>
        )}
        {max && (
          <button aria-label={max.full ? "缩小" : "放大"} onClick={fill} className="focus-child -my-0.5 grid size-11 shrink-0 place-items-center">
            <span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}>{max.full ? <Minimize2 className="size-4.5" /> : <Maximize2 className="size-4.5" />}</span>
          </button>
        )}
        {terminal && (
          <button aria-label={reading ? "终端" : "对话记录"} onClick={() => setReads(reading ? null : d.id)} className="focus-child -my-0.5 grid size-11 shrink-0 place-items-center">
            <span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}>{reading ? <SquareTerminal className="size-4.5" /> : <MessageSquareText className="size-4.5" />}</span>
          </button>
        )}
        <Pick label="更多" choices={more} head={terminal && !reading && <FontSize px={font} set={(px) => setFont(keepTerminalFont(px))} />} className="focus-child -my-0.5 grid size-11 shrink-0 place-items-center">
          <span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}>
            <Ellipsis className="size-4.5" />
          </span>
        </Pick>
        <Sheet>
          <SheetTrigger className="focus-child -my-0.5 grid h-11 min-w-11 shrink-0 place-items-center">
            <span className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>详情</span>
          </SheetTrigger>
          <SheetContent className="w-[90%] gap-0">
            <SheetHeader>
              <SheetTitle>
                {d.agent && <AgentLogo agent={d.agent} className="mr-1.5" />}
                {d.ref}
              </SheetTitle>
            </SheetHeader>
            <Details d={d} />
          </SheetContent>
        </Sheet>
      </TopBar>
      <TakeBack slot={d.id} open={taking} onOpenChange={setTaking} onTaken={() => setReads(d.id)} />
      <Remove slot={d.id} name={d.ref} open={removing} onOpenChange={setRemoving} />
      {(!terminal || reading) && <Stick label="对话" reset={log.conversation} tail={`${log.blocks.at(-1)?.at} ${log.begun} ${log.sent.length}`} older={older} place={place}>
        {() => (
          <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {!log.blocks.length && <p className="text-sm text-muted-foreground">{log.conversation ? "对话里还没有消息。" : "还没有对话。"}</p>}
            {folded(log.blocks).map((b) => (
              <Said key={b.at} b={b} conversation={log.conversation ?? ""} />
            ))}
            {log.drafts.map((d, i) => (
              // Streaming: Markdown half written, as **bold not yet closed, shows as it will.
              <Streamdown key={i} {...MARKDOWN} isAnimating={!d.whole} caret="block">
                {d.text}
              </Streamdown>
            ))}
            {log.sent
              .filter((s) => !d.queue.some((q) => q.id === s.id))
              .map((s) => (
                <Pending key={s.id} s={s} slot={d.id} log={log} changed={changed} />
              ))}
          </div>
        )}
      </Stick>}
      {/* Kept attached under the chat: the page is still yours (spec web-terminal "一处在操作"). */}
      {terminal && (
        <Suspense
          fallback={
            <section aria-label="终端" className={cn("relative min-h-0 flex-1 bg-[#0a0a0a]", reading && "hidden")}>
              <Connecting />
            </section>
          }
        >
          <TerminalView key={d.id} slot={d.id} font={font} shown={!reading} />
        </Suspense>
      )}
      {/* The toasts float over what is at the bottom: the asks, where you type, or with neither, the screen's edge. */}
      <div className="relative shrink-0">
        <Toasts />
        {d.mode === "headless" && <Queue slot={d.id} queue={d.queue} />}
        {/* Asks waiting on you take the place of where you type, the stop key on the top one (spec web-write "页面"). */}
        <Asks d={d} turn={turn} />
        {bottom && <Composer key={d.id} slot={d.id} turn={turn} terminal={d.archivedAt === null} log={log} changed={changed} commands={d.commands} agent={d.agent} model={d.model} effort={d.effort} ultracode={d.ultracode} />}
        {!bottom && <div className="h-[env(safe-area-inset-bottom)]" />}
      </div>
    </div>
  );
}

/** 更多's row for the web terminal's font size (story 342): smaller and bigger a px, the menu staying
 *  open, so the terminal shows it. */
function FontSize({ px, set }: { px: number; set: (px: number) => void }) {
  const key = "grid size-11 shrink-0 cursor-default place-items-center rounded-lg outline-none data-disabled:opacity-40 data-highlighted:bg-muted";
  return (
    <div className="flex h-11 items-center gap-2.5 pl-3 select-none">
      <ALargeSmall className="size-4 shrink-0 text-muted-foreground" />
      字号
      <Menu.Item aria-label="缩小字号" closeOnClick={false} disabled={px <= FONT.min} onClick={() => set(px - 1)} className={cn(key, "ml-auto")}>
        <AArrowDown className="size-4" />
      </Menu.Item>
      <Menu.Item aria-label="放大字号" closeOnClick={false} disabled={px >= FONT.max} onClick={() => set(px + 1)} className={key}>
        <AArrowUp className="size-4" />
      </Menu.Item>
    </div>
  );
}

/** A conversation's latest page in a box of its own that scrolls, for the topology's timeline (spec
 *  web-topology, story 231): as the chat shows it, opened at the newest, going on down with what comes
 *  while you are at the bottom. live: the slot's current conversation, which grows as the stream says,
 *  drafts and all; an old one never changes. */
export function Preview({ slot, conversation, live }: { slot: string; conversation: string; live: boolean }) {
  const [log] = useState(() => new Messages(slot, json, conversation));
  const [, redraw] = useState(0);
  useEffect(() => {
    const more = () => void log.newer().then(() => redraw((n) => n + 1), () => {});
    more();
    if (!live) return;
    const hear = (what: string, text?: string) => (what === "grew" ? more() : (log.wrote(what, text), redraw((n) => n + 1)));
    heard.add(hear);
    return () => void heard.delete(hear);
  }, [log, live]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-background">
      <Stick label="预览" reset={log.loaded} tail={`${log.blocks.at(-1)?.at} ${log.begun}`} older={async () => false}>
        {() => (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm">
            {folded(log.blocks).map((b) => (
              <Said key={b.at} b={b} conversation={conversation} />
            ))}
            {log.drafts.map((d, i) => (
              <Streamdown key={i} {...MARKDOWN} isAnimating={!d.whole} caret="block">
                {d.text}
              </Streamdown>
            ))}
          </div>
        )}
      </Stick>
    </div>
  );
}

/** Your avatar on the platform beside your bubble; with none, or one that does not load, its mark. */
function Yours({ url, p }: { url: string | null; p: Platform }) {
  const [broken, setBroken] = useState<string | null>(null);
  return url && broken !== url ? <img src={url} alt="" onError={() => setBroken(url)} className="size-7 shrink-0 rounded-full object-cover" /> : <Mark p={p} size={28} />;
}

/** A block of the conversation: what you said on the right, what the agent said as Markdown, its tool
 *  calls and thoughts folded. */
function Said({ b, conversation }: { b: Shown; conversation: string }) {
  const time = "time" in b && b.time !== null && <span className="text-xs text-muted-foreground tabular-nums">{clock(b.time)}</span>;
  switch (b.kind) {
    case "user": {
      // Through a bot: its avatar and name over the bubble, yours beside it, each the platform's mark
      // with none. Else the source line as it is (rh send, a report); typed in the terminal or on the
      // board, neither.
      const f = b.from;
      return (
        // One column no wider than the room: an auto one grows to what is in it, the chat then scrolling sideways.
        <div className={cn("grid grid-cols-[minmax(0,1fr)] justify-items-end gap-1", f ? "pl-4" : "pl-10")}>
          <div className={cn("flex items-center gap-1.5", f && "mr-9")}>
            {f ? (
              <>
                <Face url={f.botAvatar} p={f.platform} size={20} ring="ring-background" />
                {f.bot && <span className="text-xs text-muted-foreground">{f.bot}</span>}
              </>
            ) : (
              // A long one, as 槽位 HomeProject/homehelp，经 rh send, wraps on a phone, its last line not one
              // lone word; 10px round, a pill on one 20px line as before, a soft box on two.
              b.source && b.source !== FROM_BOARD && <Badge variant="outline" className="h-auto shrink rounded-lg py-px text-pretty whitespace-normal wrap-anywhere">{b.source}</Badge>
            )}
            {time}
          </div>
          <div className="flex max-w-full items-start gap-2">
            <p className="min-w-0 rounded-2xl rounded-tr-sm border bg-muted px-3 py-2 whitespace-pre-wrap wrap-anywhere">{breakLong(b.text)}</p>
            {f && <Yours url={f.avatar} p={f.platform} />}
          </div>
        </div>
      );
    }
    case "assistant":
      return (
        <div className="grid gap-1">
          {time}
          <Streamdown mode="static" {...MARKDOWN}>
            {b.text}
          </Streamdown>
        </div>
      );
    case "system":
      // Quiet, a line across the chat on either side.
      return <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">{b.title}</p>;
    case "fold":
      return <Fold f={b} conversation={conversation} />;
    case "running":
      return <Running tool={b.tool} />;
  }
}
