// Internal turns relay nothing (product §5.5, GLOSSARY 内部回合): a turn a report or your decision
// on a confirm request began has no turn chat, so what its agent says reaches no chat; only its
// rh send me reaches the contact chat. The first two replay #54's acceptance on 2026-10-22, where
// messages of yours that joined a turn between its tool calls (no result of their own) left the
// Claude driver naming an old message of yours as the one an internal turn began with. The last: a
// reply of yours joins an internal turn still talking, and that chat gets the rest of it (#215).
import { afterEach, expect, test } from "bun:test";
import type { Script, Step } from "./fake-agent/fake-agent";
import { endTurn, joinBetweenTools, joinTurn, on, saying, startTurn, toolCall, toolResult, toolUse } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Your first message; while its tool runs, `joins` more of yours join the turn. */
const busyTurn = (joins: number) => [
  ...startTurn,
  toolUse("toolu_ls", "Bash", { command: "ls" }),
  ...Array.from({ length: joins }, () => joinBetweenTools).flat(),
  toolResult("toolu_ls"),
  ...endTurn("看过了"),
];
const say = (text: string, bot = "q") => rhodium.im.inject(bot, { chat: ME, sender: ME, text });
/** What the bot posted to you, edits included. */
const posts = async (bot: string) => (await rhodium.im.log(bot, ME)).map((p) => p.text ?? "");
/** The user frames the slot's agent was given, oldest first. */
const frames = (ref: string) =>
  rhodium.claude
    .runs()
    .filter((r) => r.env.RHODIUM_SLOT === ref)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"));
const idle = async (ref: string) => {
  await until(async () => (await rhodium.state(ref)) === "空闲", 15_000);
};

test("a child's report right after the turn that spawned it relays nothing the agent says; its rh send me reaches you", async () => {
  const script: Script = {
    on,
    steps: [
      ...busyTurn(1),
      // Your next message spawns two children.
      ...startTurn,
      { rhFrom: "in.message.content.0.text" },
      ...endTurn("派了两个子槽位"),
      // The first report: the agent checks and talks to itself.
      ...startTurn,
      toolCall("toolu_ls2", "Bash", { command: "rh ls" }),
      ...endTurn("roll-call-a replied. roll-call-b is still running."),
      // The second: it tells you with rh send me.
      ...startTurn,
      { rh: ["send", "me", "两个都到了"] },
      ...endTurn("Told the user both replied."),
      { wait: { type: "never" } },
    ],
  };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a");

  await say("看一下 git log");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("顺便说说名字的来历");
  await until(async () => (await posts("q")).length === 1, 15_000);
  await idle("w/a");
  const spawn = [["spawn", "roll-call-a", "--agent", "pi", "只回一句到"], ["spawn", "roll-call-b", "--agent", "pi", "只回一句到"]];
  await say(JSON.stringify(spawn));

  await until(async () => (await posts("q")).includes("两个都到了"), 15_000);
  await until(() => frames("w/a").length === 5, 15_000);
  await idle("w/a");
  await Bun.sleep(500);
  expect(await posts("q")).toEqual(["[🔧 Bash]\n\n看过了", "派了两个子槽位", "两个都到了"]);
}, 30_000);

test("your decision on a confirm request relays nothing the agent says, not even to a chat whose earlier turn rh send me took over; its rh send me reaches you", async () => {
  const script: Script = {
    on,
    steps: [
      ...busyTurn(2),
      // On Telegram: rh send me takes the turn over.
      ...startTurn,
      { rh: ["send", "me", "这是 rh send me 发的"] },
      ...endTurn("I sent it with rh send me."),
      // On QQ: archiving w/x asks you first, once the turn has replied.
      ...startTurn,
      { rh: ["archive", "w/x"] },
      ...endTurn("好。"),
      // Your decision: words for no one, then rh send me.
      ...startTurn,
      toolCall("toolu_why", "Bash", { command: "rh ls", description: "Ask user to clarify the declined archive" }),
      saying("The user declined the confirm request, so w/x was not archived."),
      { rh: ["send", "me", "你拒绝了，w/x 没有归档"] },
      ...endTurn("Asked the user over IM."),
      { wait: { type: "never" } },
    ],
  };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a", "x");

  await say("看一下 git log");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("顺便说说名字的来历");
  await say("这个项目有价值吗？");
  await until(async () => (await posts("q")).length === 1, 15_000);
  await idle("w/a");

  await say("用 rh send me 给我发条消息", "t");
  await until(async () => (await posts("t")).some((t) => t.includes("这是 rh send me 发的")), 15_000);
  await idle("w/a");
  const telegram = await posts("t");

  await say("回收 w/x");
  await until(async () => (await posts("q")).some((t) => t.includes("命令：rh archive w/x")), 15_000);
  await idle("w/a");
  await say("不要");

  await until(async () => (await posts("q")).includes("你拒绝了，w/x 没有归档"), 15_000);
  await until(() => frames("w/a").length === 6, 15_000);
  await idle("w/a");
  await Bun.sleep(500);
  expect(await posts("t")).toEqual(telegram);
  const qq = await posts("q");
  expect(qq.slice(-2)).toEqual(["已拒绝，并转告：“不要”", "你拒绝了，w/x 没有归档"]);
  expect(qq.join("\n")).not.toContain("declined");
}, 30_000);

test("your reply to an internal turn's rh send me, sent before that turn ends, joins it: that chat is its turn chat from then on, and gets the rest of what it says; a second chat joins as well and hears where the reply goes", async () => {
  const before = "The user declined; telling them now.";
  const decline = "The user declined, so w/x was not archived; I told them over IM.";
  const answer = "好的，那就先留着 w/x。";
  // Your decision: words for no one, rh send me tells you, and the agent is still talking when your
  // reply and then a Telegram message come in. Claude takes each into this turn (the mid-turn-message recording).
  const script: Script = {
    on,
    steps: [
      ...startTurn,
      { rh: ["archive", "w/x"] },
      ...endTurn("好。"),
      ...startTurn,
      saying(before),
      { rh: ["send", "me", "你拒绝了，w/x 没有归档"] },
      { sleep: 1500 },
      saying(decline),
      ...joinTurn,
      ...joinTurn,
      ...endTurn(answer),
      { wait: { type: "never" } },
    ],
  };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a", "x");

  await say("回收 w/x");
  await until(async () => (await posts("q")).some((t) => t.includes("命令：rh archive w/x")), 15_000);
  await idle("w/a");
  await say("不要");
  await until(async () => (await posts("q")).includes("你拒绝了，w/x 没有归档"), 15_000);
  await say("那就先留着");
  // The Telegram message comes once QQ's has joined the turn.
  await until(() => frames("w/a").some((m) => JSON.stringify(m).includes("那就先留着")), 15_000);
  await say("还有别的吗？", "t");

  await until(async () => (await posts("q")).includes(answer), 15_000);
  await idle("w/a");
  await Bun.sleep(500);
  const qq = await posts("q");
  expect(qq.slice(-4)).toEqual(["已拒绝，并转告：“不要”", "你拒绝了，w/x 没有归档", decline, answer]);
  expect(qq.join("\n")).not.toContain(before);
  expect(await posts("t")).toEqual(["已并入 假 IM Bot q 的私聊那边正在跑的回合，回复会发在那边。"]);
}, 30_000);
