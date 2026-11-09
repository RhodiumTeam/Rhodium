// Each agent's quota is its own (#419): a refusal staggers only the slots waiting on the same agent,
// and you hear of it by that agent's name. pi reports no quota, so its refusal is made up here and
// given to the router as is. Codex's comes from its driver, end to end (story 502).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import type { AgentKind } from "../src/contracts";
import type { Posted } from "../src/fake-im";
import { route, type Ctx, type State } from "../src/router";
import type { Slot } from "../src/store";
import { installFakeAgent } from "./fake-agent/fake-agent";
import { codexQuota, rateLimited } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Instance } from "./instance";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-quota-agents-"));
writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}"\n`, { mode: 0o600 });
const ctx: Ctx = {
  now: Date.parse("2026-10-27T12:00:00Z"),
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
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

/** Slot a on Claude, waiting for its quota, and slot b on pi, running. */
function state(): State {
  const slot = (id: string, state: Slot["state"]) =>
    ({ id, workspace: "w", name: id, dir: "/w", mode: "headless", state, conversation: `c-${id}`, lifetime: "longterm", archivedAt: null, resumeAt: state === "rate_limited" ? ctx.now + 60_000 : null, quotaUntold: null }) as unknown as Slot;
  const conv = (id: string, agent: AgentKind) => ({ id: `c-${id}`, slot: id, agent, sessionId: "s", startedAt: 0, progress: null }) as unknown as State["conversations"][number];
  return {
    workspaces: [{ id: "w", name: "w", dir: "/w" } as unknown as State["workspaces"][number]],
    slots: [slot("a", "rate_limited"), slot("b", "running")],
    conversations: [conv("a", "claude"), conv("b", "pi")],
    // Your chat with bot q points at b: there you hear of it.
    bots: [{ id: "q", name: "q", platform: "fake", owners: '["me"]', defaultTarget: null } as unknown as State["bots"][number]],
    chats: [{ id: "ch", bot: "q", platformChatId: "me", target: "b", contactedAt: null } as unknown as State["chats"][number]],
    ...{ holders: [], queued: [], quotas: [], held: [], hints: [], asks: [], listed: [], unsure: [] },
    ...{ chatOf: {}, quoted: null, seen: false, begun: null, models: {}, modelInfo: {} },
  } as State;
}

test("#419: pi's refusal waits out pi's quota alone, on a clock of its own, and you hear of pi's quota, not Claude's", () => {
  const s = state();
  const resetsAt = ctx.now + 3_600_000;
  const d = route(s, { kind: "agent", event: { type: "usage", conv: "c-b", proc: 1, quota: { exhausted: true, resetsAt } } as never }, ctx);
  const resumes = d.writes.flatMap((w) => (w.op === "update" && w.table === "slot" && "resumeAt" in w.patch ? [w.where.id] : []));
  expect(resumes).toEqual(["b"]); // Claude's slot a keeps its own reset
  expect(d.effects.filter((e) => e.kind === "timer" && e.timer === "quota_notice")).toMatchObject([{ key: "pi" }]);

  const waiting = { ...s, slots: s.slots.map((x) => (x.id === "b" ? { ...x, state: "rate_limited" as const, quotaUntold: 1 as const, resumeAt: resetsAt } : { ...x, quotaUntold: 1 as const })) };
  const told = route(waiting, { kind: "clock", timer: "quota_notice", key: "pi" }, ctx);
  const untold = told.writes.flatMap((w) => (w.op === "update" && w.table === "slot" && w.patch.quotaUntold === null ? [w.where.id] : []));
  expect(untold).toEqual(["b"]); // Claude's waiting slot is told on Claude's clock
  expect(JSON.stringify(told)).toContain("用完了 pi 额度");
  expect(JSON.stringify(told)).not.toContain("Claude");
});

// ---- Codex, end to end ----

const ME = "you-openid";
// rhodium tells times in its own zone; this one is passed on to it, so both read the same clock.
process.env.TZ = "Etc/GMT-9";

let rhodium: Instance | undefined;
afterEach(async () => {
  await rhodium?.cleanup();
  rhodium = undefined;
});

/** The time of day as you read it, say 14:30, of a reset in epoch seconds. */
const clock = (s: number) => new Date(s * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

let board = ""; // its address

/** A rhodium whose bot q sends your chat to w/a; started, with workspace w and these Codex slots in it. */
async function codexSlots(toml: string, ...names: string[]): Promise<Instance> {
  const r = (rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml }));
  board = `http://${(await r.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await r.slots();
  for (const n of names) await r.ok("new", `w/${n}`, "--agent", "codex");
  return r;
}

/** Each codex started from now on is refused its first turn, its quota out until s seconds from now. */
function codexOutOfQuota(r: Instance, s: number): number {
  const resetsAt = Math.ceil(Date.now() / 1000) + s;
  installFakeAgent(join(r.dir, "bin"), { script: codexQuota(resetsAt) }, "codex");
  return resetsAt;
}

async function posts(r: Instance, n: number): Promise<Posted[]> {
  await until(async () => (await r.im.log("q", ME)).length >= n, 15_000);
  return r.im.log("q", ME);
}

test("story 502: Codex's quota runs out: the slot waits for it, you hear when it resets, and at the reset it carries on with 继续", async () => {
  const r = await codexSlots('[durations]\nquotaNotice = "0s"', "a");
  const resetsAt = codexOutOfQuota(r, 2);
  const { messageId } = await r.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [notice, reply] = await posts(r, 2);
  expect(notice!.text).toMatch(new RegExp(`^w/a 用完了 Codex 额度，${clock(resetsAt)} 恢复（还有 \\d+ 秒）。\n到时它自己接着做。`));
  expect(reply).toMatchObject({ text: "fake reply", replyTo: messageId });
  expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000);
  // The same process waited, and was told 继续 at the reset.
  const [run, ...more] = r.codex.runs();
  expect(more).toEqual([]);
  expect(run!.stdin.map((l) => JSON.parse(l)).filter((m) => m.method === "turn/start").map((m) => withoutSource(m.params.input[0].text))).toEqual(["work", "继续"]);
}, 30_000);

test("story 502: Codex's quota and Claude's run out together: one notice each, the Codex one naming its slots, and each staggered among its own", async () => {
  // All three are told of in the main chat; a minute of stagger puts w/b's reset a minute after w/a's.
  const r = await codexSlots(`mainChat = "q/${ME}"\n[durations]\nquotaNotice = "3s"\nquotaStagger = "60s"`, "a", "b");
  await r.ok("new", "w/c");
  const resetsAt = codexOutOfQuota(r, 30);
  installFakeAgent(dirname(r.claude.path), { script: rateLimited(resetsAt, true) });
  await r.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await r.ok("send", "w/b", "work");
  await r.ok("send", "w/c", "work");
  const notices = (await posts(r, 2)).map((p) => p.text);
  const codex = notices.find((t) => t.startsWith("Codex"));
  expect(codex).toMatch(new RegExp(`^Codex 额度用完了，${clock(resetsAt)} 恢复（还有 \\d+ 秒）。\n在等的：w/a、w/b。\n`));
  expect(notices.find((t) => t !== codex)).toStartWith(`w/c 用完了 Claude 额度，${clock(resetsAt)} 恢复`);
  await Bun.sleep(500); // a third notice would show up by now
  expect(await r.im.log("q", ME)).toHaveLength(2);

  // w/c waits for Claude's alone: not put after the two Codex slots.
  type Board = { workspaces: { name: string; groups: Record<string, { name: string; state: string }[]> }[] };
  const res = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const cards = ((await res.json()) as Board).workspaces.find((w) => w.name === "w")!.groups.running!;
  const at = Object.fromEntries(cards.map((c) => [c.name, c.state]));
  expect(at).toEqual({ a: `等额度，预计 ${clock(resetsAt)} 恢复`, b: `等额度，预计 ${clock(resetsAt + 60)} 恢复`, c: `等额度，预计 ${clock(resetsAt)} 恢复` });
}, 30_000);
