// The board's queue (spec web-write, its fourth ticket): what you send from the board while a turn runs
// waits above where you type, and goes as the next turn once this one ends; you may send one in now,
// take one back, or let a paused queue go on. Seen from seam one, through the board's HTTP, with the
// fake agents.
import { afterEach, expect, test } from "bun:test";
import { dirname } from "node:path";
import { installFakeAgent } from "./fake-agent/fake-agent";
import { asking, builtins, endTurn, joinBetweenTools, on, rateLimited, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, boardAct, newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
let base = "";
afterEach(() => rhodium.cleanup());

/** An instance whose bot q sends your private chat to w/a; started, with w/a made. */
async function begin(opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
}
const get = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
let id = "";
const slotId = async (): Promise<string> => (id ||= Object.values((await get("/api/board")).workspaces[0].groups as Record<string, any[]>).flat()[0].id);
afterEach(() => void (id = ""));
type Reply = { ok: true; text: string } | { ok: false; error: string };
const act = async (a: object, rid?: string): Promise<Reply> => {
  const r = await boardAct(base, { slot: await slotId(), ...a }, rid);
  expect(r.status).toBe(200);
  return (await r.json()) as Reply;
};
/** Types text into w/a's chat on the board, under the request id given, and sends it. */
const say = (text: string, rid?: string) => act({ kind: "say", text }, rid);
/** Sends the one queued under its request's id now, or, with none, lets the paused go on. */
const now = (input?: string) => act({ kind: "queued", op: "now", ...(input && { input }) });
const drop = (input: string) => act({ kind: "queued", op: "drop", input });
const stop = () => act({ kind: "common", name: "stop" });
/** w/a's queue as the board has it: each one's words and why it waits. */
const queue = async (): Promise<[string, string][]> => (await get(`/api/slot?id=${await slotId()}`)).queue.map((q: any) => [q.text, q.reason]);
/** The text of each user frame the fake claude got, over all its runs or in run, oldest first. */
const frames = (run?: number) =>
  rhodium.claude
    .runs()
    .filter((_, i) => run === undefined || i === run)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"))
    .map((m) => (m.message.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text);
const prompts = () => rhodium.pi.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "prompt").map((m) => m.message as string));
const posts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text ?? "");
const fromIm = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const becomes = (state: string) => until(async () => (await rhodium.state("w/a")) === state, 15_000);
/** The event table's rows after seq, as the page's event stream brings them, each of which has the page ask afresh. */
async function eventsAfter(seq: number): Promise<{ seq: number }[]> {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "Last-Event-ID": String(seq) }, signal: ac.signal });
  const seen: { seq: number }[] = [];
  const reading = (async () => {
    try {
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) for (const m of chunk.matchAll(/^id: \d+\ndata: (\{.*\})$/gm)) seen.push(JSON.parse(m[1]!));
    } catch {
      // aborted
    }
  })();
  await Bun.sleep(300);
  ac.abort();
  await reading;
  return seen;
}
const web = (text: string) => `[来自 网页]\n${text}`;
/** Each turn takes 1.5 s. */
const long = { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("done"), { goto: 0 }] };

test("stories 283, 284: while a turn runs, what you send from the board waits in the queue, not with the agent; once the turn ends they go one after another, each with its first line; IM hears none of it", async () => {
  await begin({ claude: { script: long } });
  expect(await say("work")).toEqual({ ok: true, text: "起进程，开始新回合" });
  await becomes("运行中");
  expect(await say("顺便看看日志")).toEqual({ ok: true, text: "排队" });
  expect(await say("再跑一遍测试")).toEqual({ ok: true, text: "排队" });
  expect(await queue()).toEqual([
    ["顺便看看日志", "web_queue"],
    ["再跑一遍测试", "web_queue"],
  ]);
  await Bun.sleep(500);
  expect(frames()).toEqual([web("work")]);
  await until(() => frames().length === 3, 15_000);
  expect(frames()).toEqual([web("work"), web("顺便看看日志"), web("再跑一遍测试")]);
  expect(await queue()).toEqual([]);
  await becomes("空闲");
  expect(await posts()).toEqual([]);
}, 30_000);

test("#580: one queued behind an internal turn, handed to the agent as that turn ends, leaves the queue with an event the page hears, the slot running all along", async () => {
  // Each turn takes 3 s: the board's runs on past what the test reads.
  await begin({ claude: { script: { on, steps: [...startTurn, { sleep: 3000 }, ...endTurn("done"), { goto: 0 }] } } });
  await rhodium.ok("send", "w/a", "from the terminal");
  await becomes("运行中");
  expect(await say("排着的")).toEqual({ ok: true, text: "排队" });
  const queued = (await eventsAfter(0)).at(-1)!.seq;
  await until(() => frames().length === 2, 15_000);
  expect(frames()[1]).toBe(web("排着的"));
  expect(await queue()).toEqual([]);
  const heard = await eventsAfter(queued);
  // Still the board's turn: what the page heard was not its end.
  expect(await rhodium.state("w/a")).toBe("运行中");
  expect(heard).not.toEqual([]);
}, 30_000);

test("story 283: with the board's messages queued, a message from IM still joins the turn, and so does the second in the queue sent in now; the first waits for the turn's end", async () => {
  // The turn ends a second after two messages have joined it.
  await begin({ claude: { script: { on, steps: [...startTurn, ...joinBetweenTools, ...joinBetweenTools, { sleep: 1000 }, ...endTurn("看过了"), { goto: 0 }] } } });
  await say("work");
  await becomes("运行中");
  await say("一");
  const two = crypto.randomUUID();
  await say("二", two);
  await fromIm("IM 这句");
  await until(() => frames().length === 2, 15_000);
  // Your message from IM took the turn over: its reply goes there, as you hear.
  expect(await now(two)).toEqual({ ok: true, text: "已并入 假 IM 私聊那边正在跑的回合，回复会发在那边。" });
  expect(await queue()).toEqual([["一", "web_queue"]]);
  await until(() => frames().length === 4, 15_000);
  expect(frames()).toEqual([web("work"), "[来自 假 IM 私聊]\nIM 这句", web("二"), web("一")]);
}, 30_000);

test("story 285: a stop pauses the queue: neither the turn's end nor an internal turn after it lets it go, and a message sent while idle begins a turn alone; only 继续 does", async () => {
  // The first turn runs until interrupted; the rest end by themselves.
  const interrupted = builtins["until-interrupted"]!.steps.slice(0, startTurn.length + 4);
  await begin({ claude: { script: { on, steps: [...interrupted, ...startTurn, ...endTurn("done"), { goto: interrupted.length }] } } });
  await say("work");
  await becomes("运行中");
  await say("排着的");
  expect(await stop()).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
  expect(await queue()).toEqual([["排着的", "web_paused"]]);
  await becomes("空闲");
  await rhodium.ok("send", "w/a", "from the terminal");
  await until(() => frames().length === 2, 15_000);
  await becomes("空闲");
  expect(await say("新的一句")).toEqual({ ok: true, text: "开始新回合" });
  await until(() => frames().length === 3, 15_000);
  await becomes("空闲");
  await Bun.sleep(300);
  expect(await queue()).toEqual([["排着的", "web_paused"]]);
  expect(frames()).toHaveLength(3);
  expect((await now()).ok).toBe(true);
  await until(() => frames().length === 4, 15_000);
  expect(frames()[3]).toBe(web("排着的"));
  expect(await queue()).toEqual([]);
}, 30_000);

test("story 283: one sent in now while idle begins a turn; 继续 while a turn runs waits for its end; one taken off never goes, and one gone already cannot be taken off", async () => {
  await begin({ claude: { script: long } });
  await say("work");
  await becomes("运行中");
  const [one, two, three] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await say("一", one);
  await say("二", two);
  await say("三", three);
  expect(await drop(three)).toEqual({ ok: true, text: "删掉了。" });
  // 详情 says so under it.
  const events = await get(`/api/slot-events?id=${await slotId()}`);
  expect(events.find((e: any) => e.type === "board_routed" && e.text === "三").why).toBe("删掉了");
  await stop();
  await becomes("空闲");
  expect(await queue()).toEqual([
    ["一", "web_paused"],
    ["二", "web_paused"],
  ]);
  expect(await now(two)).toEqual({ ok: true, text: "开始新回合" });
  await becomes("运行中");
  expect((await now()).ok).toBe(true);
  expect(await queue()).toEqual([["一", "web_queue"]]);
  expect(frames()).toEqual([web("work"), web("二")]);
  await until(() => frames().length === 3, 15_000);
  expect(frames()[2]).toBe(web("一"));
  expect(await drop(one)).toEqual({ ok: false, error: "这条已经交给 agent 了。" });
  await becomes("空闲");
  await Bun.sleep(300);
  expect(frames()).toHaveLength(3);
}, 30_000);

test("an agent launched in the old approval mode is kept at the turn's end while the board's messages are queued, and they go to it", async () => {
  const refuse = {
    match: { type: "control_request", request: { subtype: "set_permission_mode" } },
    emit: [JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "{{in.request_id}}", error: "disabled by settings" } })],
  };
  await begin({ claude: { script: { ...long, on: [refuse, ...on!] } } });
  await rhodium.ok("set", "w/a", "approval=on");
  await say("work");
  await becomes("运行中");
  await rhodium.ok("set", "w/a", "approval=off");
  await say("一");
  await until(() => frames().length === 2, 15_000);
  expect(frames()[1]).toBe(web("一"));
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 30_000);

test("the queue goes with the slot to a new conversation, paused: /new, and rh agent waiting for the turn's end", async () => {
  await begin({ claude: { script: long }, pi: { script: "pi-turn" } });
  await say("work");
  await becomes("运行中");
  await say("一");
  await fromIm("/new");
  await until(async () => (await queue()).length === 1 && (await queue())[0]![1] === "web_paused", 15_000);
  await Bun.sleep(300);
  expect(frames()).toEqual([web("work")]);
  await now();
  await until(() => frames(1).length === 1, 15_000);
  expect(frames(1)).toEqual([web("一")]);

  await say("二");
  await rhodium.ok("agent", "w/a", "pi");
  await until(async () => (await rhodium.ok("ls")).includes("pi"), 15_000);
  expect(await queue()).toEqual([["二", "web_paused"]]);
  expect(rhodium.pi.runs()).toHaveLength(0);
  await now();
  await until(() => prompts().length === 1, 15_000);
  expect(prompts()).toEqual([web("二")]);
}, 30_000);

test("story 287: switching to the terminal gives the board's queued messages back, paused ones too: each on record with its words, and IM quotes none of them", async () => {
  await begin({ claude: { script: long }, herdr: true });
  // Your private chat is w/a's contact chat, where a notice quoting them would go.
  await fromIm("hi");
  await until(async () => (await posts()).includes("done"), 15_000);
  await say("work");
  await becomes("运行中");
  await say("一");
  await stop();
  await becomes("空闲");
  await say("work again");
  await becomes("运行中");
  await say("二");
  await rhodium.ok("tui", "w/a");
  await until(async () => (await queue()).length === 0, 15_000);
  const events = await get(`/api/slot-events?id=${await slotId()}`);
  expect(events.filter((e: any) => e.type === "input_returned").map((e: any) => [e.data.text, e.data.why])).toEqual([
    ["一", "切到 TUI 了"],
    ["二", "切到 TUI 了"],
  ]);
  await until(async () => (await posts()).some((t) => t.startsWith("w/a 切到 TUI 了")), 15_000);
  expect((await posts()).filter((t) => t.includes("排着"))).toEqual([]);
  expect(frames().map((f) => withoutSource(f!))).toEqual(["hi", "work", "work again"]);
}, 30_000);

test("story 285: stopping the agent's process pauses the queue as you press it; a crash mid-turn leaves it paused too", async () => {
  // The first agent ignores TERM, so its stop takes stopGrace; the second crashes mid-turn.
  const steps = [{ ignore: "SIGTERM" as const }, ...startTurn, { sleep: 5000 }, ...endTurn("done")];
  await begin({ claude: { script: { on, steps } }, toml: '[durations]\nstopGrace = "2s"\n[defaults]\ncrashResume = false' });
  await say("work");
  await becomes("运行中");
  await say("一");
  expect((await act({ kind: "rh", argv: ["stop", "w/a"] })).ok).toBe(true);
  expect(await queue()).toEqual([["一", "web_paused"]]);
  await becomes("未运行");
  installFakeAgent(dirname(rhodium.claude.path), { script: { on, steps: [...startTurn, { sleep: 500 }, { exit: 1 }] } });
  await say("again");
  await becomes("运行中");
  await say("二");
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);
  expect(await queue()).toEqual([
    ["一", "web_paused"],
    ["二", "web_paused"],
  ]);
  expect(frames()).toEqual([web("work"), web("again")]);
}, 30_000);

test("stories 285, 286: a ! from the board is held by Rhodium till the interrupt takes effect, listed in the queue by why, and can only be taken off; the interrupted turn leaves the queue paused", async () => {
  // The interrupt is answered, but the turn goes on to its end.
  await begin({ claude: { script: long } });
  await say("work");
  await becomes("运行中");
  await say("一");
  const bang = crypto.randomUUID();
  expect(await say("!换个做法", bang)).toEqual({ ok: true, text: "打断当前回合，再开始新回合" });
  expect(await queue()).toEqual([
    ["一", "web_queue"],
    ["换个做法", "after_interrupt"],
  ]);
  expect(await now(bang)).toEqual({ ok: false, error: "这条在等 Rhodium 放行，只能删掉。" });
  expect(await drop(bang)).toEqual({ ok: true, text: "删掉了。" });
  await becomes("空闲");
  expect(await queue()).toEqual([["一", "web_paused"]]);
  await Bun.sleep(300);
  expect(frames()).toEqual([web("work")]);
}, 30_000);

test("a switch to the terminal that fails leaves the paused queue paused and the slot not running: the board's next message begins a turn", async () => {
  // No Herdr running: the switch fails.
  await begin({ claude: { script: long } });
  await say("work");
  await becomes("运行中");
  await say("排着的");
  await stop();
  await becomes("空闲");
  await rhodium.ok("tui", "w/a");
  await until(async () => (await get(`/api/slot-events?id=${await slotId()}`)).some((e: any) => e.type === "tui_failed"), 15_000);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(await queue()).toEqual([["排着的", "web_paused"]]);
  expect(await say("新的一句")).toEqual({ ok: true, text: "起进程，开始新回合" });
  await until(() => frames().length === 2, 15_000);
  expect(frames()).toEqual([web("work"), web("新的一句")]);
}, 30_000);

test("继续 while the slot waits for Claude's quota: the paused go in at the reset, as one sent then would, though auto-continue is off", async () => {
  await begin({ claude: { script: long } });
  await rhodium.ok("set", "w/a", "auto-continue=off");
  await say("work");
  await becomes("运行中");
  await say("一");
  expect((await act({ kind: "rh", argv: ["stop", "w/a"] })).ok).toBe(true);
  await becomes("未运行");
  installFakeAgent(dirname(rhodium.claude.path), { script: rateLimited(Math.ceil(Date.now() / 1000) + 2, true) });
  await say("again");
  await becomes("等额度");
  expect(await queue()).toEqual([["一", "web_paused"]]);
  const r = await now();
  expect(r.ok && r.text).toStartWith("w/a 在等 Claude 额度");
  expect(await queue()).toEqual([["一", "after_quota"]]);
  await until(() => frames().length === 3, 15_000);
  expect(frames()).toEqual([web("work"), web("again"), web("一")]);
}, 30_000);

test("with an ask waiting on you, one in the queue is not sent in: answer the ask first", async () => {
  await begin({ claude: { script: asking([["ask-1", "Bash", { command: "make" }]], { delay: 1000 }) } });
  await say("go");
  await becomes("运行中");
  const one = crypto.randomUUID();
  expect(await say("一", one)).toEqual({ ok: true, text: "排队" });
  await becomes("需要你");
  expect(await now(one)).toEqual({ ok: false, error: "w/a 有提问在等你，先答提问。" });
  expect(await queue()).toEqual([["一", "web_queue"]]);
}, 30_000);
