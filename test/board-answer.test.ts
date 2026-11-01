// Answering asks on the board (spec web-write, its third ticket): the card's answer goes to POST
// /api/act as you would type it in IM, and IM hears it was answered there. Seen from seam one, through
// the board's HTTP, with fake agents and the fake IM.
import { afterEach, expect, test } from "bun:test";
import type { Posted } from "../src/fake-im";
import type { RhReply } from "../src/router";
import { askOnce, askWithdrawn, asking, endTurn, on, saying, startTurn, toolCall, toolResult, toolUse, type FakeAsk } from "./fake-agent/scripts";
import type { Step } from "./fake-agent/fake-agent";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you";
let rhodium: Instance;
let base = "";
afterEach(() => rhodium.cleanup());

const TEA: FakeAsk = ["q-1", "AskUserQuestion", { questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }], multiSelect: false }] }];

/** A rhodium whose bot b, like QQ or Telegram, sends your messages to slot w/a. */
async function bot(like: "qq" | "telegram", opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { b: { like, owner: ME, target: "w/a" } }, ...opts });
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
}

const say = (text: string) => rhodium.im.inject("b", { chat: ME, sender: ME, text });
const get = async <T>(path: string): Promise<T> => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<T>;

type Ask = { id: string; kind: string };
/** w/a's first ask waiting on you, as the board lists it, once there is one. */
async function asked(): Promise<Ask> {
  const board = await get<{ workspaces: { groups: Record<string, { id: string; name: string }[]> }[] }>("/api/board");
  const id = board.workspaces.flatMap((w) => Object.values(w.groups).flat()).find((c) => c.name === "a")!.id;
  let asks: Ask[] = [];
  await until(async () => (asks = (await get<{ asks: Ask[] }>(`/api/slot?id=${id}`)).asks).length > 0, 15_000);
  return asks[0]!;
}

/** Answers the ask on the board with text, as its card sends it. */
const answer = async (ask: string, text: string): Promise<RhReply> => (await boardAct(base, { kind: "answer", ask, text })).json() as Promise<RhReply>;

/** The answers claude got, as [request id, behavior, message or input]. */
const answers = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "control_response")
    .map(({ response: { request_id, response } }) => [request_id, response.behavior, response.message ?? response.updatedInput]);

/** What the bot sent in your chat, once there are n messages. */
async function sent(n: number): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("b", ME)).filter((p) => p.kind === "send").length >= n, 15_000);
  return (await rhodium.im.log("b", ME)).filter((p) => p.kind === "send");
}

test("stories 289, 292: a choice answered on the board reaches the agent; on Telegram the ask says so in place, its buttons gone, and a press on it no longer works", async () => {
  await bot("telegram", { claude: { script: asking([TEA]) } });
  await say("go");
  const [pushed] = await sent(1);
  expect(await answer((await asked()).id, "2")).toEqual({ ok: true, text: "已回答：Coffee。" });
  await until(() => answers().length === 1, 15_000);
  expect(answers()).toEqual([["q-1", "allow", { ...TEA[2], answers: { "Tea or coffee?": "Coffee" } }]]);
  await until(async () => (await rhodium.im.shown("b", ME))[0]!.text.includes("已在网页回答"), 15_000);
  expect((await rhodium.im.shown("b", ME))[0]).toMatchObject({ text: "Tea or coffee?\n\n也可以直接写你的回答。\n\n已在网页回答：Coffee" });
  expect((await rhodium.im.shown("b", ME))[0]!.buttons ?? []).toEqual([]);
  // Nothing else comes for it: the receipt is the board's.
  expect((await sent(2)).map((p) => p.text)).toEqual([pushed!.text, "answered"]);

  await rhodium.im.inject("b", { chat: ME, sender: ME, text: "", button: { data: pushed!.buttons![0]!.data, message: pushed!.messageId } });
  await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.kind === "toast" && p.text === "这个按钮已经失效了"), 15_000);
  expect(answers()).toHaveLength(1);
}, 30_000);

test("stories 289, 292: on QQ, which cannot change a sent message, a line under the ask says it was answered on the board; its button no longer works", async () => {
  await bot("qq", { claude: { script: asking([TEA]) } });
  await say("go");
  const [pushed] = await sent(1);
  expect(await answer((await asked()).id, "Tea")).toEqual({ ok: true, text: "已回答：Tea。" });
  await until(() => answers().length === 1, 15_000);
  expect((await sent(3)).map((p) => p.text).slice(1).toSorted()).toEqual(["answered", "已在网页回答：Tea"]);
  await rhodium.im.press("b", ME, pushed!, "Coffee");
  await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.kind === "toast" && p.text === "这个按钮已经失效了"), 15_000);
  expect(answers()).toHaveLength(1);
}, 30_000);

const TWO: FakeAsk = [
  "q-2",
  "AskUserQuestion",
  {
    questions: [
      { question: "Which fruit?", header: "Fruit", options: [{ label: "Apple" }, { label: "Pear" }, { label: "Plum" }], multiSelect: true },
      { question: "When?", header: "When", options: [{ label: "Now" }, { label: "Later" }], multiSelect: false },
    ],
  },
];

test("story 289: several questions, each a line, a multiple choice by numbers, a question of your own words", async () => {
  await bot("qq", { claude: { script: asking([TWO]) } });
  await say("go");
  expect(await answer((await asked()).id, "1 3\n明天早上")).toEqual({ ok: true, text: "已回答：Apple, Plum；明天早上。" });
  await until(() => answers().length === 1, 15_000);
  expect(answers()[0]![2]).toMatchObject({ answers: { "Which fruit?": "Apple, Plum", "When?": "明天早上" } });
}, 30_000);

test("story 292: on Telegram an ask sent with no buttons, several questions one a multiple choice, says in place it was answered on the board", async () => {
  await bot("telegram", { claude: { script: asking([TWO]) } });
  await say("go");
  const [pushed] = await sent(1);
  expect(pushed!.buttons ?? []).toEqual([]);
  await answer((await asked()).id, "1 3\n明天早上");
  await until(async () => (await rhodium.im.shown("b", ME))[0]!.text.endsWith("已在网页回答：Apple, Plum；明天早上"), 15_000);
}, 30_000);

test("story 292: on Telegram an ask too long to say in place it was answered on the board still loses its buttons", async () => {
  await bot("telegram", { claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  await say("go");
  const [pushed] = await sent(1);
  expect(pushed!.buttons?.length).toBeGreaterThan(0);
  expect(await answer((await asked()).id, `2 ${"先跑测试".repeat(1100)}`)).toMatchObject({ ok: true });
  await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.kind === "unbutton"), 15_000);
  expect((await rhodium.im.shown("b", ME))[0]).toMatchObject({ text: pushed!.text });
  expect((await rhodium.im.shown("b", ME))[0]!.buttons ?? []).toEqual([]);
}, 30_000);

test("story 290: an approval refused on the board with a reason: the agent gets the no and the reason", async () => {
  await bot("qq", { claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  await say("go");
  expect(await answer((await asked()).id, "2 先跑测试")).toEqual({ ok: true, text: "已拒绝，并转告：“先跑测试”" });
  await until(() => answers().length === 1, 15_000);
  expect(answers()).toEqual([["p-1", "deny", "先跑测试"]]);
}, 30_000);

test("story 291: an agent's confirm request, pushed to IM, is a card on the board too; agreed there, it is carried out", async () => {
  // The agent makes the rh calls your message lists.
  await bot("telegram", { claude: { script: { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] } } });
  await rhodium.ok("new", "w/b");
  await say(JSON.stringify([["rename", "w/b", "c"]]));
  await until(async () => (await rhodium.im.log("b", ME)).some((p) => p.buttons?.length), 15_000);
  const ask = await asked();
  expect(ask.kind).toBe("confirm");
  expect(await answer(ask.id, "1")).toEqual({ ok: true, text: "已回答：同意。" });
  expect(await rhodium.ok("ls")).toContain("w/c ");
}, 30_000);

test("story 293: an ask answered in IM, timed out or withdrawn takes no answer from the board, which says where or why", async () => {
  await bot("qq", { claude: { script: asking([TEA]) }, toml: '[durations]\naskTimeout = "3s"' });
  await say("go");
  const first = (await asked()).id;
  await say("Tea");
  await until(() => answers().length === 1, 15_000);
  expect(await answer(first, "2")).toEqual({ ok: false, error: "已在 假 IM 私聊回答", gone: true });

  await say("again");
  const second = (await asked()).id;
  await until(() => answers().length === 2, 15_000);
  expect(await answer(second, "2")).toEqual({ ok: false, error: "已超时", gone: true });
  expect(answers()).toHaveLength(2);
}, 30_000);

test("story 293: an ask the agent withdrew takes no answer from the board", async () => {
  await bot("qq", { claude: { script: { on, steps: [...startTurn, ...askWithdrawn(TEA, 2_000), ...endTurn("done"), { goto: 0 }] } } });
  await say("go");
  const ask = (await asked()).id;
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await answer(ask, "1")).toEqual({ ok: false, error: "提问已撤回", gone: true });
}, 30_000);

/** rh send me, words after it, the ask, then words, ls and the final reply. */
const takesOverThenAsks: Step[] = [
  ...startTurn,
  toolUse("toolu_send", "Bash", { command: "rh send me 测试接管" }),
  { rh: ["send", "me", "测试接管"] },
  toolResult("toolu_send"),
  saying("接管后说的话。"),
  toolUse("toolu_q-1", "AskUserQuestion", TEA[2]),
  ...askOnce(TEA),
  toolResult("toolu_q-1"),
  saying("答完说的话。"),
  toolCall("toolu_ls", "Bash", { command: "ls ~" }),
  ...endTurn("最终回复。"),
  { goto: 0 },
];

test("spec web-write: an answer on the board leaves rh send me's hold on the turn: you are on the board, so the turn stays quiet in IM to its end", async () => {
  await bot("qq", { claude: { script: { on, steps: takesOverThenAsks } } });
  await say("go");
  await answer((await asked()).id, "Tea");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(300); // nothing more comes
  const texts = (await rhodium.im.log("b", ME)).filter((p) => p.kind === "send").map((p) => (p.text.startsWith("Tea or coffee?") ? "ask" : p.text));
  expect(texts).toEqual(["测试接管", "[🔧 Bash]", "ask", "已在网页回答：Tea", "[🔧 Bash]"]);
}, 30_000);
