// A pi slot end to end (seam one): how rhodium launches pi, its approval extension, and the
// commands that only pi's driver sends (architecture §6.3). The format the commands answer in is
// checked for both agents in commands.test.ts.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Posted } from "../src/fake-im";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

async function ok(...args: string[]): Promise<string> {
  const r = await rhodium.rh(args);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  return r.out;
}

/** A rhodium whose bot q sends your private chat to the pi slot w/a; env is added to rhodium's own. */
async function slot(env: Record<string, string> = {}, opts: InstanceOptions = {}): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, ...opts });
  Object.assign(rhodium.env, env);
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await ok("ws", "w", dir);
  await ok("new", "w/a", "--agent", "pi");
  return dir;
}

const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });

/** Waits until the bot has posted n messages in your chat, and returns them. */
async function posts(n = 1): Promise<Posted[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return rhodium.im.log("q", ME);
}

/** What each run of the fake pi was sent, parsed. */
const sent = () => rhodium.pi.runs().map((r) => r.stdin.map((l) => JSON.parse(l)));
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

test("story 13: pi runs in rpc mode on the configured PATH, with nothing of your Claude login in its arguments or environment", async () => {
  await slot({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_OAUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "t", DEEPSEEK_API_KEY: "sk-ds" });
  await say("hello");
  expect((await posts())[0]!.text).toBe("fake reply");

  const [run, ...more] = rhodium.pi.runs();
  expect(more).toEqual([]);
  expect(rhodium.claude.runs()).toEqual([]);
  expect(run!.argv.slice(0, 3)).toEqual(["--mode", "rpc", "--session-id"]);
  expect(flag(run!.argv, "--append-system-prompt")).toStartWith(join(rhodium.dir, "state"));
  expect(run!.argv).not.toContain("-e"); // approval mode is off by default
  expect(Object.keys(run!.env).filter((k) => /^(ANTHROPIC|CLAUDE)/.test(k))).toEqual([]);
  expect(run!.env.DEEPSEEK_API_KEY).toBe("<redacted>"); // pi's own key does reach it
  expect(run!.env.PATH).toBe(rhodium.env.PATH!); // agentPath defaults to rhodium's PATH
}, 30_000);

test("with approval mode on, pi loads Rhodium's approval extension", async () => {
  await slot();
  await ok("set", "w/a", "approval=on");
  await say("hello");
  await posts();
  const extension = flag(rhodium.pi.runs()[0]!.argv, "-e");
  expect(extension).toBe(join(rhodium.dir, "state/pi/rhodium-approval.ts"));
  expect(readFileSync(extension!, "utf8")).toBe(readFileSync(join(import.meta.dir, "../src/pi-approval.ts"), "utf8"));
}, 30_000);

test("a pi start that cannot write the approval extension is a crash of that slot, not of rhodium", async () => {
  await slot();
  await ok("set", "w/a", "approval=on");
  // A file where the extension's directory goes, as a full disk or a wrong permission would fail it.
  writeFileSync(join(rhodium.dir, "state/pi"), "");
  await say("hello");
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);
  expect((await posts())[0]!.text).toContain("w/a 崩溃了");
  rmSync(join(rhodium.dir, "state/pi"));
  await say("again");
  expect((await posts(2))[1]!.text).toBe("fake reply");
}, 30_000);

test("/model and /effort switch with pi's own commands; a level pi does not offer is never sent", async () => {
  await slot();
  await say("hello");
  await posts(1);
  for (const [i, command] of ["/model 2", "/effort high", "/effort bogus"].entries()) {
    await say(command);
    await posts(i + 2);
  }
  const switches = sent()[0]!.filter((c) => c.type === "set_model" || c.type === "set_thinking_level");
  expect(switches.map(({ id, ...c }) => c)).toEqual([
    { type: "set_model", provider: "fake", modelId: "pi-other" },
    { type: "set_thinking_level", level: "high" },
  ]);
}, 30_000);

test("/resume <id> goes back to an earlier pi conversation of the slot; the next message opens it", async () => {
  await slot();
  await say("first");
  await posts(1);
  const first = flag(rhodium.pi.runs()[0]!.argv, "--session-id")!;
  await say("/new");
  await say("second");
  await posts(3);
  expect(flag(rhodium.pi.runs()[1]!.argv, "--session-id")).not.toBe(first);

  // Any unique start of the id will do.
  const back = await say(`/resume ${first.slice(0, 8)}`);
  expect((await posts(4))[3]).toMatchObject({ text: expect.stringMatching(/^已回到今天 \d\d:\d\d 那段对话。$/), replyTo: back.messageId });
  await say("third");
  expect((await posts(5))[4]!.text).toBe("fake reply");
  const [, , again, ...more] = rhodium.pi.runs();
  expect(more).toEqual([]);
  expect(flag(again!.argv, "--session-id")).toBe(first);
  // The fake pi kept the session in one file, as pi does: both visits are in it.
  const sessions = join(rhodium.home, ".pi/agent/sessions");
  const [dir] = readdirSync(sessions);
  const file = readdirSync(join(sessions, dir!)).find((f) => f.endsWith(`_${first}.jsonl`))!;
  const texts = [...readFileSync(join(sessions, dir!, file), "utf8").matchAll(/"text":("(?:[^"\\]|\\.)*")/g)];
  expect(texts.map((m) => withoutSource(JSON.parse(m[1]!)))).toEqual(["first", "fake reply", "third", "fake reply"]);
}, 30_000);

/** A pi session "from-terminal" in dir, as your own pi in a terminal there leaves it. */
function terminalSession(dir: string) {
  const sessions = join(rhodium.home, ".pi/agent/sessions", `--${dir.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(sessions, { recursive: true });
  const header = { type: "session", version: 3, id: "from-terminal", timestamp: "2026-10-20T18:00:00.000Z", cwd: dir };
  const typed = { type: "message", id: "e1", parentId: null, timestamp: "2026-10-20T18:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
  writeFileSync(join(sessions, "2026-10-20T18-00-00-000Z_from-terminal.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(typed)}\n`);
}

test("/resume <id> also takes a pi conversation of the directory that Rhodium never ran, say one from your terminal", async () => {
  terminalSession(await slot());
  await say("first");
  await posts(1);
  await say("/resume from-terminal");
  expect((await posts(2))[1]!.text).toMatch(/^已回到(今天 \d\d:\d\d|昨天 \d\d:\d\d|\d\d\/\d\d \d\d:\d\d|\d{4}\/\d\d\/\d\d) 那段对话。$/);
  await say("second");
  await posts(3);
  expect(rhodium.pi.runs().map((r) => flag(r.argv, "--session-id"))).toEqual([expect.any(String), "from-terminal"]);
  expect(await ok("ls")).toMatch(/^w\/a +pi +/m);
}, 30_000);

test("/resume while a turn runs says so and leaves the turn alone", async () => {
  terminalSession(await slot({}, { pi: { script: "pi-until-interrupted" } }));
  await say("first");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/resume from-terminal");
  expect((await posts())[0]!.text).toBe("/resume 没做成。\n原因：回合还在进行，先 /stop 再 /resume");
  expect(await rhodium.state("w/a")).toBe("运行中");
  expect(rhodium.pi.runs()).toHaveLength(1);
}, 30_000);

test("/resume of a conversation another slot is on is refused: two pi would write one session file", async () => {
  // Bot r sends your private chat to w/b, a second pi slot in the same directory.
  await slot({}, { bots: { q: { like: "qq", owner: ME, target: "w/a" }, r: { like: "qq", owner: ME, target: "w/b" } } });
  await ok("new", "w/b", "--agent", "pi");
  await say("first");
  await posts(1);
  const first = flag(rhodium.pi.runs()[0]!.argv, "--session-id")!;
  const toB = (text: string) => rhodium.im.inject("r", { chat: ME, sender: ME, text });
  const fromB = async (n: number) => (await until(async () => (await rhodium.im.log("r", ME)).length >= n, 15_000), rhodium.im.log("r", ME));
  await toB("hello");
  await fromB(1);
  await toB(`/resume ${first}`);
  expect((await fromB(2))[1]!.text).toBe("/resume 没做成。\n原因：w/a 正在用这段对话");
  await toB("again");
  await fromB(3);
  expect(rhodium.pi.runs().map((r) => flag(r.argv, "--session-id"))).toEqual([first, expect.not.stringMatching(first)]);
}, 30_000);

test("/resume of a conversation this directory does not have says so and changes nothing", async () => {
  await slot();
  await say("first");
  await posts(1);
  await say("/resume nosuch");
  expect((await posts(2))[1]!.text).toBe("/resume 没做成。\n原因：这个槽位和目录里没有对话 nosuch");
  await say("again");
  await posts(3);
  expect(rhodium.pi.runs()).toHaveLength(1);
}, 30_000);
