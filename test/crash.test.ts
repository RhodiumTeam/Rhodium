// A crash is told to you (story 123, product §4.5, architecture §4.8), seen from seam one. Every
// kill -9 goes to a PID this test instance recorded itself, or one systemd gives for its own unit.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../src/contracts";
import type { Posted } from "../src/fake-im";
import type { Script, Step } from "./fake-agent/fake-agent";
import { codexKilledUntaken, codexKilledWithSteer, crashing, endTurn, joinTurn, lifecycle, on, piKilledUntaken, piKilledWithSteer, queueMidTurn, saying, selfStart, startTurn, state as claudeState, takeQueued, toolUse } from "./fake-agent/scripts";
import { BOARD_LOGIN, mainPid, newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

let board = ""; // the board's address, once slotA has started rhodium

/** Bot q sends your messages to slot w/a. */
async function slotA(opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  board = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
}

async function posts(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

const state = () => rhodium.state("w/a");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** kill -9 of the slot's holder (or another signal): only the PID systemd gives for this instance's own unit, once it is surely its holder. */
async function killHolder(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  const unit = (await rhodium.units()).find((u) => u.includes("hold-"))!;
  const pid = await mainPid(unit);
  expect(readFileSync(`/proc/${pid}/cmdline`, "utf8")).toContain(`\0run\0${join(rhodium.dir, "state/hold")}/`);
  process.kill(pid, signal);
}

/** What the slot's holder took for the agent's stdin. */
function inLog(): string {
  const dir = join(rhodium.dir, "state/hold");
  const [conversation] = existsSync(dir) ? readdirSync(dir) : [];
  return conversation ? readFileSync(join(dir, conversation, "in.log"), "utf8") : "";
}

/** Every line written to the fake claude's stdin, over all its runs. */
const stdin = () => rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)));
const said = () => stdin().filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text));

// Story 123 is the notice alone: these crashes are not resumed (story 124).
const noResume = "[defaults]\ncrashResume = false";

// A turn that never ends.
const busy: Script = { on, steps: [...startTurn, { wait: { type: "never" } }] };

test("story 123: kill -9 of the holder mid-turn: the agent goes with it, and you get a crash notice", async () => {
  await slotA({ claude: { script: busy }, toml: noResume });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "运行中", 15_000);
  const agent = rhodium.claude.runs()[0]!.pid;

  await killHolder();
  await until(async () => (await state()) === "崩溃", 15_000);
  await until(() => !alive(agent), 15_000);
  const [notice, ...more] = await posts(1);
  expect(notice!.text).toBe("w/a 崩溃了，这一回合没做完。\n发一条消息就恢复这段对话。\n原因：托管进程断开了");
  expect(more).toEqual([]);
}, 30_000);

test("story 123: an ask open when the agent crashes is void: the notice says so, and your answer to it goes to the agent as a new message", async () => {
  await slotA({ claude: { script: "ask" }, toml: noResume });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "go" });
  const [ask] = await posts(1);
  expect(ask!.text).toContain("echo hi");

  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  await until(async () => (await state()) === "崩溃", 15_000);
  const [, notice] = await posts(2);
  expect(notice!.text).toContain("w/a 崩溃了");
  expect(notice!.text).toBe("w/a 崩溃了，这一回合没做完。\n发一条消息就恢复这段对话。\n原因：agent 被信号 KILL 结束\n\n它那条提问作废了，之后回的编号会当成新消息。");

  // Your answer is no answer any more: it goes on as a message of its own, which starts the agent again.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "1" });
  await until(() => said().includes("1"), 15_000);
  expect(stdin().filter((m) => m.type === "control_response" && m.response?.request_id === "fake-ask-1")).toEqual([]);
  expect((await rhodium.im.log("q", ME)).filter((p) => p.text.startsWith("已回答"))).toEqual([]);
}, 30_000);

// Longer than the 64 KiB pipe buffer, so it sticks in stdin while the agent reads nothing.
const BIG = `部署到生产 ${"x".repeat(200 * 1024)}`;

test("story 123: a message going in when the holder dies may or may not have got there: never written again, and the notice asks you to check and send it again", async () => {
  await slotA({ claude: { script: "turn" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await posts(1);
  const agent = rhodium.claude.runs()[0]!.pid;
  process.kill(agent, "SIGSTOP"); // it reads nothing more
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes("部署到生产"), 15_000); // marked writing; the holder is on it

  await killHolder();
  const [, notice] = await posts(2);
  // Quoted up to 60 characters; too long for a copy button, or a message of its own. Claude never
  // took that message in, so it has no turn to resume (story 124): the slot waits for your next one.
  expect(notice!.text).toBe(`w/a 崩溃了。\n发一条消息就恢复这段对话。\n原因：托管进程断开了\n\n这条不确定它收到没有，需要的话再发一遍：\n“${BIG.slice(0, 60)}…”`);
  expect(notice!.buttons).toBeUndefined();

  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "after" });
  const [, , reply] = await posts(3);
  expect(reply).toMatchObject({ text: "fake reply", replyTo: messageId });
  expect(said()).toEqual(["first", "after"]);
}, 30_000);

test("story 123: a message that may or may not have got there comes with a copy button holding all of it, to send it again", async () => {
  // copy: the fake's own key, the longest text its copy button takes; QQ's and Telegram's are far shorter than BIG.
  await slotA({ claude: { script: "turn" }, toml: noResume, bots: { q: { like: "qq", owner: ME, target: "w/a", copy: String(BIG.length) } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await posts(1);
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGSTOP"); // it reads nothing more
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: BIG });
  await until(() => inLog().includes("部署到生产"), 15_000); // marked writing; the holder is on it

  await killHolder();
  const [, notice] = await posts(2);
  expect(notice!.text).toEndWith(`这条不确定它收到没有，需要的话再发一遍：\n“${BIG.slice(0, 60)}…”`);
  expect(notice!.buttons).toEqual([{ label: "复制", data: BIG, copy: true }]);
}, 30_000);

test("story 123: a quote too long for the copy button, but not for a message, follows the notice in a message of its own (2026-10-21)", async () => {
  await slotA({ claude: { script: "turn" }, toml: noResume, bots: { q: { like: "qq", owner: ME, target: "w/a", copy: "10" } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await posts(1);
  // A stopped holder takes the message in, but never says it went on to the agent.
  await killHolder("SIGSTOP");
  const QUOTE = "帮我看下测试，然后部署到生产";
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: QUOTE });
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  await until(() => db.query("SELECT 1 FROM agentInput WHERE status = 'writing'").all().length > 0, 15_000);
  db.close();

  await killHolder();
  const [, notice, alone] = await posts(3);
  expect(notice!.text).toEndWith(`这条不确定它收到没有，需要的话再发一遍：\n“${QUOTE}”`);
  expect(notice!.buttons).toBeUndefined();
  expect(alone!.text).toBe(QUOTE);
}, 30_000);

// Claude keeps a message that comes while a tool runs in its own queue, and takes it into the turn
// only at the next tool boundary (command_lifecycle started); pi, a steering message, once the tool
// ends (a user message_start); Codex, once its user message item carries the message's id. Killed before then, the agent never had it, though the holder wrote
// it whole: a real-device check on 2026-10-22 lost one so, unquoted.
const killedWith: Record<AgentKind, (taken: boolean) => InstanceOptions> = {
  claude: (taken) => {
    const steps = [...startTurn, toolUse("toolu_sleep", "Bash", { command: "sleep 60" }), ...queueMidTurn, ...(taken ? [takeQueued] : []), { sleep: 100 }, { kill: "SIGKILL" as const }];
    return { claude: { script: { on, steps } } };
  },
  pi: (taken) => ({ pi: { script: piKilledWithSteer(taken) } }),
  codex: (taken) => ({ codex: { script: codexKilledWithSteer(taken) } }),
};
for (const [agent, taken] of [["claude", false], ["claude", true], ["pi", false], ["pi", true], ["codex", false], ["codex", true]] as const) {
  test(`story 123: ${agent} killed with a message of yours it ${taken ? "took into the turn: not quoted" : "only queued: quoted, with a copy button"}; nor ever the turn's first`, async () => {
    rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } }, toml: noResume, ...killedWith[agent](taken) });
    await rhodium.start();
    await rhodium.slots("a");
    if (agent !== "claude") await rhodium.ok("agent", "w/a", agent);
    await rhodium.im.inject("t", { chat: ME, sender: ME, text: "跑一下测试" });
    await until(async () => (await state()) === "运行中", 15_000);
    const { messageId } = await rhodium.im.inject("t", { chat: ME, sender: ME, text: "复制测试" });

    const notices = async () => (await rhodium.im.log("t", ME)).filter((p) => p.text.startsWith("w/a 崩溃了"));
    await until(async () => (await notices()).length === 1, 15_000);
    const [notice] = await notices();
    const head = "w/a 崩溃了，这一回合没做完。\n发一条消息就恢复这段对话。\n原因：agent 被信号 KILL 结束";
    expect(notice!.text).toBe(taken ? head : `${head}\n\n这条不确定它收到没有，需要的话再发一遍：\n“复制测试”`);
    expect(notice!.buttons).toEqual(taken ? undefined : [{ label: "复制", data: "复制测试", copy: true }]);
    if (taken) return;

    // Told once: it is left as it is, and the next process neither has it nor quotes it again.
    expect(await rhodium.ok("trace", messageId)).toContain("\n投给 agent：w/a，结局不明，没有重发\n");
    await rhodium.im.inject("t", { chat: ME, sender: ME, text: "继续" });
    await until(async () => rhodium[agent].runs().length === 2 && (await state()) === "运行中", 15_000);
    process.kill(rhodium[agent].runs()[1]!.pid, "SIGKILL");
    await until(async () => (await notices()).length === 2, 15_000);
    expect((await notices())[1]!.text).toBe(head);
  }, 30_000);
}

/** What each run of the agent was written, as you sent it: Claude's user frames, pi's prompts, Codex's turn/starts. */
const written = (agent: AgentKind) =>
  rhodium[agent].runs().map((r) =>
    r.stdin
      .map((l) => JSON.parse(l))
      .filter((m) => (agent === "codex" ? m.method === "turn/start" : m.type === (agent === "pi" ? "prompt" : "user")))
      .map((m) => withoutSource(agent === "codex" ? m.params.input[0].text : agent === "pi" ? m.message : m.message.content[0].text)),
  );

// Rhodium begins a turn when it hands the agent your message (architecture §3), before the agent has
// it. Killed before it took in any message of that turn, the agent has no turn to resume: on a
// real-device check on 2026-10-22, a Claude that never had "复制测试" was told to resume, and dug up
// old work instead.
// From idle, Claude says it is running before it takes the message in, so the kill lands after a
// turn start and still before the message is in the conversation.
const killedUntaken: Record<AgentKind, InstanceOptions> = {
  claude: { claude: { script: { on, steps: [...startTurn, ...endTurn("fake reply"), { wait: { type: "user" } }, { emit: [claudeState("running"), lifecycle("queued")] }, { sleep: 100 }, { kill: "SIGKILL" }] } } },
  pi: { pi: { script: piKilledUntaken } },
  codex: { codex: { script: codexKilledUntaken } },
};
for (const agent of ["claude", "pi", "codex"] as const) {
  test(`story 124: ${agent} killed before it took in any message of the turn: nothing to resume, the notice quotes the message, and the slot waits for your next one`, async () => {
    await slotA(killedUntaken[agent]);
    if (agent !== "claude") await rhodium.ok("agent", "w/a", agent);
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "跑一下测试" });
    await posts(1);
    await until(async () => (await state()) === "空闲", 15_000);
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "复制测试" });

    const [, notice] = await posts(2);
    expect(notice!.text).toBe("w/a 崩溃了。\n发一条消息就恢复这段对话。\n原因：agent 被信号 KILL 结束\n\n这条不确定它收到没有，需要的话再发一遍：\n“复制测试”");
    expect(notice!.buttons).toEqual([{ label: "复制", data: "复制测试", copy: true }]);
    await Bun.sleep(500); // a resume would have started by now
    expect(rhodium[agent].runs()).toHaveLength(1);
    expect(await state()).toBe("崩溃");

    // Your next message starts it plainly: no resume prompt before it.
    const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "继续" });
    const [, , reply] = await posts(3);
    expect(reply).toMatchObject({ text: "fake reply", replyTo: messageId });
    expect(written(agent)).toEqual([["跑一下测试", "复制测试"], ["继续"]]);
    if (agent === "claude") expect(rhodium.claude.runs()[1]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined();
  }, 30_000);

  test(`story 124: ${agent} killed with the turn's first message taken in and a later one only queued: the turn is resumed, and the notice quotes the later one`, async () => {
    await slotA(killedWith[agent](false));
    if (agent !== "claude") await rhodium.ok("agent", "w/a", agent);
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "跑一下测试" });
    await until(async () => (await state()) === "运行中", 15_000);
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "复制测试" });

    const [notice] = await posts(1);
    expect(notice!.text).toBe("w/a 崩溃了，这一回合没做完。\n正在自动恢复这段对话。\n原因：agent 被信号 KILL 结束\n\n这条不确定它收到没有，需要的话再发一遍：\n“复制测试”");
    expect(notice!.buttons).toEqual([{ label: "复制", data: "复制测试", copy: true }]);
    // Claude runs the turn again by itself; pi and Codex are told to.
    if (agent === "claude") await until(() => rhodium.claude.runs()[1]?.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === "1", 15_000);
    else await until(() => written(agent)[1]?.[0] === "上一回合被打断，先检查现状再继续。", 15_000);
  }, 30_000);
}

/** The first value of the flag in argv, as --name value or --name=value. */
const flag = (argv: string[], name: string) => argv.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
const userFrames = (stdin: string[]) => stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user");

test("story 124: the agent crashes mid-turn: after the notice the conversation resumes by itself, and the turn runs again to its reply", async () => {
  await slotA({ claude: { script: crashing("resumed") } });
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [notice, reply] = await posts(2);
  expect(notice!.text).toContain("w/a 崩溃了");
  expect(notice!.text).toContain("正在自动恢复");
  expect(reply).toMatchObject({ text: "resumed", replyTo: messageId });

  const [first, again, ...more] = rhodium.claude.runs();
  expect(more).toEqual([]);
  expect(again!.argv).toContain(`--resume=${flag(first!.argv, "--session-id")}`);
  // Claude runs the interrupted turn again by itself (probe 9): nothing more is written to it.
  expect(first!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined();
  expect(again!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
  expect(userFrames(again!.stdin)).toEqual([]);
  await until(async () => (await state()) === "空闲", 15_000);
}, 30_000);

test("story 124: Claude runs the interrupted turn again by itself and crashes again: the resume it never needed is not quoted", async () => {
  await slotA({ claude: { script: crashing(null) }, toml: "[limits]\ncrashCount = 2" });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000); // the second crash trips the breaker
  const [first, second] = await posts(2);
  expect(first!.text).toContain("正在自动恢复");
  expect(userFrames(rhodium.claude.runs()[1]!.stdin)).toEqual([]);
  expect(second!.text).toBe("w/a 崩溃了，这一回合没做完。\n10 分钟里崩了 2 次，不再自动恢复。发一条消息就重新启动它。\n原因：agent 退出，退出码 1");
  expect(second!.buttons).toBeUndefined();
}, 30_000);

test("story 124: pi has no resume of its own: its resumed run is told the last turn was cut short and to check where things stand first", async () => {
  await slotA({ pi: { script: "pi-crash" }, toml: "[limits]\ncrashCount = 2" });
  await rhodium.ok("agent", "w/a", "pi");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000); // the second crash trips the breaker
  const prompts = rhodium.pi.runs().map((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "prompt").map((m) => withoutSource(m.message)));
  expect(prompts).toEqual([["work"], ["上一回合被打断，先检查现状再继续。"]]);
}, 30_000);

test("story 125: the third crash within 10 minutes trips the breaker: no more resumes, the slot waits for you, and your message resumes it", async () => {
  await slotA({ claude: { script: crashing(null) } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000);
  const notices = (await posts(3)).map((p) => p.text);
  expect(notices.slice(0, 2).every((t) => t.includes("正在自动恢复"))).toBe(true);
  expect(notices[2]).toContain("\n10 分钟里崩了 3 次，不再自动恢复。发一条消息就重新启动它。\n");
  await Bun.sleep(500); // a resume would have started by now
  expect(rhodium.claude.runs()).toHaveLength(3);
  expect(await rhodium.im.log("q", ME)).toHaveLength(3);
  // On the board it needs you (product §4).
  type Board = { workspaces: { name: string; groups: Record<string, { name: string; state: string }[]> }[] };
  const r = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  expect(((await r.json()) as Board).workspaces[0]!.groups.needsYou!.map((c) => [c.name, c.state])).toEqual([["a", "崩溃"]]);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => rhodium.claude.runs().length === 4, 15_000);
  expect(rhodium.claude.runs()[3]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined();
  // It crashes too, still within the window: done with, before the test ends.
  await until(async () => (await state()) === "崩溃", 15_000);
  expect(rhodium.claude.runs()).toHaveLength(4);
}, 30_000);

test("story 125: only crashes within the window count: the breaker trips on crashCount of them, not on older ones", async () => {
  // 3 s: a crash and its resume take more than 1 s on a busy machine (#575).
  await slotA({ claude: { script: crashing(null) }, toml: '[limits]\ncrashCount = 2\n[durations]\ncrashWindow = "3s"' });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000);
  expect(rhodium.claude.runs()).toHaveLength(2);
  await Bun.sleep(3200); // both out of the window now

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => rhodium.claude.runs().length === 4, 15_000); // its crash is the only one counted: resumed once more
  await until(async () => (await state()) === "崩溃", 15_000);
  expect(rhodium.claude.runs()).toHaveLength(4);
}, 30_000);

/** At most one slot runs, and idle agents are reaped after 1 s. Bot qb goes to w/b, a pi taking
 *  1.5 s a turn, which you start first; then w/a, which yours always wakes, crashes mid-turn.
 *  Resolves to the board's address. */
async function crashAtLimit(): Promise<string> {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } },
    claude: { script: crashing("resumed") },
    pi: { script: "pi-slow" },
    toml: '[limits]\nmaxRunning = 1\n[durations]\nidleReap = "1s"',
  });
  const d = await rhodium.start();
  await rhodium.slots("a", "b");
  await rhodium.ok("agent", "w/b", "pi");
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "busy" });
  await until(async () => (await rhodium.state("w/b")) === "运行中", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000);
  return `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
}

test("the crash resume is a wake of Rhodium's own: at the running limit it waits for room, and starts once there is", async () => {
  const board = await crashAtLimit();
  const [notice] = await posts(1);
  expect(notice!.text).toContain("\n同时运行的槽位满了，有空位就自动恢复。\n");
  expect(rhodium.claude.runs()).toHaveLength(1);
  // On the board it runs, waiting for room: it does not need you (product §4).
  type Board = { workspaces: { name: string; groups: Record<string, { name: string; state: string }[]> }[] };
  const r = await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const groups = ((await r.json()) as Board).workspaces.find((w) => w.name === "w")!.groups;
  expect(groups.needsYou).toEqual([]);
  expect(groups.running!.find((c) => c.name === "a")?.state).toBe("崩溃，有空位后自动恢复");

  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  const [, reply] = await posts(2);
  expect(reply!.text).toBe("resumed");
  expect(rhodium.claude.runs()[1]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
  await until(async () => (await state()) === "未运行", 15_000); // reaped, before the test ends
}, 30_000);

test("approval mode changed with rh set after the crash: no resume, the slot waits for your message", async () => {
  await crashAtLimit();
  expect(await rhodium.ok("set", "w/a", "approval=on")).toContain("不再自动恢复");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  await Bun.sleep(500); // a resume would have started by now
  expect(rhodium.claude.runs()).toHaveLength(1);
  expect(await state()).toBe("崩溃");

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => rhodium.claude.runs().length === 2, 15_000);
  expect(rhodium.claude.runs()[1]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined();
  // That turn crashes too and is resumed; done with, and reaped, before the test ends.
  await until(async () => (await state()) === "未运行", 15_000);
}, 30_000);

test("approval mode changed with rh set once the resume has started: it goes on, and the reply does not say otherwise", async () => {
  // Slow to read stdin, so Claude has not answered initialize yet when rh set comes.
  await slotA({ claude: { script: crashing("resumed"), readAfter: 1500 } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [notice] = await posts(1);
  expect(notice!.text).toContain("正在自动恢复");
  expect(await rhodium.ok("set", "w/a", "approval=on")).not.toContain("不再自动恢复");
  const [, reply] = await posts(2);
  expect(reply!.text).toBe("resumed");
  await until(async () => (await state()) === "空闲", 15_000);
}, 30_000);

test("a resumed Claude that exits before it answers initialize leaves no resume behind: the slot needs you, and your next message starts it plainly", async () => {
  // A turn that never ends; resumed, it exits at once. Slow to read stdin, so that is surely before
  // it answers initialize.
  const exitOnResume: Script = { on, steps: [{ goto: startTurn.length + 2, env: "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" }, ...busy.steps, { exit: 1 }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: exitOnResume, readAfter: 200 } });
  const d = await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "运行中", 15_000);
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  const [resuming, failed] = await posts(2);
  expect(resuming!.text).toContain("正在自动恢复");
  expect(failed!.text).toContain("没能启动");
  expect(failed!.text).toContain("\n发一条消息就恢复这段对话。\n");
  expect(rhodium.claude.runs()[1]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");

  // Nothing resumes it by itself: on the board it needs you (product §4).
  type Board = { workspaces: { name: string; groups: Record<string, { name: string; state: string }[]> }[] };
  const r = await fetch(`http://${d.logs.find((l) => l.msg === "ready")!.board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const groups = ((await r.json()) as Board).workspaces.find((w) => w.name === "w")!.groups;
  expect(groups.needsYou!.map((c) => [c.name, c.state])).toEqual([["a", "崩溃"]]);
  expect(groups.running).toEqual([]);

  // Your message starts it as any start: no resume, so no resume prompt before it.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "again" });
  await until(() => rhodium.claude.runs().length === 3, 15_000);
  expect(rhodium.claude.runs()[2]!.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined();
  await until(async () => (await state()) === "运行中", 15_000);
  expect(said()).toEqual(["work", "again"]);
}, 30_000);

// An agent that takes your message and exits at once, as Claude does on a --resume it cannot do: what it
// last wrote to stderr is why, and the notice quotes it (2026-10-22).
const failsToStart = (stderr: string): Script => ({ on, steps: [{ wait: { type: "user" } }, { stderr }, { exit: 1 }] });
const NOT_STARTED = "w/a 崩溃了，没能启动。\n发一条消息就恢复这段对话。\n原因：agent 退出，退出码 1";
const LONG = "x".repeat(500);
for (const [what, stderr, quoted] of [
  [
    "its last 3 lines, colour codes gone",
    "\x1b[1mwarming up\x1b[0m\nstill warming\n\x1b[31mError:\x1b[0m bad flag\n  at main (cli.js:1:1)\n\nNo conversation found with session ID: abc\n",
    "Error: bad flag\n  at main (cli.js:1:1)\nNo conversation found with session ID: abc",
  ],
  ["300 characters of it at most", `${LONG}\n`, `${LONG.slice(0, 300)}…`],
] as const) {
  test(`story 123: an agent that exits as it starts: the notice quotes what it last wrote to stderr, ${what}`, async () => {
    await slotA({ claude: { script: failsToStart(stderr) } });
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
    const [notice] = await posts(1);
    expect(notice!.text).toBe(`${NOT_STARTED}\n它最后报的错：\n${quoted}\n\n这条不确定它收到没有，需要的话再发一遍：\n“hi”`);
  }, 30_000);
}

test("story 123: a crash mid-turn quotes no error output; nor does a start that fails after it, of what the process before wrote", async () => {
  // Writes to stderr and dies mid-turn; resumed, it exits at once, saying nothing.
  const steps = [{ goto: 1 + startTurn.length + 3, env: "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" }, ...startTurn, { stderr: "old trouble\n" }, { sleep: 100 }, { exit: 1 }, { exit: 1 }];
  await slotA({ claude: { script: { on, steps } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  const [midTurn, atStart] = await posts(2);
  expect(midTurn!.text).toBe("w/a 崩溃了，这一回合没做完。\n正在自动恢复这段对话。\n原因：agent 退出，退出码 1");
  expect(atStart!.text).toBe(NOT_STARTED);
}, 30_000);

test("story 126: with crash resume off for the slot, a crash stops it", async () => {
  await slotA({ claude: { script: crashing("resumed") } });
  await rhodium.ok("set", "w/a", "crash-resume=off");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await state()) === "崩溃", 15_000);
  const [notice] = await posts(1);
  expect(notice!.text).toContain("\n发一条消息就恢复这段对话。\n");
  await Bun.sleep(500);
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 30_000);

// An internal turn (here rh send's) dies 1.5 s in, after your message joined it unread (#215).
const internalCrash: Step[] = [...startTurn, { sleep: 1500 }, { exit: 1 }];
/** Starts an internal turn on w/a, then sends your message into it. */
async function intoInternal(): Promise<void> {
  await rhodium.ok("send", "w/a", "work");
  await until(async () => (await state()) === "运行中", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "你的话" });
}
const unread = "原因：agent 退出，退出码 1\n\n这条不确定它收到没有，需要的话再发一遍：\n“你的话”";

test("story 124: an internal turn your message joined crashes as a turn of yours: resumed, the notice quotes your unread message, and its reply comes to you", async () => {
  const resumed = 1 + internalCrash.length;
  const steps: Step[] = [{ goto: resumed, env: "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" }, ...internalCrash, selfStart, ...endTurn("内部回合续完了"), { wait: { type: "never" } }];
  await slotA({ claude: { script: { on, steps } } });
  await intoInternal();

  const [notice, reply] = await posts(2);
  expect(notice!.text).toBe(`w/a 崩溃了，这一回合没做完。\n正在自动恢复这段对话。\n${unread}`);
  expect(reply!.text).toBe("内部回合续完了");
  await until(async () => (await state()) === "空闲", 15_000);
  await Bun.sleep(300);
  expect(await rhodium.im.log("q", ME)).toHaveLength(2);
}, 30_000);

test("story 126: an internal turn your message joined crashes with crash resume off: the notice quotes your unread message, and nothing of it is kept for the next start", async () => {
  await slotA({ claude: { script: { on, steps: [...internalCrash, { goto: 0 }] } }, toml: noResume });
  await intoInternal();

  const [notice] = await posts(1);
  expect(notice!.text).toBe(`w/a 崩溃了，这一回合没做完。\n发一条消息就恢复这段对话。\n${unread}`);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "新的" });
  await until(() => rhodium.claude.runs()[1]?.stdin.some((l) => l.includes("新的")) ?? false, 15_000);
  // Yours went to the process that crashed, and is not written again.
  expect(said()).toEqual(["work", "你的话", "新的"]);
}, 30_000);
