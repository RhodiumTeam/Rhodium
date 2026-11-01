// The topology view's layout and the rest of its logic that is not drawing (spec web-topology, 测试决定):
// on a graph of the real size, a large one, and one with a child spawned into another workspace, at
// every focus, phone and wide, archived slots shown or not, every workspace unfolded or not.
import { expect, test } from "bun:test";
import { addStep, below, bring, clamp, drafted, comers, drop, dropAt, editLit, editTap, endOf, ends, grab, grabbed, pressed, fitTo, hidden, into, keep, key, known, least, MARGIN, NONE, pick, put, readRoute, replaces, routeHash, seen, SHEET, span, stale, starts, swap, toward, trail, undoOf, undoStep, union, view, type Data, type Edit, type Focus, type Graph, type Line, type Rect, type Slot } from "../web/src/topology/model";

type SlotIn = Partial<Slot> & { ref: string };
/** A graph from bots (name: [chat, kind, slot ref it goes to, by /rh_use][]) and slots by ref; ids
 *  are the names. kind: "private" is your private chat; "stranger" a stranger's (#291). A slot's
 *  parent is a ref; its workspace the ref's first part. */
function graph(bots: Record<string, [chat: string, kind: "private" | "stranger" | "group", to: string, use?: boolean][]>, slots: SlotIn[], extraWs: string[] = []): Graph {
  const ws = [...new Set([...slots.map((s) => s.ref.split("/")[0]!), ...extraWs])];
  return {
    // A Bot's default is where the chats that follow it go.
    bots: Object.entries(bots).map(([name, cs], i) => ({ id: name, name, platform: i % 2 ? "telegram" : "qq", main: i === 0, conn: "online", target: cs.find((c) => !c[3])?.[2] ?? null, avatar: null })),
    chats: Object.entries(bots).flatMap(([bot, cs]) => cs.map(([id, kind]) => ({ id, bot, kind: kind === "group" ? ("group" as const) : ("private" as const), yours: kind === "private", name: null, main: false, avatar: null, verbose: false }))),
    bindings: Object.values(bots).flatMap((cs) => cs.map(([chat, , to, use]) => ({ chat, slot: to, use: !!use }))),
    workspaces: ws.map((w) => ({ id: w, name: w })),
    slots: slots.map((s) => ({
      id: s.ref,
      name: s.ref.split("/")[1]!,
      workspace: s.ref.split("/")[0]!,
      parent: null,
      agent: "claude",
      mode: "headless",
      phase: "idle",
      state: "空闲",
      group: "idle",
      lifetime: "longterm",
      archived: false,
      contact: null,
      ...s,
    })),
  };
}

// As the real instance has it: three Bots in the order of their names, a private chat each; a workspace
// with archived slots only.
const real = graph(
  { main: [["c-main", "private", "dispatcher/main"]], relay: [["c-mc", "private", "home/main"]], telegram: [["c-tg", "private", "dispatcher/main"]] },
  [
    { ref: "dispatcher/main", group: "running" },
    { ref: "dispatcher/cat-or-dog", parent: "dispatcher/main", archived: true, lifetime: "oneoff" },
    { ref: "home/main" },
    { ref: "Rhodium/main", group: "needsYou", phase: "waiting" },
    { ref: "shop/main" },
    { ref: "rh-import-test/old", archived: true },
  ],
);

// About 30 slots in 8 workspaces, trees three deep, 10 chats of 4 Bots, some by /rh_use, some groups.
const WS = ["dispatcher", "Rhodium", "shop", "ops", "home", "notes", "infra", "web"];
const big: SlotIn[] = [];
for (const [i, w] of WS.entries()) {
  big.push({ ref: `${w}/main`, group: i % 3 === 0 ? "running" : "idle" });
  for (let k = 0; k < (i % 3) + 1; k++) {
    big.push({ ref: `${w}/k${k}`, parent: `${w}/main`, lifetime: "oneoff", archived: k === 2 });
    if (k === 0) big.push({ ref: `${w}/k0a`, parent: `${w}/k0` }, { ref: `${w}/k0b`, parent: `${w}/k0`, group: "needsYou" });
  }
}
big.push({ ref: "ops/lonely" }, { ref: "web/old", archived: true });
const large = graph(
  {
    a: [["a1", "private", "dispatcher/main"], ["a2", "group", "Rhodium/k0", true], ["a3", "group", "dispatcher/main"]],
    b: [["b1", "group", "shop/main", true], ["b2", "private", "dispatcher/main"], ["b3", "private", "Rhodium/k0a", true]],
    c: [["c1", "private", "ops/main"], ["c2", "group", "web/k0b", true]],
    d: [["d1", "private", "infra/main"], ["d2", "group", "notes/k0", true]],
  },
  big,
  ["empty"],
);
// dispatcher/main spawned ops/backup: the child lives in ops.
const cross = graph({ a: [["a1", "private", "dispatcher/main"]], b: [["b1", "private", "ops/backup", true]] }, [...big, { ref: "ops/backup", parent: "dispatcher/main" }]);

// Every node, and every line by its start: each Bot with a default, each chat with a slot.
const foci = (g: Graph): Focus[] => [
  null,
  ...g.bots.map((b) => ({ kind: "bot" as const, id: b.id })),
  ...g.workspaces.map((w) => ({ kind: "ws" as const, id: w.id })),
  ...g.slots.map((s) => ({ kind: "slot" as const, id: s.id })),
  ...[...g.bots.filter((b) => b.target), ...g.chats.filter((c) => g.bindings.some((b) => b.chat === c.id))].map((n) => ({ kind: "line" as const, id: n.id })),
];
const inside = (r: Rect, e: Rect) => r.x >= e.x && r.y >= e.y && r.x + r.w <= e.x + e.w && r.y + r.h <= e.y + e.h;
const every = (check: (g: Graph, f: Focus, wide: boolean, archived: boolean, unfold: boolean) => void) => {
  for (const g of [real, large, cross]) for (const wide of [false, true]) for (const archived of [false, true]) for (const unfold of [false, true]) for (const f of foci(g)) check(g, f, wide, archived, unfold);
};

test("stories 212, 218, 224, 377: at every focus, nodes are unique, lines join shown nodes, all is within bounds, the lit show; and so while the bindings are edited", () => {
  every((g, f, wide, archived, unfold) => {
    for (const v of [view(g, f, archived, wide, { unfold }), view(g, f, archived, wide, { base: g, unfold })]) {
    const ids = new Set(v.nodes.map((n) => n.id));
    expect(ids.size).toBe(v.nodes.length);
    expect(v.rects.size).toBe(v.nodes.length);
    for (const e of v.edges) expect([e.id, ids.has(e.source) && ids.has(e.target)]).toEqual([e.id, true]);
    for (const id of v.lit ?? []) expect(ids.has(id)).toBe(true);
    for (const [id, r] of v.rects) expect([id, inside(r, v.extent)]).toEqual([id, true]);
    if (f?.kind === "slot") expect(ids.has(f.id) && v.lit!.has(f.id)).toBe(true);
    }
  });
});

/** Where a binding line ends: its last point. */
const endY = (l: Line) => l.pts!.at(-1)![1];

test("stories 370, 372, 377: binding lines whose runs overlap never share a lane, and none ends where the tree enters a child; and so while the bindings are edited", () => {
  every((g, f, wide, archived, unfold) => {
    for (const v of [view(g, f, archived, wide, { unfold }), view(g, f, archived, wide, { base: g, unfold })]) {
    // A follower's link runs up its Bot's gutter, which the links of one Bot share.
    const runs = v.edges.filter((e) => e.data!.kind !== "spawn" && e.data!.kind !== "link").map((e) => e.data!);
    for (const [i, a] of runs.entries())
      for (const b of runs.slice(i + 1)) {
        const [a0, a1] = span(a);
        const [b0, b1] = span(b);
        expect(a1 < b0 || b1 < a0 || Math.abs(a.lane! - b.lane!) >= 4).toBe(true);
      }
    const spawns = v.edges.filter((e) => e.data!.kind === "spawn");
    for (const s of spawns) for (const b of v.edges.filter((e) => e.target === s.target && e.data!.kind !== "spawn")) expect(Math.abs(endY(b.data!) - s.data!.ty)).toBeGreaterThanOrEqual(4);
    }
  });
});

// The review's crowd: main sends to dispatcher/main, its private chat following; six groups picked
// dispatcher/main, three Rhodium/dev, one the archived cat-or-dog. Of relay's groups, one picked
// dispatcher/main, one home/notes, between relay's title and its default (#310).
const crowd = graph(
  {
    main: [["m0", "private", "dispatcher/main"], ...[1, 2, 3, 4, 5, 6].map((i): [string, "group", string, true] => [`m${i}`, "group", "dispatcher/main", true]), ...[7, 8, 9].map((i): [string, "group", string, true] => [`m${i}`, "group", "Rhodium/dev", true]), ["m10", "group", "dispatcher/cat-or-dog", true]],
    relay: [["c-mc", "private", "home/main"], ["mc1", "group", "dispatcher/main", true], ["mc2", "group", "home/notes", true]],
    telegram: [["c-tg", "private", "dispatcher/main"]],
  },
  [{ ref: "dispatcher/main", group: "running" }, { ref: "dispatcher/cat-or-dog", parent: "dispatcher/main", archived: true }, { ref: "home/main" }, { ref: "home/notes", group: "needsYou" }, { ref: "Rhodium/main" }, { ref: "Rhodium/dev", group: "needsYou" }],
);

test("stories 370, 372: of two binding lines whose runs overlap, going down the one starting higher runs further right, going up further left, so none crosses another's run", () => {
  for (const g of [real, large, cross, crowd])
    for (const wide of [false, true])
      for (const f of foci(g)) {
        const runs = view(g, f, true, wide).edges.filter((e) => e.data!.kind === "bot" || e.data!.kind === "own").map((e) => e.data!);
        for (const a of runs)
          for (const b of runs) {
            const [a0, a1] = span(a);
            const [b0, b1] = span(b);
            const down = (l: Line) => l.ty >= l.sy;
            if (a === b || a1 < b0 || b1 < a0 || down(a) !== down(b) || a.sy >= b.sy) continue;
            // a starts higher than b.
            expect([a.of, b.of, down(a) ? a.lane! > b.lane! : a.lane! < b.lane!]).toEqual([a.of, b.of, true]);
          }
      }
});

type Pt = [number, number];
/** Whether segments pq and rs cross, not just touch. */
const crosses = (p: Pt, q: Pt, r: Pt, s: Pt) => {
  const side = (a: Pt, b: Pt, c: Pt) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return side(r, s, p) * side(r, s, q) < 0 && side(p, q, r) * side(p, q, s) < 0;
};
/** Each place one binding line's level part crosses another's vertical run, the only way two cross. */
const crossings = (lines: Line[]) => {
  const parts = (l: Line) => l.pts!.slice(1).map((q, i) => [l.pts![i]!, q] as const);
  return lines.flatMap((across) =>
    lines.flatMap((run) => {
      const up = parts(run).filter(([p, q]) => p[0] === q[0]);
      return parts(across).flatMap(([p, q]) => (p[0] === q[0] ? [] : up.filter(([r, s]) => crosses(p, q, r, s)).map(() => ({ across, run }))));
    }),
  );
};

test("#310: a thin line crosses a Bot's line's run only where its own run lies within the Bot's; so on the crowd no more lines cross than with every line going up left, and fewer across a Bot's run", () => {
  let all = 0;
  let thick = 0;
  for (const g of [real, large, cross, crowd])
    for (const wide of [false, true])
      for (const archived of [false, true])
        for (const unfold of [false, true])
          for (const f of foci(g)) {
            const found = crossings(view(g, f, archived, wide, { unfold }).edges.filter((e) => e.data!.kind === "bot" || e.data!.kind === "own").map((e) => e.data!));
            const cut = found.filter(({ across, run }) => across.kind === "own" && run.kind === "bot");
            for (const { across, run } of cut) {
              const [a0, a1] = span(across);
              const [b0, b1] = span(run);
              expect([across.of, run.of, b0 < a0 && a1 < b1]).toEqual([across.of, run.of, true]);
            }
            if (g === crowd) [all, thick] = [all + found.length, thick + cut.length];
          }
  // With every line going up left of every line going down (#309): 2028 crossings, 1128 across a Bot's run.
  expect(all).toBeLessThanOrEqual(2028);
  expect(thick).toBeLessThan(1128);
});

test("story 224: each child sits right under its parent, one step in, ending where it ends, with one tree line; only its parent's descendants between", () => {
  every((g, f, wide, archived, unfold) => {
    const v = view(g, f, archived, wide, { unfold });
    const ids = new Set(v.nodes.map((n) => n.id));
    const slots = v.nodes.filter((n) => n.type === "slot").map((n) => g.slots.find((s) => s.id === n.id)!);
    const spawns = v.edges.filter((e) => e.data!.kind === "spawn");
    const order = slots.map((s) => s.id).sort((a, b) => v.rects.get(a)!.y - v.rects.get(b)!.y);
    const under = (id: string, p: string): boolean => {
      const s = g.slots.find((s) => s.id === id)!;
      return s.parent === p || (!!s.parent && under(s.parent, p));
    };
    // A parent drawn in another workspace, both shown as lines point at them, is no tree's.
    const near = (s: Slot) => !!s.parent && ids.has(s.parent) && g.slots.find((p) => p.id === s.parent)!.workspace === s.workspace;
    for (const s of slots) {
      expect(v.nodes.find((n) => n.id === s.id)!.parentId).toBe(s.workspace);
      if (!near(s) || !s.parent) continue;
      const p = v.rects.get(s.parent)!;
      const c = v.rects.get(s.id)!;
      expect(c.y > p.y && c.x === p.x + 18 && c.x + c.w === p.x + p.w).toBe(true);
      for (const id of order.slice(order.indexOf(s.parent) + 1, order.indexOf(s.id))) expect(under(id, s.parent)).toBe(true);
      expect(spawns.some((e) => e.source === s.parent && e.target === s.id)).toBe(true);
    }
    expect(spawns).toHaveLength(slots.filter(near).length);
  });
});

test("stories 218, 220: a Bot is lit exactly when it is the focus, one of its chats is or its line is; a focused Bot leaves every other Bot faded and every workspace closed", () => {
  every((g, f, wide, archived, unfold) => {
    if (!f) return;
    const v = view(g, f, archived, wide, { unfold });
    for (const b of g.bots) expect([b.id, v.lit!.has(b.id)]).toEqual([b.id, f.id === b.id || g.chats.some((c) => c.bot === b.id && v.lit!.has(c.id)) || v.litLines!.has(`bot:${b.id}`)]);
  });
  for (const g of [real, large])
    for (const b of g.bots) {
      const v = view(g, { kind: "bot", id: b.id }, false, false);
      expect(g.chats.filter((c) => c.bot === b.id).every((c) => v.lit!.has(c.id))).toBe(true);
      expect(g.bots.filter((o) => v.lit!.has(o.id)).map((o) => o.id)).toEqual([b.id]);
      expect(v.nodes.some((n) => n.type === "ws" && n.data.kind === "ws" && n.data.open)).toBe(false);
    }
});

test("story 370: each Bot has a thick line from its start to its default; each chat following it a thick link into the Bot's end; each chat with a slot of its own a thin line there; no other binding line", () => {
  every((g, f, wide, archived, unfold) => {
    const v = view(g, f, archived, wide, { unfold });
    const lines = v.edges.filter((e) => e.data!.kind !== "spawn");
    const own = (c: string) => !!g.bindings.find((b) => b.chat === c)?.use;
    const want = [
      ...g.bots.filter((b) => b.target).map((b) => `bot:${b.id} ${b.id}>${b.target}`),
      ...g.chats.filter((c) => !own(c.id)).map((c) => `link:${c.id} ${c.id}>${c.bot}`),
      ...g.chats.filter((c) => own(c.id)).map((c) => `own:${c.id} ${c.id}>${g.bindings.find((b) => b.chat === c.id)!.slot}`),
    ];
    expect(lines.map((e) => `${e.id} ${e.source}>${e.target}`).sort()).toEqual(want.sort());
    for (const e of lines) {
      const l = e.data!;
      const start = v.points.find((p) => !p.end && p.of === e.source)!;
      expect([e.id, l.pts![0]]).toEqual([e.id, [start.x, start.y]]);
      // A link ends at its Bot's end, left of the Bot's start on its title, over the room the chats leave.
      if (l.kind === "link") {
        const end = v.points.find((p) => p.end && p.of === e.target)!;
        expect([e.id, l.pts!.at(-1)]).toEqual([e.id, [end.x, end.y]]);
        expect(end.x).toBeGreaterThan(v.rects.get(e.source)!.x + v.rects.get(e.source)!.w);
        expect(end.x).toBeLessThan(v.rects.get(e.target)!.x + v.rects.get(e.target)!.w);
      }
    }
  });
});

test("story 372: every slot a line points at has one end at the middle of its left, where each line into it ends; no other slot has one", () => {
  every((g, f, wide, archived, unfold) => {
    const v = view(g, f, archived, wide, { unfold });
    const into = v.edges.filter((e) => e.data!.kind === "bot" || e.data!.kind === "own");
    const ends = v.points.filter((p) => p.end && g.slots.some((s) => s.id === p.of));
    expect(ends.map((p) => p.of).sort()).toEqual([...new Set(into.map((e) => e.target))].sort());
    for (const p of ends) {
      const r = v.rects.get(p.of)!;
      expect([p.x, p.y]).toEqual([r.x, r.y + r.h / 2]);
    }
    for (const e of into) {
      const p = ends.find((p) => p.of === e.target)!;
      expect([e.id, e.data!.pts!.at(-1)]).toEqual([e.id, [p.x, p.y]]);
      // Off its height, it meets the others over a run as long as min(24, 8 + 2n) for n lines into it.
      const n = into.filter((o) => o.target === e.target).length;
      const meet = e.data!.pts!.at(-2)!;
      if (e.data!.pts!.length > 2 && meet[1] !== p.y) expect([e.id, meet[0]]).toEqual([e.id, p.x - Math.min(24, 8 + 2 * n)]);
    }
  });
});

// Bot p sends to w/a, which its private chat follows; its groups picked w/c (a child of w/a), w/old
// (archived), w/d and w/e. w/b, which needs you, no line points at; nor at w/f, which runs.
const aimed = graph(
  { p: [["p1", "private", "w/a"], ["p2", "group", "w/c", true], ["p3", "group", "w/old", true], ["p4", "group", "w/e", true], ["p5", "group", "w/d", true]] },
  [{ ref: "w/a" }, { ref: "w/b", group: "needsYou" }, { ref: "w/c", group: "running", parent: "w/a" }, { ref: "w/d", group: "needsYou" }, { ref: "w/old", archived: true }, { ref: "w/e", group: "running" }, { ref: "w/f", group: "running" }],
);

test("story 373: a closed workspace shows only the slots lines point at, archived too, as a tree, each level what needs you first, then what runs; its counts leave them out", () => {
  for (const wide of [false, true])
    for (const f of [null, { kind: "bot" as const, id: "p" }]) {
      const v = view(aimed, f, false, wide);
      const ws = v.nodes.find((n) => n.id === "w")!;
      expect(ws.data).toMatchObject({ kind: "ws", open: false, rows: ["w/d", "w/e", "w/a", "w/c", "w/old"] });
      const slots = v.nodes.filter((n) => n.type === "slot").sort((a, b) => v.rects.get(a.id)!.y - v.rects.get(b.id)!.y);
      expect(slots.map((n) => n.id)).toEqual(["w/d", "w/e", "w/a", "w/c", "w/old"]);
      expect(slots.every((n) => n.parentId === "w")).toBe(true);
      expect(v.rects.get("w/c")!.x).toBe(v.rects.get("w/a")!.x + 18);
      expect(v.edges.some((e) => e.data!.kind === "spawn" && e.source === "w/a" && e.target === "w/c")).toBe(true);
      // Inside its box.
      for (const n of slots) expect(inside(v.rects.get(n.id)!, v.rects.get("w")!)).toBe(true);
      expect(hidden(ws.data as Extract<Data, { kind: "ws" }>).map((s) => s.id)).toEqual(["w/b", "w/f"]);
    }
  // Opened, it has all of its live slots, and the archived one a line points at.
  const open = view(aimed, { kind: "ws", id: "w" }, false, false);
  expect(open.nodes.filter((n) => n.type === "slot").map((n) => n.id).sort()).toEqual(["w/a", "w/b", "w/c", "w/d", "w/e", "w/f", "w/old"]);
  // With no line at any of its slots, a workspace is its heading alone.
  const v = view(large, null, false, false);
  for (const w of large.workspaces.filter((w) => v.rects.has(w.id))) {
    const d = v.nodes.find((n) => n.id === w.id)!.data as Extract<Data, { kind: "ws" }>;
    const at = new Set([...large.bots.map((b) => b.target), ...large.bindings.map((b) => b.slot)]);
    expect(d.rows.toSorted()).toEqual(large.slots.filter((s) => s.workspace === w.id && at.has(s.id)).map((s) => s.id).toSorted());
  }
});

test("stories 370, 218: a slot or a workspace lights the lines that reach it, a follower's link with its Bot's line; a Bot, its line and each of its chats'", () => {
  const lit = (g: Graph, f: Focus) => [...view(g, f, false, false).litLines!].sort();
  expect(lit(aimed, { kind: "slot", id: "w/a" })).toEqual(["bot:p", "link:p1", "spawn:w/c"]);
  expect(lit(aimed, { kind: "slot", id: "w/c" })).toEqual(["own:p2", "spawn:w/c"]);
  expect(lit(aimed, { kind: "ws", id: "w" })).toEqual(["bot:p", "link:p1", "own:p2", "own:p3", "own:p4", "own:p5", "spawn:w/c"]);
  expect(lit(large, { kind: "bot", id: "b" })).toEqual(["bot:b", "link:b2", "own:b1", "own:b3"]);
  // Each lit line lights both ends: its chat and Bot, its slot and the slot's workspace.
  const v = view(large, { kind: "slot", id: "dispatcher/main" }, false, false);
  for (const id of ["a", "a1", "a3", "b", "b2", "dispatcher/main", "dispatcher"]) expect([id, v.lit!.has(id)]).toEqual([id, true]);
  expect(v.lit!.has("c")).toBe(false);
  expect(view(large, null, false, false).litLines).toBeNull();
});

test("stories 371, 236: within a Bot, the chats that follow its default come first, your private chats before the rest in each lot, at every focus; opening a workspace keeps both columns' order", () => {
  every((g, f, wide, archived, unfold) => {
    const v = view(g, f, archived, wide, { unfold });
    for (const b of g.bots) {
      const rank = (id: string) => 2 * +!!g.bindings.find((x) => x.chat === id)?.use + +!g.chats.find((c) => c.id === id)!.yours;
      const ranks = v.nodes.filter((n) => n.parentId === b.id).sort((p, q) => p.position.y - q.position.y).map((n) => rank(n.id));
      expect(ranks).toEqual(ranks.toSorted());
    }
  });
  // A stranger's private chat (#291) comes after yours, though it points higher.
  const s = graph({ p: [["p1", "private", "w/b", true], ["p2", "stranger", "w/a", true]] }, [{ ref: "w/a" }, { ref: "w/b" }]);
  expect(view(s, null, false, false).nodes.filter((n) => n.parentId === "p").sort((a, b) => a.position.y - b.position.y).map((n) => n.id)).toEqual(["p1", "p2"]);
  const order = (f: Focus) => {
    const v = view(large, f, false, false);
    return v.nodes.filter((n) => !n.parentId).sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y).map((n) => n.id);
  };
  const shut = order(null);
  for (const w of large.workspaces.filter((w) => shut.includes(w.id))) expect(order({ kind: "ws", id: w.id })).toEqual(shut);
});

test("#255: archived shown or not, both columns keep their order: workspaces with archived slots only come after the rest", () => {
  const order = (g: Graph, f: Focus, archived: boolean, wide: boolean, unfold: boolean) =>
    view(g, f, archived, wide, { unfold })
      .nodes.filter((n) => !n.parentId)
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .map((n) => n.id);
  every((g, f, wide, archived, unfold) => {
    if (archived) return;
    const off = order(g, f, false, wide, unfold);
    const on = order(g, f, true, wide, unfold);
    expect(on.filter((id) => off.includes(id))).toEqual(off);
    const live = (id: string) => g.slots.some((s) => s.workspace === id && !s.archived);
    const ws = on.filter((id) => g.workspaces.some((w) => w.id === id));
    expect(ws).toEqual([...ws.filter(live), ...ws.filter((id) => !live(id))]);
  });
});

test("story 374: with every workspace unfolded, each shown is open at every focus, with the slots it has opened alone; none overlaps another; both columns keep their order", () => {
  const top = (v: ReturnType<typeof view>) => v.nodes.filter((n) => !n.parentId).sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const opened = new Map<string, string[]>();
  const rows = (v: ReturnType<typeof view>, id: string) => (v.nodes.find((n) => n.id === id)!.data as Extract<Data, { kind: "ws" }>).rows;
  every((g, f, wide, archived, unfold) => {
    if (!unfold) return;
    const v = view(g, f, archived, wide, { unfold });
    const own = f?.kind === "ws" ? f.id : f?.kind === "slot" ? g.slots.find((s) => s.id === f.id)!.workspace : null;
    for (const n of v.nodes.filter((n) => n.type === "ws")) {
      // Its rows as when it is opened alone: by the focus, if it holds it, else by its own heading.
      const k = [[real, large, cross].indexOf(g), wide, archived, n.id].join();
      if (own !== n.id && !opened.has(k)) opened.set(k, rows(view(g, { kind: "ws", id: n.id }, archived, wide), n.id));
      const alone = own === n.id ? rows(view(g, f, archived, wide), n.id) : opened.get(k)!;
      expect([n.id, (n.data as Extract<Data, { kind: "ws" }>).open, rows(v, n.id)]).toEqual([n.id, true, alone]);
    }
    const nodes = top(v);
    expect(nodes.map((n) => n.id)).toEqual(top(view(g, f, archived, wide)).map((n) => n.id));
    for (const [i, n] of nodes.entries()) {
      const p = nodes[i - 1];
      if (!p || p.position.x !== n.position.x) continue;
      const r = v.rects.get(p.id)!;
      expect([n.id, n.position.y >= r.y + r.h]).toEqual([n.id, true]);
    }
  });
});

test("stories 212, 242: on a phone, every chat window and slot is at least 44px tall at the least zoom the phone fits it at", () => {
  for (const g of [real, large, cross])
    for (const f of foci(g)) {
      const v = view(g, f, true, false);
      for (const n of v.nodes.filter((n) => n.type === "chat" || n.type === "slot")) expect([n.id, v.rects.get(n.id)!.h * 0.85 >= 44]).toEqual([n.id, true]);
    }
});

test("story 216: archived slots, and workspaces with no live slot, show only with the archived switch, or as the focus and its ancestors", () => {
  expect(view(real, null, false, false).rects.has("rh-import-test")).toBe(false);
  expect(view(real, null, true, false).rects.has("rh-import-test")).toBe(true);
  expect(view(real, { kind: "ws", id: "rh-import-test" }, false, false).rects.has("rh-import-test")).toBe(true);
  const slots = (f: Focus, archived: boolean) => view(real, f, archived, false).nodes.filter((n) => n.parentId === "dispatcher").map((n) => n.id);
  expect(slots({ kind: "ws", id: "dispatcher" }, false)).toEqual(["dispatcher/main"]);
  expect(slots({ kind: "ws", id: "dispatcher" }, true)).toEqual(["dispatcher/main", "dispatcher/cat-or-dog"]);
  expect(slots({ kind: "slot", id: "dispatcher/cat-or-dog" }, false)).toEqual(["dispatcher/main", "dispatcher/cat-or-dog"]);
});

test("stories 218, 221, 225: a slot lights its parent, children and bound chats with their Bots, not its siblings; across workspaces, the other's workspace", () => {
  const v = view(large, { kind: "slot", id: "Rhodium/k0" }, false, false);
  for (const id of ["Rhodium/main", "Rhodium/k0a", "Rhodium/k0b", "a2", "a"]) expect([id, v.lit!.has(id)]).toEqual([id, true]);
  expect(v.lit!.has("Rhodium/k1")).toBe(false);
  expect(v.edges.find((e) => e.id === "own:a2")!.target).toBe("Rhodium/k0");

  // The child, which a line points at, shows in its closed workspace, lit with it.
  const parent = view(cross, { kind: "slot", id: "dispatcher/main" }, false, false);
  expect(parent.nodes.find((n) => n.id === "ops/backup")!.parentId).toBe("ops");
  expect(parent.lit!.has("ops/backup") && parent.lit!.has("ops")).toBe(true);
  expect(parent.nodes.find((n) => n.id === "dispatcher/main")!.data).toMatchObject({ away: true });
  const child = view(cross, { kind: "slot", id: "ops/backup" }, false, false);
  expect(child.nodes.find((n) => n.id === "ops/backup")!).toMatchObject({ parentId: "ops", data: { away: true } });
  expect(child.lit!.has("dispatcher")).toBe(true);
  expect(child.edges.some((e) => e.data!.kind === "spawn" && e.target === "ops/backup")).toBe(false);
  expect(trail(cross, { kind: "slot", id: "ops/backup" }).map((c) => c.label)).toEqual(["总览", "ops", "backup"]);
});

test("story 223: the path goes from the overview through the workspace and each parent to the focus; a Bot's is the overview's", () => {
  expect(trail(large, { kind: "slot", id: "Rhodium/k0b" }).map((c) => c.label)).toEqual(["总览", "Rhodium", "main", "k0", "k0b"]);
  expect(trail(large, { kind: "slot", id: "Rhodium/k0b" }).at(-2)!.focus).toEqual({ kind: "slot", id: "Rhodium/k0" });
  expect(trail(large, { kind: "ws", id: "shop" }).map((c) => c.label)).toEqual(["总览", "shop"]);
  expect(trail(large, { kind: "bot", id: "a" }).map((c) => c.label)).toEqual(["总览"]);
  expect(trail(large, null).map((c) => c.label)).toEqual(["总览"]);
});

test("story 243: back goes to the last place you stopped: a move within one level replaces the step, a move deeper or elsewhere adds one", () => {
  const s = (id: string): Focus => ({ kind: "slot", id });
  const ws = (id: string): Focus => ({ kind: "ws", id });
  const bot = (id: string): Focus => ({ kind: "bot", id });
  // Between Bots and workspaces; between a workspace's top-level slots; between a slot's children.
  expect([replaces(large, bot("a"), bot("b")), replaces(large, bot("a"), ws("shop")), replaces(large, ws("ops"), ws("shop"))]).toEqual([true, true, true]);
  expect([replaces(large, s("ops/main"), s("ops/lonely")), replaces(large, s("Rhodium/k0a"), s("Rhodium/k0b"))]).toEqual([true, true]);
  // Deeper, up, or elsewhere; and from the overview.
  expect([replaces(large, ws("Rhodium"), s("Rhodium/main")), replaces(large, s("Rhodium/main"), s("Rhodium/k0")), replaces(large, s("Rhodium/k0"), s("shop/main")), replaces(large, null, ws("shop"))]).toEqual([false, false, false, false]);
  // The focus let go of and taken up again.
  expect(replaces(large, s("shop/main"), s("shop/main"))).toBe(true);
});

test("the address: #/topology, a focus by kind and id, ?x for the focus let go of, chat beside it; an unknown node is the overview", () => {
  const routes = [
    { focus: null, sel: true, chat: false },
    { focus: { kind: "slot" as const, id: "01ABC" }, sel: true, chat: false },
    { focus: { kind: "ws" as const, id: "w/x y" }, sel: false, chat: false },
    { focus: { kind: "bot" as const, id: "b" }, sel: false, chat: true },
    { focus: { kind: "slot" as const, id: "s" }, sel: true, chat: true },
  ];
  expect(routes.map(routeHash)).toEqual(["#/topology", "#/topology/slot/01ABC", "#/topology/ws/w%2Fx%20y?x", "#/topology/bot/b?x&chat", "#/topology/slot/s?chat"]);
  for (const r of routes) expect(readRoute(routeHash(r))).toEqual(r);
  expect(readRoute("#/topology/nope/1")).toEqual({ focus: null, sel: true, chat: false });
  expect(known(large, { kind: "slot", id: "gone" })).toBeNull();
  expect(known(large, { kind: "ws", id: "shop" })).toEqual({ kind: "ws", id: "shop" });
});

test("stories 240-242: the camera stays within bounds, keeps the tapped node under the finger, and moves the least to bring it into view", () => {
  const ext = { x: -32, y: -32, w: 600, h: 1000 };
  // Dragged far off, it comes back to the edge; content narrower than the screen is centred.
  const far = clamp({ x: 5000, y: -9000, zoom: 1 }, 390, 600, ext);
  expect([far.x, far.y]).toEqual([32, -(ext.y + ext.h - 600)]);
  expect(clamp({ x: 99, y: 0, zoom: 0.5 }, 390, 600, ext).x).toBe(195 - (ext.x + ext.w / 2) * 0.5);
  // A node that moved by the layout stays where it was on the screen.
  expect(keep({ x: 10, y: 20, zoom: 2 }, { x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 100, w: 1, h: 1 })).toEqual({ x: 0, y: -180, zoom: 2 });
  // Off the bottom, it comes up just enough to show with 16px to spare; on screen, nothing moves.
  expect(bring({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 700, w: 100, h: 40 }, 390, 600)).toEqual({ x: 0, y: -156, zoom: 1 });
  expect(bring({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100, w: 100, h: 40 }, 390, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  // All on the screen, if nearer its edge than 16px: nothing moves (#242). Partly off: in, 16px from the edge.
  expect(bring({ x: 0, y: 0, zoom: 1 }, { x: 8, y: 560, w: 374, h: 40 }, 390, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(bring({ x: 0, y: 0, zoom: 1 }, { x: -10, y: 100, w: 100, h: 40 }, 390, 600)).toEqual({ x: 26, y: 0, zoom: 1 });
  // A graph shorter than the screen is centred, which would move a node the layout moved (#242); the
  // bounds widened by what the screen shows let the view keep it under the finger.
  const small = { x: -32, y: -32, w: 454, h: 300 };
  const kept = keep({ x: 12, y: 150, zoom: 1 }, { x: 0, y: 200, w: 160, h: 48 }, { x: 0, y: 150, w: 160, h: 48 });
  expect(clamp(kept, 390, 600, small)).not.toEqual(kept);
  expect(seen(kept, 390, 600)).toEqual({ x: -12, y: -200, w: 390, h: 600 });
  expect(clamp(kept, 390, 600, union([small, seen(kept, 390, 600)]))).toEqual(kept);
  // A phone fits the width at 0.85 at least, from the top it is given.
  const phone = fitTo({ x: 0, y: 0, w: 500, h: 900 }, 390, 600, 0.85, 1, ext, 12, 0);
  expect(phone.zoom).toBe(0.85);
  expect(phone.y).toBe(16);
  // A Pixel 7's (412px) overview fits its width at 0.85, and so does any workspace opened or slot's neighbourhood.
  for (const g of [real, large]) {
    expect(view(g, null, false, false).box.w * 0.85).toBeLessThanOrEqual(388);
    for (const w of g.workspaces) expect(view(g, { kind: "ws", id: w.id }, true, false).extent.w).toBe(view(g, null, false, false).extent.w);
    for (const s of g.slots) expect(view(g, { kind: "slot", id: s.id }, true, false).box.w * 0.85).toBeLessThanOrEqual(396);
  }
});

test("#255: as the sheet shrinks to what the new focus has, the camera is bound by the screen as it is when it glides, not as it was", () => {
  // A graph shorter than the screen, the view kept where the tapped node was, the sheet 421px tall.
  const small = { x: -32, y: -32, w: 454, h: 300 };
  const vp = { x: 12, y: 150, zoom: 1 };
  const held = union([small, seen(vp, 390, 400)]);
  // The sheet shrinks and the screen grows 294px: the node, on screen, stays under the finger.
  expect(toward(vp, { x: 0, y: 100, w: 160, h: 48 }, 390, 694, held)).toEqual(vp);
});

test("#282: a graph shorter than the screen sits 16px under the path on a phone, kept there as it is dragged or zoomed out; a wide screen centres it", () => {
  const g = view(real, null, false, false);
  const [w, h] = [390, 700];
  const min = least(g.extent, w, h);
  expect(g.extent.h * min).toBeLessThan(h);
  const ext = below(g.extent, h, min);
  // Across, as before.
  expect([ext.x, ext.w]).toEqual([g.extent.x, g.extent.w]);
  const all = { ...g.box, x: g.extent.x + MARGIN, w: g.extent.w - 2 * MARGIN };
  const vp = fitTo(all, w, h, Math.max(min, 0.85), 1, ext, 12, g.top);
  expect(g.box.y * vp.zoom + vp.y).toBe(16);
  expect(vp.x).toBe(fitTo(all, w, h, Math.max(min, 0.85), 1, g.extent, 12, g.top).x);
  // What a drag or a pinch is kept to keeps it there, down to the least zoom.
  expect(clamp(vp, w, h, ext)).toEqual(vp);
  const out = { x: vp.x, y: 16 - g.box.y * min, zoom: min };
  expect(clamp(out, w, h, ext).y).toBe(out.y);
  // Zoomed in and dragged up as far as it goes, the graph's top stays on the screen, 0 to 32px down,
  // with the room under it as deep as the screen at that zoom; at the least zoom's, the screen goes blank.
  for (const zoom of [min, 0.92, 1.44, 1.5]) {
    const up = clamp({ x: vp.x, y: -1e5, zoom }, w, h, below(g.extent, h, zoom));
    expect(g.box.y * zoom + up.y).toBeGreaterThanOrEqual(0);
    expect(g.box.y * zoom + up.y).toBeLessThanOrEqual(MARGIN);
  }
  expect(g.box.y * 1.44 + clamp({ x: vp.x, y: -1e5, zoom: 1.44 }, w, h, below(g.extent, h, min)).y).toBeLessThan(-h / 2);
  // A wide screen centres it, as before.
  const wide = view(real, null, false, true);
  const at = fitTo(wide.box, 1440, 900, least(wide.extent, 1440, 900), 1.2, wide.extent, 12);
  expect(wide.extent.y * at.zoom + at.y).toBeCloseTo(450 - (wide.extent.h * at.zoom) / 2);
});

test("story 227: the sheet opens to 46% of the screen, never covers more than two thirds of the graph, and let go of within two rows folds to its row", () => {
  expect(SHEET.open(800)).toBe(368);
  expect(SHEET.max(800)).toBe(472);
  expect(SHEET.open(250)).toBe(SHEET.max(250));
  expect(SHEET.settle(131, 800)).toBeNull();
  expect(SHEET.settle(300.4, 800)).toBe(300);
  expect(SHEET.settle(700, 800)).toBe(472);
});

// ---- the bindings edited on the topology (spec web-write "拓扑图上的改绑定") ----

// Bot p sends to w/a by default: its private chat follows, its group picked w/c. q's default is w/b: its
// private chat follows, its group picked w/b too. r has no default, and its private chat goes nowhere.
const edit = graph(
  { p: [["p1", "private", "w/a"], ["p2", "group", "w/c", true]], q: [["q1", "private", "w/b"], ["q2", "group", "w/b", true]] },
  [{ ref: "w/a" }, { ref: "w/b" }, { ref: "w/c" }, { ref: "w/d", archived: true }, { ref: "v/e" }],
);
edit.bots[0]!.target = "w/a";
edit.bots[1]!.target = "w/b";
edit.bots.push({ id: "r", name: "r", platform: "qq", main: false, conn: "online", target: null, avatar: null });
edit.chats.push({ id: "r1", bot: "r", kind: "private", yours: true, name: null, main: false, avatar: null, verbose: false });
const byChat = (g: Graph) => g.bindings.toSorted((a, b) => a.chat.localeCompare(b.chat));

test("stories 383, 385: a line put on a slot is the chat's own pick, even its Bot's default; put on its Bot's end it follows the default; put again, only the last stays; put back, there is none", () => {
  let d = put(edit, [], "p1", "w/b");
  expect(d).toEqual([{ chat: "p1", from: { slot: "w/a", use: false }, to: "w/b" }]);
  d = put(edit, d, "p1", "w/c");
  expect(d).toEqual([{ chat: "p1", from: { slot: "w/a", use: false }, to: "w/c" }]);
  expect(put(edit, d, "p1", null)).toEqual([]);
  // On the slot its Bot's default is: picked, not following (story 383).
  expect(put(edit, [], "p1", "w/a")).toEqual([{ chat: "p1", from: { slot: "w/a", use: false }, to: "w/a" }]);
  expect(put(edit, [], "p2", null)).toEqual([{ chat: "p2", from: { slot: "w/c", use: true }, to: null }]);
  expect(put(edit, [], "p2", "w/c")).toEqual([]);
  // Picked by /rh_use, it went to its Bot's default: there again, nothing changes; on the Bot's end, it follows.
  expect(put(edit, [], "q2", "w/b")).toEqual([]);
  expect(put(edit, [], "q2", null)).toEqual([{ chat: "q2", from: { slot: "w/b", use: true }, to: null }]);
  // Nowhere before: a chat with no target, a Bot with no default.
  expect(put(edit, [], "r1", "w/a")).toEqual([{ chat: "r1", from: { slot: null, use: false }, to: "w/a" }]);
  expect(put(edit, [], "r", "w/a")).toEqual([{ bot: "r", from: null, to: "w/a" }]);
});

test("story 384: a Bot's line moved moves its default, and the chats following it with it; a chat put on the slot the default now is picks it", () => {
  const moved = put(edit, [], "p", "w/c");
  expect(moved).toEqual([{ bot: "p", from: "w/a", to: "w/c" }]);
  const g = drafted(edit, moved);
  expect(g.bots.find((b) => b.id === "p")!.target).toBe("w/c");
  expect(byChat(g)).toEqual(byChat(edit).map((b) => (b.chat === "p1" ? { ...b, slot: "w/c" } : b)));
  expect(put(edit, moved, "p2", "w/c")).toEqual(moved);
  expect(put(edit, moved, "p1", "w/c")).toEqual([...moved, { chat: "p1", from: { slot: "w/a", use: false }, to: "w/c" }]);
  expect(put(edit, moved, "p1", null)).toEqual(moved);
  expect(put(edit, moved, "p", "w/a")).toEqual([]);
});

test("story 315: a change whose chat or Bot was changed elsewhere since is in conflict, until it is put again", () => {
  const d = put(edit, put(edit, [], "p1", "w/b"), "q", "w/c");
  expect(stale(edit, d).size).toBe(0);
  const now = structuredClone(edit);
  now.bindings = now.bindings.map((b) => (b.chat === "p1" ? { chat: "p1", slot: "w/c", use: true } : b));
  expect([...stale(now, d)]).toEqual(["p1"]);
  expect(stale(now, put(now, d, "p1", "w/b")).size).toBe(0);
  now.bots.find((b) => b.id === "q")!.target = "w/a";
  expect([...stale(now, d)]).toEqual(["p1", "q"]);
});

test("story 316: what undoes a batch done puts each chat and Bot back, from where the batch left it", () => {
  const d = put(edit, put(edit, put(edit, [], "p", "w/c"), "p2", "w/b"), "q2", null);
  const undo = undoOf(edit, d);
  expect(undo).toEqual([
    { bot: "p", from: "w/c", to: "w/a" },
    { chat: "p2", from: { slot: "w/b", use: true }, to: "w/c" },
    { chat: "q2", from: { slot: "w/b", use: false }, to: "w/b" },
  ]);
  const back = drafted(drafted(edit, d), undo);
  expect([byChat(back), back.bots]).toEqual([byChat(edit), edit.bots]);
  // A Bot that had no default cannot be left with none again.
  expect(undoOf(edit, put(edit, [], "r", "w/a"))).toEqual([]);
});

test("story 379: a start swaps with another of its kind reaching another slot: two chats each take the slot the other reaches now as their own, two Bots each other's default", () => {
  const sorted = (s: Set<string>) => [...s].sort();
  // p1 follows p to w/a, p2 picked w/c, q1 follows q to w/b, q2 picked w/b; r has no default, r1 goes nowhere.
  expect(sorted(starts(edit, "p1"))).toEqual(["p2", "q1", "q2"]);
  expect(sorted(starts(edit, "q1"))).toEqual(["p1", "p2"]);
  expect(sorted(starts(edit, "p"))).toEqual(["q"]);
  expect([sorted(starts(edit, "r")), sorted(starts(edit, "r1"))]).toEqual([[], []]);
  // As drafted: p1 put on w/b no longer swaps with what reaches w/b.
  expect(sorted(starts(drafted(edit, put(edit, [], "p1", "w/b")), "p1"))).toEqual(["p2"]);

  // Each following its Bot's default: each picks the other's slot.
  const d = swap(edit, [], "p1", "q1");
  expect(d).toEqual([
    { chat: "p1", from: { slot: "w/a", use: false }, to: "w/b" },
    { chat: "q1", from: { slot: "w/b", use: false }, to: "w/a" },
  ]);
  // Two Bots swap their defaults; the chats following them go with them.
  const b = swap(edit, [], "p", "q");
  expect(b).toEqual([
    { bot: "p", from: "w/a", to: "w/b" },
    { bot: "q", from: "w/b", to: "w/a" },
  ]);
  expect(byChat(drafted(edit, b)).filter((x) => !x.use)).toEqual([
    { chat: "p1", slot: "w/b", use: false },
    { chat: "q1", slot: "w/a", use: false },
  ]);
  // From the draft as it is: p1 already on w/c swaps that; q2 back on its picked w/b is no change.
  expect(swap(edit, put(edit, [], "p1", "w/c"), "p1", "q2")).toEqual([{ chat: "p1", from: { slot: "w/a", use: false }, to: "w/b" }, { chat: "q2", from: { slot: "w/b", use: true }, to: "w/c" }]);
  expect(swap(edit, put(edit, [], "q2", "w/c"), "q2", "q1")).toEqual([{ chat: "q1", from: { slot: "w/b", use: false }, to: "w/c" }]);
});

test("story 385: undoing one step brings the draft back as it was before it: a swap's two changes together; a swap, then one of them changed, undone, is the swap", () => {
  // Saved: p1 to W (w/a), q1 to V (w/b). A, B swap: p1 to V, q1 to W.
  let h = addStep([], (d) => swap(edit, d, "p1", "q1"));
  const swapped = h.at(-1)!;
  // p1 then put on U (w/c): its first change gives way.
  h = addStep(h, (d) => put(edit, d, "p1", "w/c"));
  expect(h.at(-1)).toEqual([
    { chat: "q1", from: { slot: "w/b", use: false }, to: "w/a" },
    { chat: "p1", from: { slot: "w/a", use: false }, to: "w/c" },
  ]);
  h = undoStep(h);
  expect(h.at(-1)).toEqual(swapped);
  const g = drafted(edit, h.at(-1)!);
  expect([g.bindings.find((b) => b.chat === "p1")!.slot, g.bindings.find((b) => b.chat === "q1")!.slot]).toEqual(["w/b", "w/a"]);
  // The swap undone: both back, no draft.
  expect(undoStep(h).at(-1) ?? []).toEqual([]);
});

test("stories 377, 385: while editing, the lines are drawn as ever from the draft; a change is a draft, the line it takes the place of drawn as removed; every live slot shown has an end; the nodes stay where they were", () => {
  const d = put(edit, put(edit, [], "p1", "w/b"), "q", "w/c");
  for (const wide of [false, true]) {
    const v = view(drafted(edit, d), null, false, wide, { laid: edit.bindings, base: edit });
    expect(v.rects).toEqual(view(edit, null, false, wide).rects);
    const lines = Object.fromEntries(v.edges.filter((e) => e.data!.kind !== "spawn").map((e) => [e.id, [e.target, e.data!.draft ? "draft" : e.data!.was ? "was" : ""]]));
    expect(lines).toEqual({
      "bot:p": ["w/a", ""],
      "bot:q": ["w/c", "draft"],
      "was:bot:q": ["w/b", "was"],
      "own:p1": ["w/b", "draft"],
      "was:link:p1": ["p", "was"],
      "own:p2": ["w/c", ""],
      "link:q1": ["q", ""],
      "own:q2": ["w/b", ""],
      "link:r1": ["r", ""],
    });
    const ends = (v: ReturnType<typeof view>) => v.points.filter((p) => p.end).map((p) => p.of).sort();
    expect(ends(v)).toEqual(["p", "q", "r", "w/a", "w/b", "w/c"]);
    expect(ends(view(edit, null, false, wide, { base: edit, open: "v" }))).toEqual(["p", "q", "r", "v/e", "w/a", "w/b", "w/c"]);
    // Not editing, a slot has an end only where a line points.
    const g = drafted(edit, put(edit, [], "p2", null));
    expect(ends(view(g, null, false, wide, { open: "v" }))).toEqual(["p", "q", "r", "w/a", "w/b"]);
  }
});

test("story 385: a draft into a slot a closed workspace did not show shows it, the nodes below pushed down, both columns in their order", () => {
  const order = (v: ReturnType<typeof view>) => [...v.rects].filter(([id]) => ["p", "q", "r", "v", "w"].includes(id)).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
  const v = view(drafted(edit, put(edit, [], "p1", "v/e")), null, false, false, { laid: edit.bindings, base: edit });
  expect(v.edges.find((e) => e.id === "own:p1")!.target).toBe("v/e");
  expect(order(v)).toEqual(order(view(edit, null, false, false)));
});

test("stories 378, 383, 384: a line's end goes to any live slot but where it is; a chat's to its own Bot's end too; the lines that end somewhere", () => {
  const sorted = (s: Set<string>) => [...s].sort();
  expect(sorted(ends(edit, "p1"))).toEqual(["v/e", "w/a", "w/b", "w/c"]);
  expect(sorted(ends(edit, "p2"))).toEqual(["p", "v/e", "w/a", "w/b"]);
  expect(sorted(ends(edit, "p"))).toEqual(["v/e", "w/b", "w/c"]);
  expect(sorted(ends(edit, "r"))).toEqual(["v/e", "w/a", "w/b", "w/c"]);
  expect([endOf(edit, "p1"), endOf(edit, "p2"), endOf(edit, "p"), endOf(edit, "r")]).toEqual(["p", "w/c", "w/a", null]);
  expect([into(edit, "w/b"), into(edit, "p"), into(edit, "w/a"), into(edit, "r"), into(edit, "v/e")]).toEqual([["q", "q2"], ["p1"], ["p"], ["r1"], []]);
});

test("stories 378, 379, 380, 383, 384, 311: while editing, a tap selects a line, picks up its end and puts it on an end, which is a change, or picks up its start and swaps it; an end tapped lights the lines into it", () => {
  const v = view(edit, null, false, false, { base: edit });
  const dot = (k: string) => v.points.find((p) => (p.end ? "e:" : "s:") + p.of === k)!;
  const mid = (id: string) => ({ x: v.rects.get(id)!.x + v.rects.get(id)!.w / 2, y: v.rects.get(id)!.y + v.rects.get(id)!.h / 2 });
  const kind = (id: string) => v.nodes.find((n) => n.id === id)!.data.kind;
  /** A tap on a dot, a node's middle, or a place, at zoom 1. */
  const tap = (s: Edit, on: string | { x: number; y: number }) => {
    if (typeof on !== "string") return editTap(edit, v, s, on.x, on.y, 1, null);
    if (on.includes(":")) return editTap(edit, v, s, dot(on).x, dot(on).y, 1, null);
    return editTap(edit, v, s, mid(on).x, mid(on).y, 1, { kind: kind(on) as "chat", id: on });
  };
  const sel = (of: string, held = false): Edit => ({ sel: of, held, at: null });
  expect(tap(NONE, "s:p1")).toEqual({ edit: sel("p1") });
  expect(tap(NONE, "p2")).toEqual({ edit: sel("p2") });
  // Its end picked up, then put on a slot: a change, nothing selected.
  expect(tap(sel("p1"), "e:p")).toEqual({ edit: sel("p1", true) });
  expect(tap(sel("p1", true), "e:w/b")).toEqual({ edit: NONE, put: { of: "p1", to: "w/b" } });
  expect(tap(sel("p1", true), "w/a")).toEqual({ edit: NONE, put: { of: "p1", to: "w/a" } });
  // Where it can't go, or off the nodes: put down, still selected.
  expect(tap(sel("p1", true), "e:q")).toEqual({ edit: sel("p1") });
  expect(tap(sel("p1", true), { x: -500, y: -500 })).toEqual({ edit: sel("p1") });
  // A chat's own pick put on its Bot's end follows the default; a Bot's line moves its default.
  expect(tap(sel("p2", true), "e:p")).toEqual({ edit: NONE, put: { of: "p2", to: null } });
  expect(tap(sel("p"), "e:w/a")).toEqual({ edit: sel("p", true) });
  expect(tap(sel("p", true), "e:w/c")).toEqual({ edit: NONE, put: { of: "p", to: "w/c" } });
  // A Bot with no default has only its start: selected, its end is in hand.
  expect(tap(NONE, "r")).toEqual({ edit: sel("r", true) });
  // A closed workspace tapped with an end in hand opens, the end still in hand (story 311).
  expect(tap(sel("p1", true), "v")).toEqual({ edit: sel("p1", true), open: "v" });
  expect(tap(NONE, "v")).toEqual({ edit: NONE, open: "v" });
  // Selected, its row or the empty canvas lets go of it; another's row selects that one.
  expect(tap(sel("p1"), "p1")).toEqual({ edit: NONE });
  expect(tap(sel("p1"), { x: -500, y: -500 })).toEqual({ edit: NONE });
  expect(tap(sel("p1"), "q1")).toEqual({ edit: sel("q1") });
  // An end with one line into it selects that line; with more, lights them; tapped again, lets go; with none, nothing.
  expect(tap(NONE, "e:w/c")).toEqual({ edit: sel("p2") });
  expect(tap(NONE, "e:w/b")).toEqual({ edit: { sel: null, held: false, at: "w/b" } });
  expect(tap(sel("p1"), "w/b")).toEqual({ edit: { sel: null, held: false, at: "w/b" } });
  expect(tap({ sel: null, held: false, at: "w/b" }, "e:w/b")).toEqual({ edit: NONE });
  // Its start picked up, then a start it can swap with, or its row: a swap; elsewhere, put down, still selected (story 379).
  const start = (of: string): Edit => ({ ...sel(of), start: true });
  expect(tap(sel("p1"), "s:p1")).toEqual({ edit: start("p1") });
  expect(tap(start("p1"), "s:q1")).toEqual({ edit: NONE, swap: { of: "p1", with: "q1" } });
  expect(tap(start("p1"), "q2")).toEqual({ edit: NONE, swap: { of: "p1", with: "q2" } });
  expect(tap(start("p"), "q")).toEqual({ edit: NONE, swap: { of: "p", with: "q" } });
  expect(tap(start("q1"), "s:q2")).toEqual({ edit: sel("q1") });
  expect(tap(start("p1"), "s:r1")).toEqual({ edit: sel("p1") });
  expect(tap(start("p1"), "e:w/b")).toEqual({ edit: sel("p1") });
  expect(tap(start("p1"), "v")).toEqual({ edit: sel("p1") });
  const open = view(edit, null, false, false, { base: edit, open: "v" });
  const e = open.points.find((p) => p.end && p.of === "v/e")!;
  expect(editTap(edit, open, sel("p1"), e.x, e.y, 1, null)).toEqual({ edit: sel("p1") });
});

test("stories 378, 379, 380: while editing, a line selected lights it and its two ends; its end in hand, the ends it can go to and their workspaces; its start in hand, the starts it can swap with; an end tapped, the lines into it", () => {
  const v = view(edit, null, false, false, { base: edit });
  const lit = (s: Edit) => {
    const l = editLit(edit, v, s)!;
    return { nodes: [...l.nodes].sort(), lines: [...l.lines].sort(), big: [...l.big].sort(), glow: [...l.glow].sort() };
  };
  expect(editLit(edit, v, NONE)).toBeNull();
  expect(lit({ sel: "p1", held: false, at: null })).toEqual({ nodes: ["p", "p1"], lines: ["link:p1"], big: ["e:p", "s:p1"], glow: [] });
  expect(lit({ sel: "p1", held: true, at: null })).toEqual({ nodes: ["p", "p1", "v", "v/e", "w", "w/a", "w/b", "w/c"], lines: ["link:p1"], big: ["s:p1"], glow: ["e:w/a", "e:w/b", "e:w/c"] });
  // Its start in hand, the starts it can swap with, and their Bots; its end stays larger (story 379).
  expect(lit({ sel: "p1", held: false, at: null, start: true })).toEqual({ nodes: ["p", "p1", "p2", "q", "q1", "q2"], lines: ["link:p1"], big: ["e:p"], glow: ["s:p2", "s:q1", "s:q2"] });
  expect(lit({ sel: null, held: false, at: "w/b" })).toEqual({ nodes: ["q", "q2", "w", "w/b"], lines: ["bot:q", "own:q2"], big: ["e:w/b"], glow: [] });
});

test("story 381: a finger draws once held 300ms, unless it moved 8px first, which pans; a mouse draws once it moves 4px", () => {
  expect([pressed(false, 5, 100), pressed(false, 9, 100), pressed(false, 3, 300), pressed(false, 9, 300)]).toEqual([null, "pan", "draw", "draw"]);
  expect([pressed(true, 3, 0), pressed(true, 5, 0), pressed(true, 3, 1000)]).toEqual([null, "draw", null]);
});

test("story 382: a slot's end takes the line of any start not ending there, a chat following the default that is this slot too; a Bot's end, its chats with a slot of their own; an archived slot's, none", () => {
  const sorted = (s: Set<string>) => [...s].sort();
  expect(sorted(comers(edit, "w/b"))).toEqual(["p", "p1", "p2", "q1", "r", "r1"]);
  expect(sorted(comers(edit, "w/a"))).toEqual(["p1", "p2", "q", "q1", "q2", "r", "r1"]);
  expect([sorted(comers(edit, "q")), sorted(comers(edit, "p")), sorted(comers(edit, "r")), sorted(comers(edit, "w/d"))]).toEqual([["q2"], ["p2"], [], []]);
});

test("stories 381, 382: a press grabs the nearest dot within 22px with somewhere to go; let go on what it can go to within 30px, or its node, it is the tap's change; elsewhere, nothing", () => {
  const v = view(edit, null, false, false, { base: edit });
  const dot = (k: string) => v.points.find((p) => (p.end ? "e:" : "s:") + p.of === k)!;
  const mid = (id: string) => ({ x: v.rects.get(id)!.x + v.rects.get(id)!.w / 2, y: v.rects.get(id)!.y + v.rects.get(id)!.h / 2 });
  const title = (id: string) => ({ x: v.rects.get(id)!.x + 30, y: v.rects.get(id)!.y + 12 });
  expect(grab(edit, v, dot("s:p1").x + 10, dot("s:p1").y + 10, 1)).toEqual({ of: "p1", end: false });
  expect(grab(edit, v, dot("e:w/b").x, dot("e:w/b").y - 20, 1)).toEqual({ of: "w/b", end: true });
  expect(grab(edit, v, dot("e:q").x, dot("e:q").y, 1)).toEqual({ of: "q", end: true });
  // r's end has no line to take: its start, 12px off, is grabbed; far from any, nothing; at half zoom, 44px reaches.
  expect(grab(edit, v, dot("e:r").x, dot("e:r").y, 1)).toEqual({ of: "r", end: false });
  expect(grab(edit, v, dot("s:p1").x + 30, dot("s:p1").y, 1)).toBeNull();
  expect(grab(edit, v, dot("s:p1").x + 30, dot("s:p1").y, 2)).toEqual({ of: "p1", end: false });

  // From a start: an end it can go to, near or by its node; the Bot's title for its end.
  const p1 = { of: "p1", end: false };
  expect(dropAt(edit, v, p1, dot("e:w/b").x - 25, dot("e:w/b").y, 1)).toBe("w/b");
  expect(dropAt(edit, v, p1, mid("w/a").x, mid("w/a").y, 1)).toBe("w/a");
  expect(dropAt(edit, v, p1, title("q").x, title("q").y, 1)).toBeNull();
  expect(dropAt(edit, v, { of: "p2", end: false }, title("p").x, title("p").y, 1)).toBe("p");
  expect(dropAt(edit, v, p1, -500, -500, 1)).toBeNull();
  expect(drop(edit, p1, "w/b")).toEqual({ edit: NONE, put: { of: "p1", to: "w/b" } });
  expect(drop(edit, { of: "p2", end: false }, "p")).toEqual({ edit: NONE, put: { of: "p2", to: null } });
  expect(drop(edit, p1, null)).toEqual({ edit: { sel: "p1", held: false, at: null } });

  // From an end: a start whose line can come, near or by its node.
  const wb = { of: "w/b", end: true };
  expect(dropAt(edit, v, wb, dot("s:p1").x, dot("s:p1").y + 20, 1)).toBe("p1");
  expect(dropAt(edit, v, wb, mid("p2").x, mid("p2").y, 1)).toBe("p2");
  expect(dropAt(edit, v, wb, title("p").x, title("p").y, 1)).toBe("p");
  expect(dropAt(edit, v, wb, mid("q2").x, mid("q2").y, 1)).toBeNull();
  expect(dropAt(edit, v, wb, mid("w/a").x, mid("w/a").y, 1)).toBeNull();
  expect(drop(edit, wb, "p1")).toEqual({ edit: NONE, put: { of: "p1", to: "w/b" } });
  expect(drop(edit, { of: "q", end: true }, "q2")).toEqual({ edit: NONE, put: { of: "q2", to: null } });
  expect(drop(edit, wb, null)).toEqual({ edit: NONE });
});

test("stories 381, 382: drawing from a start is its end in hand; from an end, the starts that can come light, glowing, the rest fading", () => {
  const v = view(edit, null, false, false, { base: edit });
  expect(grabbed({ of: "p1", end: false })).toEqual({ sel: "p1", held: true, at: null });
  const s = grabbed({ of: "q", end: true });
  expect(s).toEqual({ sel: null, held: false, at: "q", back: true });
  const l = editLit(edit, v, s)!;
  expect({ nodes: [...l.nodes].sort(), lines: [...l.lines], big: [...l.big], glow: [...l.glow] }).toEqual({ nodes: ["q", "q2"], lines: [], big: ["e:q"], glow: ["s:q2"] });
  const w = editLit(edit, v, grabbed({ of: "w/b", end: true }))!;
  expect([[...w.glow].sort(), [...w.nodes].sort()]).toEqual([["s:p", "s:p1", "s:p2", "s:q1", "s:r", "s:r1"], ["p", "p1", "p2", "q", "q1", "r", "r1", "w", "w/b"]]);
});

test("story 317: the columns are ordered by the bindings they were laid out by, not by those drawn: laid out again, by the new", () => {
  const g = graph({ a: [["a1", "private", "x/m"]], b: [["b1", "private", "y/m"]] }, [{ ref: "x/m" }, { ref: "y/m" }]);
  const order = (v: ReturnType<typeof view>) => ["a", "b", "x", "y"].toSorted((p, q) => v.rects.get(p)!.y - v.rects.get(q)!.y || p.localeCompare(q));
  const swapped = drafted(g, put(g, put(g, [], "a1", "y/m"), "b1", "x/m"));
  const before = view(g, null, false, false);
  expect(view(swapped, null, false, false, { laid: g.bindings }).rects).toEqual(before.rects);
  expect(order(view(swapped, null, false, false))).not.toEqual(order(before));
});

test("story 376: a line focused lights itself and what it carries on with: a Bot's line its followers' links, a link its Bot's line, a chat's own line alone; and the ends of those, every workspace closed", () => {
  const lit = (g: Graph, id: string) => [...view(g, { kind: "line", id }, false, false).litLines!].sort();
  expect(lit(large, "a")).toEqual(["bot:a", "link:a1", "link:a3"]);
  expect(lit(large, "a1")).toEqual(["bot:a", "link:a1"]);
  expect(lit(large, "a2")).toEqual(["own:a2"]);
  expect([...view(large, { kind: "line", id: "a1" }, false, false).lit!].sort()).toEqual(["a", "a1", "dispatcher", "dispatcher/main"]);
  every((g, f, wide, archived) => {
    if (f?.kind !== "line") return;
    const v = view(g, f, archived, wide);
    const ends = new Set(v.edges.filter((e) => v.litLines!.has(e.id)).flatMap((e) => [e.source, e.target]));
    for (const id of [...ends]) {
      const up = g.chats.find((c) => c.id === id)?.bot ?? g.slots.find((s) => s.id === id)?.workspace;
      if (up) ends.add(up);
    }
    expect([key(f), [...v.lit!].sort()]).toEqual([key(f), [...ends].sort()]);
    expect(v.nodes.some((n) => n.data.kind === "ws" && n.data.open)).toBe(false);
    // Opened on it, the first view has all it lights.
    for (const id of v.lit!) expect([id, inside(v.rects.get(id)!, v.box)]).toEqual([id, true]);
  });
});

test("story 376: a tap within 18px picks the nearest line, a thick one in a near tie; on the run a Bot's links share, the chat's below; never a spawn, nor a line that reaches no slot", () => {
  const lines: Line[] = [
    { kind: "bot", of: "B", reach: "s", sx: 0, sy: 0, tx: 0, ty: 0, pts: [[0, 0], [100, 0]] },
    { kind: "own", of: "C", reach: "s", sx: 0, sy: 20, tx: 0, ty: 0, pts: [[0, 20], [100, 20]] },
    { kind: "link", of: "D", reach: null, sx: 0, sy: 60, tx: 0, ty: 0, pts: [[0, 60], [100, 60]] },
    { kind: "spawn", sx: 0, sy: 90, tx: 100, ty: 90 },
  ];
  for (const ls of [lines, lines.toReversed()]) expect([pick(ls, 50, 10, 18), pick(ls, 50, 14, 18), pick(ls, 50, -17, 18), pick(ls, 50, -19, 18)]).toEqual(["B", "C", "B", null]);
  expect([pick(lines, 50, 60, 18), pick(lines, 50, 90, 18)]).toEqual([null, null]);
  // Bot a's private a1 and group a3 follow its default; their links meet on one run up into its end.
  const v = view(large, null, false, false);
  const ls = v.edges.map((e) => e.data!);
  const link = (c: string) => ls.find((l) => l.kind === "link" && l.of === c)!;
  const [x, end] = link("a1").pts!.at(-1)!;
  const [a1, a3] = [link("a1").sy, link("a3").sy];
  for (const order of [ls, ls.toReversed()]) expect([pick(order, x, (end + a1) / 2, 18), pick(order, x, (a1 + a3) / 2, 18), pick(order, x + 1, a3 - 2, 18)]).toEqual(["a1", "a3", "a3"]);
  // Each binding line is picked where it runs.
  for (const l of ls.filter((l) => l.kind === "bot" || l.kind === "own")) {
    const [p, q] = l.pts!.slice(-2);
    expect([l.of, pick(ls, (p![0] + q![0]) / 2, (p![1] + q![1]) / 2, 18)]).toEqual([l.of, l.of]);
  }
});

test("stories 376, 223, 243: a line's path is the overview then its slot; it goes to and from a Bot, a workspace or another line in place, to a slot as a step; its address is its start's", () => {
  const line = (id: string): Focus => ({ kind: "line", id });
  expect(trail(large, line("a1")).map((c) => c.label)).toEqual(["总览", "main"]);
  expect(trail(large, line("b")).at(-1)!.focus).toEqual(line("b"));
  expect([replaces(large, line("a"), line("b1")), replaces(large, { kind: "bot", id: "a" }, line("a")), replaces(large, line("a"), { kind: "ws", id: "shop" })]).toEqual([true, true, true]);
  expect([replaces(large, null, line("a")), replaces(large, line("a"), { kind: "slot", id: "dispatcher/main" })]).toEqual([false, false]);
  const r = { focus: line("a 1"), sel: true, chat: false };
  expect(routeHash(r)).toBe("#/topology/line/a%201");
  expect(readRoute(routeHash(r))).toEqual(r);
  // A Bot with no default has no line; a chat with no slot neither.
  const none = graph({ a: [["a1", "private", "x/m", true]] }, [{ ref: "x/m" }]);
  expect([known(none, line("a")), known(none, line("a1")), known(none, line("gone"))]).toEqual([null, line("a1"), null]);
  expect(known(large, line("a"))).toEqual(line("a"));
});
