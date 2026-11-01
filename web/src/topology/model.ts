// The topology view's layout (spec web-topology), as a pure function of the data, the focus, whether
// archived slots show, whether every workspace is unfolded and whether the screen is wide; and the rest of the view's logic that is not
// drawing: the path, the address, back, the camera and the sheet. The overview has each Bot with its
// chat windows on the left and the workspaces on the right. Focusing a slot or a workspace opens that
// workspace, its slots as a file tree: each child right under its parent, a little to the right. A
// child spawned from another workspace's slot stays in its own workspace.
import { graphlib, layout } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { BindChange } from "../../../src/contracts";
import type { TopologyData } from "../data";

export type Graph = TopologyData;
export type Bot = Graph["bots"][number];
export type Chat = Graph["chats"][number];
export type Workspace = Graph["workspaces"][number];
export type Slot = Graph["slots"][number];

/** What can be the focus. A chat window stands for the slot it is bound to, so it never is one; a line
 *  is its start's, a Bot's or a chat's (story 376). */
export type Kind = "bot" | "ws" | "slot" | "line";
export type Focus = { kind: Kind; id: string } | null;
export type Status = "needs" | "running" | "idle";
export type Rect = { x: number; y: number; w: number; h: number };

/** Widths and heights. A phone's columns are narrow so that the overview and an open workspace fit a
 *  Pixel 7's width (412px) at 0.85, its chats wide enough for the names; its chats and slots are tall
 *  enough to tap (44px) at 0.85. Its lanes take ten lines 4px apart.
 *  W: a chat; SW: a top-level slot, a workspace being as wide as one with a margin, open or closed,
 *  so opening one never widens the graph; GAPX: between the Bot and workspace columns, the lanes of
 *  the binding lines. */
const SIZE = {
  phone: { W: 160, SW: 184, GAPX: 66, chat: 52, slot: 52 },
  wide: { W: 184, SW: 240, GAPX: 140, chat: 40, slot: 40 },
};
const PAD = 8;
const GAP = 8;
export const INDENT = 18; // a child sits this far right of its parent, and ends where it ends
const TRUNK = 9; // the tree's line runs down this far right of the parent's left edge
const TICK = 15; // and enters the child this far down, above the end at the middle of its left
export const HEAD = 40; // a workspace's heading over the slots it shows
export const H = { botHead: 40, ws: 48 };
const GUT = 16; // a Bot's chats leave this much more room on their right, for the links into its end
export const MARGIN = 32; // how far past the content the view may go

/** The colour a slot's group gives it: what needs you amber, what runs blue, the rest grey. */
export const status = (s: Slot): Status => (s.group === "needsYou" ? "needs" : s.group === "running" ? "running" : "idle");

export type Data =
  | { kind: "bot"; bot: Bot }
  | { kind: "chat"; chat: Chat; bot: Bot }
  /** rows: the slots it shows, all when open, else those a line points at. */
  | { kind: "ws"; ws: Workspace; open: boolean; slots: Slot[]; rows: string[] }
  /** away: its parent or a child of it lives in another workspace. */
  | { kind: "slot"; slot: Slot; away: boolean };

/** A line, drawn from its own coordinates (absolute) rather than from handles. A binding line (stories
 *  370-372): bot, a Bot's from its start to its default; link, a chat's that follows the default, into
 *  its Bot's end; own, a chat's to the slot it picked. pts: its corners; reach: the slot it leads to;
 *  of: whose it is; lane: the x of its vertical run, ty its height there. While the bindings are edited
 *  (story 385): draft, a change not yet made; was, the line as it is, which the change removes. */
export type Line = {
  kind: "bot" | "link" | "own" | "spawn";
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  pts?: [number, number][];
  /** Where a tap picks it, if not along pts: a link only up to the chat above it. */
  hit?: [number, number][];
  reach?: string | null;
  lane?: number;
  of?: string;
  draft?: true;
  was?: true;
};
/** A start (a chat's or a Bot's) or an end (a Bot's, or a slot's a line points at; while the bindings
 *  are edited, every live slot's shown), and the lines at it. */
export type Point = { of: string; x: number; y: number; end: boolean; lines: string[] };

export interface View {
  nodes: Node<Data>[];
  edges: Edge<Line>[];
  /** Every node's box, absolute. */
  rects: Map<string, Rect>;
  /** The box to fit in view when the page opens on this focus: the focus and what is near it, else all. */
  box: Rect;
  /** A phone fits the width only, and puts this y at the top: the box's, or the focus's if the box is tall. */
  top: number;
  /** The content and a margin: the view never goes past it. */
  extent: Rect;
  /** What the focus is related to, lit while the rest fades; null for the overview. */
  lit: Set<string> | null;
  /** The lines lit with it. */
  litLines: Set<string> | null;
  /** The starts and ends. */
  points: Point[];
}

/** The slots a closed workspace does not show: what its counts count. */
export const hidden = (d: Extract<Data, { kind: "ws" }>) => d.slots.filter((s) => !d.rows.includes(s.id));
const RANK: Record<Status, number> = { needs: 0, running: 1, idle: 2 };

/** The view of g at focus. unfold: every workspace open, whatever the focus (story 374). laid: the bindings the columns are ordered by, as when last laid out, so
 *  that lines drawn elsewhere move no node (spec web-write "重排"). base: the bindings are being edited,
 *  g being base with the draft: the lines g has, a change a draft, the line it removes beside it; an end
 *  on every live slot shown. open: a workspace opened while editing, which sets no focus. */
export function view(g: Graph, focus: Focus, archived: boolean, wide: boolean, { laid = g.bindings, base, unfold = false, open }: { laid?: Graph["bindings"]; base?: Graph; unfold?: boolean; open?: string | null } = {}): View {
  const { W, SW, GAPX, chat: HC, slot: HS } = wide ? SIZE.wide : SIZE.phone;
  const WS = SW + 2 * PAD;
  const BOTW = W + 2 * PAD;
  const slotById = new Map(g.slots.map((s) => [s.id, s]));
  const parentOf = (s: Slot) => (s.parent ? slotById.get(s.parent) : undefined);
  const focused = focus?.kind === "slot" ? slotById.get(focus.id) : undefined;
  const keep = new Set<string>(); // the focused slot and its ancestors: shown even when archived
  for (let p = focused; p; p = parentOf(p)) keep.add(p.id);
  // The slots a line points at, shown even when closed or archived; while edited, as saved or drafted. The
  // columns are ordered with those saved: a draft pushes nodes down, never out of their order.
  const aimsOf = (x: Graph) => [...x.bots.flatMap((b) => (b.target ? [b.target] : [])), ...x.bindings.map((b) => b.slot)];
  const saved = new Set(aimsOf(base ?? g));
  const aimed = new Set([...saved, ...aimsOf(g)]);
  const shows = (s: Slot) => archived || !s.archived || keep.has(s.id) || aimed.has(s.id);
  const kids = (s: Slot) => g.slots.filter((c) => c.parent === s.id && c.workspace === s.workspace && shows(c));
  const binding = new Map(g.bindings.map((b) => [b.chat, b]));
  const laidBy = new Map(laid.map((b) => [b.chat, b]));
  const botOf = new Map(g.chats.map((c) => [c.id, c.bot]));
  const ws = focus?.kind === "ws" ? focus.id : focused?.workspace;
  const isOpen = (w: string) => unfold || w === ws || w === open;
  // A workspace with no live slot, nor one a line points at, shows only with the archived ones, or when it is open.
  const live = new Set(g.slots.filter((s) => !s.archived || aimed.has(s.id)).map((s) => s.workspace));
  const wss = g.workspaces.filter((w) => archived || w.id === ws || w.id === open || live.has(w.id));
  const isWs = new Set(wss.map((w) => w.id));

  // Each workspace's rows, a tree: each slot, then its children. The open one has its slots; a closed
  // one those a line points at, each level what needs you first, then what runs, as the list has them.
  const rowsOf = (w: string) => {
    const open = isOpen(w);
    const all = g.slots.filter((s) => s.workspace === w && (open ? shows(s) : aimed.has(s.id)));
    const ids = new Set(all.map((s) => s.id));
    const level = (ss: Slot[]) => (open ? ss : ss.toSorted((a, b) => RANK[status(a)] - RANK[status(b)]));
    const out: { s: Slot; depth: number }[] = [];
    const walk = (s: Slot, depth: number) => {
      out.push({ s, depth });
      for (const c of level(all.filter((c) => c.parent === s.id))) walk(c, depth + 1);
    };
    for (const s of level(all.filter((s) => !ids.has(s.parent ?? "")))) walk(s, 0);
    return out;
  };
  const rows = new Map(wss.map((w) => [w.id, rowsOf(w.id)]));
  /** A workspace's height: its heading alone, or a frame round its rows; an open one at least 80px. */
  const height = (w: string) => {
    const n = rows.get(w)!.length;
    const h = HEAD + n * (HS + GAP) - GAP + PAD;
    return isOpen(w) ? Math.max(h, HEAD + 40) : n ? h : H.ws;
  };
  // Closed, as dagre orders them: rows by what is aimed at as saved, not by the focus.
  const closedH = (w: string) => {
    const n = g.slots.filter((s) => s.workspace === w && saved.has(s.id)).length;
    return n ? HEAD + n * (HS + GAP) - GAP + PAD : H.ws;
  };
  const shown = new Set([...rows.values()].flatMap((r) => r.map((x) => x.s.id)));

  /** The node a line to slot id lands on: the slot, else its nearest shown ancestor in its workspace, else its workspace. */
  const lift = (id: string | null | undefined) => {
    const s = slotById.get(id ?? "");
    for (let p = s; p && p.workspace === s!.workspace; p = parentOf(p)) if (shown.has(p.id)) return p.id;
    return s && isWs.has(s.workspace) ? s.workspace : undefined;
  };

  // Top level: Bots and workspaces in two columns, ordered by dagre to cross the bindings least. Dagre
  // lays out the closed graph of the live workspaces only, so the order never changes: those with
  // archived slots only, shown with them or open, come after the rest; an open workspace pushes those
  // below it down.
  const chatsOf = (b: Bot) => g.chats.filter((c) => c.bot === b.id);
  const size = new Map<string, { width: number; height: number }>();
  for (const b of g.bots) size.set(b.id, { width: BOTW, height: H.botHead + chatsOf(b).length * (HC + GAP) + PAD - GAP });
  for (const w of wss) size.set(w.id, { width: WS, height: closedH(w.id) });
  const NODESEP = 16;
  const dg = new graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: NODESEP, ranksep: GAPX });
  dg.setDefaultEdgeLabel(() => ({}));
  const ranked = [...size.keys()].filter((id) => !isWs.has(id) || live.has(id));
  for (const id of ranked) dg.setNode(id, { ...size.get(id)! });
  for (const b of laid) {
    const v = botOf.get(b.chat);
    if (!v) continue;
    const w = slotById.get(b.slot)?.workspace;
    if (w && live.has(w)) dg.setEdge(v, w, { weight: (dg.edge(v, w)?.weight ?? 0) + 1 });
  }
  // A workspace no chat points at still belongs in the right column: tie it to the last Bot.
  const last = g.bots.at(-1);
  if (last) for (const w of wss) if (live.has(w.id) && !dg.inEdges(w.id)?.length) dg.setEdge(last.id, w.id, { weight: 1 });
  layout(dg);
  const ys = new Map(ranked.map((id) => [id, dg.node(id).y - dg.node(id).height / 2]));
  const top = ys.size ? Math.min(...ys.values()) : 0;
  let after = Math.max(top, ...wss.filter((w) => ys.has(w.id)).map((w) => ys.get(w.id)! + closedH(w.id) + NODESEP));
  for (const w of wss.filter((w) => !ys.has(w.id))) {
    ys.set(w.id, after);
    after += closedH(w.id) + NODESEP;
  }
  const closedY = (id: string) => ys.get(id)! - top;
  const X2 = (g.bots.length ? BOTW + GAPX : 0); // the workspace column
  for (const w of wss) size.set(w.id, { width: WS, height: height(w.id) });
  // Each open workspace, or one showing a slot a draft points at, pushes those below it down by what it grew.
  const grown = wss.map((w) => ({ y: closedY(w.id), by: height(w.id) - closedH(w.id) }));
  const at = (id: string) => {
    const y = closedY(id);
    return { x: isWs.has(id) ? X2 : 0, y: isWs.has(id) ? y + grown.reduce((d, o) => d + (o.y < y ? o.by : 0), 0) : y };
  };

  const nodes: Node<Data>[] = [];
  const rects = new Map<string, Rect>();
  const inner: Node<Data>[] = [];
  const spawns: [string, string][] = [];
  for (const w of wss) {
    const slots = g.slots.filter((s) => s.workspace === w.id);
    const rs = rows.get(w.id)!;
    const o = at(w.id);
    // A workspace showing slots is a frame: only its heading takes a tap, the rest is the empty canvas.
    nodes.push({ id: w.id, type: "ws", data: { kind: "ws", ws: w, open: isOpen(w.id), slots, rows: rs.map((r) => r.s.id) }, position: o, ...size.get(w.id)!, ...((isOpen(w.id) || rs.length > 0) && { style: { pointerEvents: "none" as const } }) });
    rects.set(w.id, { ...o, w: size.get(w.id)!.width, h: size.get(w.id)!.height });
    const ids = new Set(rs.map((r) => r.s.id));
    rs.forEach(({ s, depth }, i) => {
      const x = PAD + depth * INDENT;
      const y = HEAD + i * (HS + GAP);
      const away = (!!parentOf(s) && parentOf(s)!.workspace !== s.workspace) || g.slots.some((c) => c.parent === s.id && c.workspace !== s.workspace);
      inner.push({ id: s.id, type: "slot", data: { kind: "slot", slot: s, away }, parentId: w.id, position: { x, y }, width: SW - depth * INDENT, height: HS });
      rects.set(s.id, { x: o.x + x, y: o.y + y, w: SW - depth * INDENT, h: HS });
      if (s.parent && ids.has(s.parent)) spawns.push([s.parent, s.id]);
    });
  }
  nodes.push(...inner);

  // Each Bot's chats: those following its default first, then those with a slot of their own; in each
  // lot your private ones first; the latter then in the order of where they point, so their lines cross
  // the least. As saved: a draft moves no chat.
  const index = new Map(g.slots.map((s, i) => [s.id, i]));
  const order = (c: Chat) => {
    const b = laidBy.get(c.id);
    const s = b?.use ? slotById.get(b.slot) : undefined;
    return [+!!b?.use, +!c.yours, ...(s && isWs.has(s.workspace) ? [closedY(s.workspace), index.get(s.id)!] : [b?.use ? Infinity : 0, 0])];
  };
  const CW = W - GUT;
  const points: Point[] = [];
  const point = (of: string, x: number, y: number, end: boolean) => (points.push({ of, x, y, end, lines: [] }), points.at(-1)!);
  const binds: { id: string; source: string; target: string; l: Line }[] = [];
  const links: { id: string; source: string; target: string; l: Line }[] = [];
  // While edited, a change is a draft, and the line as saved, which it removes, is drawn too.
  const flag = (moved: boolean) => (moved ? { draft: true as const } : {});
  const savedBy = new Map((base ?? g).bindings.map((b) => [b.chat, b]));
  const own = (b?: Graph["bindings"][number]) => (b?.use ? b.slot : null);
  for (const b of g.bots) {
    const p = at(b.id);
    nodes.push({ id: b.id, type: "bot", data: { kind: "bot", bot: b }, position: p, ...size.get(b.id)! });
    rects.set(b.id, { ...p, w: size.get(b.id)!.width, h: size.get(b.id)!.height });
    // A Bot's start at its title's right; its end a little left of it, over the room the chats leave.
    const hy = p.y + H.botHead / 2;
    const end = point(b.id, p.x + BOTW - 12, hy, true);
    let above = hy; // the last follower's height: the run the links share is the lower chat's to a tap
    point(b.id, p.x + BOTW, hy, false);
    const then = base ? (base.bots.find((x) => x.id === b.id)?.target ?? null) : b.target;
    const bot = (id: string, to: string | null, more: Partial<Line>) => {
      const t = lift(to);
      if (t) binds.push({ id, source: b.id, target: t, l: { kind: "bot", sx: p.x + BOTW, sy: hy, tx: 0, ty: 0, of: b.id, reach: to, ...more } });
    };
    bot(`bot:${b.id}`, b.target, flag(then !== b.target));
    if (then !== b.target) bot(`was:bot:${b.id}`, then, { was: true });
    chatsOf(b)
      .sort((p, q) => {
        const a = order(p);
        const b = order(q);
        return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!;
      })
      .forEach((c, i) => {
        const cy = H.botHead + i * (HC + GAP);
        nodes.push({ id: c.id, type: "chat", data: { kind: "chat", chat: c, bot: b }, parentId: b.id, position: { x: PAD, y: cy }, width: CW, height: HC });
        const r = { x: p.x + PAD, y: p.y + cy, w: CW, h: HC };
        rects.set(c.id, r);
        const [sx, sy] = [r.x + r.w, r.y + r.h / 2];
        point(c.id, sx, sy, false);
        const [now, was] = [own(binding.get(c.id)), own(savedBy.get(c.id))];
        const line = (s: string | null, more: Partial<Line>, id = "") => {
          const t = s && lift(s);
          if (t) return void binds.push({ id: `${id}own:${c.id}`, source: c.id, target: t, l: { kind: "own", sx, sy, tx: 0, ty: 0, of: c.id, reach: s, ...more } });
          // Following: right into the room, then up into the Bot's end, where the links of its chats meet.
          if (s) return;
          links.push({ id: `${id}link:${c.id}`, source: c.id, target: b.id, l: { kind: "link", sx, sy, tx: end.x, ty: end.y, of: c.id, reach: b.target, pts: [[sx, sy], [end.x, sy], [end.x, end.y]], hit: [[sx, sy], [end.x, sy], [end.x, above]], ...more } });
          if (!more.was) above = sy;
        };
        line(now, flag(now !== was));
        if (now !== was) line(was, { was: true }, "was:");
      });
  }

  const edges: Edge<Line>[] = [];
  const line = (id: string, source: string, target: string, l: Line) => edges.push({ id, source, sourceHandle: "r", target, targetHandle: "l", type: "line", data: l });
  const spawned = new Set(spawns.map(([, c]) => c));
  const slotEnd = new Map<string, Point>();
  for (const target of new Set(binds.map((b) => b.target))) {
    const r = rects.get(target)!;
    const into = binds.filter((b) => b.target === target).sort((a, b) => a.l.sy - b.l.sy);
    if (slotById.has(target)) {
      // Each at its own height, the higher source higher (a child's in its lower half, under the
      // tree's tick), meeting at the one end at the middle of its left (story 372).
      const end = point(target, r.x, r.y + r.h / 2, true);
      slotEnd.set(target, end);
      const [from, h] = spawned.has(target) ? [r.h / 2, r.h / 2 - 6] : [6, r.h - 12];
      into.forEach((b, i) => {
        b.l.tx = end.x;
        b.l.ty = into.length === 1 ? end.y : r.y + from + (h * (i + 1)) / (into.length + 1);
      });
      continue;
    }
    // A workspace, whose slot is not shown, takes them on its heading.
    const h = r.h > H.ws ? HEAD : r.h;
    into.forEach((b, i) => Object.assign(b.l, { tx: r.x, ty: r.y + (h * (i + 1)) / (into.length + 1) }));
  }
  // While edited, every live slot shown has an end, where a line can go (story 377).
  if (base) for (const id of shown) if (!slotEnd.has(id) && !slotById.get(id)!.archived) point(id, rects.get(id)!.x, rects.get(id)!.y + rects.get(id)!.h / 2, true);
  lanes(
    binds.map((b) => b.l),
    BOTW + 16,
    X2 - 14,
  );
  // Down its lane to its height, then into the slot's end over a run longer the more lines meet there;
  // one a few pixels off runs straight in.
  for (const { l, target } of binds) {
    const to: [number, number] = [l.tx, slotEnd.get(target)?.y ?? l.ty];
    const fan = Math.min(24, 8 + 2 * binds.filter((b) => b.target === target).length);
    const meet: [number, number][] = l.ty === to[1] ? [to] : [[l.tx - fan, l.ty], to];
    l.pts = l.ty === to[1] && Math.abs(l.sy - to[1]) < 6 ? [[l.sx, l.sy], to] : [[l.sx, l.sy], [l.lane!, l.sy], [l.lane!, l.ty], ...meet];
  }
  for (const b of [...binds, ...links]) {
    line(b.id, b.source, b.target, b.l);
    for (const p of points) if (p.of === (p.end ? b.target : b.source)) p.lines.push(b.id);
  }
  // The file tree: down from the parent's left, into each child.
  for (const [p, c] of spawns) {
    const a = rects.get(p)!;
    const b = rects.get(c)!;
    line(`spawn:${c}`, p, c, { kind: "spawn", sx: a.x + TRUNK, sy: a.y + a.h, tx: b.x, ty: b.y + TICK });
  }

  // What the focus is related to: the node; a slot's parent, children and the chats bound to it; a
  // workspace's slots and the chats bound into it; a Bot's chats. With each chat, its Bot and where its
  // line lands; with each slot, its workspace. The lines lit: those that lead to the focus, a slot or
  // one in the workspace, a follower's link with its Bot's line; a Bot's own and its chats'. Each lit
  // line lights both its ends.
  let lit: Set<string> | null = null;
  let litLines: Set<string> | null = null;
  const chatIds: string[] = [];
  const wsSlots = (w: string) => (rows.get(w) ?? []).map((r) => r.s.id);
  if (focus) {
    lit = new Set([focus.id]);
    if (focused) {
      for (const s of [parentOf(focused), ...g.slots.filter((c) => c.parent === focused.id && shows(c))]) {
        const to = s && lift(s.id);
        if (to) lit.add(to);
      }
      for (const b of g.bindings) if (b.slot === focused.id) chatIds.push(b.chat);
    }
    if (focus.kind === "ws") {
      for (const id of wsSlots(focus.id)) lit.add(id);
      for (const b of g.bindings) if (slotById.get(b.slot)?.workspace === focus.id) chatIds.push(b.chat);
    }
    if (focus.kind === "bot") chatIds.push(...g.chats.filter((c) => c.bot === focus.id).map((c) => c.id));
    for (const c of chatIds) {
      lit.add(c);
      lit.add(botOf.get(c)!);
      const t = lift(binding.get(c)?.slot);
      if (t) lit.add(t);
    }
    // A line: itself and what it carries on with, a Bot's line its followers' links, a link its Bot's line.
    const me = focus.kind === "line" ? edges.find((e) => e.data!.of === focus.id && e.data!.kind !== "spawn" && !e.data!.was)?.data : undefined;
    const along = (a: Line, b: Line) => a.of === b.of || (a.kind === "bot" && b.kind === "link" && botOf.get(b.of!) === a.of);
    const leads = (l: Line) => {
      if (l.was) return false;
      if (focus.kind === "line") return !!me && (along(me, l) || along(l, me));
      const owner = botOf.get(l.of!) ?? l.of;
      if (focus.kind === "bot") return owner === focus.id;
      return focus.kind === "slot" ? l.reach === focus.id : slotById.get(l.reach ?? "")?.workspace === focus.id;
    };
    litLines = new Set(edges.filter((e) => e.data!.kind !== "spawn" && leads(e.data!)).map((e) => e.id));
    for (const e of edges) if (litLines.has(e.id)) for (const id of [e.source, e.target, botOf.get(e.source)]) if (id) lit.add(id);
    for (const id of [...lit]) {
      const s = slotById.get(id);
      if (s && isWs.has(s.workspace)) lit.add(s.workspace);
    }
    // A spawn's tree line, between two lit slots.
    for (const e of edges) if (e.data!.kind === "spawn" && lit.has(e.source) && lit.has(e.target)) litLines.add(e.id);
  }

  // The first view of a deep link: a slot with its parent, children and chats; a workspace with the
  // chats bound into it, so both ends of each line show; a Bot with its chats and where its default goes.
  let fit: string[] = [];
  if (focused) fit = [focused.parent ?? "", focused.id, ...kids(focused).map((c) => c.id), ...chatIds];
  if (focus?.kind === "ws") fit = [focus.id, ...wsSlots(focus.id), ...chatIds];
  if (focus?.kind === "bot") fit = [focus.id, ...chatIds, lift(g.bots.find((b) => b.id === focus.id)?.target) ?? ""];
  if (focus?.kind === "line") fit = [...lit!];
  fit = fit.filter((id) => rects.has(id));
  const all = [...rects.values()];
  const content = all.length ? union(all) : { x: 0, y: 0, w: 0, h: 0 };
  const extent = { x: content.x - MARGIN, y: content.y - MARGIN, w: content.w + 2 * MARGIN, h: content.h + 2 * MARGIN };
  // A top-level slot fits under its workspace's heading, for context.
  const head = focused && !fit.includes(focused.parent ?? "") && rects.get(focused.workspace);
  const box = fit.length ? union([...fit.map((id) => rects.get(id)!), ...(head ? [{ ...head, h: HEAD }] : [])]) : content;
  const anchor = rects.get(focus?.id ?? "");
  return { nodes, edges, rects, box, top: box.h > 480 && anchor ? anchor.y : box.y, extent, lit: lit && new Set([...lit].filter((id) => rects.has(id))), litLines, points };
}

/** A change to a chat's target or a Bot's default, with what it was (spec web-write "拓扑图上的改绑定"). */
export type Change = BindChange;

/** g as it is with the draft's changes made: each Bot's default, and where each chat goes, one that
 *  follows its Bot's default following it. */
export function drafted(g: Graph, draft: Change[]): Graph {
  const bots = g.bots.map((b) => {
    const c = draft.find((c) => "bot" in c && c.bot === b.id);
    return c ? { ...b, target: c.to as string } : b;
  });
  const was = new Map(g.bindings.map((b) => [b.chat, b]));
  const bindings = g.chats.flatMap((c) => {
    const ch = draft.find((x) => "chat" in x && x.chat === c.id) as Extract<Change, { chat: string }> | undefined;
    const b = was.get(c.id);
    const use = ch ? ch.to !== null : !!b?.use;
    const slot = (ch ? ch.to : b?.use ? b.slot : null) ?? (use ? null : bots.find((x) => x.id === c.bot)?.target);
    return slot ? [{ chat: c.id, slot, use }] : [];
  });
  return { ...g, bots, bindings };
}

/** The draft with the line of `of`, a chat or a Bot, put on slot `to` (a chat: null, its Bot's end,
 *  following the default), in place of a change to it before: none if that is where it was. A slot is
 *  a chat's own pick even when it is the default: only the Bot's end follows it (story 383). Each change
 *  has what it was as g has it now. */
export function put(g: Graph, draft: Change[], of: string, to: string | null): Change[] {
  const rest = draft.filter((c) => ("chat" in c ? c.chat : c.bot) !== of);
  const bot = g.bots.find((b) => b.id === of);
  if (bot) return to === bot.target || to === null ? rest : [...rest, { bot: of, from: bot.target, to }];
  const b = g.bindings.find((b) => b.chat === of);
  const from = { slot: b?.slot ?? null, use: !!b?.use };
  return (to === null ? !from.use : from.use && from.slot === to) ? rest : [...rest, { chat: of, from, to }];
}

/** The draft with the lines of `of` and `other`, two chats or two Bots, swapped (story 379): each takes
 *  the slot the other reaches as drafted now, a chat as its own pick, a Bot as its default. */
export function swap(g: Graph, draft: Change[], of: string, other: string): Change[] {
  const now = drafted(g, draft);
  const [a, b] = [reachOf(now, of)!.id, reachOf(now, other)!.id];
  return put(g, put(g, draft, of, b), other, a);
}

/** The starts line `of`'s start can swap with (story 379): the others of its kind reaching a slot, not
 *  the one it reaches; none if it reaches none. */
export function starts(g: Graph, of: string): Set<string> {
  const at = reachOf(g, of)?.id;
  const kin = g.bots.some((b) => b.id === of) ? g.bots.map((b) => b.id) : g.chats.map((c) => c.id);
  return new Set(at ? kin.filter((k) => (reachOf(g, k)?.id ?? at) !== at) : []);
}

/** The draft step by step (story 385): the whole draft after each step, the last the draft now. Undoing
 *  one drops the last, so the draft is back exactly as it was, a swap's two changes together. */
export const addStep = (steps: Change[][], f: (draft: Change[]) => Change[]) => [...steps, f(steps.at(-1) ?? [])];
export const undoStep = (steps: Change[][]) => steps.slice(0, -1);

/** The chats and Bots whose change was made from what g no longer has: changed elsewhere since. */
export function stale(g: Graph, draft: Change[]): Set<string> {
  const out = new Set<string>();
  for (const c of draft) {
    if ("bot" in c) {
      if ((g.bots.find((b) => b.id === c.bot)?.target ?? null) !== c.from) out.add(c.bot);
      continue;
    }
    const b = g.bindings.find((b) => b.chat === c.chat);
    if ((b?.slot ?? null) !== c.from.slot || !!b?.use !== c.from.use) out.add(c.chat);
  }
  return out;
}

/** What undoes the draft once made on g: each chat and Bot back as g has it, from where the draft left
 *  it. A Bot that had no default keeps the one it was given. */
export function undoOf(g: Graph, draft: Change[]): Change[] {
  const after = drafted(g, draft);
  return draft.flatMap((c): Change[] => {
    if ("bot" in c) return c.from === null ? [] : [{ bot: c.bot, from: c.to, to: c.from }];
    const b = after.bindings.find((b) => b.chat === c.chat);
    return [{ chat: c.chat, from: { slot: b?.slot ?? null, use: c.to !== null }, to: c.from.use ? c.from.slot : null }];
  });
}

/** Where line `of`, a chat's or a Bot's, ends as g has it: a slot; a following chat's, its Bot's end;
 *  a Bot's with no default, nowhere. */
export function endOf(g: Graph, of: string): string | null {
  const bot = g.bots.find((b) => b.id === of);
  if (bot) return bot.target;
  const b = g.bindings.find((b) => b.chat === of);
  return b?.use ? b.slot : (g.chats.find((c) => c.id === of)?.bot ?? null);
}

/** The ends line `of`'s end can go to (stories 378, 383, 384): every live slot, and a chat's own Bot's
 *  end; not where it is. */
export function ends(g: Graph, of: string): Set<string> {
  const out = new Set(g.slots.filter((s) => !s.archived).map((s) => s.id));
  const chat = g.chats.find((c) => c.id === of);
  if (chat) out.add(chat.bot);
  out.delete(endOf(g, of) ?? "");
  return out;
}

/** The lines, by their starts, that end at end k: a Bot's followers', or those into a slot. */
export const into = (g: Graph, k: string) => [...g.bots.map((b) => b.id), ...g.chats.map((c) => c.id)].filter((of) => endOf(g, of) === k);

/** Editing (spec web-write "拓扑图上的改绑定"): the line selected, by its start; whether its end is in
 *  hand, or its start; the end tapped, whose lines are lit; back, that end held to draw from, to a start (story 382). */
export type Edit = { sel: string | null; held: boolean; at: string | null; start?: boolean; back?: true };
export const NONE: Edit = { sel: null, held: false, at: null };
/** A tap's outcome: the edit next; the line of `of` put on `to` (null: its Bot's end), or swapped with
 *  that of `with`; a workspace opened or closed. */
export type Step = { edit: Edit; put?: { of: string; to: string | null }; swap?: { of: string; with: string }; open?: string };
const dotKey = (p: Point) => `${p.end ? "e" : "s"}:${p.of}`;

/** What a tap at x, y does while editing, on node if it is on one, k flow units a screen pixel. A dot
 *  within 22px is tapped, the nearest; the selected line's own within 24px, those its end can go to
 *  within 26px, or the starts its start can swap with. Off the dots, a chat or a Bot stands for its start,
 *  a slot for its end. */
export function editTap(g: Graph, v: View, s: Edit, x: number, y: number, k: number, node: { kind: Data["kind"]; id: string } | null): Step {
  const near = (ps: Point[], r: number) => {
    let best: Point | undefined;
    for (const p of ps) if (Math.hypot(p.x - x, p.y - y) <= r * k && (!best || Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y))) best = p;
    return best;
  };
  const isBot = (id: string) => g.bots.some((b) => b.id === id);
  const select = (of: string): Step => (s.sel === of ? { edit: NONE } : { edit: { sel: of, held: isBot(of) && !endOf(g, of), at: null } });
  const atEnd = (end: string): Step => {
    const ls = into(g, end);
    if (!ls.length) return { edit: s };
    if (ls.length === 1) return { edit: { sel: ls[0]!, held: false, at: null } };
    return { edit: s.at === end ? NONE : { sel: null, held: false, at: end } };
  };
  if (s.sel && (s.held || s.start)) {
    // A chat or Bot node stands for its start, a slot or Bot node for its end: the legal ones are of the kind in hand.
    const legal = s.held ? ends(g, s.sel) : starts(g, s.sel);
    const to = near(v.points.filter((p) => p.end === s.held && legal.has(p.of)), 26)?.of ?? (node && legal.has(node.id) ? node.id : undefined);
    if (to) return { edit: NONE, ...(s.held ? { put: { of: s.sel, to: isBot(to) ? null : to } } : { swap: { of: s.sel, with: to } }) };
    const d = node && v.nodes.find((n) => n.id === node.id)?.data;
    if (s.held && d?.kind === "ws" && !d.open) return { edit: s, open: d.ws.id };
    return { edit: { sel: s.sel, held: false, at: null } };
  }
  if (s.sel) {
    const end = endOf(g, s.sel);
    const mine = near(v.points.filter((p) => (p.end ? p.of === end : p.of === s.sel)), 24);
    if (mine) return { edit: mine.end ? { ...s, held: true } : { ...s, start: true } };
  }
  const d = near(v.points, 22);
  if (d) return d.end ? atEnd(d.of) : select(d.of);
  if (node?.kind === "chat" || node?.kind === "bot") return select(node.id);
  if (node?.kind === "slot") return atEnd(node.id);
  if (node?.kind === "ws") return { edit: s, open: node.id };
  const l = pick(v.edges.map((e) => e.data!), x, y, 18 * k);
  return l ? select(l) : { edit: NONE };
}

/** What stays clear while editing, the rest fading: a line selected with its two ends, larger; its end
 *  in hand, the ends it can go to, glowing, and their workspaces; its start in hand, the starts it can
 *  swap with, glowing, and their Bots; an end tapped, the lines into it. None, nothing singled out. */
export function editLit(g: Graph, v: View, s: Edit): { nodes: Set<string>; lines: Set<string>; big: Set<string>; glow: Set<string> } | null {
  if (!s.sel && !s.at) return null;
  const out = { nodes: new Set<string>(), lines: new Set<string>(), big: new Set<string>(), glow: new Set<string>() };
  const line = (of: string) => {
    for (const e of v.edges) if (e.data!.of === of && !e.data!.was && e.data!.kind !== "spawn") out.lines.add(e.id);
    out.nodes.add(of);
    const bot = g.chats.find((c) => c.id === of)?.bot;
    if (bot) out.nodes.add(bot);
  };
  const end = (id: string | null) => {
    if (!id) return;
    out.nodes.add(id);
    const ws = g.slots.find((x) => x.id === id)?.workspace;
    if (ws) out.nodes.add(ws);
  };
  const points = new Set(v.points.map(dotKey));
  if (s.back) {
    // Drawn from an end: the starts whose line can come here, with their Bots.
    for (const of of comers(g, s.at!)) {
      out.nodes.add(of);
      const bot = g.chats.find((c) => c.id === of)?.bot;
      if (bot) out.nodes.add(bot);
      out.glow.add(`s:${of}`);
    }
    end(s.at);
    out.big.add(`e:${s.at}`);
  } else if (s.sel) {
    line(s.sel);
    if (!s.start) out.big.add(`s:${s.sel}`);
    for (const id of s.start ? starts(g, s.sel) : []) {
      out.nodes.add(id);
      out.nodes.add(g.chats.find((c) => c.id === id)?.bot ?? id);
      out.glow.add(`s:${id}`);
    }
    // A closed workspace with one stays clear too: tapped, it opens (story 311).
    if (s.held) for (const id of ends(g, s.sel)) (end(id), points.has(`e:${id}`) && out.glow.add(`e:${id}`));
    else if (endOf(g, s.sel)) (end(endOf(g, s.sel)), out.big.add(`e:${endOf(g, s.sel)}`));
  } else {
    for (const of of into(g, s.at!)) line(of);
    end(s.at);
    out.big.add(`e:${s.at}`);
  }
  return out;
}

/** A line drawn by a drag (stories 381, 382): from a start, its end to go on an end; from an end, to
 *  take the line of a start. */
export type Grab = { of: string; end: boolean };
export const LONG_PRESS = 300;
/** What a press is that has moved d px in ms: a finger pans once it moves 8px before it has been held
 *  300ms, and draws once it has; a mouse draws once it moves 4px. null: not yet either, a tap if let go. */
export const pressed = (mouse: boolean, d: number, ms: number): "pan" | "draw" | null => (mouse ? (d > 4 ? "draw" : null) : ms >= LONG_PRESS ? "draw" : d > 8 ? "pan" : null);

/** The starts whose line can be put on end k (story 382): those whose end can go there. */
export const comers = (g: Graph, k: string) => new Set([...g.bots, ...g.chats].map((x) => x.id).filter((of) => ends(g, of).has(k)));
/** Where a line drawn from d can go: from a start, an end; from an end, a start. */
const aims = (g: Graph, d: Grab) => (d.end ? comers(g, d.of) : ends(g, d.of));

/** The nearest of ps within r of x, y. */
const nearest = (ps: Point[], x: number, y: number, r: number) => {
  let best: Point | undefined;
  for (const p of ps) if (Math.hypot(p.x - x, p.y - y) <= r && (!best || Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y))) best = p;
  return best;
};

/** What a press at x, y draws from, k flow units a screen pixel: the nearest dot within 22px with
 *  somewhere to go. */
export function grab(g: Graph, v: View, x: number, y: number, k: number): Grab | null {
  const p = nearest(v.points.filter((p) => aims(g, { of: p.of, end: p.end }).size > 0), x, y, 22 * k);
  return p ? { of: p.of, end: p.end } : null;
}

/** Where a line drawn from d goes if let go at x, y: a dot it can go to within 30px, else the node
 *  under it that stands for one, a chat or a slot, or a Bot's title. */
export function dropAt(g: Graph, v: View, d: Grab, x: number, y: number, k: number): string | null {
  const legal = aims(g, d);
  const p = nearest(v.points.filter((p) => p.end !== d.end && legal.has(p.of)), x, y, 30 * k);
  if (p) return p.of;
  const inside = (r: Rect | undefined) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  const n = v.nodes.find((n) => (n.data.kind === "chat" || n.data.kind === "slot") && inside(v.rects.get(n.id))) ?? v.nodes.find((n) => n.data.kind === "bot" && inside({ ...v.rects.get(n.id)!, h: H.botHead }));
  return n && legal.has(n.id) ? n.id : null;
}

/** Editing while d is drawn: from a start, its line selected and its end in hand; from an end, it held. */
export const grabbed = (d: Grab): Edit => (d.end ? { sel: null, held: false, at: d.of, back: true } : { sel: d.of, held: true, at: null });

/** What letting go of d on to does, as the tap there would: a start's line or the line of to put on the
 *  end. On nothing, a start's line stays selected. */
export function drop(g: Graph, d: Grab, to: string | null): Step {
  if (!to) return { edit: d.end ? NONE : { sel: d.of, held: false, at: null } };
  const [of, end] = d.end ? [to, d.of] : [d.of, to];
  return { edit: NONE, put: { of, to: g.bots.some((b) => b.id === end) ? null : end } };
}

/** The top and bottom of a line's vertical run. */
export const span = (l: Line) => [Math.min(l.sy, l.ty), Math.max(l.sy, l.ty)] as const;

/** Gives each line a vertical run of its own between x0 and x1, ordered so lines cross the least:
 *  of the lines going down, the one that starts higher runs further right; going up, further left.
 *  A line going up and one going down whose runs overlap cross once whichever runs left: they go as
 *  side has it, so that the fewest thin lines cross a Bot's line's run, the lines going up left where
 *  it makes no odds. Lines whose runs are apart vertically share a lane, so the lanes get the whole width. */
function lanes(lines: Line[], x0: number, x1: number) {
  const by = (a: Line, b: Line) => a.sy - b.sy || a.ty - b.ty;
  const up = lines.filter((l) => l.ty < l.sy).sort(by);
  const down = lines.filter((l) => l.ty >= l.sy).sort(by).reverse();
  // The two merged, each in its order, with the fewest pairs against side. cost[j]: the least for the
  // lines going up so far, the last right of j lines going down; from: where the one before it was then.
  let cost = Array<number>(down.length + 1).fill(0);
  const from: number[][] = [];
  for (const u of up) {
    const want = down.map((d) => side(u, d));
    const lo = cost.map((_, j) => cost.indexOf(Math.min(...cost.slice(0, j + 1))));
    from.push(lo);
    cost = lo.map((k, j) => cost[k]! + want.filter((w, i) => (i < j ? w < 0 : w > 0)).length);
  }
  const right: number[] = []; // how many lines going down run left of each line going up
  for (let i = up.length - 1, j = cost.indexOf(Math.min(...cost)); i >= 0; j = from[i]![j]!, i--) right[i] = j;
  const order = [...down.flatMap((d, j) => [...up.filter((_, i) => right[i] === j), d]), ...up.filter((_, i) => right[i] === down.length)];
  // Each one lane right of every line before it whose run is within 12px of its own (past the rounded
  // corners), so the order holds; lines apart share a lane.
  const at: number[] = [];
  order.forEach((l, i) => {
    const [lo, hi] = span(l);
    at.push(Math.max(-1, ...order.slice(0, i).flatMap((o, j) => (span(o)[1] + 12 < lo || hi + 12 < span(o)[0] ? [] : [at[j]!]))) + 1);
  });
  const n = Math.max(0, ...at) + 1;
  const step = Math.min(12, (x1 - x0) / Math.max(n - 1, 1));
  const start = (x0 + x1) / 2 - (step * (n - 1)) / 2;
  order.forEach((l, i) => (l.lane = start + at[i]! * step));
}

/** Which side of d, going down, u, going up, runs if their runs overlap: they cross once either way, the
 *  level part of the one across the run of the other. 1 right, -1 left, 0 either way. A Bot's line keeps
 *  a thin line's level parts off its run: right of it when it starts within the thin line's run, so it
 *  crosses that run as it sets out; left when it ends within it, so as it comes in. */
function side(u: Line, d: Line) {
  if ((u.kind === "bot") === (d.kind === "bot")) return 0;
  const [bot, thin] = u.kind === "bot" ? [u, d] : [d, u];
  const [lo, hi] = span(thin);
  const right = lo < bot.sy && bot.sy < hi ? 1 : lo < bot.ty && bot.ty < hi ? -1 : 0;
  return bot === u ? right : -right;
}

/** The line a tap at x, y picks (story 376), by its start: the nearest within r, a thick one in a near
 *  tie; a link only up to the chat above it, so the run a Bot's links share is the lower chat's. Only
 *  binding lines that reach a slot. */
export function pick(lines: Line[], x: number, y: number, r: number): string | null {
  const seg = ([px, py]: [number, number], [qx, qy]: [number, number]) => {
    const [dx, dy] = [qx - px, qy - py];
    const t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - px - t * dx, y - py - t * dy);
  };
  let best: string | null = null;
  let score = Infinity;
  for (const l of lines) {
    const pts = l.hit ?? l.pts;
    if (!pts || !l.reach || l.was || l.kind === "spawn") continue;
    const d = Math.min(...pts.slice(1).map((q, i) => seg(pts[i]!, q)));
    const s = d - (l.kind === "own" ? 0 : 1); // a thick line is a little nearer
    if (d <= r && s < score) [best, score] = [l.of!, s];
  }
  return best;
}

/** The slot line `of` (a Bot or a chat) reaches: a Bot's default, a chat's slot; none, no line. */
export const reachOf = (g: Graph, of: string) => {
  const id = g.bots.find((b) => b.id === of)?.target ?? g.bindings.find((b) => b.chat === of)?.slot;
  return g.slots.find((s) => s.id === id);
};


/** The path from the overview to the focus: a workspace, then the slots down its tree to the focused
 *  one. A Bot is lit on the overview, so its path is the overview's; a line's has the slot it reaches. */
export function trail(g: Graph, focus: Focus): { label: string; focus: Focus }[] {
  const out: { label: string; focus: Focus }[] = [{ label: "总览", focus: null }];
  if (!focus || focus.kind === "bot") return out;
  if (focus.kind === "line") return [...out, { label: reachOf(g, focus.id)?.name ?? "", focus }];
  const s = g.slots.find((s) => s.id === focus.id);
  const ws = g.workspaces.find((w) => w.id === (s ? s.workspace : focus.id));
  if (!ws) return out;
  out.push({ label: ws.name, focus: { kind: "ws", id: ws.id } });
  const path: Slot[] = [];
  for (let p = s; p && p.workspace === ws.id; p = g.slots.find((x) => x.id === p!.parent)) path.unshift(p);
  for (const p of path) out.push({ label: p.name, focus: { kind: "slot", id: p.id } });
  return out;
}

export const key = (f: Focus) => (f ? `${f.kind}:${f.id}` : "");

/** A focus only if the data has that node. */
export function known(g: Graph, f: Focus): Focus {
  if (f?.kind === "line") return reachOf(g, f.id) ? f : null;
  const ids = f && { ws: g.workspaces, slot: g.slots, bot: g.bots }[f.kind];
  return ids?.some((n) => n.id === f!.id) ? f : null;
}

/** Whether going from the focus at to f replaces the step in history rather than adding one: a move
 *  between nodes of one level, whose path has the same step above (Bots and workspaces, the top-level
 *  slots of a workspace, the children of a slot), or taking up again the focus let go of. */
export const replaces = (g: Graph, at: Focus, f: Focus) => key(at) === key(f) || (!!at && !!f && key(trail(g, at).at(-2)?.focus ?? null) === key(trail(g, f).at(-2)?.focus ?? null));

/** Where the view is: #/topology, or #/topology/<kind>/<id> on a focus, a line by its start's id; ?x the focus let go of, what
 *  it opened staying open; chat, a slot's chat open beside the graph. */
export type Route = { focus: Focus; sel: boolean; chat: boolean };
export function readRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#?\/?/, "").split("?");
  const [, kind, ...id] = path.split("/");
  const q = new URLSearchParams(query);
  const focus: Focus = (kind === "bot" || kind === "ws" || kind === "slot" || kind === "line") && id.length ? { kind, id: decodeURIComponent(id.join("/")) } : null;
  return { focus, sel: !q.has("x"), chat: q.has("chat") };
}
export function routeHash(r: Route): string {
  const q = [r.focus && !r.sel && "x", r.chat && "chat"].filter(Boolean).join("&");
  return `#/topology${r.focus ? `/${r.focus.kind}/${encodeURIComponent(r.focus.id)}` : ""}${q ? `?${q}` : ""}`;
}

export type Viewport = { x: number; y: number; zoom: number };

/** v kept inside ext, as d3-zoom's constrain does: centred on an axis where ext fits the screen. */
export function clamp(v: Viewport, w: number, h: number, ext: Rect): Viewport {
  const axis = (t: number, start: number, size: number, screen: number) =>
    size * v.zoom <= screen ? screen / 2 - (start + size / 2) * v.zoom : Math.min(-start * v.zoom, Math.max(screen - (start + size) * v.zoom, t));
  return { x: axis(v.x, ext.x, ext.w, w), y: axis(v.y, ext.y, ext.h, h), zoom: v.zoom };
}

/** The zoom that fits all of ext on a w by h screen, kept between 0.5 and 1: the least zoom allowed. */
export const least = (ext: Rect, w: number, h: number) => Math.min(1, Math.max(0.5, Math.min(w / ext.w, h / ext.h)));

/** A phone's bounds: ext reaching a screen h tall below the graph's top at zoom min, the least. A graph
 *  shorter than the screen sits at its top, not centred, the room under it the sheet's. */
export const below = (ext: Rect, h: number, min: number): Rect => union([ext, { ...ext, h: MARGIN + h / min }]);

/** The view that shows box b, as large as it fits (zoom min to max), its top left first if it can't.
 *  With top (a phone), it fits the width only and puts y = top 16px from the top. */
export function fitTo(b: Rect, w: number, h: number, min: number, max: number, ext: Rect, pad = 16, top?: number): Viewport {
  const zoom = Math.min(max, Math.max(min, Math.min((w - 2 * pad) / b.w, top === undefined ? (h - 2 * pad) / b.h : Infinity)));
  const axis = (start: number, size: number, screen: number) => (size * zoom > screen - 2 * pad ? pad - start * zoom : screen / 2 - (start + size / 2) * zoom);
  return clamp({ x: axis(b.x, b.w, w), y: top === undefined ? axis(b.y, b.h, h) : 16 - top * zoom, zoom }, w, h, ext);
}

/** Whether box r shows on a w by h screen at viewport vp. */
export const onScreen = (r: Rect, vp: Viewport, w: number, h: number) => r.x * vp.zoom + vp.x < w && (r.x + r.w) * vp.zoom + vp.x > 0 && r.y * vp.zoom + vp.y < h && (r.y + r.h) * vp.zoom + vp.y > 0;

/** vp moved the least that brings box r inside the screen with a 16px margin, its top left first; on an
 *  axis where all of it shows already, not at all. */
export function bring(vp: Viewport, r: Rect, w: number, h: number): Viewport {
  const axis = (t: number, start: number, size: number, screen: number) => {
    const a = start * vp.zoom + t;
    const b = a + size * vp.zoom;
    if (a >= 0 && b <= screen) return t;
    return size * vp.zoom > screen - 32 || a < 16 ? t + 16 - a : t - (b - screen + 16);
  };
  return { x: axis(vp.x, r.x, r.w, w), y: axis(vp.y, r.y, r.h, h), zoom: vp.zoom };
}

/** vp moved the least that brings box r into view, kept inside ext and what the screen shows at vp as it
 *  is now: a screen that grew since ext was taken, as when the sheet shrinks, never centres a graph
 *  shorter than it. */
export const toward = (vp: Viewport, r: Rect, w: number, h: number, ext: Rect) => clamp(bring(vp, r, w, h), w, h, union([ext, seen(vp, w, h)]));

/** The part of the graph a w by h screen shows at viewport vp. */
export const seen = (vp: Viewport, w: number, h: number): Rect => ({ x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: w / vp.zoom, h: h / vp.zoom });

/** vp moved so that the node whose box was o and is now r stays where it was on the screen. */
export const keep = (vp: Viewport, o: Rect, r: Rect): Viewport => ({ x: vp.x - (r.x - o.x) * vp.zoom, y: vp.y - (r.y - o.y) * vp.zoom, zoom: vp.zoom });

export const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

/** The phone's sheet: its one row's height; how tall it may be on a screen (a third of the graph, under
 *  its 48px header and 44px path, stays above it); how tall a tap opens it; and where a drag let go
 *  of at h leaves it: null, its row alone, when within two rows. */
export const SHEET = {
  bar: 66,
  max: (screen: number) => Math.round(((screen - 92) * 2) / 3),
  open: (screen: number) => Math.min(SHEET.max(screen), Math.round(screen * 0.46)),
  settle: (h: number, screen: number): number | null => (h < 2 * SHEET.bar ? null : Math.min(Math.round(h), SHEET.max(screen))),
};
