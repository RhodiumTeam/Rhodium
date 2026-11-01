// rh rename and /rh_rename (issue #212), seen from seam one: a slot takes a new name in its workspace,
// and what goes to it by id goes on as before; a bot's target in the config file follows it. As in
// confirm.test.ts the fake claude makes the rh calls its message lists.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { Run, Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Instance } from "./instance";

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
const plan = (...calls: string[][]) => JSON.stringify(calls);

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

const say = (text: string, bot = "q") => rhodium.im.inject(bot, { chat: ME, sender: ME, text });
/** The texts the bot has posted to you, once there are at least n. */
async function texts(n: number, bot = "q"): Promise<string[]> {
  await until(async () => (await rhodium.im.log(bot, ME)).length >= n, 15_000);
  return (await rhodium.im.log(bot, ME)).map((p) => p.text);
}
/** The agent runs given a message, oldest first. */
const runs = (): Run[] => rhodium.claude.runs().filter((r) => r.stdin.some((l) => JSON.parse(l).type === "user"));
/** The texts of the user frames the agents were given, over all their runs. */
const told = () => runs().flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user").map((m) => withoutSource(m.message.content[0].text)));
const listed = async () => (await rhodium.ok("ls")).trim().split("\n").map((l) => l.split(/ +/)[0]);

test("rh rename gives a slot a new name in its workspace; the bot whose config target it is follows it there, after a restart too, with the config backed up first", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  const daemon = await rhodium.start();
  await rhodium.slots("a", "b");
  await say("first");
  await texts(1);
  const before = readFileSync(rhodium.config, "utf8");

  const out = await rhodium.ok("rename", "w/a", "x");
  const backup = out.match(/备份在 (\S+)。/)?.[1];
  expect(out.trim()).toBe(`已把 w/a 改名为 w/x。配置文件里 Bot q 的 target 也跟着改了，改之前的备份在 ${backup}。`);
  expect(readFileSync(rhodium.config, "utf8")).toBe(before.replace('target = "w/a"', 'target = "w/x"'));
  expect(readFileSync(backup!, "utf8")).toBe(before);
  expect(await listed()).toEqual(["w/x", "w/b"]);
  const board = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  const ws = (await (await fetch(`${board}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()).workspaces.find((w: any) => w.name === "w");
  expect(Object.values(ws.groups as Record<string, { name: string }[]>).flat().map((c) => c.name).sort()).toEqual(["b", "x"]);

  // The same slot: your messages go on to it, and none to w/b.
  await say("second");
  await texts(2);
  await rhodium.stop();
  await rhodium.start();
  await say("third");
  await texts(3);
  expect(told()).toEqual(["first", "second", "third"]);
  expect(runs().every((r) => r.env.RHODIUM_SLOT !== "w/b")).toBe(true);
}, 60_000);

test("rh rename refuses a name taken in the workspace, one that is no name, and another workspace; the name it has changes nothing", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  const before = readFileSync(rhodium.config, "utf8");
  expect(await rhodium.rh(["rename", "w/a", "b"])).toMatchObject({ code: 1, err: "rh: 工作区 w 里已经有槽位 b。\n" });
  expect(await rhodium.rh(["rename", "w/a", "a b"])).toMatchObject({ code: 1, err: "rh: 槽位名字只能由文字、数字和 _ . - 组成，不超过 64 个字符：a b\n" });
  expect(await rhodium.rh(["rename", "w/a", "v/c"])).toMatchObject({ code: 1, err: "rh: 只能在同一个工作区里改名，新名字只写槽位名，例如 rh rename w/a c。\n" });
  expect(await rhodium.rh(["rename", "w/zz", "c"])).toMatchObject({ code: 1, err: "rh: 没有槽位 w/zz。\n" });
  expect((await rhodium.ok("rename", "w/a", "a")).trim()).toBe("w/a 本来就叫 a，没有改动。");
  expect(await listed()).toEqual(["w/a", "w/b"]);
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
  // A target that names it in a way other than "w/a" on a line of its own is left alone, and so is the slot.
  const escaped = before.replace('target = "w/a"', 'target = "w\\u002Fa"');
  writeFileSync(rhodium.config, escaped);
  expect(await rhodium.rh(["rename", "w/a", "c"])).toMatchObject({
    code: 1,
    err: 'rh: 没有改名：配置文件改不了，Bot q 的 target 不是单独一行 target = "w/a" 的写法，没法只改引号里的名字。\n',
  });
  expect(readFileSync(rhodium.config, "utf8")).toBe(escaped);
  expect(await listed()).toEqual(["w/a", "w/b"]);
  writeFileSync(rhodium.config, before);
  // A slot no bot's config target names: the config is left alone.
  expect((await rhodium.ok("rename", "w/b", "c")).trim()).toBe("已把 w/b 改名为 w/c。");
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

test("an agent renames its own slot at once, and asks you to rename another; once you agree it is done, to that slot though you renamed it meanwhile", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } }, claude: { script: obey } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  const before = readFileSync(rhodium.config, "utf8");
  await say(plan(["rename", "w/a", "a2"], ["rename", "w/b", "c"]));
  await until(() => runs().flatMap((r) => r.rh).length >= 2, 15_000);
  const [own, other] = runs().flatMap((r) => r.rh);
  expect([own!.code, own!.out.trim()]).toEqual([0, "已把 w/a 改名为 w/a2。配置文件里 Bot q 的 target 也跟着改了，改之前的备份在 " + own!.out.match(/备份在 (\S+)。/)?.[1] + "。"]);
  expect(other!.out.trim()).toStartWith("已请用户确认：rh rename w/b c。");
  expect(await texts(2)).toEqual(["done", "w/a2 想把 w/b 改名为 c。\n\n命令：rh rename w/b c\n回别的话算拒绝，并转告 w/a2。"]);
  expect(await listed()).toEqual(["w/a2", "w/b"]);
  // Asking changed nothing yet: w/b's line is as it was.
  expect(readFileSync(rhodium.config, "utf8")).toBe(before.replace('target = "w/a"', 'target = "w/a2"'));

  // Renamed meanwhile, and its old name taken by another: what you agree to is done to the slot it asked about.
  await rhodium.ok("rename", "w/b", "d");
  await rhodium.ok("new", "w/b");
  await say("1");
  await until(async () => (await listed()).includes("w/c"), 15_000);
  expect(await listed()).toEqual(["w/a2", "w/c", "w/b"]);
  expect(readFileSync(rhodium.config, "utf8")).toBe(before.replace('target = "w/a"', 'target = "w/a2"').replace('target = "w/b"', 'target = "w/c"'));
}, 30_000);

test("/rh_rename renames the slot this chat goes to, or the one named first; with no name it says how", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await say("/rh_rename");
  expect((await texts(1))[0]).toBe("/rh_rename 后面写新名字，例如 /rh_rename new-name；改别的槽位，先写槽位，例如 /rh_rename w/a new-name。");
  await say("/rh_rename x");
  expect((await texts(2))[1]).toStartWith("已把 w/a 改名为 w/x。配置文件里 Bot q 的 target 也跟着改了");
  await say("/rh_rename b c");
  expect((await texts(3))[2]).toBe("已把 w/b 改名为 w/c。");
  await say("/rh_rename w/c x");
  expect((await texts(4))[3]).toBe("工作区 w 里已经有槽位 x。");
  expect(await listed()).toEqual(["w/x", "w/c"]);
}, 30_000);

test("a confirm request whose caller is renamed before it is pushed to you says who asked by the new name", async () => {
  // The rh calls, then the turn waits for your next message: the request waits for the turn's reply.
  const held: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, { wait: { type: "user" } }, ...endTurn("done"), { goto: 0 }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: held } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await say(plan(["archive", "w/b"]));
  await until(() => runs().flatMap((r) => r.rh).length === 1, 15_000);
  await rhodium.ok("rename", "w/a", "x");
  await say("go on");
  expect(await texts(2)).toEqual(["done", "w/x 想归档 w/b。\n对话留着，发消息就恢复。\n\n命令：rh archive w/b\n回别的话算拒绝，并转告 w/x。"]);
}, 30_000);
