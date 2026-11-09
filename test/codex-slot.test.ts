// A Codex slot end to end (seam one): how rhodium launches Codex's app-server, sends to it, stops its
// turns, puts its approvals to you, takes over after a restart, and when it does not start it
// (architecture §6.4, spec codex.md).
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { terminalUnset } from "../src/agents";
import type { Posted } from "../src/fake-im";
import { installFakeAgent } from "./fake-agent/fake-agent";
import { BOARD_LOGIN, newInstance, recorded, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

let board = ""; // its address

/** A rhodium whose bot q sends your private chat to the Codex slot w/a. */
async function slot(opts: InstanceOptions = {}, env: Record<string, string> = {}): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  Object.assign(rhodium.env, env);
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await rhodium.ok("ws", "w", dir);
  await rhodium.ok("new", "w/a", "--agent", "codex");
  return dir;
}

const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });

/** Waits until the bot has posted n messages in your chat, and returns them. */
async function posts(n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

/** What each run of the fake codex was sent, parsed. */
const sent = () => rhodium.codex.runs().map((r) => r.stdin.map((l) => JSON.parse(l)));
/** Your messages in each run, as Codex got them. */
const told = () => sent().map((run) => run.filter((m) => m.method === "turn/start").map((m) => withoutSource(m.params.input[0].text)));
/** Makes the fake codex play another script from its next run on. */
const play = (script: string) => installFakeAgent(join(rhodium.dir, "bin"), { script }, "codex");

test("stories 483, 484, 486: a Codex slot runs your own codex's app-server, with nothing of Claude's, Herdr's or a parent Codex session's; the reply comes back", async () => {
  const dir = await slot({}, { ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "t", OPENAI_API_KEY: "sk-o", ACME_API_KEY: "sk-acme", CODEX_THREAD_ID: "parent" });
  const { messageId } = await say("hello");
  expect((await posts())[0]).toMatchObject({ text: "fake reply", replyTo: messageId });

  const [run, ...more] = rhodium.codex.runs();
  expect(more).toEqual([]);
  expect(rhodium.claude.runs()).toEqual([]);
  expect(run!.argv).toEqual(["app-server", "--listen", "stdio://"]);
  expect(run!.cwd).toBe(dir);
  expect(Object.keys(run!.env).filter((k) => /^(ANTHROPIC|CLAUDE|HERDR_|CODEX_THREAD_ID)/.test(k))).toEqual([]);
  // Codex's own keys do reach it: OpenAI's, and one a provider of yours names in its env_key (#435).
  expect(run!.env.OPENAI_API_KEY).toBe("<redacted>");
  expect(run!.env.ACME_API_KEY).toBe("<redacted>");
  // Nor does its terminal go without them.
  expect(terminalUnset("codex", rhodium.env).filter((k) => /^(OPENAI|ACME)_/.test(k))).toEqual([]);
  expect(run!.env.CODEX_HOME).toBe(join(rhodium.home, ".codex"));
  await say("/status");
  expect((await posts(2))[1]!.text).toContain("Agent：Codex CLI");
}, 30_000);

test("story 490: the conversation is the thread Codex made: after the process stops, the next message resumes it", async () => {
  await slot();
  await say("first");
  await posts(1);
  const thread = sent()[0]!.find((m) => m.method === "turn/start")!.params.threadId;
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await say("second");
  await posts(2);
  const again = sent()[1]!;
  expect(again.filter((m) => m.method === "thread/start")).toEqual([]);
  expect(again.find((m) => m.method === "thread/resume")!.params.threadId).toBe(thread);
  expect(told()).toEqual([["first"], ["second"]]);
}, 30_000);

test("story 488: a message while the turn runs joins it as a turn/start, and the turn's one reply answers the first", async () => {
  await slot({ codex: { script: "codex-until-steered" } });
  const first = await say("run the tests");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("also tell me the time");
  // The tool line by Codex's own name for it (story 487).
  expect((await posts())[0]).toMatchObject({ text: "[🔧 exec_command]\n\nsteered", replyTo: first.messageId });
  expect(told()).toEqual([["run the tests", "also tell me the time"]]);
  expect(sent()[0]!.filter((m) => m.method === "turn/steer")).toEqual([]);
}, 30_000);

test("story 488: /stop interrupts the running turn; nothing is left running, and the next message is a new turn", async () => {
  await slot({ codex: { script: "codex-until-interrupted" } });
  await say("sleep");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/stop");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const stop = sent()[0]!.find((m) => m.method === "turn/interrupt")!;
  expect(stop.params).toEqual({ threadId: sent()[0]!.find((m) => m.method === "turn/start")!.params.threadId, turnId: expect.any(String) });
  await say("again");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "fake reply"), 15_000);
  expect(rhodium.codex.runs()).toHaveLength(1);
}, 30_000);

/** Stands in for the slot's holder at its socket, for the next connection: passes everything on,
 *  but what the holder sends after its hello_ok, out.log fed again first, only once release() is
 *  called, as a slow replay would (#574). */
function holdReplay(): () => void {
  const dir = join(rhodium.dir, "run/hold");
  const sock = join(dir, readdirSync(dir)[0]!);
  renameSync(sock, `${sock}.held`);
  let release!: () => void;
  let queue = new Promise<void>((r) => (release = r));
  const server = createServer((rh) => {
    server.close();
    const holder = connect(`${sock}.held`);
    rh.pipe(holder);
    let greeted = false;
    holder.on("data", (chunk: Buffer) => {
      const at = greeted ? 0 : chunk.indexOf(10) + 1 || chunk.length;
      greeted ||= chunk[at - 1] === 10;
      rh.write(chunk.subarray(0, at));
      queue = queue.then(() => void rh.write(chunk.subarray(at)));
    });
    holder.on("close", () => void queue.then(() => rh.destroy()));
    rh.on("close", () => holder.destroy());
    for (const s of [rh, holder]) s.on("error", () => {});
  }).listen(sock);
  return release;
}

test("story 490: Rhodium restarts mid-turn; the turn goes on, a message still joins it, and its reply comes back", async () => {
  await slot({ codex: { script: "codex-until-steered" } });
  const first = await say("run the tests");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.stop();
  const release = holdReplay();
  await rhodium.start();
  await say("also tell me the time");
  // The message comes before the replay has told the driver which thread and turn run: it waits for it.
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  await until(() => db.query("SELECT 1 FROM agentInput WHERE body LIKE '%also tell me the time%'").get() !== null, 15_000);
  db.close();
  await Bun.sleep(300);
  release();
  expect((await posts())[0]).toMatchObject({ text: "[🔧 exec_command]\n\nsteered", replyTo: first.messageId });
  expect(rhodium.codex.runs()).toHaveLength(1);
  expect(told()).toEqual([["run the tests", "also tell me the time"]]);
}, 30_000);

test("story 491: Codex has no resume of its own: its resumed turn is told the last one was cut short", async () => {
  await slot({ codex: { script: "codex-crash" }, toml: "[limits]\ncrashCount = 2" });
  await say("work");
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000); // the second crash trips the breaker
  expect(told()).toEqual([["work"], ["上一回合被打断，先检查现状再继续。"]]);
  expect(sent()[1]!.filter((m) => m.method === "thread/resume")).toHaveLength(1);
}, 30_000);

test("story 492: the thread is open elsewhere: Codex is not started on it, you hear so, and your message waits for the next start", async () => {
  await slot();
  await say("first");
  await posts(1);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  play("codex-locked");
  await say("second");
  const [, notice] = await posts(2);
  expect(notice!.text).toBe(
    "w/a 没能启动，这段对话别处正在用。那边退出后再发一条消息，等着的消息会一起交给它。\n原因：Codex 说别的程序开着它。你自己的 codex 退出后，它连的后台服务还会占一阵，最长 30 分钟。",
  );
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(told()[1]).toEqual([]);

  play("codex-turn");
  await say("third");
  await posts(3);
  expect(told()[2]).toEqual(["second", "third"]);
}, 30_000);

/** Waits for a post, among those after the first `from`, that has text in it; returns its index. */
async function find(text: string, from = 0): Promise<number> {
  const at = async () => (await rhodium.im.log("q", ME)).findIndex((p, i) => i >= from && p.text.includes(text));
  await until(async () => (await at()) >= 0, 15_000);
  return at();
}
/** Codex's answers from rhodium, in a run: the lines with no method. */
const answers = (run: any[]) => run.filter((m) => m.method === undefined);

test("stories 494, 495: approval on: each command and patch of Codex's comes to IM; 1 allows, and other words decline, then reach Codex in the same turn", async () => {
  await slot({ codex: { replay: join(import.meta.dir, "fixtures/codex/untrusted") } });
  await rhodium.ok("set", "w/a", "approval=on");
  await say("Run the shell command `ls`. Then run `touch a.txt`. Then use apply_patch to create b.txt containing the line hi. Then reply with the single word: done.");
  let at = await find("要运行这条命令，允许吗？\n\nls\n\n回别的话算拒绝，并转告它。");
  await say("1");
  at = await find("要运行这条命令，允许吗？\n\ntouch a.txt\n", await find("已允许运行这条命令。", at));
  await say("1");
  at = await find("要改 /tmp/…/project/b.txt，允许吗？\n\nhi\n\n回别的话算拒绝，并转告它。", at);
  await say("1");
  at = await find("done", await find("已允许改 /tmp/…/project/b.txt。", at));
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await say("Run the shell command `rm a.txt`, then reply with the single word: done.");
  at = await find("要运行这条命令，允许吗？\n\nrm a.txt\n", at);
  const words = "Don't delete a.txt. Rename it to a.txt.bak instead, then reply with the single word: renamed.";
  await say(words);
  at = await find("要运行这条命令，允许吗？\n\nmv a.txt a.txt.bak\n", await find(`已拒绝，并转告：“${words}”`, at));
  await say("1");
  await find("renamed", at);

  const [run, ...more] = sent();
  expect(more).toEqual([]);
  expect(run!.find((m) => m.method === "thread/start")!.params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
  expect(answers(run!).map((m) => m.result.decision)).toEqual(["accept", "accept", "accept", "decline", "accept"]);
  // Codex's no takes no words: they go into the turn right after it.
  const steer = run!.findIndex((m) => m.method === "turn/steer");
  expect(run![steer - 1]).toEqual({ id: 3, result: { decision: "decline" } });
  expect(run![steer].params.input).toEqual([{ type: "text", text: words, text_elements: [] }]);
}, 60_000);

test("story 495: an approval nobody answers in time is declined, and the careful words go into the turn after it", async () => {
  await slot({ codex: { script: "codex-approval" }, toml: '[durations]\naskTimeout = "1s"' });
  await rhodium.ok("set", "w/a", "approval=on");
  await say("build it");
  await find("要运行这条命令，允许吗？\n\nmake\n");
  await find("answered");
  const run = sent()[0]!;
  const steer = run.findIndex((m) => m.method === "turn/steer");
  expect(run[steer - 1]).toEqual({ id: 1, result: { decision: "decline" } });
  expect(run[steer].params.input).toEqual([{ type: "text", text: "用户暂时无法回答，请按你的最佳判断继续", text_elements: [] }]);
}, 30_000);

test("story 490: Rhodium restarts with an approval open: it is not asked again, and your answer still reaches Codex", async () => {
  await slot({ codex: { script: "codex-approval" } });
  await rhodium.ok("set", "w/a", "approval=on");
  await say("build it");
  await find("要运行这条命令，允许吗？\n\nmake\n");
  await recorded(rhodium, "SELECT 1 FROM ask WHERE status = 'open' AND pushedAt IS NOT NULL");
  await rhodium.stop();
  await rhodium.start();
  await Bun.sleep(500); // a second push would show up by now
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  expect(await rhodium.state("w/a")).toBe("需要你");
  await say("1");
  await find("answered", await find("已允许运行这条命令。"));
  expect(rhodium.codex.runs()).toHaveLength(1);
  expect(answers(sent()[0]!)).toEqual([{ id: 1, result: { decision: "accept" } }]);
}, 30_000);

test("story 497: rh set approval while Codex's turn runs: no restart; you hear it holds from the next turn, and each turn/start from then on carries it", async () => {
  await slot({ codex: { script: "codex-until-steered" } });
  await say("run the tests");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect((await rhodium.ok("set", "w/a", "approval=on")).trim()).toEndWith("\nCodex 从下一个回合起按新设置跑。");
  await say("also tell me the time");
  await find("steered");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await rhodium.ok("set", "w/a", "approval=off")).not.toContain("下一个回合");
  await rhodium.ok("set", "w/a", "approval=on");
  await say("again");
  await find("fake reply");
  expect(rhodium.codex.runs()).toHaveLength(1);
  expect(sent()[0]!.filter((m) => m.method === "turn/start").map((m) => m.params.approvalPolicy)).toEqual(["never", "untrusted", "untrusted"]);
}, 30_000);

test("story 498: approval on, and this Codex no longer takes untrusted: it does not start, you hear why, and your messages wait", async () => {
  await slot({ codex: { script: "codex-no-untrusted" } });
  await rhodium.ok("set", "w/a", "approval=on");
  await say("hello");
  const [notice] = await posts(1);
  expect(notice!.text).toBe(
    "w/a 崩溃了，没能启动。\n等着的消息都还在，不用重发。下次来消息时再启动它，到时一起交给它。\n原因：这一版 Codex 不再接受“每条都问”的审批设置，审批开的 Codex 槽位起不来。关掉这个槽位的审批再发一条，或者换回旧版 codex。",
  );
  expect(told()).toEqual([[]]);

  await rhodium.ok("set", "w/a", "approval=off");
  await say("again");
  await posts(2);
  expect(told()).toEqual([[], ["hello", "again"]]);
}, 30_000);

test("stories 507, 509: the board shows a Codex slot's conversation from Codex's own record, and its last line; rh read and /resume read it too", async () => {
  await slot();
  await say("hello");
  await posts(1);
  const get = async (path: string) => (await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
  const card = Object.values((await get("/api/board")).workspaces[0].groups).flat().find((c: any) => c.name === "a") as any;
  expect(card.last).toMatchObject({ role: "assistant", text: "fake reply" });
  const { blocks } = await get(`/api/messages?slot=${card.id}`);
  expect(blocks.map((b: { kind: string; text: string }) => [b.kind, b.text])).toEqual([
    ["user", "hello"],
    ["assistant", "fake reply"],
  ]);
  expect(await rhodium.ok("read", "w/a")).toMatch(/收到：.* hello\n[\s\S]*回复：fake reply/);
  // The slot's own conversation, by what you said first: the only agent in the list, so not marked.
  await say("/resume");
  expect((await posts(2))[1]!.buttons!.map((b) => b.label)).toEqual([expect.stringMatching(/^★ \d\d:\d\d hello$/), "取消"]);
}, 30_000);

/** The bot's latest message, as it shows now, once it has sent more than `before`. */
async function next(before: number): Promise<Posted> {
  await until(async () => (await rhodium.im.shown("q", ME)).length > before, 15_000);
  return (await rhodium.im.shown("q", ME)).at(-1)!;
}
const labels = (p: Posted) => (p.buttons ?? []).map((b) => b.label);

test("story 499: /model in two steps, Codex's models by name and then the levels of the one picked; the next turn carries both, and /status says them, also once Codex no longer runs", async () => {
  await slot();
  await say("hello");
  await posts(1);
  await say("/model");
  const models = await next(1);
  expect(models.text).toBe("换哪个模型？\n现在：默认（GPT-6.1-Sol），思考强度 medium");
  expect(labels(models)).toEqual(["★ 默认（GPT-6.1-Sol）", "GPT-6-Luna", "取消"]);
  await rhodium.im.press("q", ME, models, "GPT-6-Luna");
  const step = await next(2);
  expect(step.text).toBe("已切到 GPT-6-Luna。\n思考强度要改吗？现在是 medium。");
  // GPT-6-Luna has no ultra.
  expect(labels(step)).toEqual(["low", "★ medium", "high", "xhigh", "max", "取消"]);
  await rhodium.im.press("q", ME, step, "high");
  expect((await next(3)).text).toBe("思考强度改成 high。");

  await say("next");
  await next(4);
  expect(sent()[0]!.filter((m) => m.method === "turn/start").map((m) => [m.params.model, m.params.effort])).toEqual([[undefined, undefined], ["gpt-6-luna", "high"]]);
  await say("/status");
  const status = (await next(5)).text;
  expect(status).toContain("Agent：Codex CLI\n模型：GPT-6-Luna high");
  // Nearly full, the 7-day window shows (story 500).
  expect(status).toContain("额度信息\n91% 7d");

  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await say("/status");
  expect((await next(6)).text).toContain("模型：GPT-6-Luna high");
  // A new process carries the slot's model and level from its first turn.
  await say("again");
  await next(7);
  expect(sent()[1]!.filter((m) => m.method === "turn/start").map((m) => [m.params.model, m.params.effort])).toEqual([["gpt-6-luna", "high"]]);
}, 30_000);

test("story 499: /model to a model without the level in use moves the level to that model's default, and the slot keeps both; a process taken over after a restart carries them", async () => {
  await slot();
  await say("/effort ultra");
  expect((await next(0)).text).toBe("思考强度改成 ultra。");
  await say("/model gpt-6-luna");
  const step = await next(1);
  expect(step.text).toBe("已切到 GPT-6-Luna。\n思考强度要改吗？现在是 medium。");
  expect(labels(step)).toEqual(["low", "★ medium", "high", "xhigh", "max", "取消"]);
  // The second step left alone; Rhodium restarts before the next turn.
  await rhodium.stop();
  await rhodium.start();
  await say("hello");
  await next(2);
  expect(rhodium.codex.runs()).toHaveLength(1);
  expect(sent()[0]!.filter((m) => m.method === "turn/start").map((m) => [m.params.model, m.params.effort])).toEqual([["gpt-6-luna", "medium"]]);
}, 30_000);

test("story 499: /effort offers all six levels on Codex's default model, and the one picked goes on the next turn", async () => {
  await slot();
  await say("/effort");
  const panel = await next(0);
  expect(panel.text).toBe("思考强度改成哪档？\n现在：medium");
  expect(labels(panel)).toEqual(["low", "★ medium", "high", "xhigh", "max", "ultra", "取消"]);
  await rhodium.im.press("q", ME, panel, "ultra");
  expect((await next(1)).text).toBe("思考强度改成 ultra。");
  await say("hello");
  await next(2);
  expect(sent()[0]!.find((m) => m.method === "turn/start")!.params.effort).toBe("ultra");
}, 30_000);

test("story 501: /compact runs as a turn of its own; a message meanwhile waits for it, then has its own turn and reply", async () => {
  await slot({ codex: { script: "codex-compact" } });
  await say("hello");
  await posts(1);
  await say("/compact");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  const later = await say("and now?");
  const [, compacted, reply] = await posts(3);
  expect(compacted!.text).toBe("已压缩上下文，从约 127 tokens 减到约 50 tokens。");
  expect(reply).toMatchObject({ text: "fake reply", replyTo: later.messageId });
  expect(told()).toEqual([["hello", "and now?"]]);
}, 30_000);
