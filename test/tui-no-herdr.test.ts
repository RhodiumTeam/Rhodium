// Without Herdr installed (product §4.2), rh tui, which /rh_tui and the board's 切到终端 are too, says
// so before it stops anything: the headless agent goes on (story 586).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type State } from "../src/router";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-tui-no-herdr-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const ctx = (herdr: boolean): Ctx => ({
  now: Date.parse("2026-11-06T12:00:00Z"),
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: loadConfig(join(dir, "config.toml")),
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => herdr,
  retarget: () => null,
  inboundOf: () => [],
});
// w/a's headless agent runs, idle: a switch would stop it first.
const state = {
  workspaces: [{ id: "w", name: "w", dir: "/w" }],
  slots: [{ id: "a", workspace: "w", name: "a", dir: "/w", mode: "headless", state: "idle", conversation: "c", parent: null, lifetime: "longterm", archivedAt: null, herdrPane: null, nextAgent: null }],
  conversations: [{ id: "c", slot: "a", agent: "claude", sessionId: "s", startedAt: 0, progress: null }],
  ...{ bots: [], chats: [], holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
  ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
} as unknown as State;
const tui = (herdr: boolean) => route(state, { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv: ["tui", "w/a"] }, ctx(herdr));

test("story 586: without Herdr, rh tui says so and does nothing: the headless agent is not stopped", () => {
  const d = tui(false);
  expect(d.effects).toEqual([{ kind: "rh_reply", id: "r", reply: { ok: false, error: "没装 Herdr，w/a 切不到 TUI。" } }]);
  expect(d.writes).toEqual([]);
  // With it, the agent goes first.
  expect(tui(true).effects.map((e) => e.kind)).toContain("stop");
});
