// Permissions between agents and confirm requests (product §6.2, §5.8; stories 85, 86, 93), seen
// from seam one. Every slot runs the same fake claude, which makes the rh calls its message lists
// (plan below) and replies "done"; a message that lists none, such as your decision, it just takes.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Run, Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, boardAct, newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
/** A message that has the agent make these rh calls, in order. */
const plan = (...calls: string[][]) => JSON.stringify(calls);

let rhodium: Instance;
/** The board's address. */
let board = "";
afterEach(() => rhodium.cleanup());

/** Bot q goes to w/a, bot qb to w/b; both slots made, and w/b's agent running, idle after a turn. */
async function begin(opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } }, claude: { script: obey }, ...opts });
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a", "b");
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "hello" });
  await texts(1, "qb");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
}

const say = (text: string, bot = "q") => rhodium.im.inject(bot, { chat: ME, sender: ME, text });

/** The texts the bot has posted to you, once there are at least n. */
async function texts(n: number, bot = "q"): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return (await rhodium.im.log(bot, ME)).map((p) => p.text);
}

/** The slot's agent runs that have been given a message. */
const runsOf = (ref: string): Run[] => rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === ref && r.stdin.some((l) => JSON.parse(l).type === "user"));

/** The texts of the user frames written to the slot's agents, over all their runs. */
const told = (ref: string) =>
  runsOf(ref).flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text)));

/** The rh calls the slot's agents made, once there are at least n. */
async function rhCalls(ref: string, n: number): Promise<Run["rh"]> {
  await until(() => runsOf(ref).flatMap((r) => r.rh).length >= n, 15_000);
  return runsOf(ref).flatMap((r) => r.rh);
}

/** What rh says back to an agent whose request asks you at once. */
const ASKED_NOW = "已请用户确认：rh stop w/b。用户的决定会作为一条消息发给你，不用等；超时没确认视为拒绝。";
/** And in the turn your message began, whose chat it would ask you in: it waits for that turn's reply (product §5.8). */
const ASKED = ASKED_NOW.replace("。用户", "。确认请求会在你这一回合结束后推给用户。用户");
/** What each rh call asks for, as the confirm request says it, and what follows from it (docs/im-style.md §5.3). */
const WANTS: Record<string, string> = {
  "rh stop w/b": "停掉 w/b。\n正在跑的回合会中断，对话留着。",
  "rh archive w/b": "归档 w/b。\n对话留着，发消息就恢复。",
  "rh agent w/b pi": "把 w/b 换成 pi。\n会从一段新对话开始，旧对话发 /resume 能回去。",
  "rh tui w/b": "把 w/b 切到 TUI。",
  "rh release w/b": "把 w/b 切回无头。\n这会结束 TUI 里的 agent，对话留着接着用。",
};
/** The confirm request you get for w/a's rh call. */
const asks = (cmd: string) => `w/a 想${WANTS[cmd]}\n\n命令：${cmd}\n回别的话算拒绝，并转告 w/a。`;
const CONFIRM = asks("rh stop w/b");
/** Agreed, you hear 已回答：同意 alone: the agent tells you what came of it (product §5.8). */
const TELL = "用户在 IM 里只看到“已回答：同意”。请用 rh send me 把结果告诉用户；你有父槽位时，见 rh send me 的说明。";
/** Agreed on the board, which shows the turn the decision begins: the reply will do (story 478). */
const TELL_WEB = "用户是在网页上同意的，网页上看得到你这一回合的回复。请把结果写在回复里，不用 rh send me。";

/** Agrees on the board to the confirm request open on w/a, as its card sends it. */
async function agreeOnBoard(): Promise<void> {
  const get = async (path: string) => (await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
  const a = (await get("/api/board")).workspaces.flatMap((w: any) => Object.values(w.groups).flat()).find((c: any) => c.name === "a").id;
  let asks: { id: string }[] = [];
  await until(async () => (asks = (await get(`/api/slot?id=${a}`)).asks).length > 0, 15_000);
  expect(await (await boardAct(board, { kind: "answer", ask: asks[0]!.id, text: "1" })).json()).toEqual({ ok: true, text: "已回答：同意。" });
}

test("story 85: an agent's rh stop of a slot not its descendant returns at once and asks you, under its reply to you; once you agree it runs, and the agent hears the result, to tell you", async () => {
  await begin();
  await say(plan(["stop", "w/b"]));
  const [call] = await rhCalls("w/a", 1);
  expect([call!.code, call!.out.trim(), call!.err]).toEqual([0, ASKED, ""]);
  expect(await texts(2)).toEqual(["done", CONFIRM]);
  expect(await rhodium.state("w/b")).toBe("空闲");

  await say("1");
  expect((await texts(3))[2]).toBe("已回答：同意。");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe(`用户同意了你的确认请求：rh stop w/b\n结果：正在停止 w/b，对话保留。\n${TELL}`);
  // A turn your decision started replies to no one.
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await rhodium.im.log("q", ME)).toHaveLength(3);
}, 30_000);

test("story 478: agreed on the board, the agent hears the result, to write in its reply there, not with rh send me", async () => {
  await begin();
  await say(plan(["stop", "w/b"]));
  await agreeOnBoard();
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe(`用户同意了你的确认请求：rh stop w/b\n结果：正在停止 w/b，对话保留。\n${TELL_WEB}`);
}, 30_000);

test("story 85: once you refuse, nothing runs, and the agent hears so, with your words", async () => {
  await begin();
  await say(plan(["stop", "w/b"]));
  expect(await texts(2)).toEqual(["done", asks("rh stop w/b")]);
  await say("2 别动它");
  expect((await texts(3))[2]).toBe("已拒绝，并转告：“别动它”");
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe("用户拒绝了你的确认请求：rh stop w/b 没有执行。\n用户说：别动它");
  expect(await rhodium.ok("ls")).toMatch(/^w\/b +\S+ +\S+ +空闲/m);
}, 30_000);

test("story 85: an agent's confirm request in a turn no message of yours began asks you at once", async () => {
  await begin();
  await say("hello");
  await texts(1);
  await rhodium.ok("send", "w/a", plan(["stop", "w/b"]));
  const [call] = await rhCalls("w/a", 1);
  expect([call!.code, call!.out.trim()]).toEqual([0, ASKED_NOW]);
  expect(await texts(2)).toEqual(["done", CONFIRM]);
}, 30_000);

test("story 85: an agent's confirm request in the turn your message began asks you at once when it goes to another chat, such as one that joined the turn since", async () => {
  // w/a makes the rh calls the message that joins its turn lists, and its turn goes on.
  const script: Script = { on, steps: [...startTurn, { wait: { type: "user" } }, { rhFrom: "in.message.content.0.text" }, { wait: { type: "user" } }] };
  // Bots q and qb both go to w/a; w/b is the slot the call is about.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await say("hello");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  // qb's message joins the turn q began, and makes qb's chat w/a's contact chat.
  await say(plan(["archive", "w/b"]), "qb");
  const [call] = await rhCalls("w/a", 1);
  expect([call!.code, call!.out.trim()]).toEqual([0, ASKED_NOW.replace("stop", "archive")]);
  expect(await texts(2, "qb")).toEqual(["已并入 假 IM Bot q 的私聊那边正在跑的回合，回复会发在那边。", asks("rh archive w/b")]);
  // Not waiting for the turn's end, which never comes here.
  expect(await rhodium.state("w/a")).toBe("运行中");
}, 30_000);

/** Bot q goes to w/a, whose agent makes the rh archive w/b your message asks for, and its turn goes
 *  on: the confirm request waits for a turn's end that never comes (architecture §9.6). */
async function waitingForTurnEnd(): Promise<void> {
  const script: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, { wait: { type: "user" } }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await say(plan(["archive", "w/b"]));
  const [call] = await rhCalls("w/a", 1);
  expect(call!.out.trim()).toBe(ASKED.replace("stop", "archive"));
}
const asksYou = async () => (await rhodium.im.log("q", ME)).some((p) => p.text === asks("rh archive w/b"));

test("story 85: a confirm request waiting for the turn's end goes to you once the agent exits instead, say on rh stop; agreed, the agent hears", async () => {
  await waitingForTurnEnd();
  await rhodium.ok("stop", "w/a");
  await until(asksYou, 15_000);
  await say("1");
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toStartWith("用户同意了你的确认请求：rh archive w/b\n");
}, 30_000);

test("story 85: a confirm request waiting for the turn's end goes to you, once, when the slot moves to another conversation instead: say rh agent waiting for that turn, and rh stop ending it", async () => {
  await waitingForTurnEnd();
  await rhodium.ok("agent", "w/a", "pi");
  await rhodium.ok("stop", "w/a");
  await until(asksYou, 15_000);
  expect(await rhodium.ok("ls", "w/a")).toContain("agent: pi");
  await say("2");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "已拒绝。"), 15_000);
  expect((await texts(1)).filter((t) => t === asks("rh archive w/b"))).toHaveLength(1);
}, 30_000);

test("story 86: a confirm request nobody answers in time is a refusal: nothing runs, the agent hears so, and your next message is a message again", async () => {
  await begin({ toml: '[durations]\naskTimeout = "500ms"' });
  await say(plan(["stop", "w/b"]));
  expect(await texts(2)).toEqual(["done", CONFIRM]);
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe("确认请求超时，视为拒绝：rh stop w/b 没有执行。");
  expect(await rhodium.state("w/b")).toBe("空闲");

  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await say("1");
  await until(() => told("w/a").length === 3, 15_000);
  expect(told("w/a")[2]).toBe("1");
  expect(await texts(3)).toEqual(["done", CONFIRM, "done"]);
  expect(await rhodium.state("w/b")).toBe("空闲");
}, 30_000);

test("story 85: an agent's rh archive of a bot's default target, its own slot or another, is refused at once, with no request to you", async () => {
  await begin();
  await say(plan(["archive", "w/b"], ["archive", "w/a"]));
  const [b, a] = await rhCalls("w/a", 2);
  expect([b!.code, b!.err]).toEqual([1, "rh: w/b 是 假 IM Bot qb 的默认目标，先用 rh bind 换一个再归档。\n"]);
  expect([a!.code, a!.err]).toEqual([1, "rh: w/a 是 假 IM Bot q 的默认目标，先用 rh bind 换一个再归档。\n"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await texts(1)).toEqual(["done"]);
  expect(await rhodium.ok("ls")).toMatch(/^w\/a .*\nw\/b /m);
}, 30_000);

test("story 93: an agent stops and archives its own descendants, a grandchild too, without asking you", async () => {
  await begin();
  await say(plan(["spawn", "c1", "--longterm", plan(["spawn", "c2", "--longterm", "idle"])]));
  // The children's reports wake w/a too: your next message would join that turn, its reply coming to you.
  const idle = async (ref: string) => (await rhodium.state(ref)) === "空闲";
  await until(async () => (await idle("w/c1")) && (await idle("w/c2")) && (await idle("w/a")), 15_000);
  await say(plan(["stop", "w/c1"], ["archive", "w/c2"]));
  const [, stop, archive] = await rhCalls("w/a", 3);
  expect([stop!.code, stop!.out.trim()]).toEqual([0, "正在停止 w/c1，对话保留。"]);
  expect([archive!.code, archive!.out.trim()]).toEqual([0, "已归档 w/c2，对话保留。rh unarchive w/c2 恢复。"]);
  expect(await texts(2)).toEqual(["done", "done"]);
  await until(async () => (await rhodium.state("w/c1")) === "未运行", 15_000);
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c2 /m);
}, 30_000);

test("a write by a caller rh cannot recognize asks you in the main chat, and runs once you agree, from the caller's directory", async () => {
  await begin({ toml: `mainChat = "q/${ME}"` });
  const unknown = (...args: string[]) => rhodium.rh(args, { tty: false, cwd: join(rhodium.dir, "w") });
  const NOT_TOLD = "认不出是谁在调用 rh：它不在 Rhodium 的槽位里，也不是从终端调用的。用户的决定不会发回给你。";
  const ask = (cmd: string, wants = "执行一条 rh 命令。") => `有个认不出的程序想${wants}\n\n命令：${cmd}\n回别的话算拒绝。`;

  expect(await unknown("stop", "w/b")).toEqual({ code: 0, out: `已请用户确认：rh stop w/b。${NOT_TOLD}\n`, err: "" });
  expect(await texts(1)).toEqual([ask("rh stop w/b", WANTS["rh stop w/b"])]);
  await say("1");
  expect((await texts(2))[1]).toBe("已回答：同意。正在停止 w/b，对话保留。");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);

  expect((await unknown("new", "w/c", "--dir", "sub")).out).toBe(`已请用户确认：rh new w/c --dir sub。${NOT_TOLD}\n`);
  expect((await texts(3))[2]).toBe(ask("rh new w/c --dir sub"));
  await say("同意");
  expect((await texts(4))[3]).toStartWith("已回答：同意。已建槽位 w/c");
  expect(await rhodium.ok("ls", "w/c")).toMatch(new RegExp(`^目录: ${join(rhodium.dir, "w", "sub")}$`, "m"));
  // Refused in words: no one hears them, so the receipt does not say they are passed on.
  await unknown("archive", "w/c");
  expect((await texts(5))[4]).toBe(ask("rh archive w/c", "归档 w/c。\n对话留着，发消息就恢复。"));
  await say("别动它");
  expect((await texts(6))[5]).toBe("已拒绝。");
  // The slot your answers went to was never woken: no one is told.
  expect(runsOf("w/a")).toEqual([]);
}, 30_000);

test("an rh send to a slot by a caller rh cannot recognize asks you; once you agree it goes in, saying who sent it", async () => {
  await begin({ toml: `mainChat = "q/${ME}"` });
  const r = await rhodium.rh(["send", "w/b", "hi"], { tty: false, cwd: rhodium.dir });
  expect(r.out).toStartWith("已请用户确认：rh send w/b hi。");
  await texts(1);
  await say("1");
  const frames = () => runsOf("w/b").flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => m.message.content[0].text));
  await until(() => frames().length === 2, 15_000);
  expect(frames()[1]).toBe("[来自 认不出的调用者（用户已同意），经 rh send]\nhi");
}, 30_000);

test("story 101: at the running limit your decision waits for room instead of being dropped, and reaches the agent once a slot stops", async () => {
  await begin({ toml: "[limits]\nmaxRunning = 1" });
  await say(plan(["stop", "w/b"])); // your message starts w/a past the limit: it is never refused
  expect(await texts(2)).toEqual(["done", CONFIRM]);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);

  // w/b's agent takes the one place: your no waits.
  await say("2");
  expect((await texts(3))[2]).toBe("已拒绝。");
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(told("w/a")).toHaveLength(1);

  await rhodium.ok("stop", "w/b");
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe("用户拒绝了你的确认请求：rh stop w/b 没有执行。");
}, 30_000);

test("a call with a mistake is refused at once, and one that would change nothing asks no one", async () => {
  await begin();
  await rhodium.ok("stop", "w/b");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  await say(plan(["stop", "w/nope"], ["stop", "w/b"]));
  expect(await texts(1)).toEqual(["done"]);
  const calls = await rhCalls("w/a", 2);
  expect(calls.map((c) => [c.code, c.out.trim(), c.err.trim()])).toEqual([
    [1, "", "rh: 没有槽位 w/nope。"],
    [0, "w/b 没在运行。", ""],
  ]);
}, 30_000);

// Switching agent or mode (issue #51): rh agent and rh tui follow the rule above; rh release asks you
// whoever calls it, as it ends the agent in your terminal (architecture §10.1).

/** What w/a's rh says back. */
const asked = (cmd: string) => ASKED.replace("rh stop w/b", cmd);
const SWITCHED = (ref: string) => `已把 ${ref} 换成 pi，下一条消息开始一段新对话。`;
/** Waits until the slot is in the terminal, its Herdr pane open. */
const inPane = (ref: string) => until(async () => (await rhodium.state(ref)) === "TUI 模式", 15_000);

test("story 93: an agent switches its own descendant to pi without asking you", async () => {
  await begin();
  await say(plan(["spawn", "c1", "--longterm", "idle"]));
  await until(async () => (await rhodium.state("w/c1")) === "空闲", 15_000);
  await say(plan(["agent", "w/c1", "pi"]));
  const [, call] = await rhCalls("w/a", 2);
  expect([call!.code, call!.out.trim()]).toEqual([0, SWITCHED("w/c1")]);
  expect(await rhodium.ok("ls", "w/c1")).toContain("agent: pi");
  expect((await texts(2)).filter((t) => t.includes("命令：rh "))).toEqual([]);
}, 30_000);

test("story 85: an agent's rh agent of a slot not its descendant asks you; once you agree the slot switches, and the agent hears so", async () => {
  await begin();
  await say(plan(["agent", "w/b", "pi"]));
  const [call] = await rhCalls("w/a", 1);
  expect([call!.code, call!.out.trim()]).toEqual([0, asked("rh agent w/b pi")]);
  expect(await texts(2)).toEqual(["done", asks("rh agent w/b pi")]);
  expect(await rhodium.ok("ls", "w/b")).toContain("agent: claude");

  await say("1");
  expect((await texts(3))[2]).toBe("已回答：同意。");
  expect(await rhodium.ok("ls", "w/b")).toContain("agent: pi");
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toBe(`用户同意了你的确认请求：rh agent w/b pi\n结果：${SWITCHED("w/b")}\n${TELL}`);
}, 30_000);

test("story 93: an agent switches its own descendant to the terminal without asking you; releasing it asks you all the same", async () => {
  await begin({ herdr: true });
  await say(plan(["spawn", "c1", "--longterm", "idle"]));
  await until(async () => (await rhodium.state("w/c1")) === "空闲", 15_000);
  await say(plan(["tui", "w/c1"]));
  const [, tui] = await rhCalls("w/a", 2);
  expect([tui!.code, tui!.out.trim()]).toEqual([0, "正在把 w/c1 切到 TUI…"]);
  await inPane("w/c1");
  expect((await texts(2)).filter((t) => t.includes("命令：rh "))).toEqual([]);

  await say(plan(["release", "w/c1"]));
  const [, , release] = await rhCalls("w/a", 3);
  expect([release!.code, release!.out.trim()]).toEqual([0, asked("rh release w/c1")]);
  await until(async () => (await texts(3)).some((t) => t === `w/a 想把 w/c1 切回无头。\n这会结束 TUI 里的 agent，对话留着接着用。\n\n命令：rh release w/c1\n回别的话算拒绝，并转告 w/a。`), 15_000);
  await say("1");
  await until(async () => (await rhodium.state("w/c1")) === "未运行", 15_000);
}, 45_000);

test("story 85: an agent's rh tui and rh release of a slot not its descendant each ask you first; agreed, how each switch went is the agent's to tell you", async () => {
  await begin({ herdr: true });
  await say(plan(["tui", "w/b"]));
  const [tui] = await rhCalls("w/a", 1);
  expect([tui!.code, tui!.out.trim()]).toEqual([0, asked("rh tui w/b")]);
  expect(await texts(2)).toEqual(["done", asks("rh tui w/b")]);
  expect(await rhodium.state("w/b")).toBe("空闲");
  await say("1");
  expect((await texts(3))[2]).toBe("已回答：同意。");
  await inPane("w/b");
  // The decision waits for the switch, and carries how it went.
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toMatch(new RegExp(`^用户同意了你的确认请求：rh tui w/b\n结果：w/b 切到 TUI 了。\n在 Herdr \\S+ 会话里 w 工作区的 b 标签页。\n在 TUI 里退出 agent，它会自动切回无头。这之前，这里的消息不会交给它。\n${TELL}$`));
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await say(plan(["release", "w/b"]));
  const [, release] = await rhCalls("w/a", 2);
  expect([release!.code, release!.out.trim()]).toEqual([0, asked("rh release w/b")]);
  await until(async () => (await texts(5)).some((t) => t === asks("rh release w/b")), 15_000);
  expect(await rhodium.state("w/b")).toBe("TUI 模式");
  await say("1");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  await until(() => told("w/a").length === 4, 15_000);
  expect(told("w/a")[3]).toBe(`用户同意了你的确认请求：rh release w/b\n结果：w/b 切回无头了。\n${TELL}`);
  // Rhodium itself said nothing of either switch: not where you answered, nor in w/b's own chat.
  expect(await texts(6)).toEqual(["done", asks("rh tui w/b"), "已回答：同意。", "done", asks("rh release w/b"), "已回答：同意。"]);
  expect((await rhodium.im.log("qb", ME)).map((p) => p.text)).toEqual(["done"]);
}, 45_000);

test("story 478: an agent's rh tui agreed on the board: how the switch went reaches the agent, to write in its reply there", async () => {
  await begin({ herdr: true });
  await say(plan(["tui", "w/b"]));
  await agreeOnBoard();
  await inPane("w/b");
  await until(() => told("w/a").length === 2, 15_000);
  expect(told("w/a")[1]).toStartWith("用户同意了你的确认请求：rh tui w/b\n结果：w/b 切到 TUI 了。");
  expect(told("w/a")[1]).toEndWith(`\n${TELL_WEB}`);
}, 45_000);

test("stories 85, 154: the emergency stop calls off an agent's rh tui waiting for the turn: the agent hears so with its next message, not woken for it, and the slot's next switch is told to you again", async () => {
  // Each turn takes 3 s: w/b's is still under way when you agree, and the switch waits for it.
  const slow: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, { sleep: 3000 }, ...endTurn("done"), { goto: 0 }] };
  await begin({ herdr: true, claude: { script: slow }, toml: '[durations]\nstopGrace = "1s"' });
  await say(plan(["tui", "w/b"]));
  expect(await texts(2)).toEqual(["done", asks("rh tui w/b")]);
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "[]" });
  await until(async () => (await rhodium.state("w/b")) === "运行中", 15_000);
  await say("1");
  expect((await texts(3))[2]).toBe("已回答：同意。");
  await rhodium.ok("stop", "--all");
  await until(async () => (await rhodium.state("w/b")) === "未运行" && (await rhodium.state("w/a")) === "未运行", 15_000);
  await Bun.sleep(500);
  expect(told("w/a")).toHaveLength(1); // not woken

  await say("hi");
  await until(() => told("w/a").length === 3, 15_000);
  expect(told("w/a").slice(1)).toEqual(["你请求的 rh tui w/b 被急停取消了，w/b 停着，还是无头模式。", "hi"]);
  // Your own /rh_tui of w/b later: how it went comes to you, not to w/a.
  await say("/rh_tui w/b");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.startsWith("w/b 切到 TUI 了")), 15_000);
  expect(told("w/a")).toHaveLength(3);
}, 60_000);

test("story 85: agreed, an agent's rh tui or rh release whose switch fails is the agent's to tell you all the same", async () => {
  // Every agent ignores its exit keys and SIGTERM: the one in the terminal outlives rh release.
  const obeying = { on, steps: [{ ignore: "SIGINT" }, { ignore: "SIGTERM" }, ...obey.steps.slice(0, -1), { goto: 2 }] } satisfies Script;
  await begin({ herdr: true, claude: { script: obeying }, toml: '[durations]\nreleaseGrace = "1s"\nstopGrace = "1s"' });
  const session = runsOf("w/b")[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);
  // Say you resumed w/b's conversation by hand in a terminal of your own: the switch to it fails.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    await say(plan(["tui", "w/b"]));
    await texts(2);
    await say("1");
    await until(() => told("w/a").length === 2, 15_000);
  } finally {
    other.kill();
    await other.exited;
  }
  expect(told("w/a")[1]).toBe(`用户同意了你的确认请求：rh tui w/b\n结果：w/b 没能切到 TUI，还在无头模式，对话不变。\n原因：另一个进程正在用这段对话\n${TELL}`);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await rhodium.ok("tui", "w/b");
  await inPane("w/b");
  await say(plan(["release", "w/b"]));
  await until(async () => (await texts(5)).some((t) => t === asks("rh release w/b")), 15_000);
  await say("1");
  await until(() => told("w/a").length === 4, 15_000);
  const pane = rhodium.claude.runs().find((r) => r.env.RHODIUM_SLOT === "w/b" && r.argv[0] !== "-p")!;
  expect(told("w/a")[3]).toBe(`用户同意了你的确认请求：rh release w/b\n结果：w/b 没能切回无头，这里的消息还不会交给它。\n原因：TUI 里的 agent 没有退出\n${TELL}`);
  process.kill(pane.pid, "SIGKILL");
  // Rhodium itself said nothing of either failure: not where you answered, nor in w/b's own chat.
  const failed = async (bot: string) => (await rhodium.im.log(bot, ME)).filter((p) => p.text.includes("没能切"));
  expect([await failed("q"), await failed("qb")]).toEqual([[], []]);
}, 45_000);

test("story 86: confirm requests to switch a slot's agent or mode that nobody answers in time leave the slot as it was", async () => {
  await begin({ herdr: true, toml: '[durations]\naskTimeout = "500ms"' });
  await say(plan(["agent", "w/b", "pi"], ["tui", "w/b"]));
  await until(() => told("w/a").join("\n").split("确认请求超时").length === 3, 15_000);
  const heard = told("w/a").join("\n");
  expect(heard).toContain("确认请求超时，视为拒绝：rh agent w/b pi 没有执行。");
  expect(heard).toContain("确认请求超时，视为拒绝：rh tui w/b 没有执行。");
  expect(await rhodium.ok("ls", "w/b")).toContain("agent: claude");
  expect(await rhodium.state("w/b")).toBe("空闲");
}, 30_000);
