// /rh_import (stories 19-21, 161), seen from seam one: a fake Herdr session stands in for yours, and
// the conversations on disk are copies of real transcripts (test/fixtures/transcripts/), moved to a
// directory of the test's own. As in tui.test.ts the fake claude does what its message says: the
// message is a list of rh calls.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir, type Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { call } from "./fake-herdr/fake-herdr";
import { newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
const FIXTURES = join(import.meta.dir, "fixtures/transcripts");
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** An instance with a fake Herdr, whose bot q (and a Telegram-like t) go to w/a; started, with the slot w/a made. */
async function begin(opts: InstanceOptions = {}): Promise<Instance> {
  const bots = { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } as const;
  rhodium = newInstance({ bots, claude: { script: obey }, herdr: true, ...opts });
  await rhodium.start();
  await rhodium.slots("a");
  return rhodium;
}

const texts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text);
/** Waits until the bot has posted n messages containing what, and returns the last. */
async function posted(what: string, n = 1): Promise<string> {
  await until(async () => (await texts()).filter((t) => t.includes(what)).length >= n, 15_000);
  return (await texts()).filter((t) => t.includes(what)).at(-1)!;
}
const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const herdr = async (method: string, params: object = {}) => (await call(rhodium.herdr.socket, method, params)).result;

/** A directory of the test's own, as one of your projects. */
function project(name: string): string {
  const dir = join(rhodium.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Puts a copy of the agent's real transcript under the sandbox HOME, where the agent keeps those of
 *  conversations started in dir, with the directory it records changed to dir, and a session id of
 *  its own: one no other test's process names, as a check for one that uses it looks at them all.
 *  Codex keeps its own by the day they began, in CODEX_HOME. Returns that session id. */
function copyTranscript(agent: "claude" | "pi" | "codex", dir: string): string {
  const [file] = readdirSync(join(FIXTURES, agent));
  const text = readFileSync(join(FIXTURES, agent, file!), "utf8");
  const id = agent === "codex" ? JSON.parse(text.slice(0, text.indexOf("\n"))).payload.id : file!.replace(/\.jsonl$/, "").replace(/^[^_]*_/, "");
  const session = crypto.randomUUID();
  const copy = text.replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(dir)}`).replaceAll(id, session);
  const [into, name] =
    agent === "claude"
      ? [join(rhodium.home, ".claude/projects", claudeProjectDir(dir)), `${session}.jsonl`]
      : agent === "pi"
        ? [join(rhodium.home, ".pi/agent/sessions", `--${dir.replace(/^\//, "").replace(/\//g, "-")}--`), file!.replace(id, session)]
        : [join(rhodium.home, ".codex/sessions/2026/10/27"), `rollout-2026-10-27T16-34-11-${session}.jsonl`];
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, name), copy);
  return session;
}

test("story 19: /rh_import takes over a conversation on disk as a slot in the directory it was started in, and the chat goes on with it", async () => {
  await begin();
  const dir = project("proj");
  const session = copyTranscript("claude", dir);
  const short = session.slice(0, 8);

  await say(`/rh_import ${short}`);
  expect(await posted("已导入")).toBe(`已导入成 proj/${short}，接着那段对话。这里的消息改交给它。`);
  expect(await rhodium.ok("ls")).toMatch(new RegExp(`^proj/${short} +claude +无头 +未运行 +${dir}$`, "m"));

  // The chat goes to it now: your next message resumes that conversation, there.
  await say("carry on");
  await posted("done");
  const run = rhodium.claude.runs().at(-1)!;
  expect(run.argv).toContain(`--resume=${session}`);
  expect(run.cwd).toBe(dir);
  expect(run.env.RHODIUM_SLOT).toBe(`proj/${short}`);
}, 30_000);

test("a conversation imported from disk is not resumed while another process has taken it up since: you hear why, and your message goes once it lets go", async () => {
  await begin();
  const dir = project("proj");
  const session = copyTranscript("claude", dir);
  const ref = `proj/${session.slice(0, 8)}`;
  await say(`/rh_import ${session}`);
  await posted("已导入");

  // You resumed it by hand in a terminal of your own after the import.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    await say("carry on");
    expect(await posted("正在用这段对话")).toBe(`${ref} 没能启动，这段对话别处正在用。那边退出后再发一条消息，等着的消息会一起交给它。\n原因：另一个进程正在用这段对话`);
    expect(rhodium.claude.runs()).toHaveLength(0);
    expect(await rhodium.state(ref)).toBe("未运行");
  } finally {
    other.kill();
    await other.exited;
  }
  await say("now?");
  await posted("done");
  const [run, ...more] = rhodium.claude.runs();
  expect(more).toEqual([]);
  expect(run!.argv).toContain(`--resume=${session}`);
  expect(run!.stdin.join("\n")).toContain("carry on");
}, 30_000);

test("an import asked for by a caller rh cannot recognize is answered, once you agree, in the chat you agreed in, also when it fails", async () => {
  await begin({ toml: `mainChat = "q/${ME}"` });
  const dir = project("proj");
  const session = copyTranscript("claude", dir);
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    expect((await rhodium.rh(["import", session], { tty: false, cwd: dir })).out).toStartWith(`已请用户确认：rh import ${session}。`);
    await posted("命令：rh import");
    await say("1");
    expect(await posted("没能导入")).toBe("没能导入。\n原因：另一个进程正在用这段对话");
  } finally {
    other.kill();
    await other.exited;
  }
}, 30_000);

test("story 19: rh import takes over a pi conversation on disk as a pi slot, which resumes it in its directory", async () => {
  await begin();
  const dir = project("pi-proj");
  const session = copyTranscript("pi", dir);
  const ref = `pi-proj/${session.slice(0, 8)}`;
  expect(await rhodium.ok("import", session)).toContain(`已导入成 ${ref}：pi 的对话，目录 ${dir}。`);
  await rhodium.ok("send", ref, "hi");
  await until(() => rhodium.pi.runs().length === 1, 15_000);
  const [run] = rhodium.pi.runs();
  expect(run!.argv).toEqual(expect.arrayContaining(["--session-id", session]));
  expect(run!.cwd).toBe(dir);
}, 30_000);

test("story 508: rh import takes over a Codex thread on disk as a Codex slot in the directory it began in, which resumes the thread there", async () => {
  await begin();
  const dir = project("cx-proj");
  const thread = copyTranscript("codex", dir);
  const ref = `cx-proj/${thread.slice(0, 8)}`;
  expect(await rhodium.ok("import", thread.slice(0, 8))).toContain(`已导入成 ${ref}：codex 的对话，目录 ${dir}。`);
  await rhodium.ok("send", ref, "hi");
  await until(() => rhodium.codex.runs().some((r) => r.stdin.some((l) => l.includes('"turn/start"'))), 15_000);
  const [run] = rhodium.codex.runs();
  expect(run!.cwd).toBe(dir);
  const sent = run!.stdin.map((l) => JSON.parse(l));
  expect(sent.find((m) => m.method === "thread/resume")?.params.threadId).toBe(thread);
  expect(sent.filter((m) => m.method === "thread/start")).toEqual([]);
}, 30_000);

test("story 508: a Codex pane is not imported: Codex is imported from disk alone", async () => {
  await begin();
  const dir = project("proj");
  const thread = copyTranscript("codex", dir);
  // Your own codex in a pane, which Herdr's hook reported once a turn ran.
  const ws = await herdr("workspace.create", { cwd: dir, label: "mine" });
  const pane = ws.root_pane.pane_id;
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:codex", agent: "codex", agent_session_id: thread });
  const slots = await rhodium.ok("ls");
  const r = await rhodium.rh(["import", pane]);
  expect([r.code, r.err.trim()]).toEqual([1, "rh: 没能导入。\n原因：Codex 只能从磁盘导入：rh import <线程 ID>"]);
  expect(await rhodium.ok("ls")).toBe(slots);
}, 30_000);

test("story 508: /rh_import lists the directory's Codex threads with the rest, marked as Codex's", async () => {
  // Numbered, as on QQ when there are too many for buttons: the whole of each label.
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a", buttons: "false" } } });
  const dir = project("proj");
  const [mine, claude, codex] = [copyTranscript("claude", dir), copyTranscript("claude", dir), copyTranscript("codex", dir)];
  expect((await rhodium.rh(["import"], { cwd: dir, tty: false })).out).toContain(`rh import ${codex.slice(0, 8)}  codex  `);
  await rhodium.ok("import", mine, "--name", "mine");
  await say("/rh_use proj/mine");
  await say("/rh_import");
  const listed = (await posted("导入哪一个？")).split("\n");
  expect(listed.filter((l) => /^\d\. /.test(l))).toEqual([
    expect.stringMatching(new RegExp(`^1\\. ${dir} \\d\\d:\\d\\d（codex）Run the …$`)),
    expect.stringMatching(new RegExp(`^2\\. ${dir} \\d\\d:\\d\\d Use the …$`)),
  ]);
}, 30_000);

test("importing a conversation from disk is refused while another process or a Herdr pane uses it, or a slot has it already", async () => {
  await begin();
  const dir = project("proj");
  const session = copyTranscript("claude", dir);
  /** Refused for why, and no slot made for it. */
  const refused = async (why: string) => {
    const slots = await rhodium.ok("ls");
    const r = await rhodium.rh(["import", session]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("没能导入");
    expect(r.err).toContain(why);
    expect(await rhodium.ok("ls")).toBe(slots);
  };

  // Say you resumed it by hand in a terminal of your own.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    await refused("另一个进程正在用这段对话");
  } finally {
    other.kill();
    await other.exited;
  }
  // Or a Herdr pane reports it.
  const ws = await herdr("workspace.create", { cwd: dir, label: "mine" });
  const pane = ws.root_pane.pane_id;
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: session });
  await refused("Herdr 里另一个 pane 正在用这段对话");
  await herdr("tab.close", { tab_id: ws.tab.tab_id });

  // Free now; once a slot has it, it is that slot's: at your terminal, said the rh way.
  expect(await rhodium.ok("import", session, "--name", "mine")).toContain("已导入成 proj/mine");
  await refused("没能导入，这段对话是 proj/mine 用过的。要接着用，先 rh use <Bot>/<窗口 ID> proj/mine，再在那个窗口发 /resume 选它。");
}, 30_000);

test("stories 19, 20: a conversation a slot ever had is not imported again, by its id or from a pane, though the slot moved on or is archived; you hear whose it is and how to go back to it", async () => {
  await begin();
  const dir = project("proj");
  const old = copyTranscript("claude", dir);
  await rhodium.ok("import", old, "--name", "x");
  await say("/rh_use proj/x");
  await say("/new");
  await posted("已开一段新对话。");
  const refs = async () => (await rhodium.ok("ls", "--all")).split("\n").map((l) => l.split(" ")[0]);
  const slots = await refs();

  await say(`/rh_import ${old}`);
  expect(await posted("没能导入")).toBe("没能导入，这段对话是 proj/x 用过的。要接着用，先 /rh_use proj/x，再发 /resume 选它。");
  // A pane of yours goes on with it: quit it there first, as one process at a time may have it.
  await rhodium.ok("archive", "proj/x");
  const pane = (await herdr("workspace.create", { cwd: dir, label: "mine" })).root_pane.pane_id;
  await herdr("pane.send_input", { pane_id: pane, text: `claude --resume ${old}`, keys: ["enter"] });
  await until(async () => (await herdr("pane.get", { pane_id: pane })).pane.agent_session?.value === old, 15_000);
  await say(`/rh_import ${pane}`);
  expect(await posted("没能导入", 2)).toBe("没能导入，这段对话是 proj/x 用过的。要接着用，先在 pane 里退出 agent，再 /rh_use proj/x，发 /resume 选它。");
  expect(await refs()).toEqual(slots);
}, 30_000);

const plan = (...calls: (string[] | { args: string[]; env: Record<string, string> })[]) => JSON.stringify(calls);
const alive = (pid: number) => existsSync(`/proc/${pid}`);
/** The claude run whose command line names the session. */
const runOf = (session: string) => rhodium.claude.runs().find((r) => r.argv.some((a) => a.includes(session)))!;

/** A tab of your own, in a Herdr workspace of its own in dir, where you start claude as you would:
 *  a child of the pane's shell. Or a pane split off the pane beside, in its tab. Resolves once
 *  Herdr reports its session. */
async function yourPane(dir: string, label: string, beside?: string) {
  const pane: string = beside
    ? (await herdr("pane.split", { target_pane_id: beside, direction: "right", cwd: dir })).pane.pane_id
    : (await herdr("workspace.create", { cwd: dir, label })).root_pane.pane_id;
  const session = crypto.randomUUID();
  await herdr("pane.send_input", { pane_id: pane, text: `claude --session-id ${session}`, keys: ["enter"] });
  await until(async () => (await herdr("pane.get", { pane_id: pane })).pane.agent_session?.value === session, 15_000);
  await until(() => runOf(session) !== undefined);
  return { pane, session, run: runOf(session) };
}
/** Types a message into the pane's agent, as you would at its prompt. */
async function typeInto(pane: string, text: string) {
  const frame = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
  await herdr("pane.send_input", { pane_id: pane, text: JSON.stringify(frame), keys: ["enter"] });
}
/** Quits the pane's agent as you would: Ctrl-C twice. */
async function quit(pane: string) {
  for (let i = 0; i < 2; i++) await herdr("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
}

test("stories 20, 161, 21: /rh_import of a Herdr pane makes its agent a slot in TUI mode and leaves your other panes alone; once you quit it there, the slot is headless and the phone carries on", async () => {
  await begin();
  const dir = project("proj");
  const mine = await yourPane(dir, "proj");
  const other = await yourPane(dir, "other");
  // Split off the one imported, in its tab.
  const beside = await yourPane(dir, "", mine.pane);
  const ref = `proj/${mine.session.slice(0, 8)}`;

  await say(`/rh_import ${mine.pane}`);
  expect(await posted("已导入")).toBe(`已导入成 ${ref}，它在 TUI 里。在 TUI 里退出 agent，它会自动切回无头，之后这里的消息交给它。`);
  expect(await rhodium.state(ref)).toBe("TUI 模式");
  // Meanwhile your messages are turned away, and no headless agent starts for them.
  await say("are you there?");
  await posted(`${ref} 在 TUI 里，这条没交给它。发 /rh_use - 改和 w/a 说，或者发 /rh_release 把它切回无头。`);
  expect(rhodium.claude.runs()).toHaveLength(3);
  // Its agent has no token: rh knows it by its process, and it reaches you as the slot (story 20).
  await typeInto(mine.pane, plan({ args: ["send", "me", "from your pane"], env: { RHODIUM_SOCKET: rhodium.socket } }));
  await posted("from your pane");

  await quit(mine.pane);
  await posted(`${ref} 切回无头了。`);
  expect(await rhodium.state(ref)).toBe("未运行");
  await say("on the phone");
  await posted("done");
  const headless = rhodium.claude.runs().at(-1)!;
  expect(headless.argv).toContain(`--resume=${mine.session}`);
  expect(headless.cwd).toBe(dir);

  // Your other panes, never imported, are as they were: their tabs, their agents, and nothing typed
  // into them; the one beside it lost only its neighbour.
  expect((await herdr("session.snapshot")).snapshot.panes.map((p: any) => p.pane_id)).toEqual([beside.pane, other.pane]);
  for (const p of [other, beside]) {
    expect(alive(p.run.pid)).toBe(true);
    expect(runOf(p.session).stdin).toEqual([]);
  }
}, 45_000);

test("a pane imported before you said a word to its claude, then released, answers from the phone, and stays on that conversation", async () => {
  await begin();
  const dir = project("notes");
  const mine = await yourPane(dir, "notes");
  const ref = "notes/QQ";
  await say(`/rh_import ${mine.pane} --name QQTest`);
  await posted("已导入");
  // The tab is yours, not one Rhodium opened: a new name for the slot leaves its name alone.
  await rhodium.ok("rename", "notes/QQTest", "QQ");
  await rhodium.ok("release", ref);
  await posted(`${ref} 切回无头了。`);
  expect((await herdr("fake.calls")).calls.map((c: any) => c.method)).not.toContain("tab.rename");

  // Claude has no transcript of it yet: it was never said anything.
  await say("你好");
  await posted("done");
  expect(rhodium.claude.runs().at(-1)!.argv).toContain(`--session-id=${mine.session}`);
  // Once it has one, a new process resumes it.
  await rhodium.ok("stop", ref);
  await say("还在吗");
  await posted("done", 2);
  expect(rhodium.claude.runs().at(-1)!.argv).toContain(`--resume=${mine.session}`);
}, 45_000);

test("rh import alone lists what there is to import: the agents in your Herdr panes, and the conversations on disk started in the directory, but for those a slot has", async () => {
  await begin();
  const dir = project("proj");
  const claude = copyTranscript("claude", dir);
  const pi = copyTranscript("pi", dir);
  const yours = await yourPane(dir, "proj");
  const list = async () => (await rhodium.rh(["import"], { cwd: dir, tty: false })).out; // reading it needs no say-so

  const shown = await list();
  expect(shown).toContain(`rh import ${yours.pane}`);
  expect(shown).toContain(`rh import ${claude.slice(0, 8)}`);
  expect(shown).toContain("Use the AskUserQuestion"); // what was said first
  expect(shown).toContain(`rh import ${pi.slice(0, 8)}`);
  await rhodium.ok("import", claude);
  expect(await list()).not.toContain(claude.slice(0, 8));

  // In chat, for the directory of the slot the chat goes to, a panel: Herdr's panes first (docs/im-style.md §9.7).
  const tg = (text: string) => rhodium.im.inject("t", { chat: ME, sender: ME, text });
  await tg(`/rh_use proj/${claude.slice(0, 8)}`);
  await tg("/rh_import");
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.buttons?.length), 15_000);
  const listed = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  expect(listed.text).toBe(`导入哪一个？Herdr ${rhodium.herdr.session} 会话里正在用的排在前面。`);
  expect(listed.buttons!.map((b) => b.data)).toEqual([`/rh_import ${yours.pane} --name`, `/rh_import ${pi} --name`, "cancel"]);
  expect(listed.buttons![0]!.label).toStartWith("Herdr 里 "); // its directory after, cut to fit the button
  // A press asks for the slot's name next, in place; 用默认名 imports it.
  await rhodium.im.press("t", ME, listed, listed.buttons![0]!.label);
  await until(async () => (await rhodium.im.shown("t", ME)).some((p) => p.text === "导入成槽位，叫什么？"), 15_000);
  const naming = (await rhodium.im.shown("t", ME)).find((p) => p.text === "导入成槽位，叫什么？")!;
  expect(naming.buttons!.map((b) => b.label)).toEqual(["用默认名", "自己起名…", "返回", "取消"]);
  await rhodium.im.press("t", ME, naming, "用默认名");
  await until(async () => (await rhodium.im.shown("t", ME)).some((p) => p.text.startsWith("已导入成")), 15_000);
  expect(await rhodium.state(`proj/${yours.session.slice(0, 8)}`)).toBe("TUI 模式");
}, 45_000);

test("a pane that is a slot's already is neither listed nor imported again, even once you moved its agent to another conversation", async () => {
  await begin();
  const dir = project("proj");
  const mine = await yourPane(dir, "proj");
  const ref = `proj/${mine.session.slice(0, 8)}`;
  await rhodium.ok("import", mine.pane);
  // /clear in the pane: it reports a conversation no slot has.
  await herdr("pane.report_agent_session", { pane_id: mine.pane, source: "herdr:claude", agent: "claude", agent_session_id: crypto.randomUUID() });

  expect((await rhodium.rh(["import"], { cwd: dir, tty: false })).out).not.toContain(mine.pane);
  const slots = await rhodium.ok("ls");
  const r = await rhodium.rh(["import", mine.pane]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`没能导入，这个 pane 已经是 ${ref} 的了。`);
  expect(await rhodium.ok("ls")).toBe(slots);
}, 30_000);

test("a conversation on disk that a Herdr pane is using is listed once, as that pane", async () => {
  await begin();
  const dir = project("proj");
  const session = copyTranscript("claude", dir);
  const ws = await herdr("workspace.create", { cwd: dir, label: "mine" });
  const pane = ws.root_pane.pane_id;
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: session });

  const shown = (await rhodium.rh(["import"], { cwd: dir, tty: false })).out;
  expect(shown).toContain(`rh import ${pane}`);
  expect(shown).not.toContain(`rh import ${session.slice(0, 8)}`);
}, 30_000);

test("a conversation a slot ever had is not listed: /resume goes back to it, even once the slot moved on or is archived", async () => {
  await begin();
  const dir = project("proj");
  const old = copyTranscript("claude", dir);
  const list = async () => (await rhodium.rh(["import"], { cwd: dir, tty: false })).out;
  await rhodium.ok("import", old, "--name", "x");
  await say("/rh_use proj/x");
  await say("/new");
  await posted("已开一段新对话。");

  expect(await list()).not.toContain(old.slice(0, 8));
  await rhodium.ok("archive", "proj/x");
  expect(await list()).not.toContain(old.slice(0, 8));
}, 30_000);

test.each([
  ["named", undefined, (session: string) => `Herdr ${session} 会话里`],
  ["not named when it is default, the one you use", "default", () => "Herdr 里"],
])("story 20: with nothing to import, /rh_import says where it looked; the Herdr session is %s", async (_, herdrSession, where) => {
  await begin({ herdrSession });
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/rh_import" });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.startsWith("没有可以导入的")), 15_000);
  const reply = (await rhodium.im.log("t", ME)).find((p) => p.text.startsWith("没有可以导入的"))!;
  expect(reply.text).toStartWith(`没有可以导入的：${where(rhodium.herdr.session)}没有报告了对话的 agent，`);
}, 30_000);

test.each([
  ["named", undefined, (session: string) => `Herdr ${session} 会话里`],
  ["not named when it is default, the one you use", "default", () => "Herdr 里"],
])("story 20: on the /rh_import panel a Herdr pane reads as a conversation on disk does, its directory, time and opening words; the Herdr session is %s", async (_, herdrSession, where) => {
  await begin({ herdrSession });
  const dir = join(rhodium.home, "proj");
  mkdirSync(dir);
  const session = copyTranscript("claude", dir);
  const ws = await herdr("workspace.create", { cwd: dir, label: "mine" });
  await herdr("pane.report_agent_session", { pane_id: ws.root_pane.pane_id, source: "herdr:claude", agent: "claude", agent_session_id: session });

  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/rh_import" });
  await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.buttons?.length), 15_000);
  const listed = (await rhodium.im.log("t", ME)).find((p) => p.buttons?.length)!;
  expect(listed.text).toBe(`导入哪一个？${where(rhodium.herdr.session)}正在用的排在前面。`);
  expect(listed.buttons!.map((b) => b.label)).toEqual([expect.stringMatching(/^Herdr 里 ~\/proj \d\d:\d\d Use the …$/), "取消"]);
}, 30_000);
