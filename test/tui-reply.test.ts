// Your message typed into a slot's terminal gets its reply back where you sent it (stories 618, 619, 620,
// 625, 627, 628, docs/spec/tui-user-input.md, architecture §10.6): the turn starts where the agent took
// your message in, ends at its own mark or once Herdr says idle twice after its last line, and its last
// words go to your chat, as headless; not after an rh send me there, nor for a turn cut short. What it
// says and does on the way goes there too, as headless shows a turn as it goes. The fake Herdr's
// pane shows a recorded Claude screen; the transcript lines are Claude's, as recorded in
// test/fixtures/herdr/turns.jsonl.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectDir, type Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { call } from "./fake-herdr/fake-herdr";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance } from "./instance";

const screen = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/herdr/claude-screens.jsonl"), "utf8")
      .split("\n")
      .find((l) => l.includes(`"name":"${name}"`))!,
  ).text as string;
const EMPTY = screen("empty-bare");

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, ...endTurn("done"), { goto: 0 }] };
let rhodium: Instance;
let board = "";
afterEach(() => rhodium?.cleanup());

/** An instance with a fake Herdr, bot q (QQ) and bot t (Telegram) going to w/a, w/a switched to the
 *  terminal after a turn, type-in left to its default. Returns the pane, its session's transcript, and
 *  the slot's id. */
async function inTerminal() {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script: obey }, herdr: true, toml: `[durations]\ntuiConfirm = "3s"` });
  const daemon = await rhodium.start();
  board = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  await say("hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);
  await say("/rh_tui");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式" && (await sent()).some((t) => t.includes("切到 TUI 了")), 15_000);
  const pane = (await herdr("session.snapshot")).snapshot.panes[0].pane_id as string;
  await status(pane, "idle");
  await until(() => rows("SELECT tuiInput FROM slot")[0]?.tuiInput === "ready", 10_000);
  const slot = rows("SELECT id FROM slot")[0].id as string;
  const file = join(rhodium.home, ".claude/projects", claudeProjectDir(join(rhodium.dir, "w")), `${session}.jsonl`);
  return { pane, file, slot };
}
const say = (text: string, bot = "q") => rhodium.im.inject(bot, { chat: ME, sender: ME, text });
const herdr = async (method: string, params: object = {}) => (await call(rhodium.herdr.socket, method, params)).result;
const status = (pane: string, s: string) => herdr("fake.set_screen", { pane_id: pane, text: EMPTY, status: s });
const calls = async (method: string) => ((await herdr("fake.calls")).calls as { method: string; params: any }[]).filter((c) => c.method === method);
const queue = async (slot: string) => ((await (await fetch(`${board}/api/slot?id=${slot}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as any).queue as { text: string; from: string; wait?: string }[];
/** What a bot sent to your chat since the n-th message. */
const sent = async (n = 0, bot = "q") => (await rhodium.im.log(bot, ME)).slice(n).map((p) => p.text);
function write(file: string, ...lines: object[]) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.map((l) => JSON.stringify({ timestamp: new Date().toISOString(), isSidechain: false, ...l }) + "\n").join(""));
}
const user = (content: string) => ({ type: "user", message: { role: "user", content } });
let ids = 0;
const said = (text: string, id = `msg_${++ids}`) => ({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
const tool = (id = `msg_${++ids}`) => ({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: `toolu_${ids}`, name: "Read", input: { file_path: "/tmp/x" } }] } });
const ended = { type: "system", subtype: "turn_duration", durationMs: 1000 };
const run = (id: string, name: string, input: object) => ({ type: "assistant", message: { id: `msg_${++ids}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const enqueue = (content: string) => ({ type: "queue-operation", operation: "enqueue", content });
const queued = (prompt: string) => ({ type: "attachment", attachment: { type: "queued_command", prompt, origin: { kind: "human" } } });
/** Says it from bot, and waits for it typed in: the n-th text Enter was pressed for. Returns what was typed. */
async function typeIn(text: string, n: number, bot = "q"): Promise<string> {
  await say(text, bot);
  await until(async () => (await calls("pane.send_keys")).length === n, 10_000);
  return (await calls("pane.send_input"))[n - 1]!.params.text;
}
function rows(sql: string): any[] {
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

test("story 618: typed in while idle, with defaults.typeIn left as it is: no end while Herdr says idle and nothing came after your line, nor at once when the agent's first words follow two idle reads; then two idle reads after its last line send its last words to your chat, and the turn's fields go", async () => {
  const { pane, file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("看下测试为什么挂了", 1);
  expect(typed).toBe("[来自 假 IM Bot q 的私聊]\n看下测试为什么挂了");
  write(file, user(typed));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  await Bun.sleep(3000); // Herdr idle all along, nothing of the agent's past your line
  expect(await sent(n)).toEqual([]);
  // Its words come as Herdr still says idle: the idle reads before them count for nothing.
  const at = Date.now();
  write(file, said("先看日志。"), tool(), said("是超时，已经修好。"));
  // What it said before its last goes as it goes (story 619); the last waits for the turn's end.
  await until(async () => (await sent(n)).length === 2, 10_000);
  expect(Date.now() - at).toBeGreaterThan(1500);
  expect(await sent(n)).toEqual(["先看日志。", "是超时，已经修好。"]);
  expect(rows("SELECT turnChat, turnInbound, turnSentMe, turnStartedAt FROM slot")[0]).toEqual({ turnChat: null, turnInbound: null, turnSentMe: null, turnStartedAt: null });
  expect(rows("SELECT progress FROM conversation WHERE progress IS NOT NULL")).toEqual([]);
  // The headless turn's before the switch, and this one's.
  expect(rows("SELECT type FROM event WHERE type = 'final_reply'")).toHaveLength(2);
  void pane;
}, 60_000);

test("story 625: typed in while Claude works on a turn you began by hand in the terminal: queued, what it says before your message joins is not its reply, its turn_duration line ends the turn though Herdr still says working, and the reply is what came after; on Telegram too", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("帮我看看 README"), said("在看了。"));
  const n = (await sent(0, "t")).length;
  const typed = await typeIn("顺便看下 LICENSE", 1, "t");
  expect(typed).toBe("[来自 假 IM Bot t 的私聊]\n顺便看下 LICENSE");
  write(file, enqueue(typed));
  await until(() => rows("SELECT status FROM agentInput WHERE source = 'human' ORDER BY id DESC")[0].status === "taken", 5_000);
  write(file, said("README 没问题。"), queued(typed), said("LICENSE 是 MIT。"), ended);
  await until(async () => (await sent(n, "t")).length === 1, 10_000);
  expect(await sent(n, "t")).toEqual(["LICENSE 是 MIT。"]);
}, 60_000);

test("probe 3, story 625: typed in while Claude works on a turn with no tool calls, run after it as a user line of its own, Herdr saying idle a second late: no end before its own words, then its words are the reply", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("写一段关于海的话"));
  const n = (await sent()).length;
  const typed = await typeIn("再回一个 y", 1);
  write(file, enqueue(typed));
  // As recorded: the last turn's words, the dequeue, its end, then yours on a line of its own.
  write(file, said("海从不停歇。"), { type: "queue-operation", operation: "dequeue" }, ended, user(typed));
  await Bun.sleep(1000);
  await status(pane, "idle");
  await Bun.sleep(2500);
  expect(await sent(n)).toEqual([]);
  write(file, said("y"), ended);
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect(await sent(n)).toEqual(["y"]);
}, 60_000);

test("story 620: two chats each send one into the terminal's turn: the second hears it joined the first's, whose chat gets the reply", async () => {
  const { pane, file } = await inTerminal();
  const [nq, nt] = [(await sent()).length, (await sent(0, "t")).length];
  const first = await typeIn("第一条", 1);
  write(file, user(first));
  await status(pane, "working");
  const second = await typeIn("第二条", 2, "t");
  write(file, enqueue(second), said("先回第一条。"), queued(second));
  await until(async () => (await sent(nt, "t")).length === 1, 10_000);
  expect(await sent(nt, "t")).toEqual(["已并入 假 IM Bot q 的私聊那边正在跑的回合，回复会发在那边。"]);
  write(file, said("两条都看了。"), ended);
  await until(async () => (await sent(nq)).length === 2, 10_000);
  expect(await sent(nq)).toEqual(["先回第一条。", "两条都看了。"]);
  await Bun.sleep(1500);
  expect(await sent(nt, "t")).toHaveLength(1);
}, 60_000);

test("story 620: two of yours run as one user line: both start there, the reply goes once, and internal messages go in after it", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("写一段关于海的话"));
  const n = (await sent()).length;
  const first = await typeIn("第一条", 1);
  write(file, enqueue(first));
  const second = await typeIn("第二条", 2);
  write(file, enqueue(second), said("海从不停歇。"), { type: "queue-operation", operation: "dequeue" }, ended, user(`${first}\n${second}`), said("两条都看了。"), ended);
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect(await sent(n)).toEqual(["两条都看了。"]);
  expect(rows("SELECT turnChat FROM slot")[0].turnChat).toBeNull();
  await status(pane, "idle");
  await rhodium.ok("send", "w/a", "汇报一下");
  await until(async () => (await calls("pane.send_keys")).length === 3, 10_000);
}, 60_000);

test("story 620: one of yours taken into a turn you began by hand, then gone from the terminal: once a later one of yours starts a turn it is dropped, the turn is the later one's, and nothing waits after it", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("帮我看看 README"));
  const nt = (await sent(0, "t")).length;
  const stale = await typeIn("这条后来删了", 1);
  write(file, enqueue(stale));
  await until(() => rows("SELECT status FROM agentInput WHERE source = 'human' ORDER BY id DESC")[0].status === "taken", 5_000);
  // Esc puts it back in the box, and you delete it there: its start is never written.
  write(file, user("[Request interrupted by user]"), ended);
  await status(pane, "idle");
  const later = await typeIn("看下 LICENSE", 2, "t");
  write(file, user(later), said("LICENSE 是 MIT。"), ended);
  await until(async () => (await sent(nt, "t")).length === 1, 10_000);
  expect(await sent(nt, "t")).toEqual(["LICENSE 是 MIT。"]);
  expect(rows("SELECT turnChat FROM slot")[0].turnChat).toBeNull();
  await rhodium.ok("send", "w/a", "汇报一下");
  await until(async () => (await calls("pane.send_keys")).length === 3, 10_000);
}, 60_000);

test("story 628: an rh send me with words to the turn's chat holds back what follows and the final reply; your next message from there joining the turn lifts the hold", async () => {
  const { pane, file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("跑一下全量测试", 1);
  write(file, user(typed));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  // The agent in the terminal runs rh as the slot: the pane's env says which.
  const env = (await calls("layout.apply"))[0]!.params.root.env;
  const rh = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), "rh", "send", "me", "测试开始跑了"], { env: { ...rhodium.env, ...env }, stdin: "ignore" });
  expect(rh.stderr.toString()).toBe("");
  await until(async () => (await sent(n)).includes("测试开始跑了"), 10_000);
  await status(pane, "working");
  write(file, said("跑完了，全过。"), ended);
  await Bun.sleep(2500);
  expect(await sent(n)).toEqual(["测试开始跑了"]);
  // Next turn: yours joins after a send me in it, and what comes after goes to you again.
  const next = await typeIn("再跑一次", 2);
  write(file, user(next));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), "rh", "send", "me", "又开始了"], { env: { ...rhodium.env, ...env }, stdin: "ignore" });
  await until(async () => (await sent(n)).includes("又开始了"), 10_000);
  const joined = await typeIn("跑完告诉我", 3);
  write(file, enqueue(joined), queued(joined), said("第二次也全过。"), ended);
  await until(async () => (await sent(n)).includes("第二次也全过。"), 10_000);
}, 60_000);

test("story 628: on Telegram, what the agent said after an rh send me and before your message joined the turn stays unshown once the hold lifts; on QQ too", async () => {
  const { pane, file } = await inTerminal();
  const env = (await calls("layout.apply"))[0]!.params.root.env;
  const sendMe = (text: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), "rh", "send", "me", text], { env: { ...rhodium.env, ...env }, stdin: "ignore" });
  await status(pane, "working");
  for (const [bot, n] of [["t", 1], ["q", 3]] as const) {
    const before = (await rhodium.im.shown(bot, ME)).length;
    const shown = async () => (await rhodium.im.shown(bot, ME)).slice(before).map((p) => p.text);
    const typed = await typeIn(`跑一下测试 ${bot}`, n, bot);
    write(file, user(typed));
    await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
    expect(sendMe("开始跑了").stderr.toString()).toBe("");
    await until(async () => (await shown()).includes("开始跑了"), 10_000);
    write(file, said("压下的话。"));
    await until(() => (rows("SELECT progress FROM conversation WHERE progress IS NOT NULL")[0]?.progress ?? "").includes("压下的话。"), 10_000);
    const joined = await typeIn(`跑完告诉我 ${bot}`, n + 1, bot);
    write(file, enqueue(joined), queued(joined), said("全过了。"), ended);
    await until(async () => (await shown()).some((t) => t.includes("全过了。")), 10_000);
    expect((await shown()).join("\n")).not.toContain("压下的话。");
    await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt === null, 5_000);
  }
}, 60_000);

test("story 628: Esc after the agent said something: no final reply, though Herdr then says idle; a report waiting for the turn is typed in once it is cut short, and the board said why it waited", async () => {
  const { pane, file, slot } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("讲个长故事", 1);
  write(file, user(typed));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  await rhodium.ok("send", "w/a", "汇报一下");
  await until(async () => (await queue(slot)).some((q) => q.wait === "等这一回合回完你"), 5_000);
  await Bun.sleep(1500);
  expect(await calls("pane.send_input")).toHaveLength(1);
  write(file, said("从前有座山，"), user("[Request interrupted by user]"));
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
  expect((await calls("pane.send_input"))[1]!.params.text).toStartWith("[来自 用户的终端，经 rh send]\n汇报一下");
  await Bun.sleep(2500);
  expect(await sent(n)).toEqual([]);
  // A turn of yours in the terminal after it, with no source line, does not come to IM.
  write(file, user("算了，讲个短的"), said("好。"), ended);
  await Bun.sleep(2500);
  expect(await sent(n)).toEqual([]);
}, 60_000);

test("story 628: the pane reporting another session mid-turn (/clear) cuts it short: no final reply", async () => {
  const { pane, file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("改个文件", 1);
  write(file, user(typed), said("改好了一半，"));
  await until(() => rows("SELECT progress FROM conversation WHERE progress IS NOT NULL").length === 1, 5_000);
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: crypto.randomUUID() });
  await until(() => rows("SELECT turnChat FROM slot")[0].turnChat === null, 10_000);
  write(file, said("改完了。"), ended);
  await Bun.sleep(2500);
  expect(await sent(n)).toEqual([]);
}, 60_000);

test("story 618: a final reply that is just the word cut is a reply like any other, not the turn cut short", async () => {
  const { file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("取一列用哪个命令？只回命令名", 1);
  write(file, user(typed), said("cut"), ended);
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect(await sent(n)).toEqual(["cut"]);
}, 60_000);

test("story 628: the pane reporting another session after yours was taken in but before its turn started: the reply waits for it no more, and internal messages go in", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("帮我看看 README"));
  const typed = await typeIn("顺便看下 LICENSE", 1);
  write(file, enqueue(typed));
  await until(() => rows("SELECT status FROM agentInput WHERE source = 'human' ORDER BY id DESC")[0].status === "taken", 5_000);
  expect(rows("SELECT turnChat FROM slot")[0].turnChat).not.toBeNull();
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: crypto.randomUUID() });
  await until(() => rows("SELECT turnChat FROM slot")[0].turnChat === null, 10_000);
  expect(rows("SELECT typed FROM agentInput WHERE source = 'human' ORDER BY id DESC")[0].typed).toBeNull();
  await status(pane, "idle");
  await rhodium.ok("send", "w/a", "汇报一下");
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
}, 60_000);

test("story 620: two of yours with the same words, run as two turns: each line starts one turn, and each reply goes back", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("写一段关于海的话"));
  const n = (await sent()).length;
  const first = await typeIn("继续", 1);
  write(file, enqueue(first));
  const second = await typeIn("继续", 2);
  expect(second).toBe(first);
  write(file, enqueue(second), said("海从不停歇。"), ended, user(first), said("第一次。"), ended, user(second), said("第二次。"), ended);
  await until(async () => (await sent(n)).length === 2, 10_000);
  expect(await sent(n)).toEqual(["第一次。", "第二次。"]);
}, 60_000);

test("story 628: switched back to headless mid-turn: no final reply, and the headless agent finds no turn of the terminal's", async () => {
  const { file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("写个脚本", 1);
  write(file, user(typed), said("写到一半，"));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  await rhodium.ok("release", "w/a");
  await until(async () => (await sent(n)).some((t) => t.includes("切回无头了")), 15_000);
  expect(rows("SELECT turnChat, turnInbound, turnStartedAt FROM slot")[0]).toEqual({ turnChat: null, turnInbound: null, turnStartedAt: null });
  expect(rows("SELECT progress FROM conversation WHERE progress IS NOT NULL")).toEqual([]);
  expect((await sent(n)).filter((t) => !t.includes("切回无头"))).toEqual([]);
}, 60_000);

test("story 627: the turn ends while Rhodium is down, Herdr saying working when it stopped and idle as it starts: the final reply goes once it is back", async () => {
  const { pane, file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("查一下磁盘", 1);
  await status(pane, "working");
  write(file, user(typed));
  await until(() => rows("SELECT tuiStatus, turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  await rhodium.stop();
  write(file, said("还剩 40G。"));
  await status(pane, "idle");
  await rhodium.start();
  await until(async () => (await sent(n)).length === 1, 15_000);
  expect(await sent(n)).toEqual(["还剩 40G。"]);
}, 60_000);

test("story 619: on Telegram the turn's one message grows as the transcript does: a tool_use line shows its step running, its tool_result folds it into the tool lines, with its whole input and what looks like a secret as ***, and the final reply ends the same message", async () => {
  const { file } = await inTerminal();
  const n = (await rhodium.im.shown("t", ME)).length;
  const typed = await typeIn("部署一下", 1, "t");
  write(file, user(typed), said("先拉代码。"), run("toolu_a", "Bash", { command: "deploy.sh token=abc123" }));
  const last = async () => (await rhodium.im.shown("t", ME)).slice(n).map((p) => p.text);
  await until(async () => (await last()).at(-1)?.includes("正在运行") ?? false, 10_000);
  expect((await last()).at(-1)).toContain("先拉代码。");
  // A Write whose input is far over the board's 2000 characters still has its path on the line.
  write(file, result("toolu_a"), run("toolu_b", "Write", { file_path: join(rhodium.dir, "w/deploy.log"), content: "x".repeat(3000) }), result("toolu_b"), said("部署好了。"), ended);
  await until(async () => (await last()).at(-1)?.includes("部署好了。") ?? false, 10_000);
  expect(await last()).toEqual(["先拉代码。\n\n[🔧 Bash] deploy.sh token=***\n[🔧 Write] deploy.log\n\n部署好了。"]);
}, 60_000);

test("story 619: on QQ each thing said is a message of its own, the tool lines before it on top; a call made before your message started the turn has no line", async () => {
  const { pane, file } = await inTerminal();
  await status(pane, "working");
  write(file, user("先看看 README"), run("toolu_old", "Read", { file_path: join(rhodium.dir, "w/README.md") }));
  const n = (await sent()).length;
  const typed = await typeIn("看完再看下日志", 1);
  write(file, enqueue(typed), queued(typed), result("toolu_old"), said("README 看完了。"), run("toolu_c", "Read", { file_path: join(rhodium.dir, "w/app.log") }));
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect(await sent(n)).toEqual(["README 看完了。"]);
  write(file, result("toolu_c"), said("日志里有个超时。"), said("已经修好。"), ended);
  await until(async () => (await sent(n)).length === 3, 10_000);
  const [, tools, reply] = await sent(n);
  expect(tools).toBe("[🔧 Read]\n\n日志里有个超时。");
  expect(reply).toBe("已经修好。");
}, 60_000);

test("story 627: Rhodium killed after a turn has sent some of what it said: back up, nothing goes twice, the rest goes on, and the final reply comes", async () => {
  const { file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("写个周报", 1);
  write(file, user(typed), said("第一段。"), said("第二段。"));
  await until(async () => (await sent(n)).length === 1, 10_000);
  await rhodium.kill9();
  write(file, said("第三段。"), ended);
  await rhodium.start();
  await until(async () => (await sent(n)).length >= 2, 15_000);
  await Bun.sleep(1500);
  expect(await sent(n)).toEqual(["第一段。", "第二段。", "第三段。"]);
}, 60_000);

test("story 627: Rhodium killed while a tool call runs: back up, its result still gives it a tool line", async () => {
  const { file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("跑一下脚本", 1);
  write(file, user(typed), said("先跑脚本。"), run("toolu_r", "Bash", { command: "./check.sh" }));
  await until(async () => (await sent(n)).length === 1, 10_000);
  await rhodium.kill9();
  write(file, result("toolu_r"), said("跑完了。"), said("没问题。"), ended);
  await rhodium.start();
  await until(async () => (await sent(n)).length >= 3, 15_000);
  await Bun.sleep(1500);
  expect(await sent(n)).toEqual(["先跑脚本。", "[🔧 Bash]\n\n跑完了。", "没问题。"]);
}, 60_000);

test("story 629: once your turn's start is found, a dialog in the terminal is told once in your chat; closed and opened again, not again; then the reply comes as ever", async () => {
  const { pane, file } = await inTerminal();
  const n = (await sent()).length;
  const typed = await typeIn("跑一下部署脚本", 1);
  write(file, user(typed));
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  write(file, tool());
  await status(pane, "blocked");
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect(await sent(n)).toEqual(["w/a 的终端里弹了一个框在等你，处理完它才会接着回复。网页终端里也能点。"]);
  await status(pane, "working");
  await until(() => rows("SELECT tuiInput FROM slot")[0].tuiInput !== "dialog", 5_000);
  await status(pane, "blocked");
  await until(() => rows("SELECT tuiInput FROM slot")[0].tuiInput === "dialog", 5_000);
  await Bun.sleep(2000);
  expect(await sent(n)).toHaveLength(1);
  write(file, said("部署好了。"), ended);
  await until(async () => (await sent(n)).length === 2, 10_000);
  expect((await sent(n))[1]).toBe("部署好了。");
}, 60_000);

test("story 629: a dialog in a turn from the board is not told", async () => {
  const { pane, file, slot } = await inTerminal();
  const m = (await sent()).length;
  await boardAct(board, { kind: "say", slot, text: "网页来的" });
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  write(file, user((await calls("pane.send_input"))[0]!.params.text), tool());
  await until(() => rows("SELECT turnStartedAt FROM slot")[0].turnStartedAt !== null, 5_000);
  await status(pane, "blocked");
  await until(() => rows("SELECT tuiInput FROM slot")[0].tuiInput === "dialog", 5_000);
  await Bun.sleep(2000);
  expect(await sent(m)).toEqual([]);
  expect(rows("SELECT payload FROM outbound WHERE payload LIKE '%弹了一个框%'")).toEqual([]);
}, 60_000);

test("story 632: a built-in / command from the board typed bare, one that calls no model (#737 probe, /context): its line starts the turn, two idle reads end it with no reply, and the internal message held behind it goes in", async () => {
  const { file, slot } = await inTerminal();
  await boardAct(board, { kind: "say", slot, text: "/context" });
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await calls("pane.send_input"))[0]!.params.text).toBe("/context");
  expect(rows("SELECT turnChat FROM slot")[0].turnChat).not.toBeNull();
  await rhodium.ok("send", "w/a", "内部消息");
  write(file, { type: "system", subtype: "local_command", content: "<command-name>/context</command-name>\n  <command-message>context</command-message>\n  <command-args></command-args>" });
  await until(async () => (await calls("pane.send_input")).length === 2, 10_000);
  expect((await calls("pane.send_input"))[1]!.params.text).toEndWith("内部消息");
  // No words, no final reply: the board's turn just ends.
  expect(rows("SELECT type FROM event WHERE type = 'final_reply'")).toHaveLength(1);
}, 60_000);

test("story 632: a built-in / command's turn started before rhodium was killed still ends on two idle reads once back, though its start line is behind where it reads from", async () => {
  const { pane, file, slot } = await inTerminal();
  await boardAct(board, { kind: "say", slot, text: "/context" });
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  await herdr("fake.set_screen", { pane_id: pane, text: EMPTY, status: "working" });
  write(file, { type: "system", subtype: "local_command", content: "<command-name>/context</command-name>\n  <command-message>context</command-message>\n  <command-args></command-args>" });
  await until(() => rows("SELECT progress FROM conversation")[0].progress?.includes('"tui"'), 10_000);
  await rhodium.kill9();
  await rhodium.start();
  await status(pane, "idle");
  await until(() => rows("SELECT turnChat FROM slot")[0].turnChat === null, 10_000);
}, 60_000);
