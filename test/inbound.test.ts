// Inbound (seam one): pairing a bot with you, only you trigger an agent, and each IM message is
// handled once (architecture §7.3, §8.5, §11).
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { Posted } from "../src/fake-im";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
const STRANGER = "stranger-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** An instance with slot w/a, the target of bot q; q is paired with you only if `bot` says so. */
async function begin(bot: Record<string, string> = {}, more: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", target: "w/a", ...bot } }, ...more });
  await rhodium.start();
  await rhodium.slots("a");
}

/** Waits until the bot has posted n messages in the chat, and returns their text. */
async function posts(chat: string, n: number): Promise<string[]> {
  await until(async () => (await rhodium.im.log("q", chat)).length >= n, 15_000);
  return (await rhodium.im.log("q", chat)).map((p: Posted) => p.text);
}

/** What the fake claude was asked, user frame by user frame, over all its runs. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => withoutSource(m.message.content[0].text));

/** A pairing code for bot q from rh pair, run at your terminal. */
async function pairCode(): Promise<string> {
  const out = await rhodium.ok("pair", "q");
  return out.match(/配对码：(\S+)/)![1]!;
}

const say = (sender: string, text: string) => rhodium.im.inject("q", { chat: sender, sender, text });

// One flow for every platform: pairing compares ids alone. rh-bot.test.ts pairs a real Telegram adapter (story 29).
test("stories 26, 27: an unpaired bot heeds no one until you send it the code from rh pair; then only you", async () => {
  await begin();
  await say(ME, "before the code");
  const code = await pairCode();
  await say(STRANGER, "not the code");
  await say(ME, ` ${code.toLowerCase()} `);
  expect(await posts(ME, 1)).toEqual(["已配对，以后 Bot q 只认这个账号。"]);

  // The code is used up: sent again, by anyone, it is just a message from someone who is not you.
  await say(STRANGER, code);
  await say(STRANGER, "delete everything");
  await say(ME, "hello");
  expect(await posts(ME, 2)).toEqual(["已配对，以后 Bot q 只认这个账号。", "fake reply"]);
  expect(asked()).toEqual(["hello"]);
  expect(await rhodium.im.log("q", STRANGER)).toEqual([]);
}, 30_000);

test("story 27: a code works only for its time, a new one voids the old, and only rh pair at your terminal gives one", async () => {
  await begin({}, { toml: '[durations]\npairCode = "300ms"' });
  const late = await pairCode();
  await Bun.sleep(400);
  await say(ME, late);
  await Bun.sleep(300); // its success would show up by now
  expect(await rhodium.im.log("q", ME)).toEqual([]);
  const old = await pairCode();
  const code = await pairCode();
  await say(ME, old);
  await say(ME, code);
  expect(await posts(ME, 1)).toEqual(["已配对，以后 Bot q 只认这个账号。"]);
  // A second success would come before the reply to a message sent after it.
  await say(ME, "hello");
  expect(await posts(ME, 2)).toEqual(["已配对，以后 Bot q 只认这个账号。", "fake reply"]);

  const r = await rhodium.rh(["pair", "q"], { tty: false });
  expect(r.code).toBe(1);
  expect(r.err).toContain("rh pair 只有用户本人能用");
}, 30_000);

test("story 119: the same message delivered twice reaches the agent once and is answered once", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  const { messageId } = await say(ME, "hello");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello", messageId });
  // The same id in another chat is another message.
  await rhodium.im.inject("q", { chat: "other-chat", sender: ME, text: "again", messageId });
  await until(() => asked().length === 2, 15_000);
  await Bun.sleep(300); // a second reply would show up by now
  expect(asked()).toEqual(["hello", "again"]);
  expect((await rhodium.im.log("q", ME)).map((p) => ({ text: p.text, replyTo: p.replyTo }))).toEqual([{ text: "fake reply", replyTo: messageId }]);
  // Turned away as a duplicate, not as a failure.
  expect(daemon.logs.filter((l) => l.msg === "input failed")).toEqual([]);
}, 30_000);

test("story 119: rhodium killed mid-turn; the platform delivers the message again after the restart; the agent still has it once", async () => {
  const steps = [...startTurn, { sleep: 300 }, ...endTurn("done"), { goto: 0 }];
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps } } });
  await rhodium.start();
  await rhodium.slots("a");
  const { messageId } = await say(ME, "count");
  await until(() => asked().length === 1, 15_000);
  await rhodium.kill9();
  await rhodium.start();
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "count", messageId });
  await posts(ME, 1);
  // Once the next message has its reply, the one before it was long handled.
  await say(ME, "next");
  await posts(ME, 2);
  await Bun.sleep(300); // a third reply would show up by now
  expect(asked()).toEqual(["count", "next"]);
  expect(await rhodium.im.log("q", ME)).toHaveLength(2);
}, 60_000);

test("story 27: a bot whose config names its owner is paired already, and rh pair leaves it so", async () => {
  await begin({ owner: ME });
  expect(await rhodium.rh(["pair", "q"])).toMatchObject({ code: 1, err: "rh: Bot q 的配置里写了 owner，以配置为准。要换账号，改配置文件里的 owner。\n" });
  await say(ME, "hello");
  expect(await posts(ME, 1)).toEqual(["fake reply"]);
}, 30_000);

test("story 27: a code from before owner went into the config is void once it has", async () => {
  await begin();
  const code = await pairCode();
  await rhodium.stop();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace('target = "w/a"', `target = "w/a"\nowner = "${ME}"`));
  await rhodium.start();
  await say(STRANGER, code);
  await say(ME, "hello");
  expect(await posts(ME, 1)).toEqual(["fake reply"]);
  expect(await rhodium.im.log("q", STRANGER)).toEqual([]);
  expect(asked()).toEqual(["hello"]);
}, 30_000);
