// A holder unit throttled over its MemoryHigh (#692, architecture §4.2): how Rhodium tells it from the
// unit's memory.pressure, what the router keeps and tells you, what rh ls and the board say, and what is
// read off a real unit, one of the test's own with a small MemoryHigh.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard, type BoardData, type SlotData } from "../src/board";
import { loadConfig } from "../src/config";
import { blocked, fullPressure, programName, readUnit, watchMemory } from "../src/memory";
import type { Input } from "../src/contracts";
import { route, type Ctx, type Decision, type State } from "../src/router";
import { openStore, type Slot } from "../src/store";
import { BOARD_LOGIN, exec, newInstance, until } from "./instance";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-memory-blocked-"));
const prefix = `rhodium-test-${crypto.randomUUID().slice(0, 8)}-`;
afterAll(async () => {
  await exec(["systemctl", "--user", "stop", `${prefix}*`]);
  rmSync(dir, { recursive: true, force: true });
});
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
const config = loadConfig(join(dir, "config.toml"));
const now = Date.parse("2026-11-16T12:00:00Z");
const ctx: Ctx = {
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
  dropBot: () => {},
  inboundOf: () => [],
};
const G = 2 ** 30;

test("#692: memory.pressure's full line is read; blocked once full avg10 and avg60 are both at 40% or more, and till avg10 drops under 10%", () => {
  const text = "some avg10=91.20 avg60=70.01 avg300=26.60 total=95780172\nfull avg10=88.07 avg60=61.19 avg300=21.97 total=77208044\n";
  expect(fullPressure(text)).toEqual({ avg10: 88.07, avg60: 61.19 });
  expect(fullPressure("some avg10=1.00 avg60=0.00 avg300=0.00 total=1\n")).toBeNull();
  // A spike alone, or the last minute high with the last 10 s quiet, is not blocked.
  expect(blocked(false, { avg10: 95, avg60: 20 })).toBe(false);
  expect(blocked(false, { avg10: 20, avg60: 60 })).toBe(false);
  expect(blocked(false, { avg10: 40, avg60: 40 })).toBe(true);
  // Once blocked, it stays so till the last 10 s are nearly quiet, whatever the last minute says.
  expect(blocked(true, { avg10: 15, avg60: 70 })).toBe(true);
  expect(blocked(true, { avg10: 9.9, avg60: 70 })).toBe(false);
});

test("#692: a process goes by its program's name, node by the script it runs", () => {
  expect(programName(["/usr/bin/bun", "/tmp/gen.ts"])).toBe("bun");
  expect(programName(["/home/u/.nvm/versions/node/v22/bin/node", "/w/node_modules/.bin/vite", "build"])).toBe("vite");
  expect(programName(["node", "/w/node_modules/tsc/bin/tsc.js"])).toBe("tsc");
  expect(programName(["node", "--max-old-space-size=4096", "x.js"])).toBe("node");
  expect(programName(["/usr/bin/python3", "-c", "x"])).toBe("python3");
});

/** Headless slot w/a, running, its conversation c, as o has it; your private chat ch with bot q goes to it. */
function state(o: Partial<Slot> = {}): State {
  const a = { id: "a", workspace: "w", name: "a", dir: "/w", mode: "headless", state: "running", conversation: "c", parent: null, lifetime: "longterm", archivedAt: null, memBlocked: null, ...o };
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [a],
    conversations: [{ id: "c", slot: "a", agent: "claude", sessionId: "s", startedAt: 0, progress: null }],
    bots: [{ id: "q", platform: "qq", name: "q", isMain: 1, owners: JSON.stringify(["me"]), pairCode: null, pairUntil: null, pairAdd: null, defaultTarget: "a" }],
    chats: [{ id: "ch", bot: "q", platformChatId: "me", target: null, panel: null, verbose: null, contactedAt: null }],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [], typed: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
}
const told = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [JSON.parse(w.row.payload as string).text as string] : []));
const kept = (d: Decision) => d.writes.flatMap((w) => (w.op === "update" && w.table === "slot" ? [w.patch.memBlocked] : []));
const memory = (s: State, blocked: object | null) => route(s, { kind: "memory", slot: "a", blocked } as never, ctx);
const rh = (s: State, ...argv: string[]) => {
  const d = route(s, { kind: "rh", id: "r", caller: { token: null, pid: null, tty: true, cwd: "/" }, argv }, ctx);
  return (d.effects.find((e) => e.kind === "rh_reply") as { reply: { text: string } }).reply.text;
};

test("#692: a slot found blocked is kept so, with what its unit uses and its limit, and you hear once, by program name; again blocked, no word; free again, cleared, no word", () => {
  const top = [{ name: "bun", bytes: 3.1 * G }, { name: "vite", bytes: 0.6 * G }];
  const first = memory(state(), { current: 3.94 * G, high: 4 * G, top });
  expect(kept(first)).toEqual([JSON.stringify({ current: 3.94 * G, high: 4 * G })]);
  expect(first.events.map((e) => [e.type, e.slot, e.data])).toEqual([["memory_blocked", undefined, { slot: "a", current: 3.94 * G, high: 4 * G }]]);
  expect(told(first)).toEqual(["w/a 内存阻塞了，用了 3.9G，上限 4G。\n最占内存的是 bun 3.1G、vite 0.6G。\n内存降下来之前它停着，交给它的消息先排着，停止也不管用。要马上恢复，结束占内存的进程，或者调高上限。"]);
  // No PIDs, no command lines: none are given, and a small one goes in M.
  expect(told(memory(state(), { current: 3.9 * G, high: null, top: [{ name: "python3", bytes: 50 * 2 ** 20 }] }))).toEqual([
    "w/a 内存阻塞了，用了 3.9G。\n最占内存的是 python3 50M。\n内存降下来之前它停着，交给它的消息先排着，停止也不管用。要马上恢复，结束占内存的进程，或者调高上限。",
  ]);

  const was = JSON.stringify({ current: 3.94 * G, high: 4 * G });
  const again = memory(state({ memBlocked: was }), { current: 4 * G, high: 4 * G, top: [] });
  expect([kept(again), told(again)]).toEqual([[JSON.stringify({ current: 4 * G, high: 4 * G })], []]);
  const free = memory(state({ memBlocked: was }), null);
  expect([kept(free), told(free), free.events.map((e) => [e.type, e.data])]).toEqual([[null], [], [["memory_blocked", { slot: "a", current: null, high: null }]]]);
  expect(memory(state(), null)).toEqual({ writes: [], events: [], effects: [] });
});

test("#692: rh ls and /rh_ls say 内存阻塞 in a blocked slot's state; rh ls <slot> adds what its unit uses and its limit", () => {
  const s = state({ memBlocked: JSON.stringify({ current: 3.94 * G, high: 4 * G }) });
  expect(rh(s, "ls")).toContain("内存阻塞");
  const detail = rh(s, "ls", "w/a");
  expect(detail).toContain("状态: 内存阻塞\n");
  expect(detail).toContain("内存: 3.9G / 4G\n");
  expect(rh(state(), "ls", "w/a")).not.toContain("内存");
  // /rh_ls in IM names it too.
  const ls = route(s, { kind: "im", message: { bot: "q", chat: "me", messageId: "m", sender: "me", text: "/rh_ls", at: now } }, ctx);
  expect(told(ls).join("\n")).toContain("内存阻塞");
  // Stopped meanwhile, the mark is old news.
  expect(rh(state({ state: "off", memBlocked: JSON.stringify({ current: 3.94 * G, high: 4 * G }) }), "ls", "w/a")).toContain("状态: 未运行\n");
});

test("#692: on the board a blocked slot's card says 内存阻塞 and stays in its group; its 详情 has what its unit uses and its limit", async () => {
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, config).servers[0]!;
  try {
    const ids = store.tx((tx) => {
      const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
      const blocked = tx.insert("slot", { workspace: ws, name: "big", dir: "/w", mode: "headless", state: "running", lifetime: "longterm", memBlocked: JSON.stringify({ current: 3.94 * G, high: 4 * G }) }).id;
      const fine = tx.insert("slot", { workspace: ws, name: "fine", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
      return { blocked, fine };
    });
    const get = async <T>(path: string) => (await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as T;
    const w = (await get<BoardData>("/api/board")).workspaces[0]!;
    expect(w.groups.running.map((c) => [c.name, c.state])).toEqual([["big", "内存阻塞"], ["fine", "运行中"]]);
    expect((await get<SlotData>(`/api/slot?id=${ids.blocked}`)).memory).toBe("3.9G / 4G");
    expect(await get<SlotData>(`/api/slot?id=${ids.fine}`)).not.toHaveProperty("memory");
  } finally {
    server.stop(true);
    store.close();
  }
});

test("#692: a real unit's memory.pressure, what it uses, its MemoryHigh, and its processes by program name, the biggest first", async () => {
  const unit = `${prefix}mem`;
  const hog = "x = bytearray(48 << 20)\nfor i in range(0, len(x), 4096): x[i] = 1\nimport time; time.sleep(120)";
  const run = await exec(["systemd-run", "--user", "--collect", "--quiet", `--unit=${unit}`, "--property=MemoryHigh=256M", "python3", "-c", hog]);
  expect(run.code).toBe(0);
  let seen: Awaited<ReturnType<typeof readUnit>> = null;
  await until(async () => {
    seen = await readUnit(unit, true);
    return seen !== null && seen.current >= 48 << 20 && (seen.top[0]?.bytes ?? 0) >= 48 << 20;
  }, 10_000);
  expect(seen!.high).toBe(256 * 2 ** 20);
  expect(seen!.current).toBeGreaterThanOrEqual(48 << 20);
  expect(seen!.pressure).toEqual({ avg10: expect.any(Number), avg60: expect.any(Number) });
  expect(seen!.top[0]!.name).toBe("python3");
  expect(await readUnit(`${prefix}gone`, true)).toBeNull();
});

test("#692: a blocked unit whose programs cannot be read in one memoryLook is told without them, and the next looks still run", async () => {
  writeFileSync(join(dir, "look.toml"), `stateDir = "${dir}/look"\n[durations]\nmemoryLook = "100ms"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "look.db"));
  const slot = store.tx((tx) => {
    const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
    const id = tx.insert("slot", { workspace: ws, name: "a", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "claude", sessionId: "s", startedAt: 0 }).id;
    tx.update("slot", { id }, { conversation });
    tx.insert("holder", { conversation, unit: "u", proto: 1, outOffset: 0, outStart: 0, errStart: 0, stopRequested: 0, exited: 0 });
    return id;
  });
  const enqueued: Input[] = [];
  // Its pressure reads at once; its programs never do, as a cmdline read stuck on a throttled process.
  const read = (_unit: string, top = false) => (top ? new Promise<never>(() => {}) : Promise.resolve({ pressure: { avg10: 90, avg60: 90 }, current: 4 * G, high: 4 * G, top: [] }));
  const stop = watchMemory({ cfg: loadConfig(join(dir, "look.toml")), store, loop: { enqueue: (i) => enqueued.push(i), batch: () => {} }, read });
  try {
    // The loop here keeps nothing, so each look finds it newly blocked: two told means a later look ran.
    await until(() => enqueued.length >= 2, 3_000);
    expect(enqueued[0]).toEqual({ kind: "memory", slot, blocked: { current: 4 * G, high: 4 * G, top: [] } } as Input);
  } finally {
    stop();
    store.close();
  }
});

test("#692: the daemon looks at its holder units every durations.memoryLook: a slot kept blocked whose unit is not held up is free again", async () => {
  const rhodium = newInstance({ toml: '[durations]\nmemoryLook = "200ms"' });
  try {
    await rhodium.start();
    await rhodium.slots("a");
    await rhodium.ok("send", "w/a", "hi");
    await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
    const db = new Database(join(rhodium.dir, "state/rh.db"));
    try {
      db.run("PRAGMA busy_timeout = 5000"); // the daemon may be writing, as what the turn's end asked comes back
      db.run(`UPDATE slot SET memBlocked = '{"current":1,"high":2}'`);
      await until(() => (db.query("SELECT memBlocked FROM slot").get() as { memBlocked: string | null }).memBlocked === null, 5_000);
      expect(db.query("SELECT data FROM event WHERE type = 'memory_blocked'").all()).toEqual([{ data: expect.stringContaining('"current":null') }]);
    } finally {
      db.close();
    }
  } finally {
    await rhodium.cleanup();
  }
}, 30_000);
