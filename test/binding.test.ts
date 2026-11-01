// Bindings and the command menus (seam one): /rh_use points one chat at a slot, /rh_bind moves a bot's
// default target (product §5.2); the / menu holds the commands the current agent takes and /rh_help,
// and follows the chat's target and the slot's agent as they change; QQ's row holds Rhodium's own,
// whatever the agent (product §5.7).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { QQ_ROW, TELEGRAM_ROW } from "../src/commands";
import { newInstance, until, withoutSource, type Instance } from "./instance";

const ME = "you";

// Product §5.7's / menu: a Claude slot's 11, a pi slot's 10, without /ultracode (story 397).
const CLAUDE = ["/stop", "/new", "/status", "/resume", "/model", "/usage", "/context", "/compact", "/effort", "/ultracode", "/rh_help"];
const PI = CLAUDE.filter((c) => c !== "/ultracode");

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium with a QQ bot q and a Telegram bot t, both sending your private chat to w/a by default.
 *  Each slot named in agents is in a directory of its own, so a run's cwd tells which slot ran it. */
async function start(agents: Record<string, "claude" | "pi"> = { a: "claude" }, toml?: string): Promise<void> {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } },
    toml,
  });
  await rhodium.start();
  mkdirSync(join(rhodium.dir, "w"));
  await rhodium.ok("ws", "w", join(rhodium.dir, "w"));
  for (const [name, agent] of Object.entries(agents)) {
    mkdirSync(join(rhodium.dir, name));
    await rhodium.ok("new", `w/${name}`, "--dir", join(rhodium.dir, name), "--agent", agent);
  }
}

/** The commands in the / menu the bot's chat sees, once it reads want. */
async function menu(bot: string, want: string[]): Promise<void> {
  const commands = async () => (await rhodium.im.menu(bot, ME))?.map((i) => i.command);
  await until(async () => Bun.deepEquals(await commands(), want)).catch(async () => expect(await commands()).toEqual(want));
}

/** How many rows and / menus the bot has pushed. */
const pushes = async (bot: string) => ({ rows: (await rhodium.im.rowLog(bot)).length, menus: (await rhodium.im.menuLog(bot)).length });

const say = (bot: string, text: string, chat = ME) => rhodium.im.inject(bot, { chat, sender: ME, text });

/** The texts the bot has posted in the chat, once there are n. */
async function posts(bot: string, n: number, chat = ME): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, chat)).length >= n, 15_000);
  return (await rhodium.im.log(bot, chat)).map((p) => p.text);
}

/** Each fake claude run as [the slot directory it ran in, the messages it was given]. */
const runs = () =>
  rhodium.claude.runs().map((r) => [
    basename(r.cwd),
    r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text)),
  ]);

test("story 31: after /rh_use shop this chat's messages go to the shop slot; the bot's other chats still go to its default", async () => {
  await start({ a: "claude", shop: "claude" });
  await say("t", "/rh_use shop");
  expect((await posts("t", 1))[0]).toContain("w/shop");
  await say("t", "to shop");
  await say("t", "to a", "another chat");
  await posts("t", 2);
  await posts("t", 1, "another chat");
  expect(runs().sort()).toEqual([
    ["a", ["to a"]],
    ["shop", ["to shop"]],
  ]);
}, 30_000);

test("stories 323, 326, 330: each bot gets its row and its / menu once each, Telegram's row to your chat", async () => {
  await start();
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
  await until(async () => (await pushes("t")).rows === 1);
  await rhodium.ok("ls");
  expect(await rhodium.im.rowLog("q")).toMatchObject([{ row: QQ_ROW }]);
  expect(await rhodium.im.rowLog("t")).toMatchObject([{ chat: ME, row: TELEGRAM_ROW }]);
  // Each / menu twice: first with no slot w/a yet, then once it is made.
  expect(await pushes("q")).toEqual({ rows: 1, menus: 2 });
  expect(await pushes("t")).toEqual({ rows: 1, menus: 2 });
}, 30_000);

test("story 331: a Telegram bot paired gets its row after 已配对 has arrived, at the chat's pace; paired anew to another account, the row goes to the new chat", async () => {
  rhodium = newInstance({ bots: { t: { like: "telegram" } } });
  await rhodium.start();
  const pair = async (who: string) => {
    const code = (await rhodium.ok("pair", "t")).match(/配对码：(\S+)/)![1]!;
    await rhodium.im.inject("t", { chat: who, sender: who, text: code });
  };
  await pair(ME);
  await until(async () => (await rhodium.im.rowLog("t")).length === 1, 15_000);
  const [paired] = await rhodium.im.log("t", ME);
  const [row] = await rhodium.im.rowLog("t");
  expect(paired!.text).toStartWith("已配对");
  expect(row).toMatchObject({ chat: ME, row: TELEGRAM_ROW });
  // The chat's pace, the test's five messages a second: the row waits out the gap after 已配对.
  expect(row!.at - paired!.at).toBeGreaterThanOrEqual(150);
  await pair("someone else");
  await until(async () => (await rhodium.im.rowLog("t")).length === 2, 15_000);
  expect((await rhodium.im.rowLog("t"))[1]).toMatchObject({ chat: "someone else", row: TELEGRAM_ROW });
}, 30_000);

test("story 334: /start on Telegram pushes the row again and not the / menu; the agent still gets it", async () => {
  await start();
  await menu("t", CLAUDE);
  await until(async () => (await pushes("t")).rows === 1);
  const before = await pushes("t");
  await say("t", "/start");
  await until(async () => (await pushes("t")).rows === 2, 15_000);
  await posts("t", 1);
  expect(runs()).toEqual([["a", ["/start"]]]);
  expect(await pushes("t")).toEqual({ rows: 2, menus: before.menus });
}, 30_000);

test("an unpaired Telegram bot, with no chat to push to, gets neither", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME }, t: { like: "telegram" } } });
  await rhodium.start();
  await menu("q", PI);
  await rhodium.ok("ls");
  await Bun.sleep(300);
  expect(await pushes("t")).toEqual({ rows: 0, menus: 0 });
}, 30_000);

test("story 333: Rhodium commands not in the / menu still work typed", async () => {
  await start();
  await say("q", "/rh_verbose on");
  await say("q", "/rh_rename b");
  const [verbose, renamed] = await posts("q", 2);
  expect(verbose).toBe("工具行改成详细：每个工具一行，带文件名或命令。");
  expect(renamed).toStartWith("已把 w/a 改名为 w/b。");
}, 30_000);

test("story 32: /rh_bind changes the bot's default target; a chat given its own with /rh_use keeps it, other bots keep theirs", async () => {
  await start({ a: "claude", b: "claude", c: "claude" });
  await say("t", "/rh_use w/c", "pinned");
  await say("t", "/rh_bind w/b");
  expect((await posts("t", 1))[0]).toContain("w/b");
  await say("t", "to b");
  await say("t", "to c", "pinned");
  await say("q", "to a");
  await Promise.all([posts("t", 2), posts("t", 2, "pinned"), posts("q", 1)]);
  expect(runs().sort()).toEqual([
    ["a", ["to a"]],
    ["b", ["to b"]],
    ["c", ["to c"]],
  ]);
}, 30_000);

test("stories 32, 33: rh bind and rh use from ssh point QQ and Telegram at one slot, and the two carry on one conversation", async () => {
  await start({ a: "claude", b: "claude" });
  expect(await rhodium.ok("bind", "q", "w/b")).toContain("w/b");
  expect(await rhodium.ok("use", `t/${ME}`, "b")).toContain("w/b");
  // Story 260: the chat hears so; q's, not on record yet, has nothing to hear.
  expect(await posts("t", 1)).toEqual(["这里的消息改交给 w/b。"]);
  await say("q", "from QQ");
  await posts("q", 1);
  await say("t", "from Telegram");
  await posts("t", 2);
  // One claude, given both: the same conversation.
  expect(runs()).toEqual([["b", ["from QQ", "from Telegram"]]]);
}, 30_000);

test("/rh_use - takes the chat back to its bot's default target, saying which slot that is, and /rh_bind moves it again; rh use <Bot>/<窗口 ID> - from ssh too", async () => {
  await start({ a: "claude", shop: "claude" });
  await say("t", "/rh_use shop");
  await say("t", "/rh_use -");
  // In IM the chat is 这里, never its id.
  expect(await posts("t", 2)).toEqual(["这里的消息改交给 w/shop。", "这里改回默认，消息交给 w/a。"]);
  await say("t", "to a");
  await posts("t", 3);

  expect(await rhodium.ok("use", `t/${ME}`, "shop")).toContain("w/shop");
  // Named, never by its id; the chat hears so too (story 260).
  expect(await rhodium.ok("use", `t/${ME}`, "-")).toBe("假 IM Bot t 的私聊的消息改回 Bot t 的默认槽位 w/a。\n");
  expect((await posts("t", 5)).slice(3)).toEqual(["这里的消息改交给 w/shop。", "这里改回默认，消息交给 w/a。"]);
  await say("t", "/rh_bind shop");
  expect((await posts("t", 6))[5]).toBe("这个 Bot 的默认槽位改成 w/shop。单独选过槽位的窗口不受影响。");
  await say("t", "to shop");
  await posts("t", 7);
  expect(runs().sort()).toEqual([
    ["a", ["to a"]],
    ["shop", ["to shop"]],
  ]);
}, 30_000);

/** Spawns the one-off slot w/<name> from your terminal, and waits for its first turn to end. */
async function oneOff(name: string): Promise<void> {
  expect((await rhodium.rh(["spawn", name, "do it"], { cwd: join(rhodium.dir, "w") })).out).toContain("一次性");
  await until(async () => (await rhodium.state(`w/${name}`)) === "空闲", 15_000);
}

test("a one-off slot archived by its clock takes each chat pointing at it back to its bot's default target, and says so there", async () => {
  await start({ a: "claude" }, '[durations]\noneoffArchive = "2s"');
  await oneOff("c");
  await say("t", "/rh_use c");
  await say("q", "/rh_use c");
  await Promise.all([posts("t", 1), posts("q", 1)]);
  await say("t", "to c"); // its clock starts again once this turn is over
  await posts("t", 2);
  const told = "w/c 归档了，这里的消息改交给 w/a。";
  await until(async () => (await posts("t", 2)).includes(told) && (await posts("q", 1)).includes(told), 15_000);
  expect(await rhodium.ok("ls", "--all")).toMatch(/^w\/c .*（已归档）/m);
  await say("q", "to a");
  await posts("q", 3);
  expect(runs().filter(([dir]) => dir === "a")).toEqual([["a", ["to a"]]]);
}, 30_000);

test("rh archive of a one-off slot takes the chat pointing at it back to its bot's default target, and says so there", async () => {
  await start({ a: "claude" });
  await oneOff("c");
  await say("t", "/rh_use c");
  await posts("t", 1);
  await rhodium.ok("archive", "w/c");
  expect((await posts("t", 2))[1]).toBe("w/c 归档了，这里的消息改交给 w/a。");
  await say("t", "to a");
  await posts("t", 3);
  expect(runs().filter(([dir]) => dir === "a")).toEqual([["a", ["to a"]]]);
}, 30_000);

test("rh archive of a long-term slot takes the chat pointing at it back to its bot's default target, which rh unarchive leaves as it is", async () => {
  await start({ a: "claude", x: "claude" });
  await say("t", "/rh_use x");
  await posts("t", 1);
  await rhodium.ok("archive", "w/x");
  expect((await posts("t", 2))[1]).toBe("w/x 归档了，这里的消息改交给 w/a。");
  await rhodium.ok("unarchive", "w/x");
  await say("t", "to a");
  await posts("t", 3);
  expect(runs()).toEqual([["a", ["to a"]]]);
}, 30_000);

test("/rh_archive of the long-term slot this chat points at says where its messages go now in the command's reply", async () => {
  await start({ a: "claude", x: "claude" });
  await say("t", "/rh_use x");
  await posts("t", 1);
  await say("t", "/rh_archive w/x");
  await until(async () => (await rhodium.ok("ls", "--all")).includes("（已归档）"), 15_000);
  await say("t", "to a");
  expect(await posts("t", 3)).toEqual(["这里的消息改交给 w/x。", "已归档 w/x，对话保留。rh unarchive w/x 恢复。\n这里的消息改交给 w/a。", "fake reply"]);
  expect(runs()).toEqual([["a", ["to a"]]]);
}, 30_000);

test("story 22: a bot's default target is not archived: rh archive and /rh_archive name each bot it is the default of, and say to bind another first", async () => {
  await start({ a: "claude", x: "claude" });
  expect(await rhodium.rh(["archive", "w/a"])).toMatchObject({ code: 1, err: "rh: w/a 是 假 IM Bot q、假 IM Bot t 的默认目标，先用 rh bind 换一个再归档。\n" });
  await say("t", "/rh_archive w/a");
  expect(await posts("t", 1)).toEqual(["w/a 是 假 IM Bot q、假 IM Bot t 的默认目标，先用 /rh_bind 换一个再归档。"]);
  await rhodium.ok("bind", "q", "w/x");
  expect(await rhodium.rh(["archive", "w/a"])).toMatchObject({ code: 1, err: "rh: w/a 是 假 IM Bot t 的默认目标，先用 rh bind 换一个再归档。\n" });
  expect(await rhodium.ok("ls")).toMatch(/^w\/a /m);
  await rhodium.ok("bind", "t", "w/x");
  await rhodium.ok("archive", "w/a");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/a /m);
}, 30_000);

test("story 100: a one-off slot that is a bot's default target is not archived by its clock, and nothing is said", async () => {
  await start({ a: "claude" }, '[durations]\noneoffArchive = "2s"');
  await oneOff("c");
  await rhodium.ok("bind", "t", "w/c");
  await Bun.sleep(3_000); // past its clock
  expect(await rhodium.ok("ls")).toMatch(/^w\/c /m);
  expect(await rhodium.im.log("t", ME)).toEqual([]);
}, 30_000);

test("story 32: /rh_bind to an archived slot brings it back, as a message to it would: no bot's default target is ever an archived slot", async () => {
  await start({ a: "claude", x: "claude" });
  await rhodium.ok("archive", "w/x");
  await say("t", "/rh_bind w/x");
  expect(await posts("t", 1)).toEqual(["这个 Bot 的默认槽位改成 w/x。单独选过槽位的窗口不受影响。"]);
  expect(await rhodium.ok("ls")).toMatch(/^w\/x /m);
  // rh bind from your terminal too.
  await rhodium.ok("bind", "q", "w/x");
  await rhodium.ok("archive", "w/a");
  await rhodium.ok("bind", "q", "w/a");
  expect(await rhodium.ok("ls")).toMatch(/^w\/a /m);
}, 30_000);

test("/rh_use and /rh_bind say why when the slot is not there or its name alone is not enough", async () => {
  await start({ a: "claude" });
  await rhodium.ok("ws", "v", rhodium.dir);
  await rhodium.ok("new", "v/a");
  await say("q", "/rh_use nowhere");
  await say("q", "/rh_bind a");
  await say("q", "/rh_use");
  expect(await posts("q", 3)).toEqual([
    "没有槽位 nowhere。",
    "有 2 个槽位叫 a：w/a、v/a，写全名。",
    // Alone, it offers the slots to pick from (docs/im-style.md §9.2).
    "这里的消息交给谁？\n现在：w/a",
  ]);
}, 30_000);

test("story 63: the menu follows the chat's target to a pi slot", async () => {
  await start({ a: "claude", p: "pi" });
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
  await say("t", "/rh_use w/p");
  await menu("t", PI);
  await say("t", "/rh_use w/a");
  await menu("t", CLAUDE);
  await say("q", "/rh_bind w/p");
  await menu("q", PI);
}, 30_000);

test("stories 63, 325, 327: a Claude slot changed to pi drops /ultracode from every / menu pointing at it; changed back, they are as they were; QQ's row is not pushed again", async () => {
  await start();
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
  const before = await pushes("q");
  await say("q", "/rh_agent pi");
  // Both bots point at w/a: both menus follow it.
  await menu("q", PI);
  await menu("t", PI);
  await say("t", "/rh_agent claude");
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
  expect(await pushes("q")).toEqual({ rows: 1, menus: before.menus + 2 });
}, 30_000);

test("story 63: rh agent from your terminal changes the menu too; /resume back to the Claude conversation restores it", async () => {
  await start();
  await say("q", "first");
  await posts("q", 1);
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1]!;
  await rhodium.ok("agent", "w/a", "pi");
  await menu("q", PI);
  await say("q", `/resume ${session}`);
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
}, 30_000);

test("a menu that has not changed is not pushed again, across a restart too", async () => {
  await start({ a: "claude", b: "claude", p: "pi" });
  await menu("q", CLAUDE);
  const before = await pushes("q");
  await say("q", "/rh_bind w/b"); // claude as well: the same menu
  await posts("q", 1);
  await rhodium.stop();
  await rhodium.start();
  await say("q", "/rh_ls");
  await posts("q", 2);
  // A change still goes out, after every sync before it: one push more, no others.
  await say("q", "/rh_bind w/p");
  await menu("q", PI);
  expect(await pushes("q")).toEqual({ rows: 1, menus: before.menus + 1 });
}, 30_000);

test("a slot changing agent pushes only the menus that change: none for the same agent, none to a bot pointing elsewhere", async () => {
  await start({ a: "claude", b: "claude" });
  await rhodium.ok("bind", "t", "w/b");
  await menu("q", CLAUDE);
  await menu("t", CLAUDE);
  const [q, t] = [(await pushes("q")).menus, (await pushes("t")).menus];
  await say("q", "/rh_agent claude"); // the agent it has: nothing changes, the menu neither
  await posts("q", 1);
  await say("q", "/rh_agent pi");
  await menu("q", PI);
  // A change still goes out, after every sync before it: so once this one is in, so are the others.
  await say("q", "/rh_agent claude");
  await menu("q", CLAUDE);
  expect([(await pushes("q")).menus, (await pushes("t")).menus]).toEqual([q + 2, t]);
}, 30_000);

test("a menu push the platform failed is tried again with an input once durations.menuRetry has passed, not before", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME } }, toml: '[durations]\nmenuRetry = "1500ms"' });
  await rhodium.im.connection("q", false); // the platform turns the bot's requests down
  const daemon = await rhodium.start();
  await until(() => daemon.logs.some((l) => l.msg === "menu push failed"));
  await rhodium.im.connection("q", true);
  await rhodium.ok("ls");
  await Bun.sleep(300);
  expect(await pushes("q")).toEqual({ rows: 0, menus: 0 });
  await Bun.sleep(1_500);
  await rhodium.ok("ls");
  // No slot yet to name an agent: the commands every agent has. The row goes first.
  await menu("q", PI);
  expect(await pushes("q")).toEqual({ rows: 1, menus: 1 });
}, 30_000);

test("story 327: a row push the platform failed is tried again alone, with an input once durations.menuRetry has passed; after a restart neither is", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME } }, toml: '[durations]\nmenuRetry = "1500ms"' });
  await rhodium.im.next("q", "fail", "row");
  const daemon = await rhodium.start();
  await until(() => daemon.logs.some((l) => l.msg === "menu push failed"));
  await menu("q", PI);
  await rhodium.ok("ls");
  await Bun.sleep(300);
  expect(await pushes("q")).toEqual({ rows: 0, menus: 1 });
  await Bun.sleep(1_500);
  await rhodium.ok("ls");
  await until(async () => (await pushes("q")).rows === 1);
  await rhodium.stop();
  await rhodium.start();
  await rhodium.ok("ls");
  await Bun.sleep(300);
  expect(await pushes("q")).toEqual({ rows: 1, menus: 1 });
}, 30_000);

test("story 64: /rh_ls lists every slot and its state, by workspace (docs/im-style.md §8.1)", async () => {
  await start({ a: "claude", p: "pi" });
  await say("q", "/rh_ls");
  const [text] = await posts("q", 1);
  expect(text).toBe(`2 个槽位\n\nw（${join(rhodium.dir, "w")}）\na 未运行\np 未运行（pi）\n\n这里的消息交给 w/a。点一个看详情。`);
}, 30_000);

