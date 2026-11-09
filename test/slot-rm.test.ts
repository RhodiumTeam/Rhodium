// rh rm (product §4, architecture §9.8): only you delete a slot, archived and with its process stopped.
// Rhodium forgets its own records of it; a chat rh use points at it goes back to its bot's default.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { route, type Ctx, type State } from "../src/router";
import type { Slot } from "../src/store";
import { asking } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you";

let rhodium: Instance | undefined;
afterEach(() => rhodium?.cleanup());

test("stories 532, 533: rh rm of an archived, stopped slot rh use points at forgets every record of it; the chat goes back to its bot's default and hears so; a restart goes on as usual", async () => {
  const r = (rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } }));
  await r.start();
  await r.slots("a", "x");
  const say = (text: string) => r.im.inject("t", { chat: ME, sender: ME, text });
  /** Waits until the bot has said text in the chat, that many times: the start of a message is enough. */
  const heard = (text: string, times = 1) =>
    until(async () => (await r.im.log("t", ME)).filter((p) => p.text.startsWith(text)).length >= times, 15_000);
  // w/x has two conversations: the first ran a turn and made an ask, the second is new.
  await say("/rh_use x");
  await heard("这里的消息改交给 w/x。");
  const go = await say("go");
  await heard("要运行这条命令");
  await say("/new");
  await heard("已开一段新对话。");
  await r.ok("archive", "w/x");
  await say("/rh_use x");
  await heard("这里的消息改交给 w/x。", 2);
  await until(async () => (await r.state("w/x")) === "未运行（已归档）", 15_000);

  expect(await r.ok("rm", "w/x")).toBe("已删除 w/x。\n");
  await heard("w/x 删除了，这里的消息改交给 w/a。");
  // rh trace still names it, from its slot_deleted event.
  expect(await r.ok("trace", go.messageId)).toMatch(/^去向：w\/x（/m);

  await r.stop();
  const db = new Database(join(r.dir, "state/rh.db"), { readonly: true });
  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
  const left = {
    slot: count("SELECT count(*) n FROM slot"),
    conversation: count("SELECT count(*) n FROM conversation"),
    // a's conversation has none yet: what is left is x's.
    agentInput: count("SELECT count(*) n FROM agentInput"),
    holder: count("SELECT count(*) n FROM holder"),
    ask: count("SELECT count(*) n FROM ask"),
  };
  const deleted = db.query("SELECT data FROM event WHERE type = 'slot_deleted'").all();
  db.close();
  expect(left).toEqual({ slot: 1, conversation: 1, agentInput: 0, holder: 0, ask: 0 });
  expect(deleted).toEqual([{ data: JSON.stringify({ ref: "w/x" }) }]);

  await r.start();
  await say("to a");
  await until(async () => (await r.state("w/a")) === "需要你", 15_000); // its ask
}, 60_000);

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-slot-rm-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const ctx: Ctx = {
  now: Date.parse("2026-10-28T12:00:00Z"),
  newId: () => crypto.randomUUID(),
  newPairCode: () => "0000",
  config: loadConfig(join(dir, "config.toml")),
  capabilities: () => undefined,
  keepFile: () => null,
  diskFree: () => Infinity,
  front: () => false,
  herdr: () => true,
  retarget: () => null,
  inboundOf: () => [],
};

test("story 534: rh rm refuses a slot not archived, one whose agent still runs, headless or in the terminal, a bot's default target, and an agent", () => {
  const slot = (name: string, o: Partial<Slot> = {}) =>
    ({ id: name, workspace: "w", name, dir: "/w", mode: "headless", state: "off", conversation: null, parent: null, lifetime: "longterm", archivedAt: 1, token: null, rhWindowAt: null, ...o }) as Slot;
  const state = {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot("live", { archivedAt: null, token: "agent" }), slot("busy", { state: "idle" }), slot("term", { mode: "tui" }), slot("def"), slot("gone")],
    bots: [{ id: "t", name: "t", platform: "telegram", defaultTarget: "def" }],
    ...{ conversations: [], chats: [], holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
  const rm = (ref: string, token: string | null = null) => {
    const d = route(state, { kind: "rh", id: "r", caller: { token, pid: null, tty: true, cwd: "/" }, argv: ["rm", ref] }, ctx);
    const reply = d.effects.find((e) => e.kind === "rh_reply")!.reply;
    return reply.ok ? reply.text : reply.error;
  };
  expect([rm("w/live"), rm("w/busy"), rm("w/term"), rm("w/def"), rm("w/gone", "agent")]).toEqual([
    "w/live 没有归档，只能删除已归档的槽位。",
    "w/busy 的 agent 还没停，停了再删除。",
    "w/term 的 agent 还没停，停了再删除。",
    "w/def 是 Telegram Bot 的默认目标，先用 rh bind 换一个再删除。",
    "rh rm 只有用户本人能用，agent 调用一律拒绝。",
  ]);
});
