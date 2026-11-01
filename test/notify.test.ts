// When and where Rhodium comes to you by itself (stories 43, 132, 133; product §5.5, §5.9, §5.10;
// architecture §8.6, §8.7), seen from seam one with two fake bots: q has QQ's capabilities, t Telegram's.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import type { Posted } from "../src/fake-im";
import type { Script } from "./fake-agent/fake-agent";
import { asking, endTurn, on, startTurn } from "./fake-agent/scripts";
import { sourceLine } from "../src/prompt";
import { botApi, ME as TG_API_ME } from "./bot-api";
import { newInstance, until, type Daemon, type Instance, type InstanceOptions } from "./instance";

const QQ_ME = "you-openid";
/** A claude that makes the rh calls its message lists (plan), as in rh-spawn.test.ts. */
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
const plan = (...calls: string[][]) => JSON.stringify(calls);
const TG_ME = "you-tg-id";

let rhodium: Instance;
let daemon: Daemon;
afterEach(() => rhodium.cleanup());

/** Bots q and t both send your messages to slot w/a, unless tb has t's go to w/b, made too; only, if
 *  given, leaves the other bot out. */
async function begin(opts: InstanceOptions & { only?: "q" | "t"; tb?: true } = {}): Promise<void> {
  const { only, tb, ...rest } = opts;
  const bots = {
    q: { like: "qq" as const, owner: QQ_ME, target: "w/a" },
    t: { like: "telegram" as const, owner: TG_ME, target: tb ? "w/b" : "w/a" },
  };
  rhodium = newInstance({ bots: only ? { [only]: bots[only] } : bots, ...rest });
  daemon = await rhodium.start();
  await rhodium.slots(...(tb ? ["a", "b"] : ["a"]));
}

/** What bot posted in your private chat with it. */
const log = (bot: "q" | "t"): Promise<Posted[]> => rhodium.im.log(bot, bot === "q" ? QQ_ME : TG_ME);
async function posts(bot: "q" | "t", n: number): Promise<Posted[]> {
  await until(async () => (await log(bot)).length >= n, 15_000);
  return log(bot);
}
const say = (bot: "q" | "t", text: string) => rhodium.im.inject(bot, { chat: bot === "q" ? QQ_ME : TG_ME, sender: bot === "q" ? QQ_ME : TG_ME, text });
const state = () => rhodium.state("w/a");
/** Once a crashed agent's holder unit is gone: cleanup's stop must not race systemd collecting it. */
const holderGone = () => until(async () => !(await rhodium.units()).some((u) => u.includes("hold-")), 15_000);

type Ev = { seq: number; type: string; slot: string | null; data: any };
/** The board's event stream from the start, once check holds for what came. */
async function events(check: (seen: Ev[]) => boolean): Promise<Ev[]> {
  const base = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { "Tailscale-User-Login": "you@example.com", "Last-Event-ID": "0" }, signal: ac.signal });
  const seen: Ev[] = [];
  let buf = "";
  try {
    for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const data = buf.slice(0, i).match(/^data: (.*)$/m)?.[1]; // none in a heartbeat
        buf = buf.slice(i + 2);
        if (data) seen.push(JSON.parse(data));
      }
      if (check(seen)) break;
    }
  } finally {
    ac.abort();
  }
  return seen;
}

test("story 43: with a main chat set, a notice about a slot no chat has written to goes to the main chat", async () => {
  await begin({ toml: `mainChat = "t/${TG_ME}"`, claude: { script: "crash" } });
  await rhodium.ok("send", "w/a", "go"); // from your terminal: no chat is the slot's contact chat
  const [notice] = await posts("t", 1);
  expect(notice!.text).toContain("w/a 崩溃了");
  expect(await log("q")).toEqual([]);
  await holderGone();
}, 30_000);

test("story 132: a turn ending, the slot going idle and being reaped send nothing: they are events, for the board", async () => {
  await begin({ toml: `mainChat = "t/${TG_ME}"\n[durations]\nidleReap = "1s"` });
  await rhodium.ok("send", "w/a", "hello");
  await until(async () => (await state()) === "未运行", 15_000);
  const seen = await events((s) => s.some((e) => e.type === "slot_state" && e.data.state === "off"));
  const states = seen.filter((e) => e.type === "slot_state").map((e) => e.data.state);
  expect(states).toEqual(expect.arrayContaining(["running", "idle", "off"]));
  await Bun.sleep(300); // a notice would show up by now
  expect([await log("q"), await log("t")]).toEqual([[], []]);
}, 30_000);

test("story 133: a bot that keeps failing to reach its platform is marked faulted, and you hear of it through the other bot, once, and again when it is back", async () => {
  await begin({ toml: "[limits]\nbotFailures = 3" });
  await rhodium.im.connection("q", false);
  const [notice] = await posts("t", 1);
  expect(notice!.text).toBe("假 IM Bot q 连不上平台，已经连续失败 3 次。它会一直自动重连，连上之前这个 Bot 的消息收不到也发不出。\n原因：fake-im bot/updates: the bot is not connected");
  await events((s) => s.some((e) => e.type === "bot_faulted" && e.data.bot === "q"));

  // Back again: an event, and a word where the first notice went.
  await rhodium.im.connection("q", true);
  await events((s) => s.some((e) => e.type === "bot_online" && e.data.bot === "q"));
  const [, back] = await posts("t", 2);
  expect(back!.text).toBe("假 IM Bot q 已恢复，又连上平台了。");
  await Bun.sleep(500);
  expect(await log("t")).toHaveLength(2);
  expect(await log("q")).toEqual([]);
}, 30_000);

test("a rhodium whose build the main chat has not heard of says so there once, with the note upgrade.sh built it with, if any (2026-10-23)", async () => {
  // A build bakes in its commit and note (scripts/build.sh); run from source, the environment has them.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: QQ_ME } }, toml: `mainChat = "q/${QQ_ME}"`, env: { RHODIUM_BUILD_COMMIT: "aaaaaaa" } });
  await rhodium.start();
  expect((await posts("q", 1))[0]!.text).toBe(`升级到 ${version}（aaaaaaa）。`);
  // Restarted on the same build: not again.
  await rhodium.stop();
  await rhodium.start();
  await Bun.sleep(500);
  expect(await log("q")).toHaveLength(1);
  await rhodium.stop();
  Object.assign(rhodium.env, { RHODIUM_BUILD_COMMIT: "bbbbbbb", RHODIUM_BUILD_NOTE: "每回合第一行带发送时间" });
  await rhodium.start();
  expect((await posts("q", 2))[1]!.text).toBe(`升级到 ${version}（bbbbbbb）：每回合第一行带发送时间`);
  // Run from source with no commit, as rh dev runs: nothing to tell.
  await rhodium.stop();
  delete rhodium.env.RHODIUM_BUILD_COMMIT;
  await rhodium.start();
  await Bun.sleep(500);
  expect(await log("q")).toHaveLength(2);
}, 30_000);

test("a notice for a chat whose bot is faulted comes through the other bot, saying so", async () => {
  await begin({ toml: "[limits]\nbotFailures = 3" });
  await say("q", "hello"); // q's chat is w/a's contact chat from now on
  await posts("q", 1);
  await rhodium.im.connection("q", false);
  await posts("t", 1);

  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  const [, notice] = await posts("t", 2);
  expect(notice!.text).toStartWith("假 IM Bot q 的私聊那边发不出去，改发在这里。\n\n");
  expect(notice!.text).toContain("w/a 崩溃了");
  expect(await log("q")).toHaveLength(1);
  await holderGone();
}, 30_000);

test("with both of QQ's quotas used up, an ask comes through the Telegram bot, and you can answer it there", async () => {
  await begin({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: "ask" } });
  await say("q", "go");
  const [ask] = await posts("t", 1);
  expect(ask!.text).toStartWith("假 IM Bot q 的私聊那边发不出去，改发在这里。\n\n");
  expect(ask!.text).toContain("echo hi");

  await say("t", "1");
  await until(async () => (await log("t")).some((p) => p.text === "已允许运行这条命令。"), 15_000);
  // The final reply waits in QQ behind the one passive reply kept for 完成，回任意字查看.
  expect((await posts("q", 1)).map((p) => p.text)).toEqual(["完成，回任意字查看"]);
}, 30_000);

test("an ask the Telegram bot forwarded is answered by what you type in its chat, though that chat goes to another slot", async () => {
  await begin({ tb: true, toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: "ask" } });
  await say("q", "go");
  const [ask] = await posts("t", 1);
  expect(ask!.text).toContain("w/a");

  await say("t", "1");
  await until(async () => (await log("t")).some((p) => p.text === "已回答 w/a 的提问：允许。"), 15_000);
  expect(rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === "w/b")).toEqual([]);
}, 30_000);

test("an ask QQ can send only part of without holding the rest goes whole through the Telegram bot", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${"step ".repeat(10)}`).join("\n"); // over QQ's 2000 characters
  await begin({ toml: "[limits]\nqqPassiveReplies = 2\nqqActive = 0", claude: { script: asking([["plan-1", "ExitPlanMode", { plan: long }]]) } });
  await say("q", "go"); // one passive reply for the first piece, and the one kept for the hint: no room for the second
  const [ask] = await posts("t", 1);
  expect(ask!.text).toStartWith("假 IM Bot q 的私聊那边发不出去，改发在这里。\n\n");
  expect(ask!.text).toContain("60. step");
  expect(await log("q")).toEqual([]);
}, 30_000);

test("with QQ alone and both its quotas used up, an ask waits for your next message, which brings it", async () => {
  await begin({ only: "q", toml: "[limits]\nqqActive = 0", claude: { script: "ask" } });
  await say("q", "/status"); // q's chat is w/a's contact chat from now on
  await posts("q", 1);
  await rhodium.ok("send", "w/a", "go"); // a turn from your terminal: no message of yours to reply to
  await until(async () => (await state()) === "需要你", 15_000);
  await Bun.sleep(300); // the ask would show up by now
  expect(await log("q")).toHaveLength(1);

  const next = await say("q", "hi");
  await until(async () => (await log("q")).some((p) => p.text.includes("echo hi")), 15_000);
  expect((await log("q")).find((p) => p.text.includes("echo hi"))!.replyTo).toBe(next.messageId);
}, 30_000);

test("with QQ alone, an ask in your turn with only the kept passive reply left: 完成，回任意字查看, then any reply brings the ask, which you answer", async () => {
  await begin({ only: "q", toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: "ask" } });
  await say("q", "go");
  expect((await posts("q", 1)).map((p) => p.text)).toEqual(["完成，回任意字查看"]);
  await say("q", "x");
  const [, ask] = await posts("q", 2);
  expect(ask!.text).toContain("echo hi");
  await say("q", "1");
  await until(async () => (await log("q")).some((p) => p.text === "已允许运行这条命令。"), 15_000);
}, 30_000);

test("a QQ reply with no passive reply left even for 完成，回任意字查看: the Telegram bot says where it waits, and any reply in QQ brings it", async () => {
  await begin({ toml: "[limits]\nqqActive = 0" });
  // Your message's passive replies ran out with its window, before the turn ended.
  await rhodium.im.inject("q", { chat: QQ_ME, sender: QQ_ME, text: "hello", at: Date.now() - 2 * 3_600_000 });
  const [hint] = await posts("t", 1);
  expect(hint!.text).toBe("假 IM Bot q 的私聊那边有 w/a 的回复在等你，在那边回任意一个字就能收到。");
  expect(await log("q")).toEqual([]);

  const any = await say("q", "1");
  const [reply] = await posts("q", 1);
  expect(reply).toMatchObject({ text: "fake reply", replyTo: any.messageId });
  await Bun.sleep(300);
  const asked = rhodium.claude.runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l))).filter((m) => m.type === "user");
  expect(asked).toHaveLength(1); // the 1 only brought the reply
}, 30_000);

test("an agent error is told once a turn, its text clipped: a pi extension failing on every tool call", async () => {
  await begin({ only: "t", pi: { script: "pi-ext-error" } });
  await rhodium.ok("agent", "w/a", "pi");
  await say("t", "hello");
  await until(async () => (await log("t")).some((p) => p.text === "fake reply"), 15_000);
  const notices = (await log("t")).filter((p) => p.text.includes("出错了"));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toStartWith("w/a 的 agent 出错了。\n原因：");
  expect(notices[0]!.text).toContain("/ext/approval.ts: boom");
  expect(notices[0]!.text.length).toBeLessThan(600);
}, 30_000);

test("pi refusing your message is a failure you hear of, with pi's error", async () => {
  await begin({ only: "t", pi: { script: "pi-refuse" } });
  await rhodium.ok("agent", "w/a", "pi");
  await say("t", "hello");
  const [notice] = await posts("t", 1);
  expect(notice!.text).toContain("w/a");
  expect(notice!.text).toContain("No API key found for provider fake");
}, 30_000);

test("two notices from one input on a QQ bot whose active quota has no count yet both go out: a child crashing with its parent archived", async () => {
  await begin({ only: "q", claude: { script: obey } });
  await say("q", plan(["spawn", "c", plan()])); // w/c, from no chat of yours: its notices go to w/a's chat, as active messages
  const turns = (ref: string) => rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === ref).flatMap((r) => r.stdin.filter((l) => JSON.parse(l).type === "user"));
  await until(() => turns("w/a").length === 2, 15_000); // your message, then w/c's done report
  await until(async () => (await state()) === "空闲", 15_000);
  await rhodium.ok("bind", "q", "w/c"); // a bot's default target is not archived
  await rhodium.ok("archive", "w/a");

  process.kill(rhodium.claude.runs().find((r) => r.env.RHODIUM_SLOT === "w/c")!.pid, "SIGKILL");
  await until(async () => (await log("q")).some((p) => p.text.includes("w/c 卡住了")), 15_000);
  expect((await log("q")).some((p) => p.text.includes("w/c 崩溃了"))).toBe(true);
  await holderGone();
}, 30_000);

// rh send me goes the way a notice does (product §5.5, architecture §8.7).
const FORWARDED = "假 IM Bot q 的私聊那边发不出去，改发在这里。\n\n";

test("rh send me on QQ uses an active message, so a notice after it, with none left, comes through the Telegram bot", async () => {
  await begin({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 1", claude: { script: obey } });
  await say("q", plan(["send", "me", "hi"]));
  expect((await posts("q", 1)).map((p) => p.text)).toEqual(["hi"]); // and no final reply: it would say it twice
  await until(async () => (await state()) === "空闲", 15_000);
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  const [notice] = await posts("t", 1);
  expect(notice!.text).toStartWith(FORWARDED);
  expect(notice!.text).toContain("w/a 崩溃了");
  await holderGone();
}, 30_000);

test("by default a QQ bot has 1000 active messages a day (QQ's docs): five rh send me past the passive replies all go out on QQ", async () => {
  await begin({ toml: "[limits]\nqqPassiveReplies = 1", claude: { script: obey } });
  const five = ["1", "2", "3", "4", "5"];
  await say("q", plan(...five.map((n) => ["send", "me", n])));
  expect((await posts("q", 5)).map((p) => p.text)).toEqual(five);
  await until(async () => (await state()) === "空闲", 15_000);
  expect(await log("t")).toEqual([]);
}, 30_000);

test("with both of QQ's quotas used up, rh send me comes through the Telegram bot", async () => {
  await begin({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: obey } });
  await say("q", plan(["send", "me", "hi"]));
  expect((await posts("t", 1)).map((p) => p.text)).toEqual([`${FORWARDED}hi`]);
}, 30_000);

test("a child's rh send me another bot takes to a chat that goes to its parent says whose it is under the forwarding line, alone before a file", async () => {
  // q's chat points at the child (/rh_use), so it is the child's; t's still goes to w/a (product §5.9).
  await begin({ toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: obey } });
  await rhodium.ok("send", "w/a", plan(["spawn", "c", plan()]));
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  writeFileSync(join(rhodium.dir, "w/notes.txt"), "12 wicks\n");
  await say("q", "/rh_use c");
  await posts("q", 1);
  await say("q", plan(["send", "me", "hi"], ["send", "me", "--file", "notes.txt"]));
  const got = await posts("t", 3);
  expect(got.map((p) => p.file?.name ?? p.text.trimEnd())).toEqual([`${FORWARDED}〔w/c〕\nhi`, `${FORWARDED}〔w/c〕`, "notes.txt"]);
}, 30_000);

test("rh send me for a chat whose bot is faulted comes through the other bot", async () => {
  await begin({ toml: "[limits]\nbotFailures = 3", claude: { script: obey } });
  await say("q", "hello"); // q's chat is w/a's contact chat from now on
  await posts("q", 1);
  await rhodium.im.connection("q", false);
  await posts("t", 1); // the fault notice
  await rhodium.ok("send", "w/a", plan(["send", "me", "hi"]));
  expect((await posts("t", 2))[1]!.text).toBe(`${FORWARDED}hi`);
  expect(await log("q")).toHaveLength(1);
}, 30_000);

test("an active message QQ turns down for its quota comes through the Telegram bot, saying where it was for; QQ's active messages count as used up", async () => {
  await begin({ claude: { script: obey }, platform: { activeMessages: 0 } });
  await say("q", "hello"); // q's chat is w/a's contact chat from now on
  await posts("q", 1);
  await rhodium.ok("send", "w/a", plan(["send", "me", "one"]));
  expect((await posts("t", 1))[0]!.text).toBe(`${FORWARDED}one`);
  await rhodium.ok("send", "w/a", plan(["send", "me", "two"]));
  expect((await posts("t", 2))[1]!.text).toBe(`${FORWARDED}two`);
  // Not tried on QQ first.
  expect(daemon.logs.filter((l) => l.msg === "send failed")).toHaveLength(1);
  expect(await log("q")).toHaveLength(1);
}, 30_000);

test("an active message QQ turns down goes through a bot on another platform, before the main chat's bot on QQ (product §5.5)", async () => {
  // m, a QQ bot like q, has the main chat; tg is a Telegram bot, on a stand-in for the Bot API.
  const api = botApi();
  try {
    rhodium = newInstance({
      bots: { q: { like: "qq", owner: QQ_ME, target: "w/a" }, m: { like: "qq", owner: QQ_ME, target: "w/a" } },
      toml: [`mainChat = "m/${QQ_ME}"`, "[bots.tg]", 'platform = "telegram"', 'token = "x"', `apiRoot = "${api.url}"`, `owner = "${TG_API_ME}"`, 'target = "w/a"'].join("\n"),
      claude: { script: obey },
      platform: { activeMessages: 1 }, // to each chat
    });
    daemon = await rhodium.start();
    await rhodium.slots("a");
    await say("q", "hello"); // q's chat is w/a's contact chat from now on
    await posts("q", 1);
    await rhodium.ok("send", "w/a", plan(["send", "me", "one"]));
    await posts("q", 2); // q's one active message
    await rhodium.ok("send", "w/a", plan(["send", "me", "two"]));
    await until(() => api.sent.length === 1, 15_000);
    expect(api.sent[0]!.text).toBe(`${FORWARDED}two`);
    expect(await rhodium.im.log("m", QQ_ME)).toEqual([]);
  } finally {
    api.stop();
  }
}, 30_000);

test("an ask QQ turns down for its quota comes through the Telegram bot, and a number typed there answers it, though that chat goes to another slot", async () => {
  // One passive reply, kept for 完成，回任意字查看: the ask goes as an active message, which QQ turns down.
  await begin({ tb: true, toml: "[limits]\nqqPassiveReplies = 1", platform: { activeMessages: 0 }, claude: { script: "ask" } });
  await say("q", "go");
  const [ask] = await posts("t", 1);
  expect(ask!.text).toStartWith(FORWARDED);
  expect(ask!.text).toContain("echo hi");
  await say("t", "1");
  await until(async () => (await log("t")).some((p) => p.text === "已回答 w/a 的提问：允许。"), 15_000);
  expect(rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === "w/b")).toEqual([]);
}, 30_000);

test("a bot's label is what its chat goes by, to you and to the agent; commands still name the bot by its id (2026-10-21)", async () => {
  const bots = { q: { like: "qq", owner: QQ_ME, target: "w/a", label: "Echo Agent" }, t: { like: "telegram", owner: TG_ME, target: "w/a" } } as const;
  rhodium = newInstance({ bots, toml: "[limits]\nqqPassiveReplies = 1\nqqActive = 0", claude: { script: obey } });
  await rhodium.start();
  await rhodium.slots("a");
  await say("q", plan(["send", "me", "hi"]));
  expect((await posts("t", 1))[0]!.text).toBe("假 IM Bot Echo Agent 的私聊那边发不出去，改发在这里。\n\nhi");
  const run = rhodium.claude.runs()[0]!;
  const first = run.stdin.map((l) => JSON.parse(l)).find((m) => m.type === "user");
  expect(first.message.content[0].text).toStartWith(`${sourceLine("假 IM Bot Echo Agent 的私聊")}\n`);
  // So do the bot's format limits in the system prompt, for the agent to match them up (2026-10-23).
  expect(readFileSync(run.argv[run.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toMatch(/^- 假 IM Bot Echo Agent 的私聊：.*2000 字/m);
  expect(await rhodium.ok("bind", "q", "w/a")).toContain("Bot q");
}, 30_000);

test("with QQ alone, an active message it turns down for its quota stays failed", async () => {
  await begin({ only: "q", claude: { script: obey }, platform: { activeMessages: 0 } });
  await say("q", "hello");
  await posts("q", 1);
  await rhodium.ok("send", "w/a", plan(["send", "me", "one"]));
  await until(() => daemon.logs.some((l) => l.msg === "send failed"), 15_000);
  await Bun.sleep(500); // another try would show up by now
  expect(daemon.logs.filter((l) => l.msg === "send failed")).toHaveLength(1);
  expect(await log("q")).toHaveLength(1);
}, 30_000);

test("rh send me goes to a chat that goes to the slot now, of those the one that last wrote to a slot", async () => {
  // A second Telegram bot, so that two chats go to w/a while the last to write to it goes elsewhere.
  const bots = { q: { like: "qq", owner: QQ_ME, target: "w/a" }, t: { like: "telegram", owner: TG_ME, target: "w/a" }, u: { like: "telegram", owner: TG_ME, target: "w/a" } } as const;
  rhodium = newInstance({ bots, claude: { script: obey } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  const u = () => rhodium.im.log("u", TG_ME);
  const sayU = (text: string) => rhodium.im.inject("u", { chat: TG_ME, sender: TG_ME, text });
  await say("t", "hello");
  await posts("t", 1);
  await say("q", "hello");
  await posts("q", 1);
  await sayU("hello"); // the last to write to w/a
  await until(async () => (await u()).length === 1, 15_000);
  await sayU("/rh_use b");
  await until(async () => (await u()).length === 2, 15_000);
  // q's and t's chats still go to w/a: q's wrote last.
  await rhodium.ok("send", "w/a", plan(["send", "me", "one"]));
  expect((await posts("q", 2))[1]!.text).toBe("one");
  // Once q's goes elsewhere too, t's is the one left.
  await say("q", "/rh_use b");
  await posts("q", 3);
  await rhodium.ok("send", "w/a", plan(["send", "me", "two"]));
  expect((await posts("t", 2))[1]!.text).toBe("two");
}, 30_000);

// The contact chat no longer falls back to the last chat to write to the slot (2026-10-27, #412):
// with no chat going to it, nor to its root, the main chat.
test("story 479: rh send me and a confirm request of a slot no chat goes to any more go to the main chat, saying whose, not to the chat that last wrote to it", async () => {
  await begin({ tb: true, toml: `mainChat = "t/${TG_ME}"`, claude: { script: obey } });
  await say("q", "hello"); // q's chat wrote to w/a last
  await posts("q", 1);
  await say("q", "/rh_use b");
  await posts("q", 2);
  await rhodium.ok("send", "w/a", plan(["send", "me", "hi"], ["rename", "w/b", "z"]));
  const [sent, asked] = await posts("t", 2);
  expect(sent!.text).toBe("〔w/a〕\nhi");
  expect(asked!.text).toContain("w/a");
  expect(asked!.text).toContain("rh rename w/b z");
  expect(await log("q")).toHaveLength(2);
}, 30_000);

test("story 481: a child's rh send me goes to the chat that goes to its root, not to the chat that last wrote to the child", async () => {
  await begin({ tb: true, toml: `mainChat = "t/${TG_ME}"`, claude: { script: obey } });
  await say("q", plan(["spawn", "c", plan()])); // q's chat goes to w/a, the root
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  await say("t", "/rh_use c");
  await say("t", "hello"); // t's chat wrote to w/c last
  await until(async () => (await log("t")).some((p) => p.text === "done"), 15_000);
  await say("t", "/rh_use b");
  const before = (await posts("t", 3)).length;
  await rhodium.ok("send", "w/c", plan(["send", "me", "hi"]));
  await until(async () => (await log("q")).some((p) => p.text === "〔w/c〕\nhi"), 15_000);
  expect(await log("t")).toHaveLength(before);
}, 30_000);

test("story 482: a crash of a slot no chat goes to any more is told in the main chat, not in the chat that last wrote to it", async () => {
  await begin({ tb: true, toml: `mainChat = "t/${TG_ME}"`, claude: { script: obey } });
  await say("q", "hello");
  await posts("q", 1);
  await say("q", "/rh_use b");
  await posts("q", 2);
  await until(async () => (await state()) === "空闲", 15_000);
  process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL");
  const [notice] = await posts("t", 1);
  expect(notice!.text).toContain("w/a 崩溃了");
  expect(await log("q")).toHaveLength(2);
  await holderGone();
}, 30_000);
