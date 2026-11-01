// The board (product §7): the slots that need you in a card on top; those you pinned in a card under
// them; then each workspace with more slots in a card under its name, which folds, and each other
// slot's tree, those side by side sharing a card, the latest active first; and the archived ones folded
// at the bottom. A slot is a row: its agent's logo with a dot for its state, its name with the Bots
// whose chats land in it, its state, and the last thing said.
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowUp, ChevronRight, Import, Pin, Search, SquarePen, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject, type TouchEvent } from "react";
import { Link, useLocation } from "wouter";
import { AgentLogo, ago, goHash, MAC } from "./common";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { json, mayPrefetch, queryClient, settled, type BoardData, type Card, type TopologyData } from "./data";
import { Face } from "./faces";
import { useToasts } from "./toast";
import { useUnread } from "./unread";

export type Kind = "needs" | "running" | "done" | "idle" | "archived";
const KIND = { needsYou: "needs", running: "running", done: "done", idle: "idle" } as const;
type Bot = BoardData["bots"][number];
/** A slot as a row: its kind, its workspace, how deep under its parent, whether it goes by its full
 *  ref, as where no workspace's name is above it, and the Bots whose chats land in it. */
export type Row = { c: Card; kind: Kind; ws: string; depth: number; full: boolean; bots: Bot[] };

/** When something was last said in the slot, or its turn ended; 0 for never. */
const lastAt = (c: Card) => Math.max(c.last?.at ?? 0, c.turnEndedAt ?? 0);
/** Lower comes first: the latest active. */
const rank = (r: Row) => -r.c.activeAt;

/** rows in order, each child right under its parent, as deep as it is. A child whose parent is not
 *  among them stands alone. A parent goes where the first of its descendants would. */
function tree(rows: Row[]): Row[] {
  const refs = new Set(rows.map((r) => r.c.ref));
  const kids = new Map<string, Row[]>();
  for (const r of rows) {
    const parent = r.c.parent && refs.has(r.c.parent) ? r.c.parent : "";
    kids.set(parent, [...(kids.get(parent) ?? []), r]);
  }
  const key = (r: Row): number => Math.min(rank(r), ...(kids.get(r.c.ref) ?? []).map(key));
  const out: Row[] = [];
  const walk = (rs: Row[], depth: number) => rs.sort((a, b) => key(a) - key(b)).forEach((r) => (out.push({ ...r, depth }), walk(kids.get(r.c.ref) ?? [], depth + 1)));
  walk(kids.get("") ?? [], 0);
  return out;
}

/** The board's cards in order (product §7): what needs you, the latest said first; what you pinned,
 *  each tree by when you pinned its root, the first on top; then the blocks, the latest active first: a
 *  workspace with two or more top-level slots under its name, and each other slot's tree, those side by
 *  side sharing a card. A tree goes with its root, a child of another workspace too, into 置顶 with a
 *  pinned one; a child whose parent needs you stays where the parent would be. What needs you or is
 *  pinned counts for no block. A row goes by its full name but under its own workspace's name, a child
 *  by its own under a parent of its own workspace. Then the archived. */
function layout(data: BoardData) {
  const bots = (c: Card) => data.bots.filter((b) => c.bots.includes(b.id));
  const live = data.workspaces.flatMap((w) => Object.entries(KIND).flatMap(([g, kind]) => w.groups[g as keyof typeof KIND].map((c): Row => ({ c, kind, ws: w.name, depth: 0, full: true, bots: bots(c) }))));
  const needs = live.filter((r) => r.kind === "needs").sort((a, b) => lastAt(b.c) - lastAt(a.c));
  const byRef = new Map(live.map((r) => [r.c.ref, r]));
  /** r and those above it, up to its tree's root. */
  const up = (r: Row): Row[] => [r, ...(byRef.has(r.c.parent ?? "") ? up(byRef.get(r.c.parent!)!) : [])];
  const tops = (ws: string) => live.filter((r) => r.ws === ws && !byRef.has(r.c.parent ?? "")).length;
  const blocks = new Map<string, { name?: string; pin?: number; rows: Row[]; key: number }>();
  for (const r of live.filter((r) => r.kind !== "needs")) {
    const line = up(r);
    const pin = line.findLast((x) => x.c.pinnedAt !== null);
    const root = line.at(-1)!;
    const name = !pin && tops(root.ws) > 1 ? root.ws : undefined;
    const id = pin?.c.id ?? name ?? root.c.id;
    const b = blocks.get(id) ?? blocks.set(id, { name, pin: pin?.c.pinnedAt ?? undefined, rows: [], key: 0 }).get(id)!;
    b.rows.push(r);
    b.key = Math.max(b.key, r.c.activeAt);
  }
  const named = (rows: Row[], name?: string) => tree(rows).map((r) => ({ ...r, full: r.depth ? !r.c.parent!.startsWith(`${r.ws}/`) : r.ws !== name }));
  const all = [...blocks.values()];
  const pinned = all.filter((b) => b.pin !== undefined).sort((a, b) => a.pin! - b.pin!).flatMap((b) => named(b.rows));
  const cards: { name?: string; rows: Row[] }[] = [];
  for (const b of all.filter((b) => b.pin === undefined).sort((a, b) => b.key - a.key)) {
    const rows = named(b.rows, b.name);
    const last = cards.at(-1);
    if (!b.name && last && !last.name) last.rows.push(...rows);
    else cards.push({ name: b.name, rows });
  }
  const archived = data.workspaces
    .flatMap((w) => w.archived.map((c): Row => ({ c, kind: "archived", ws: w.name, depth: 0, full: true, bots: bots(c) })))
    .sort((a, b) => (b.c.archivedAt ?? 0) - (a.c.archivedAt ?? 0));
  return { needs, pinned, cards, archived };
}

/** The live slots top to bottom as the list has them, every workspace unfolded; and the archived. */
export function order(data: BoardData): { live: Row[]; archived: Row[] } {
  const { needs, pinned, cards, archived } = layout(data);
  return { live: [...needs, ...pinned, ...cards.flatMap((x) => x.rows)], archived };
}

/** The slot by from the open one (current) among those the list shows top to bottom, held still under
 *  the mouse (story 434), round at the ends, for Alt+↑↓ (story 442): none hidden in a folded workspace
 *  but the open one, which shows; none archived. The open one not among them, as one archived or new,
 *  the first below it and the last above. */
export function nextSlot(data: BoardData, current: string, by: 1 | -1): string | undefined {
  const { needs, pinned, cards } = steady(held, data);
  const ids = [...needs, ...pinned, ...cards.flatMap((x) => (x.name && folded(x.name) ? x.rows.filter((r) => r.c.id === current) : x.rows))].map((r) => r.c.id);
  const i = ids.indexOf(current);
  return ids[((i < 0 && by < 0 ? 0 : i) + by + ids.length) % ids.length];
}

/** What a list shows (story 434): the board's layout of now; while the mouse is on it, was, the data as
 *  it came, the cards and rows in was's order, each row as it is now: one new waits till the mouse
 *  leaves, one gone goes at once. So no row moves from under the mouse as the agents run. */
export function steady(was: BoardData | null, now: BoardData): ReturnType<typeof layout> {
  const fresh = layout(now);
  if (!was) return fresh;
  const then = layout(was);
  const all = new Map([...fresh.needs, ...fresh.pinned, ...fresh.cards.flatMap((x) => x.rows), ...fresh.archived].map((r) => [r.c.id, r]));
  // Where it was: how deep, and by which name.
  const keep = (rows: Row[]) => rows.flatMap((r) => (all.has(r.c.id) ? [{ ...all.get(r.c.id)!, depth: r.depth, full: r.full }] : []));
  return { needs: keep(then.needs), pinned: keep(then.pinned), cards: then.cards.map((x) => ({ ...x, rows: keep(x.rows) })).filter((x) => x.rows.length), archived: keep(then.archived) };
}

// What the list under the mouse holds still, for Alt+↑↓ (story 442); none off a list, as beside the topology.
let held: BoardData | null = null;

/** How long a list stays held after the last finger leaves it (#506). */
const LIFTED = 3000;

/** The data a list holds still (story 434), while a mouse is on it, or a finger, till LIFTED after the
 *  last one leaves (#506); and the handlers that tell. A finger's pointer leaves as it lifts, or as the
 *  list scrolls under it: its touch is what tells. */
function useHeld(data: BoardData | undefined) {
  const [was, setWas] = useState<BoardData | null>(null);
  const hold = (d: BoardData | null) => setWas((held = d));
  const lifted = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Gone from under a resting mouse, as Esc leaves maximize mode, it tells no leave.
  useEffect(() => () => (clearTimeout(lifted.current), void (held = null)), []);
  const lift = (e: TouchEvent) => e.touches.length || (lifted.current = setTimeout(() => hold(null), LIFTED));
  return [
    was,
    {
      onPointerEnter: (e: PointerEvent) => e.pointerType === "mouse" && hold(data ?? null),
      onPointerLeave: (e: PointerEvent) => e.pointerType === "mouse" && hold(null),
      onTouchStart: () => (clearTimeout(lifted.current), was || hold(data ?? null)),
      onTouchEnd: lift,
      onTouchCancel: lift,
    },
  ] as const;
}

/** Of the rows of a fold folded, the open slot's (story 435), on its own: none or one. */
const peek = (rows: Row[], at: string) => rows.filter((r) => r.c.id === openSlot(at)).map((r) => ({ ...r, depth: 0 }));

/** Folded, how many slots a workspace has, a blue dot first if one runs (story 436); what needs you
 *  is on top already. */
const Count = ({ rows, className }: { rows: Row[]; className?: string }) => (
  <span className={cn("flex items-center gap-1 tabular-nums", className)}>
    {rows.some((r) => r.kind === "running") && <span role="img" aria-label="有在运行的" className="size-1.5 rounded-full bg-running" />}
    {rows.length}
  </span>
);

// Whether the archived are open: kept while you visit a slot and come back.
let archivedOpen = false;

// What writes, with the archived slots' restore buttons or a toast, comes only once they show (spec web-write).
const Restore = lazy(() => import("./write").then((m) => ({ default: m.Restore })));
const Toasts = lazy(() => import("./write").then((m) => ({ default: m.Toasts })));
const RowMenu = lazy(() => import("./write").then((m) => ({ default: m.RowMenu })));

/** A headless slot's row's menu (spec web-write "列表行的菜单"): a right click, or a finger held still
 *  half a second, opens it where it was, its code coming then; Android's long press, a right click
 *  too, opens it once. One in the terminal has none. What the row takes, none for one in the terminal,
 *  and the menu, there once opened, its dialog outliving it. */
function useRowMenu(c: Card) {
  const [at, setAt] = useState<{ x: number; y: number } | null>();
  // A finger down on the row, which may be held; shown: it opened the menu, which is still up.
  const press = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout>; shown?: boolean } | null>(null);
  const show = (x: number, y: number) => {
    if (press.current) (clearTimeout(press.current.timer), (press.current.shown = true));
    setAt({ x, y });
  };
  // Lifted, moved or taken by a scroll before it was held: a tap or a scroll, as without.
  const drop = () => press.current && !press.current.shown && (clearTimeout(press.current.timer), (press.current = null));
  // The browser's own right click for that press, after ours, lands on the menu or what it lays over
  // the page: not its menu over ours.
  useEffect(() => {
    const no = (e: Event) => press.current?.shown && e.preventDefault();
    addEventListener("contextmenu", no);
    return () => removeEventListener("contextmenu", no);
  }, []);
  const hold = c.mode !== "headless" ? undefined : {
    onContextMenu: (e: MouseEvent) => (e.preventDefault(), press.current?.shown || show(e.clientX, e.clientY)),
    // In capture, beside toward's own.
    onPointerDownCapture: (e: PointerEvent) => {
      const { clientX: x, clientY: y } = e;
      clearTimeout(press.current?.timer);
      press.current = e.pointerType === "touch" ? { x, y, timer: setTimeout(() => show(x, y), 500) } : null;
    },
    onPointerMoveCapture: (e: PointerEvent) => press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10 && drop(),
    onPointerUpCapture: drop,
    onPointerCancelCapture: drop,
    // Its lift is no tap on the link.
    onTouchEnd: (e: TouchEvent) => press.current?.shown && e.cancelable && e.preventDefault(),
    // No link preview, callout or text selection for a finger held on it.
    className: "any-pointer-coarse:select-none any-pointer-coarse:[-webkit-touch-callout:none]",
  };
  return [
    hold,
    at !== undefined && (
      <Suspense>
        <RowMenu c={c} at={at} close={() => ((press.current = null), setAt(null))} />
      </Suspense>
    ),
  ] as const;
}

export function BoardPage() {
  const { data } = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board") });
  // The topology's answer, fetched ahead once the page is idle, for a topology that opens drawn (#356).
  useEffect(() => void settled().then(() => void (mayPrefetch() && queryClient.prefetchQuery({ queryKey: ["topology"], queryFn: () => json<TopologyData>("api/topology", { priority: "low" }) }))), []);
  return data ? <BoardView data={data} /> : null;
}

/** The board. It measures its own width: a slot is a line where there is room, two beside a chat. */
export function BoardView({ data }: { data: BoardData }) {
  const [was, hover] = useHeld(data);
  const { needs, pinned, cards, archived } = steady(was, data);
  const [arcOpen, setArcOpen] = useState(archivedOpen);
  // What a button did shows at the bottom, as a chat gone back from had it; beside a chat, in the chat.
  const up = useToasts().length > 0;
  const [at] = useLocation();
  const beside = at.startsWith("/slot/");
  // One line a slot: the name's column wider by the most faces any row has, the same for all, so the
  // last lines stay in one column (story 438).
  const most = Math.max(0, ...[...needs, ...pinned, ...cards.flatMap((x) => x.rows), ...archived].map((r) => r.bots.length));
  return (
    <div className="@container" style={{ "--bw": `${facesRoom(Math.min(3, most), most, 24)}px` } as CSSProperties} {...hover}>
      {needs.length > 0 && <Rows rows={needs} className="mt-5 border-needs/35 shadow-needs/10 @min-[40rem]:mt-6" />}
      {pinned.length > 0 && (
        <div className="mt-5 @min-[40rem]:mt-6.5">
          <Pinned className="ml-4 pb-[7px]" />
          <Rows rows={pinned} />
        </div>
      )}
      {cards.map((x) => (x.name ? <Workspace key={x.name} name={x.name} rows={x.rows} /> : <Rows key={x.rows[0]!.c.id} rows={x.rows} className="mt-5 @min-[40rem]:mt-6.5" />))}
      {!needs.length && !pinned.length && !cards.length && <p className="my-10 text-center text-muted-foreground">没有在用的槽位。</p>}
      {archived.length > 0 && (
        <Collapsible className="mt-7" open={arcOpen} onOpenChange={(open) => ((archivedOpen = open), setArcOpen(open))}>
          <CollapsibleTrigger className="group flex items-center gap-1 py-1.5 pr-1 pl-3 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="size-4 transition-transform group-data-panel-open:rotate-90" />
            已归档 {archived.length}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5">
            <Rows rows={archived} />
          </CollapsibleContent>
          {!arcOpen && <Rows rows={peek(archived, at)} className="mt-1.5" />}
        </Collapsible>
      )}
      {up && !beside && (
        <Suspense>
          <div className="fixed inset-x-0 bottom-[env(safe-area-inset-bottom)] z-[60]">
            <Toasts />
          </div>
        </Suspense>
      )}
    </div>
  );
}

/** Whether workspace name's card is folded on this device. Storage that cannot be used, as in some
 *  private windows, keeps none. */
function folded(name: string): boolean {
  try {
    return localStorage.getItem(`folded:${name}`) === "1";
  } catch {
    return false;
  }
}

function fold(name: string, on: boolean) {
  try {
    if (on) localStorage.setItem(`folded:${name}`, "1");
    else localStorage.removeItem(`folded:${name}`);
  } catch {}
}

/** A workspace's card under its name, which folds it; folded, the name says how many slots it has. */
function Workspace({ name, rows }: { name: string; rows: Row[] }) {
  const [open, setOpen] = useState(() => !folded(name));
  const [at] = useLocation();
  return (
    <Collapsible className="mt-5 @min-[40rem]:mt-6.5" open={open} onOpenChange={(o) => (setOpen(o), fold(name, !o))}>
      <CollapsibleTrigger className="group flex items-center gap-1 pb-[7px] pl-4 text-[13px] font-semibold tracking-[0.01em] text-muted-foreground transition-colors hover:text-foreground">
        {name}
        {!open && <Count rows={rows} className="font-normal" />}
        <ChevronRight className="size-3.5 opacity-60 transition-transform group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Rows rows={rows} />
      </CollapsibleContent>
      {!open && <Rows rows={peek(rows, at)} />}
    </Collapsible>
  );
}

/** What heads 置顶 (#506): a pin, as small as a workspace's name over its card. */
const Pinned = ({ className }: { className: string }) => (
  <div className={cn("flex h-[19.5px] items-center text-muted-foreground", className)}>
    <Pin role="img" aria-label="置顶" className="size-3.5" />
  </div>
);

/** Rows in a card; none, no card. */
function Rows({ rows, className }: { rows: Row[]; className?: string }) {
  if (!rows.length) return null;
  return (
    <div className={cn("overflow-hidden rounded-[18px] border bg-card shadow-xs", className)}>
      {rows.map((r) => (
        <SlotRow key={r.c.id} r={r} />
      ))}
    </div>
  );
}

/** A text in px: w(k), its first k of n letters; keep, the letters a cut keeps at least; ell, its "…". */
type Text = { w: (k: number) => number; n: number; keep: number; ell: number };

/** text's box cut, at a letter with the "…", as wide as left lets it be (CSS cuts at a letter and leaves
 *  the rest of the box empty, a gap before what follows); no narrower than keep letters, and never cut
 *  where the "…" would make it no narrower. undefined: whole. */
function cut(t: Text, left: number): number | undefined {
  const all = t.w(t.n);
  const least = Math.ceil(t.w(t.keep) + t.ell);
  if (all <= left + 0.5 || t.keep >= t.n || least >= all) return undefined;
  let k = t.n - 1;
  while (k > t.keep && Math.ceil(t.w(k) + t.ell) > left) k--;
  return Math.ceil(t.w(k) + t.ell);
}

/** A slot's name and the Bots' faces after it out of room (stories 433, 439), in px: room for it all;
 *  ws, a full name's workspace, slash, the "/" after it; own, the slot's own name; faces(k), the room of
 *  k of count faces and a +N for the rest. They give way in turn: the workspace, down to its first three
 *  letters (its keep); the own name, down to its keep (keepOf); fewer faces, the +N growing (not for one
 *  Bot); then no +N either, the own name taking the rest. Box widths, each undefined as wide as it is; faces, how many
 *  show, -1 for none and no +N, undefined for all there are room for. */
export function squeeze(room: number, ws: Text | undefined, slash: number, own: Text, faces: (k: number) => number, count: number): { ws?: number; name?: number; faces?: number } {
  const most = Math.min(3, count);
  const sl = ws ? slash : 0;
  const ownAll = own.w(own.n);
  const fits = (wide: number) => wide <= room + 0.5;
  if (fits((ws ? ws.w(ws.n) : 0) + sl + ownAll + faces(most))) return {};
  const wsCut = ws && cut(ws, room - sl - ownAll - faces(most));
  const wsBox = ws ? (wsCut ?? ws.w(ws.n)) : 0;
  const at = (o: { name?: number; faces?: number }) => ({ ...(wsCut === undefined ? {} : { ws: wsCut }), ...o });
  const ownCut = cut(own, room - sl - wsBox - faces(most));
  if (fits(wsBox + sl + (ownCut ?? ownAll) + faces(most))) return at(ownCut === undefined ? {} : { name: ownCut });
  // The own name at its least: the faces give way, the own name taking back what they leave. One Bot's
  // face gives way to nothing, not to a +1 that does not say which.
  for (let k = most - 1; k >= (count > 1 ? 0 : 1); k--) {
    if (!fits(wsBox + sl + (ownCut ?? ownAll) + faces(k))) continue;
    const name = cut(own, room - sl - wsBox - faces(k));
    return at({ ...(name === undefined ? {} : { name }), faces: k });
  }
  const rest = room - sl - wsBox;
  return at({ ...(ownAll <= rest + 0.5 ? {} : { name: Math.max(0, Math.floor(rest)) }), ...(count ? { faces: -1 } : {}) });
}

/** How many of name's letters it keeps at least, cut (story 439): some 6 letters' room, a Chinese
 *  character as wide as 1.5; all of a name of 7 or fewer. */
export function keepOf(name: string): number {
  if (name.length <= 7) return name.length;
  let k = 0;
  for (let room = 6; k < name.length; k++) {
    room -= name[k]! >= "\u2e80" ? 1.5 : 1;
    if (room < 0) break;
  }
  return k;
}

/** A +N's width, set: as wide as its letters at 12px. */
const plusWidth = (n: number) => 7 * (1 + String(n).length);

/** The room k of count Bots' faces of size px take after a name (story 438), and a +N for the rest:
 *  6px before them, 8px at 24px; 4px between. -1, or no Bots: none. */
export const facesRoom = (k: number, count: number, size: number) =>
  k < 0 || !count ? 0 : (size < 24 ? 6 : 8) + k * size + Math.max(0, k - 1) * 4 + (count > k ? (k ? 4 : 0) + plusWidth(count - k) : 0);

// What measures the "…" as the browser draws it, made as the first full name is.
let pen: CanvasRenderingContext2D | null = null;

/** A slot's name in a box that takes className, the Bots whose chats land in the slot right after it
 *  (story 437), their marks with the classes mark has (Face's row); with ws, its full name, the
 *  workspace's part grey. Out of room, squeezed (squeeze): measured as it is drawn and again as the box's
 *  width changes. The faces are the box's --face px, 18 with none: the row in one line or two is a box
 *  of another width, so measured again. */
export function Name({ ws, name, bots, mark = "", className }: { ws?: string; name: string; bots: Bot[]; mark?: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // How many faces show, -1 for none and no +N, and how big: before it is measured, all, small.
  const [faces, setFaces] = useState({ k: Math.min(3, bots.length), size: 18 });
  useLayoutEffect(() => {
    if (ws === undefined && !bots.length) return;
    const box = ref.current!;
    const own = box.querySelector<HTMLElement>(":scope > [data-own]")!;
    const part = ws === undefined ? null : (box.firstElementChild as HTMLElement);
    const range = document.createRange();
    const text = (el: HTMLElement, keep: number) => {
      const t = el.firstChild!;
      const cs = getComputedStyle(el);
      pen ??= document.createElement("canvas").getContext("2d")!;
      pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return { w: (k: number) => (range.setStart(t, 0), range.setEnd(t, k), range.getBoundingClientRect().width), n: t.textContent!.length, keep, ell: pen.measureText("…").width };
    };
    const fit = () => {
      const size = parseFloat(getComputedStyle(box).getPropertyValue("--face")) || 18;
      const slash = part ? part.nextElementSibling!.getBoundingClientRect().width : 0;
      const s = squeeze(box.getBoundingClientRect().width, part ? text(part, Math.min(3, ws!.length)) : undefined, slash, text(own, keepOf(name)), (k) => facesRoom(k, bots.length, size), bots.length);
      if (part) part.style.width = s.ws === undefined ? "" : `${s.ws}px`;
      own.style.maxWidth = s.name === undefined ? "" : `${s.name}px`;
      const k = s.faces ?? Math.min(3, bots.length);
      setFaces((f) => (f.k === k && f.size === size ? f : { k, size }));
    };
    fit();
    const sized = new ResizeObserver(fit);
    sized.observe(box);
    // Not a full name any more, as a child gone back under its parent, the name, the same span, is not left squeezed.
    return () => {
      sized.disconnect();
      own.style.maxWidth = "";
    };
  }, [ws, name, bots.length]);
  const rest = bots.slice(faces.k).map((b) => b.name).join("、");
  return (
    <span ref={ref} className={className}>
      {ws !== undefined && (
        <>
          <span className="flex-none truncate font-normal text-muted-foreground">{ws}</span>
          <span className="flex-none font-normal text-muted-foreground">/</span>
        </>
      )}
      <span data-own className="max-w-full flex-none truncate">
        {name}
      </span>
      {bots.length > 0 && faces.k >= 0 && (
        // Not to be tapped on their own: a tap on them is on the row.
        <span className="flex flex-none items-center gap-1" style={{ paddingLeft: faces.size < 24 ? 6 : 8 }}>
          {bots.slice(0, faces.k).map((b) => (
            <span key={b.id} role="img" aria-label={b.name} title={b.name} className="flex">
              <Face url={b.avatar} p={b.platform} size={faces.size} row={mark} />
            </span>
          ))}
          {rest && (
            <span role="img" aria-label={rest} title={rest} style={{ width: plusWidth(bots.length - faces.k) }} className="text-xs font-normal text-muted-foreground tabular-nums">
              +{bots.length - faces.k}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** Whether you said it: not the agent, and not a slot (rh send) or Rhodium (a child's report), which
 *  prompt.ts's sendLine and REPORT_LINE name in its source line. */
const yours = (l: NonNullable<Card["last"]>) => l.role === "user" && !/^(槽位 |Rhodium)/.test(l.source ?? "");

// Each kind's colour, for its dot, its state and why it is not in a turn.
export const COLOR: Record<Kind, string> = { needs: "[--c:var(--needs)]", running: "[--c:var(--running)]", done: "[--c:var(--done)]", idle: "", archived: "" };

// The slot whose row is to flash once it shows, and the rows that show.
let flashing: string | null = null;
const rows = new Set<() => void>();
/** Flashes slot's row once (story 412), now if it shows, else as soon as it does. */
export const flash = (slot: string) => ((flashing = slot), rows.forEach((f) => f()));

/** Slot id's row, to flash when asked: scrolled to, a blue that fades. */
function useFlash(id: string) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const f = () => {
      const a = link.current;
      if (flashing !== id || !a) return;
      flashing = null;
      // A frame on, once the page that came is scrolled to its top (main.tsx).
      requestAnimationFrame(() => {
        a.scrollIntoView({ block: "nearest" });
        a.animate([{ backgroundColor: `color-mix(in oklab, ${getComputedStyle(a).getPropertyValue("--running")} 30%, transparent)` }], { duration: 1200, easing: "ease-out" });
      });
    };
    f();
    rows.add(f);
    return () => void rows.delete(f);
  }, [id]);
  return link;
}

// The row last clicked, till it opens: the list does not scroll under the pointer.
let clicked: string | null = null;

/** Slot id's row (link), in sight once it is the open one (open), as the list or the sidebar comes or
 *  Alt+↑↓ or the jump box go to it, but by a click on it, which onClick marks. */
function useInSight(link: RefObject<HTMLAnchorElement | null>, id: string, open: boolean) {
  useEffect(() => {
    if (open && clicked !== id) link.current?.scrollIntoView({ block: "nearest" });
    if (open) clicked = null;
  }, [open]);
  // Not the open one, nor one opened in another tab: no open to follow, it would stay marked.
  return (e: MouseEvent) => open || e.metaKey || e.ctrlKey || e.shiftKey || (clicked = id);
}

/** One running but not in a turn, as waiting for quota, or that could not switch back: it says why in
 *  place of the last thing said. */
const whyNot = (c: Card, kind: Kind) => (kind === "running" && c.state !== "运行中") || c.state === "没能切回无头";

/** A slot's state in a word: 需要你 or 崩溃, 运行中, or how long ago its turn ended, it was archived, or
 *  it was last active. */
export function word(c: Card, kind: Kind) {
  if (kind === "needs") return c.state.startsWith("崩溃") ? "崩溃" : "需要你";
  if (kind === "running") return "运行中";
  if (kind === "done" && c.turnEndedAt) return ago(c.turnEndedAt);
  if (kind === "archived") return c.archivedAt !== null && ago(c.archivedAt);
  return c.activeAt > 0 && ago(c.activeAt);
}

/** Before a slot's state, a green dot while it is unread (spec web-maximize "未读和跑完提醒怎么做"). */
function Unread({ id }: { id: string }) {
  return useUnread(id) && <span role="img" aria-label="未读" className="mr-1.5 inline-block size-2 rounded-full bg-done align-[0.05em]" />;
}

/** What a slot's second line says: why it is not in a turn, or the last thing said, yours after 你：. */
const Last = ({ c, why }: { c: Card; why: boolean }) =>
  why ? c.state : c.last && (yours(c.last) ? <><b className="font-medium text-foreground/75">你：</b>{c.last.text}</> : c.last.text);

let resting: ReturnType<typeof setTimeout> | undefined;
let slotCode: typeof import("./slot") | undefined;
/** What starts bringing slot id's chat, its code and newest page, as you go to open it (#356): the mouse
 *  down on its row, not its right button, which opens the row's menu; or resting on it a moment after
 *  it moved, as a wheel scrolling the row under a still mouse moves none; leaving the row stops what is
 *  still coming, but of one pressed on. A finger down brings the code alone, which every slot shares:
 *  it may be starting a scroll of the list. Not while the browser saves data. */
const toward = (id: string) => {
  const go = (page: boolean, open = false) => mayPrefetch() && void import("./slot").then((m) => ((slotCode = m), page && m.ahead(id, open)), () => {});
  return {
    onPointerMove: (e: PointerEvent) => e.pointerType === "mouse" && (clearTimeout(resting), (resting = setTimeout(() => go(true), 100))),
    onPointerLeave: () => (clearTimeout(resting), slotCode?.behind()),
    onPointerDown: (e: PointerEvent) => (clearTimeout(resting), e.button === 0 && go(e.pointerType === "mouse", true)),
  };
};

/** A slot's row, which opens it. Two lines: the logo beside its name and state, the last thing said
 *  under them; where there is room, one. A child is indented under its parent. Beside its chat, it is in
 *  sight as the slot changes but by a click on it. */
function SlotRow({ r: { c, kind, ws, depth, full, bots } }: { r: Row }) {
  const why = whyNot(c, kind);
  const state = kind === "done" && c.turnEndedAt ? `${word(c, kind)}结束` : word(c, kind);
  const kid = depth > 0;
  const quiet = kind === "idle" ? "opacity-70" : kind === "archived" ? "opacity-60" : "";
  const href = `/slot/${encodeURIComponent(c.id)}`;
  // Its chat open beside the list, on a wide screen.
  const open = useLocation()[0] === href;
  const archived = kind === "archived";
  const link = useFlash(c.id);
  const onClick = useInSight(link, c.id, open);
  const [hold, menu] = useRowMenu(c);
  return (
    <div
      style={{ "--d": Math.min(depth, 2) } as CSSProperties}
      className={cn(
        // Its ground, which the Bots' marks ring themselves in, and a rename box covers it with.
        "relative [--av:40px] [--row:var(--card)] @min-[40rem]:[--av:34px]",
        // A line between rows, from the text on.
        "not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[calc(14px+var(--d)*52px+var(--av)+12px)] not-first:before:border-t not-first:before:border-border",
        "@min-[40rem]:not-first:before:left-[calc(20px+var(--d)*42px+var(--av)+14px)]",
        kid && "[--av:30px] @min-[40rem]:[--av:26px]",
      )}
    >
      <Link
        ref={link}
        href={href}
        // What a medium screen's 缩小 goes back to.
        state={{ up: "list" }}
        {...toward(c.id)}
        aria-current={open ? "page" : undefined}
        onClick={onClick}
        {...hold}
        className={cn(
          "grid grid-cols-[var(--av)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-[11px] pr-3.5 pl-[calc(14px+var(--d)*52px)] [--c:var(--muted-foreground)]",
          "bg-(--row) hover:[--row:color-mix(in_oklab,var(--foreground)_4%,var(--card))] active:[--row:var(--accent)]",
          // Inside the row: the card's rounded corners cut off what sticks out.
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          "@min-[40rem]:grid-cols-[var(--av)_calc(250px-var(--d)*42px-var(--av)+var(--bw))_minmax(0,1fr)_auto] @min-[40rem]:gap-x-3.5 @min-[40rem]:pr-5 @min-[40rem]:pl-[calc(20px+var(--d)*42px)]",
          kid && "py-[9px] @min-[40rem]:py-2",
          // Room at the right for its restore button.
          archived && "pr-14 @min-[40rem]:pr-16",
          open && "[--row:var(--accent)] hover:[--row:var(--accent)]",
          COLOR[kind],
          hold?.className,
        )}
      >
        <span
          className={cn(
            "relative row-span-2 grid size-(--av) place-items-center self-start rounded-[calc(var(--av)*0.3)] bg-muted font-semibold text-muted-foreground @min-[40rem]:row-span-1 @min-[40rem]:self-center",
            kind === "idle" && "opacity-85",
            kind === "archived" && "opacity-50 grayscale",
          )}
        >
          {/* No agent yet, as before its first conversation: its initial, which says nothing more to a screen reader. */}
          {c.agent ? <AgentLogo agent={c.agent} className="size-[55%]" /> : <span aria-hidden>{c.name[0]?.toUpperCase()}</span>}
          {kind !== "idle" && kind !== "archived" && (
            <span
              className={cn(
                "absolute -right-[3px] -bottom-[3px] size-3 rounded-full border-[2.5px] border-card bg-(--c) @min-[40rem]:size-[11px] @min-[40rem]:border-2",
                kid && "size-2.5 border-2 @min-[40rem]:size-[9px]",
              )}
            >
              {kind === "running" && !why && <span className="absolute inset-0 rounded-full bg-(--c) opacity-55 motion-safe:animate-ripple" />}
            </span>
          )}
        </span>
        {/* The faces small where the last line is under the name, full size where it is beside it. */}
        <Name ws={full ? ws : undefined} name={c.name} bots={bots} className={cn("flex min-w-0 text-[15.5px] font-semibold tracking-[-0.005em] whitespace-nowrap @min-[40rem]:text-[15px] @min-[40rem]:[--face:24px]", kid && "text-[14.5px]", quiet)} />
        <span
          className={cn(
            "text-xs whitespace-nowrap text-(--c) tabular-nums @min-[40rem]:col-start-4 @min-[40rem]:row-start-1 @min-[40rem]:text-[13px]",
            kind === "needs" && "rounded-full bg-[color-mix(in_oklab,var(--c)_15%,var(--card))] px-2 py-0.5 font-semibold",
          )}
        >
          <Unread id={c.id} />
          {state}
        </span>
        <span
          className={cn(
            "col-span-2 truncate text-[13.5px] text-muted-foreground @min-[40rem]:col-span-1 @min-[40rem]:col-start-3 @min-[40rem]:row-start-1 @min-[40rem]:text-sm",
            kid && "text-[13px]",
            why && "text-(--c)",
            quiet,
          )}
        >
          <Last c={c} why={why} />
        </span>
      </Link>
      {archived && (
        <Suspense>
          <Restore slot={c.id} className="absolute top-1/2 right-1.5 grid size-11 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground active:bg-accent @min-[40rem]:right-2.5" />
        </Suspense>
      )}
      {menu}
    </div>
  );
}

// ---- maximize mode's sidebar (spec web-maximize) ----

// Its 新建槽位 and 导入 write, so they come only once opened.
const SideSheets = lazy(() => import("./create").then((m) => ({ default: m.SideSheets })));

/** Opens the jump box, as ⌘K does: the jump box listens for it. */
export const openJump = () => dispatchEvent(new Event("rh-jump"));

/** Where slot id opens in maximize mode, from where the mode came. */
const maxHash = (id: string, from: "list" | "topology") => (from === "topology" ? `#/topology/slot/${encodeURIComponent(id)}?chat&full` : `#/slot/${encodeURIComponent(id)}?full`);

/** The slot whose chat is open at address at, beside the list or the topology; "" for none. */
export const openSlot = (at: string) => decodeURIComponent((/^\/(?:topology\/)?slot\/([^/?]+)/.exec(at) ?? [])[1] ?? "");

/** The sidebar's buttons on top, in px: three under each other with their names; or a row of icons, as
 *  tall as the chat's top bar beside it, so the lines under them meet. */
const HEAD = { open: 128, shut: 57 };
/** How far scrolled the buttons shrink: past the 71px it frees, by a little, so what they then show is
 *  rows, not the empty top. */
const SHUT_AT = HEAD.open - HEAD.shut + 16;

/** Whether the sidebar's buttons are a row of icons, scrolled top px, as they were (was): from SHUT_AT
 *  on, till back at the very top. So they never shrink and grow by turns, and growing cover no row in
 *  sight. */
export const shrunk = (was: boolean, top: number) => (was ? top > 0 : top >= SHUT_AT);

/** The room at the end of a sidebar that scrolls over px without it, so it scrolls past SHUT_AT, a pixel
 *  to spare for a scroll position not whole; none for one that does not scroll at all. */
export const endRoom = (over: number) => (over > 0 ? Math.max(0, SHUT_AT + 1 - over) : 0);

/** Whether e is on the blank of the sidebar's buttons on top: right of where the widest of the three
 *  reaches grown (8px in, its scrollWidth: its width with its name, whole px, so a px to spare). Not
 *  under or between the icons: growing would put a button there. */
const onBlank = (e: MouseEvent<HTMLElement>) => {
  const head = e.currentTarget;
  return e.target === head && e.clientX - head.getBoundingClientRect().left > 9 + Math.max(...[...head.children].slice(0, 3).map((b) => b.scrollWidth));
};

/** Maximize mode's sidebar: no title; on top, 新建槽位, 跳转 and 导入, staying there over the rest as it
 *  scrolls; then the board's rows in the board's order with no cards: what needs you, by full name;
 *  each workspace a tab that folds, as on the board, its slots a little in under it; those alone in their
 *  workspace, by full name; the archived folded at the bottom. A row opens its slot in maximize mode,
 *  from where the mode came (from). wide: dragged wider than the narrowest phone's list, its rows are
 *  the phone's two lines. Scrolled from the top, the buttons shrink to a row of icons (shrunk), leaving
 *  the rows more room; they lie over the list, which keeps their full height on top, so no row moves as
 *  they do. Shrunk, they grow back for a while (peeking) over the rows, which stay as they are shrunk: as
 *  the mouse rests on their blank, till a second after it leaves; tapped there, till tapped again; till
 *  the list scrolls or one is pressed. Scrolled into a workspace, its tab sticks under them. */
export function SideList({ from, wide }: { from: "list" | "topology"; wide?: boolean }) {
  const { data } = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board") });
  const [sheet, setSheet] = useState<"new" | "import" | null>(null);
  const [arcOpen, setArcOpen] = useState(archivedOpen);
  const [shut, setShut] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const peekAt = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [above, setAbove] = useState(false);
  const [at] = useLocation();
  const current = openSlot(at);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const needsRef = useRef<HTMLDivElement>(null);
  const [was, hover] = useHeld(data);
  // Its rows taller or shorter, the open one stays in sight.
  useEffect(() => void scroller.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" }), [wide]);
  // A list that scrolls at all scrolls far enough for the buttons to shrink: room at its end if need be.
  useEffect(() => {
    const [el, room] = [scroller.current, end.current];
    if (!el || !room) return;
    const sized = new ResizeObserver(() => (room.style.height = `${endRoom(el.scrollHeight - room.offsetHeight - el.clientHeight)}px`));
    sized.observe(el);
    sized.observe(list.current!);
    return () => sized.disconnect();
  }, [!!data]);
  // What needs you all out of sight under the buttons: 需要你 at the end of their first row, which goes
  // back up. Not pinned on top: five or six would take too much room.
  const anyNeeds = !!data?.workspaces.some((w) => w.groups.needsYou.length);
  useEffect(() => {
    const el = needsRef.current;
    if (!el) return setAbove(false);
    const seen = new IntersectionObserver(([e]) => setAbove(!e!.isIntersecting), { root: scroller.current, rootMargin: `-${shut ? HEAD.shut : HEAD.open}px 0px 0px 0px` });
    seen.observe(el);
    return () => seen.disconnect();
  }, [anyNeeds, shut]);
  if (!data) return null;
  const { needs, pinned, cards, archived } = steady(was, data);
  // The buttons as a row of icons: shrunk, not grown back for a while. All else goes by shut.
  const icons = shut && !peeking;
  // 新建槽位 picks the open slot's workspace, as an agent's app starts a session in the project open.
  const ws = data.workspaces.find((w) => [...Object.values(w.groups).flat(), ...w.archived].some((c) => c.id === current))?.name;
  const rowsOf = (rows: Row[], under?: boolean) => rows.map((r) => <SideRow key={r.c.id} r={r} from={from} under={under} />);
  return (
    // --head: how far down the buttons reach now, under which a tab sticks. The scroll padding keeps a
    // row scrolled or paged to clear of them and a stuck tab (a row's scroll margin takes the tab back
    // off where there is none). Its scroll bar shows only under the pointer or the focus (index.css).
    <div
      ref={scroller}
      data-wide={wide || undefined}
      data-shut={shut || undefined}
      data-quiet-scroll=""
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setShut((was) => shrunk(was, top));
        clearTimeout(peekAt.current);
        setPeeking(false);
      }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        const down = ({ PageDown: true, PageUp: false, " ": !e.shiftKey } as Record<string, boolean>)[e.key];
        // Space on a button presses it, in a row's name box types it. A key in a sheet, out of the list in the page, is not the list's.
        if (down === undefined || e.altKey || e.ctrlKey || e.metaKey || !e.currentTarget.contains(t) || (e.key === " " && t.closest("button, input"))) return;
        if (turnPage(e.currentTarget, down)) e.preventDefault();
      }}
      style={{ "--head": `${shut ? HEAD.shut : HEAD.open}px` } as CSSProperties}
      className="group/side h-full scroll-pt-[calc(var(--head)+2rem)] overflow-y-auto"
    >
      <nav aria-label="槽位">
        <div className="sticky top-0 z-10 h-0">
          {/* Shrinking, all moves once the names are gone (Tab's fade). */}
          <div
            onPointerMove={(e) => {
              if (e.pointerType !== "mouse") return;
              clearTimeout(peekAt.current);
              if (shut && !peeking && onBlank(e)) peekAt.current = setTimeout(() => setPeeking(true), 300);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== "mouse") return;
              clearTimeout(peekAt.current);
              if (peeking) peekAt.current = setTimeout(() => setPeeking(false), 1000);
            }}
            onClick={(e) => {
              const blank = onBlank(e);
              if (!blank || (e.nativeEvent as globalThis.PointerEvent).pointerType !== "mouse") setPeeking((p) => blank && shut && !p);
            }}
            style={{ height: icons ? HEAD.shut : HEAD.open }}
            className={cn("relative border-b border-border/70 bg-sidebar transition-[height] duration-200 ease-out motion-reduce:transition-none", icons && "delay-75")}
          >
            {/* Grown for a while, each as wide as what it says: the blank tapped stays blank, to tap again. */}
            <Tab i={0} shut={icons} fit={peeking} icon={SquarePen} onClick={() => setSheet("new")}>
              新建槽位
            </Tab>
            <Tab i={1} shut={icons} fit={peeking} icon={Search} onClick={openJump} hint={MAC ? "⌘K" : "Ctrl+K"}>
              跳转
            </Tab>
            <Tab i={2} shut={icons} fit={peeking} icon={Import} onClick={() => setSheet("import")}>
              导入
            </Tab>
            {above && (
              <button
                // It goes as they come in sight: the focus, with them.
                onClick={() => (scroller.current?.scrollTo({ top: 0, behavior: "smooth" }), needsRef.current?.querySelector("a")?.focus({ preventScroll: true }))}
                className="absolute top-[15px] right-2 flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--needs)_15%,var(--sidebar))] py-1 pr-2.5 pl-2 text-[13px] font-semibold text-needs ring-1 ring-needs/30 transition-colors hover:bg-[color-mix(in_oklab,var(--needs)_25%,var(--sidebar))] focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ArrowUp className="size-3.5" />
                需要你
              </button>
            )}
          </div>
        </div>
        <div ref={list} style={{ paddingTop: HEAD.open }} className="px-2 pb-6" {...hover}>
          {needs.length > 0 && (
            <div ref={needsRef} className="mt-1 grid gap-px">
              {rowsOf(needs)}
            </div>
          )}
          {pinned.length > 0 && (
            <div className="mt-2 grid gap-px">
              <Pinned className="h-8 px-2" />
              {rowsOf(pinned)}
            </div>
          )}
          {/* 置顶 ends with a line, as the buttons on top do: the next block may have no name over it. */}
          {pinned.length > 0 && (cards.length > 0 || archived.length > 0) && <hr className="-mx-2 mt-2 border-border/70" />}
          {cards.map((x) =>
            x.name ? (
              <SideWorkspace key={x.name} name={x.name} rows={x.rows} row={(r) => <SideRow key={r.c.id} r={r} from={from} under />} />
            ) : (
              <div key={x.rows[0]!.c.id} className="mt-2 grid gap-px">
                {rowsOf(x.rows)}
              </div>
            ),
          )}
          {!needs.length && !pinned.length && !cards.length && <p className="my-6 px-2 text-sm text-muted-foreground">没有在用的槽位。</p>}
          {archived.length > 0 && (
            <SideFold
              className="mt-3"
              open={arcOpen}
              onOpenChange={(open) => ((archivedOpen = open), setArcOpen(open))}
              tab={
                <>
                  已归档
                  <span className="ml-auto tabular-nums">{archived.length}</span>
                </>
              }
              peek={rowsOf(peek(archived, at))}
            >
              {rowsOf(archived)}
            </SideFold>
          )}
        </div>
        <div ref={end} />
      </nav>
      {sheet && (
        <Suspense>
          <SideSheets open={sheet} close={() => setSheet(null)} ws={ws} done={(id) => goHash(maxHash(id, from))} />
        </Suspense>
      )}
    </div>
  );
}

/** Pages the sidebar el down or up, as the page keys and space do: the row whole at the page's far edge
 *  comes whole to its near one, under the buttons on top and a stuck tab (the scroll padding, less a
 *  row's scroll margin where it has no tab over it), or at the bottom. The browser's own page keeps an
 *  eighth of the page, which a row and the room a tab leaves can be more than. Whether it moved: none
 *  that would, as on a page of folded tabs, the browser pages. */
function turnPage(el: HTMLElement, down: boolean): boolean {
  const box = el.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(el).scrollPaddingTop);
  const whole = [...el.querySelectorAll("nav a")].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.top >= box.top + pad + parseFloat(getComputedStyle(a).scrollMarginTop) - 0.5 && r.bottom <= box.bottom + 0.5;
  });
  const was = el.scrollTop;
  (down ? whole.at(-1) : whole[0])?.scrollIntoView({ block: down ? "start" : "end" });
  return el.scrollTop !== was;
}

/** One of the sidebar's buttons on top, the i-th: its icon and what it does; hint, its key. shut, it
 *  slides into a row with the others, its name gone from sight, still read out and shown on hover. fit,
 *  as wide as what it says, not the row. */
function Tab({ i, shut, fit, icon: Icon, hint, onClick, children }: { i: number; shut: boolean; fit?: boolean; icon: LucideIcon; hint?: string; onClick: () => void; children: string }) {
  // The name fades before the buttons move (their delay), and comes back once they are in place.
  const fade = cn("transition-opacity motion-reduce:transition-none", shut ? "opacity-0 duration-75" : "delay-150 duration-150");
  return (
    <button
      aria-label={children}
      title={shut ? (hint ? `${children} ${hint}` : children) : undefined}
      onClick={onClick}
      style={shut ? { top: 10, left: 8 + 40 * i, width: 36 } : { top: 10 + 37 * i, left: 8, width: fit ? "auto" : "calc(100% - 16px)" }}
      className={cn(
        "absolute flex h-9 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-left text-[14px] whitespace-nowrap text-foreground/90 transition-[top,left,width] duration-200 ease-out hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-foreground/[0.08] motion-reduce:transition-none",
        shut && "delay-75",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className={fade}>{children}</span>
      {hint && <kbd className={cn("ml-auto font-sans text-xs text-muted-foreground/80", fade)}>{hint}</kbd>}
    </button>
  );
}

/** A fold of the sidebar, a workspace's or the archived: its tab, which folds it, and what it holds,
 *  shown while open; folded, peek, the open slot's row if it holds it (story 435). Scrolled into, the
 *  tab sticks under the buttons on top, moving with them as they shrink and grow, till the next fold's
 *  pushes it off. Folded or unfolded, the tab stays where it is on screen: folded where it sticks, the
 *  next fold comes right under it. Not a CollapsibleContent, which goes a frame late, after the tab is
 *  put back. --tab: the tab's height, which a row scrolled to keeps clear of. */
function SideFold({ open, onOpenChange, tab, peek, className, children }: { open: boolean; onOpenChange: (open: boolean) => void; tab: ReactNode; peek: ReactNode; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const was = useRef<number | null>(null);
  useLayoutEffect(() => {
    const t = ref.current;
    if (was.current === null || !t) return;
    // Where the fold itself is, not its tab: stuck, the tab says nothing of how far the list scrolled.
    t.closest("nav")!.parentElement!.scrollTop += t.closest("[data-slot=collapsible]")!.getBoundingClientRect().top - was.current;
    was.current = null;
  }, [open]);
  return (
    <Collapsible className={cn("[--tab:2rem]", className)} open={open} onOpenChange={(o) => ((was.current = ref.current!.getBoundingClientRect().top), onOpenChange(o))}>
      {/* The sidebar's ground: no row shows through as it passes under. */}
      <div className="sticky top-(--head) z-[5] bg-sidebar transition-[top] duration-200 ease-out group-data-shut/side:delay-75 motion-reduce:transition-none">
        <CollapsibleTrigger ref={ref} className="group flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.05]">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          {tab}
        </CollapsibleTrigger>
      </div>
      {open ? <div className="grid gap-px">{children}</div> : peek}
    </Collapsible>
  );
}

/** A workspace as the sidebar's tab: its name, which folds it, folded on this device as on the board;
 *  folded, how many slots it has, and the open one's row. row: a row as the sidebar draws it. */
function SideWorkspace({ name, rows, row }: { name: string; rows: Row[]; row: (r: Row) => ReactNode }) {
  const [open, setOpen] = useState(() => !folded(name));
  const [at] = useLocation();
  return (
    <SideFold
      className="mt-2"
      open={open}
      onOpenChange={(o) => (setOpen(o), fold(name, !o))}
      tab={
        <>
          <span className="truncate font-semibold">{name}</span>
          {!open && <Count rows={rows} className="ml-auto gap-1.5" />}
        </>
      }
      peek={peek(rows, at).map(row)}
    >
      {rows.map(row)}
    </SideFold>
  );
}

/** A slot's row in the sidebar, two tight lines: the logo with its state's dot, the name and the state
 *  (none once archived: faded and in order, they need no time); the last thing said under them. under:
 *  under a workspace's tab, a little in; a child 16px further in under its parent. The open one has a
 *  ground of its own, and is in sight as the sidebar comes or the slot changes but by a click on it. */
function SideRow({ r: { c, kind, ws, depth, full, bots }, from, under }: { r: Row; from: "list" | "topology"; under?: boolean }) {
  const why = whyNot(c, kind);
  const kid = depth > 0;
  const quiet = kind === "idle" ? "opacity-70" : kind === "archived" ? "opacity-60" : "";
  const open = openSlot(useLocation()[0]) === c.id;
  const archived = kind === "archived";
  const link = useFlash(c.id);
  const onClick = useInSight(link, c.id, open);
  const [hold, menu] = useRowMenu(c);
  return (
    // Its ground, which the Bots' marks ring themselves in, and a rename box covers it with.
    <div className="relative [--row:var(--sidebar)]">
      <a
        ref={link}
        href={maxHash(c.id, from)}
        {...toward(c.id)}
        aria-current={open ? "page" : undefined}
        onClick={onClick}
        {...hold}
        style={{ paddingLeft: 8 + (under ? 14 : 0) + Math.min(depth, 2) * 16 }}
        className={cn(
          "grid scroll-mt-[calc(var(--tab,0px)-2rem)] scroll-mb-2 grid-cols-[var(--av)_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg py-1.5 pr-2 [--av:28px] [--c:var(--muted-foreground)]",
          "bg-(--row) hover:[--row:color-mix(in_oklab,var(--foreground)_4%,var(--sidebar))]",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          // Wide, the phone's two lines, the logo a size up.
          "group-data-wide/side:gap-x-3 group-data-wide/side:gap-y-0.5 group-data-wide/side:py-2.5 group-data-wide/side:[--av:40px]",
          kid && "[--av:22px] group-data-wide/side:py-2 group-data-wide/side:[--av:30px]",
          archived && "pr-10",
          open && "[--row:color-mix(in_oklab,var(--foreground)_7%,var(--sidebar))] hover:[--row:color-mix(in_oklab,var(--foreground)_7%,var(--sidebar))]",
          COLOR[kind],
          hold?.className,
        )}
      >
        <span className={cn("relative row-span-2 grid size-(--av) place-items-center self-start rounded-[calc(var(--av)*0.3)] bg-background font-semibold text-muted-foreground", kid ? "mt-px" : "mt-0.5", archived && "opacity-50 grayscale")}>
          {c.agent ? <AgentLogo agent={c.agent} className="size-[58%]" /> : <span aria-hidden>{c.name[0]?.toUpperCase()}</span>}
          {kind !== "idle" && !archived && (
            <span className={cn("absolute -right-[3px] -bottom-[3px] size-2.5 rounded-full border-2 border-sidebar bg-(--c) group-data-wide/side:size-3", kid && "size-2 group-data-wide/side:size-2.5")}>
              {kind === "running" && !why && <span className="absolute inset-0 rounded-full bg-(--c) opacity-55 motion-safe:animate-ripple" />}
            </span>
          )}
        </span>
        {/* In two tight lines, the marks lifted and ringed thinner, clear of the last line under them. */}
        <Name
          ws={full ? ws : undefined}
          name={c.name}
          bots={bots}
          mark="ring-[1.5px] -translate-y-0.5 group-data-wide/side:translate-y-0 group-data-wide/side:ring-2"
          className={cn("flex min-w-0 items-center text-[14px] font-semibold whitespace-nowrap group-data-wide/side:text-[15.5px]", kid && "text-[13.5px] group-data-wide/side:text-[14.5px]", quiet)}
        />
        <span className={cn("text-xs whitespace-nowrap text-(--c) tabular-nums", kind === "needs" && "rounded-full bg-[color-mix(in_oklab,var(--c)_15%,var(--sidebar))] px-1.5 py-px font-semibold")}>
          <Unread id={c.id} />
          {!archived && word(c, kind)}
        </span>
        <span className={cn("col-start-2 col-end-4 truncate text-[12.5px] text-muted-foreground group-data-wide/side:text-[13.5px]", kid && "group-data-wide/side:text-[13px]", why && "text-(--c)", quiet)}>
          <Last c={c} why={why} />
        </span>
      </a>
      {archived && (
        <Suspense>
          <Restore slot={c.id} className="absolute top-1/2 right-0 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.05]" />
        </Suspense>
      )}
      {menu}
    </div>
  );
}
