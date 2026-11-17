// The record of context, use and quota (spec web-import-composer, its fourth ticket; architecture §7.11):
// asked of an agent already running at its turn's end, as a page opens its chat and as the page asks,
// never starting one; kept in the database, the quota shared by an agent's slots. Seen from seam one,
// through the fake IM and the board's HTTP.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { SlotData } from "../src/board";
import { BOARD_LOGIN, newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
let base = "";
afterEach(() => rhodium.cleanup());

async function start(o: Parameters<typeof newInstance>[0]): Promise<void> {
  rhodium = newInstance(o);
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
}
const get = (path: string) => fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
/** Slot w/<name>'s id, by its card on the board. */
async function idOf(name: string): Promise<string> {
  const b = (await (await get("/api/board")).json()) as { workspaces: { name: string; groups: Record<string, { id: string; name: string }[]> }[] };
  return Object.values(b.workspaces.find((w) => w.name === "w")!.groups).flat().find((c) => c.name === name)!.id;
}
const slot = async (id: string) => (await (await get(`/api/slot?id=${id}`)).json()) as SlotData;
/** POST /api/meter for the slot, as the board's own page sends it. */
const askMeter = (id: string) => fetch(`${base}/api/meter`, { method: "POST", headers: { "Tailscale-User-Login": BOARD_LOGIN, "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ slot: id }) });
/** The board's event stream following the slot's chat, as a page opening it connects; told has the meter events it said. */
function openChat(id: string) {
  const ac = new AbortController();
  const told: unknown[] = [];
  void fetch(`${base}/api/events?slot=${id}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN }, signal: ac.signal })
    .then(async (r) => {
      let buf = "";
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: meter$/m.test(block)) told.push(JSON.parse(block.match(/^data: (.*)$/m)![1]!));
        }
      }
    })
    .catch(() => {});
  return { told, close: () => ac.abort() };
}
/** How many times the fake agent was asked what: control requests by subtype, rpc commands by type, Codex's requests by method. */
const asked = (agent: "claude" | "pi" | "codex", what: string) =>
  rhodium[agent].runs().flatMap((r) => r.stdin).filter((l) => {
    const m = JSON.parse(l);
    return m.request?.subtype === what || m.type === what || m.method === what;
  }).length;

test("story 656: a turn's end asks the running agent once for its context and use, kept with the conversation; a page's asks send nothing to any chat and change nothing of the slot, nor write an event; two asks in a row ask once", async () => {
  await start({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  const id = await idOf("a");
  await until(async () => (await slot(id)).meter.context !== null && (await slot(id)).meter.quota !== null, 15_000);
  const s = await slot(id);
  expect(s.live).toBe(true);
  // The fake Claude's get_context_usage and get_usage.
  expect(s.meter.context).toMatchObject({ usedTokens: 52_000, maxTokens: 200_000 });
  expect(s.meter.session).toMatchObject({ cost: 15.35 });
  expect(s.meter.quota!.limits.map((l) => [l.window, l.usedPercent])).toEqual([["5h", 12], ["7d", 52], ["7d", 38]]);
  expect([asked("claude", "get_usage"), asked("claude", "get_context_usage")]).toEqual([1, 1]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);

  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const now = () => db.query(`SELECT state, turnEndedAt, startedIdleAt, activeAt, (SELECT max(seq) FROM event) AS seq FROM slot WHERE id = '${id}'`).get();
  const before = now();
  const heard = s.meter.context!.at;
  // Past the 10 s within which an ask asks nothing again.
  await Bun.sleep(10_500);
  expect((await askMeter(id)).status).toBe(204);
  expect((await askMeter(id)).status).toBe(204);
  await until(async () => (await slot(id)).meter.context!.at > heard, 10_000);
  await Bun.sleep(300);
  expect([asked("claude", "get_usage"), asked("claude", "get_context_usage")]).toEqual([2, 2]);
  expect(now()).toEqual(before);
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  // Opening the chat within 60 s of the last record asks nothing.
  const chat = openChat(id);
  await Bun.sleep(500);
  chat.close();
  expect(asked("claude", "get_usage")).toBe(2);
  db.close();
}, 40_000);

test("stories 656, 657: once its process is reaped, opening the chat and asking start none and ask nothing; the page has what was heard, not live; a restart keeps it", async () => {
  await start({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: '[durations]\nidleReap = "1s"' });
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  const id = await idOf("a");
  await until(async () => (await slot(id)).meter.context !== null, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  const heard = (await slot(id)).meter;
  const chat = openChat(id);
  expect((await askMeter(id)).status).toBe(204);
  await Bun.sleep(1_000);
  chat.close();
  expect(rhodium.claude.runs()).toHaveLength(1);
  expect(asked("claude", "get_usage")).toBe(1);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(await slot(id)).toMatchObject({ meter: heard, live: false });

  await rhodium.stop();
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  expect(await slot(id)).toMatchObject({ meter: heard, live: false });
}, 40_000);

test("stories 657, 658: the quota one slot heard is every slot's of the same agent, not another agent's; pi has its context and use, no quota", async () => {
  await start({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, r: { like: "qq", owner: ME, target: "w/c" } } });
  await rhodium.slots("a", "b");
  await rhodium.ok("new", "w/c", "--agent", "pi");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await rhodium.im.inject("r", { chat: ME, sender: ME, text: "hello" });
  const [a, b, c] = [await idOf("a"), await idOf("b"), await idOf("c")];
  await until(async () => (await slot(a)).meter.quota !== null && (await slot(c)).meter.context !== null && (await slot(c)).meter.session !== null, 15_000);
  expect((await slot(b)).meter).toEqual({ context: null, session: null, quota: (await slot(a)).meter.quota });
  // The fake pi's get_session_stats: 127 of 100,000 tokens.
  expect((await slot(c)).meter).toMatchObject({ context: { usedTokens: 127, maxTokens: 100_000 }, session: { tokens: { total: 127 } }, quota: null });
}, 30_000);

test("stories 656, 658: opening the chat of a running agent never heard asks it, and every stream hears of it; Codex before its first answer has the quota, no context", async () => {
  await start({ bots: { q: { like: "qq", owner: ME, target: "w/d" } } });
  await rhodium.slots();
  await rhodium.ok("new", "w/d", "--agent", "codex");
  const id = await idOf("d");
  // /model starts it, and records nothing.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/model" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  expect((await slot(id)).meter).toEqual({ context: null, session: null, quota: null });
  const other = openChat("none");
  const chat = openChat(id);
  await until(async () => (await slot(id)).meter.quota !== null, 10_000);
  const s = await slot(id);
  expect(s.live).toBe(true);
  expect(s.meter.context).toBeNull();
  // The fake Codex's account/rateLimits/read: 91% of the seven days, from bucket codex.
  expect(s.meter.quota).toMatchObject({ limits: [{ window: "7d", usedPercent: 91, limitId: "codex" }] });
  await until(() => other.told.length > 0 && chat.told.length > 0);
  expect(other.told[0]).toEqual({ agent: "codex", conversation: expect.any(String) });
  chat.close();
  other.close();
  // Only the quota was recorded, yet it was asked just now: a reopened chat and a page's ask ask nothing.
  const once = asked("codex", "account/rateLimits/read");
  const again = openChat(id);
  expect((await askMeter(id)).status).toBe(204);
  await Bun.sleep(1_000);
  again.close();
  expect(asked("codex", "account/rateLimits/read")).toBe(once);
}, 30_000);
