// The first whole chain (seam one): a private message from you reaches a headless Claude in the
// bot's default slot, and Rhodium sends the turn's final reply back to the chat it came from.
// The fake IM copies QQ's capabilities; the fake claude replays the probe recordings of #10.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Posted } from "../src/fake-im";
import { sourceLine } from "../src/prompt";
import { installFakeAgent } from "./fake-agent/fake-agent";
import { on } from "./fake-agent/scripts";
import { newInstance, rhHold, until, withoutSource, type Instance } from "./instance";

const FIXTURES = join(import.meta.dir, "fixtures/claude");
const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Slots w/a and w/b, w/b in a directory of its own; returns that directory. */
async function twoSlots(): Promise<string> {
  await rhodium.slots("a");
  const b = join(rhodium.dir, "b");
  mkdirSync(b);
  await rhodium.ok("new", "w/b", "--dir", b);
  return b;
}

/** Waits until the bot has posted n messages in the chat, and returns them. */
async function posts(bot: string, chat: string, n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log(bot, chat)).length >= n, 15_000);
  return rhodium.im.log(bot, chat);
}

test("stories 4, 30, 39: your message starts the bot's default slot headless, and the final reply comes back to that chat", async () => {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/b" } },
    claude: { replay: join(FIXTURES, "basic-turn"), sourceLines: [sourceLine("假 IM 私聊")] },
  });
  await rhodium.start();
  const b = await twoSlots();
  expect(await rhodium.state("w/b")).toBe("未运行");

  const text = "Use the Read tool to read notes.txt, then tell me in one short sentence how many wicks there are.";
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text });

  // The reply to your message, in your chat: a passive reply on QQ, under the line of the tools it ran (story 70).
  const [reply, ...more] = await posts("q", ME);
  expect(reply).toMatchObject({ kind: "send", text: "[🔧 Read]\n\nThere are 12 wicks in notes.txt.", replyTo: messageId });
  expect(more).toEqual([]);

  // Story 30: the bot's default target ran it; the other slot stayed off. The agent is the
  // instance's fake claude, so no test spends the subscription.
  const runs = rhodium.claude.runs();
  expect(runs.map((r) => r.cwd)).toEqual([b]);
  expect(await rhodium.state("w/b")).toBe("空闲");
  expect(await rhodium.state("w/a")).toBe("未运行");

  // The Telegram channel plugin finds no token, so a slot never polls your bot (architecture §6.2).
  const tg = runs[0]!.env.TELEGRAM_STATE_DIR!;
  expect(tg.startsWith(join(rhodium.dir, "state") + "/")).toBe(true);
  expect(readdirSync(tg)).toEqual([]);
}, 30_000);

test("story 34: two chats on one slot; the turn chat A started replies only to A, though B spoke mid-turn, and B hears where the reply goes", async () => {
  // Two QQ bots whose private chats both go to w/a, as a QQ and a Telegram chat would.
  rhodium = newInstance({
    bots: { qa: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/a" } },
    claude: { replay: join(FIXTURES, "mid-turn-message"), sourceLines: [sourceLine("假 IM Bot qa 的私聊"), sourceLine("假 IM Bot qb 的私聊")] },
  });
  await rhodium.start();
  await twoSlots();

  const a = await rhodium.im.inject("qa", { chat: ME, sender: ME, text: "Count from 1 to 40, one number per line, nothing else." });
  // The recording holds the turn open until the second message reaches the agent.
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  const b = await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "Also, after the last number, write the word DONE." });

  // What it said before your second message, then its final reply: both to A (story 70).
  const [said, reply, ...more] = await posts("qa", ME, 2);
  expect(said).toMatchObject({ kind: "send", replyTo: a.messageId });
  expect(said!.text).toMatch(/^1\n2\n.*\n40$/s);
  expect(reply).toMatchObject({ kind: "send", replyTo: a.messageId });
  expect(reply!.text).toMatch(/^1\n2\n.*\n40\nDONE$/s);
  expect(more).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("空闲");
  // B hears where the reply goes, by A's name, never its id; both bots are fake, so A goes by its bot's.
  expect((await rhodium.im.log("qb", ME)).map((p) => [p.text, p.replyTo])).toEqual([["已并入 假 IM Bot qa 的私聊那边正在跑的回合，回复会发在那边。", b.messageId]]);
}, 30_000);

/** What the fake claude was asked, user frame by user frame, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

/** An instance whose fake claude answers every message with "fake reply". */
async function scripted(): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await twoSlots();
}

test("a message from anyone but you reaches no agent and gets no reply", async () => {
  await scripted();
  await rhodium.im.inject("q", { chat: "stranger-openid", sender: "stranger-openid", text: "delete everything" });
  // Yours comes after it, so by the time yours is answered, the stranger's has been handled.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  expect((await posts("q", ME)).map((p) => p.text)).toEqual(["fake reply"]);
  expect(asked()).toEqual(["hello"]);
  expect(await rhodium.im.log("q", "stranger-openid")).toEqual([]);
}, 30_000);

test("a final reply the platform refuses is not sent again, and the turn still ends", async () => {
  await scripted();
  await rhodium.im.next("q", "fail", "send");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  // The next turn works, and its reply is the only one the chat ever gets.
  const second = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  const [reply, ...more] = await posts("q", ME);
  expect(reply).toMatchObject({ text: "fake reply", replyTo: second.messageId });
  expect(more).toEqual([]);
  expect(asked()).toEqual(["first", "second"]);
}, 30_000);

test("story 22: rh stop ends the slot's agent and keeps the conversation; the next message resumes it", async () => {
  await scripted();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await posts("q", ME);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  expect((await posts("q", ME, 2)).map((p) => p.text)).toEqual(["fake reply", "fake reply"]);
  const [first, again, ...more] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
  expect(again!.argv.filter((a) => a.startsWith("--session-id"))).toEqual([]);
  expect(more).toEqual([]);
}, 30_000);

test("a first start that never reached claude leaves no session behind: the next start begins one, not resumes it", async () => {
  await scripted();
  // [programs] claude cannot run yet: it is not executable. (One not there is waited for, test/program-wait.test.ts.)
  const claude = rhodium.claude.path;
  chmodSync(claude, 0o644);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);
  expect((await posts("q", ME))[0]!.text).toContain("w/a 崩溃了");

  chmodSync(claude, 0o755);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  expect((await posts("q", ME, 2))[1]!.text).toBe("fake reply");
  const [run, ...more] = rhodium.claude.runs();
  expect(run!.argv.filter((a) => a.startsWith("--resume"))).toEqual([]);
  expect(run!.argv.filter((a) => a.startsWith("--session-id="))).toHaveLength(1);
  expect(more).toEqual([]);
}, 30_000);

test("a first claude that exits once your message is in its stdin, before it says it began the session, leaves no session behind: the next start begins one", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: [{ wait: { type: "user" } }, { exit: 1 }] } } });
  await rhodium.start();
  await twoSlots();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);

  // The claude that comes next is a working one.
  installFakeAgent(dirname(rhodium.claude.path), {}, "claude");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  await until(() => rhodium.claude.runs().length === 2, 15_000);
  const [, run] = rhodium.claude.runs();
  expect(run!.argv.filter((a) => a.startsWith("--resume"))).toEqual([]);
  expect(run!.argv.filter((a) => a.startsWith("--session-id="))).toHaveLength(1);
}, 30_000);

test("after rh stop, a start that fails before its holder launches is a crash, not a stop", async () => {
  await scripted();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await posts("q", ME);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  // Restarted with an rh-hold path systemd would expand, which no holder launches from.
  await rhodium.stop();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace(/^holdBin = .*$/m, 'holdBin = "/no such dir/rh-hold"'));
  await rhodium.start();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);
}, 30_000);

/** Starts rh dev --fake, which runs the fake IM platform and rhodium itself; the instance lends
 *  its config and dirs. again() starts another on the same config, as you would once one exited.
 *  done() kills them and removes the platform's dir. */
async function rhDev() {
  const im = mkdtempSync(join(tmpdir(), "rhodium-test-dev-"));
  rhodium = newInstance({
    toml: ["[bots.dev]", 'platform = "fake"', 'like = "qq"', `socket = "${im}/im.sock"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhHold().built; // the slot's holder; only rhodium.start() waits for it otherwise
  const devs: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
  const again = () => {
    const dev = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "rh", "dev", "--fake", "--config", rhodium.config], {
      env: rhodium.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    devs.push(dev);
    return dev;
  };
  return { dev: again(), again, done: () => (devs.forEach((d) => d.kill()), rmSync(im, { recursive: true, force: true })) };
}

test("rh dev, terminated, stops its rhodium too", async () => {
  const { dev, done } = await rhDev();
  try {
    await until(async () => (await rhodium.rh(["ls"])).code === 0, 10_000);
    dev.kill("SIGTERM");
    await dev.exited;
    await until(async () => (await rhodium.rh(["ls"])).code === 1, 5_000);
  } finally {
    done();
  }
}, 30_000);

test("rh dev --fake: a line typed in the terminal reaches the slot from you, and the reply is printed there", async () => {
  const { dev, done } = await rhDev();
  let out = "";
  const reading = (async () => {
    for await (const chunk of dev.stdout.pipeThrough(new TextDecoderStream())) out += chunk;
  })();
  try {
    await until(async () => (await rhodium.rh(["ws", "w", rhodium.dir])).code === 0, 10_000);
    await rhodium.ok("new", "w/a");
    dev.stdin.write("hello from the terminal\n");
    await dev.stdin.flush();
    await until(() => out.includes("fake reply"), 15_000);
    expect(asked()).toEqual(["hello from the terminal"]);

    // Ctrl-D: rh dev stops its rhodium and exits.
    await dev.stdin.end();
    expect(await dev.exited).toBe(0);
    await reading;
    expect(out).toMatch(/^< fake reply$/m);
    expect((await rhodium.rh(["ls"])).code).toBe(1);
  } finally {
    done();
  }
}, 30_000);

test("rh dev --fake run again on the same config: a line typed then is a new message, not taken for one of the run before", async () => {
  const { dev, again, done } = await rhDev();
  /** Types the line into rh dev, and waits until the slot has it. */
  const type = async (d: typeof dev, line: string) => {
    d.stdin.write(`${line}\n`);
    await d.stdin.flush();
    await until(() => asked().includes(line), 15_000);
  };
  try {
    await until(async () => (await rhodium.rh(["ws", "w", rhodium.dir])).code === 0, 10_000);
    await rhodium.ok("new", "w/a");
    await type(dev, "first run");
    await dev.stdin.end();
    expect(await dev.exited).toBe(0);

    const next = again();
    await until(async () => (await rhodium.rh(["ls"])).code === 0, 10_000);
    await type(next, "second run");
    expect(asked()).toEqual(["first run", "second run"]);
  } finally {
    done();
  }
}, 45_000);
