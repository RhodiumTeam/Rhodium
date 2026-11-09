// Your quote of another slot's rh send to you, led by its name, goes to that slot (product §5.3, story 589),
// seen from the router: a common command goes as ever, and an ask pushed here does not take it.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type State } from "../src/router";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-quoted-route-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const now = Date.parse("2026-11-06T12:00:00Z");
const ctx: Ctx = {
  now,
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: loadConfig(join(dir, "config.toml")),
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => false,
  retarget: () => null,
  inboundOf: () => [],
};
const slot = (id: string) => ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "idle", conversation: `c${id}`, parent: null, lifetime: "longterm", archivedAt: null, herdrPane: null, nextAgent: null });
// The chat goes to w/a; the message quoted is w/b's rh send, led by its name. w/c has an ask pushed here.
const state = (asks: unknown[] = []) =>
  ({
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot("a"), slot("b"), slot("c")],
    conversations: ["a", "b", "c"].map((s) => ({ id: `c${s}`, slot: s, agent: "claude", sessionId: s, startedAt: 0, progress: null })),
    bots: [{ id: "q", platform: "qq", name: "q", isMain: 1, owners: JSON.stringify(["me"]), pairCode: null, pairUntil: null, pairAdd: null, defaultTarget: "a" }],
    chats: [{ id: "ch", bot: "q", platformChatId: "me", target: null, panel: null, verbose: null, contactedAt: null }],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks, listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: { text: "〔w/b〕\nwhich snapshot?", slot: "b" }, seen: false, begun: null, models: {}, modelInfo: {} },
  }) as unknown as State;
const ask = { id: "k", slot: "c", kind: "question", status: "open", forwardedTo: "ch", pushedAt: now, prompt: JSON.stringify({ questions: [{ question: "?", options: [] }] }) };
/** Your message, quoting w/b's unless quote is false. */
const im = (text: string, s: State, quote = true) =>
  route(s, { kind: "im", message: { bot: "q", chat: "me", messageId: "m", sender: "me", text, at: now, ...(quote && { quote: { ref: "r" } }) } }, ctx);
/** The slot your message went to. */
const to = (text: string, s = state(), quote = true) =>
  (im(text, s, quote).writes.find((w) => w.op === "insert" && w.table === "inbound") as { row: { route: string | null } }).row.route;

test("story 589: a quote of w/b's rh send goes to w/b, past an ask pushed here; a common command quoting it, a bare ! too, goes to w/a", () => {
  expect(to("the old one")).toBe("b");
  expect(to("the old one", state([ask]))).toBe("b");
  expect(to("/status")).toBe("a");
  expect(to("!")).toBe("a");
});

test("story 589: a number quoting it is for w/b, not a pick from a panel open here", () => {
  const s = state();
  s.chats[0]!.panel = JSON.stringify({ commands: ["/status"] });
  expect(to("1", s)).toBe("b");
});

test("story 589: a number quoting the rh send of this chat's own slot, or of one deleted, picks from the panel open here", () => {
  for (const from of ["a", "gone"]) {
    const s = { ...state(), quoted: { text: "〔w/x〕\nwhich snapshot?", slot: from } };
    s.chats[0]!.panel = JSON.stringify({ commands: ["/status"] });
    expect(im("1", s).writes.some((w) => w.op === "insert" && w.table === "agentInput")).toBe(false);
  }
});

test("story 589: w/b's asks that went elsewhere, listed here by your quote, take your pick here", () => {
  const b = { ...ask, slot: "b", forwardedTo: "elsewhere", pushedAt: null, listNo: null, pickedAt: null };
  const s = state([b]);
  for (const w of im("the old one", s).writes) if (w.op === "update" && w.table === "ask") Object.assign(b, w.patch);
  expect(to("1", { ...s, quoted: null }, false)).toBe("b");
});

test("story 589: w/b's asks listed here by your quote void a pick of w/a's: your next 1 picks w/b's", () => {
  const a = { ...ask, id: "ka", slot: "a", listNo: 1, pickedAt: now };
  const b = { ...ask, id: "kb", slot: "b", forwardedTo: "elsewhere", pushedAt: null, listNo: null, pickedAt: null };
  const s = state([a, b]);
  for (const w of im("the old one", s).writes) if (w.op === "update" && w.table === "ask") Object.assign(w.where.id === "ka" ? a : b, w.patch);
  const picked = im("1", { ...s, quoted: null }, false).writes.find((w) => w.op === "update" && w.table === "ask" && w.patch.pickedAt === now);
  expect(picked && picked.op === "update" && picked.where).toEqual({ id: "kb" });
});

test("story 589: w/b in TUI, your quote of it is refused, and the /rh_release you are told to send names it", () => {
  const s = state();
  Object.assign(s.slots[1]!, { mode: "tui", herdrLostAt: null });
  const sent = im("the old one", s).writes.find((w) => w.op === "insert" && w.table === "outbound") as { row: { payload: string } };
  expect(JSON.parse(sent.row.payload).text).toContain("发 /rh_release w/b 把它切回无头");
});
