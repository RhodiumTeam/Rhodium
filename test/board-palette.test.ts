// The command palette's commands from the board (spec web-write, its fifth ticket): a command typed
// into a slot's chat, or picked from the palette, runs as in IM, on the page's slot; what IM shows as a
// panel comes back to the page as what to pick from, the same candidates; what the agent answers comes
// back to the page too, never to IM. Seen from seam one, through the board's HTTP.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { on, startTurn, state } from "./fake-agent/scripts";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
let base = "";
afterEach(() => rhodium.cleanup());

/** An instance whose bot q sends your private chat to w/a; started, with the slots named made. */
async function begin(opts: InstanceOptions = {}, ...slots: string[]): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a", ...slots);
}
const get = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
const slotId = async (name: string): Promise<string> => {
  const w = (await get("/api/board")).workspaces.find((w: any) => w.name === "w");
  return [...Object.values(w.groups as Record<string, { id: string; name: string }[]>).flat(), ...w.archived].find((c) => c.name === name)!.id;
};
type Candidate = { label: string; command: string; current?: boolean; fill?: string };
type Reply = { ok: true; text: string; panel?: { head: string[]; candidates: Candidate[] }; card?: unknown } | { ok: false; error: string };
/** What rhodium answers text typed into the slot's chat on the board. */
async function say(text: string, slot = "a"): Promise<Reply> {
  const r = await boardAct(base, { kind: "say", slot: await slotId(slot), text });
  expect(r.status).toBe(200);
  return (await r.json()) as Reply;
}
/** The panel of a reply that has one. */
const panelOf = (r: Reply) => {
  if (!r.ok || !r.panel) throw new Error(`no panel: ${JSON.stringify(r)}`);
  return r.panel;
};
const posts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text ?? "");

test("story 407: a Claude slot with no model set names its default on the board by the model it uses", async () => {
  await begin();
  await say("hello");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect((await get(`/api/slot?id=${await slotId("a")}`)).model).toBe("默认（Opus 5.5）");
}, 30_000);

test("stories 297, 299: /model from the board answers with IM's candidates, the one now marked; a pick goes as typed, and a model with levels asks for the level next; IM gets none of it", async () => {
  await begin();
  await say("hello");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const models = panelOf(await say("/model"));
  expect(models.head).toEqual(["换哪个模型？", "现在：默认（Opus 5.5）"]);
  expect(models.candidates.map((c) => [c.label, c.current ?? false])).toEqual([
    ["默认（Opus 5.5）", true],
    ["Haiku", false],
  ]);
  const levels = panelOf(await say(models.candidates[1]!.command));
  expect(levels.head).toEqual(["已切到 Haiku。", "思考强度要改吗？"]);
  expect(levels.candidates.map((c) => c.label)).toEqual(["low", "medium", "high"]);
  expect(await say(levels.candidates[2]!.command)).toEqual({ ok: true, text: "思考强度改成 high。" });
  // Typed whole, as in IM: the same.
  expect(await say("/effort low")).toEqual({ ok: true, text: "思考强度改成 low。" });
  expect(await say("/status")).toMatchObject({ ok: true, text: expect.stringContaining("\n模型：Haiku low\n") });
  await Bun.sleep(300);
  expect(await posts()).toEqual([]);
}, 30_000);

test("stories 300, 387, 393, 406: what a command shows comes as its words, /status, /context and /usage with their data; one the agent cannot do is an error", async () => {
  await begin();
  // Story 406: /status's card has the slot as Rhodium knows it, and the commands of its buttons.
  const status = (await say("/status")) as { ok: true; text: string; card: Record<string, unknown> };
  expect(status.text).toMatch(/^w\/a\n未运行，来消息就启动\n/);
  const dir = status.card.dir;
  expect(status).toEqual({
    ok: true,
    text: status.text,
    card: { command: "status", model: null, context: null, ref: "w/a", agent: "claude", dir, line: "未运行，来消息就启动", actions: ["/model", "/compact", "/new"] },
  });
  // Story 387: a query's answer carries its data, for the page's info card; an action's does not.
  expect(await say("/context")).toEqual({ ok: true, text: "已使用 26% 上下文 (~52k / 200k Tokens)", card: { command: "context", usedTokens: 52_000, maxTokens: 200_000 } });
  // Story 393: /usage's card has every window and the conversation's use, by model too.
  const usage = await say("/usage");
  expect(usage).toMatchObject({ ok: true, text: expect.stringMatching(/^Claude 额度\n12% 5h，/) });
  expect((usage as { card: unknown }).card).toEqual({
    agent: "claude",
    command: "usage",
    limits: [
      { window: "5h", usedPercent: 12, resetsAt: Date.parse("2026-10-21T05:00:00Z") },
      { window: "7d", usedPercent: 52, resetsAt: Date.parse("2026-10-24T21:00:00Z") },
      { window: "7d", model: "Fable", usedPercent: 38, resetsAt: Date.parse("2026-10-24T21:00:00Z") },
    ],
    session: {
      cost: 15.35,
      tokens: { input: 1_800, output: 97_000, cacheRead: 18_200_000, cacheWrite: 612_000, total: 18_910_800 },
      models: [
        { name: "Opus 5.5", cost: 14.92, tokens: { input: 1_800, output: 96_000, cacheRead: 18_200_000, cacheWrite: 612_000, total: 18_909_800 } },
        { name: "Haiku 4.5", cost: 0.43, tokens: { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0, total: 1_000 } },
      ],
    },
  });
  // With Claude's process running, its context and quota windows as /context and /usage have them.
  expect(await say("/status")).toMatchObject({ card: { command: "status", line: "空闲", context: { usedTokens: 52_000, maxTokens: 200_000 }, limits: expect.arrayContaining([{ window: "7d", usedPercent: 52, resetsAt: Date.parse("2026-10-24T21:00:00Z") }]) } });
  expect(await say("/compact")).not.toHaveProperty("card");
  expect(await say("/resume zzz")).toEqual({ ok: false, error: "/resume 没做成。\n原因：这个槽位和目录里没有对话 zzz" });
  expect(await posts()).toEqual([]);
}, 30_000);

test("story 406: mid-turn /status's card offers 停止 and 模型, not 压缩 nor 新对话; its state line says how long the turn has run", async () => {
  await begin({ claude: { script: "until-interrupted" } });
  await rhodium.ok("send", "w/a", "count to a million");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  const status = (await say("/status")) as { card: { line: string; actions: string[] } };
  expect(status.card.line).toMatch(/^运行中，这一回合跑了 \d+ 秒$/);
  expect(status.card.actions).toEqual(["/stop", "/model"]);
}, 30_000);

test("story 405: a turn that a ! began after cutting the last one short counts from its own start", async () => {
  const j = JSON.stringify;
  const cut = [
    j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { still_queued: [] } } }),
    j({ type: "result", subtype: "error_during_execution", is_error: true, result: null, session_id: "{{session_id}}", uuid: "{{uuid}}" }),
    state("idle"),
  ];
  const steps = [...startTurn, { wait: { type: "control_request", request: { subtype: "interrupt" } } }, { emit: cut }, ...startTurn, { wait: { type: "never" } }];
  await begin({ claude: { script: { on, steps } as Script } });
  await rhodium.ok("send", "w/a", "count to a million");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await Bun.sleep(3_000);
  await say("!换个做法");
  const line = async () => ((await say("/status")) as { card: { line: string } }).card.line;
  await until(async () => /^运行中，这一回合跑了 [01] 秒$/.test(await line()), 5_000).catch(async () => expect(await line()).toMatch(/^运行中，这一回合跑了 [01] 秒$/));
}, 30_000);

test("story 387: a /usage with nothing to show, a Claude without get_usage, comes as its sentence, no card", async () => {
  const unsupported = { type: "control_response", response: { subtype: "error", request_id: "{{in.request_id}}", error: "Unsupported control request subtype: get_usage" } };
  await begin({ claude: { script: { on: [{ match: { type: "control_request", request: { subtype: "get_usage" } }, emit: [JSON.stringify(unsupported)] }, ...on!], steps: [] } } });
  expect(await say("/usage")).toEqual({ ok: true, text: "Claude 没有用量可查。" });
}, 30_000);

test("story 301: /resume lists the slot's conversations as IM does; a pick goes back to one", async () => {
  await begin();
  await say("first");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await say("/new");
  const list = panelOf(await say("/resume"));
  expect(list.head).toEqual(["回到哪段对话？", "现在：新对话"]);
  expect(list.candidates.map((c) => c.label)).toEqual([expect.stringMatching(/^\d\d:\d\d first$/)]);
  expect(await say(list.candidates[0]!.command)).toMatchObject({ ok: true, text: expect.stringMatching(/^已回到今天 \d\d:\d\d 那段对话。/) });
}, 30_000);

test("story 261: /rh_agent from the board offers Claude, pi and Codex, the one now marked; a pick switches the page's slot, said on the page alone", async () => {
  await begin();
  const agents = panelOf(await say("/rh_agent"));
  expect(agents.head).toEqual(["w/a 换哪个 agent？", "现在：Claude", "换了会开一段新对话，旧对话发 /resume 能回去。"]);
  expect(agents.candidates).toEqual([
    { label: "Claude", command: "/rh_agent claude", current: true },
    { label: "pi", command: "/rh_agent pi", current: false },
    { label: "Codex", command: "/rh_agent codex", current: false },
  ]);
  expect(await say("/rh_agent pi")).toEqual({ ok: true, text: "w/a 换成了 pi，下一条消息开始新对话。" });
  expect(await rhodium.ok("ls")).toMatch(/^w\/a +pi +/m);
  await Bun.sleep(300);
  expect(await posts()).toEqual([]);
}, 30_000);

test("story 297: a Rhodium command typed on the board is about the page's slot, as one typed in IM is about the chat's; one refused is an error, naming the next step on the board", async () => {
  await begin({}, "c");
  expect(await say("/rh_rename d", "c")).toEqual({ ok: true, text: "已把 w/c 改名为 w/d。" });
  expect(await say("/rh_archive w/a", "d")).toEqual({ ok: false, error: "w/a 是 假 IM Bot 的默认目标，先在拓扑图上给 假 IM Bot 换一个默认目标，再归档。" });
  const archive = panelOf(await say("/rh_archive", "d"));
  expect(archive.candidates.map((c) => c.label)).toEqual(["w/a", "w/d"]);
  expect(await say(archive.candidates[1]!.command, "d")).toEqual({ ok: true, text: "已归档 w/d，对话保留。" });
}, 30_000);

test("story 297: /rh_import on the board lists what the page's slot's directory has to import, as in IM; picked, it asks for the name, what to write offered as such", async () => {
  await begin({ herdr: true });
  // A copy of a real pi transcript, started in w's directory (as import.test.ts's copyTranscript).
  const fixtures = join(import.meta.dir, "fixtures/transcripts/pi");
  const [file] = readdirSync(fixtures);
  const id = file!.replace(/\.jsonl$/, "").replace(/^[^_]*_/, "");
  const session = crypto.randomUUID();
  const dir = join(rhodium.dir, "w");
  const into = join(rhodium.home, ".pi/agent/sessions", `--${dir.replace(/^\//, "").replace(/\//g, "-")}--`);
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, file!.replace(id, session)), readFileSync(join(fixtures, file!), "utf8").replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(dir)}`).replaceAll(id, session));

  const listed = panelOf(await say("/rh_import"));
  expect(listed.head).toEqual([`导入哪一个？Herdr ${rhodium.herdr.session} 会话里正在用的排在前面。`]);
  expect(listed.candidates.map((c) => c.command)).toEqual([`/rh_import ${session} --name`]);
  const naming = panelOf(await say(listed.candidates[0]!.command));
  expect(naming.candidates).toEqual([
    { label: `用 ${session.slice(0, 8)}`, command: `/rh_import ${session} --name ${session.slice(0, 8)}` },
    { label: "自己起名…", command: `/rh_import ${session} --name …`, fill: `/rh_import ${session} --name ` },
  ]);
  expect(await say(`/rh_import ${session} --name imp`)).toMatchObject({ ok: true, text: expect.stringMatching(/^已导入成 w\/imp/) });
  // Again: the way back is the board's.
  expect(await say(`/rh_import ${session} --name imp2`)).toEqual({ ok: false, error: "没能导入，这段对话是 w/imp 用过的。要接着用，打开 w/imp，发 /resume 选它。" });
  expect(await posts()).toEqual([]);
}, 30_000);

test("story 257: what the agent answers later than the board keeps a quiet request open still comes back to the page", async () => {
  // Claude answers /context after 6 s; a request quiet for 1 s may be dropped, which Bun checks every 4 s.
  const usage = { type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { totalTokens: 52_000, maxTokens: 200_000, percentage: 26 } } };
  const steps = [{ wait: { type: "control_request", request: { subtype: "get_context_usage" } } }, { sleep: 6_000 }, { emit: [JSON.stringify(usage)] }];
  await begin({ claude: { script: { on, steps } }, toml: '[durations]\nboardIdle = "1s"' });
  expect(await say("/context")).toMatchObject({ ok: true, text: "已使用 26% 上下文 (~52k / 200k Tokens)" });
}, 30_000);
