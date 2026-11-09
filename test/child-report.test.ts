// A child's result reaches you once, from its parent (stories 577-579; product §6.1, architecture
// §9.2, §9.3): no report of a turn you began or joined, a child you are not talking to has its rh
// send me refused, and rh send's receipt names the chat it went to.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeoutAnswer } from "../src/asks";
import { skillText } from "../src/commands";
import { loadConfig } from "../src/config";
import { QQ_CAPABILITIES } from "../src/platforms";
import type { AgentEvent } from "../src/contracts";
import { BOARD, route, type Ctx, type Decision, type State } from "../src/router";
import type { Chat, Slot } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-child-report-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const ctx: Ctx = {
  now: Date.parse("2026-11-06T12:00:00Z"),
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

const slot = (id: string, o: Partial<Slot>) =>
  ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state: "idle", conversation: id, parent: null, lifetime: "oneoff", archivedAt: null, token: id, turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null, reported: null, ...o }) as Slot;

/** Slot p, idle, and its child c running a turn; bot t's default target is target, your private chat with it chat. */
function state(child: Partial<Slot> = {}, o: { parent?: Partial<Slot>; target?: string; chat?: Partial<Chat> } = {}): State {
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" }],
    slots: [slot("p", o.parent ?? {}), slot("c", { parent: "p", state: "running", turnInbound: "in", ...child })],
    conversations: ["p", "c"].map((s) => ({ id: s, slot: s, agent: "claude", sessionId: s, startedAt: 0, progress: null })),
    bots: [{ id: "t", name: "t", platform: "telegram", defaultTarget: o.target ?? "p", owners: JSON.stringify(["me"]), connState: "online" }],
    chats: [{ id: "me", bot: "t", platformChatId: "me", target: null, contactedAt: null, ...o.chat }],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as unknown as State;
}

const event = (s: State, e: Record<string, unknown>) => route(s, { kind: "agent", event: { conv: "c", ...e } as AgentEvent }, ctx);
const end = (s: State) => event(s, { type: "turn_end", reply: "all 12 wicks trimmed" });
/** What the decision gives p's agent as a report, and tells you. */
const reports = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "agentInput" && w.row.source === "report" ? [w.row.body as string] : []));
const told = (d: Decision) => d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" ? [JSON.parse(w.row.payload as string).text as string] : []));
const marked = (d: Decision) => d.writes.some((w) => w.op === "update" && w.table === "slot" && "reported" in w.patch);

test("story 578: a report says the child told you nothing itself, and one of it stuck that you have the ask or the crash notice already", () => {
  const [done] = reports(end(state()));
  expect(done).toContain("子槽位 w/c 完成了。最后一条回复的开头：all 12 wicks trimmed\n它没有直接告诉用户。\n");
  const asked = event(state(), { type: "ask", requestId: "r", kind: "question", tool: "AskUserQuestion", input: { questions: [] } });
  expect(reports(asked)[0]).toContain("它没有直接告诉用户。提问已经推给用户，不用转告。\n");
  const crashed = event(state(), { type: "exit", proc: 1, code: 1, signal: null, from: "agent" });
  expect(reports(crashed)[0]).toContain("它没有直接告诉用户。用户已收到崩溃通知，不用转告。\n");
});

test("story 579: a child reports no turn you began or joined, from the board or a chat going to it by its bot's default alone, and marks none reported", () => {
  for (const s of [state({ turnChat: BOARD }), state({ turnChat: "me" }, { target: "c" })]) {
    const d = end(s);
    expect(reports(d)).toEqual([]);
    expect(marked(d)).toBe(false);
  }
});

test("story 579: with its parent archived, your own turn with the child brings you no notice for you to decide", () => {
  const d = end(state({ turnChat: "me" }, { parent: { archivedAt: 1 }, target: "c" }));
  expect(told(d).filter((t) => t.includes("需要你拿主意"))).toEqual([]);
  // Not yours, it does.
  expect(told(end(state({}, { parent: { archivedAt: 1 }, target: "c" }))).some((t) => t.includes("需要你拿主意"))).toBe(true);
});

const sendMe = (s: State, token = "c") => {
  const reply = route(s, { kind: "rh", id: "r", caller: { token, pid: null, tty: false, cwd: "/w" }, argv: ["send", "me", "hi"] }, ctx).effects.find((e) => e.kind === "rh_reply")!.reply;
  return reply.ok ? reply.text : reply.error;
};

test("stories 577, 578: a child you are not talking to has its rh send me refused; one you are, or with its parent gone, sends, told where it went", () => {
  expect(sendMe(state())).toContain("结果会随汇报交给父槽位 w/p，由它决定告诉用户什么。把结果和文件路径写进最终回复");
  const sent = "已发到 Telegram 私聊。";
  for (const s of [state({ turnChat: BOARD }), state({}, { chat: { target: "c" } }), state({}, { parent: { archivedAt: 1 } }), state({ mode: "tui" })]) expect(sendMe(s)).toBe(sent);
  expect(sendMe(state(), "p")).toBe(sent);
});

test("story 577: rh send me on a QQ bot with no active message left, and no other bot, says it waits for your reply", () => {
  const s = state();
  (s.bots[0] as { platform: string }).platform = "qq";
  const qq = { ...ctx, config: { ...ctx.config, limits: { ...ctx.config.limits, qqActive: 0 } }, capabilities: () => QQ_CAPABILITIES };
  const reply = route(s, { kind: "rh", id: "r", caller: { token: "p", pid: null, tty: false, cwd: "/w" }, argv: ["send", "me", "hi"] }, qq).effects.find((e) => e.kind === "rh_reply")!.reply;
  expect(reply).toEqual({ ok: true, text: "已交给 QQ 私聊，那边额度用完了，在等用户回话，回了才发出。" });
});

test("#601: a child whose plan ask timed out stops to wait for you, so its turn's end reports it stuck, not done, with the summary its reply holds", () => {
  const s = state({ state: "waiting", reported: "stuck" });
  s.asks = [{ id: "k", slot: "c", kind: "plan", status: "open", deadline: ctx.now - 1, prompt: JSON.stringify({ tool: "ExitPlanMode", input: { plan: "trim" } }) } as State["asks"][number]];
  expect(route(s, { kind: "clock", timer: "ask_timeout", key: "k" }, ctx).writes).toContainEqual({ op: "update", table: "slot", where: { id: "c" }, patch: { turnPlanTimedOut: 1 } });
  // Reported stuck already this turn, of that ask or one it raised since, and with a background task running.
  const [stuck, ...more] = reports(event(state({ turnPlanTimedOut: 1, reported: "stuck" }), { type: "turn_end", reply: "all 12 wicks trimmed", background: true }));
  expect(more).toEqual([]);
  expect(stuck).toContain("子槽位 w/c 卡住了。它的计划确认超时，没有批准，停下来等用户回复。最后一条回复的开头：all 12 wicks trimmed\n它没有直接告诉用户。\n");
  // Its next turn starts afresh.
  expect(event(state({ turnPlanTimedOut: 1 }), { type: "turn_start" }).writes).toContainEqual({ op: "update", table: "slot", where: { id: "c" }, patch: { turnPlanTimedOut: null } });
});

test("#601: what asks an agent to tell you a result itself sends one with a parent to rh send me's rule, as a child's may be refused", () => {
  const rule = "你有父槽位时，见 rh send me 的说明";
  expect((timeoutAnswer("plan", { tool: "ExitPlanMode", input: {} }) as { message: string }).message).toContain(`请用 rh send me 把计划摘要发给用户（${rule}）`);
  expect(skillText()).toContain(`由你用 rh send me 告诉用户（${rule}）`);
});
