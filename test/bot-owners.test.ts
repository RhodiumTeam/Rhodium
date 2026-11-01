// A bot with several owners (product §5.11, #449), seen from seam one: each owner's private chat is
// a chat of yours with a target of its own; only owners trigger an agent; rh pair --add, --rm and
// --list; the config's owners are fixed; another bot's owner chat takes what one bot can't send.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

const A = "owner-a"; // two accounts of yours under q
const B = "owner-b";
const C = "owner-c";
const STRANGER = "stranger";

/** A claude that makes the rh calls its message lists, as in notify.test.ts. */
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
const plan = (...calls: string[][]) => JSON.stringify(calls);
const CLAUDE = ["/stop", "/new", "/status", "/resume", "/model", "/usage", "/context", "/compact", "/effort", "/ultracode", "/rh_help"];
const PI = CLAUDE.filter((c) => c !== "/ultracode");

let rhodium: Instance;
let daemon: Daemon;
afterEach(() => rhodium.cleanup());

/** Slots w/a (claude) and w/b (pi unless said), each in a directory of its own, so a run's cwd tells
 *  which slot ran it. */
async function begin(opts: InstanceOptions, b: "claude" | "pi" = "claude"): Promise<void> {
  rhodium = newInstance({ claude: { script: obey }, ...opts });
  daemon = await rhodium.start();
  mkdirSync(join(rhodium.dir, "w"));
  await rhodium.ok("ws", "w", join(rhodium.dir, "w"));
  for (const [name, agent] of [["a", "claude"], ["b", b]] as const) {
    mkdirSync(join(rhodium.dir, name));
    await rhodium.ok("new", `w/${name}`, "--dir", join(rhodium.dir, name), "--agent", agent);
  }
}

const say = (sender: string, text: string, bot = "q") => rhodium.im.inject(bot, { chat: sender, sender, text });
const texts = async (chat: string, bot = "q") => (await rhodium.im.log(bot, chat)).map((p) => p.text);
/** The texts the bot posted in the chat, once one passes check. */
async function heard(chat: string, check: (t: string) => boolean, bot = "q"): Promise<string[]> {
  await until(async () => (await texts(chat, bot)).some(check), 15_000);
  return texts(chat, bot);
}
/** Says text and waits for its reply. */
async function talk(sender: string, text: string, bot = "q"): Promise<void> {
  const m = await say(sender, text, bot);
  await until(async () => (await rhodium.im.log(bot, sender)).some((p) => p.replyTo === m.messageId), 15_000);
}
/** Each fake claude run as [the slot directory it ran in, the messages it was given]. */
const runs = () =>
  rhodium.claude.runs().map((r) => [
    basename(r.cwd),
    r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text)),
  ]);
const pairCode = async (...args: string[]) => (await rhodium.ok("pair", "q", ...args)).match(/配对码：(\S+)/)![1]!;

test("stories 512, 514: two owners of one bot, each chat pointing at its own slot: replies, the contact window, rh send me and confirm requests land in the right one; the moved-chats notice in each; a stranger is still ignored", async () => {
  await begin({ bots: { q: { like: "qq", owner: [A, B], target: "w/a" } } });
  await say(STRANGER, "hi");
  await talk(B, "/rh_use b");
  await talk(A, "to a");
  await talk(B, "to b");
  expect(runs().sort()).toEqual([
    ["a", ["to a"]],
    ["b", ["to b"]],
  ]);
  // Each slot's contact window is the owner chat pointing at it: what it says by itself goes there.
  await rhodium.ok("send", "w/b", plan(["send", "me", "from b"]));
  await rhodium.ok("send", "w/a", plan(["send", "me", "from a"]));
  expect(await heard(B, (t) => t === "from b")).not.toContain("from a");
  expect(await heard(A, (t) => t === "from a")).not.toContain("from b");
  // A confirm request (an approval of yours) of w/b's goes to B's chat alone.
  await rhodium.ok("send", "w/b", plan(["stop", "w/a"]));
  await heard(B, (t) => t.includes("命令：rh stop w/a"));
  expect((await texts(A)).filter((t) => t.includes("rh stop"))).toEqual([]);
  // rh bind moves the default A's chat follows: A hears so, B's chat points elsewhere, a stranger never hears.
  await rhodium.ok("bind", "q", "w/b");
  await heard(A, (t) => t === "这里的消息改交给 w/b。");
  await Bun.sleep(300);
  expect((await texts(B)).filter((t) => t.startsWith("这里"))).toEqual(["这里的消息改交给 w/b。"]); // its own /rh_use only
  expect(await texts(STRANGER)).toEqual([]);
}, 60_000);

test("story 513: rh pair --add adds an owner, --list shows them, --rm takes one off, rh pair alone replaces them all; only you run these", async () => {
  await begin({ bots: { q: { like: "qq", target: "w/a" } } });
  await say(A, await pairCode());
  expect(await heard(A, (t) => t.startsWith("已配对"))).toEqual(["已配对，以后 Bot q 只认这个账号。"]);
  expect(await rhodium.ok("pair", "q", "--add")).toContain("原来的主人不变");
  await say(B, await pairCode("--add"));
  expect(await heard(B, (t) => t.startsWith("已配对"))).toEqual(["已配对，以后 Bot q 也认这个账号。"]);
  await talk(A, "from a");
  await talk(B, "from b");
  expect(await rhodium.ok("pair", "q", "--list")).toBe(`Bot q 的主人：\n${A}：私聊交给 w/a\n${B}：私聊交给 w/a\n`);
  // Read only: a caller rh cannot recognize may list them too, but not replace them all.
  expect((await rhodium.rh(["pair", "q", "--list"], { tty: false })).out).toBe(await rhodium.ok("pair", "q", "--list"));
  expect((await rhodium.rh(["pair", "q"], { tty: false })).err).toStartWith("rh: 不带参数的 rh pair 只有用户本人能用。认不出是谁在调用 rh");

  expect(await rhodium.rh(["pair", "q", "--rm", STRANGER])).toMatchObject({ code: 1, err: `rh: ${STRANGER} 不是 Bot q 的主人。\n` });
  expect(await rhodium.ok("pair", "q", "--rm", B)).toBe("已去掉假 IM Bot 的一个主人。\n");
  expect(await rhodium.ok("pair", "q", "--list")).toBe(`Bot q 的主人：\n${A}：私聊交给 w/a\n`);
  await say(B, "ignored now");
  await talk(A, "still a");

  // Plain rh pair: the sender is the only owner after it.
  await say(B, await pairCode("--add"));
  await heard(B, (t) => t === "已配对，以后 Bot q 也认这个账号。");
  expect(await rhodium.ok("pair", "q")).toContain("原来配对的主人都去掉");
  await say(C, await pairCode());
  await heard(C, (t) => t.startsWith("已配对"));
  expect(await rhodium.ok("pair", "q", "--list")).toBe(`Bot q 的主人：\n${C}：私聊交给 w/a\n`);
  await say(A, "ignored a");
  await say(B, "ignored b");
  await talk(C, "from c");
  expect(runs().flatMap(([, m]) => m)).toEqual(["from a", "from b", "still a", "from c"]);

  expect(await rhodium.rh(["pair", "q", "--add", "--rm", C])).toMatchObject({ code: 1 });
}, 60_000);

test("story 513: the config's owners are fixed: --rm leaves them, --add pairs another beside them", async () => {
  await begin({ bots: { q: { like: "qq", owner: A, target: "w/a" } } });
  expect(await rhodium.rh(["pair", "q", "--rm", A])).toMatchObject({ code: 1, err: `rh: ${A} 是 Bot q 配置里写的主人，以配置为准。要去掉，改配置文件里的 owner。\n` });
  await say(B, await pairCode("--add"));
  await heard(B, (t) => t === "已配对，以后 Bot q 也认这个账号。");
  expect(await rhodium.ok("pair", "q", "--list")).toBe(`Bot q 的主人：\n${A}（配置）\n${B}：私聊交给 w/a\n`);
  await talk(A, "from a");
  await talk(B, "from b");
  // A restart keeps the paired one.
  await rhodium.stop();
  daemon = await rhodium.start();
  await talk(B, "again b");
  expect(runs().flatMap(([, m]) => m)).toEqual(["from a", "from b", "again b"]);
}, 60_000);

test("story 515: with its bot faulted, a notice goes to the other bot's owner chat pointing at the same slot, else to the one you used last there", async () => {
  await begin({ toml: "[limits]\nbotFailures = 3", bots: { q: { like: "qq", owner: A, target: "w/a" }, t: { like: "telegram", owner: [B, C], target: "w/a" } } });
  await talk(C, "/rh_use b", "t");
  await talk(B, "to a", "t");
  await talk(A, "to a too"); // q's chat is w/a's contact window from now on
  await rhodium.im.connection("q", false);
  await heard(B, (t) => t.includes("连不上平台"), "t");
  const runsOfA = () => rhodium.claude.runs().filter((r) => basename(r.cwd) === "a");
  const crash = () => process.kill(runsOfA().at(-1)!.pid, "SIGKILL");
  // B's chat points at w/a, as the slot does.
  crash();
  await heard(B, (t) => t.startsWith("假 IM Bot q 的私聊那边发不出去，改发在这里。") && t.includes("w/a 崩溃了"), "t");
  expect((await texts(C, "t")).filter((t) => t.includes("崩溃"))).toEqual([]);

  // Neither points at w/a now: the one you used last on t, C, takes it.
  await talk(B, "/rh_use b", "t");
  await talk(C, "to b", "t");
  await rhodium.ok("send", "w/a", "wake up");
  await until(() => runsOfA().length === 2, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  crash();
  await heard(C, (t) => t.includes("w/a 崩溃了"), "t");
  expect((await texts(B, "t")).filter((t) => t.includes("崩溃"))).toHaveLength(1);
}, 60_000);

test("story 516: Telegram has a / menu for each owner chat by its own target; QQ's one menu follows the bot's default with several owners, the chat's with one", async () => {
  await begin({ bots: { q: { like: "qq", owner: [A, B], target: "w/a" }, t: { like: "telegram", owner: [A, B], target: "w/a" } } }, "pi");
  const menu = async (bot: string, chat: string | undefined, want: string[]) => {
    const commands = async () => (await rhodium.im.menu(bot, chat))?.map((i) => i.command);
    await until(async () => Bun.deepEquals(await commands(), want)).catch(async () => expect(await commands()).toEqual(want));
  };
  await talk(A, "hello", "t");
  await talk(B, "/rh_use b", "t");
  await menu("t", A, CLAUDE);
  await menu("t", B, PI);
  await talk(B, "/rh_use b");
  await menu("q", undefined, CLAUDE);
  await Bun.sleep(300);
  await menu("q", undefined, CLAUDE);
}, 60_000);

test("story 516: the board draws each owner's private chat as yours, each with its avatar", async () => {
  await begin({ bots: { q: { like: "qq", owner: [A, B], target: "w/a" } } });
  await talk(A, "hi");
  await talk(B, "/rh_use b");
  await say(STRANGER, "hi");
  const base = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  type Chat = { id: string; yours: boolean; avatar: string | null };
  const topology = async () => (await (await fetch(`${base}/api/topology`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as { chats: Chat[] };
  await until(async () => (await topology()).chats.filter((c) => c.avatar !== null).length === 2, 15_000);
  const { chats } = await topology();
  expect(chats.map((c) => c.yours)).toEqual([true, true]);
}, 30_000);

// Agents rebind chats and bots, and add and remove owners (product §5.11, #485): w/b's agent makes the
// rh calls its message lists; its contact window is A's private chat with q, which points at it.

/** The rh calls w/b's agent made, once there are at least n, each as [exit code, what it printed]. */
async function callsOfB(n: number): Promise<[number, string][]> {
  const calls = () => rhodium.claude.runs().filter((r) => basename(r.cwd) === "b").flatMap((r) => r.rh);
  await until(() => calls().length >= n, 15_000);
  return calls().map((c) => [c.code, (c.out || c.err).trim()]);
}
/** A confirm request of w/b's, as you get it (docs/im-style.md §5.3). */
const asksB = (want: string, cmd: string) => `w/b 想${want}\n\n命令：${cmd}\n回别的话算拒绝，并转告 w/b。`;
const ASKED = "用户的决定会作为一条消息发给你，不用等；超时没确认视为拒绝。";
/** The cards of the asks open on w/b, as the board shows them: with no chat there to be 这里. */
async function cardsOfB(): Promise<{ head: string; body: string }[]> {
  const base = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  const get = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
  const b = (await get("/api/board")).workspaces.flatMap((w: any) => Object.values(w.groups).flat()).find((c: any) => c.name === "b").id;
  return (await get(`/api/slot?id=${b}`)).asks.map((a: any) => a.card);
}

test("story 546: an agent's rh use of another chat is done at once; of its contact window, or of a chat of the main bot, it asks you first, the chat's id left out", async () => {
  await begin({ toml: `mainChat = "m/${A}"`, bots: { q: { like: "qq", owner: [A, B], target: "w/a" }, m: { like: "qq", owner: A, target: "w/a" } } });
  await talk(A, "/rh_use b");
  await rhodium.ok("send", "w/b", plan(["use", `q/${B}`, "w/a"], ["use", `m/${A}`, "w/b"]));
  expect(await callsOfB(2)).toEqual([
    [0, "假 IM Bot q 的私聊的消息改交给 w/a。"],
    [0, `已请用户确认：rh use m/${A} w/b。${ASKED}`],
  ]);
  const main = asksB("把假 IM Bot m 的私聊（它现在交给 w/a）改交给 w/b。", "rh use m/… w/b");
  await heard(A, (t) => t === main);
  await say(A, "2");

  await rhodium.ok("send", "w/b", plan(["use", `q/${A}`, "w/a"]));
  await heard(A, (t) => t === asksB("把这里改交给 w/a。", "rh use q/… w/a"));
  expect((await callsOfB(3))[2]).toEqual([0, `已请用户确认：rh use q/${A} w/a。${ASKED}`]);
  expect(await cardsOfB()).toMatchObject([{ head: "w/b 想把假 IM Bot q 的私聊（它现在交给 w/b）改交给 w/a。", body: "rh use q/… w/a" }]);
  await say(A, "1");
  await heard(A, (t) => t === "这里的消息改交给 w/a。");
}, 60_000);

test("story 546: an agent's rh bind asks you first when its contact window follows that bot's default, and is done at once when the window picked its own", async () => {
  await begin({ bots: { q: { like: "qq", owner: A, target: "w/a" } } });
  await talk(A, "/rh_use b");
  await rhodium.ok("send", "w/b", plan(["bind", "q", "w/b"]));
  expect(await callsOfB(1)).toEqual([[0, "Bot q 的默认槽位改成 w/b。单独选过槽位的窗口不受影响。"]]);
  await talk(A, "/rh_use -");
  await rhodium.ok("send", "w/b", plan(["bind", "q", "w/a"]));
  await heard(A, (t) => t === asksB("把假 IM Bot 的默认槽位改成 w/a。\n这里的消息也会改交给 w/a。", "rh bind q w/a"));
  expect(await cardsOfB()).toMatchObject([{ head: "w/b 想把假 IM Bot 的默认槽位改成 w/a。\n假 IM 私聊的消息也会改交给 w/a。", body: "rh bind q w/a" }]);
}, 60_000);

test("story 547: an agent's rh pair --add sends the code to its contact window, never to the agent nor on record; sent from the new account, it pairs", async () => {
  await begin({ bots: { q: { like: "qq", owner: A, target: "w/a" } } });
  await talk(A, "/rh_use b");
  await rhodium.ok("send", "w/b", plan(["pair", "q", "--add"]));
  expect(await callsOfB(1)).toEqual([[0, "配对码已发到用户的假 IM 私聊，10 分钟内有效。配上没有，用 rh pair q --list 看。"]]);
  const said = await heard(A, (t) => /^[A-Z0-9]{8}$/.test(t));
  const code = said.at(-1)!;
  expect(said.at(-2)).toBe("w/b 要给假 IM Bot 加一个主人。\n10 分钟内，用要加的那个账号私聊假 IM Bot，发下一条里的码。只用你本人的账号。\n不想加就别理它。");
  await say(B, code);
  await heard(B, (t) => t === "已配对，以后 Bot q 也认这个账号。");
  await rhodium.stop();
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const kept = JSON.stringify([db.query("SELECT * FROM event").all(), db.query("SELECT text FROM outbound").all()]);
  db.close();
  expect(kept).not.toContain(code);
}, 60_000);

test("story 548: an agent's rh pair --list says where each owner's private chat goes, and --rm asks you first", async () => {
  await begin({ bots: { q: { like: "qq", owner: A, target: "w/a" } } });
  await talk(A, "/rh_use b");
  await say(B, await pairCode("--add"));
  await heard(B, (t) => t.startsWith("已配对"));
  await talk(B, "hi");
  await rhodium.ok("send", "w/b", plan(["pair", "q", "--list"], ["pair", "q", "--rm", B]));
  expect((await callsOfB(2))[0]).toEqual([0, `Bot q 的主人：\n${A}（配置）：私聊交给 w/b\n${B}：私聊交给 w/a`]);
  await heard(A, (t) => t === asksB("去掉假 IM Bot 的一个主人（它的私聊现在交给 w/a）。\n那个账号的消息不再触发 agent。", "rh pair q --rm …"));
  await say(A, "1");
  await until(async () => (await rhodium.ok("pair", "q", "--list")) === `Bot q 的主人：\n${A}（配置）：私聊交给 w/b\n`, 15_000);
}, 60_000);
