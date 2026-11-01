// Seam two (docs/spec/v1.md "接缝二"): kill -9 rhodium mid-turn and start it again. The holder and
// the agent run on, and the restarted rhodium picks up where the last one stopped (architecture §5).
// Every kill -9 goes to a PID this test instance recorded itself.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import type { Config as FakeAgentConfig } from "./fake-agent/fake-agent";
import { endTurn, on, PROGRESS_PIECES, queueMidTurn, saying, startTurn, takeQueued, toolCall, toolUse } from "./fake-agent/scripts";
import { mainPid, newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

async function ok(...args: string[]): Promise<string> {
  const r = await rhodium.rh(args);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  return r.out;
}

/** An instance whose bot q sends your messages to slot w/a, a headless claude playing `claude`. */
async function slotA(claude: FakeAgentConfig, more: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude, ...more });
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await ok("ws", "w", dir);
  await ok("new", "w/a");
}

const state = async () => (await ok("ls")).match(/^w\/a +\S+ +\S+ +(\S+)/m)?.[1];

/** Waits until the bot has posted n messages to you, and returns them. */
async function posts(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

/** The text of every user frame the fake claude got, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

/** Sends a message from you and waits until the agent has it. Returns its platform message id. */
async function say(text: string): Promise<string> {
  const n = asked().length;
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text });
  await until(() => asked().length > n, 15_000);
  return messageId;
}

/** A file of the slot's holder: out.log, the agent's stdout; in.log, each line taken for its stdin. */
function holdFile(name: "out.log" | "in.log"): string {
  const dir = join(rhodium.dir, "state/hold");
  if (!existsSync(dir)) return ""; // no holder yet
  const [conversation, ...more] = readdirSync(dir);
  expect(more).toEqual([]);
  const file = join(dir, conversation!, name);
  return existsSync(file) ? readFileSync(file, "utf8") : ""; // its directory is made first
}
const outLog = () => holdFile("out.log");
const inLog = () => holdFile("in.log");
const count = (text: string, part: string) => text.split(part).length - 1;

test("story 118: rhodium killed mid-turn and started again; each turn's reply arrives once, in order", async () => {
  await slotA({ script: "numbered" });
  const sent: string[] = [];

  sent.push(await say("one"));
  await posts(1);

  // Killed as soon as the agent has the message; back while the turn still runs.
  sent.push(await say("two"));
  await rhodium.kill9();
  await rhodium.start();
  await posts(2);

  // Killed after the turn's last line of text, which it had read; back once the turn has ended.
  // Only that earlier line says what the final reply is.
  sent.push(await say("three"));
  await until(() => count(outLog(), '"text":"40"') === 3);
  await Bun.sleep(100);
  await rhodium.kill9();
  await until(() => count(outLog(), '"state":"idle"') === 3);
  await rhodium.start();

  await posts(3);
  await Bun.sleep(300); // anything sent twice would show up by now
  expect((await rhodium.im.log("q", ME)).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual(
    sent.map((replyTo) => ({ text: "40", replyTo })),
  );
  // One agent all along, and it got each message once. A restart of Rhodium is no crash.
  expect(rhodium.claude.runs()).toHaveLength(1);
  expect(asked()).toEqual(["one", "two", "three"]);
  expect(await state()).toBe("空闲");
}, 60_000);

// QQ sends what the agent said once something comes after it, the tools before it on top (architecture §8.2).
const pieces = (from: number, to: number) => PROGRESS_PIECES.slice(from, to).join("");

test("story 118: killed mid-turn after one thing it said went out and with the next not yet sent: each reaches QQ once, in order", async () => {
  // Says one, reads a file, says two, pauses a second, runs a command, ends saying three.
  const steps = [...startTurn, saying("one"), toolCall("toolu_read", "Read", { file_path: "notes.txt" }), saying("two"), { sleep: 1000 }, toolCall("toolu_bash", "Bash", { command: "ls" }), ...endTurn("three"), { goto: 0 }];
  await slotA({ script: { on, steps } });
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "go" });
  await posts(1); // one; two waits for what comes after it
  await until(() => outLog().includes('"text":"two"')); // the agent pauses after it
  await rhodium.kill9();
  await rhodium.start();
  await until(async () => (await state()) === "空闲", 15_000);
  await Bun.sleep(300); // anything sent twice would show up by now
  expect((await rhodium.im.log("q", ME)).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual(
    ["one", "[🔧 Read]\n\ntwo", "[🔧 Bash]\n\nthree"].map((text) => ({ text, replyTo: messageId })),
  );
}, 60_000);

test("story 118: killed after a message ended and before anything came after it: that message still reaches QQ when the next step starts", async () => {
  await slotA({ script: "progress-then-tool" });
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "go" });
  await until(() => outLog().includes('"type":"assistant"')); // the agent pauses after the message
  await rhodium.kill9();
  await rhodium.start();
  await until(async () => (await state()) === "空闲", 15_000);
  await Bun.sleep(300);
  expect((await rhodium.im.log("q", ME)).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual(
    [pieces(0, 5).trimEnd(), "[🔧 Read]\n\nfinal"].map((text) => ({ text, replyTo: messageId })),
  );
}, 60_000);

test("story 118: lines with U+2028, 3 MiB long, or 汉 split across two writes, said while rhodium was down, reach IM intact", async () => {
  await slotA({ script: "hard-replies" });
  const replies = ["line separator \u2028 inside a line", "after 3 MiB", "汉字被切开"];
  for (const [i, want] of replies.entries()) {
    const id = await say(`go ${i}`);
    await rhodium.kill9(); // the agent answers 300 ms after it has the message
    await until(() => count(outLog(), '"state":"idle"') === i + 1, 15_000);
    await rhodium.start();
    expect((await posts(i + 1))[i]).toMatchObject({ text: want, replyTo: id });
  }
  expect((await rhodium.im.log("q", ME)).map((p) => p.text)).toEqual(replies);
}, 60_000);

// Longer than the 64 KiB pipe buffer, so it sticks in stdin while the agent reads nothing.
const BIG = "x".repeat(200 * 1024);

/** Kills rhodium while it is writing BIG to an agent stopped with SIGSTOP. The agent goes on
 *  reading before rhodium is back (`before`) or after. Returns BIG's platform message id. */
async function killWhileWriting(before: boolean): Promise<string> {
  await slotA({ script: "turn" });
  await say("first");
  await posts(1);
  const agent = rhodium.claude.runs()[0]!.pid; // the fake claude's own record of its pid
  process.kill(agent, "SIGSTOP");
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes(BIG), 15_000); // marked writing; the holder is on it
  await rhodium.kill9();
  if (before) {
    process.kill(agent, "SIGCONT");
    await until(() => asked().length === 2, 15_000);
    await until(() => count(outLog(), '"state":"idle"') === 2, 15_000);
    await rhodium.start();
  } else {
    await rhodium.start();
    process.kill(agent, "SIGCONT");
  }
  return messageId;
}

/** The slot's holder unit, while systemd has it. */
const holderUnit = async () => (await rhodium.units()).find((u) => u.includes("hold-"));
const logged = (d: Daemon) => d.logs.filter((l) => l.msg === "agent exited").map(({ from, code, signal }) => ({ from, code, signal }));

/** The crash notice of slot w/a (story 123): a crash found after a restart is told as one seen live. */
const notice = (why: string) => ({ text: expect.stringMatching(new RegExp(`^w/a 崩溃了.*\n.*\n原因：${why}($|\n)`)) });

test("story 118: the agent exits by itself while rhodium is down: its reply still goes out, the exit is the agent's, code and all, and you hear of the crash", async () => {
  await slotA({ script: "reply-then-exit" });
  const id = await say("hello");
  await rhodium.kill9();
  await until(async () => !(await holderUnit()), 15_000);
  const d = await rhodium.start();
  // The reply was only in out.log by then: no holder was left to send it.
  expect(await posts(2)).toMatchObject([{ text: "bye", replyTo: id }, notice("agent 退出，退出码 3")]);
  expect(logged(d)).toEqual([{ from: "agent", code: 3, signal: null }]);
  expect(await state()).toBe("崩溃");
}, 60_000);

// Claude takes a message that comes while a tool runs into the turn only at the next tool boundary
// (command_lifecycle started). Here rhodium is killed before it does. Claude takes it while rhodium
// is down, or once it is back, or never, and then dies: the notice quotes the message only if never.
// Taken while rhodium was down, the restarted rhodium reads so from out.log.
for (const when of ["never", "while rhodium is down", "once rhodium is back"] as const) {
  test(`story 118: Claude queues your message, rhodium is killed, Claude takes it ${when} and dies: the notice quotes it only if never taken`, async () => {
    const take = when === "never" ? [] : [takeQueued];
    const steps = [...startTurn, toolUse("toolu_sleep", "Bash", { command: "sleep 60" }), ...queueMidTurn, { sleep: 1500 }, ...take, { sleep: 100 }, { kill: "SIGKILL" as const }];
    await slotA({ script: { on, steps } }, { toml: "[defaults]\ncrashResume = false" });
    await say("work");
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "顺便看下日志" });
    await until(() => count(outLog(), '"state":"queued"') === 2, 15_000);
    const agent = rhodium.claude.runs()[0]!.pid; // the fake claude's own record of its pid
    // Back: it waits for the restarted rhodium, which reattaches to its holder. Else it is gone with
    // its holder by then, and the restart reads its end from out.log.
    const back = when === "once rhodium is back";
    if (back) process.kill(agent, "SIGSTOP");
    await rhodium.kill9();
    expect(count(outLog(), '"state":"started"')).toBe(1); // the first message's alone, so far
    if (!back) await until(async () => !(await holderUnit()), 15_000);

    await rhodium.start();
    if (back) process.kill(agent, "SIGCONT");
    await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.startsWith("w/a 崩溃了")), 15_000);
    const told = (await rhodium.im.log("q", ME)).find((p) => p.text.startsWith("w/a 崩溃了"))!.text;
    const head = "w/a 崩溃了，这一回合没做完。\n发一条消息就恢复这段对话。\n原因：agent 被信号 KILL 结束";
    expect(told).toBe(when === "never" ? `${head}\n\n这条不确定它收到没有，需要的话再发一遍：\n“顺便看下日志”` : head);
  }, 60_000);
}

test("story 118: killed while a start waits for the last holder unit to go: the last agent's exit file is no crash of this start, which goes ahead", async () => {
  await slotA({ script: "reply-then-exit" }, { stopPostDelay: 1 });
  await say("hello");
  await posts(1);
  await until(async () => (await state()) === "崩溃", 15_000); // its exit is on record, its unit not gone
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(async () => (await state()) === "启动中", 15_000);
  await rhodium.kill9();
  expect(await holderUnit()).toBeDefined(); // so the start was still waiting for it
  await until(async () => !(await holderUnit()), 15_000);
  await rhodium.start();
  expect((await posts(3)).slice(1, 3)).toMatchObject([notice("agent 退出，退出码 3"), { text: "bye", replyTo: messageId }]);
  expect(asked()).toEqual(["hello", "again"]);
}, 60_000);

test("story 118: the holder is still up when rhodium looks but gone by the time it connects: the reply still goes out, and the exit is the agent's", async () => {
  await slotA({ script: "reply-then-exit", readAfter: 1200 });
  const id = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(() => inLog().includes("hello"), 15_000);
  await rhodium.kill9();
  // As a holder does on its way out, just after the restarted rhodium found its unit up. This one
  // goes once its agent has answered and exited.
  const [conversation] = readdirSync(join(rhodium.dir, "state/hold"));
  rmSync(join(rhodium.dir, "run/hold", `${conversation}.sock`));
  const d = await rhodium.start();
  expect(await posts(2)).toMatchObject([{ text: "bye", replyTo: id.messageId }, notice("agent 退出，退出码 3")]);
  expect(logged(d)).toEqual([{ from: "agent", code: 3, signal: null }]);
}, 60_000);

test("story 118: the holder is up but its socket is gone for good: rhodium stops it, records a holder crash, and the next message starts afresh", async () => {
  await slotA({ script: "turn" }, { toml: '[durations]\nholderGone = "1500ms"' });
  await say("first");
  await posts(1);
  await rhodium.kill9();
  const [conversation] = readdirSync(join(rhodium.dir, "state/hold"));
  rmSync(join(rhodium.dir, "run/hold", `${conversation}.sock`));
  const d = await rhodium.start(); // waits out the 1.5 s a holder unit gets to go
  expect(await holderUnit()).toBeUndefined(); // no agent left running that nothing can reach
  expect(logged(d)).toEqual([{ from: "holder", code: null, signal: "TERM" }]);
  expect(await state()).toBe("崩溃");
  await say("after");
  expect(await posts(3)).toMatchObject([{ text: "fake reply" }, notice("托管进程被信号 TERM 结束"), { text: "fake reply" }]);
  expect(rhodium.claude.runs()).toHaveLength(2);
}, 60_000);

test("story 118: the holder is killed -9 while rhodium is down: a holder crash, and the line it was writing is never written again", async () => {
  // Not resumed (story 124), so the next message is what starts claude again.
  await slotA({ script: "turn" }, { toml: "[defaults]\ncrashResume = false" });
  await say("first");
  await posts(1);
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGSTOP");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes(BIG), 15_000);
  await rhodium.kill9();

  // Only the pid systemd gives for this instance's own unit, and only once it is surely its holder.
  const unit = (await holderUnit())!;
  const pid = await mainPid(unit);
  expect(readFileSync(`/proc/${pid}/cmdline`, "utf8")).toContain(`\0run\0${join(rhodium.dir, "state/hold")}/`);
  process.kill(pid, "SIGKILL");
  await until(async () => !(await holderUnit()), 15_000);

  const d = await rhodium.start();
  expect(logged(d)).toEqual([{ from: "holder", code: null, signal: "KILL" }]);
  expect(await state()).toBe("崩溃");
  // Whether BIG got in is unknown: the notice asks you to check, and the next message starts claude
  // again without writing it.
  const told = (await posts(2))[1]!.text;
  expect(told).toStartWith("w/a 崩溃了");
  expect(told).toContain("\n原因：托管进程被信号 KILL 结束\n");
  expect(told).toContain("\n这条不确定它收到没有，需要的话再发一遍：\n");
  await say("after");
  expect((await posts(3)).map((p) => p.text)).toEqual(["fake reply", told, "fake reply"]);
  expect(rhodium.claude.runs()).toHaveLength(2);
  expect(asked()).toEqual(["first", "after"]);
  // Nor after the next restart, which finds the new holder knows nothing of it.
  await rhodium.kill9();
  await rhodium.start();
  await say("again");
  expect((await posts(4)).map((p) => p.text)).toEqual(["fake reply", told, "fake reply", "fake reply"]);
  expect(asked()).toEqual(["first", "after", "again"]);
}, 60_000);

for (const before of [false, true]) {
  test(`story 118: killed between writing and written, the line taken in ${before ? "before" : "after"} the restart: written once, never lost`, async () => {
    const big = await killWhileWriting(before);
    const [, reply, ...more] = await posts(2);
    expect(reply).toMatchObject({ text: "fake reply", replyTo: big });
    expect(more).toEqual([]);
    // Nothing waits behind it: the next message goes through as usual.
    await say("third");
    expect((await posts(3)).map((p) => p.text)).toEqual(["fake reply", "fake reply", "fake reply"]);
    expect(asked()).toEqual(["first", BIG, "third"]);
    expect(count(inLog(), BIG)).toBe(1);
    expect(rhodium.claude.runs()).toHaveLength(1);
  }, 60_000);
}

test("story 118: a new conversation's first message, written across a restart, still leaves its session on record to resume", async () => {
  await slotA({ script: "turn", readAfter: 700 });
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes(BIG), 15_000); // the agent reads nothing yet
  await rhodium.kill9();
  await rhodium.start();
  expect(await posts(1)).toMatchObject([{ text: "fake reply", replyTo: messageId }]);

  await ok("stop", "w/a");
  await until(async () => (await state()) === "未运行", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await posts(2);
  const [first, again] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
}, 60_000);

test("story 118: a new conversation's agent takes its first message and exits while rhodium is down; its session is still on record to resume", async () => {
  await slotA({ script: "reply-then-exit", readAfter: 700 });
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes(BIG), 15_000); // marked writing; the agent reads nothing yet
  await rhodium.kill9();
  await until(async () => !(await holderUnit()), 15_000); // acked, answered and gone, all unseen
  await rhodium.start();
  expect(await posts(1)).toMatchObject([{ text: "bye", replyTo: messageId }]);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => rhodium.claude.runs().length === 2, 15_000);
  const [first, again] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
}, 60_000);

for (const [kind, flag] of [["a plain", 1], ["the emergency", 2]] as const) {
  test(`story 118: ${kind} stop on record when rhodium went down is carried out after the restart`, async () => {
    await slotA({ script: "turn" });
    await say("first");
    await posts(1);
    await rhodium.kill9();
    // As if rhodium went down after recording the stop and before stopping the agent.
    const db = new Database(join(rhodium.dir, "state/rh.db"));
    db.run("UPDATE holder SET stopRequested = ?", [flag]);
    db.close();
    await rhodium.start();
    await until(async () => !(await holderUnit()), 15_000);
    expect(await state()).toBe("未运行");
  }, 60_000);
}
