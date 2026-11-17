// A slot in the terminal has no driver to ask: the board reads its context, and Codex's quota, off its
// transcript (story 658, architecture §7.11). Seen through /api/slot of a board over a store of its own.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard, type Hear, type SlotData } from "../src/board";
import { loadConfig } from "../src/config";
import { openStore, type Store } from "../src/store";

const FIXTURES = join(import.meta.dir, "fixtures/transcripts");
const LOGIN = "you@example.com";
const THREAD = "01a17c7e-0000-7000-8000-0000000000aa";
const CLAUDE = "00000000-0000-4000-8000-645e563d4553";
const home = mkdtempSync(join(tmpdir(), "rhodium-test-meter-"));
const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
let store: Store;
let server: ReturnType<typeof serveBoard>["servers"][number];
const ids: Record<string, string> = {};
/** The meter events the board pushed through hearing, as [conversation, agent]. */
const told: [string, string][] = [];
const convs: Record<string, string> = {};

beforeAll(() => {
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const codex = join(home, ".codex/sessions/2026/01/01");
  mkdirSync(codex, { recursive: true });
  copyFileSync(join(FIXTURES, "codex/thread.jsonl"), join(codex, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`));
  const claude = join(home, ".claude/projects/-w");
  mkdirSync(claude, { recursive: true });
  copyFileSync(join(FIXTURES, `claude/${CLAUDE}.jsonl`), join(claude, `${CLAUDE}.jsonl`));
  writeFileSync(join(home, "config.toml"), `stateDir = "${home}/state"\n[programs]\nherdr = "/bin/false"\n[board]\nport = 0\nlogin = "${LOGIN}"\n`, { mode: 0o600 });
  store = openStore(join(home, "rh.db"));
  store.tx((tx) => {
    const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
    for (const [name, agent, session, meter] of [
      ["x", "codex", THREAD, null],
      // Heard while headless, before it went to the terminal: its limit stays.
      ["k", "claude", CLAUDE, JSON.stringify({ context: { usedTokens: 1, maxTokens: 200_000, at: 1 } })],
    ] as const) {
      const s = tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "tui", state: "idle", lifetime: "longterm", herdrPane: "p1" });
      const c = tx.insert("conversation", { slot: s.id, agent, sessionId: session, startedAt: 1, meter });
      tx.update("slot", { id: s.id }, { conversation: c.id });
      ids[name] = s.id;
      convs[name] = c.id;
    }
    // Two buckets heard before: the transcript's replaces codex's window alone.
    const luna = { window: "5h", model: "GPT-6-Luna", usedPercent: 50, resetsAt: 1, limitId: "codex_luna" };
    tx.insert("meta", { id: "quota.codex", value: JSON.stringify({ limits: [{ window: "7d", usedPercent: 10, resetsAt: 1, limitId: "codex" }, luna], credits: 5, at: 1 }) });
  });
  const tell: Hear = (conversation, e) => void (e.type === "meter" && told.push([conversation, e.agent]));
  server = serveBoard(store, loadConfig(join(home, "config.toml")), new Set([tell]), join(home, "web")).servers[0]!;
});
afterAll(() => {
  server.stop(true);
  store.close();
  Object.assign(process.env, saved);
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

const slot = async (id: string) => (await (await fetch(`http://127.0.0.1:${server.port}/api/slot?id=${id}`, { headers: { "Tailscale-User-Login": LOGIN } })).json()) as SlotData;
/** The newest line of a fixture that pick takes, parsed: its times are synthesis's, so read, not written here. */
const newest = (file: string, pick: (v: any) => boolean) => readFileSync(join(FIXTURES, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).findLast(pick);
const count = newest("codex/thread.jsonl", (v) => v.payload?.type === "token_count" && v.payload.info);
const at = Date.parse(count.timestamp);

test("story 658: a Codex slot in the terminal has the context of its transcript's last token_count, and the quota of its rate_limits over that bucket's windows alone, the other bucket's kept; live, as the terminal runs it", async () => {
  const s = await slot(ids.x!);
  expect(s.live).toBe(true);
  expect(s.meter.context).toEqual({ usedTokens: 17_532, maxTokens: 258_400, at });
  expect(s.meter.quota).toEqual({
    limits: [
      { window: "7d", usedPercent: 35, resetsAt: count.payload.rate_limits.primary.resets_at * 1000, limitId: "codex" },
      { window: "5h", model: "GPT-6-Luna", usedPercent: 50, resetsAt: 1, limitId: "codex_luna" },
    ],
    credits: 1000,
    at,
  });
  // Every stream hears of what it recorded (architecture §7.11).
  expect(told).toEqual([[convs.x!, "codex"]]);
});

test("story 658: a quota heard after the transcript's line is not replaced by it", async () => {
  const newer = { limits: [{ window: "7d" as const, usedPercent: 60, resetsAt: 2, limitId: "codex" }], at: at + 1 };
  store.tx((tx) => tx.update("meta", { id: "quota.codex" }, { value: JSON.stringify(newer) }));
  expect((await slot(ids.x!)).meter.quota).toEqual(newer);
  // Nothing newer recorded, nothing told.
  expect(told).toHaveLength(1);
});

test("story 658: a Claude slot in the terminal has its transcript's context out of the limit heard before, and the Codex quota is not its", async () => {
  const s = await slot(ids.k!);
  expect(s.meter).toEqual({ context: { usedTokens: 28_687, maxTokens: 200_000, at: Date.parse(newest(`claude/${CLAUDE}.jsonl`, (v) => v.message?.role === "assistant" && v.message.usage && !v.isSidechain).timestamp) }, session: null, quota: null });
});
