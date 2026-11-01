// Messages from the board (spec web-write, its second ticket): what you type at the bottom of a slot's
// chat reaches its agent as from IM, its first line [来自 网页]; the turn it begins is the board's, whose
// words and reply IM never gets, until a message or an answer of yours from IM takes it over. Seen from
// seam one, through the board's HTTP.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFakeAgent, type Script } from "./fake-agent/fake-agent";
import { asking, builtins, endTurn, joinBetweenTools, on, rateLimited, state as session, startTurn, toolResult, toolUse } from "./fake-agent/scripts";
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
type Reply = { ok: true; text: string } | { ok: false; error: string };
/** What rhodium answers text typed into the slot's chat on the board. */
async function say(text: string, slot = "a", id?: string): Promise<Reply> {
  const r = await boardAct(base, { kind: "say", slot: await slotId(slot), text }, id);
  expect(r.status).toBe(200);
  return (await r.json()) as Reply;
}
/** Sends the message queued on the board under that request id in now. */
const now = async (input: string, slot = "a"): Promise<Reply> => (await boardAct(base, { kind: "queued", slot: await slotId(slot), op: "now", input })).json() as Promise<Reply>;
/** The text of each user frame the fake claude got, over all its runs, oldest first. */
const frames = (run?: number) =>
  rhodium.claude
    .runs()
    .filter((_, i) => run === undefined || i === run)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"))
    .map((m) => (m.message.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text);
const posts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text ?? "");
const fromIm = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const becomes = (state: string, ref = "w/a") => until(async () => (await rhodium.state(ref)) === state, 15_000);

test("stories 272, 274, 281: a message from the board starts its slot and a turn, its first line [来自 网页]; IM gets nothing of the turn, its reply neither", async () => {
  await begin();
  const id = crypto.randomUUID();
  expect(await say("hello", "a", id)).toEqual({ ok: true, text: "起进程，开始新回合" });
  await until(() => frames().length === 1, 15_000);
  expect(frames()).toEqual(["[来自 网页]\nhello"]);
  await becomes("空闲");
  // A second one starts the next turn in the running agent.
  expect(await say("again")).toEqual({ ok: true, text: "开始新回合" });
  await until(() => frames().length === 2, 15_000);
  await becomes("空闲");
  await Bun.sleep(300);
  expect(await posts()).toEqual([]);
  // 详情 says it came, as for one from IM, under the request's id.
  const events = await get(`/api/slot-events?id=${await slotId("a")}`);
  expect(events.filter((e: any) => e.type === "board_routed").map((e: any) => [e.source, e.text])).toEqual([
    ["board", "hello"],
    ["board", "again"],
  ]);
}, 30_000);

test("story 274: a message from IM in the middle of a turn the board began takes the turn over: the rest, its reply too, goes to that chat", async () => {
  // The turn waits in its tool call until a message joins it.
  const script: Script = { on, steps: [...startTurn, toolUse("toolu_ls", "Bash", { command: "ls" }), ...joinBetweenTools, toolResult("toolu_ls"), ...endTurn("看过了"), { goto: 0 }] };
  await begin({ claude: { script } });
  await say("看一下");
  await becomes("运行中");
  await Bun.sleep(300);
  expect(await posts()).toEqual([]);
  await fromIm("顺便看看日志");
  await until(async () => (await posts()).some((t) => t.includes("看过了")), 15_000);
}, 30_000);

test("story 275: answering in IM an ask of a turn the board began takes the turn over: its reply goes to that chat", async () => {
  await begin({ claude: { script: asking([["ask-1", "Bash", { command: "make" }]]) } });
  // Your private chat with the bot, where asks of w/a go, is on record once you have written there.
  await fromIm("/rh_help");
  await until(async () => (await posts()).length === 1, 15_000);
  await say("go");
  await becomes("需要你");
  // The ask is pushed to IM, as ever.
  await until(async () => (await posts()).some((t) => t.includes("make")), 15_000);
  await fromIm("1");
  await until(async () => (await posts()).includes("answered"), 15_000);
}, 30_000);

test("story 274: while rh stop ends the turn, a message from the board waits for the restart, and one from IM after it takes the restarted turn over", async () => {
  // The agent ignores TERM: the stop takes stopGrace, then KILL. Each turn replies once a second
  // message has joined it.
  const script: Script = { on, steps: [{ ignore: "SIGTERM" }, ...startTurn, ...joinBetweenTools, ...endTurn("done"), { goto: 1 }] };
  await begin({ claude: { script }, toml: '[durations]\nstopGrace = "1s"' });
  await fromIm("work");
  await becomes("运行中");
  await rhodium.ok("stop", "w/a");
  expect(await say("网页这句")).toEqual({ ok: true, text: "正在停止，停完再起进程" });
  await fromIm("IM 这句");
  await until(async () => (await posts()).includes("done"), 15_000);
  expect(rhodium.claude.runs()).toHaveLength(2);
  expect(frames(1)).toEqual(["[来自 网页]\n网页这句", "[来自 假 IM 私聊]\nIM 这句"]);
}, 30_000);

test("story 274: a message from IM after a ! from the board, before the interrupt takes effect, takes the next turn over: its reply goes to that chat", async () => {
  // The turn runs until interrupted, and ends 1.5 s after; the next takes both messages held meanwhile.
  const interrupted = builtins["until-interrupted"]!.steps.slice(0, startTurn.length + 4).map((s) => ("sleep" in s ? { sleep: 1500 } : s));
  const steps = [...interrupted, ...startTurn, { wait: { type: "user" } }, ...endTurn("fake reply")];
  await begin({ claude: { script: { on, steps } } });
  await say("work");
  await becomes("运行中");
  expect(await say("!换个做法")).toEqual({ ok: true, text: "打断当前回合，再开始新回合" });
  await fromIm("IM 这句");
  await until(async () => (await posts()).includes("fake reply"), 15_000);
  expect(frames().slice(0, 3)).toEqual(["[来自 网页]\nwork", "[来自 网页]\n换个做法", "[来自 假 IM 私聊]\nIM 这句"]);
}, 30_000);

test("story 274: a message from IM while a turn the board began waits for Claude's quota takes it over: at the reset, its reply goes to that chat", async () => {
  await begin();
  installFakeAgent(dirname(rhodium.claude.path), { script: rateLimited(Math.ceil(Date.now() / 1000) + 4, true) });
  await say("work");
  await becomes("等额度");
  await fromIm("IM 这句");
  await until(async () => (await posts()).includes("fake reply"), 15_000);
}, 30_000);

test("a message from the board's queue sent in now that reaches the agent just as its last turn ends begins the next turn, the board's: one more sent in now joins it", async () => {
  // This claude holds its idle line back until the second message reaches it, as in #129's test.
  const steps = [...startTurn, { wait: { type: "user" } }, ...endTurn("reply to first"), { emit: [session("running")] }, { wait: { type: "user" } }, ...endTurn("reply to second")];
  await begin({ claude: { script: { on, steps } } });
  await fromIm("first");
  await becomes("运行中");
  // Mid-turn, what you send from the board waits in its queue (spec web-write "待发队列").
  const [second, third] = [crypto.randomUUID(), crypto.randomUUID()];
  expect(await say("second", "a", second)).toEqual({ ok: true, text: "排队" });
  expect(await now(second)).toEqual({ ok: true, text: "已并入 假 IM 私聊那边正在跑的回合，回复会发在那边。" });
  await until(async () => (await posts()).includes("reply to first"), 15_000);
  await Bun.sleep(300);
  expect(await say("third", "a", third)).toEqual({ ok: true, text: "排队" });
  expect(await now(third)).toEqual({ ok: true, text: "插话" });
  await until(() => frames().length === 3, 15_000);
  await Bun.sleep(300);
  expect(await posts()).toEqual(["reply to first"]);
}, 30_000);

test("a message from the board that waited longer than durations.sentAtAfter says when you sent it, as one from IM does", async () => {
  await begin({ toml: '[durations]\nprogramWait = "10s"\nsentAtAfter = "1s"', env: { TZ: "UTC" } });
  const claude = rhodium.claude.path;
  renameSync(claude, `${claude}.updating`);
  const sent = Date.now();
  await say("hi");
  await Bun.sleep(1500);
  renameSync(`${claude}.updating`, claude);
  await until(() => frames().length === 1, 15_000);
  expect(frames()).toEqual([`[来自 网页，发送于 ${new Date(sent).toISOString().slice(11, 16)}]\nhi`]);
}, 30_000);

test("story 279: ! and the commands Rhodium knows work as in IM: a bare ! stops the turn, ! before words interrupts and sends them; a / command it does not know goes to the agent as typed", async () => {
  // Each turn runs until interrupted.
  const steps = builtins["until-interrupted"]!.steps;
  await begin({ claude: { script: { on, steps: [...steps.slice(0, startTurn.length + 4), { goto: 0 }] } } });
  await say("work");
  await becomes("运行中");
  expect(await say("!换个做法")).toEqual({ ok: true, text: "打断当前回合，再开始新回合" });
  await until(() => frames().length === 2, 15_000);
  await becomes("运行中");
  expect(await say("!")).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
  await becomes("空闲");
  await say("/btw 还在吗");
  await until(() => frames().length === 3, 15_000);
  expect(await say("/stop")).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
  await becomes("空闲");
  expect(frames()).toEqual(["[来自 网页]\nwork", "[来自 网页]\n换个做法", "/btw 还在吗"]);
}, 30_000);

test("story 279: the Rhodium commands the board does elsewhere only say where; nothing changes, and nothing reaches the agent", async () => {
  await begin();
  const before = await rhodium.ok("ls");
  const where: [string, string][] = [
    ["/rh_use dispatcher/main", "改绑定在拓扑图上做。"],
    ["/rh_bind", "改绑定在拓扑图上做。"],
    ["/rh_verbose on", "工具行的写法在拓扑图上改：点开那个窗口的详情。"],
    ["/rh_ls", "槽位都在首页和拓扑图上。"],
    ["/rh_help", "打 / 看命令面板。"],
    ["/rh_release", "点横幅上的“收回终端”把它切回无头。"],
  ];
  for (const [typed, said] of where) expect([typed, await say(typed)]).toEqual([typed, { ok: true, text: said }]);
  expect(await rhodium.ok("ls")).toBe(before);
  expect(rhodium.claude.runs()).toHaveLength(0);
}, 30_000);

test("story 278: with an ask waiting on you, a message from the board is turned away, saying to answer it first", async () => {
  await begin({ claude: { script: asking([["ask-1", "Bash", { command: "make" }]]) } });
  await say("go");
  await becomes("需要你");
  expect(await say("还有一件事")).toEqual({ ok: false, error: "w/a 有提问在等你，先答提问。" });
  expect(frames()).toEqual(["[来自 网页]\ngo"]);
}, 30_000);

test("story 278: short of free disk, a message from the board to a slot not running is turned away, saying why", async () => {
  await begin();
  // Restarted wanting more free disk than any disk has.
  await rhodium.kill9();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace("[programs]", "[limits]\nminFreeMB = 1024000000\n[programs]"));
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  const r = await say("hello");
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toMatch(/^磁盘只剩 [\d.]+ GB，这条没交给 w\/a。清出空间再发。$/);
  expect(rhodium.claude.runs()).toHaveLength(0);
}, 30_000);

test("a message from the board to an archived slot reaches it as from IM, and brings the slot back", async () => {
  await begin({}, "b");
  await rhodium.ok("archive", "w/b");
  expect(await say("醒醒", "b")).toEqual({ ok: true, text: "起进程，开始新回合" });
  await until(() => frames().length === 1, 15_000);
  expect(await rhodium.ok("ls")).toContain("w/b ");
}, 30_000);

test("rh send to a slot in a turn the board began waits for that turn to end, as for a turn begun from IM", async () => {
  const script: Script = { on, steps: [...startTurn, { sleep: 2000 }, ...endTurn("done"), { goto: 0 }] };
  await begin({ claude: { script } });
  await say("long");
  await becomes("运行中");
  await rhodium.ok("send", "w/a", "from the terminal");
  await Bun.sleep(500);
  expect(frames()).toHaveLength(1);
  await until(() => frames().length === 2, 15_000);
  expect(frames()[1]).toContain("from the terminal");
}, 30_000);

test("#493: each change of state in a turn the board began says so, from any page: the web reminds of its end alone; one begun from IM or by rh send does not", async () => {
  await begin();
  await say("from the web");
  await until(() => frames().length === 1, 15_000);
  await becomes("空闲");
  await fromIm("from IM");
  await until(async () => (await posts()).length === 1, 15_000);
  await becomes("空闲");
  await rhodium.ok("send", "w/a", "from the terminal");
  await until(() => frames().length === 3, 15_000);
  await becomes("空闲");
  await rhodium.stop();
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const states = db.query("SELECT data FROM event WHERE type = 'slot_state' ORDER BY seq").all() as { data: string }[];
  db.close();
  expect(states.map((e) => JSON.parse(e.data)).map((d) => (d.web ? `${d.state} web` : d.state))).toEqual(["starting web", "running web", "idle web", "running", "idle", "running", "idle"]);
}, 30_000);

/** A PNG of one pixel. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("story 276: a message with a picture and a file goes as one from IM does: each kept under media/, a line each, and the picture shown to the agent", async () => {
  await begin();
  const form = new FormData();
  form.set("id", crypto.randomUUID());
  form.set("slot", await slotId("a"));
  form.set("text", "看看这张图");
  form.append("file", new File([PNG], "shot.png", { type: "image/png" }));
  form.append("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
  const r = await fetch(`${base}/api/send`, { method: "POST", headers: { "Tailscale-User-Login": BOARD_LOGIN, "sec-fetch-site": "same-origin" }, body: form });
  expect(await r.json()).toEqual({ ok: true, text: "起进程，开始新回合" });
  await until(() => frames().length === 1, 15_000);
  const media = `${rhodium.dir}/state/media/`;
  expect(frames()[0]).toMatch(new RegExp(`^\\[来自 网页\\]\\n看看这张图\\n\\[图片\\] ${media}[0-9a-f]{64}\\n\\[文件\\] notes\\.txt：${media}[0-9a-f]{64}$`));
  const frame = rhodium.claude.runs()[0]!.stdin.map((l) => JSON.parse(l)).find((m) => m.type === "user");
  expect(frame.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
}, 30_000);
