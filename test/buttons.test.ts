// Seam one: asks and lists to pick from as buttons (Telegram and QQ), and numbered where they do not
// fit one message, on the fake IM's copies of the two capability tables (product §5.8).
import { afterEach, expect, test } from "bun:test";
import type { Posted } from "../src/fake-im";
import { asking, endTurn, on, startTurn, type FakeAsk } from "./fake-agent/scripts";
import { newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

const TEA: FakeAsk = ["q-1", "AskUserQuestion", { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee", description: "strong" }], multiSelect: false }] }];

/** A rhodium whose bot b, like QQ or Telegram, sends your messages to slot w/a. */
async function bot(like: "qq" | "telegram", opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { b: { like, owner: ME, target: "w/a" } }, ...opts });
  await rhodium.start();
  await rhodium.slots("a");
}

const say = (text: string) => rhodium.im.inject("b", { chat: ME, sender: ME, text });

/** What the bot sent or edited in your chat, once there are n messages. */
async function sent(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("b", ME)).filter((p) => p.kind === "send").length >= n, 15_000);
  return (await rhodium.im.log("b", ME)).filter((p) => p.kind === "send");
}

test.each(["telegram", "qq"] as const)("story 75: a choice question on %s comes with a button for each option", async (like) => {
  await bot(like, { claude: { script: asking([TEA]) } });
  await say("go");
  const [ask] = await sent(1);
  // Narrow names, two a row (docs/im-style.md §11.2).
  expect(ask!.buttons).toEqual([{ label: "Tea", data: expect.any(String), row: 0 }, { label: "Coffee", data: expect.any(String), row: 0 }]);
  expect(ask!.text).toBe("Tea or coffee?\n\n1. Tea\n2. Coffee：strong\n\n也可以回编号，或直接写你的回答。");
}, 30_000);

test("on QQ, which shows buttons on a Markdown message only (2026-10-22), an ask's, /status's and a panel's come as Markdown that reads as their text, and can be pressed", async () => {
  await bot("qq", { claude: { script: asking([TEA]) } });
  await say("go");
  const [ask] = await sent(1);
  expect(ask).toMatchObject({ text: "Tea or coffee?\n\n1. Tea\n2. Coffee：strong\n\n也可以回编号，或直接写你的回答。", markdown: "Tea or coffee?\n\n1\\.\u00a0Tea  \n2\\.\u00a0Coffee：strong\n\n也可以回编号，或直接写你的回答。" });
  await rhodium.im.press("b", ME, ask!, "Coffee"); // the platform takes no press on a keyboard it does not show
  expect((await sent(3)).slice(1).map((p) => [p.text, p.markdown])).toEqual([["已回答：Coffee。", undefined], ["answered", "answered"]]);
  await say("/status");
  await say("/rh_agent");
  const [status, panel] = (await sent(5)).slice(3);
  for (const p of [status!, panel!]) {
    expect(p.buttons?.length).toBeGreaterThan(0);
    expect(p.markdown).toEqual(expect.any(String));
    expect(p.buttonsHidden).toBeUndefined();
  }
  await rhodium.im.press("b", ME, panel!, "取消");
  await until(async () => (await sent(6))[5]!.text === "已取消，没有改动。", 15_000);
}, 30_000);

test("story 75: on QQ, a choice of more options than a page holds comes numbered", async () => {
  const options = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((label) => ({ label }));
  await bot("qq", { claude: { script: asking([["q-1", "AskUserQuestion", { questions: [{ question: "Which?", header: "Pick", options, multiSelect: false }] }]]) } });
  await say("go");
  const [ask] = await sent(1);
  expect(ask!.buttons).toBeUndefined();
  expect(ask!.text).toBe("Which?\n\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n\n回编号，或直接写你的回答。");
}, 30_000);

/** The answers claude got, as [request id, behavior, message or input]. */
const answers = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "control_response")
    .map(({ response: { request_id, response } }) => [request_id, response.behavior, response.message ?? response.updatedInput]);

/** Presses the button on the message, as you would. */
const press = (message: Posted, label: string) =>
  rhodium.im.inject("b", { chat: ME, sender: ME, text: "", button: { data: message.buttons!.find((b) => b.label === label)!.data, message: message.messageId } });

/** Every post of this kind in your chat, once there are n. */
async function posts(kind: Posted["kind"], n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("b", ME)).filter((p) => p.kind === kind).length >= n, 15_000);
  return (await rhodium.im.log("b", ME)).filter((p) => p.kind === kind);
}

test.each(["telegram", "qq"] as const)("stories 82, 83 on %s: a button press answers the ask, and its buttons go where they can; pressed again, it says it no longer works and reaches no agent", async (like) => {
  await bot(like, { claude: { script: asking([TEA]) } });
  await say("go");
  const [ask] = await sent(1);
  await press(ask!, "Coffee");
  expect((await sent(3)).map((p) => p.text).slice(1)).toEqual(["已回答：Coffee。", "answered"]);
  expect(answers()).toEqual([["q-1", "allow", { ...TEA[2], answers: { "Tea or coffee?": "Coffee" } }]]);
  // QQ cannot change a sent message, so there its buttons stay.
  if (like === "telegram") expect((await posts("unbutton", 1)).map((p) => p.messageId)).toEqual([ask!.messageId]);

  await press(ask!, "Tea");
  expect((await posts("toast", 2)).map((p) => p.text)).toEqual(["", "这个按钮已经失效了"]);
  await Bun.sleep(300);
  expect(answers()).toHaveLength(1);
  expect(await sent(3)).toHaveLength(3);
}, 30_000);

test.each(["telegram", "qq"] as const)("story 79 on %s: with two asks open, the list to pick from has a button for each; pressing one sends that ask again", async (like) => {
  const bash = (id: string, command: string): FakeAsk => [id, "Bash", { command }];
  await bot(like, { claude: { script: asking([bash("ask-1", "echo one"), bash("ask-2", "echo two")], { together: true }) } });
  await say("go");
  await sent(2);
  await say("?");
  const list = (await sent(3))[2]!;
  expect(list.text).toBe("有 2 条提问在等你，先选一条再回答。刚才那句没交出去。\n\n1. 要运行：echo one\n2. 要运行：echo two");
  expect(list.buttons!.map((b) => b.label)).toEqual(["第 1 条", "第 2 条"]);
  await press(list, "第 2 条");
  expect((await sent(4))[3]!.text).toBe("要运行这条命令，允许吗？\n\necho two\n\n回别的话算拒绝，并转告它。");
  await say("1");
  expect((await sent(5))[4]!.text).toBe("已回答“要运行：echo two”：允许。");
  expect(answers()).toEqual([["ask-2", "allow", { command: "echo two" }]]);
}, 30_000);

test("story 85: a confirm request comes with 同意 and 拒绝 buttons on Telegram, and a press carries your decision out", async () => {
  // The agent makes the rh calls your message lists.
  await bot("telegram", { claude: { script: { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] } } });
  await rhodium.ok("new", "w/b");
  await say(JSON.stringify([["archive", "w/b"]]));
  await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.buttons?.length), 15_000);
  const ask = (await rhodium.im.log("b", ME)).find((p) => p.buttons?.length)!;
  expect(ask.text).toBe("w/a 想归档 w/b。\n对话留着，发消息就恢复。\n\n命令：rh archive w/b\n回别的话算拒绝，并转告 w/a。");
  expect(ask.buttons!.map((b) => b.label)).toEqual(["同意", "拒绝"]);
  await press(ask, "同意");
  await until(async () => (await sent(3)).some((p) => p.text.startsWith("已回答")), 15_000);
  expect((await sent(3)).find((p) => p.text.startsWith("已回答"))!.text).toBe("已回答：同意。"); // the agent tells you what came of it
  expect((await posts("unbutton", 1)).map((p) => p.messageId)).toEqual([ask.messageId]);
}, 30_000);

test("story 10: /resume's list comes as buttons on Telegram, and pressing one goes back to that conversation", async () => {
  await bot("telegram");
  await say("first");
  await sent(1);
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1]!;
  await say("/new");
  await sent(2);
  await say("/resume");
  const list = (await sent(3))[2]!;
  // The new conversation has no session yet: nothing to go back to, and 现在 says it is new (story 408).
  expect(list.text).toBe("回到哪段对话？\n现在：新对话");
  expect(list.buttons).toEqual([{ label: expect.stringMatching(/^\d\d:\d\d first$/), data: `/resume ${session}`, row: 0 }, { label: "取消", data: "cancel", row: 1, muted: true }]);
  await press(list, list.buttons![0]!.label);
  // Telegram: the pick shows in place of the list.
  await until(async () => (await rhodium.im.shown("b", ME))[2]!.text.includes("已选"), 15_000);
  expect((await rhodium.im.shown("b", ME))[2]!.text).toMatch(/^回到哪段对话？\n已选：今天 \d\d:\d\d 那段$/);
  expect((await posts("toast", 1)).map((p) => p.text)).toEqual([""]);
}, 30_000);

/** The control requests of this subtype that claude got. */
const controls = (subtype: string) =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "control_request" && m.request.subtype === subtype)
    .map((m) => m.request);

test.each(["telegram", "qq"] as const)("story 57: /model's list on %s comes as buttons; the model pressed is the one claude switches to", async (like) => {
  await bot(like);
  await say("hello");
  await sent(1);
  await say("/model");
  const list = (await sent(2))[1]!;
  expect(list.text).toBe("换哪个模型？\n现在：默认（Opus 5.5）");
  expect(list.buttons).toEqual([
    { label: `${like === "qq" ? "★" : "✓"} 默认（Opus 5.5）`, data: "/model default", row: 0 },
    { label: "Haiku", data: "/model haiku", row: 1 },
    { label: "取消", data: "cancel", row: 2, muted: true },
  ]);
  await press(list, "Haiku");
  // The next step asks about the level: in place on Telegram, in a new message on QQ.
  const next = like === "telegram" ? "换哪个模型？\n已选：Haiku\n思考强度要改吗？" : "已切到 Haiku。\n思考强度要改吗？";
  await until(async () => (await rhodium.im.shown("b", ME)).some((p) => p.text === next), 15_000);
  expect(controls("set_model")).toEqual([{ subtype: "set_model", model: "haiku" }]);
}, 30_000);

test("story 82: an ask that times out loses its buttons, then gets the careful answer", async () => {
  await bot("telegram", { toml: '[durations]\naskTimeout = "1s"', claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  await say("go");
  const [ask] = await sent(1);
  expect(ask!.buttons!.map((b) => b.label)).toEqual(["允许", "拒绝"]);
  expect((await posts("unbutton", 1)).map((p) => p.messageId)).toEqual([ask!.messageId]);
  await until(() => answers().length === 1, 15_000);
  expect(answers()[0]!.slice(0, 2)).toEqual(["p-1", "deny"]);
}, 30_000);
