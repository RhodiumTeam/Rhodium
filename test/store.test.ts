import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openStore, schemaOf, ulid, type Event, type Insert, type Tables } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshPath = () => join(dir, `db-${n++}`, "rh.db");

const now = 1_760_000_000_000;

// One row per table in docs/spec/v1.md "数据表", plus meta.
// The mapped type makes tsc fail when a table has no sample.
const samples: { [T in keyof Tables]: Insert<Tables[T]> } = {
  workspace: { name: "stock", dir: "/home/u/stock" },
  slot: {
    workspace: "W",
    name: "dispatcher",
    dir: "/home/u/notes",
    mode: "headless",
    state: "idle",
    lifetime: "longterm",
    askTimeout: 60_000,
  },
  conversation: { slot: "S", agent: "claude", sessionId: "c0ffee", startedAt: now },
  holder: { conversation: "C", unit: "rh-hold-C", proto: 1, outOffset: 0, outStart: 0, errStart: 0, stopRequested: 0, exited: 0 },
  agentInput: { conversation: "C", source: "human", status: "queued", body: "hi", queueReason: "tui" },
  bot: { platform: "qq", name: "main", isMain: 1 },
  chat: { bot: "B", platformChatId: "openid-1" },
  inbound: { chat: "CH", platformMsgId: "m1", trace: "T", sender: "openid-1", receivedAt: now, text: "原文" },
  outbound: { chat: "CH", status: "pending", createdAt: now, payload: '{"text":"hi"}', qqSeq: 7 },
  ask: { slot: "S", kind: "question", requestId: "r1", status: "open", deadline: now + 1 },
  quota: { kind: "qq_passive", owner: "IN", used: 1, resetsAt: now },
  meta: { id: "boot", value: "1" },
};

test("a new database has every spec table, each row gets a ULID and the machine name", () => {
  const store = openStore(freshPath(), { machine: "myhost" });
  for (const [table, row] of Object.entries(samples) as [keyof Tables, Insert<Tables[keyof Tables]>][]) {
    const saved = store.tx((tx) => tx.insert(table, row));
    expect(saved).toMatchObject({ ...row, machine: "myhost" });
    if (table !== "meta") expect(saved.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.tx((tx) => tx.get(table, saved.id))).toEqual(saved);
  }
  expect(store.tx((tx) => tx.append({ source: "rh", type: "probe" }))).toBe(1);
  store.close();
});

test("columns left out of an insert read back as null", () => {
  const store = openStore(freshPath());
  const ws = store.tx((tx) => tx.insert("workspace", { name: "a", dir: "/a" }));
  expect(ws.herdrWorkspace).toBeNull();
  store.close();
});

test("reopening keeps the data and does not rebuild the tables", () => {
  const path = freshPath();
  const first = openStore(path);
  const ws = first.tx((tx) => tx.insert("workspace", { name: "keep", dir: "/k" }));
  first.tx((tx) => tx.append({ source: "rh", type: "made" }));
  first.close();

  const again = openStore(path);
  expect(again.tx((tx) => tx.get("workspace", ws.id))).toEqual(ws);
  expect(again.events(0).map((e) => e.type)).toEqual(["made"]);
  expect(again.tx((tx) => tx.append({ source: "rh", type: "next" }))).toBe(2);
  again.close();
});

test("#276: a slot on the old ultracode level reopens on xhigh with ultracode on; any other level is left alone", () => {
  const path = freshPath();
  const first = openStore(path);
  first.tx((tx) => {
    tx.insert("slot", { ...samples.slot, id: "A", name: "a", effort: "ultracode" });
    tx.insert("slot", { ...samples.slot, id: "B", name: "b", effort: "high" });
  });
  first.close();
  // The database as the release before left it.
  const db = new Database(path);
  db.run("ALTER TABLE slot DROP COLUMN ultracode");
  db.run("ALTER TABLE bot DROP COLUMN rowHash"); // #300's, after it
  db.run("ALTER TABLE slot DROP COLUMN turnStartedAt"); // #329's, after that
  beforeOwners(db); // #449's, after that
  db.run(`PRAGMA user_version = ${schemaOf(path) - 8}`);
  db.close();

  const again = openStore(path);
  expect(again.tx((tx) => tx.find("slot", {})).map((s) => [s.effort, s.ultracode])).toEqual([["xhigh", 1], ["high", null]]);
  again.close();
});

test("#300: a bot from the release before keeps the hash of its / menu and has none of a row, so its row goes out once", () => {
  const path = freshPath();
  const first = openStore(path);
  first.tx((tx) => void tx.insert("bot", { platform: "qq", name: "q", isMain: 0, menuHash: "h" }));
  first.close();
  const db = new Database(path);
  db.run("ALTER TABLE bot DROP COLUMN rowHash");
  db.run("ALTER TABLE slot DROP COLUMN turnStartedAt"); // #329's, after it
  beforeOwners(db); // #449's, after that
  db.run(`PRAGMA user_version = ${schemaOf(path) - 7}`);
  db.close();

  const again = openStore(path);
  expect(again.tx((tx) => tx.find("bot", {})).map((b) => [b.menuHash, b.rowHash])).toEqual([["h", null]]);
  again.close();
});

/** Takes #449's migration back: a bot's one ownerId, no list of owners. And #489's, #506's, #593's and #601's, after it. */
function beforeOwners(db: Database): void {
  db.run("ALTER TABLE bot ADD COLUMN ownerId TEXT");
  for (const col of ["owners", "pairAdd"]) db.run(`ALTER TABLE bot DROP COLUMN ${col}`);
  for (const col of ["startedIdleAt", "activeAt", "pinnedAt", "webAt", "turnToldYou", "turnPlanTimedOut"]) db.run(`ALTER TABLE slot DROP COLUMN ${col}`);
}

test("#506: a slot from the release before was last active as its turn began, running, else as its last turn ended; one that never ran, never; none is pinned", () => {
  const path = freshPath();
  const first = openStore(path);
  first.tx((tx) => {
    tx.insert("slot", { ...samples.slot, id: "R", name: "r", state: "running", turnStartedAt: 5, turnEndedAt: 3 });
    tx.insert("slot", { ...samples.slot, id: "I", name: "i", turnEndedAt: 4 });
    tx.insert("slot", { ...samples.slot, id: "N", name: "n" });
  });
  first.close();
  const db = new Database(path);
  for (const col of ["activeAt", "pinnedAt", "webAt", "turnToldYou", "turnPlanTimedOut"]) db.run(`ALTER TABLE slot DROP COLUMN ${col}`);
  db.run(`PRAGMA user_version = ${schemaOf(path) - 3}`);
  db.close();

  const again = openStore(path);
  expect(again.tx((tx) => tx.find("slot", {})).map((s) => [s.id, s.activeAt, s.pinnedAt])).toEqual([["I", 4, null], ["N", null, null], ["R", 5, null]]);
  again.close();
});

test("#449: a bot's one owner from the release before is its one paired owner; Telegram's hashes of what was pushed are kept by that owner's chat", () => {
  const path = freshPath();
  const first = openStore(path);
  first.tx((tx) => {
    tx.insert("bot", { id: "T", platform: "telegram", name: "t", isMain: 0, menuHash: "m", rowHash: "r" });
    tx.insert("bot", { id: "Q", platform: "qq", name: "q", isMain: 0, menuHash: "m" });
    tx.insert("bot", { id: "N", platform: "qq", name: "n", isMain: 0 });
  });
  first.close();
  const db = new Database(path);
  beforeOwners(db);
  db.run("UPDATE bot SET ownerId = 'you' WHERE id IN ('T', 'Q')");
  db.run(`PRAGMA user_version = ${schemaOf(path) - 5}`);
  db.close();

  const again = openStore(path);
  expect(again.tx((tx) => tx.find("bot", {})).map((b) => [b.id, b.owners, b.menuHash, b.rowHash])).toEqual([
    ["N", null, null, null],
    ["Q", '["you"]', "m", null],
    ["T", '["you"]', '{"you":"m"}', '{"you":"r"}'],
  ]);
  expect(again.tx((tx) => tx.get("bot", "T"))).not.toHaveProperty("ownerId");
  again.close();
});

test("the database file is private to the user", () => {
  const path = freshPath();
  openStore(path).close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a state change and its event commit together", () => {
  const store = openStore(freshPath());
  const seen: Event[] = [];
  store.subscribe(0, (e) => seen.push(e));
  const ws = store.tx((tx) => {
    const ws = tx.insert("workspace", { name: "w", dir: "/w" });
    tx.append({ source: "rh", type: "workspace_created", trace: "T1", data: { id: ws.id } });
    return ws;
  });
  expect(store.tx((tx) => tx.get("workspace", ws.id))).not.toBeNull();
  expect(seen).toMatchObject([{ seq: 1, source: "rh", type: "workspace_created", trace: "T1", data: { id: ws.id } }]);
  store.close();
});

test("a rolled-back transaction leaves neither the state change nor the event", () => {
  const store = openStore(freshPath());
  const seen: Event[] = [];
  store.subscribe(0, (e) => seen.push(e));
  expect(() =>
    store.tx((tx) => {
      tx.insert("workspace", { name: "gone", dir: "/g" });
      tx.append({ source: "rh", type: "workspace_created" });
      throw new Error("router failed");
    }),
  ).toThrow("router failed");
  expect(store.tx((tx) => tx.find("workspace", { name: "gone" }))).toEqual([]);
  expect(store.events(0)).toEqual([]);
  expect(seen).toEqual([]);
  expect(store.tx((tx) => tx.append({ source: "rh", type: "after" }))).toBe(1);
  store.close();
});

test("an async transaction body is refused and rolled back", () => {
  const store = openStore(freshPath());
  expect(() =>
    store.tx(async (tx) => {
      tx.insert("workspace", { name: "async", dir: "/a" });
    }),
  ).toThrow();
  expect(store.tx((tx) => tx.find("workspace", {}))).toEqual([]);
  store.close();
});

test("event seqs rise globally and a subscriber resumes after a given seq", () => {
  const path = freshPath();
  const store = openStore(path);
  for (const type of ["a", "b", "c"]) store.tx((tx) => tx.append({ source: "clock", type }));
  store.tx((tx) => {
    tx.append({ source: "im", type: "d" });
    tx.append({ source: "im", type: "e", slot: "S" });
  });
  expect(store.events(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

  const seen: string[] = [];
  const stop = store.subscribe(2, (e) => seen.push(`${e.seq}${e.type}`));
  expect(seen).toEqual(["3c", "4d", "5e"]);
  store.tx((tx) => tx.append({ source: "agent", type: "f" }));
  expect(seen).toEqual(["3c", "4d", "5e", "6f"]);
  stop();
  store.tx((tx) => tx.append({ source: "agent", type: "g" }));
  expect(seen).toHaveLength(4);
  store.close();

  // After a restart, a client that saw up to 6 picks up 7 and nothing else.
  const again = openStore(path);
  const later: number[] = [];
  again.subscribe(6, (e) => later.push(e.seq));
  expect(later).toEqual([7]);
  again.close();
});

test("events appended by a subscriber are delivered in order", () => {
  const store = openStore(freshPath());
  const seen: string[] = [];
  store.subscribe(0, (e) => {
    seen.push(e.type);
    if (e.type === "a") store.tx((tx) => tx.append({ source: "rh", type: "c" }));
  });
  store.tx((tx) => {
    tx.append({ source: "rh", type: "a" });
    tx.append({ source: "rh", type: "b" });
  });
  expect(seen).toEqual(["a", "b", "c"]);
  store.close();
});

test("a failing subscriber does not turn a committed transaction into an error", () => {
  const store = openStore(freshPath());
  store.subscribe(0, () => {
    throw new Error("client went away");
  });
  const seen: string[] = [];
  store.subscribe(0, (e) => seen.push(e.type));
  expect(store.tx((tx) => tx.append({ source: "rh", type: "x" }))).toBe(1);
  expect(seen).toEqual(["x"]);
  store.close();
});

test("subscribing inside a transaction is refused, so nobody sees events that may roll back", () => {
  const store = openStore(freshPath());
  const seen: string[] = [];
  expect(() =>
    store.tx((tx) => {
      tx.append({ source: "rh", type: "ghost" });
      store.subscribe(0, (e) => seen.push(e.type));
    }),
  ).toThrow(/transaction/);
  expect(seen).toEqual([]);
  expect(store.events(0)).toEqual([]);
  store.close();
});

test("another process holding the write lock a moment, say one reading rh.db, makes a transaction that reads then writes wait for it, not fail", async () => {
  const path = freshPath();
  const store = openStore(path);
  const other = Bun.spawn(
    [process.execPath, "-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(path)}); db.run("BEGIN IMMEDIATE"); console.log("locked"); await Bun.sleep(300); db.run("COMMIT");`],
    { stdout: "pipe" },
  );
  await other.stdout.getReader().read(); // "locked"
  const id = store.tx((tx) => {
    tx.find("workspace", {});
    return tx.insert("workspace", samples.workspace).id;
  });
  expect(store.tx((tx) => tx.get("workspace", id))).not.toBeNull();
  expect(await other.exited).toBe(0);
  store.close();
});

test("the same chat and platform message id can only be stored once", () => {
  const store = openStore(freshPath());
  const msg = { chat: "CH", platformMsgId: "m1", trace: "T", sender: "u", receivedAt: now };
  store.tx((tx) => tx.insert("inbound", msg));
  expect(() => store.tx((tx) => tx.insert("inbound", { ...msg, trace: "T2" }))).toThrow();
  expect(store.tx((tx) => tx.insert("inbound", { ...msg, chat: "CH2" }))).toBeTruthy();
  store.close();
});

test("a conditional update lets only the first answer in", () => {
  const store = openStore(freshPath());
  const ask = store.tx((tx) => tx.insert("ask", { slot: "S", kind: "permission", status: "open" }));
  const answer = (by: string) =>
    store.tx((tx) => tx.update("ask", { id: ask.id, answeredBy: null }, { answeredBy: by, status: "answered" }));
  expect(answer("qq")).toBe(1);
  expect(answer("timeout")).toBe(0);
  expect(store.tx((tx) => tx.get("ask", ask.id))).toMatchObject({ answeredBy: "qq", status: "answered" });
  store.close();
});

test("find filters by equality and null, delete removes matching rows", () => {
  const store = openStore(freshPath());
  store.tx((tx) => {
    tx.insert("slot", { workspace: "W", name: "a", dir: "/a", mode: "headless", state: "idle", lifetime: "longterm" });
    tx.insert("slot", { workspace: "W", name: "b", dir: "/b", mode: "tui", state: "idle", lifetime: "oneoff", parent: "P" });
    tx.insert("slot", { workspace: "X", name: "a", dir: "/c", mode: "headless", state: "idle", lifetime: "longterm" });
  });
  const names = (where: object) => store.tx((tx) => tx.find("slot", where).map((s) => `${s.workspace}/${s.name}`));
  expect(names({ workspace: "W" }).sort()).toEqual(["W/a", "W/b"]);
  expect(names({ parent: null }).sort()).toEqual(["W/a", "X/a"]);
  expect(store.tx((tx) => tx.delete("slot", { workspace: "W", name: "b" }))).toBe(1);
  expect(names({}).sort()).toEqual(["W/a", "X/a"]);
  store.close();
});

test("update and delete refuse an empty filter instead of touching every row", () => {
  const store = openStore(freshPath());
  store.tx((tx) => tx.insert("workspace", { name: "a", dir: "/a" }));
  expect(() => store.tx((tx) => tx.delete("workspace", {}))).toThrow();
  expect(() => store.tx((tx) => tx.update("workspace", {}, { dir: "/b" }))).toThrow();
  expect(store.tx((tx) => tx.find("workspace", {}))).toHaveLength(1);
  store.close();
});

test("a ULID starts with the time it was made, in Crockford base32", () => {
  const before = Date.now();
  const id = ulid();
  const after = Date.now();
  expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  const time = [...id.slice(0, 10)].reduce((t, c) => t * 32 + "0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(c), 0);
  expect(time).toBeGreaterThanOrEqual(before);
  expect(time).toBeLessThanOrEqual(after);
});

test("ULIDs made one after another strictly increase, even within one millisecond", () => {
  const ids = Array.from({ length: 1000 }, () => ulid());
  expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBeLessThan(ids.length); // some share a ms
  for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
});

test("agent inputs queued in one transaction read back in the order they were queued", () => {
  const store = openStore(freshPath());
  const bodies = Array.from({ length: 50 }, (_, i) => `msg ${i}`);
  store.tx((tx) => {
    for (const body of bodies) tx.insert("agentInput", { conversation: "C", source: "human", status: "queued", body });
  });
  expect(store.tx((tx) => tx.find("agentInput", { conversation: "C" }).map((r) => r.body))).toEqual(bodies);
  store.close();
});

test("once an input is written its text can be cleared, and a sent message's payload too", () => {
  const store = openStore(freshPath());
  const input = store.tx((tx) =>
    tx.insert("agentInput", { conversation: "C", source: "human", status: "writing", body: "secret" }),
  );
  store.tx((tx) => tx.update("agentInput", { id: input.id, status: "writing" }, { status: "written", body: null }));
  expect(store.tx((tx) => tx.get("agentInput", input.id))).toMatchObject({ status: "written", body: null });

  const out = store.tx((tx) =>
    tx.insert("outbound", { chat: "CH", status: "sending", createdAt: now, payload: '{"text":"hi"}' }),
  );
  store.tx((tx) => tx.update("outbound", { id: out.id }, { status: "sent", payload: null }));
  expect(store.tx((tx) => tx.get("outbound", out.id))).toMatchObject({ status: "sent", payload: null });
  store.close();
});
