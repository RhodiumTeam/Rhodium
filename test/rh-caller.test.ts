// How rh knows who calls it (docs/spec/v1.md "rh 怎么认出调用者"), seen from seam one: by the
// slot's token, by the holder unit the caller runs in, or else as you from a terminal or as a
// caller it cannot recognize.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

// With a main chat, its writes become confirm requests instead (confirm.test.ts).
test("a caller rh cannot recognize may read, but with no main chat to ask you in, not write; from a terminal it is you", async () => {
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");

  const unknown = (...args: string[]) => rhodium.rh(args, { tty: false });
  const ls = await unknown("ls");
  expect(ls.code).toBe(0);
  expect(ls.out).toMatch(/^w\/a /m);
  for (const args of [["set", "w/a", "reap=2h"], ["new", "w/b"], ["ws", "v", rhodium.dir]]) {
    const r = await unknown(...args);
    expect({ args, code: r.code }).toEqual({ args, code: 1 });
    expect(r.err).toContain("认不出");
  }
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/b /m);
  expect(await rhodium.ok("ls", "w/a")).toMatch(/^回收时长: 1h（默认）$/m);

  await rhodium.ok("set", "w/a", "reap=2h");
  expect(await rhodium.ok("ls", "w/a")).toMatch(/^回收时长: 2h$/m);
});

/** The texts the bot has posted in the chat, once there are at least n. */
async function texts(bot: string, chat: string, n: number): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, chat)).length >= n, 15_000);
  return (await rhodium.im.log(bot, chat)).map((p) => p.text);
}

test("stories 40, 47: the agent's rh send me needs no identity flags and reaches its contact chat; that turn's final reply is neither sent nor on record as sent", async () => {
  const script: Script = {
    on,
    steps: [
      ...startTurn,
      { rh: ["send", "me", "by token"] },
      // Without the token, the holder unit rh runs in says which slot it is.
      { rh: ["send", "me", "by unit"], env: { RHODIUM_TOKEN: "" } },
      ...endTurn("first final reply"),
      ...startTurn,
      ...endTurn("second final reply"),
    ],
  };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  const daemon = await rhodium.start();
  await rhodium.slots("a");

  const first = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  // The next turn used no rh send me, so its reply comes; the first turn's never came before it.
  const second = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  expect(await texts("q", ME, 3)).toEqual(["by token", "by unit", "second final reply"]);
  // Nor is the first turn's on record as a final reply sent (rh trace; the board's 发出最终回复).
  expect(await rhodium.ok("trace", first.messageId)).not.toContain("final_reply");
  expect(await rhodium.ok("trace", second.messageId)).toMatch(/^ {2}.* final_reply w\/a$/m);

  const [run] = rhodium.claude.runs();
  expect(run!.rh.map((c) => [c.code, c.err])).toEqual([[0, ""], [0, ""]]);
  expect(run!.env.RHODIUM_SLOT).toBe("w/a");
  expect(run!.env.RHODIUM_TOKEN).toBe("<redacted>"); // set, and kept out of the fake agent's log

  // Nor is it in rhodium's log or the event table: only the slot row keeps it.
  await rhodium.stop();
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const { token } = db.query("SELECT token FROM slot").get() as { token: string };
  const events = JSON.stringify(db.query("SELECT * FROM event").all());
  db.close();
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(events).not.toContain(token);
  expect(daemon.logs.length).toBeGreaterThan(0);
  expect(JSON.stringify(daemon.logs)).not.toContain(token);
}, 30_000);

test("an agent's rh set, rh stop --all and rh pair with no flag are refused, as only you may run them", async () => {
  const calls = [["set", "w/a", "reap=2h"], ["stop", "--all"], ["pair", "q"]];
  const script: Script = { on, steps: [...startTurn, ...calls.map((rh) => ({ rh })), ...endTurn("done"), { goto: 0 }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a");

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "go" });
  expect(await texts("q", ME, 1)).toEqual(["done"]);
  const [run] = rhodium.claude.runs();
  expect(run!.rh.map((c) => c.args)).toEqual(calls);
  for (const c of run!.rh) {
    expect(c.code).toBe(1);
    expect(c.err).toContain("只有用户本人能用");
  }
  expect(await rhodium.state("w/a")).toBe("空闲");
  expect(await rhodium.ok("ls", "w/a")).toMatch(/^回收时长: 1h（默认）$/m);
}, 30_000);

test("rh send me with no contact chat, as from your terminal, goes to the main chat in the config", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME } } });
  await rhodium.start();
  const none = await rhodium.rh(["send", "me", "hello"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("主窗口");

  await rhodium.stop();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace("[programs]", `mainChat = "q/${ME}"\n[programs]`));
  await rhodium.start();
  await rhodium.ok("send", "me", "hello");
  // What follows me is the text as it is, though it looks like an option: a list item, a rule.
  await rhodium.ok("send", "me", "- done");
  await rhodium.ok("send", "me", "--- summary ---");
  expect(await texts("q", ME, 3)).toEqual(["hello", "- done", "--- summary ---"]);
});

test("story 45: rh send me goes to the chat that last messaged the slot, though another chat started the turn; sent there, it leaves that turn's final reply to be sent", async () => {
  const script: Script = {
    on,
    steps: [
      ...startTurn,
      { wait: { type: "user" } }, // B's message, mid-turn
      { rh: ["send", "me", "to the last chat"] },
      ...endTurn("final reply"),
      ...startTurn,
      ...endTurn("next reply"),
    ],
  };
  // Two QQ bots whose private chats both go to w/a, as a QQ and a Telegram chat would.
  rhodium = newInstance({
    bots: { qa: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/a" } },
    claude: { script },
  });
  await rhodium.start();
  await rhodium.slots("a");

  await rhodium.im.inject("qa", { chat: ME, sender: ME, text: "from A" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "from B" });
  expect(await texts("qb", ME, 2)).toEqual(["已并入 假 IM Bot qa 的私聊那边正在跑的回合，回复会发在那边。", "to the last chat"]);
  // rh send me went to another chat than the turn's: the turn's reply still comes (product §5.5).
  expect(await texts("qa", ME, 1)).toEqual(["final reply"]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  await rhodium.im.inject("qa", { chat: ME, sender: ME, text: "from A again" });
  expect(await texts("qa", ME, 2)).toEqual(["final reply", "next reply"]);
  expect(await texts("qb", ME, 2)).toHaveLength(2);
}, 30_000);
