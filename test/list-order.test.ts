// The list's order (product §7, #506): what the router keeps as a slot's activity and its pin, and what
// the board's cards carry of them.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard, type BoardData } from "../src/board";
import { loadConfig } from "../src/config";
import { route, type Ctx, type Decision, type State } from "../src/router";
import { openStore, type Slot } from "../src/store";
import { BOARD_LOGIN } from "./instance";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-list-order-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n[durations]\noneoffArchive = "1h"\n`, { mode: 0o600 });
const config = loadConfig(join(dir, "config.toml"));
const HOUR = 3_600_000;
const now = Date.parse("2026-10-31T12:00:00Z");
const at: Ctx = {
  now,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config,
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  retarget: () => null,
  inboundOf: () => [],
};

/** Long-term slot w/a, its conversation c, as o has it. */
function state(o: Partial<Slot> = {}): State {
  const slot = { id: "a", workspace: "w", name: "a", dir: "/w", mode: "headless", state: "idle", conversation: "c", parent: null, lifetime: "longterm", archivedAt: null, turnEndedAt: null, turnStartedAt: null, activeAt: now - HOUR, ...o } as Slot;
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot],
    conversations: [{ id: "c", slot: "a", agent: "claude", sessionId: "s", startedAt: 0, progress: null }],
    ...{ bots: [], chats: [], holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
}
/** What d writes to slot a, and to a slot it makes. */
const slotPatch = (d: Decision) => Object.assign({}, ...d.writes.flatMap((w) => (w.op === "update" && w.table === "slot" ? [w.patch] : [])));
const made = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "slot" ? [w.row] : []));
const agent = (s: State, event: object) => route(s, { kind: "agent", event: { conv: "c", proc: 1, ...event } as never }, at);
const board = (s: State, act: object) => route(s, { kind: "board", id: crypto.randomUUID(), act: act as never }, at);
const rh = (s: State, ...argv: string[]) => route(s, { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv }, at);

test("#506: a slot is active as a turn starts or ends, stopped too, and as it is made or comes back from the archive; not as its agent talks mid-turn, nor as it is renamed", () => {
  const running = state({ state: "running", turnStartedAt: now - HOUR });
  expect(slotPatch(agent(state(), { type: "turn_start" })).activeAt).toBe(now);
  expect(slotPatch(agent(running, { type: "item", item: { kind: "message", text: "还在改" } }))).not.toHaveProperty("activeAt");
  expect(slotPatch(agent(running, { type: "turn_end" })).activeAt).toBe(now);
  expect(slotPatch(agent(running, { type: "exit", code: null, signal: "SIGTERM", from: "holder" })).activeAt).toBe(now);
  expect(slotPatch(rh(state(), "rename", "w/a", "b"))).not.toHaveProperty("activeAt");
  expect(made(rh(state(), "new", "w/b")).map((r) => r.activeAt)).toEqual([now]);
  const archived = state({ archivedAt: now - HOUR });
  expect(slotPatch(rh(archived, "unarchive", "w/a")).activeAt).toBe(now);
  expect(slotPatch(rh(archived, "send", "w/a", "hi")).activeAt).toBe(now);
  expect(slotPatch(board(archived, { kind: "say", slot: "a", text: "hi" })).activeAt).toBe(now);
  expect(slotPatch(board(state({ archivedAt: now - HOUR, state: "off" }), { kind: "common", slot: "a", name: "usage" })).activeAt).toBe(now);
  expect(slotPatch(rh({ ...archived, bots: [{ id: "b", name: "t", defaultTarget: null }] } as State, "bind", "t", "w/a")).activeAt).toBe(now);
});

test("#506: 置顶 on the board pins a slot, by when; 取消置顶 unpins it", () => {
  const pin = board(state(), { kind: "pin", slot: "a", on: true });
  expect(slotPatch(pin)).toEqual({ pinnedAt: now });
  expect(pin.effects).toContainEqual({ kind: "rh_reply", id: expect.any(String), reply: { ok: true, text: "已置顶 w/a。" } });
  const unpin = board(state({ pinnedAt: now - HOUR }), { kind: "pin", slot: "a", on: false });
  expect(slotPatch(unpin)).toEqual({ pinnedAt: null });
  expect(unpin.effects).toContainEqual({ kind: "rh_reply", id: expect.any(String), reply: { ok: true, text: "已取消置顶 w/a。" } });
});

test("#506: a card says when its slot was last active, as kept; with no turn running, or kept from before, its turn's end or the last thing said if later; and when it was pinned. Its turn ended under 24 h ago it is done, whatever the archive clock", async () => {
  const home = process.env.HOME;
  process.env.HOME = dir; // the transcripts written below
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, config);
  try {
    const t = Date.now();
    store.tx((tx) => {
      const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
      const slot = (name: string, o: Partial<Slot>, said?: number) => {
        const id = tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", ...o }).id;
        if (said === undefined) return;
        const session = crypto.randomUUID();
        const file = join(dir, ".claude/projects/-w", `${session}.jsonl`);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, JSON.stringify({ type: "assistant", uuid: session, timestamp: new Date(said).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) + "\n");
        tx.update("slot", { id }, { conversation: tx.insert("conversation", { slot: id, agent: "claude", sessionId: session, startedAt: 0 }).id });
      };
      slot("kept", { state: "running", activeAt: t - 5 * HOUR, turnStartedAt: t - 5 * HOUR }, t - HOUR);
      slot("back", { activeAt: t - 72 * HOUR, turnEndedAt: t - 23 * HOUR }, t - HOUR); // said in the terminal since
      slot("term", { mode: "tui", activeAt: t - 5 * HOUR }, t - HOUR);
      slot("old", { turnEndedAt: t - 25 * HOUR }, t - 2 * HOUR);
      slot("ended", { turnEndedAt: t - 26 * HOUR });
      slot("never", { pinnedAt: 7 });
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
    const w = ((await r.json()) as BoardData).workspaces[0]!;
    const cards = Object.entries(w.groups).flatMap(([g, cs]) => cs.map((c) => [c.name, g, c.activeAt && (t - c.activeAt) / HOUR, c.pinnedAt]));
    expect(cards.toSorted()).toEqual([
      ["back", "done", 1, null],
      ["ended", "idle", 26, null],
      ["kept", "running", 5, null],
      ["never", "idle", 0, 7],
      ["old", "idle", 2, null],
      ["term", "running", 1, null],
    ]);
  } finally {
    server.stop(true);
    store.close();
    process.env.HOME = home;
    rmSync(dir, { recursive: true, force: true });
  }
});
