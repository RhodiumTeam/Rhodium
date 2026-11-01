// Changing a slot's agent, and the slot's timeline (seam one, product §4.7): /rh_agent starts a new
// conversation with the other agent; /resume lists the conversations the slot has had and those its
// directory has, and goes back to one, the slot's agent becoming that conversation's.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium whose bot q sends your private chat to the slot w/a, in its own directory. Its lists
 *  come numbered, as on QQ when there are too many for buttons (buttons.test.ts has the buttons). */
async function slot(agent = "claude", opts: InstanceOptions = {}): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a", buttons: "false" } }, ...opts });
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await rhodium.ok("ws", "w", dir);
  await rhodium.ok("new", "w/a", "--agent", agent);
  return dir;
}

/** Says text in your chat and returns the bot's reply to it. */
async function ask(text: string): Promise<string> {
  const sent = await rhodium.im.inject("q", { chat: ME, sender: ME, text });
  const reply = async () => (await rhodium.im.log("q", ME)).find((p) => p.replyTo === sent.messageId);
  await until(async () => (await reply()) !== undefined, 15_000);
  return (await reply())!.text;
}

/** The messages each run of the fake agent got: Claude's user frames, pi's prompts. */
const asked = (agent: "claude" | "pi") =>
  rhodium[agent].runs().map((r) =>
    r.stdin
      .map((l) => JSON.parse(l))
      .filter((m) => m.type === "user" || m.type === "prompt")
      .map((m) => withoutSource(m.type === "prompt" ? m.message : m.message.content[0].text)),
  );

test("story 11: /rh_agent pi makes the slot pi, starting from a new conversation; /status shows pi", async () => {
  const dir = await slot();
  expect(await ask("first")).toBe("fake reply");
  expect(await ask("/rh_agent pi")).toBe("w/a 换成了 pi，下一条消息开始新对话。");
  expect(await rhodium.ok("ls")).toMatch(/^w\/a +pi +/m);

  expect(await ask("hello")).toBe("fake reply");
  // A pi of its own, with nothing of the Claude conversation.
  expect(asked("pi")).toEqual([["hello"]]);
  expect(asked("claude")).toEqual([["first"]]);
  expect(await ask("/status")).toContain("\nAgent：Pi\n模型：");
  expect(await ask("/status")).toContain(`\n目录：${dir}`);
}, 30_000);

const sessionOf = (argv: string[]) => argv.find((a) => a.startsWith("--session-id=") || a.startsWith("--resume="))?.split("=")[1];
/** One line of the /resume list, as a bot with no buttons numbers it: ✓ on the current one, when it
 *  was last active (today, here), and what was said first (docs/im-style.md §9.6). */
const entry = (n: number, said: string, current = false) => new RegExp(`^${current ? "✓ " : ""}${n}\\. \\d\\d:\\d\\d ${said}$`);
/** The /resume list's head, the current conversation, or 新对话 where it has not begun, and its foot. */
const head = (current: boolean) => ["回到哪段对话？", ...(current ? [expect.stringMatching(/^现在：今天 \d\d:\d\d 那段$/)] : ["现在：新对话"]), ""];
const FOOT = ["", "回编号选一个。"];
const BACK = /^已回到今天 \d\d:\d\d 那段对话。/;

test("story 10: /resume with no argument lists the conversations the slot has had; /resume <number> goes back to one", async () => {
  await slot();
  await ask("first");
  const first = sessionOf(rhodium.claude.runs()[0]!.argv)!;
  await ask("/new");
  await ask("second");
  // /new left the slot on a conversation of its own, so the slot runs no agent now: none is needed.
  await ask("/new");
  expect((await ask("/resume")).split("\n")).toEqual([...head(false), expect.stringMatching(entry(1, "second")), expect.stringMatching(entry(2, "first")), ...FOOT]);
  expect(await ask("/resume 2")).toMatch(BACK);

  expect(await ask("third")).toBe("fake reply");
  const runs = rhodium.claude.runs();
  expect(runs).toHaveLength(3);
  expect(runs[2]!.argv).toContain(`--resume=${first}`);
  expect((await ask("/resume")).split("\n")).toEqual([...head(true), expect.stringMatching(entry(1, "second")), expect.stringMatching(entry(2, "first", true)), ...FOOT]);
}, 30_000);

test("story 12: going back to a Claude conversation from the timeline makes the slot Claude again", async () => {
  await slot();
  await ask("first");
  const first = sessionOf(rhodium.claude.runs()[0]!.argv)!;
  await ask("/rh_agent pi");
  await ask("hello");
  // Both agents in one list: pi's say so, up front where a narrow button can't cut it off; Claude's don't.
  expect((await ask("/resume")).split("\n")).toEqual([...head(true), expect.stringMatching(/^✓ 1\. \d\d:\d\d（pi）hello$/), expect.stringMatching(entry(2, "first")), ...FOOT]);
  expect(await ask("/resume 2")).toMatch(/^已回到今天 \d\d:\d\d 那段对话。agent 换成了 Claude。$/);
  expect(await ask("/status")).toContain("\nAgent：Claude Code\n");

  expect(await ask("again")).toBe("fake reply");
  expect(rhodium.claude.runs()[1]!.argv).toContain(`--resume=${first}`);
  expect(asked("claude")).toEqual([["first"], ["again"]]);
  expect(asked("pi")).toEqual([["hello"]]);
}, 30_000);

test("story 509: a Codex conversation is in the /resume list by what you said first, marked as Codex's", async () => {
  await slot();
  await ask("first");
  await ask("/rh_agent codex");
  expect(await ask("hello")).toBe("fake reply");
  expect((await ask("/resume")).split("\n")).toEqual([...head(true), expect.stringMatching(/^✓ 1\. \d\d:\d\d（codex）hello$/), expect.stringMatching(entry(2, "first")), ...FOOT]);
  expect(await ask("/resume 2")).toMatch(/^已回到今天 \d\d:\d\d 那段对话。agent 换成了 Claude。$/);
}, 30_000);

/** A Claude conversation in dir that your own claude in a terminal there left, as Claude lays it out. */
function terminalClaude(dir: string, session: string, said: string): void {
  const projects = join(rhodium.home, ".claude/projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const line = { type: "user", uuid: "u1", parentUuid: null, sessionId: session, cwd: dir, timestamp: "2026-10-20T18:00:00.000Z", message: { role: "user", content: said } };
  writeFileSync(join(projects, `${session}.jsonl`), `${JSON.stringify(line)}\n`);
}

test("/resume also lists the directory's conversations the slot never had; going back to one adds it to the timeline", async () => {
  const dir = await slot("pi");
  // Its own: rhodium refuses a session some process on the machine names, as another test run's claude does.
  // Not starting with a digit: /resume 2 below would go back to it by the start of its id.
  const session = `a${crypto.randomUUID().slice(1)}`;
  terminalClaude(dir, session, "fix the login page, the one with the broken redirect");
  // A new slot's conversation has no session yet: nothing of the slot's to list.
  expect((await ask("/resume")).split("\n")).toEqual([...head(false), expect.stringMatching(entry(1, "fix the logi…")), ...FOOT]);
  expect(await ask("/resume 1")).toMatch(/^已回到今天 \d\d:\d\d 那段对话。agent 换成了 Claude。$/);
  expect(await ask("go on")).toBe("fake reply");
  expect(rhodium.claude.runs()[0]!.argv).toContain(`--resume=${session}`);
  expect((await ask("/resume")).split("\n")).toEqual([...head(true), expect.stringMatching(entry(1, "fix the logi…", true)), ...FOOT]);
  expect(await ask("/resume 2")).toBe("/resume 没做成。\n原因：这个槽位和目录里没有对话 2");
}, 30_000);

test("/resume with nothing to go back to says so", async () => {
  await slot();
  expect(await ask("/resume")).toBe("这个槽位还没有用过的对话，这个目录里也没有。");
}, 30_000);

/** The control requests written to the slot's first claude, by subtype. */
const controls = () =>
  rhodium.claude.runs()[0]!.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "control_request").map((m) => m.request.subtype);
const agentOf = async () => (await rhodium.ok("ls")).match(/^w\/a +(\S+) +/m)?.[1];
const texts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text);

test("/rh_agent mid-turn waits for the turn to end, its reply included, then switches (2026-10-21)", async () => {
  await slot("claude", { claude: { script: { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("slow reply"), { goto: 0 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "take your time" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi")).toBe("w/a 这一回合还没跑完，跑完就换成 pi，下一条消息开始新对话。");
  expect(await agentOf()).toBe("claude");
  await until(async () => (await agentOf()) === "pi", 15_000);
  expect(await texts()).toContain("slow reply");
  expect(controls()).not.toContain("interrupt");
  expect(await ask("hello")).toBe("fake reply");
  expect(asked("pi")).toEqual([["hello"]]);
}, 30_000);

test("/rh_agent back to the agent the slot has, while a switch waits for the turn, calls the switch off", async () => {
  await slot("claude", { claude: { script: { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("slow reply"), { goto: 0 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "take your time" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi")).toStartWith("w/a 这一回合还没跑完，跑完就换成 pi");
  expect(await ask("/rh_agent claude")).toBe("w/a 不换成 pi 了，还是 Claude。");
  await until(async () => (await texts()).includes("slow reply"), 15_000);
  expect(await ask("hello")).toBe("slow reply");
  expect(await agentOf()).toBe("claude");
  expect(asked("claude")).toEqual([["take your time", "hello"]]);
  expect(asked("pi")).toEqual([]);
}, 30_000);

test("/rh_agent ! cuts the turn short, then switches; what you send meanwhile goes to the new agent (2026-10-21)", async () => {
  await slot("claude", { claude: { script: "until-interrupted" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work until stopped" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi !")).toBe("已打断 w/a 这一回合，停下就换成 pi，下一条消息开始新对话。");
  expect(await ask("for pi")).toBe("fake reply");
  expect(controls()).toContain("interrupt");
  expect(await agentOf()).toBe("pi");
  expect(asked("pi")).toEqual([["for pi"]]);
  expect(asked("claude")).toEqual([["work until stopped"]]);
}, 30_000);

test("/rh_agent mid-turn comes with a button that cuts the turn short and switches at once, as /rh_agent ! does (2026-10-21)", async () => {
  await slot("claude", { claude: { script: "until-interrupted" }, bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work until stopped" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  const sent = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/rh_agent pi" });
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.replyTo === sent.messageId), 15_000);
  const reply = (await rhodium.im.log("q", ME)).find((p) => p.replyTo === sent.messageId)!;
  expect(reply.buttons).toEqual([{ label: "打断，马上换", data: "/rh_agent pi !" }]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "", button: { data: reply.buttons![0]!.data, message: reply.messageId } });
  await until(async () => (await texts()).includes("已打断 w/a 这一回合，停下就换成 pi，下一条消息开始新对话。"), 15_000);
  expect(controls()).toContain("interrupt");
  await until(async () => (await agentOf()) === "pi", 15_000);
}, 30_000);

test("rh stop while /rh_agent waits for the turn switches the slot all the same; your next message goes to the new agent (2026-10-21)", async () => {
  await slot("claude", { claude: { script: "until-interrupted" } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work until stopped" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi")).toStartWith("w/a 这一回合还没跑完，跑完就换成 pi");
  await rhodium.ok("stop", "w/a");
  await until(async () => (await agentOf()) === "pi", 15_000);
  expect(await ask("hello")).toBe("fake reply");
  expect(asked("pi")).toEqual([["hello"]]);
  expect(asked("claude")).toEqual([["work until stopped"]]);
}, 30_000);

test("your message while rh stop is still ending the turn /rh_agent waits for goes to the new agent alone, started once (2026-10-21)", async () => {
  // The turn runs for a minute and the agent ignores TERM: the stop takes stopGrace, then KILL.
  await slot("claude", { claude: { script: { on, steps: [{ ignore: "SIGTERM" }, ...startTurn, { sleep: 60_000 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi")).toStartWith("w/a 这一回合还没跑完，跑完就换成 pi");
  await rhodium.ok("stop", "w/a");
  // The reply is the new agent's: a second start of it would fail on the first, and that failure would reply.
  expect(await ask("hello")).toBe("fake reply");
  // It came while the agent was stopping.
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT reason FROM inbound WHERE text = 'hello'").all()).toEqual([{ reason: "正在停止，停完再起进程" }]);
  db.close();
  expect(await agentOf()).toBe("pi");
  expect(asked("pi")).toEqual([["hello"]]);
  expect(asked("claude")).toEqual([["work"]]);
}, 30_000);

test("the agent crashing while /rh_agent waits for its turn is not resumed: the slot switches to the new agent (2026-10-21)", async () => {
  // The turn crashes 3 s in.
  await slot("claude", { claude: { script: { on, steps: [...startTurn, { sleep: 3000 }, { exit: 1 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  expect(await ask("/rh_agent pi")).toStartWith("w/a 这一回合还没跑完，跑完就换成 pi");
  await until(async () => (await texts()).some((t) => t.includes("w/a 崩溃了")), 15_000);
  expect((await texts()).find((t) => t.includes("w/a 崩溃了"))).toContain("\n它换成了 pi，下一条消息开始新对话。\n");
  expect(await agentOf()).toBe("pi");
  await Bun.sleep(500); // a resume would have started by now
  expect(rhodium.claude.runs()).toHaveLength(1);
  expect(await ask("hello")).toBe("fake reply");
  expect(asked("pi")).toEqual([["hello"]]);
}, 30_000);

test("every agent the slot moves away from is on record as exited once it is gone, so rh doctor finds no holder lost (2026-10-22)", async () => {
  // As on the dev instance: /rh_agent pi, /resume back, /rh_agent pi mid-turn, /resume back, the
  // switch button mid-turn. Each move stops the agent the slot leaves; its exit comes after the move.
  await slot("claude", { claude: { script: { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("slow reply"), { goto: 0 }] } } });
  const turn = async (text: string) => {
    await rhodium.im.inject("q", { chat: ME, sender: ME, text });
    await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  };
  await turn("first");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const claude = sessionOf(rhodium.claude.runs()[0]!.argv)!;
  expect(await ask("/rh_agent pi")).toBe("w/a 换成了 pi，下一条消息开始新对话。");
  expect(await ask("hello")).toBe("fake reply");
  expect(await ask(`/resume ${claude}`)).toMatch(/agent 换成了 Claude。$/);
  await turn("take your time");
  expect(await ask("/rh_agent pi")).toStartWith("w/a 这一回合还没跑完，跑完就换成 pi");
  await until(async () => (await agentOf()) === "pi", 15_000);
  expect(await ask("for pi")).toBe("fake reply");
  expect(await ask(`/resume ${claude}`)).toMatch(/agent 换成了 Claude。$/);
  await turn("again");
  expect(await ask("/rh_agent pi !")).toStartWith("已打断 w/a 这一回合，停下就换成 pi");
  await until(async () => (await agentOf()) === "pi", 15_000);

  await until(async () => (await rhodium.units()).length === 0, 15_000);
  expect((await rhodium.ok("doctor")).split("\n").filter((l) => l.includes("托管进程"))).toEqual([]);
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT conversation FROM holder WHERE exited = 0").all()).toEqual([]);
  db.close();
}, 60_000);

test("rh agent ! while the slot is still starting has no turn to cut short yet: it says to send it again shortly (2026-10-21)", async () => {
  // Claude reads your message only 1.5 s after it starts.
  await slot("claude", { claude: { script: { on, steps: [{ sleep: 1500 }, ...startTurn, ...endTurn("done"), { goto: 1 }] } } });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hi" });
  await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
  expect(await ask("/rh_agent pi !")).toBe("w/a 还在启动，过几秒再发 /rh_agent pi !。");
  expect(await rhodium.rh(["agent", "w/a", "pi", "!"])).toMatchObject({ code: 1, err: "rh: w/a 还在启动，过几秒再发 /rh_agent pi !。\n" });
  await until(async () => (await texts()).includes("done"), 15_000);
  expect(await agentOf()).toBe("claude");
}, 30_000);

test("rh agent from your terminal does what /rh_agent does; /rh-agent works too; an agent Rhodium does not run is refused", async () => {
  await slot();
  expect(await rhodium.ok("agent", "w/a", "pi")).toBe("已把 w/a 换成 pi，下一条消息开始一段新对话。\n");
  expect(await rhodium.ok("ls")).toMatch(/^w\/a +pi +/m);
  expect(await rhodium.rh(["agent", "w/a", "gemini"])).toMatchObject({ code: 1, err: "rh: 没有叫 gemini 的 agent，可以选 claude、pi 或 codex。\n" });
  expect(await ask("/rh_agent gemini")).toBe("没有叫 gemini 的 agent，可以选 claude、pi 或 codex。");
  expect(await ask("/rh_agent")).toStartWith("w/a 换哪个 agent？\n现在：pi\n");
  expect(await ask("/rh-agent claude")).toBe("w/a 换成了 Claude，下一条消息开始新对话。");
  expect(await ask("hello")).toBe("fake reply");
  expect(rhodium.pi.runs()).toEqual([]);
  expect(asked("claude")).toEqual([["hello"]]);
}, 30_000);
