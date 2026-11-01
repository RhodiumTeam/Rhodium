// rh spawn, one-off children and the spawn limits (stories 87-89, 94, 100-102), seen from seam one.
// Every slot runs the same fake claude, which does what its message says: the message is a list
// of rh calls (plan below), so a parent's message can carry its child's task, and so on down.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run, Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, boardAct, newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
/** A message that has the agent make these rh calls, in order. */
const plan = (...calls: string[][]) => JSON.stringify(calls);

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** An instance whose bot q goes to w/a, with w at <dir>/w; started, with the slot w/a made. */
async function begin(opts: InstanceOptions = {}): Promise<Instance> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey }, ...opts });
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  return rhodium;
}
let board = ""; // the board's address

/** The slot's agent run, once it has been given a message. */
async function runOf(ref: string): Promise<Run> {
  const find = () => rhodium.claude.runs().find((r) => r.env.RHODIUM_SLOT === ref && r.stdin.some((l) => JSON.parse(l).type === "user"));
  await until(() => find() !== undefined, 15_000);
  return find()!;
}

/** The slot's rh calls, once it has made at least n. The fake agent logs a call only once rh
 *  has exited, which can be after Rhodium has acted on it, say told you about it. */
async function rhCalls(ref: string, n: number): Promise<Run["rh"]> {
  await until(async () => (await runOf(ref)).rh.length >= n, 15_000);
  return (await runOf(ref)).rh;
}

/** The texts of the user frames written to the run. */
const told = (run: Run) => run.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text));

/** The texts the bot has posted to you, once there are at least n. */
async function texts(n: number, bot = "q"): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return (await rhodium.im.log(bot, ME)).map((p) => p.text);
}

test("story 87: an agent's rh spawn makes a child slot of the given agent and dir, and its task is the child's first message", async () => {
  await begin();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "fix", "--agent", "claude", "fix the login bug"]) });

  const child = await runOf("w/fix");
  expect(told(child)).toEqual(["fix the login bug"]);
  // The task is not from you.
  expect(child.stdin.map((l) => JSON.parse(l)).find((m) => m.type === "user").origin).toBeUndefined();
  const [call] = await rhCalls("w/a", 1);
  expect([call!.code, call!.err]).toEqual([0, ""]);
  expect(call!.out).toContain("w/fix");

  const ls = await rhodium.ok("ls", "w/fix");
  expect(ls).toMatch(/^agent: claude$/m);
  expect(ls).toMatch(new RegExp(`^目录: ${join(rhodium.dir, "w")}$`, "m"));
  expect(ls).toMatch(/^父槽位: w\/a$/m);
  expect(ls).toMatch(/^生命周期: 一次性$/m);
}, 30_000);

test("story 405: a child's first turn says on /status how long it has run", async () => {
  await begin({ claude: { script: { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, { wait: { type: "never" } }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "fix", "--agent", "claude", plan()]) });
  await runOf("w/fix");
  await until(async () => (await rhodium.state("w/fix")) === "运行中", 15_000);
  const w = (await (await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()).workspaces.find((w: any) => w.name === "w");
  const fix = [...Object.values(w.groups as Record<string, { id: string; name: string }[]>).flat()].find((c) => c.name === "fix")!.id;
  const status = await (await boardAct(board, { kind: "say", slot: fix, text: "/status" })).json();
  expect(status.card.line).toMatch(/^运行中，这一回合跑了 \d+ 秒$/);
}, 30_000);

test("story 87: rh spawn --agent pi makes a pi child, whose first prompt is its task", async () => {
  await begin();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "port", "--agent", "pi", "port the parser"]) });
  const prompted = () => rhodium.pi.runs().find((r) => r.env.RHODIUM_SLOT === "w/port" && r.stdin.length > 0);
  await until(() => prompted() !== undefined, 15_000);
  const run = prompted()!;
  expect(run.argv.slice(0, 3)).toEqual(["--mode", "rpc", "--session-id"]);
  const prompts = run.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "prompt");
  expect(prompts.map((m) => withoutSource(m.message))).toEqual(["port the parser"]);
  expect(rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === "w/port")).toEqual([]);
  const ls = await rhodium.ok("ls", "w/port");
  expect(ls).toMatch(/^agent: pi$/m);
  expect(ls).toMatch(/^父槽位: w\/a$/m);
}, 30_000);

test("a child's ask comes to its root slot's chat, and what you type there answers the child, not the root", async () => {
  await begin({ pi: { script: "pi-ask" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.startsWith("w/c 要运行这条命令，允许吗？")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "1" });
  await until(async () => (await texts(1)).some((t) => t.startsWith("已回答")), 10_000).catch(() => {});
  expect((await texts(1)).filter((t) => t.startsWith("已回答"))).toEqual(["已回答 w/c 的提问：允许。"]);
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  expect(told(await runOf("w/a"))).not.toContain("1");
}, 30_000);

test("asks of two children in their root slot's chat: what you type answers neither until you pick one from a list naming each slot", async () => {
  await begin({ pi: { script: "pi-ask" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.startsWith("w/c1 要运行这条命令，允许吗？")), 15_000);
  // A ! message goes to w/a, not to the ask.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "!" + plan(["spawn", "c2", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.startsWith("w/c2 要运行这条命令，允许吗？")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  const last = async () => (await rhodium.im.log("q", ME)).at(-1)!.text;
  const say = async (text: string) => {
    const n = (await rhodium.im.log("q", ME)).length;
    await rhodium.im.inject("q", { chat: ME, sender: ME, text });
    await texts(n + 1);
  };
  await say("2");
  expect(await last()).toBe("有 2 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. w/c1 要运行：echo hi\n2. w/c2 要运行：echo hi");
  await say("2");
  expect(await last()).toStartWith("w/c2 要运行这条命令，允许吗？");
  // A new ask here voids that pick, as one of the same slot would.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "!" + plan(["spawn", "c3", "--agent", "pi", "do it"]) });
  await until(async () => (await texts(1)).some((t) => t.startsWith("w/c3 要运行这条命令，允许吗？")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await say("2");
  expect(await last()).toStartWith("有 3 条提问在等你，先选一条再回答。");
  await say("2");
  await say("2");
  expect(await last()).toBe("已回答“w/c2 要运行：echo hi”：拒绝。");
  await until(async () => (await rhodium.state("w/c2")) === "空闲", 15_000);
  expect([await rhodium.state("w/c1"), await rhodium.state("w/c3")]).toEqual(["需要你", "需要你"]);
  expect(told(await runOf("w/a"))).not.toContain("2");
}, 45_000);

test("story 88: the child lands in the workspace whose default dir is its dir; with none there, one is made, then reused", async () => {
  await begin();
  const other = join(rhodium.dir, "projects", "shop");
  mkdirSync(other, { recursive: true });
  await rhodium.im.inject("q", {
    chat: ME,
    sender: ME,
    text: plan(
      ["spawn", "here", "no dir: where I am"],
      ["spawn", "there", "--dir", other, "--longterm", "in shop"],
      ["spawn", "again", "--dir", other, "in shop too"],
    ),
  });
  expect(await texts(1)).toEqual(["done"]);
  expect((await runOf("w/a")).rh.map((c) => [c.code, c.err])).toEqual([[0, ""], [0, ""], [0, ""]]);

  expect((await rhodium.ok("ws")).trim().split("\n")).toEqual([`w     ${join(rhodium.dir, "w")}`, `shop  ${other}`]);
  const ls = await rhodium.ok("ls");
  expect(ls).toMatch(new RegExp(`^w/here +claude +无头 +\\S+ +${join(rhodium.dir, "w")}$`, "m"));
  expect(ls).toMatch(new RegExp(`^shop/there +claude +无头 +\\S+ +${other}$`, "m"));
  expect(ls).toMatch(new RegExp(`^shop/again +claude +无头 +\\S+ +${other}$`, "m"));
  expect(await rhodium.ok("ls", "shop/there")).toMatch(/^生命周期: 长期$/m);
  expect(told(await runOf("shop/again"))).toEqual(["in shop too"]);
}, 30_000);

test("story 97: child slots are on the board like slots you made, in their workspaces' groups, each with its parent", async () => {
  await begin();
  const other = join(rhodium.dir, "shop");
  mkdirSync(other);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "here", "hi"], ["spawn", "there", "--dir", other, "hi"]) });
  await runOf("shop/there");
  await until(async () => (await rhodium.state("shop/there")) === "空闲", 15_000);

  type Card = { name: string; parent: string | null };
  const r = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const { workspaces } = (await r.json()) as { workspaces: { name: string; groups: Record<string, Card[]> }[] };
  const cards = Object.fromEntries(workspaces.map((w) => [w.name, Object.values(w.groups).flat().map((c) => [c.name, c.parent])]));
  expect(cards).toEqual({ w: [["a", null], ["here", "w/a"]], shop: [["there", "w/a"]] });
}, 30_000);

test("stories 94, 101, 102: a child spawns too, down to the depth limit; past it rh spawn is refused and you are told", async () => {
  await begin({ toml: "[limits]\nmaxDepth = 2" });
  const leaf = plan(["spawn", "c3", "too deep"]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", plan(["spawn", "c2", leaf])]) });

  expect(told(await runOf("w/c2"))).toEqual([leaf]);
  expect(await rhodium.ok("ls", "w/c2")).toMatch(/^父槽位: w\/c1$/m);
  // c2 has no contact chat of its own: you hear in its root's, the chat that messaged w/a.
  const [, notice] = await texts(2);
  expect(notice).toContain("w/c2");
  expect(notice).toContain("派生深度");
  const [refused] = await rhCalls("w/c2", 1);
  expect(refused!.code).toBe(1);
  expect(refused!.err).toContain("派生深度");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c3 /m);
}, 30_000);

test("stories 101, 102: past the children limit rh spawn is refused and you are told; an archived child no longer counts", async () => {
  await begin({ toml: "[limits]\nmaxChildren = 1" });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", "one"], ["spawn", "c2", "two"]) });
  const [notice, reply] = await texts(2);
  expect(reply).toBe("done");
  expect(notice).toContain("w/a");
  expect(notice).toContain("子槽位已到上限 1 个");
  expect((await runOf("w/a")).rh.map((c) => c.code)).toEqual([0, 1]);
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c2 /m);

  await rhodium.ok("archive", "w/c1");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c2", "two"]) });
  expect(told(await runOf("w/c2"))).toEqual(["two"]);
}, 30_000);

test("stories 101, 102: at the running limit an agent's rh spawn is refused and you are told, but your message still wakes a slot", async () => {
  await begin({ toml: "[limits]\nmaxRunning = 2", bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } } });
  await rhodium.ok("new", "w/b");
  // w/a running, and its first child starting: two.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", "one"], ["spawn", "c2", "two"]) });
  const [notice, reply] = await texts(2);
  expect(reply).toBe("done");
  expect(notice).toContain("同时运行的无头槽位已到上限 2 个");
  const [, refused] = (await runOf("w/a")).rh;
  expect([refused!.code, refused!.err]).toEqual([1, expect.stringContaining("同时运行")]);
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c2 /m);

  // Your message is never refused: a third agent starts.
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "hello" });
  expect(await texts(1, "qb")).toEqual(["done"]);
  expect(await rhodium.state("w/b")).toBe("空闲");
}, 30_000);

test("stories 101, 102: a slot's rh calls past the per-minute limit are refused, and you are told once", async () => {
  await begin({ toml: "[limits]\nrhPerMinute = 3" });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["ls"], ["ls"], ["ls"], ["ls"], ["spawn", "c1", "one"]) });
  const [notice, reply] = await texts(2);
  expect(reply).toBe("done");
  expect(notice).toContain("w/a");
  expect(notice).toContain("每分钟 3 次");
  const calls = (await runOf("w/a")).rh;
  expect(calls.map((c) => c.code)).toEqual([0, 0, 0, 1, 1]);
  expect(calls[3]!.err).toContain("每分钟");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c1 /m);
  // You are not limited.
  for (let i = 0; i < 4; i++) await rhodium.ok("ls");
}, 30_000);

/** The slot's state as rh ls --all shows it, archived ones too. */
const stateAll = async (ref: string) => (await rhodium.ok("ls", "--all")).match(new RegExp(`^${ref} +\\S+ +\\S+ +(\\S+)`, "m"))?.[1];

test("stories 89, 100: a one-off child is archived once idle for the archive time, a rhodium restart in between or not; a long-term one is kept", async () => {
  await begin({ toml: '[durations]\noneoffArchive = "1500ms"' });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "once", "one"], ["spawn", "kept", "--longterm", "two"]) });
  await until(async () => (await rhodium.state("w/once")) === "空闲" && (await rhodium.state("w/kept")) === "空闲", 15_000);
  // Timers live in memory: the new rhodium sets the clock again from the slot table.
  await rhodium.stop();
  await rhodium.start();

  await until(async () => (await stateAll("w/once"))?.endsWith("（已归档）") === true, 15_000);
  await Bun.sleep(200);
  expect(await rhodium.state("w/kept")).toBe("空闲");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/once /m);
}, 30_000);

test("story 100: a new turn of a one-off child voids its archive clock, which starts again when it is idle again", async () => {
  // Bot qc lets you message the child directly, once /rh_use points it there: a bot's default
  // target is never archived.
  await begin({
    toml: '[durations]\noneoffArchive = "1s"',
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, qc: { like: "qq", owner: ME, target: "w/a" } },
  });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", "one"]) });
  await until(async () => (await rhodium.state("w/c1")) === "空闲", 15_000);
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "/rh_use w/c1" });
  await texts(1, "qc");
  await Bun.sleep(500);
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "one more thing" });
  expect(await texts(2, "qc")).toEqual(["这里的消息改交给 w/c1。", "done"]);
  const idleAgain = Date.now();

  await until(async () => (await stateAll("w/c1"))?.endsWith("（已归档）") === true, 15_000);
  expect(Date.now() - idleAgain).toBeGreaterThan(800);
  // Archiving reaps the process too.
  await until(async () => (await stateAll("w/c1")) === "未运行（已归档）", 15_000);
}, 30_000);

test("story 100: a one-off child brought back with rh unarchive is archived again once idle for the archive time", async () => {
  await begin({ toml: '[durations]\noneoffArchive = "1s"' });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "c1", "one"]) });
  await until(async () => (await stateAll("w/c1"))?.endsWith("（已归档）") === true, 15_000);

  await rhodium.ok("unarchive", "w/c1");
  const back = Date.now();
  expect(await rhodium.ok("ls")).toMatch(/^w\/c1 /m);
  await until(async () => (await stateAll("w/c1"))?.endsWith("（已归档）") === true, 15_000);
  expect(Date.now() - back).toBeGreaterThan(800);
}, 30_000);

test("rh set lifetime=longterm keeps a one-off child; lifetime=oneoff has a long-term one archived once idle", async () => {
  await begin({ toml: '[durations]\noneoffArchive = "2s"' });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "once", "one"], ["spawn", "kept", "--longterm", "two"]) });
  await until(async () => (await rhodium.state("w/once")) === "空闲" && (await rhodium.state("w/kept")) === "空闲", 15_000);

  expect(await rhodium.ok("set", "w/once", "lifetime=longterm")).toMatch(/^生命周期: 长期$/m);
  await rhodium.ok("set", "w/kept", "lifetime=oneoff");
  expect(await rhodium.ok("ls", "w/once")).toMatch(/^生命周期: 长期$/m);
  expect(await rhodium.ok("ls", "w/kept")).toMatch(/^生命周期: 一次性$/m);

  await until(async () => (await stateAll("w/kept"))?.endsWith("（已归档）") === true, 15_000);
  await Bun.sleep(500);
  expect(await rhodium.state("w/once")).toBe("空闲");

  // Only the two values; a bad one changes nothing.
  for (const bad of ["lifetime=forever", "lifetime=default", "lifetime="]) expect((await rhodium.rh(["set", "w/once", bad])).code).not.toBe(0);
  expect(await rhodium.ok("ls", "w/once")).toMatch(/^生命周期: 长期$/m);
}, 30_000);

test("story 98: /rh_use points a chat at a child the dispatcher spawned; you talk to it there, and its rh send me comes there", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["spawn", "fix", "fix the bug"]) });
  expect(await texts(1)).toEqual(["done"]);
  await until(async () => (await rhodium.state("w/fix")) === "空闲", 15_000);

  // Named like a slot you made, and going round the dispatcher asks no one.
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/rh_use fix" });
  expect(await texts(1, "t")).toEqual([expect.stringContaining("w/fix")]);
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: plan(["send", "me", "from fix"]) });
  expect((await texts(2, "t"))[1]).toBe("from fix");
  expect(told(await runOf("w/fix"))).toEqual(["fix the bug", plan(["send", "me", "from fix"])]);

  // The dispatcher keeps its own chat.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: plan(["send", "me", "from a"]) });
  expect(await texts(2)).toEqual(["done", "from a"]);
  expect(await texts(2, "t")).not.toContain("from a");
}, 30_000);
