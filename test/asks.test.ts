// Asks in IM (seam one, product §5.8): the agent's question, plan or approval goes to your chat
// with buttons, your reply of a number or words answers it as well, and one nobody answers in time
// gets Rhodium's careful answer.
// The fake claude replays the probe recordings of #10, or plays a script where none fits.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { installFakeAgent } from "./fake-agent/fake-agent";
import { asking, endTurn, on, startTurn, type FakeAsk } from "./fake-agent/scripts";
import { askLine, askText, parseAnswer } from "../src/asks";
import { sourceLine } from "../src/prompt";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const FIXTURES = join(import.meta.dir, "fixtures/claude");
const ME = "you-openid";
// Rhodium's first line on each of your messages, which the recordings were made without.
const VIA = sourceLine("假 IM 私聊");

let rhodium: Instance;
afterEach(() => rhodium?.cleanup());

/** A rhodium whose bot q sends your private chat to the slot w/a; rh set items apply before any message. */
async function slot(opts: InstanceOptions, ...settings: string[]): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await rhodium.ok("ws", "w", dir);
  await rhodium.ok("new", "w/a");
  if (settings.length) await rhodium.ok("set", "w/a", ...settings);
}

const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const state = () => rhodium.state("w/a");

/** Waits until the bot has posted n messages in your chat, and returns them. */
async function posts(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

/** Waits until rhodium has recorded that the open ask reached you: killed between the platform
 *  taking it and that record, it rightly takes it for not sent (#117). */
async function pushed(): Promise<void> {
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    await until(() => db.query("SELECT 1 FROM ask WHERE status = 'open' AND pushedAt IS NOT NULL").get() !== null, 15_000);
  } finally {
    db.close();
  }
}

test("stories 84, 78: AskUserQuestion reaches IM with numbered options, and a plain reply of a number answers it", async () => {
  await slot({ claude: { replay: join(FIXTURES, "question"), sourceLines: [VIA] } });
  const first = await say(
    "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options red and blue. After I answer, reply with just the color.",
  );
  const [ask] = await posts(1);
  expect(ask!.text).toContain("Which color do you prefer?\n\n1. Red：Choose red\n2. Blue：Choose blue");
  expect(await state()).toBe("需要你");

  // The replayer fails unless the answer written to claude is the recorded one: Blue.
  const answer = await say("2");
  const [, ack, reply, ...more] = await posts(3);
  expect(ack).toMatchObject({ text: "已回答：Blue。", replyTo: answer.messageId });
  expect(reply).toMatchObject({ text: "Blue", replyTo: first.messageId });
  expect(more).toEqual([]);
  expect(await state()).toBe("空闲");
}, 30_000);

/** The ask the bot posted last, once there are n posts. */
const nth = async (n: number) => (await posts(n))[n - 1]!.text;

test("story 76: a plan comes to IM to approve by number; with approval mode on, the tool call it leads to asks too", async () => {
  await slot({ claude: { replay: join(FIXTURES, "plan-confirm"), sourceLines: [VIA] } }, "approval=on");
  await say("Make a one-step plan to create hello.txt containing the word hi, then call ExitPlanMode with that plan. Do not ask questions.");
  const plan = await nth(1);
  expect(plan).toStartWith("写好了计划，批准后才动手：\n\n## Context\nCreate a file hello.txt");
  expect(plan).toEndWith("\n\n回别的话算不批准，并转告它。");
  await say("1");
  expect(await nth(2)).toBe("已回答：批准。");
  expect(await nth(3)).toBe("要写 /tmp/rh-probe/work/hello.txt，允许吗？\n\nhi\n\n回别的话算拒绝，并转告它。");
  await say("允许");
  expect(await nth(4)).toBe("已允许写 /tmp/rh-probe/work/hello.txt。");
  await until(async () => (await state()) === "空闲", 15_000);
}, 30_000);

test("stories 18, 77: with approval mode on, each tool call needing permission comes to IM; one is allowed, one denied with your reason", async () => {
  await slot({ claude: { replay: join(FIXTURES, "approval-allow-deny"), sourceLines: [VIA, VIA] } }, "approval=on");
  await say("Use the Bash tool to run exactly: echo first > a.txt");
  expect(await nth(1)).toBe("要运行这条命令，允许吗？\n\necho first > a.txt\n\n回别的话算拒绝，并转告它。");
  await say("1");
  await until(async () => (await state()) === "空闲", 15_000);

  await say("Use the Bash tool to run exactly: echo second > b.txt");
  const [, , , ask] = await posts(4); // ack and final reply in between
  expect(ask!.text).toStartWith("要运行这条命令，允许吗？\n\necho second > b.txt");
  // Anything but yes is a no, and the words go to claude as they are: the recording has them.
  await say("The user denied this command.");
  expect(await nth(5)).toBe("已拒绝，并转告：“The user denied this command.”");
  await until(async () => (await state()) === "空闲", 15_000);
  // Approval mode on: claude was not told to skip permission checks.
  expect(rhodium.claude.runs()[0]!.argv).not.toContain("bypassPermissions");
}, 30_000);

/** The answers claude got, as [request id, behavior, message]. */
const answers = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "control_response")
    .map(({ response: { request_id, response } }) => [request_id, response.behavior, response.message ?? response.updatedInput]);

const bash = (id: string, command: string): FakeAsk => [id, "Bash", { command }];

test("story 79: with two asks open, a reply first gets the list to pick from; the one picked is sent again and the next reply answers it", async () => {
  await slot({ claude: { script: asking([bash("ask-1", "echo one"), bash("ask-2", "echo two")], { together: true }) } });
  await say("go");
  await posts(2);
  expect(await state()).toBe("需要你");

  await say("1");
  expect(await nth(3)).toBe("有 2 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. 要运行：echo one\n2. 要运行：echo two");
  await say("2");
  expect(await nth(4)).toStartWith("要运行这条命令，允许吗？\n\necho two\n");
  await say("2");
  expect(await nth(5)).toBe("已回答“要运行：echo two”：拒绝。");
  expect(await state()).toBe("需要你");
  // One is left, still number 1 of the list you saw: 1 picks it, then the next reply answers it.
  await say("1");
  expect(await nth(6)).toStartWith("要运行这条命令，允许吗？\n\necho one\n");
  await say("1");
  expect(await nth(7)).toBe("已回答“要运行：echo one”：允许。");
  expect(await nth(8)).toBe("answered");
  expect(answers()).toEqual([
    ["ask-2", "deny", "The user said no."],
    ["ask-1", "allow", { command: "echo one" }],
  ]);
}, 30_000);

test("an ask you picked is answered only once it has been sent to you again: a resend that fails leaves your next 1 a pick", async () => {
  await slot({ claude: { script: asking([bash("p-1", "make")]) } });
  await rhodium.im.next("q", "fail", "send"); // the ask's push
  await say("go");
  await until(async () => (await state()) === "需要你", 15_000);
  await say("?");
  expect(await nth(1)).toBe("有 1 条提问还没送到这里，先选它再回答。刚才那句没交出去。\n\n1. 要运行：make");
  await rhodium.im.next("q", "fail", "send"); // the resend
  await say("1");
  await Bun.sleep(500); // the resend has failed by now
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  // You never saw the approval: this 1 picks it again rather than allowing it.
  await say("1");
  expect(await nth(2)).toStartWith("要运行这条命令，允许吗？\n\nmake\n");
  expect(answers()).toEqual([]);
  await say("1");
  expect(await nth(3)).toBe("已回答“要运行：make”：允许。");
  expect(await nth(4)).toBe("answered"); // claude replies once it has read the answer
  expect(answers()).toEqual([["p-1", "allow", { command: "make" }]]);
}, 30_000);

test("a picture, even captioned 1, while an approval waits, is no answer and is not dropped unsaid: you are told to answer first and send it again", async () => {
  await slot({ claude: { script: asking([bash("p-1", "make")]) } });
  await say("go");
  await posts(1);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const sent = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "1", attachments: [{ kind: "image", data: png }] });
  expect(await nth(2)).toBe("w/a 在等你回答提问，图片和文件不能当回答，这条没交给它。先用文字回答，再发一遍。");
  expect((await posts(2))[1]!.replyTo).toBe(sent.messageId);
  expect(answers()).toEqual([]);
  await say("1");
  expect(await nth(3)).toBe("已允许运行这条命令。");
}, 30_000);

const TEA = { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }], multiSelect: false }] };
const PLAN = { plan: "## Plan\n1. Make tea.txt\n" };
// Product §5.8's words.
const BEST_JUDGEMENT = "用户暂时无法回答，请按你的最佳判断继续";

test("with three asks listed, numbers stay as shown: once the first is answered, 2 still picks the second, and 3 the third", async () => {
  await slot({ claude: { script: asking([bash("ask-1", "echo one"), bash("ask-2", "echo two"), bash("ask-3", "echo three")], { together: true }) } });
  await say("go");
  await posts(3);
  await say("?");
  expect(await nth(4)).toBe("有 3 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. 要运行：echo one\n2. 要运行：echo two\n3. 要运行：echo three");
  await say("1");
  expect(await nth(5)).toStartWith("要运行这条命令，允许吗？\n\necho one\n");
  await say("1");
  expect(await nth(6)).toBe("已回答“要运行：echo one”：允许。");
  await say("2");
  expect(await nth(7)).toStartWith("要运行这条命令，允许吗？\n\necho two\n");
  await say("2");
  expect(await nth(8)).toBe("已回答“要运行：echo two”：拒绝。");
  // The last one left is still the list's number 3: a number picks it rather than answers it.
  await say("3");
  expect(await nth(9)).toStartWith("要运行这条命令，允许吗？\n\necho three\n");
  await say("1");
  expect(await nth(10)).toBe("已回答“要运行：echo three”：允许。");
  expect(await nth(11)).toBe("answered");
  expect(answers()).toEqual([
    ["ask-1", "allow", { command: "echo one" }],
    ["ask-2", "deny", "The user said no."],
    ["ask-3", "allow", { command: "echo three" }],
  ]);
}, 30_000);

test("a new ask voids your pick and the list: the 1 meant for it answers nothing and gets a new list, and the answer names the ask it answered", async () => {
  // ask-3 comes 1 s after the first two, once you have picked ask-1 and it was sent to you again.
  const script = asking([bash("ask-1", "echo one"), bash("ask-2", "echo two")], { together: true });
  const ask3 = { emit: [JSON.stringify({ type: "control_request", request_id: "ask-3", request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input: { command: "echo three" }, tool_use_id: "toolu_ask-3" } })] };
  const at = script.steps.findIndex((s) => "wait" in s && JSON.stringify(s.wait).includes("ask-1"));
  script.steps.splice(at, 0, { sleep: 1000 }, ask3, { wait: { type: "control_response", response: { request_id: "ask-3" } } });
  await slot({ claude: { script } });
  await say("go");
  await posts(2);
  await say("?");
  await say("1");
  expect(await nth(4)).toStartWith("要运行这条命令，允许吗？\n\necho one\n");
  expect(await nth(5)).toStartWith("要运行这条命令，允许吗？\n\necho three\n");
  await say("1");
  expect(await nth(6)).toBe("有 3 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. 要运行：echo one\n2. 要运行：echo two\n3. 要运行：echo three");
  expect(answers()).toEqual([]);
  await say("3");
  expect(await nth(7)).toStartWith("要运行这条命令，允许吗？\n\necho three\n");
  await say("1");
  expect(await nth(8)).toBe("已回答“要运行：echo three”：允许。");
  expect(answers()).toEqual([["ask-3", "allow", { command: "echo three" }]]);
}, 30_000);

test("a listed ask that times out leaves the list stale: your number gets a new list instead of answering the ask left", async () => {
  // ask-1 times out 3 s in; ask-2, made 1.5 s later, would at 4.5 s.
  const script = asking([bash("ask-1", "echo one")], { together: true });
  const ask2 = { emit: [JSON.stringify({ type: "control_request", request_id: "ask-2", request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input: { command: "echo two" }, tool_use_id: "toolu_ask-2" } })] };
  const at = script.steps.findIndex((s) => "wait" in s && JSON.stringify(s.wait).includes("ask-1"));
  script.steps.splice(at, 0, { sleep: 1500 }, ask2);
  script.steps.splice(at + 3, 0, { wait: { type: "control_response", response: { request_id: "ask-2" } } });
  await slot({ toml: '[durations]\naskTimeout = "3s"', claude: { script } });
  await say("go");
  await posts(2);
  await say("?");
  expect(await nth(3)).toBe("有 2 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. 要运行：echo one\n2. 要运行：echo two");
  await until(() => answers().length === 1, 15_000);
  // Meant to pick ask-1 from the list you saw: it is gone, so the list comes again.
  await say("1");
  expect(await nth(4)).toBe("有 1 条提问在等你，先选它再回答。刚才那句没交出去。\n\n1. 要运行：echo two");
  await say("1");
  expect(await nth(5)).toStartWith("要运行这条命令，允许吗？\n\necho two\n");
  await say("2");
  expect(await nth(6)).toBe("已回答“要运行：echo two”：拒绝。");
  expect(answers()).toEqual([
    ["ask-1", "deny", BEST_JUDGEMENT],
    ["ask-2", "deny", "The user said no."],
  ]);
}, 30_000);

test("story 80: unanswered, a question gets 'answer by your best judgement', an approval a no saying the same, a plan a no asking for its summary", async () => {
  await slot({ toml: '[durations]\naskTimeout = "1s"', claude: { script: asking([["q-1", "AskUserQuestion", TEA], bash("p-1", "rm -rf build"), ["plan-1", "ExitPlanMode", PLAN]], { together: true }) } });
  await say("go");
  await until(() => answers().length === 3, 15_000);
  const [question, approval, plan] = answers();
  expect(question).toEqual(["q-1", "allow", { ...TEA, answers: { "Tea or coffee?": BEST_JUDGEMENT } }]);
  expect(approval).toEqual(["p-1", "deny", BEST_JUDGEMENT]);
  expect(plan!.slice(0, 2)).toEqual(["plan-1", "deny"]);
  expect(plan![2]).toContain("用 rh send me 把计划摘要发给用户，然后停下来，等用户回复");
  // The three asks went out, then the turn's reply; nothing was said about the timeouts.
  expect((await posts(4)).map((p) => p.text.split("\n")[0])).toEqual(["Tea or coffee?", "要运行这条命令，允许吗？", "写好了计划，批准后才动手：", "answered"]);
}, 30_000);

test("story 81: a slot's ask timeout set in seconds, or to 0 for never, holds for the ask open now too", async () => {
  await slot({ claude: { script: asking([bash("p-1", "make")]) } }, "ask-timeout=1500ms");
  await say("go");
  await posts(1);
  // 0 stops the clock on the open ask: past its 1.5 seconds, it still waits for you.
  await rhodium.ok("set", "w/a", "ask-timeout=0");
  await Bun.sleep(2000);
  expect(answers()).toEqual([]);
  expect(await state()).toBe("需要你");
  // Half a second from now, then the careful answer.
  await rhodium.ok("set", "w/a", "ask-timeout=500ms");
  await until(() => answers().length === 1, 3000);
  expect(answers()).toEqual([["p-1", "deny", BEST_JUDGEMENT]]);
}, 30_000);

/** The control requests of this subtype claude got, over all its runs. */
const requests = (subtype: string) =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "control_request" && m.request.subtype === subtype)
    .map((m) => m.request);

test("story 77: rh set approval switches the running claude with set_permission_mode; an agent not running starts in the mode set", async () => {
  await slot({ claude: { script: "turn" } });
  await say("hi");
  await posts(1);
  expect(rhodium.claude.runs()[0]!.argv.join(" ")).toContain("--permission-mode bypassPermissions");
  await rhodium.ok("set", "w/a", "approval=on");
  await until(() => requests("set_permission_mode").length === 1);
  await rhodium.ok("set", "w/a", "approval=default"); // the config file's default: off
  await until(() => requests("set_permission_mode").length === 2);
  expect(requests("set_permission_mode")).toEqual([
    { subtype: "set_permission_mode", mode: "default" },
    { subtype: "set_permission_mode", mode: "bypassPermissions" },
  ]);

  await rhodium.ok("stop", "w/a");
  await until(async () => (await state()) === "未运行", 15_000);
  await rhodium.ok("set", "w/a", "approval=on");
  await say("again");
  await posts(2);
  const [, again] = rhodium.claude.runs();
  expect(again!.argv).not.toContain("bypassPermissions");
  expect(requests("set_permission_mode")).toHaveLength(2);
}, 30_000);

test("story 77: a claude launched with approval mode on can be switched off while it runs", async () => {
  await slot({ claude: { script: "turn" } }, "approval=on");
  await say("hi");
  await posts(1);
  // The CLI takes set_permission_mode bypassPermissions only from a process launched able to bypass:
  // this flag makes it able to, and leaves it asking until then.
  const [run] = rhodium.claude.runs();
  expect(run!.argv).toContain("--allow-dangerously-skip-permissions");
  expect(run!.argv).not.toContain("bypassPermissions");
  await rhodium.ok("set", "w/a", "approval=off");
  await until(() => requests("set_permission_mode").length === 1);
  expect(requests("set_permission_mode")).toEqual([{ subtype: "set_permission_mode", mode: "bypassPermissions" }]);
}, 30_000);

test("story 77: when claude refuses the switch, you are told, and the agent restarts in the mode set", async () => {
  const refused = "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration";
  const refuse = { match: { type: "control_request", request: { subtype: "set_permission_mode" } }, emit: [JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "{{in.request_id}}", error: refused } })] };
  await slot({ claude: { script: { on: [refuse, ...on!], steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }] } } }, "approval=on");
  await say("hi");
  await posts(1);
  await rhodium.ok("set", "w/a", "approval=off");
  expect(await nth(2)).toBe(`w/a 没能在运行中切换审批模式，空闲后会重启，按新设置运行。\n原因：${refused}`);
  await until(async () => (await state()) === "未运行", 15_000);
  await say("again");
  expect(await nth(3)).toBe("fake reply");
  expect(rhodium.claude.runs()[1]!.argv.join(" ")).toContain("--permission-mode bypassPermissions");
}, 30_000);

test("story 77: rh set approval while claude is still starting holds once it runs", async () => {
  await slot({ claude: { script: "turn" }, stopPostDelay: 1 });
  await say("hi");
  await posts(1);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await state()) === "未运行", 15_000);
  // The last holder takes 1 s to go, so this start waits that long, launched in the old mode.
  await say("again");
  expect(await state()).toBe("启动中");
  await rhodium.ok("set", "w/a", "approval=on");
  await posts(2);
  expect(rhodium.claude.runs()[1]!.argv.join(" ")).toContain("--permission-mode bypassPermissions");
  expect(requests("set_permission_mode")).toEqual([{ subtype: "set_permission_mode", mode: "default" }]);
}, 30_000);

test("kill -9 rhodium mid-turn with an approval open: after the restart it is not sent again, and your answer reaches claude", async () => {
  // The recording: claude waits on the approval, takes a second handshake, which names it, then the answer.
  await slot({ claude: { replay: join(FIXTURES, "reinitialize-pending-approval"), sourceLines: [VIA] } }, "approval=on");
  await say("Use the Bash tool to run exactly: touch d.txt");
  expect(await nth(1)).toStartWith("要运行这条命令，允许吗？\n\ntouch d.txt\n");
  expect(await state()).toBe("需要你");
  await pushed();
  await rhodium.kill9();
  await rhodium.start();
  await until(() => requests("initialize").length === 2, 15_000);
  await Bun.sleep(500); // a second push would show up by now
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  expect(await state()).toBe("需要你");

  await say("1");
  expect(await nth(2)).toBe("已允许运行这条命令。");
  await until(async () => (await state()) === "空闲", 15_000);
  expect(rhodium.claude.runs()).toHaveLength(1);
}, 60_000);

test("an ask open when rhodium is killed still times out after the restart", async () => {
  await slot({ toml: '[durations]\naskTimeout = "1s"', claude: { script: asking([bash("p-1", "make")], { handshake: true }) } });
  await say("go");
  await posts(1);
  await rhodium.kill9();
  await rhodium.start();
  await until(() => answers().length === 1, 15_000);
  expect(answers()).toEqual([["p-1", "deny", BEST_JUDGEMENT]]);
  expect(await nth(2)).toBe("answered");
  expect(await rhodium.im.log("q", ME)).toHaveLength(2);
}, 60_000);

test("an ask the agent makes while rhodium is down is sent once rhodium is back, and answered as usual", async () => {
  await slot({ claude: { script: asking([bash("p-1", "make")], { delay: 500, handshake: true }) } });
  await say("go");
  await until(() => rhodium.claude.runs()[0]?.stdin.some((l) => l.includes('"type":"user"')) ?? false, 15_000);
  await rhodium.kill9();
  await Bun.sleep(800);
  await rhodium.start();
  expect(await nth(1)).toStartWith("要运行这条命令，允许吗？\n\nmake\n");
  await say("1");
  expect(await nth(2)).toBe("已允许运行这条命令。");
  expect(await nth(3)).toBe("answered");
  expect(answers()).toEqual([["p-1", "allow", { command: "make" }]]);
}, 60_000);

/** The user frames claude got, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

// After a restart, claude's handshake names the asks it still waits on. One it no longer names is
// stale, and so is every unanswered one if it is too old to name any (architecture §5 step 5).
for (const list of ["names none", "has no list"]) {
  test(`after a restart claude's handshake ${list}: the open ask is stale, and your next message goes to claude as a message`, async () => {
    const script = asking([bash("p-1", "make")]);
    if (list === "has no list") {
      const [init, ...rest] = script.on!;
      script.on = [{ ...init!, emit: [init!.emit[0]!.replace(',"pending_permission_requests":[]', "")] }, ...rest];
    }
    await slot({ claude: { script } });
    await say("go");
    await posts(1);
    await rhodium.kill9();
    await rhodium.start();
    await until(() => requests("initialize").length === 2, 15_000);
    await until(async () => (await state()) === "运行中", 15_000);
    await say("1");
    await until(() => asked().length === 2, 15_000);
    expect(asked()).toEqual(["go", "1"]);
    expect(answers()).toEqual([]);
    expect(await rhodium.im.log("q", ME)).toHaveLength(1);
  }, 60_000);
}

// pi's asks come from Rhodium's approval extension; they reach IM and are answered the same way.
// The recordings fail the replay unless pi gets exactly the recorded answer.
test.each([
  ["approval-allow", "Read notes.txt with the read tool, then run `echo approved` with the bash tool, then reply with the single word: done.", "echo approved", "1", "已允许运行这条命令。"],
  ["approval-deny", "Run `touch denied.txt` with the bash tool.", "touch denied.txt && ls -la denied.txt", "Not now. Do not retry; just reply with the single word: skipped.", "已拒绝，并转告：“Not now. Do not retry; just reply with the single word: skipped.”"],
])("pi with approval mode on (%s): the tool call that needs permission comes to IM, and is allowed, or denied with your reason", async (fixture, message, command, answer, ack) => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, pi: { replay: join(import.meta.dir, "fixtures/pi", fixture), sourceLines: [VIA] } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.ok("set", "w/a", "approval=on");
  await say(message);
  expect(await nth(1)).toBe(`要运行这条命令，允许吗？\n\n${command}\n\n回别的话算拒绝，并转告它。`);
  expect(await state()).toBe("需要你");
  await say(answer);
  expect(await nth(2)).toBe(ack);
  await until(async () => (await state()) === "空闲", 15_000);
  expect(rhodium.pi.runs()[0]!.argv).toContain("-e");
}, 30_000);

test("pi: kill -9 rhodium mid-turn with an approval open: after the restart it still needs you, is not sent again, and your answer reaches pi", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, pi: { replay: join(import.meta.dir, "fixtures/pi/approval-allow"), sourceLines: [VIA] } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.ok("set", "w/a", "approval=on");
  await say("Read notes.txt with the read tool, then run `echo approved` with the bash tool, then reply with the single word: done.");
  expect(await nth(1)).toStartWith("要运行这条命令，允许吗？\n\necho approved\n");
  await pushed();
  await rhodium.kill9();
  await rhodium.start();
  await Bun.sleep(500); // the replay is done by now, and a second push would show up
  expect(await state()).toBe("需要你");
  expect(await rhodium.im.log("q", ME)).toHaveLength(1);

  // The replayer fails unless pi gets the recorded answer: allow.
  await say("1");
  expect(await nth(2)).toBe("已允许运行这条命令。");
  await until(async () => (await state()) === "空闲", 15_000);
  expect(rhodium.pi.runs()).toHaveLength(1);
}, 60_000);

test("pi: kill -9 rhodium while an allowed command still runs: after the restart the approval is not sent again, and your next message steers the turn", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, pi: { script: "pi-approval-long" } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  await rhodium.ok("set", "w/a", "approval=on");
  const sent = () => rhodium.pi.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)));
  await say("run sleep 8");
  expect(await nth(1)).toStartWith("要运行这条命令，允许吗？\n\nsleep 8\n");
  await say("1");
  expect(await nth(2)).toBe("已允许运行这条命令。");
  // The answer went to pi's stdin, so the out.log replayed after the restart never shows it.
  await until(() => sent().some((m) => m.type === "extension_ui_response"), 15_000);
  await rhodium.kill9();
  await rhodium.start();
  await Bun.sleep(500); // the replay is done by now, and a second push would show up
  expect(await rhodium.im.log("q", ME)).toHaveLength(2);
  expect(await state()).toBe("运行中");

  await say("how is it going?");
  await until(() => sent().some((m) => m.type === "prompt" && m.streamingBehavior === "steer"), 15_000);
  expect(sent().filter((m) => m.type === "extension_ui_response")).toEqual([{ type: "extension_ui_response", id: "pi-ask-1", value: "allow" }]);
  expect(await nth(3)).toBe("done"); // the call you approved shows as its ask, in no tool line
  await until(async () => (await state()) === "空闲", 15_000);
  expect(rhodium.pi.runs()).toHaveLength(1);
}, 60_000);

test("pi: rh set approval mid-turn leaves the turn be; once idle pi stops, and the next message starts it in the same session with the new mode", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, pi: { script: "pi-slow" } });
  await rhodium.start();
  await rhodium.slots();
  await rhodium.ok("new", "w/a", "--agent", "pi");
  const session = (argv: string[]) => argv[argv.indexOf("--session-id") + 1];

  await say("hello");
  await until(async () => (await state()) === "运行中", 15_000);
  await rhodium.ok("set", "w/a", "approval=on");
  expect(await nth(1)).toBe("fake reply"); // the turn went on to its end
  installFakeAgent(join(rhodium.dir, "bin"), { script: "pi-turn" }, "pi"); // the next runs need not be slow
  await until(async () => (await state()) === "未运行", 15_000);
  await say("again");
  expect(await nth(2)).toBe("fake reply");
  const [first, second] = rhodium.pi.runs();
  expect(first!.argv).not.toContain("-e");
  expect(second!.argv).toContain("-e");
  expect(session(second!.argv)).toBe(session(first!.argv));

  // Idle already: it stops at once.
  await rhodium.ok("set", "w/a", "approval=off");
  await until(async () => (await state()) === "未运行", 15_000);
  await say("third");
  expect(await nth(3)).toBe("fake reply");
  const third = rhodium.pi.runs()[2]!;
  expect(third.argv).not.toContain("-e");
  expect(session(third.argv)).toBe(session(first!.argv));
}, 30_000);

test("an ask whose agent stopped is no longer open: your next message starts a turn instead", async () => {
  await slot({ claude: { script: asking([bash("p-1", "make")]) } });
  await say("go");
  await posts(1);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await state()) === "未运行", 15_000);
  await say("1");
  await until(() => asked().length === 2, 15_000);
  expect(asked()).toEqual(["go", "1"]);
  expect(answers()).toEqual([]);
}, 30_000);

test("Codex's approvals read as the table in docs/im-style.md §4.2: a patch of several files says how many and shows each diff; more permissions, one a line", () => {
  const changes = [
    { path: "/w/a.txt", kind: { type: "add" }, diff: "hi\n" },
    { path: "/w/b.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-x\n+y\n" },
  ];
  const patch = { tool: "apply_patch", input: { changes } };
  expect(askText("permission", patch, "", true)).toBe("要改 2 个文件，允许吗？\n\n/w/a.txt\nhi\n/w/b.txt\n@@ -1 +1 @@\n-x\n+y\n\n回别的话算拒绝，并转告它。");
  expect(askLine("permission", patch)).toBe("要改 2 个文件");
  expect(askText("permission", { tool: "apply_patch", input: { changes: changes.slice(1) } }, "", true)).toBe("要改 /w/b.txt，允许吗？\n\n@@ -1 +1 @@\n-x\n+y\n\n回别的话算拒绝，并转告它。");
  const entries = [{ path: { type: "path", path: "/srv/log" }, access: "write" }];
  const more = { tool: "request_permissions", input: { network: { enabled: true }, fileSystem: { read: ["/srv/data"], write: ["/etc/hosts"], entries } } };
  expect(askText("permission", more, "", true)).toBe("要多给它这些权限，允许吗？\n\n联网\n读 /srv/data\n写 /etc/hosts\n写 /srv/log\n\n回别的话算拒绝，并转告它。");
  expect(parseAnswer("permission", more, "1")!.receipt).toBe("已允许多给它这些权限。");
  expect(askText("permission", { tool: "exec_command", input: { command: "ls -la" } }, "", true)).toBe("要运行这条命令，允许吗？\n\nls -la\n\n回别的话算拒绝，并转告它。");
});
