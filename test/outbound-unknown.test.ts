// Seam one: a message to IM that may or may not have arrived is never sent again; rather one too
// few than the same words twice (architecture §7.4). After a restart, what was mid-send counts as
// such, and what was still waiting to go goes out (architecture §5 step 8).
// Every kill -9 goes to a PID this test instance recorded itself.
import { afterEach, expect, test } from "bun:test";
import { newInstance, until, type Daemon, type Instance } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Slot w/a, the target of a QQ-like bot q; its fake claude answers each message with "fake reply". */
async function begin(): Promise<Daemon> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  const d = await rhodium.start();
  await rhodium.slots("a");
  return d;
}

const asked = () => rhodium.claude.runs().flatMap((r) => r.stdin.filter((l) => JSON.parse(l).type === "user")).length;

/** Sends a message from you and waits until its turn is over. Returns its platform message id. */
async function turn(text: string): Promise<string> {
  const n = asked();
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text });
  await until(async () => asked() > n && (await rhodium.state("w/a")) === "空闲", 15_000);
  return messageId;
}

/** What the bot posted to you, once it has posted at least n messages; anything sent twice shows by then. */
async function posted(n: number): Promise<{ text: string; replyTo?: string }[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  await Bun.sleep(300);
  return (await rhodium.im.log("q", ME)).map((p) => ({ text: p.text, replyTo: p.replyTo }));
}

test("stories 120, 121: a final reply whose send timed out is marked unknown and never sent again, a restart included", async () => {
  const d = await begin();
  await rhodium.im.next("q", "timeout", "send");
  const first = await turn("first");
  await until(() => d.logs.some((l) => l.msg === "send failed" && l.status === "unknown"), 15_000);

  await rhodium.kill9();
  await rhodium.start();
  const second = await turn("second");
  expect(await posted(2)).toEqual([
    { text: "fake reply", replyTo: first },
    { text: "fake reply", replyTo: second },
  ]);
}, 30_000);

test("story 121: rhodium killed while a message waits out Telegram's pace: it never went out, so it goes out after the restart", async () => {
  rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a", perChatPerSecond: "1" } } });
  await rhodium.start();
  await rhodium.slots("a");
  // Answered by Rhodium at once, with no agent running: the second waits a second for its turn.
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/status" });
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/status" });
  await until(async () => (await rhodium.im.log("t", ME)).length === 1, 15_000);
  await Bun.sleep(300);
  await rhodium.kill9();
  await rhodium.start();
  await until(async () => (await rhodium.im.log("t", ME)).length === 2, 3_000).catch(() => {});
  expect(await rhodium.im.log("t", ME)).toHaveLength(2);
}, 30_000);

test("story 121: rhodium killed mid-send: that message counts as unknown and is not sent again; one still waiting goes out", async () => {
  await begin();
  // The platform takes the first reply but never answers, so the second waits behind it.
  await rhodium.im.next("q", "hang", "send");
  const first = await turn("first");
  await posted(1);
  const second = await turn("second");
  expect(await posted(1)).toHaveLength(1);

  await rhodium.kill9();
  const d = await rhodium.start();
  expect(await posted(2)).toEqual([
    { text: "fake reply", replyTo: first },
    { text: "fake reply", replyTo: second },
  ]);
  expect(d.logs.filter((l) => l.msg === "send outcome unknown")).toHaveLength(1);
}, 30_000);
