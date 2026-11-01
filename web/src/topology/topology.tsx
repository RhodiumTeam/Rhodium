// The topology view (spec web-topology): each Bot with its chat windows on the left, the workspaces on
// the right, the bindings as lines. A tap focuses a node or a line and lights what it is related to; tapping the
// focus again lets go of it. A chat window stands for its slot, a Bot only lights. The details are in a
// bottom sheet you drag to any height on a phone, in a card at the right on a wide screen. The camera
// keeps the tapped node under the finger. Back goes to the last place you stopped, a move within one
// level replacing the one before. The page loads this only once you open the view; the layout is in
// model.ts.
import { useQuery } from "@tanstack/react-query";
import { BaseEdge, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi, ViewportPortal, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "cn";
import { Archive, ArchiveRestore, ArrowRight, ArrowRightLeft, Bot as BotIcon, Check, Plus, ChevronDown, ChevronRight, ChevronUp, Ellipsis, Folder, GitFork, Hourglass, House, MessageCircleQuestionMark, Pencil, Power, Send, Square, SquareTerminal, Star, TriangleAlert, Undo2, UnfoldVertical, Wrench, X } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type TouchEvent as TouchStart } from "react";
import { useLocation } from "wouter";
import type { BoardAct } from "../../../src/contracts";
import { AgentLogo, BoardHeader, ROOM, useMedia, useTheme, WIDE } from "../common";
import { json, refresh, type Episode, type SlotData, type TopologyData } from "../data";
import { connText, Face, Mark } from "../faces";
import { addStep, below, clamp, drafted, drop, dropAt, editLit, editTap, endOf, grab, grabbed, LONG_PRESS, pressed, type Grab, type Step, fitTo, H, hidden, into, keep, key, known, least, MARGIN, NONE, pick, put, reachOf, readRoute, replaces, routeHash, seen, SHEET, stale, status, swap, toward, trail, undoOf, undoStep, union, view, type Bot, type Change, type Chat, type Data, type Edit, type Focus, type Graph, type Line, type Rect, type Route, type Slot, type Status, type View, type Viewport } from "./model";
import "./topology.css";
import { act, MenuAt, Pick, Spin, TakeBack, Toasts, ToTerminal, useAct, type Choice } from "../write";
import { inTurn, Timeline } from "../timeline";
import { toast } from "../toast";
import { NewSlot } from "../create";

const TEXT: Record<Status, string> = { needs: "text-needs", running: "text-running", idle: "text-idle" };
const BG: Record<Status, string> = { needs: "bg-needs", running: "bg-running", idle: "bg-idle" };
const EDGE: Record<Status, string> = { needs: "border-l-needs", running: "border-l-running", idle: "border-l-idle" };
const LINE: Record<Line["kind"], { stroke: string; strokeWidth: number; strokeDasharray?: string }> = {
  // A Bot's line and the links into its end thick, a chat's own line thin and dashed (story 370).
  bot: { stroke: "var(--bind)", strokeWidth: 3 },
  link: { stroke: "var(--bind)", strokeWidth: 3 },
  own: { stroke: "var(--bind)", strokeWidth: 1.5, strokeDasharray: "6 4" },
  spawn: { stroke: "var(--tree)", strokeWidth: 1.25 },
};
const RING = "ring-2 ring-foreground ring-offset-2 ring-offset-background";

const MainStar = ({ label }: { label: string }) => <Star role="img" aria-label={label} className="size-3.5 shrink-0 fill-current text-muted-foreground" />;

/** A state's mark where a word would not fit: 需要你, 崩溃 and 等额度; running and quiet ones have none,
 *  their edge's colour already says so. */
const STATE_ICON: Partial<Record<Slot["phase"], typeof Archive>> = { waiting: MessageCircleQuestionMark, crashed: TriangleAlert, rate_limited: Hourglass };
/** What is worth saying about a slot: archived, TUI, or a state's mark. full: with the dot and every
 *  state's word (the details). */
function SlotMark({ slot, full }: { slot: Slot; full?: boolean }) {
  const s = status(slot);
  const Icon = slot.group === "needsYou" && slot.phase !== "crashed" ? MessageCircleQuestionMark : STATE_ICON[slot.phase];
  if (slot.archived)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-idle">
        <Archive role="img" aria-label="已归档" className="size-3.5" />
        {full && "已归档"}
      </span>
    );
  if (slot.mode === "tui")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-running">
        <SquareTerminal role="img" aria-label="TUI 模式" className="size-3.5" />
        {full && "TUI"}
      </span>
    );
  if (!full) return Icon ? <Icon role="img" aria-label={slot.state} className={cn("size-3.5 shrink-0", TEXT[s])} /> : null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", TEXT[s])}>
      <span className={cn("size-2 shrink-0 rounded-full", BG[s])} />
      <span className="truncate">{slot.state}</span>
    </span>
  );
}
/** How many slots need you and run, each a dot and a number; none, nothing. */
function Counts({ slots }: { slots: Slot[] }) {
  return (["needs", "running"] as const).map((s) => {
    const n = slots.filter((l) => !l.archived && status(l) === s).length;
    return (
      n > 0 && (
        <span key={s} role="img" aria-label={`${n} 个${s === "needs" ? "需要你" : "运行中"}`} className={cn("inline-flex shrink-0 items-center gap-0.5 text-xs", TEXT[s])}>
          <span className={cn("size-2 rounded-full", BG[s])} />
          {n}
        </span>
      )
    );
  });
}

/** A chat window's name: yours on the platform, or the group's; a private one with no name (QQ gives
 *  none) says 匿名用户 in a lighter italic, a placeholder rather than a name. */
const ChatName = ({ chat }: { chat: Chat }) =>
  chat.name ? <span className="truncate">{chat.name}</span> : <span className="truncate pr-0.5 text-muted-foreground/70 italic">{chat.kind === "group" ? "群聊" : "匿名用户"}</span>;
const BotFace = ({ bot, size = 28, ring }: { bot: Bot; size?: number; ring?: string }) => <Face url={bot.avatar} p={bot.platform} size={size} conn={bot.conn} ring={ring} />;
/** A line as the path and the details have it: its start's face, an arrow, its slot's logo; then name.
 *  ring: the ground's, for the face's mark (Face). */
function LineName({ g, of, size, name, ring }: { g: Graph; of: string; size: number; name: ReactNode; ring?: string }) {
  const b = g.bots.find((b) => b.id === of);
  const c = g.chats.find((c) => c.id === of);
  const s = reachOf(g, of);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {b ? <BotFace bot={b} size={size} ring={ring} /> : c && <Face url={c.avatar} kind={c.kind} size={size} ring={ring} />}
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      {s?.agent && <AgentLogo agent={s.agent} className={size > 20 ? "text-xl" : "text-sm"} />}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** The selection, as the canvas lights it: the focus, what it is related to, and the lines between. */
const Lit = createContext<{ sel: Focus; lit: Set<string> | null; edges: Set<string> }>({ sel: null, lit: null, edges: new Set() });
/** A node's look from the selection: a ring when it is the focus, faded when it is not related. An
 *  open workspace is a frame around what is in it, and never fades. */
function useLook(id: string, frame = false) {
  const { sel, lit } = useContext(Lit);
  return cn("transition-opacity duration-200", sel?.id === id && sel.kind !== "line" && RING, lit && !frame && !lit.has(id) && "opacity-30");
}

const HIDE = "!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent";
/** Lines draw from their own coordinates; React Flow only needs a handle at each end. */
const Handles = () => (
  <>
    <Handle type="target" id="l" position={Position.Left} className={HIDE} isConnectable={false} />
    <Handle type="source" id="r" position={Position.Right} className={HIDE} isConnectable={false} />
  </>
);

type P<K extends Data["kind"]> = NodeProps<Node<Extract<Data, { kind: K }>>>;

const BotNode = ({ id, data: { bot } }: P<"bot">) => (
  <div data-node="bot" className={cn("relative size-full cursor-pointer rounded-xl border bg-muted/70 hover:bg-muted", useLook(id))}>
    {/* Its end and start on the right of its title. */}
    <div className="flex h-10 items-center gap-1.5 pr-[18px] pl-2">
      <BotIcon role="img" aria-label="Bot" className="size-4 shrink-0 text-muted-foreground" />
      <BotFace bot={bot} />
      <span className="truncate text-sm font-medium">{bot.name}</span>
      {bot.main && <MainStar label="主 Bot" />}
    </div>
    <Handles />
  </div>
);

const ChatNode = ({ id, data: { chat } }: P<"chat">) => (
  <div data-node="chat" className={cn("flex size-full cursor-pointer items-center gap-2 rounded-lg border bg-card pr-1.5 pl-2 hover:bg-card-hover", useLook(id))}>
    <Face url={chat.avatar} kind={chat.kind} size={28} />
    <span className="flex min-w-0 text-sm">
      <ChatName chat={chat} />
    </span>
    {chat.main && <MainStar label="主窗口" />}
    <Handles />
  </div>
);

function WsNode({ id, data }: P<"ws">) {
  const { ws, open, rows } = data;
  const look = useLook(id, open);
  const name = (
    <>
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm font-semibold">{ws.name}</span>
    </>
  );
  // Closed, what needs you and runs of what it does not show.
  const counts = !open && (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <Counts slots={hidden(data)} />
      <ChevronRight className="size-4 text-muted-foreground" />
    </span>
  );
  // A frame round the slots it shows, open or closed: only its heading takes a tap.
  if (open || rows.length > 0)
    return (
      <div data-node="ws" className={cn("size-full rounded-xl border", open ? "bg-muted/40" : "bg-card shadow-xs", look)}>
        <div className={cn("pointer-events-auto flex h-10 cursor-pointer items-center gap-1.5 rounded-t-xl hover:bg-foreground/5", open ? "px-3" : "px-2.5")}>
          {name}
          {counts}
        </div>
        <Handles />
      </div>
    );
  return (
    <div data-node="ws" className={cn("flex size-full cursor-pointer items-center gap-1.5 rounded-xl border bg-card px-2.5 shadow-xs hover:bg-card-hover", look)}>
      {name}
      {counts}
      <Handles />
    </div>
  );
}

const SlotNode = ({ id, data: { slot, away } }: P<"slot">) => (
  <div data-node="slot" className={cn("flex size-full cursor-pointer items-center gap-1.5 rounded-lg border border-l-4 bg-card pr-2 pl-2 hover:bg-card-hover", slot.archived ? "border-l-idle opacity-70" : EDGE[status(slot)], useLook(id))}>
    {slot.agent && <AgentLogo agent={slot.agent} className="text-sm" />}
    <span className="min-w-0 truncate text-sm font-medium">{slot.name}</span>
    {away && <GitFork role="img" aria-label="跨工作区派生" className="size-3.5 shrink-0 text-muted-foreground" />}
    <span className="ml-auto" />
    <span className="text-xs">
      <SlotMark slot={slot} />
    </span>
    <Handles />
  </div>
);

const TYPES = { bot: BotNode, chat: ChatNode, ws: WsNode, slot: SlotNode };

/** Points as a path, each corner between two straight runs rounded. */
function through(p: [number, number][]) {
  let d = `M${p[0]![0]} ${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1]!, p[i]!, p[i + 1]!];
    const flat = (u: number[], v: number[]) => u[0] === v[0] || u[1] === v[1];
    const r = Math.min(8, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
    if (!flat(a, b) || !flat(b, c) || r === 0) {
      d += ` L${b[0]} ${b[1]}`;
      continue;
    }
    const to = (q: number[]) => [b[0] + Math.sign(q[0]! - b[0]) * r, b[1] + Math.sign(q[1]! - b[1]) * r];
    const [u, v] = [to(a), to(c)];
    d += ` L${u[0]} ${u[1]} Q${b[0]} ${b[1]} ${v[0]} ${v[1]}`;
  }
  const z = p.at(-1)!;
  return `${d} L${z[0]} ${z[1]}`;
}
/** Every line: a binding through its corners; a spawn as the file tree's elbow. */
function LineEdge({ id, data, style }: EdgeProps<Edge<Line>>) {
  const { kind, sx, sy, tx, ty, pts } = data!;
  const path = kind === "spawn" ? `M${sx},${sy} V${ty - 4} Q${sx},${ty} ${sx + 4},${ty} H${tx}` : through(pts!);
  // Thin as they are, the binding lines take a tap 24px wide (story 376).
  return <BaseEdge id={id} path={path} style={style} interactionWidth={kind === "spawn" || data!.was ? 0 : 24} />;
}
const EDGE_TYPES = { line: LineEdge };
/** No change drafted: one array, so what is worked out from the draft is kept while there is none. */
const NO_DRAFT: Change[] = [];

/** Where the camera was on this step in history, kept with it: back on it, from a slot's chat say,
 *  the view is as it was left. */
const saved = (): Viewport | undefined => history.state?.vp;
const save = (vp: Viewport) => history.replaceState({ ...history.state, vp }, "");

/** A line being drawn (stories 381, 382): from what, where the pointer is, and what it goes to there. */
type Drawn = Grab & { x: number; y: number; over: string | null };
/** Editing the bindings (spec web-write "拓扑图上的改绑定"): what is selected, what that lights, the
 *  changes in conflict, and a tap at a place on the graph, on a node if it is on one, k flow units a
 *  pixel; the line being drawn, what a press there draws from, and drawing it to x, y, then let go there. */
type Editing = {
  s: Edit;
  lit: ReturnType<typeof editLit>;
  stale: Set<string>;
  tap: (x: number, y: number, k: number, node: { kind: Data["kind"]; id: string } | null) => void;
  drag: Drawn | null;
  grab: (x: number, y: number, k: number) => Grab | null;
  begin: (d: Grab, x: number, y: number) => void;
  move: (x: number, y: number, k: number) => void;
  release: (d: Grab, x: number, y: number, k: number, cancel: boolean) => void;
};

/** The preview of a line drawn from a start to the end it goes to (story 381), as a binding line runs:
 *  into a Bot's end as a link does, else across the middle of the gap. */
function preview(v: View, d: Drawn): string | null {
  const at = (k: string) => v.points.find((p) => `${p.end ? "e" : "s"}:${p.of}` === k);
  const from = at(`${d.end ? "e" : "s"}:${d.of}`);
  if (!from) return null;
  if (!d.over) return `M${from.x} ${from.y} L${d.x} ${d.y}`;
  const [s, t] = d.end ? [at(`s:${d.over}`), from] : [from, at(`e:${d.over}`)];
  if (!s || !t) return null;
  const bot = v.nodes.some((n) => n.id === t.of && n.data.kind === "bot");
  const mid = (s.x + t.x) / 2;
  return through(bot ? [[s.x, s.y], [t.x, s.y], [t.x, t.y]] : Math.abs(s.y - t.y) < 6 ? [[s.x, s.y], [t.x, t.y]] : [[s.x, s.y], [mid, s.y], [mid, t.y], [t.x, t.y]]);
}

type CanvasProps = {
  v: View;
  focus: Focus;
  sel: boolean;
  archived: boolean;
  unfold: boolean;
  wide: boolean;
  refit: number;
  /** Laid out anew (story 317), the nodes sliding to where they go while sliding. */
  relaid: number;
  sliding: boolean;
  edit: Editing | null;
  onTap: (n: Node<Data>) => void;
  /** A line tapped, by its start. */
  onLine: (of: string) => void;
  onMenu: (slot: Slot, at: { x: number; y: number }) => void;
};
function Canvas({ v, focus, sel, archived, unfold, wide, refit, relaid, sliding, edit, onTap, onLine, onMenu }: CanvasProps) {
  const theme = useTheme();
  // While editing, what is selected lights; else the focus lights what it is related to.
  const lit = edit ? (edit.lit?.nodes ?? null) : sel ? v.lit : null;
  const litEdges = edit ? (edit.lit?.lines ?? new Set<string>()) : lit ? v.litLines! : new Set<string>();
  const picked = edit?.s.sel;
  const drag = edit?.drag;
  // Drawn to where it goes, the line it replaces fades (story 381).
  const gone = drag?.over ? (drag.end ? drag.over : drag.of) : null;
  const edges = useMemo(
    () =>
      v.edges
        .map((e): Edge => {
          const d = e.data!;
          const k = d.kind;
          const on = lit ? litEdges.has(e.id) : null;
          const mine = !!picked && d.of === picked && !d.was;
          // A change not yet made is blue and dashed, red once it is in conflict; the line it removes dark
          // red; the line selected blue and thicker (story 385).
          const color = d.was ? "var(--draft-removed)" : d.draft && edit?.stale.has(d.of!) ? "var(--draft-conflict)" : d.draft || mine ? "var(--running)" : on ? "var(--foreground)" : LINE[k].stroke;
          const dash = d.draft && k !== "own" ? "9 5" : LINE[k].strokeDasharray;
          return { ...e, style: { ...LINE[k], stroke: color, strokeDasharray: dash, strokeWidth: LINE[k].strokeWidth + (mine ? 1 : on ? 0.5 : 0), opacity: gone === d.of && !d.was ? 0.25 : on === false && !d.draft ? 0.12 : 1 } };
        })
        // What is removed under what is not, drafts over both, the lit on top.
        .sort((a, b) => +!a.data!.was - +!b.data!.was || +!!a.data!.draft - +!!b.data!.draft || +litEdges.has(a.id) - +litEdges.has(b.id)),
    [v, lit, litEdges, picked, edit?.stale, gone],
  );
  // Bounded: never zoomed out past where all of it fits (0.5 at least), never panned past its edge.
  const w = useStore((s) => s.width);
  const h = useStore((s) => s.height);
  const min = w && h ? least(v.extent, w, h) : 0.5;
  const { setViewport, getViewport } = useReactFlow();
  const store = useStoreApi();
  // What the screen showed where the camera kept a tapped node under the finger, came back to a view as
  // it was left, or stayed as the screen changed size: the bounds take it in, which the graph's alone
  // may not, one shorter than the screen being centred. Let go of once the camera has fitted the graph
  // anew: what it showed midway, as the sheet settled, is not where it ends.
  const [held, setHeld] = useState<Rect | null>(null);
  /** The zoom a pan or zoom started at. */
  const zoomedFrom = useRef(0);
  /** The graph's bounds on a w by h screen at a zoom: a phone's reach a screen below its top at that
   *  zoom, so dragged up it stays on the screen (#282). */
  const room = (w: number, h: number, zoom: number) => (wide || !h ? v.extent : below(v.extent, h, zoom));
  const zoom = useStore((s) => (wide ? 1 : s.transform[2]));
  const bounds = held ? union([room(w, h, zoom), held]) : room(w, h, zoom);
  /** The first view, and 总览's: a wide screen fits it all (the overview up to 1.2); a phone fits the
   *  width only, at 0.85 or more, from the top. */
  const fitted = () => {
    const { width, height } = store.getState();
    const floor = least(v.extent, width, height);
    // A phone keeps the whole width, Bots and all: the graph is no wider open than closed.
    const all = { ...v.box, x: v.extent.x + MARGIN, w: v.extent.w - 2 * MARGIN };
    return wide ? fitTo(v.box, width, height, floor, focus ? 1 : 1.2, v.extent, 12) : fitTo(all, width, height, Math.max(floor, 0.85), 1, room(width, height, floor), 12, v.top);
  };
  const fit = (duration: number) => void setViewport(fitted(), { duration }).then(() => setHeld(null));
  /** Glide the least that brings the focus into view: of an open workspace, its heading, what it opened
   *  being yours to swipe to. The screen as it is by then: the sheet may have shrunk to what the new
   *  focus has. */
  const into = (vp: Viewport, ext: Rect) => {
    // A line was tapped where it shows: the camera does not go after its start.
    const f = focus?.kind === "line" ? undefined : v.rects.get(focus?.id ?? "");
    const r: Rect | undefined = f && focus?.kind === "ws" ? { ...f, h: Math.min(f.h, 48) } : f;
    const { width, height } = store.getState();
    const to = r && toward(vp, r, width, height, ext);
    if (to && (to.x !== vp.x || to.y !== vp.y)) void setViewport(to, { duration: 300 });
  };
  const last = useRef<{ v: View; k: string; refit: number; archived: boolean; unfold: boolean; relaid: number } | null>(null);
  useEffect(() => {
    if (!w) return;
    const was = last.current;
    last.current = { v, k: key(focus), refit, archived, unfold, relaid };
    const glide = () => fit(was ? 400 : 0);
    if (!was) {
      const vp = saved();
      if (vp) return void (setHeld(seen(vp, w, h)), setViewport(vp));
      return void setTimeout(glide, 60);
    }
    // 总览 fits what is open.
    if (refit !== was.refit) return void setTimeout(glide, 60);
    // Laid out anew, the focus stays where it is on the screen as the nodes slide; with none, the camera stays.
    if (relaid !== was.relaid) {
      const r = v.rects.get(focus?.id ?? "");
      const o = was.v.rects.get(focus?.id ?? "");
      if (!r || !o || (r.x === o.x && r.y === o.y)) return;
      const vp = keep(getViewport(), o, r);
      setHeld(seen(vp, w, h));
      return void setViewport(vp, { duration: 300, interpolate: "linear" });
    }
    if (key(focus) === was.k && archived === was.archived && unfold === was.unfold) return;
    if (!focus) return;
    // The focus, new, with archived slots shown or hidden around it, or with every workspace unfolded or
    // not, stays where it was on the screen, at the same zoom, then comes into view if it isn't.
    const r = v.rects.get(focus.id);
    const o = was.v.rects.get(focus.id);
    let vp = getViewport();
    let ext = bounds;
    if (r && o) {
      const { width, height } = store.getState();
      vp = keep(vp, o, r);
      const shown = seen(vp, width, height);
      setHeld(shown);
      ext = union([room(width, height, vp.zoom), shown]);
      void setViewport(vp);
    }
    setTimeout(() => into(vp, ext), 60);
  }, [v, w, wide, wide && h, refit, relaid]);
  // When the phone's sheet settles at a new height, the view stays, and the focus comes back into view if
  // it went out of it. A wide screen fits the focus and its neighbours again as a chat beside it opens,
  // or its line is dragged.
  useEffect(() => {
    if (!last.current) return;
    const t = setTimeout(() => {
      if (wide && focus) return fit(300);
      const vp = getViewport();
      const { width, height } = store.getState();
      const shown = seen(vp, width, height);
      setHeld(shown);
      into(vp, union([room(width, height, vp.zoom), shown]));
    }, 150);
    return () => clearTimeout(t);
  }, [w, h]);
  const { screenToFlowPosition } = useReactFlow();
  /** A tap on a node, or off the nodes: while editing, the edit's; off them, on a line, or within 18px of
   *  one, focuses it. */
  const tapAt = (e: MouseEvent, n?: Node<Data>) => {
    if (Date.now() < quiet.current) return;
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // A Bot's title is the Bot's, though its followers' links, drawn over it, take the tap.
    const bot =
      n ??
      v.nodes.find((n) => {
        const r = n.data.kind === "bot" && v.rects.get(n.id);
        return r && at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + H.botHead;
      });
    if (edit) return edit.tap(at.x, at.y, 1 / getViewport().zoom, bot ? { kind: bot.data.kind, id: bot.id } : null);
    if (bot) return onTap(bot);
    const of = pick(v.edges.map((e) => e.data!), at.x, at.y, 18 / getViewport().zoom);
    if (of) onLine(of);
  };
  // A press on a dot while editing may draw a line (stories 381, 382): a finger held still 300ms, a
  // mouse moved 4px; a finger moved first pans, as anywhere else. Its pointer then is the canvas's.
  const press = useRef<{ d: Grab; id: number; x0: number; y0: number; x: number; y: number; t: number; mouse: boolean; drawing: boolean; el: Element; timer?: ReturnType<typeof setTimeout> } | null>(null);
  /** Till when a click is a drawn line let go of, not a tap; till the next press at most. */
  const quiet = useRef(0);
  const ed = useRef(edit);
  ed.current = edit;
  const flow = (x: number, y: number) => screenToFlowPosition({ x, y });
  const begin = () => {
    const p = press.current!;
    p.drawing = true;
    p.el.setPointerCapture(p.id);
    if (!p.mouse) navigator.vibrate?.(8);
    const at = flow(p.x, p.y);
    ed.current?.begin(p.d, at.x, at.y);
  };
  const up = (e: PointerEvent, cancel: boolean) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    clearTimeout(p.timer);
    press.current = null;
    if (!p.drawing) return;
    quiet.current = Date.now() + 300;
    const at = flow(e.clientX, e.clientY);
    ed.current?.release(p.d, at.x, at.y, 1 / getViewport().zoom, cancel);
  };
  // Drawing, the finger moves no graph: touch events stay with the element first touched, which a redraw
  // may take off the page, so this listens there, where d3-zoom's pan would hear them after.
  const still = useMemo(
    () => (e: TouchEvent) => {
      if (!press.current?.drawing) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    },
    [],
  );
  const pointers = {
    onPointerDown: (e: PointerEvent) => {
      // A press of its own is a tap again: only the click of the line let go of is quiet.
      quiet.current = 0;
      // A second finger, a pinch, is not a press.
      if (press.current) return void (!press.current.drawing && (clearTimeout(press.current.timer), (press.current = null)));
      if (!edit || e.button > 0) return;
      const at = flow(e.clientX, e.clientY);
      const d = edit.grab(at.x, at.y, 1 / getViewport().zoom);
      if (!d) return;
      const mouse = e.pointerType === "mouse";
      // A mouse's press on a dot pans nothing: no mousedown for d3-zoom.
      if (mouse) e.preventDefault();
      press.current = { d, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), mouse, drawing: false, el: e.currentTarget };
      if (!mouse) press.current.timer = setTimeout(() => press.current && !press.current.drawing && begin(), LONG_PRESS);
    },
    onPointerMove: (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.id) return;
      [p.x, p.y] = [e.clientX, e.clientY];
      if (!p.drawing) {
        const is = pressed(p.mouse, Math.hypot(p.x - p.x0, p.y - p.y0), performance.now() - p.t);
        if (is === "pan") return void (clearTimeout(p.timer), (press.current = null));
        if (is !== "draw") return;
        begin();
      }
      const at = flow(p.x, p.y);
      edit?.move(at.x, at.y, 1 / getViewport().zoom);
    },
    onPointerUp: (e: PointerEvent) => up(e, false),
    onPointerCancel: (e: PointerEvent) => up(e, true),
    // In capture, as d3-zoom stops it where it listens.
    onTouchStartCapture: (e: TouchStart) => e.target.addEventListener("touchmove", still as EventListener, { passive: false }),
    // A long press draws, and opens no menu.
    onContextMenu: (e: MouseEvent) => void (press.current && e.preventDefault()),
  };
  const path = drag && preview(v, drag);
  const { x, y, w: ew, h: eh } = bounds;
  return (
    <Lit.Provider value={{ sel: !edit && sel ? focus : null, lit, edges: litEdges }}>
      <ReactFlow
        className={cn(sliding && "sliding")}
        nodes={v.nodes}
        edges={edges}
        nodeTypes={TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={(e, n) => tapAt(e, n as Node<Data>)}
        onPaneClick={(e) => tapAt(e)}
        onEdgeClick={(e) => tapAt(e)}
        // A slot's menu where you right-click it, as its details have it (story 271).
        onNodeContextMenu={(e, n) => {
          const d = n.data as Data;
          if (press.current) return;
          if (d.kind !== "slot") return;
          e.preventDefault();
          onMenu(d.slot, { x: e.clientX, y: e.clientY });
        }}
        onMoveStart={(_, vp) => (zoomedFrom.current = vp.zoom)}
        // On a phone, a pinch or wheel lets go of what the screen showed, taken at another zoom, and ends
        // kept to the bounds of the zoom before its last step, which reach further than its own: the view
        // glides back inside them. Pans and taps keep to them already; the camera's own moves are its.
        onMoveEnd={(e, vp) => {
          if (wide || !e || vp.zoom === zoomedFrom.current) return save(vp);
          const { width, height } = store.getState();
          const to = clamp(vp, width, height, room(width, height, vp.zoom));
          setHeld(null);
          save(to);
          if (Math.abs(to.x - vp.x) + Math.abs(to.y - vp.y) > 0.5) void setViewport(to, { duration: 150, interpolate: "linear" });
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // No keys of React Flow's own: it listens on the whole window and calls preventDefault on Shift even in
        // the chat beside it, which an IME needs (#290). Its zoom key stays: Cmd + wheel zooms a wide screen on a Mac.
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        deleteKeyCode={null}
        panActivationKeyCode={null}
        zoomOnDoubleClick={false}
        panOnScroll={wide}
        translateExtent={[
          [x, y],
          [x + ew, y + eh],
        ]}
        minZoom={min}
        maxZoom={1.5}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        {...pointers}
      >
        {v.points.length > 0 && (
          <ViewportPortal>
            {/* Starts filled, ends rings, as the lines; over the boxes (stories 370, 372). While editing,
                blue: the selected line's larger, the ends its end can go to glowing (stories 377, 378). */}
            <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" style={{ zIndex: 1000 }}>
              {/* The line being drawn: to the pointer, thin; to where it goes, blue and dashed (story 381). */}
              {path && <path data-preview={drag!.over ?? ""} d={path} fill="none" stroke="var(--running)" strokeWidth={drag!.over ? 2.5 : 1.5} strokeDasharray={drag!.over ? "5 4" : undefined} strokeLinecap="round" opacity={drag!.over ? 1 : 0.6} />}
              {v.points.map((p) => {
                const k = `${p.end ? "e" : "s"}:${p.of}`;
                const lines = p.lines.some((l) => litEdges.has(l));
                const [glow, big] = [!!edit?.lit?.glow.has(k), !!edit?.lit?.big.has(k)];
                const on = !lit || lines || glow || big;
                const conflict = !p.end && !!edit?.stale.has(p.of);
                const color = conflict ? "var(--draft-conflict)" : edit ? "var(--running)" : lit && on ? "var(--foreground)" : "var(--bind)";
                const r = glow || big ? (p.end ? 7 : 6) : p.end ? 5 : 4.5;
                // What a line drawn would go to here.
                const hover = !!drag?.over && k === (drag.end ? "s:" : "e:") + drag.over;
                // The end or start in hand, where it leaves.
                const left = (edit?.s.held ? p.end : !!edit?.s.start && !p.end) && lines && !glow;
                return (
                  <g key={k} data-dot={k} opacity={left ? 0.35 : on ? 1 : 0.15} className="transition-opacity duration-200">
                    {(glow || (big && !edit?.s.held)) && <circle cx={p.x} cy={p.y} r={hover ? 18 : 15} fill="var(--running)" opacity={hover ? 0.3 : 0.14} />}
                    <circle cx={p.x} cy={p.y} r={r} fill={p.end ? (glow ? "color-mix(in srgb, var(--running) 22%, var(--card))" : "var(--card)") : color} stroke={p.end ? color : "none"} strokeWidth={glow || big ? 2.6 : 2} />
                  </g>
                );
              })}
            </svg>
            {/* A change in conflict says so at its start, not by its colour alone (story 315). */}
            {edit &&
              v.points
                .filter((p) => !p.end && edit.stale.has(p.of))
                .map((p) => (
                  <TriangleAlert key={p.of} role="img" aria-label="冲突" className="pointer-events-none absolute size-3.5 text-(--draft-conflict)" style={{ left: p.x + 3, top: p.y - 17, zIndex: 1001 }} />
                ))}
          </ViewportPortal>
        )}
      </ReactFlow>
    </Lit.Provider>
  );
}

// ---- the details: a bottom sheet on a phone, a card at the right on a wide screen ----

/** A row of the details; with onClick, it takes you somewhere. */
function Row({ lead, title, right, onClick, className }: { lead?: ReactNode; title: ReactNode; right?: ReactNode; onClick?: () => void; className?: string }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={cn("flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border bg-background px-2.5 py-1.5 text-left", onClick && "hover:bg-muted/60 active:bg-muted", className)}>
      {lead}
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {right}
      {onClick && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
    </Tag>
  );
}
const SlotRow = ({ slot, label = slot.ref, go }: { slot: Slot; label?: string; go?: (f: Focus) => void }) => (
  <Row
    lead={slot.agent && <AgentLogo agent={slot.agent} className="text-sm" />}
    title={label}
    right={
      <span className="text-xs">
        <SlotMark slot={slot} />
      </span>
    }
    onClick={go && (() => go({ kind: "slot", id: slot.id }))}
    className={cn(!go && "border-foreground/30 bg-muted font-medium")}
  />
);
/** A chat window: its face, its name and, outside its Bot's details, its Bot by platform and name;
 *  right: what else to say, such as where it goes. In its Bot's details, beside it, how it writes tool lines. */
const ChatRow = ({ chat, bot, named = true, right, go }: { chat: Chat; bot: Bot; named?: boolean; right?: ReactNode; go?: () => void }) => (
  <div className="flex min-w-0 items-center">
    <Row
      lead={<Face url={chat.avatar} kind={chat.kind} size={32} ring="ring-background" />}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <ChatName chat={chat} />
          {chat.main && <MainStar label="主窗口" />}
          {named && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Mark p={bot.platform} size={14} />
              <span className="truncate">{bot.name}</span>
            </span>
          )}
        </span>
      }
      right={right}
      onClick={go}
    />
    {!named && <Verbose chat={chat} />}
  </div>
);

/** A switch's look while off: grey, and a faint ground under the mouse anywhere on its 44px tap (#404). */
const OFF = "text-muted-foreground group-enabled:group-hover:bg-foreground/5 group-enabled:group-hover:text-foreground";

/** The chat's tool lines in full or short, switched here as /rh_verbose there, which hears nothing of it (story 319). */
function Verbose({ chat }: { chat: Chat }) {
  const [busy, run] = useAct();
  return (
    <button aria-label="详细工具行" aria-pressed={chat.verbose} disabled={busy} onClick={() => void run({ kind: "verbose", chat: chat.id, on: !chat.verbose })} className="group focus-child -mr-1.5 grid size-11 shrink-0 place-items-center">
      <span className={cn("grid size-8 place-items-center rounded-lg transition-colors", chat.verbose ? "bg-secondary text-foreground" : OFF)}>{busy ? <Spin /> : <Wrench className="size-4" />}</span>
    </button>
  );
}
/** Where a chat window goes: the slot's agent logo and name, as the canvas draws a slot. */
const Target = ({ slot }: { slot?: Slot }) =>
  slot && (
    <span className="inline-flex max-w-[45%] min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {slot.agent && <AgentLogo agent={slot.agent} />}
      <span className="truncate">{slot.name}</span>
    </span>
  );
const List = ({ children }: { children: ReactNode }) => <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-1.5 first:mt-1">{children}</div>;

/** ws: a workspace's name, whose details make a slot in it (story 320); open: the slot 打开槽位 opens, a
 *  slot's or a line's; x: what ✕ at its end does, while editing. */
type Sheet = { lead?: ReactNode; title: ReactNode; sub?: ReactNode; body: ReactNode; slot?: Slot; ws?: string; open?: string; x?: { label: string; run: () => void } };

/** The details of the focus. Chat windows list in the canvas's order (v), each with where it goes. */
function details(g: Graph, v: View, focus: NonNullable<Focus>, go: (f: Focus) => void, onPreview: (slot: string | null) => void, timeline: Episode[]): Sheet {
  const slotById = new Map(g.slots.map((s) => [s.id, s]));
  const botById = new Map(g.bots.map((b) => [b.id, b]));
  const y = (c: Chat) => v.rects.get(c.id)?.y ?? 0;
  const bindOf = (chat: string) => g.bindings.find((b) => b.chat === chat);
  const slotOf = (chat: string) => slotById.get(bindOf(chat)?.slot ?? "");
  const toSlot = (chat: string) => {
    const s = bindOf(chat)?.slot;
    return s ? () => go({ kind: "slot", id: s }) : undefined;
  };

  // A line: from its start to its slot, which 打开槽位 opens.
  if (focus.kind === "line") {
    const s = reachOf(g, focus.id)!;
    return { title: <LineName g={g} of={focus.id} size={28} name={s.ref} />, open: s.id, body: false };
  }
  if (focus.kind === "bot") {
    const b = botById.get(focus.id)!;
    const chats = g.chats.filter((c) => c.bot === b.id).sort((p, q) => y(p) - y(q));
    const conn = connText(b.conn);
    return {
      lead: <BotFace bot={b} size={36} />,
      title: (
        <span className="flex items-center gap-1.5">
          {b.name}
          {b.main && <MainStar label="主 Bot" />}
        </span>
      ),
      sub: conn && <span className={b.conn === "faulted" ? "text-destructive" : "text-needs"}>{conn}</span>,
      body: chats.length > 0 && (
        <List>
          {chats.map((c) => (
            <ChatRow key={c.id} chat={c} bot={b} named={false} go={toSlot(c.id)} right={<Target slot={slotOf(c.id)} />} />
          ))}
        </List>
      ),
    };
  }
  if (focus.kind === "ws") {
    const w = g.workspaces.find((w) => w.id === focus.id)!;
    const chats = g.chats.filter((c) => slotOf(c.id)?.workspace === w.id).sort((p, q) => y(p) - y(q));
    return {
      lead: <Folder className="size-5 shrink-0 text-muted-foreground" />,
      title: w.name,
      ws: w.name,
      body: chats.length > 0 && (
        <List>
          {chats.map((c) => (
            <ChatRow key={c.id} chat={c} bot={botById.get(c.bot)!} go={toSlot(c.id)} right={<Target slot={slotOf(c.id)} />} />
          ))}
        </List>
      ),
    };
  }
  // A slot: the chats bound to it, its contact chat marked (listed even when not bound to it); where it
  // sits in its spawn tree; its timeline.
  const slot = slotById.get(focus.id)!;
  const ids = g.bindings.filter((b) => b.slot === slot.id).map((b) => b.chat);
  if (slot.contact && !ids.includes(slot.contact)) ids.push(slot.contact);
  const chats = ids.flatMap((id) => g.chats.filter((c) => c.id === id)).sort((a, b) => +(a.kind === "group") - +(b.kind === "group"));
  const parent = slotById.get(slot.parent ?? "");
  const children = g.slots.filter((c) => c.parent === slot.id);
  const label = (s: Slot) => (s.workspace === slot.workspace ? s.name : s.ref);
  return {
    lead: slot.agent && <AgentLogo agent={slot.agent} className="text-xl" />,
    // Too long for a line, it breaks after the workspace.
    title: (
      <>
        {slot.ref.slice(0, -slot.name.length)}
        <wbr />
        {slot.name}
      </>
    ),
    sub: (
      <span className="flex min-w-0 items-center gap-2">
        <SlotMark slot={slot} full />
        {slot.lifetime === "oneoff" && <span className="shrink-0 rounded bg-secondary px-1 text-[11px] leading-4 text-secondary-foreground">一次性</span>}
      </span>
    ),
    slot,
    open: slot.id,
    body: (chats.length > 0 || parent || children.length > 0 || timeline.length > 0) && (
      <>
        {chats.length > 0 && (
          <List>
            {chats.map((c) => (
              <ChatRow key={c.id} chat={c} bot={botById.get(c.bot)!} right={c.id === slot.contact && <Send role="img" aria-label="联系窗口" className="size-4 shrink-0 text-running" />} />
            ))}
          </List>
        )}
        {(parent || children.length > 0) && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-1.5">
            {parent && <SlotRow slot={parent} label={label(parent)} go={go} />}
            <div className={cn(parent && "tick ml-4")}>
              <SlotRow slot={slot} label={slot.name} />
            </div>
            {children.map((c, i) => (
              <div key={c.id} className={cn("tick", parent ? "ml-8" : "ml-4", i < children.length - 1 && "more")}>
                <SlotRow slot={c} label={label(c)} go={go} />
              </div>
            ))}
          </div>
        )}
        <Timeline key={slot.id} slot={slot.id} list={timeline} turn={inTurn(slot)} onPreview={onPreview} />
      </>
    ),
  };
}

/** While editing, what is selected (spec web-write "拓扑图上的改绑定"): a line, its start's face, an
 *  arrow, its end; its end in hand, an empty box for it; its start in hand, an empty box to swap it with,
 *  before the line; an end tapped, the starts of the lines into it,
 *  each selecting its own. A Bot's end is its face, the default it now has after it, light. */
function editSheet(g: Graph, s: Edit, set: (s: Edit) => void): Sheet {
  const face = (of: string, size = 28) => {
    const b = g.bots.find((b) => b.id === of);
    const c = g.chats.find((c) => c.id === of);
    return b ? <BotFace bot={b} size={size} /> : c && <Face url={c.avatar} kind={c.kind} size={size} />;
  };
  const name = (of: string) => g.bots.find((b) => b.id === of)?.name ?? g.chats.find((c) => c.id === of)?.name ?? "匿名用户";
  const end = (id: string | null) => {
    const b = g.bots.find((b) => b.id === id);
    if (b) return [<BotFace key="f" bot={b} size={24} />, <Target key="t" slot={g.slots.find((s) => s.id === b.target)} />];
    const slot = g.slots.find((s) => s.id === id);
    return slot && [slot.agent && <AgentLogo key="a" agent={slot.agent} className="text-xl" />, <span key="n" className="min-w-0 truncate">{slot.name}</span>];
  };
  const arrow = <ArrowRight className="size-4 shrink-0 text-muted-foreground" />;
  const row = (...parts: ReactNode[]) => <span className="flex min-w-0 items-center gap-1.5">{parts}</span>;
  const hole = <span key="hole" className="h-7 w-14 shrink-0 rounded-md border-2 border-dashed border-running/60" />;
  // An end held to draw from: a start to come.
  if (s.back) return { title: row(hole, arrow, end(s.at)), body: false, x: { label: "放下", run: () => set(NONE) } };
  if (s.sel && s.held) return { title: row(face(s.sel), arrow, hole), body: false, x: { label: "放下", run: () => set({ ...s, held: false }) } };
  if (s.sel && s.start) return { title: row(hole, <ArrowRightLeft key="swap" className="size-4 shrink-0 text-muted-foreground" />, face(s.sel), arrow, end(endOf(g, s.sel))), body: false, x: { label: "放下", run: () => set({ ...s, start: false }) } };
  if (s.sel) return { title: row(face(s.sel), arrow, end(endOf(g, s.sel))), body: false, x: { label: "取消", run: () => set(NONE) } };
  const starts = into(g, s.at!).map((of) => (
    <button key={of} aria-label={name(of)} onClick={() => set({ sel: of, held: false, at: null })} className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-foreground/5 active:bg-muted">
      {face(of)}
    </button>
  ));
  return { title: row(<span key="s" className="flex min-w-0 overflow-x-auto">{starts}</span>, arrow, end(s.at)), body: false, x: { label: "取消", run: () => set(NONE) } };
}

/** The slot a dialog asks about: whether to take its terminal back, or to switch it there. */
type Asking = { slot: string; back: boolean };

/** What can be done to a slot (story 271), as its chat has it: stop its turn, stop its process, switch
 *  it to the terminal or take it back, archive it or bring it back. A button that opens them, or with
 *  close, them where at says, as a right click opens them. ask: asks whether to take the slot's
 *  terminal back, or to switch it there (story 476), in a dialog that outlives the menu. */
function SlotMenu({ s, at, close, ask, className }: { s: Slot; at?: { x: number; y: number } | null; close?: () => void; ask: (a: Asking) => void; className?: string }) {
  const [busy, run] = useAct();
  const go = (a: Parameters<typeof run>[0]) => () => void run(a);
  const turn = inTurn(s);
  const runs = s.mode === "headless" && s.phase !== "off" && s.phase !== "crashed";
  const terminal: Choice[] =
    s.mode === "tui"
      ? [{ icon: SquareTerminal, label: "收回终端", run: () => ask({ slot: s.id, back: true }) }]
      : s.archived
        ? []
        : [{ icon: SquareTerminal, label: "切到终端", run: () => ask({ slot: s.id, back: false }) }];
  const choices: Choice[] = [
    ...(turn ? [{ icon: Square, label: "停下这一回合", run: go({ kind: "common", slot: s.id, name: "stop" }) }] : []),
    ...(runs ? [{ icon: Power, label: "停掉进程", run: go({ kind: "rh", argv: ["stop", s.id] }) }] : []),
    ...terminal,
    ...(s.archived
      ? [{ icon: ArchiveRestore, label: "恢复", run: go({ kind: "rh", argv: ["unarchive", s.id] }) }]
      : s.mode === "headless"
        ? [{ icon: Archive, label: "归档", run: go({ kind: "rh", argv: ["archive", s.id] }) }]
        : []),
  ];
  return close ? (
    <MenuAt at={at ?? null} close={close} choices={choices} />
  ) : (
    <Pick label="操作" choices={choices} disabled={busy} className={cn("size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted", className)}>
      <Ellipsis className="size-5" />
    </Pick>
  );
}

/** Before anything is picked: what needs you or runs, counted with the dots a workspace has on the canvas. */
function summary(g: Graph, go: (f: Focus) => void): Sheet {
  const live = g.slots.filter((s) => !s.archived);
  const busy = live.some((l) => status(l) !== "idle");
  const group = (s: Status, label: string) => {
    const slots = live.filter((l) => status(l) === s);
    return (
      slots.length > 0 && (
        <section className="mt-3 first:mt-1">
          <h3 className={cn("mb-1.5 flex items-center gap-1.5 text-xs font-medium", TEXT[s])}>
            <span className={cn("size-2 rounded-full", BG[s])} />
            {label}
          </h3>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            {slots.map((l) => (
              <SlotRow key={l.id} slot={l} go={go} />
            ))}
          </div>
        </section>
      )
    );
  };
  return {
    lead: <House className="size-5 shrink-0 text-muted-foreground" />,
    title: "总览",
    sub: busy && (
      <span className="flex items-center gap-2">
        <Counts slots={live} />
      </span>
    ),
    body: busy && (
      <>
        {group("needs", "需要你")}
        {group("running", "运行中")}
      </>
    ),
  };
}

/** The phone's sheet's height on this device: null, its row alone. */
const SHEET_KEY = "topology-sheet";
function useSheet() {
  const [height, setHeight] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(SHEET_KEY)) || null;
    } catch {
      return null;
    }
  });
  const set = (h: number | null) => {
    setHeight(h);
    try {
      localStorage.setItem(SHEET_KEY, String(h ?? 0));
    } catch {}
  };
  return [height, set] as const;
}

/** Every workspace unfolded, on this device (story 374). */
const UNFOLD_KEY = "topology-unfold";
function useUnfold() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(UNFOLD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (on: boolean) => {
    setOn(on);
    try {
      if (on) localStorage.setItem(UNFOLD_KEY, "1");
      else localStorage.removeItem(UNFOLD_KEY);
    } catch {}
  };
  return [on, set] as const;
}

/** The view under the board's header. onPreview: the slot whose current conversation a preview shows,
 *  for the page's event stream to follow; null once none does. */
export function TopologyPage({ live, onPreview }: { live: boolean | null; onPreview: (slot: string | null) => void }) {
  const { data: g } = useQuery({ queryKey: ["topology"], queryFn: () => json<TopologyData>("api/topology") });
  return (
    <div className="relative flex h-dvh flex-col pt-[env(safe-area-inset-top)]">
      <div className="shrink-0 border-b px-4">
        <BoardHeader live={live} />
      </div>
      {g && (
        <ReactFlowProvider>
          <Topology g={g} onPreview={onPreview} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function Topology({ g, onPreview }: { g: Graph; onPreview: (slot: string | null) => void }) {
  const [location, setLocation] = useLocation();
  const route = readRoute(location);
  // Not a step, nor kept on the device: kept with the step in history, as the view is drawn anew when
  // a chat opens beside it or you come back from one.
  const [archived, setShown] = useState<boolean>(() => !!history.state?.archived);
  const setArchived = (on: boolean) => (history.replaceState({ ...history.state, archived: on }, ""), setShown(on));
  const [unfold, setUnfold] = useUnfold();
  // A wide screen has the details as a card beside the graph; a medium one, a phone's sheet.
  const wide = useMedia(WIDE);
  const focus = known(g, route.focus);
  const sel = !!focus && route.sel;

  // Editing the bindings (spec web-write "拓扑图上的改绑定"): not kept, so the view opens not editing.
  // The draft is drawn over the topology; the columns stay ordered by the bindings they were laid out
  // by, till a batch made or undone lays them out anew (story 317).
  const [editing, setEditing] = useState(false);
  /** The draft after each step, the last the draft now (story 385). */
  const [steps, setSteps] = useState<Change[][]>([]);
  const draft = steps.at(-1) ?? NO_DRAFT;
  const [pick, setPick] = useState<Edit>(NONE);
  /** The workspace open while editing, which sets no focus. */
  const [opened, setOpened] = useState<string | null>(null);
  const [laid, setLaid] = useState(() => g.bindings);
  const [relaid, setRelaid] = useState(0);
  const [sliding, setSliding] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A batch made, for 8 s: what was said, and what undoes it if anything can. */
  const [done, setDone] = useState<{ text: string; undo: BoardAct | null; at: number } | null>(null);
  const shown = useMemo(() => (editing ? drafted(g, draft) : g), [g, draft, editing]);
  const v = useMemo(() => view(shown, editing ? null : focus, archived, wide, { laid, base: editing ? g : undefined, unfold, open: editing ? opened : null }), [shown, key(focus), archived, unfold, wide, laid, editing, opened]);
  const conflicts = useMemo(() => (busy ? new Set<string>() : stale(g, draft)), [g, draft, busy]);
  const lit = useMemo(() => (editing ? editLit(shown, v, pick) : null), [editing, shown, v, pick]);
  /** A tap while editing: what it selects, the change it makes, the workspace it opens or closes. */
  const apply = (r: Step) => {
    if (r.put) setSteps((h) => addStep(h, (d) => put(g, d, r.put!.of, r.put!.to)));
    if (r.swap) setSteps((h) => addStep(h, (d) => swap(g, d, r.swap!.of, r.swap!.with)));
    if (r.open) setOpened((o) => (o === r.open ? null : r.open!));
    setPick(r.edit);
  };
  const editTapped = (x: number, y: number, k: number, node: { kind: Data["kind"]; id: string } | null) => apply(editTap(shown, v, pick, x, y, k, node));
  /** The line being drawn (stories 381, 382); let go, what it goes to is as tapped. */
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const drawing = {
    drag: drawn,
    grab: (x: number, y: number, k: number) => (busy ? null : grab(shown, v, x, y, k)),
    begin: (d: Grab, x: number, y: number) => (setPick(grabbed(d)), setDrawn({ ...d, x, y, over: null })),
    move: (x: number, y: number, k: number) => setDrawn((d) => d && { ...d, x, y, over: dropAt(shown, v, d, x, y, k) }),
    // Let go of by Esc already, it does nothing.
    release: (d: Grab, x: number, y: number, k: number, cancel: boolean) => drawn && (apply(drop(shown, d, cancel ? null : dropAt(shown, v, d, x, y, k))), setDrawn(null)),
  };
  /** Once the topology has what a batch made or undid (was being the one before, null once refetched), it is laid out by it. */
  const [settle, setSettle] = useState<{ was: Graph | null; then: () => void } | null>(null);
  useEffect(() => {
    if (!settle || g === settle.was) return;
    setSettle(null);
    setLaid(g.bindings);
    setRelaid((n) => n + 1);
    setSliding(true);
    setTimeout(() => setSliding(false), 400);
    settle.then();
  }, [g, settle]);
  /** Sends a batch, or its undo; done, the topology is laid out by it once it shows it. */
  const send = async (a: BoardAct, then: (text: string) => void) => {
    const was = g;
    setBusy(true);
    const r = await act(a);
    if (!r.ok) return (setBusy(false), toast(r.error, true));
    setSettle({ was, then: () => (setBusy(false), then(r.text)) });
    // Refetched with nothing new, it settles all the same.
    void refresh().then(() => setSettle((s) => s && { ...s, was: null }));
  };
  const confirm = () => {
    setPick(NONE);
    // Worked out now: a stranger's chat put back on its Bot's end leaves the graph once made (story 386).
    const undo = undoOf(g, draft);
    void send({ kind: "bind", changes: draft }, (text) => (setSteps([]), setPick(NONE), setDone({ text, undo: undo.length ? { kind: "bind", changes: undo } : null, at: Date.now() })));
  };
  const undoDone = () => {
    const u = done!.undo!;
    setDone(null);
    void send(u, (text) => toast(text));
  };
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), done.at + 8000 - Date.now());
    return () => clearTimeout(t);
  }, [done]);
  const doneDelay = useMemo(() => done && done.at - Date.now(), [done]);
  // Esc puts down the end or start in hand, else lets go of what is selected.
  useEffect(() => {
    if (!pick.sel && !pick.at) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (setDrawn(null), setPick(pick.held || pick.start ? { sel: pick.sel, held: false, at: null } : NONE));
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [pick]);

  // Each step writes the address, as an entry of its own or in place of the current one, which keeps
  // what history has of it. A chat opening or closing beside the graph draws the view anew in its new
  // width: the camera fits it afresh. up: what the step goes back to.
  const step = (r: Route, replace: boolean, up?: string) => {
    const { vp, ...kept } = (replace && history.state) || {};
    // A chat opened beside the graph goes back to it; once it follows another slot, it closes in place.
    if (kept.up === "topology" && key(r.focus) !== key(route.focus)) delete kept.up;
    const state = { ...kept, archived, ...(r.chat === route.chat && vp && { vp }), ...(up && { up }) };
    history[replace ? "replaceState" : "pushState"](state, "", routeHash(r));
    dispatchEvent(new HashChangeEvent("hashchange"));
  };
  /** Go to f. A move within one level takes the place of the step before. A slot's chat open beside
   *  the graph goes on to the slot tapped, and closes for anything else. */
  const to = (f: Focus) => {
    if (key(f) === key(focus) && (route.sel || !f)) return;
    step({ ...route, focus: f, sel: true, chat: route.chat && wide && f?.kind === "slot" }, replaces(g, focus, f));
  };
  /** 打开槽位: back, to the chat the view was opened from on this slot; on a wide screen the chat beside
   *  the graph, on a medium one in maximize mode; on a phone the chat, back from which is the view as it was. */
  const openSlot = (id: string) => {
    if (history.state?.up === `chat:${id}`) return history.back();
    if (matchMedia(ROOM).matches) return step({ focus: { kind: "slot", id }, sel: true, chat: true }, false, "topology");
    setLocation(`/slot/${encodeURIComponent(id)}`, { state: { up: "topology" } });
  };
  const onTap = (n: Node<Data>) => {
    const d = n.data;
    if (d.kind === "chat") {
      // A chat window stands for the slot it is bound to, and does nothing when that is the focus already.
      const s = g.bindings.find((b) => b.chat === d.chat.id)?.slot;
      return void (s && !(sel && s === focus?.id) && to({ kind: "slot", id: s }));
    }
    tap({ kind: d.kind, id: n.id });
  };
  /** Tapping the focus again lets go of it: nothing is lit, and what it opened stays. */
  const tap = (f: Focus) => (sel && key(f) === key(focus) ? step({ ...route, sel: false, chat: false }, true) : to(f));

  // The phone's sheet: its height, a tap on its bar opening or folding it, a drag on its bar resizing it.
  // It is never taller than what it holds, and with nothing to hold it is its bar alone.
  const [sheetH, setSheetH] = useSheet();
  const aside = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number; to: number; moved: boolean } | null>(null);
  const moved = useRef(false); // the last press on the bar was a drag: its click is not a tap
  const [dragging, setDragging] = useState(false); // the body shows while the bar is dragged
  const toggle = () => setSheetH(sheetH ? null : SHEET.open(innerHeight));
  // A focused slot's timeline, from its details.
  const slotId = sel && focus?.kind === "slot" ? focus.id : "";
  const { data: detail } = useQuery({ queryKey: ["topology-slot", slotId], queryFn: () => json<SlotData>(`api/slot?id=${encodeURIComponent(slotId)}`), enabled: !!slotId });
  const sheet = editing && (pick.sel || pick.at) ? editSheet(shown, pick, setPick) : sel ? details(g, v, focus!, to, onPreview, (detail?.id === slotId && detail.timeline) || []) : summary(g, to);
  const body = !!sheet.body;
  const lift = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    setDragging(false);
    const h = SHEET.settle(d.to, innerHeight);
    setSheetH(h);
    aside.current!.style.maxHeight = h ? `${h}px` : ""; // as React will write it, in case it doesn't
  };
  // The tap opens or folds it on click, not on the finger's lift: the click then lands on the bar, not
  // on what slides under the finger as the sheet moves. What a menu opened from it does is the menu's:
  // its popup, though not in the bar, is in it for React's events.
  const bar =
    wide || !body
      ? {}
      : {
          onPointerDown: (e: PointerEvent) => {
            if (!e.currentTarget.contains(e.target as Element)) return;
            moved.current = false;
            if ((e.target as HTMLElement).closest("button")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const h = aside.current!.getBoundingClientRect().height;
            drag.current = { y: e.clientY, h, to: h, moved: false };
          },
          onPointerMove: (e: PointerEvent) => {
            const d = drag.current;
            if (!d) return;
            if (!d.moved && Math.abs(e.clientY - d.y) > 6) {
              d.moved = moved.current = true;
              setDragging(true);
            }
            if (!d.moved) return;
            d.to = Math.max(SHEET.bar, Math.min(SHEET.max(innerHeight), d.h + d.y - e.clientY));
            aside.current!.style.maxHeight = `${d.to}px`;
          },
          onPointerUp: lift,
          onPointerCancel: lift,
          onClick: (e: MouseEvent) => {
            if (!e.currentTarget.contains(e.target as Element)) return;
            if (!moved.current && !(e.target as HTMLElement).closest("button")) toggle();
          },
        };

  // The slot right-clicked, and where; the slot a dialog asks about.
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const menuSlot = menu && g.slots.find((s) => s.id === menu.id);
  const [asking, setAsking] = useState<Asking | null>(null);
  const asked = asking && g.slots.find((s) => s.id === asking.slot);
  const shut = (open: boolean) => open || setAsking(null);
  // The workspace whose 新槽位 sheet is open.
  const [making, setMaking] = useState<string | null>(null);

  // 总览 glides back to the whole, even when it is already the overview.
  const [refit, setRefit] = useState(0);
  const crumb = (f: Focus) => {
    to(f);
    if (!f) setRefit((n) => n + 1);
  };
  const crumbs = trail(g, sel ? focus : null);
  const nav = useRef<HTMLElement>(null);
  /** The path's start fades out when it is scrolled, so no sliver of a crumb hangs after 总览. */
  const fade = (n: HTMLElement) => (n.style.maskImage = n.scrollLeft > 0 ? "linear-gradient(to right, transparent, #000 2.5rem)" : "");
  useLayoutEffect(() => {
    const n = nav.current;
    if (!n) return;
    n.scrollTo({ left: n.scrollWidth });
    fade(n);
  }, [crumbs.map((c) => c.label).join(">")]);
  useLayoutEffect(() => {
    aside.current?.querySelector("[data-body]")?.scrollTo({ top: 0 });
  }, [sel && key(focus)]);

  return (
    <>
      <div className="flex h-11 shrink-0 items-center border-b pl-2">
        {/* 总览 stays put; the rest of the path scrolls beside it. Each as tall as the row, its focus
            rings 2px inside it, clear of the row's borders (#503). */}
        <button onClick={() => crumb(null)} className={cn("inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors hover:bg-foreground/5 active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring", crumbs.length === 1 ? "font-semibold" : "text-muted-foreground hover:text-foreground")}>
          <House className="size-4 shrink-0" />
          总览
        </button>
        <nav ref={nav} aria-label="路径" onScroll={(e) => fade(e.currentTarget)} className="flex h-full min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
          {crumbs.slice(1).map((c, i) => (
            <Fragment key={i}>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <button onClick={() => crumb(c.focus)} className={cn("inline-flex h-11 max-w-[11rem] shrink-0 items-center truncate rounded-lg px-2 text-sm transition-colors hover:bg-foreground/5 active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring", i === crumbs.length - 2 ? "font-semibold" : "text-muted-foreground hover:text-foreground")}>
                {c.focus?.kind === "line" ? <LineName g={g} of={c.focus.id} size={18} name={c.label} ring="ring-background" /> : c.label}
              </button>
            </Fragment>
          ))}
        </nav>
        {/* 44px targets, their pressed look inset from the row's edges; what they do shows under a mouse. */}
        <button title="展开全部工作区" aria-pressed={unfold} onClick={() => setUnfold(!unfold)} className="group focus-child grid size-11 shrink-0 place-items-center">
          <span className={cn("grid size-8 place-items-center rounded-lg transition-colors", unfold ? "bg-secondary text-foreground" : OFF)}>
            <UnfoldVertical className="size-4" />
          </span>
        </button>
        <button title="显示已归档" aria-pressed={archived} onClick={() => setArchived(!archived)} className="group focus-child grid size-11 shrink-0 place-items-center">
          <span className={cn("grid size-8 place-items-center rounded-lg transition-colors", archived ? "bg-secondary text-foreground" : OFF)}>
            <Archive className="size-4" />
          </span>
        </button>
        {/* Editing the bindings: left only once the draft is made or let go of (story 307). The workspace
            open stays open. */}
        <button
          aria-label="改绑定"
          aria-pressed={editing}
          disabled={draft.length > 0}
          onClick={() => {
            setEditing(!editing);
            setPick(NONE);
            setSteps([]);
            setOpened(sel && focus?.kind === "ws" ? focus.id : sel && focus?.kind === "slot" ? (g.slots.find((s) => s.id === focus.id)?.workspace ?? null) : null);
          }}
          className="group focus-child mr-0.5 grid size-11 shrink-0 place-items-center disabled:opacity-50">
          <span className={cn("grid size-8 place-items-center rounded-lg transition-colors", editing ? "bg-secondary text-foreground" : OFF)}>
            <Pencil className="size-4" />
          </span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Canvas
              v={v}
              refit={refit}
              relaid={relaid}
              sliding={sliding}
              focus={focus}
              sel={sel}
              archived={archived}
              unfold={unfold}
              wide={wide}
              // No tap while a batch is out: nothing put down then is lost once it is made.
              edit={editing ? { s: pick, lit, stale: conflicts, tap: busy ? () => {} : editTapped, ...drawing } : null}
              onTap={onTap}
              onLine={(id) => tap({ kind: "line", id })}
              onMenu={(s, at) => setMenu({ id: s.id, at })}
            />
            {menuSlot && <SlotMenu key={menuSlot.id} s={menuSlot} at={menu.at} close={() => setMenu(null)} ask={setAsking} />}
            <TakeBack slot={asking?.slot ?? ""} open={!!asking?.back} onOpenChange={shut} />
            <ToTerminal slot={asking?.slot ?? ""} turn={!!asked && inTurn(asked)} open={asking?.back === false} onOpenChange={shut} />
            <NewSlot open={making !== null} ws={making ?? undefined} close={() => setMaking(null)} done={openSlot} />
          </div>
          {/* Under the graph: the draft's bar (story 385), or a batch's undo for 8 s (story 316). What a write
              did shows over it; on a wide screen with a chat beside the graph, in the chat. */}
          <div className="relative shrink-0">
            {!(wide && route.chat) && <Toasts />}
            {/* With a slot's chat beside the graph, which has no card, what is selected while editing shows here. */}
            {wide && route.chat && sheet.x && (
              <div className="flex h-14 items-center gap-2.5 border-t bg-card pr-1 pl-4">
                <div className="min-w-0 flex-1">{sheet.title}</div>
                <button onClick={sheet.x.run} aria-label={sheet.x.label} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted">
                  <X className="size-5" />
                </button>
              </div>
            )}
            {draft.length > 0 ? (
              <div className="flex h-14 items-center border-t bg-card pr-1 pl-4">
                <span className="min-w-0 flex-1 truncate text-sm">改了 {draft.length} 处</span>
                <button aria-label="撤销一步" disabled={busy} onClick={() => (setSteps(undoStep), setPick(NONE))} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground enabled:hover:text-foreground disabled:opacity-50">
                  <Undo2 className="size-5" />
                </button>
                <button aria-label="全部撤销" disabled={busy} onClick={() => (setSteps([]), setPick(NONE))} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground enabled:hover:text-foreground disabled:opacity-50">
                  <X className="size-5" />
                </button>
                <button aria-label="确认" disabled={busy || conflicts.size > 0} onClick={confirm} className="group focus-child grid size-11 shrink-0 place-items-center">
                  <span className={cn("grid size-9 place-items-center rounded-full transition-colors", conflicts.size ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground group-enabled:group-hover:bg-primary/80")}>{busy ? <Spin /> : <Check className="size-4.5" />}</span>
                </button>
              </div>
            ) : (
              done && (
                <div className="relative flex h-14 items-center overflow-hidden border-t bg-card pr-1 pl-4">
                  <span className="min-w-0 flex-1 truncate text-sm">{done.text}</span>
                  {done.undo && (
                    <button disabled={busy} onClick={undoDone} className="h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-running transition-colors enabled:hover:bg-foreground/5">
                      撤销
                    </button>
                  )}
                  <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-undo bg-running/60" style={{ animationDelay: `${doneDelay}ms` }} />
                </div>
              )
            )}
          </div>
        </div>
        {/* A wide screen has the details as a card at the canvas's right, as tall as what it holds; with
            a slot's chat beside the graph, none. */}
        <aside
          hidden={wide && route.chat}
          ref={aside}
          aria-label="详情"
          style={wide || !sheetH || !body ? undefined : { maxHeight: Math.min(sheetH, SHEET.max(innerHeight)) }}
          className="flex shrink-0 flex-col overflow-hidden border-t bg-card pb-[env(safe-area-inset-bottom)] lg:m-3 lg:max-h-[calc(100%-1.5rem)] lg:w-80 lg:self-start lg:rounded-xl lg:border lg:pb-0 lg:shadow-sm xl:w-96"
        >
          <div {...bar} className={cn("relative flex min-h-[66px] shrink-0 items-center gap-2.5 pt-2.5 pr-1 pb-3 pl-4 select-none lg:min-h-0 lg:pt-3 lg:pr-4 lg:pb-3", body && "cursor-grab touch-none lg:cursor-auto lg:touch-auto")}>
            {body && <span aria-hidden className="absolute top-1 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-border lg:hidden" />}
            {sheet.lead}
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold lg:whitespace-normal lg:wrap-anywhere">{sheet.title}</h2>
              {/* A slot's 操作 at the end of this line: its title keeps the row's width. Its 44px reach
                  the row's bottom edge, which is why a phone's row is 66px (#503), and its focus rings
                  2px inside it, clear of that edge. */}
              {(sheet.sub || sheet.slot) && (
                <div className="flex items-center text-xs text-muted-foreground">
                  {sheet.sub}
                  {sheet.slot && <SlotMenu key={sheet.slot.id} s={sheet.slot} ask={setAsking} className="-my-3 ml-auto grid focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring" />}
                </div>
              )}
            </div>
            {sheet.open && (
              <button onClick={() => openSlot(sheet.open!)} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80">
                打开槽位
                <ChevronRight className="size-4" />
              </button>
            )}
            {sheet.ws && (
              <button onClick={() => setMaking(sheet.ws!)} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80">
                <Plus className="size-4" />
                新槽位
              </button>
            )}
            {sheet.x && (
              <button onClick={sheet.x.run} aria-label={sheet.x.label} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted">
                <X className="size-5" />
              </button>
            )}
            {body && (
              <button onClick={toggle} aria-label={sheetH ? "收起详情" : "展开详情"} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted lg:hidden">
                {sheetH ? <ChevronDown className="size-5" /> : <ChevronUp className="size-5" />}
              </button>
            )}
          </div>
          {body && (
            <div data-body className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4", !sheetH && !dragging && "hidden lg:block")}>
              {sheet.body}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
