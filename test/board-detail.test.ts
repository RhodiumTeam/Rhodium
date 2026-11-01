// The board's slot detail and Rhodium's own status (seam one, product §7): a slot's messages from
// the agent's own file, its recent events, a headless slot's process and stderr, and each bot's
// connection.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard } from "../src/board";
import { loadConfig } from "../src/config";
import { openStore } from "../src/store";
import { asking, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, exec, newInstance, until, type Daemon } from "./instance";

const ME = "you-openid";

// Bot q sends your private chat to w/c, a claude that asks to run make in each turn; bot t to w/p,
// a pi. Both work in the directory w.
const rhodium = newInstance({
  bots: { q: { like: "qq", owner: ME, target: "w/c" }, t: { like: "telegram", owner: ME, target: "w/p" } },
  claude: { script: asking([["ask-1", "Bash", { command: "make" }]]) },
});
/** The board's address, from rhodium's ready line. */
const boardOf = (d: Daemon) => `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
let base = "";
beforeAll(async () => {
  base = boardOf(await rhodium.start());
  await rhodium.slots("c");
  await rhodium.ok("new", "w/p", "--agent", "pi");
});
afterAll(() => rhodium.cleanup());

async function get<T>(path: string, board = base): Promise<T> {
  const r = await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  expect(r.status).toBe(200);
  return (await r.json()) as T;
}

type Card = { id: string; name: string };
const slotId = async (name: string, board = base) => {
  const b = await get<{ workspaces: { groups: Record<string, Card[]> }[] }>("/api/board", board);
  return Object.values(b.workspaces[0]!.groups).flat().find((c) => c.name === name)!.id;
};

const say = (bot: string, text: string) => rhodium.im.inject(bot, { chat: ME, sender: ME, text });
/** Waits for bot's message in your chat that check picks. */
const sent = (bot: string, check: (p: { text: string; replyTo?: string }) => boolean) =>
  until(async () => (await rhodium.im.log(bot, ME)).some(check), 15_000);

/** A turn of w/c's claude: you say text, it asks to run make, you allow it, it replies "answered".
 *  before: what to do just before you answer. */
async function claudeTurn(text: string, before = async () => {}) {
  const asks = (await rhodium.im.log("q", ME)).filter((p) => p.text.includes("make")).length;
  const m = await say("q", text);
  await until(async () => (await rhodium.im.log("q", ME)).filter((p) => p.text.includes("make")).length > asks, 15_000);
  await before();
  await say("q", "1");
  await sent("q", (p) => p.replyTo === m.messageId && p.text === "answered");
}

/** The one transcript file in dir, which the fake agent wrote: a test writes over it. */
const onlyFile = (dir: string) => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return join(dir, files[0]!);
};

type Block = { kind: string; at: string; text?: string; source?: string | null; id?: string; result?: { at: string; text: string; length?: number } | null };
type Messages = { conversation: string | null; blocks: Block[]; start: number; end: number };

test("stories 192, 200: a slot's messages page back to its first; after gives only what was written since; a cut result comes whole from /api/full", async () => {
  const m = await say("t", "hello");
  await sent("t", (p) => p.replyTo === m.messageId);
  // 30 turns of pi's: you ask, it runs a tool, it answers. The last tool's result is long.
  const line = (role: string, content: unknown, more = {}) => JSON.stringify({ type: "message", timestamp: "2026-10-23T01:00:00.000Z", message: { role, content, ...more } });
  const turn = (i: number, result = `${i}`) => [
    line("user", [{ type: "text", text: `[来自 QQ 私聊]\nq${i}` }]),
    line("assistant", [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }]),
    line("toolResult", [{ type: "text", text: result }], { toolCallId: `c${i}`, isError: false }),
    line("assistant", [{ type: "text", text: `a${i}` }]),
  ];
  const long = "r".repeat(5000);
  const sessions = join(rhodium.home, ".pi/agent/sessions", `--${join(rhodium.dir, "w").slice(1).replace(/\//g, "-")}--`);
  const file = onlyFile(sessions);
  writeFileSync(file, [...Array.from({ length: 29 }, (_, i) => turn(i)).flat(), ...turn(29, long)].join("\n") + "\n");
  const slot = await slotId("p");

  const pages = [await get<Messages>(`/api/messages?slot=${slot}`)];
  while (pages[0]!.start > 0) pages.unshift(await get<Messages>(`/api/messages?slot=${slot}&before=${pages[0]!.start}`));
  expect(pages).toHaveLength(3);
  const conversation = pages[0]!.conversation;
  expect(conversation).toBeString();
  expect(pages.every((p) => p.conversation === conversation)).toBe(true);
  const blocks = pages.flatMap((p) => p.blocks);
  expect(blocks.filter((b) => b.kind === "user").map((b) => [b.source, b.text])).toEqual(Array.from({ length: 30 }, (_, i) => ["QQ 私聊", `q${i}`]));
  expect(blocks.filter((b) => b.kind === "tool").map((b) => b.id)).toEqual(Array.from({ length: 30 }, (_, i) => `c${i}`));
  expect(blocks.filter((b) => b.kind === "assistant").map((b) => b.text)).toEqual(Array.from({ length: 30 }, (_, i) => `a${i}`));

  // The long result comes cut, and whole by its place in the conversation.
  const last = blocks.findLast((b) => b.kind === "tool")!;
  expect(last.result).toMatchObject({ text: long.slice(0, 2000), length: 5000 });
  expect(await get<{ text: string }>(`/api/full?conversation=${conversation}&at=${last.result!.at}`)).toEqual({ text: long });

  // Nothing new yet; then the agent writes on.
  const end = pages.at(-1)!.end;
  expect(await get<Messages>(`/api/messages?slot=${slot}&after=${end}`)).toEqual({ conversation, blocks: [], start: end, end });
  appendFileSync(file, line("assistant", [{ type: "text", text: "one more thing" }]) + "\n");
  expect((await get<Messages>(`/api/messages?slot=${slot}&after=${end}`)).blocks.map((b) => b.text)).toEqual(["one more thing"]);

  const status = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).status;
  expect(await status(`/api/messages?slot=${slot}&before=x`)).toBe(400);
  expect(await status("/api/messages?slot=nope")).toBe(404);
  // No block there: past the end, or past the blocks of a line.
  expect(await status(`/api/full?conversation=${conversation}&at=${end + 1000}.0`)).toBe(404);
  expect(await status(`/api/full?conversation=${conversation}&at=${last.result!.at.split(".")[0]}.1`)).toBe(404);
  expect(await status(`/api/full?conversation=${conversation}&at=x`)).toBe(400);
  expect(await status(`/api/full?conversation=nope&at=0.0`)).toBe(404);
}, 30_000);

type Send = { at: number; status: string; text: string };
type Ev = { seq: number; at: number; type: string; data: any; text?: string; why?: string; status?: string; sends?: Send[] };
type Detail = { ref: string; agent: string; state: string; mode: string };

test("stories 142, 252, 254: a slot's events say what came in, what went out for it (a send of unknown outcome marked), and whether the ask was answered, oldest first", async () => {
  // The platform takes the receipt but its answer never comes back: the outcome is unknown.
  await claudeTurn("build it", () => rhodium.im.next("q", "timeout", "send"));
  const id = await slotId("c");
  const d = await get<Detail & { recent?: unknown }>(`/api/slot?id=${id}`);
  expect(d).toMatchObject({ ref: "w/c", agent: "claude", state: "空闲", mode: "headless" });
  expect(d.recent).toBeUndefined();
  const events = await get<Ev[]>(`/api/slot-events?id=${id}`);
  // Oldest first; this turn's from your message on.
  expect(events.map((r) => r.seq)).toEqual(events.map((r) => r.seq).toSorted((a, b) => a - b));
  const turn = events.slice(events.findLastIndex((r) => r.type === "im_routed" && r.text === "build it"));
  const shown = turn.filter((r) => ["im_routed", "ask", "ask_answered", "final_reply"].includes(r.type));
  expect(shown.map((r) => [r.type, r.text ?? null])).toEqual([
    ["im_routed", "build it"],
    ["ask", null],
    ["ask_answered", null],
    ["im_routed", "1"],
    ["final_reply", null],
  ]);
  // What went out for a message comes with it: the ask and the reply for yours, the receipt for your answer.
  const [message, ask, answered, answer] = shown;
  const sends = (r: Ev) => r.sends?.map((s) => [s.text, s.status]);
  expect(sends(message!)).toEqual([
    [expect.stringContaining("make"), "sent"],
    ["answered", "sent"],
  ]);
  expect(sends(answer!)).toEqual([["已允许运行这条命令。", "unknown"]]);
  expect(ask!.data).toMatchObject({ kind: "permission", tool: "Bash" });
  expect(["answered", "delivered"]).toContain(ask!.status!);
  expect(answered!.data.by).not.toBe("timeout");
  // Your message went to the agent; your answer did not, which says why.
  expect([message!.why, answer!.why]).toEqual([undefined, answer!.data.reason]);
  expect(answer!.why).toBeString();
}, 30_000);

test("stories 252, 254: a slot's events page back to the first, 50 at a time, oldest first, each once; what was sent for a trace is under its first event in the slot, not again on the next page; a message given back says why, one from before inputs were recorded nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-events-"));
  writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, loadConfig(join(dir, "config.toml")));
  try {
    // 120 events of slot S; the 70th and 71st, on two pages, are of one trace, which another slot had first.
    const [slot, g] = store.tx((tx) => {
      const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
      const slot = (name: string) => tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
      const [s, other] = [slot("s"), slot("other")];
      tx.append({ source: "im", type: "im_routed", slot: other, trace: "T" });
      for (let i = 1; i <= 120; i++) tx.append({ source: "agent", type: "final_reply", slot: s, ...((i === 70 || i === 71) && { trace: "T" }) });
      tx.insert("outbound", { chat: "c", trace: "T", status: "sent", createdAt: 1, text: "reply" });
      // A message queued for slot g, then given back: why is what gave it back, not where it was routed.
      const g = slot("g");
      tx.append({ source: "im", type: "im_routed", slot: g, trace: "R", data: { reason: "等额度，排队" } });
      tx.append({ source: "im", type: "input_returned", slot: g, trace: "R", data: { why: "切到 TUI 了" } });
      // A message from before inputs were recorded, older than the first record: no record says nothing.
      tx.append({ source: "im", type: "im_routed", slot: g, trace: "00OLD", data: { reason: "开始新回合" } });
      tx.insert("agentInput", { conversation: "c", source: "human", status: "taken", trace: "T" });
      return [s, g];
    });
    const at = `http://127.0.0.1:${server.port}`;
    const pages = [await get<Ev[]>(`/api/slot-events?id=${slot}`, at)];
    while (pages[0]!.length) pages.unshift(await get<Ev[]>(`/api/slot-events?id=${slot}&before=${pages[0]![0]!.seq}`, at));
    expect(pages.map((p) => p.length)).toEqual([0, 20, 50, 50]);
    const all = pages.flat();
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(120);
    expect(all.flatMap((e, i) => (e.sends ? [[i + 1, e.sends.map((s) => s.text)]] : []))).toEqual([[70, ["reply"]]]);
    expect((await get<Ev[]>(`/api/slot-events?id=${g}`, at)).filter((e) => e.type === "im_routed").map((e) => e.why)).toEqual(["切到 TUI 了", undefined]);
    const status = async (path: string) => (await fetch(at + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).status;
    expect(await status(`/api/slot-events?id=${slot}&before=x`)).toBe(400);
    expect(await status("/api/slot-events?id=nope")).toBe(404);
    expect((await fetch(`${at}/api/slot-events?id=${slot}`)).status).toBe(403);
  } finally {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

type Asked = { id: string; kind: string; text: string; card: unknown; deadline: number | null };
type More = { asks: Asked[]; pane: string | null; model: string | null };

test("stories 205, 207: a slot has the asks waiting on you, in the words IM asks them in, with when they time out; the model by its name; no pane while headless", async () => {
  const id = await slotId("c");
  let asks: Asked[] = [];
  await claudeTurn("check", async () => void (asks = (await get<More>(`/api/slot?id=${id}`)).asks));
  expect(asks).toEqual([{ id: expect.any(String), kind: "permission", text: "要运行这条命令，允许吗？\n\nmake\n\n回“允许”或“拒绝”。回别的话算拒绝，并转告它。", card: expect.any(Object), deadline: expect.any(Number) }]);
  expect(asks[0]!.deadline).toBeGreaterThan(Date.now());
  // Answered: none. No model set: the default, by the model it uses (story 407).
  expect(await get<More>(`/api/slot?id=${id}`)).toMatchObject({ asks: [], pane: null, model: "默认（Opus 5.5）" });

  // What /model set, by the name Claude gave it.
  await say("q", "/model 2");
  await until(async () => (await get<More>(`/api/slot?id=${id}`)).model === "Haiku", 15_000);
}, 30_000);

type Process = { unit: string; activeState: string; subState: string; pid: number | null; stderr: string[] };

test("stories 294, 295, 297, #289: a slot has the commands its palette offers, IM's for its agent but no rh_ one, each a button on the board: each with its arguments, what it does, and what picking it does", async () => {
  type Command = { name: string; usage?: string; summary: string; kind: "run" | "pick" };
  const c = await get<{ commands: Command[] }>(`/api/slot?id=${await slotId("c")}`);
  expect(c.commands.map((x) => `${x.name} ${x.kind}`)).toEqual([
    "stop run", "new run", "status run", "resume pick", "model pick", "usage run", "context run", "compact run", "effort pick", "ultracode pick",
  ]);
  expect(c.commands.find((x) => x.name === "model")).toEqual({ name: "model", usage: "[<模型>]", summary: "换模型", kind: "pick" });
  expect(c.commands.find((x) => x.name === "compact")).toEqual({ name: "compact", summary: "压缩上下文", kind: "run" });
  // Ultracode is no pi's; /usage is, its conversation's use (story 397).
  const p = await get<{ commands: Command[] }>(`/api/slot?id=${await slotId("p")}`);
  expect(p.commands.map((x) => x.name)).toEqual(c.commands.map((x) => x.name).filter((n) => n !== "ultracode"));
  expect(p.commands.find((x) => x.name === "usage")).toEqual({ name: "usage", summary: "看额度和当前对话的用量", kind: "run" });
});

test("story 144: a stuck headless slot shows its process state, its recent events and the end of its stderr", async () => {
  // A claude that starts the turn, writes to stderr in colour, its last line unfinished, and hangs.
  const stderr = "warming up\n\x1b[31mconnection refused\x1b[0m\nretrying in 5s";
  const stuck = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/s" } },
    claude: { script: { on, steps: [...startTurn, { stderr }, { wait: { type: "never" } }] } },
  });
  try {
    const board = boardOf(await stuck.start());
    await stuck.slots("s");
    await stuck.im.inject("q", { chat: ME, sender: ME, text: "go" });
    const id = await slotId("s", board);
    let d!: Detail & { process: Process | null };
    // Its turn began, and it has said all it will.
    await until(async () => (d = await get(`/api/slot?id=${id}`, board)).state === "运行中" && d.process?.stderr.length === 3, 15_000);
    expect(d.process).toMatchObject({ unit: expect.stringMatching(new RegExp(`^${stuck.unitPrefix}`)), activeState: "active", subState: "running" });
    expect(d.process!.pid).toBeGreaterThan(0);
    expect(d.process!.stderr).toEqual(["warming up", "connection refused", "retrying in 5s"]);
    expect((await get<Ev[]>(`/api/slot-events?id=${id}`, board)).find((r) => r.type === "im_routed")!.text).toBe("go");
  } finally {
    await stuck.cleanup();
  }
}, 30_000);

type Status = {
  boot: number;
  pid: number;
  unit: string | null;
  bots: { name: string; platform: string; state: string | null }[];
  logs: { at: number; line: string }[] | null;
};
const stateOf = async (bot: string, board = base) => (await get<Status>("/api/rhodium", board)).bots.find((b) => b.name === bot)!.state;

test("story 147: Rhodium's status says whether each bot is connected", async () => {
  await until(async () => (await stateOf("q")) === "online" && (await stateOf("t")) === "online");
  const status = await get<Status>("/api/rhodium");
  expect(status.bots.map((b) => [b.name, b.platform])).toEqual([
    ["q", "fake"],
    ["t", "fake"],
  ]);
  expect(status.boot).toBe(1);

  await rhodium.im.connection("t", false);
  try {
    await until(async () => (await stateOf("t")) === "reconnecting");
    expect(await stateOf("q")).toBe("online");
  } finally {
    await rhodium.im.connection("t", true);
  }
  await until(async () => (await stateOf("t")) === "online");
  // Run by hand, not as its systemd service: its log is on its stderr, not in journald.
  expect(await get<Status>("/api/rhodium")).toMatchObject({ unit: null, logs: null });
});

test("story 147: run as its systemd service, Rhodium's status has its log from journald", async () => {
  const service = newInstance();
  try {
    const unit = await service.installService();
    // Its board's address, from its ready line in journald.
    let ready: { board: string } | undefined;
    await until(async () => {
      const { out } = await exec(["journalctl", "--user", "-u", `${unit}.service`, "-o", "cat", "--no-pager"]);
      ready = out.split("\n").filter((l) => l.startsWith('{"msg":"ready"')).map((l) => JSON.parse(l))[0];
      return ready !== undefined;
    }, 15_000);
    const status = await get<Status>("/api/rhodium", `http://${ready!.board}`);
    expect(status).toMatchObject({ unit, boot: 1 });
    const line = status.logs!.find((l) => l.line.startsWith('{"msg":"ready"'))!;
    expect(JSON.parse(line.line)).toMatchObject({ msg: "ready", board: ready!.board });
    expect(Math.abs(line.at - Date.now())).toBeLessThan(60_000);
  } finally {
    await service.cleanup();
  }
}, 30_000);
