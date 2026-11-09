// A command that starts the agent of a slot not running (product §5.6) is no turn's end (#489): the
// board's 完成 and a one-off slot's archive clock go by the last turn's end; the reap clock by the start.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type Decision, type State } from "../src/router";
import type { Slot } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-command-start-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const config = loadConfig(join(dir, "config.toml"));
const HOUR = 3_600_000;
const at = (now: number): Ctx => ({
  now,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config,
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => true,
  retarget: () => null,
  inboundOf: () => [],
});
const now = Date.parse("2026-10-30T12:00:00Z");
const reap = config.durations.idleReap;

/** One-off slot a, its agent off, its last turn over 17 hours ago. */
function state(o: Partial<Slot> = {}): State {
  const slot = { id: "a", workspace: "w", name: "a", dir: "/w", mode: "headless", state: "off", conversation: "c", parent: null, lifetime: "oneoff", archivedAt: null, turnEndedAt: now - 17 * HOUR, ...o } as Slot;
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot],
    conversations: [{ id: "c", slot: "a", agent: "claude", sessionId: "s", startedAt: 0, progress: null }],
    ...{ bots: [], chats: [], holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
}
const slotPatch = (d: Decision) => Object.assign({}, ...d.writes.flatMap((w) => (w.op === "update" && w.table === "slot" ? [w.patch] : [])));
const timers = (d: Decision) => d.effects.flatMap((e) => (e.kind === "timer" ? [[e.timer, e.at]] : []));

test("#489: /usage from the board starts the agent idle, ends no turn, and the reap clock runs from the start", () => {
  const d = route(state(), { kind: "board", id: "r", act: { kind: "common", slot: "a", name: "usage" } }, at(now));
  expect(d.effects.filter((e) => e.kind !== "timer").map((e) => e.kind)).toEqual(["start", "command"]);
  const patch = slotPatch(d);
  expect(patch).toMatchObject({ state: "idle" });
  expect(patch).not.toHaveProperty("turnEndedAt");
  expect(timers(d)).toEqual([["idle_reap", now + reap]]); // no archive clock: that goes by the last turn

  // Rhodium restarted meanwhile, the clock asks again: not yet, though the last turn ended long before.
  const started = state(patch);
  expect(route(started, { kind: "clock", timer: "idle_reap", key: "a" }, at(now + reap - 1)).effects).toEqual([{ kind: "timer", timer: "idle_reap", key: "a", at: now + reap }]);
  expect(route(started, { kind: "clock", timer: "idle_reap", key: "a" }, at(now + reap)).effects).toContainEqual({ kind: "stop", conversation: "c" });
});

test("#489: an agent that could not start, its conversation in use elsewhere, ends no turn", () => {
  const d = route(state({ state: "starting" }), { kind: "agent", event: { type: "exit", conv: "c", proc: 1, code: null, signal: null, from: "holder", busy: "in use" } }, at(now));
  expect(slotPatch(d)).toMatchObject({ state: "off" });
  expect(slotPatch(d)).not.toHaveProperty("turnEndedAt");
});

test("#489: /usage to an archived one-off slot unarchives it, and its archive clock starts over", () => {
  const d = route(state({ archivedAt: now - HOUR }), { kind: "board", id: "r", act: { kind: "common", slot: "a", name: "usage" } }, at(now));
  expect(slotPatch(d)).toMatchObject({ archivedAt: null, turnEndedAt: now });
  expect(timers(d)).toContainEqual(["oneoff_archive", now + config.durations.oneoffArchive]);
});

test("#578: /usage to an archived one-off slot whose last agent wrote past limits.outRestartMB: the reap clock, going off at once, leaves the new agent be", () => {
  const d = route(state({ archivedAt: now - HOUR }), { kind: "board", id: "r", act: { kind: "common", slot: "a", name: "usage" } }, at(now));
  expect(timers(d)).toContainEqual(["idle_reap", now]);
  // The clock as the command left the slot, the last agent's row not yet replaced by the new one's.
  const started = { ...state(slotPatch(d)), holders: [{ conversation: "c", exited: 1, stopRequested: 0, outStart: 0, outOffset: 65 * 2 ** 20 }] } as unknown as State;
  const tick = route(started, { kind: "clock", timer: "idle_reap", key: "a" }, at(now));
  expect(tick.effects.map((e) => e.kind)).not.toContain("stop");
});
