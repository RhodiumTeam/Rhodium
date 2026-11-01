// Switching a slot to the terminal (stories 103-107, 109, 111), seen from seam one: a fake Herdr
// session stands in for yours, and its panes run the fake claude. As in rh-send.test.ts the fake
// claude does what its message says: the message is a list of rh calls.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { updateClaude } from "./claude-update";
import { claudeProjectDir, type Run, type Script } from "./fake-agent/fake-agent";
import { codexOn, endTurn, on, piEnd, piOn, piStart, startTurn } from "./fake-agent/scripts";
import { call } from "./fake-herdr/fake-herdr";
import { BOARD_LOGIN, boardAct, newInstance, until, withoutSource, type Daemon, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };
const plan = (...calls: (string[] | { args: string[]; env: Record<string, string> })[]) => JSON.stringify(calls);

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** An instance with a fake Herdr, whose bot q goes to w/a; started, with the slots w/a and w/b made. */
async function begin(opts: InstanceOptions = {}): Promise<Instance> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey }, herdr: true, ...opts });
  daemon = await rhodium.start();
  board = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a", "b");
  return rhodium;
}
let board = ""; // the board's address
let daemon: Daemon; // the rhodium begin() started
/** Waits until rhodium has logged that it ended the agent in the terminal, and returns how. */
async function endedBy(): Promise<unknown> {
  const ended = () => daemon.logs.find((l) => l.msg === "ended the agent in the terminal");
  await until(() => ended() !== undefined);
  return ended()!.by;
}
const fromBoard = async (path: string) => (await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
/** The slot's card on the board, with the group it is in. */
async function card(name: string): Promise<{ id: string; state: string; group: string }> {
  const w = (await fromBoard("/api/board")).workspaces.find((w: any) => w.name === "w");
  const [group, cards] = Object.entries(w.groups as Record<string, any[]>).find(([, cs]) => cs.some((c) => c.name === name))!;
  return { ...cards.find((c) => c.name === name), group };
}

const texts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text);
/** Waits until the bot has posted a message containing what, and returns it. */
async function posted(what: string): Promise<string> {
  await until(async () => (await texts()).some((t) => t.includes(what)), 15_000);
  return (await texts()).find((t) => t.includes(what))!;
}
const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });
const herdr = async (method: string, params: object = {}) => (await call(rhodium.herdr.socket, method, params)).result;
const snapshot = async () => (await herdr("session.snapshot")).snapshot;
const alive = (pid: number) => existsSync(`/proc/${pid}`);

/** The claude runs of the slot, oldest first: headless ones start with -p, a pane's does not. */
const runs = (ref: string) => rhodium.claude.runs().filter((r) => r.env.RHODIUM_SLOT === ref);
const inPane = (r: Run) => r.argv[0] !== "-p";
/** The session the slot's first headless run was launched with. */
const sessionOf = (ref: string) => runs(ref)[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);

/** Types a message into the pane's agent, as you would at its prompt. */
async function typeInto(pane: string, text: string) {
  const frame = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
  await herdr("pane.send_input", { pane_id: pane, text: JSON.stringify(frame), keys: ["enter"] });
}

test("stories 103, 106, 109, 111: /rh_tui opens the same conversation in the workspace's Herdr workspace; IM messages are turned away, and rh works from the pane", async () => {
  await begin();
  await say("hi");
  await posted("done");
  const session = sessionOf("w/a");
  const headless = runs("w/a")[0]!;
  expect((await snapshot()).workspaces).toEqual([]); // made at the first switch

  await say("/rh_tui");
  const switched = await posted("切到 TUI 了");
  expect(alive(headless.pid)).toBe(false);
  // Story 106: a tab named after the slot, in a Herdr workspace named after the slot's workspace.
  const snap = await snapshot();
  expect(snap.workspaces.map((w: any) => w.label)).toEqual(["w"]);
  expect(snap.tabs.map((t: any) => t.label)).toEqual(["a"]);
  const pane = snap.panes[0];
  // Where to find it, by names: no pane id. A button switches it back.
  expect(switched).toBe(`w/a 切到 TUI 了。\n在 Herdr ${rhodium.herdr.session} 会话里 w 工作区的 a 标签页。\n在 TUI 里退出 agent，它会自动切回无头。这之前，这里的消息不会交给它。`);
  expect((await rhodium.im.log("q", ME)).find((p) => p.text === switched)!.buttons).toEqual([{ label: "切回无头", data: "/rh_release w/a" }]);
  // Story 103: the same conversation, in the slot's directory.
  await until(() => runs("w/a").some(inPane), 15_000);
  const tui = runs("w/a").find(inPane)!;
  expect(tui.argv).toEqual(["--permission-mode", "bypassPermissions", "--resume", session]);
  expect(tui.cwd).toBe(headless.cwd);
  // Herdr reports the session a moment after the agent starts, so not always by the notice.
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  expect((await snapshot()).panes[0].agent_session.value).toBe(session);
  // The Telegram channel plugin finds no token in the pane either, so it leaves your bot alone (architecture §6.2).
  expect(tui.env.TELEGRAM_STATE_DIR).toBe(headless.env.TELEGRAM_STATE_DIR!);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");

  // Story 109: your messages are not delivered meanwhile, and no headless agent starts for them.
  await say("are you there?");
  const refused = await posted("在 TUI 里，这条没交给它。发 /rh_release 把它切回无头。");
  expect((await rhodium.im.log("q", ME)).find((p) => p.text === refused)!.buttons).toEqual([
    { label: "切回无头", data: "/rh_release w/a" },
    { label: "换一个槽位", data: "/rh_use" },
  ]);
  // Story 111: the agent in the pane reaches you with rh send me, with its token and without.
  await typeInto(pane.pane_id, plan(["send", "me", "from the pane"], { args: ["send", "me", "from the pane, no token"], env: { RHODIUM_TOKEN: "" } }));
  await posted("from the pane, no token");
  expect(await texts()).toContain("from the pane");
  // A message from another slot or your terminal waits for the switch back.
  expect(await rhodium.ok("send", "w/a", "later")).toContain("它在 TUI 里，切回无头后再交给它。");
  expect(runs("w/a").filter((r) => !inPane(r))).toHaveLength(1);
  // A switch is no crash: no notice of one.
  expect((await texts()).filter((t) => t.includes("崩溃"))).toEqual([]);

  // Story 106: rh tui from your terminal puts another slot of w in the same Herdr workspace.
  await rhodium.ok("send", "w/b", "hi");
  await until(() => runs("w/b").length > 0 && rhodium.claude.runs().length > 0, 15_000);
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/b");
  await until(async () => (await snapshot()).tabs.length === 2, 15_000);
  const both = await snapshot();
  expect(both.workspaces).toHaveLength(1);
  expect(both.tabs.map((t: any) => [t.workspace_id, t.label])).toEqual([
    [snap.workspaces[0].workspace_id, "a"],
    [snap.workspaces[0].workspace_id, "b"],
  ]);
}, 60_000);

/** What the fake Herdr was asked to launch with so far: each layout.apply's params, and any request that
 *  makes a pane with a shell or types into one. */
async function launches(): Promise<{ applied: any[]; typed: unknown[] }> {
  const calls: { method: string; params: any }[] = (await herdr("fake.calls")).calls;
  return {
    applied: calls.filter((c) => c.method === "layout.apply").map((c) => c.params),
    typed: calls.filter((c) => ["tab.create", "pane.send_input", "pane.send_text"].includes(c.method)),
  };
}
const RH_ENV = ["RHODIUM_SLOT", "RHODIUM_SOCKET", "RHODIUM_TOKEN", "TELEGRAM_STATE_DIR"];

test("#372: the slot's tab runs Claude itself, nothing typed into a shell to show on its screen: one layout.apply, the token in its env alone", async () => {
  await begin();
  await say("hi");
  await posted("done");
  const headless = runs("w/a")[0]!;
  await say("/rh_tui");
  await posted("切到 TUI 了");
  const { applied, typed } = await launches();
  expect(typed).toEqual([]);
  expect(applied).toHaveLength(1);
  const [{ workspace_id, tab_label, root }] = applied;
  expect([workspace_id, tab_label, root.type, root.cwd]).toEqual([(await snapshot()).workspaces[0].workspace_id, "a", "pane", headless.cwd]);
  expect(root.command).toEqual(["/usr/bin/env", `PATH=${rhodium.env.PATH}`, rhodium.claude.path, "--permission-mode", "bypassPermissions", "--resume", sessionOf("w/a")]);
  expect(Object.keys(root.env).sort()).toEqual(RH_ENV);
  expect(root.command.join(" ")).not.toContain(root.env.RHODIUM_TOKEN);
}, 30_000);

test("#372: the switch is told, and the slot's pane handed to its web page, only once the pane's agent has reported its session, about when it has drawn its screen", async () => {
  // Herdr hears nothing from this pi: the test reports its session, as Herdr would once pi is up.
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { herdrReport: false } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  const { id } = await card("p");
  const session = flag(piRuns("w/p")[0]!.argv, "--session-id")!;
  await say("/rh_tui");
  await until(() => piRuns("w/p").some((r) => !rpc(r)), 15_000);
  await Bun.sleep(1_000);
  expect((await texts()).filter((t) => t.includes("切到 TUI 了"))).toEqual([]);
  expect((await fromBoard(`/api/slot?id=${id}`)).pane).toBeNull();
  const [pane] = (await snapshot()).panes;
  await herdr("pane.report_agent_session", { pane_id: pane.pane_id, source: "herdr:pi", agent: "pi", agent_session_id: session });
  await posted("切到 TUI 了");
  expect((await fromBoard(`/api/slot?id=${id}`)).pane).toBe(pane.pane_id);
}, 30_000);

test("#372: a pane whose agent never reports, as Claude in a directory it has not trusted till you answer it, still gets the switch told within 3 s, not holdStartTimeout", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { herdrReport: false } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  await say("/rh_tui");
  await until(() => piRuns("w/p").some((r) => !rpc(r)), 15_000);
  const up = Date.now();
  await posted("切到 TUI 了");
  expect(Date.now() - up).toBeLessThan(6_000); // holdStartTimeout is 10 s
}, 30_000);

test("#372: an agent that exits in its pane before it reports refuses the switch as one that exited at once, not with Herdr's error about the gone pane", async () => {
  // In a pane it exits half a second after it starts.
  const turn = [...piStart, ...piEnd("fake reply")];
  const script: Script = { on: piOn, steps: [{ goto: turn.length + 2, env: "HERDR_PANE_ID" }, ...turn, { goto: 1 }, { sleep: 500 }, { exit: 1 }] };
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { script, herdrReport: false } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  await say("/rh_tui");
  expect(await posted("没能切到 TUI")).toContain("\n原因：pane 里的 agent 起来就退出了");
}, 30_000);

test("rh rename of a slot in TUI renames its Herdr tab, and it switches back as ever", async () => {
  await begin();
  await say("hi");
  await posted("done");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await rhodium.ok("rename", "w/a", "c");
  await until(async () => (await snapshot()).tabs[0]?.label === "c", 15_000);
  expect(await rhodium.ok("release", "w/c")).toBe("正在把 w/c 切回无头…\n");
  await posted("w/c 切回无头了");
  expect((await snapshot()).tabs).toEqual([]);
}, 60_000);

/** Says each, waiting for the bot's answer to it. */
async function each(...said: string[]) {
  for (const s of said) {
    const n = (await texts()).length;
    await say(s);
    await until(async () => (await texts()).length > n, 15_000);
  }
}
/** Switches the slot w/a to the terminal; returns the argv its pane's claude was launched with. */
async function launched(): Promise<string[]> {
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(() => runs("w/a").some(inPane), 15_000);
  return runs("w/a").find(inPane)!.argv;
}

test("the terminal starts with the slot's /model and /effort, and with approval off skips permissions, as the headless agent does", async () => {
  await begin();
  await say("hi");
  await posted("done");
  await each("/model haiku", "/effort high");
  expect(await launched()).toEqual(["--model", "haiku", "--effort", "high", "--permission-mode", "bypassPermissions", "--resume", sessionOf("w/a")]);
}, 30_000);

test("approval on: the terminal gets no permission flag, so Claude's own default mode; a remembered model the last handshake no longer offers is left out", async () => {
  await begin();
  await say("hi");
  await posted("done");
  await each("/model haiku", "/effort low");
  await rhodium.ok("set", "w/a", "approval=on");
  // Claude was upgraded meanwhile, and rh doctor met the new one first: its list has no Haiku.
  updateClaude(rhodium, "2.1.305", { extra: { models: [{ value: "sonnet", displayName: "Sonnet" }] } });
  await rhodium.rh(["doctor"]);
  expect(await launched()).toEqual(["--effort", "low", "--resume", sessionOf("w/a")]);
}, 30_000);

/** A reply at this level, as Claude writes the first of a turn down; by default of the fake's default model. */
const reply = (effort: string, model = "claude-fake") =>
  JSON.stringify({ type: "assistant", isSidechain: false, timestamp: "{{now}}", effort, requestedModel: model, message: { role: "assistant", content: [{ type: "text", text: "on it" }] } });
/** obey, each turn first writing down its first reply: at high on your default model; in a Herdr pane,
 *  these lines instead. */
const inPaneWrites = (...lines: string[]): Script => ({
  on,
  steps: [...startTurn, { goto: 6, env: "HERDR_ENV" }, { transcript: [reply("high")] }, { goto: 7 }, { transcript: lines }, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }],
});
/** As Claude writes once you pick xhigh with ultracode in the terminal's /effort: ultracode's marker first. */
const ultracodeInPane = inPaneWrites(JSON.stringify({ type: "attachment", isSidechain: false, timestamp: "{{now}}", attachment: { type: "ultra_effort_enter", reminderType: "full" } }), reply("xhigh"));

test("xhigh with ultracode picked in the terminal stays with the slot once back, each as if set with /effort and /ultracode: the notice says so, and the next headless agent and terminal start so", async () => {
  await begin({ claude: { script: ultracodeInPane } });
  // Nothing set in IM: the terminal starts on your default, which the headless turn before it ran at.
  await say("hi");
  await posted("done");
  await launched();
  const [pane] = (await snapshot()).panes;
  // A turn there, its first reply written down by the time rh send me reaches you.
  await typeInto(pane.pane_id, plan(["send", "me", "in the terminal"]));
  await posted("in the terminal");
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。\n已应用 TUI 中的设置：思考强度 xhigh，ultracode 开。");

  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toEqual(expect.arrayContaining(["--effort", "xhigh", "--settings", '{"ultracode":true}']));
  await each("/status");
  expect((await texts()).at(-1)).toContain("\n模型：默认（Opus 5.5）xhigh\n已开启 ultracode\n");
  await say("/rh_tui");
  await until(() => runs("w/a").filter(inPane).length === 2, 15_000);
  expect(runs("w/a").filter(inPane)[1]!.argv).toEqual(["--effort", "xhigh", "--settings", '{"ultracode":true}', "--permission-mode", "bypassPermissions", "--resume", sessionOf("w/a")]);
}, 45_000);

test("a model switched to in the terminal stays with the slot once back, as if set with /model, but not the level it ran at there, which is that model's default", async () => {
  // Haiku in the terminal's /model: it runs at its own default level, low here.
  await begin({ claude: { script: inPaneWrites(reply("low", "claude-fake-haiku")) } });
  await say("hi");
  await posted("done");
  await each("/effort medium");
  await launched();
  const [pane] = (await snapshot()).panes;
  await typeInto(pane.pane_id, plan(["send", "me", "in the terminal"]));
  await posted("in the terminal");
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。\n已应用 TUI 中的设置：模型 Haiku。");

  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toEqual(expect.arrayContaining(["--model", "haiku", "--effort", "medium"]));
}, 45_000);

/** The focus requests the fake Herdr was sent, in order. */
const focusCalls = async () => ((await herdr("fake.calls")).calls as { method: string; params: object }[]).filter((c) => c.method.endsWith(".focus")).map((c) => [c.method, c.params]);

test("story 109: /status as the first message of a new chat, its slot in TUI, has the button to switch it back", async () => {
  await begin();
  await rhodium.ok("send", "w/a", "hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  await say("/status");
  await posted("w/a\nTUI 模式\n");
  expect((await rhodium.im.log("q", ME))[0]!.buttons).toEqual([
    { label: "切回无头", data: "/rh_release", row: 0 },
    { label: "取消", data: "cancel", row: 1, muted: true },
  ]);
}, 45_000);

test("story 109: a chat pointed at a slot in TUI turns your message away, saying how to talk to the default slot or switch it back; /status is still answered, by Rhodium", async () => {
  await begin();
  await rhodium.ok("send", "w/b", "hi");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await say("/rh_use w/b");
  await posted("这里的消息改交给 w/b");
  await rhodium.ok("tui", "w/b");
  await until(async () => (await rhodium.state("w/b")) === "TUI 模式", 15_000);
  await say("hi b");
  const refused = await posted("w/b 在 TUI 里，这条没交给它。");
  expect(refused).toBe("w/b 在 TUI 里，这条没交给它。发 /rh_use - 改和 w/a 说，或者发 /rh_release 把它切回无头。");
  expect((await rhodium.im.log("q", ME)).find((p) => p.text === refused)!.buttons).toEqual([
    { label: "切回无头", data: "/rh_release w/b" },
    { label: "换一个槽位", data: "/rh_use" },
  ]);
  await say("/status");
  const status = await posted("w/b\nTUI 模式\n");
  expect(status).toBe(`w/b\nTUI 模式\n\n模型设置\nAgent：Claude Code\n\n状态\n目录：${join(rhodium.dir, "w")}`);
  expect((await rhodium.im.log("q", ME)).find((p) => p.text === status)!.buttons).toEqual([
    { label: "切回无头", data: "/rh_release", row: 0 },
    { label: "取消", data: "cancel", row: 1, muted: true },
  ]);
  // No headless agent started for either.
  expect(runs("w/b").filter((r) => !inPane(r))).toHaveLength(1);
}, 60_000);

test("story 332: /rh_tui on a slot in TUI already offers 切回无头; /rh_help has 切回无头 in place of 切到 TUI", async () => {
  await begin();
  await rhodium.ok("send", "w/a", "hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  await say("/rh_tui");
  await posted("w/a 已经在 TUI 里了。");
  expect((await rhodium.im.log("q", ME)).find((p) => p.text === "w/a 已经在 TUI 里了。")!.buttons).toEqual([{ label: "切回无头", data: "/rh_release w/a" }]);
  await say("/rh_help");
  await posted("这里的消息交给 w/a，用 Claude。");
  const home = (await rhodium.im.log("q", ME)).find((p) => p.text === "这里的消息交给 w/a，用 Claude。")!;
  expect(home.buttons!.slice(0, 4).map((b) => [b.label, b.data])).toEqual([["槽位", "/rh_ls"], ["切换", "/rh_use"], ["切回无头", "/rh_release"], ["换 agent", "/rh_agent"]]);
  expect(home.buttons!.map((b) => b.label)).not.toContain("切到 TUI");
}, 45_000);

test("story 262: the board's stop on a slot in the terminal is turned away, saying to take it back on the banner, never a command to type", async () => {
  await begin();
  await rhodium.ok("send", "w/a", "hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  const r = await boardAct(board, { kind: "common", slot: (await card("a")).id, name: "stop" });
  expect(await r.json()).toEqual({ ok: false, error: "w/a 在 TUI 里，这条没交给它。点横幅上的“收回终端”把它切回无头。" });
}, 45_000);

test("stories 261, 263, 265, 266: the board's terminal key focuses the pane in Herdr, as /rh_tui does, and its take-back, sure once you confirmed it, ends the agent there; each shows on the board alone, and a switch that failed is told in IM all the same", async () => {
  await begin();
  await say("hi");
  await posted("done");
  const a = (await card("a")).id;
  const act = async (argv: string[], sure?: true) => (await boardAct(board, { kind: "rh", argv, ...(sure && { sure }) })).json();
  expect(await act(["tui", a])).toEqual({ ok: true, text: "正在把 w/a 切到 TUI…" });
  await until(async () => (await focusCalls()).length === 3, 15_000);
  const pane = (await snapshot()).panes[0];
  expect(await focusCalls()).toEqual([
    ["workspace.focus", { workspace_id: pane.workspace_id }],
    ["tab.focus", { tab_id: pane.tab_id }],
    ["pane.focus", { pane_id: pane.pane_id }],
  ]);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  await until(() => runs("w/a").some(inPane), 15_000);
  expect(await act(["release", a], true)).toEqual({ ok: true, text: "正在把 w/a 切回无头…" });
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  expect(await endedBy()).toBe("exit keys");
  await Bun.sleep(300);
  expect(await texts()).toEqual(["done"]);

  // Say you resumed it by hand in a terminal of your own.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", sessionOf("w/a")]);
  try {
    await act(["tui", a]);
    expect(await posted("没能切到 TUI")).toContain("\n原因：另一个进程正在用这段对话");
  } finally {
    other.kill();
    await other.exited;
  }
}, 45_000);

test("stories 278, 279: in the terminal, a message from the board is turned away, saying to take it back on the banner; /rh_release typed there only says so, the slot left in the terminal", async () => {
  await begin();
  await rhodium.ok("send", "w/a", "hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  const say = async (text: string) => (await boardAct(board, { kind: "say", slot: (await card("a")).id, text })).json();
  expect(await say("hello")).toEqual({ ok: false, error: "w/a 在 TUI 里，这条没交给它。点横幅上的“收回终端”把它切回无头。" });
  expect(await say("/rh_release")).toEqual({ ok: true, text: "点横幅上的“收回终端”把它切回无头。" });
  await Bun.sleep(300);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
}, 45_000);

test("/rh_tui from IM focuses the slot's pane in Herdr once it is open; an agent's rh tui does not (2026-10-21)", async () => {
  await begin();
  // The agent switches its own slot once its turn is over: nothing is focused.
  await say(plan(["tui", "w/a"]));
  await posted("切到 TUI 了");
  expect(await focusCalls()).toEqual([]);
  await quit((await snapshot()).panes[0].pane_id);
  await posted("切回无头了");
  // You, from IM: the pane's workspace, its tab, then the pane.
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  const snap = await snapshot();
  const pane = snap.panes[0];
  expect(await focusCalls()).toEqual([
    ["workspace.focus", { workspace_id: pane.workspace_id }],
    ["tab.focus", { tab_id: pane.tab_id }],
    ["pane.focus", { pane_id: pane.pane_id }],
  ]);
  expect(snap.focused_pane_id).toBe(pane.pane_id);
}, 45_000);

test("a message turned away while the slot is in the terminal does not make its chat the contact chat (2026-10-21)", async () => {
  // Bots q and t both go to w/a.
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } } });
  const t = async () => (await rhodium.im.log("t", ME)).map((p) => p.text);
  const sayT = (text: string) => rhodium.im.inject("t", { chat: ME, sender: ME, text });
  await sayT("hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await sayT("/rh_tui");
  await until(async () => (await t()).some((s) => s.includes("切到 TUI 了")), 15_000);
  await say("are you there?");
  await posted("在 TUI 里，这条没交给它");
  await typeInto((await snapshot()).panes[0].pane_id, plan(["send", "me", "from the pane"]));
  await until(async () => (await t()).includes("from the pane"), 15_000);
  expect(await texts()).not.toContain("from the pane");
}, 45_000);

test("/rh_tui and /rh_release naming a slot another chat goes to: how the switch went, and the confirm request, come to the chat that asked (product §5.9)", async () => {
  // Bot q goes to w/a, bot t to w/b; t's chat has talked with w/b, so it is w/b's contact chat.
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/b" } } });
  const t = async () => (await rhodium.im.log("t", ME)).map((p) => p.text);
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "hi" });
  await until(async () => (await t()).includes("done"), 15_000);
  await say("/rh_tui w/b");
  await posted("正在把 w/b 切到 TUI…");
  await posted("w/b 切到 TUI 了");
  await say("/rh_release w/b");
  await posted("把 w/b 切回无头吗？");
  await say("1");
  await posted("w/b 切回无头了。");
  expect(await t()).toEqual(["done"]);
}, 45_000);

/** The control requests written to the run's stdin, by subtype. */
const controls = (r: Run) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "control_request").map((m) => m.request.subtype);

test("story 104: /rh_tui waits for the turn under way to end, its reply included, then switches", async () => {
  await begin({ claude: { script: { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("slow reply"), { goto: 0 }] } } });
  await say("take your time");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/rh_tui");
  expect(await posted("这一回合还没跑完，跑完就切到 TUI。")).toContain("w/a");
  await posted("切到 TUI 了");
  const all = await texts();
  expect(all.indexOf("slow reply")).toBeGreaterThan(-1);
  expect(all.indexOf("slow reply")).toBeLessThan(all.findIndex((t) => t.includes("切到 TUI 了")));
  expect(controls(runs("w/a")[0]!)).not.toContain("interrupt");
}, 30_000);

test("stories 104, 154: the emergency stop calls off a /rh_tui waiting for the turn: the chat you sent it from hears so, and the slot stays headless", async () => {
  await begin({ claude: { script: { on, steps: [...startTurn, { sleep: 3000 }, ...endTurn("slow reply"), { goto: 0 }] } }, toml: '[durations]\nstopGrace = "1s"' });
  await say("take your time");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/rh_tui");
  await posted("这一回合还没跑完，跑完就切到 TUI。");
  await rhodium.ok("stop", "--all");
  expect(await posted("被急停取消了")).toBe("你请求的 rh tui w/a 被急停取消了，w/a 停着，还是无头模式。");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  expect((await snapshot()).panes).toEqual([]);
}, 30_000);

test("stories 104, 109: your message held for an interrupt is not handed over once the slot is in the terminal: you are told, with it quoted to send there", async () => {
  // The turn takes no notice of the interrupt: your message waits for it to end.
  await begin({ claude: { script: { on, steps: [...startTurn, { sleep: 1500 }, ...endTurn("done"), { goto: 0 }] } } });
  await say("work");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("!排着的话");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await posted("没交给它");
  const notice = (await rhodium.im.log("q", ME)).find((p) => p.text.includes("没交给它"))!;
  expect(notice.text).toBe("w/a 切到 TUI 了，你排着的这条没交给它，要的话到终端里再发：\n“排着的话”");
  expect(notice.buttons).toEqual([{ label: "复制", data: "排着的话", copy: true }]);

  const [pane] = (await snapshot()).panes;
  await quit(pane.pane_id);
  await posted("切回无头了");
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行"); // nothing left to hand over
  expect(told("w/a")).not.toContain("排着的话");
}, 30_000);

test("story 105: /rh_tui ! interrupts the turn under way, then switches", async () => {
  await begin({ claude: { script: "until-interrupted" } });
  await say("work until stopped");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/rh_tui !");
  expect(await posted("已打断")).toContain("w/a");
  await posted("切到 TUI 了");
  expect(controls(runs("w/a")[0]!)).toContain("interrupt");
  await until(() => runs("w/a").some(inPane), 15_000);
}, 30_000);

test("story 105: the button on /rh_tui's reply still cuts the turn short once /rh_tui is waiting for it", async () => {
  await begin({ claude: { script: "until-interrupted" } });
  await say("work until stopped");
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await say("/rh_tui");
  const waits = await posted("这一回合还没跑完，跑完就切到 TUI。");
  const reply = (await rhodium.im.log("q", ME)).find((p) => p.text === waits)!;
  expect(reply.buttons).toEqual([{ label: "打断，马上切", data: "/rh_tui w/a !" }]);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "", button: { data: reply.buttons![0]!.data, message: reply.messageId } });
  expect(await posted("已打断")).toContain("w/a");
  await posted("切到 TUI 了");
  expect(controls(runs("w/a")[0]!)).toContain("interrupt");
}, 30_000);

test("story 105: /rh_tui ! while the slot is still starting has no turn to cut short yet: it says to send it again shortly, and the slot stays headless", async () => {
  // Claude reads your message only 1.5 s after it starts.
  await begin({ claude: { script: { on, steps: [{ sleep: 1500 }, ...startTurn, ...endTurn("done"), { goto: 1 }] } } });
  await say("hi");
  await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
  await say("/rh_tui !");
  expect(await posted("/rh_tui")).toBe("w/a 还在启动，过几秒再发 /rh_tui !。");
  await posted("done");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect((await snapshot()).panes).toEqual([]);
}, 30_000);

test("story 107: the pane opens only once the headless agent is gone", async () => {
  // After each turn the agent takes 2.5 s before it reads stdin again, and so before it sees it closed.
  await begin({ claude: { script: { on, steps: [...startTurn, ...endTurn("done"), { sleep: 2500 }, { goto: 0 }] } } });
  await say("hi");
  await posted("done");
  const headless = runs("w/a")[0]!;
  await say("/rh_tui");
  await posted("正在把 w/a 切到 TUI…");
  expect(alive(headless.pid)).toBe(true);
  await until(async () => {
    const opened = (await snapshot()).panes.length > 0;
    if (opened) expect(alive(headless.pid)).toBe(false);
    return opened;
  }, 15_000);
  await posted("切到 TUI 了");
}, 30_000);

test("story 107: the switch is refused while another process or Herdr pane has the conversation, and the slot stays headless", async () => {
  await begin();
  await say("hi");
  await posted("done");
  const session = sessionOf("w/a");

  // Say you resumed it by hand in a terminal of your own.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    await say("/rh_tui");
    expect(await posted("没能切到 TUI")).toContain("\n原因：另一个进程正在用这段对话");
  } finally {
    other.kill();
    await other.exited;
  }
  expect((await snapshot()).tabs).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("未运行");

  // Or in a Herdr pane, whose agent reported the session.
  const ws = await herdr("workspace.create", { cwd: rhodium.dir, label: "mine" });
  const pane = ws.root_pane.pane_id;
  await herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: session });
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("没能切到 TUI")).length === 2, 15_000);
  expect((await texts()).at(-1)).toContain("\n原因：Herdr 里另一个 pane 正在用这段对话");
  expect((await snapshot()).tabs).toHaveLength(1); // yours alone

  // Headless as before, and as careful: no agent resumes the conversation while your pane has it
  // (architecture §10.1). Once you let it go, your next message does, there.
  await say("still there?");
  expect(await posted("没能启动")).toContain("\n原因：Herdr 里另一个 pane 正在用这段对话");
  await herdr("tab.close", { tab_id: ws.tab.tab_id });
  await say("and now?");
  // Both waiting messages go to the new process, one after the other; the fake claude runs each
  // as a turn of its own, and each turn's reply comes back: "done" for "hi" and for these two.
  await until(async () => (await texts()).filter((t) => t === "done").length === 3, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${session}`);
}, 30_000);

test("story 107: a rhodium killed after starting the agent in the slot's tab, before it heard back, takes that pane over on restart instead of going headless beside it", async () => {
  await begin();
  await say("hi");
  await posted("done");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  const [pane] = (await snapshot()).panes;
  // Up once its pane's shell runs it, a moment before it logs its run.
  await until(() => runs("w/a").some(inPane), 15_000);
  const agent = runs("w/a").find(inPane)!;

  // As if rhodium had died before the pane was on record, in the switch that made the Herdr
  // workspace: the restart finds the switch under way, and tries it again.
  await rhodium.kill9();
  const db = new Database(join(rhodium.dir, "state/rh.db"));
  db.run("UPDATE slot SET herdrTab = NULL, herdrPane = NULL, tuiPid = NULL, tuiStart = NULL");
  db.run("UPDATE workspace SET herdrWorkspace = NULL");
  db.close();
  await rhodium.start();

  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  expect((await texts()).at(-1)).toContain("w 工作区的 a 标签页");
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  expect((await snapshot()).panes.map((p: any) => p.pane_id)).toEqual([pane.pane_id]);
  expect(alive(agent.pid)).toBe(true);
  // Your messages are still turned away, and no headless agent starts beside the pane's.
  await say("still there?");
  await posted("在 TUI 里，这条没交给它。发 /rh_release 把它切回无头。");
  expect(runs("w/a").filter((r) => !inPane(r))).toHaveLength(1);
  expect(runs("w/a").filter(inPane)).toHaveLength(1);
}, 60_000);

test("story 107: a tab of the slot's name with only a shell in it, say one Herdr restored without its agent, does not stop /rh_tui: it goes, and a new one opens", async () => {
  await begin({ toml: '[durations]\nholdStartTimeout = "2s"' });
  // w/b in the terminal keeps the workspace's Herdr workspace open.
  await rhodium.ok("send", "w/b", "hi");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await rhodium.ok("tui", "w/b");
  await until(async () => (await rhodium.state("w/b")) === "TUI 模式", 15_000);
  const [workspace] = (await snapshot()).workspaces;
  const stale = (await herdr("tab.create", { workspace_id: workspace.workspace_id, cwd: rhodium.dir, label: "a" })).tab.tab_id;

  await say("hi");
  await posted("done");
  await say("/rh_tui");
  await until(async () => (await texts()).some((t) => t.includes("切到 TUI 了") || t.includes("没能切到 TUI")), 15_000);
  expect((await texts()).filter((t) => t.includes("没能切到 TUI"))).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  const tabs = (await snapshot()).tabs.filter((t: any) => t.label === "a");
  expect(tabs).toHaveLength(1);
  expect(tabs[0].tab_id).not.toBe(stale);
}, 60_000);

/** Switches w/a, with one turn behind it, to the terminal; returns its session, pane and the pane's agent run. */
async function inTerminal() {
  await say("hi");
  await posted("done");
  const session = sessionOf("w/a");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(() => runs("w/a").some(inPane), 15_000);
  // Herdr has the session too, else a session reported next could be overwritten as it notices the agent.
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  return { session, pane: pane.pane_id as string, agent: runs("w/a").find(inPane)! };
}
/** Quits the pane's agent as you would: Ctrl-C twice. */
async function quit(pane: string) {
  for (let i = 0; i < 2; i++) await herdr("pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] });
}
/** How many final replies "done" you have had. */
const dones = async () => (await texts()).filter((t) => t === "done").length;

test("story 480: switching a slot no chat goes to, to the terminal and back by quitting there, tells no chat, though one wrote to it once; with a chat going to it, it is told there (2026-10-27)", async () => {
  await begin({ toml: `mainChat = "q/${ME}"` });
  await say("/rh_use b");
  await say("hi"); // q's chat wrote to w/b
  await posted("done");
  await say("/rh_use a");
  await until(async () => (await texts()).length === 3, 15_000);
  const quiet = async () => {
    await rhodium.ok("tui", "w/b");
    await until(async () => (await rhodium.state("w/b")) === "TUI 模式", 15_000);
    await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
    await quit((await snapshot()).panes[0].pane_id);
    await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  };
  await quiet();
  await Bun.sleep(300); // a notice would show up by now
  expect(await texts()).toHaveLength(3);
  // Once q's chat goes to it, both come there.
  await say("/rh_use b");
  await until(async () => (await texts()).length === 4, 15_000);
  await quiet();
  await posted("w/b 切到 TUI 了");
  await posted("w/b 切回无头了");
}, 45_000);

test("story 112: quitting the agent in the pane puts the slot back to headless, and the phone carries on with the same conversation", async () => {
  await begin();
  const { session, pane, agent } = await inTerminal();
  await quit(pane);
  await posted("切回无头了");
  expect(alive(agent.pid)).toBe(false);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect((await snapshot()).tabs).toEqual([]);
  await say("back on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${session}`);
}, 30_000);

test("story 106: with Herdr's session named default, the one you use, where to find the slot names no session", async () => {
  await begin({ herdrSession: "default" });
  await inTerminal();
  expect(await posted("切到 TUI 了")).toBe("w/a 切到 TUI 了。\n在 Herdr w 工作区的 a 标签页。\n在 TUI 里退出 agent，它会自动切回无头。这之前，这里的消息不会交给它。");
}, 30_000);

test("stories 143, 145, 208: on the board a slot in the terminal runs, as TUI 模式 with its pane; a page following it hears as the agent there writes, and once back, its transcript has the turns done there", async () => {
  await begin();
  const { pane } = await inTerminal();
  const a = await card("a");
  expect([a.group, a.state]).toEqual(["running", `TUI 模式（pane ${pane}）`]);
  // Story 208: its pane, for the page's banner.
  expect(await fromBoard(`/api/slot?id=${a.id}`)).toMatchObject({ state: `TUI 模式（pane ${pane}）`, pane });
  // Story 208: a page following it hears as the agent there writes to its transcript.
  const ac = new AbortController();
  const stream = await fetch(`${board}/api/events?slot=${a.id}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN }, signal: ac.signal });
  let heard = "";
  const hearing = (async () => {
    for await (const chunk of stream.body!.pipeThrough(new TextDecoderStream())) heard += chunk;
  })().catch(() => {}); // aborted

  await typeInto(pane, plan(["send", "me", "typed in the terminal"]));
  await posted("typed in the terminal");
  await until(() => heard.includes("event: grew\n"), 5_000);
  ac.abort();
  await hearing;
  // The turn there is over, its reply written down, before you quit: rh send me reaches you before
  // the agent says done, and quitting sooner would take that reply with it.
  const said = async () => (await fromBoard(`/api/messages?slot=${a.id}`)).blocks.filter((b: any) => b.kind === "user" || b.kind === "assistant").map((b: any) => [b.kind, b.text]);
  await until(async () => (await said()).length === 4, 15_000);
  await quit(pane);
  await posted("切回无头了");
  expect(await said()).toEqual([
    ["user", expect.stringContaining("hi")],
    ["assistant", "done"],
    ["user", plan(["send", "me", "typed in the terminal"])],
    ["assistant", "done"],
  ]);
}, 30_000);

/** Acts out /clear or /resume in the pane: Claude's hook reports the new session to Herdr, which sends no event of it.
 *  A /clear with nothing said after it leaves no transcript; startedIn: a /resume, to a conversation Claude wrote
 *  down in that directory's folder. */
const moveTo = async (pane: string, session: string, startedIn?: string) => {
  if (startedIn) {
    const projects = join(rhodium.home, ".claude/projects", claudeProjectDir(startedIn));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${session}.jsonl`), "");
  }
  return herdr("pane.report_agent_session", { pane_id: pane, source: "herdr:claude", agent: "claude", agent_session_id: session });
};

test("story 113: having moved to another conversation in the terminal, the slot goes on with that one once back", async () => {
  await begin();
  const first = await inTerminal();
  // Read from the pane within a second; then the agent goes some way other than Ctrl-C.
  const second = crypto.randomUUID();
  await moveTo(first.pane, second);
  await Bun.sleep(1500);
  process.kill(first.agent.pid, "SIGTERM");
  expect(await posted("切回无头了")).toBe("w/a 切回无头了，接着用你在 TUI 里最后那段对话。");
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  // A /clear with nothing said after it: Claude has no transcript of it, so it starts under that id.
  expect(runs("w/a").at(-1)!.argv).toContain(`--session-id=${second}`);

  // Moved on just before quitting with Ctrl-C: Herdr reports it as the pane exits.
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  expect(pane.agent_session.value).toBe(second);
  const third = crypto.randomUUID();
  await moveTo(pane.pane_id, third);
  await quit(pane.pane_id);
  await until(async () => (await texts()).filter((t) => t.includes("切回无头了")).length === 2, 15_000);
  await say("on the phone again");
  await until(async () => (await dones()) === 3, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--session-id=${third}`);
}, 45_000);

test("/rh_tui of a conversation Claude never wrote down, as one you /clear'ed to and left at once, opens it under that id", async () => {
  await begin();
  const first = await inTerminal();
  const second = crypto.randomUUID();
  await moveTo(first.pane, second);
  await quit(first.pane);
  await posted("切回无头了");
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  await until(() => runs("w/a").filter(inPane).length === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toEqual(["--permission-mode", "bypassPermissions", "--session-id", second]);
}, 30_000);

/** The session id of the conversation the slot is on, as rhodium has it now. */
function sessionInDb(name: string): string | null {
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    return (db.query("SELECT c.sessionId FROM slot s JOIN conversation c ON c.id = s.conversation WHERE s.name = ?").get(name) as { sessionId: string | null }).sessionId;
  } finally {
    db.close();
  }
}

test("stories 544, 545: /rh_tui on a slot with no conversation yet starts one in the terminal, by the slot's settings, under a new id the slot has at once", async () => {
  await begin();
  await say("/rh_tui");
  await until(() => runs("w/a").some(inPane), 15_000);
  const { argv } = runs("w/a").find(inPane)!;
  expect(argv.slice(0, -1)).toEqual(["--permission-mode", "bypassPermissions", "--session-id"]);
  expect(argv.at(-1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // On record before the agent starts, while the switch still waits for its screen: a rhodium that
  // died now would take this pane over on restart (architecture §10.1).
  expect(sessionInDb("a")).toBe(argv.at(-1)!);
  await posted("切到 TUI 了");
}, 30_000);

test("a conversation you /resume'd to in the terminal that was started in another directory is resumed, in the pane and once back, not started anew", async () => {
  await begin();
  const first = await inTerminal();
  const second = crypto.randomUUID();
  await moveTo(first.pane, second, join(rhodium.dir, "elsewhere"));
  await quit(first.pane);
  await posted("切回无头了");
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  await until(() => runs("w/a").filter(inPane).length === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toEqual(["--permission-mode", "bypassPermissions", "--resume", second]);

  // Nothing said in the pane: the transcript is still only in the other directory's folder.
  const [pane] = (await snapshot()).panes;
  await quit(pane.pane_id);
  await until(async () => (await texts()).filter((t) => t.includes("切回无头了")).length === 2, 15_000);
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${second}`);
}, 45_000);

test("an rh send that waited for the switch back reaches the agent once back, on the conversation you moved to in the terminal", async () => {
  await begin();
  const { pane } = await inTerminal();
  expect(await rhodium.ok("send", "w/a", "later")).toContain("它在 TUI 里，切回无头后再交给它。");
  const second = crypto.randomUUID();
  await moveTo(pane, second);
  await Bun.sleep(1500);
  await quit(pane);
  await posted("切回无头了");
  await until(() => runs("w/a").filter((r) => !inPane(r)).length === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--session-id=${second}`);
  await until(() => runs("w/a").at(-1)!.stdin.some((l) => l.includes("later")), 15_000);
}, 30_000);

test("stories 114, 115: /rh_release asks you first; agreed, it ends the agent in the terminal and the slot is headless again", async () => {
  await begin();
  const { session, agent } = await inTerminal();
  const ASK = "把 w/a 切回无头吗？\n这会结束 TUI 里的 agent，对话留着接着用。";
  const asked = async (n: number) => until(async () => (await texts()).filter((t) => t === ASK).length === n, 15_000);
  await say("/rh_release");
  await asked(1);
  // Yours, it asks in so many words, with the action on its button (docs/im-style.md §5.2).
  const ask = (await rhodium.im.log("q", ME)).find((p) => p.text.startsWith("把 w/a 切回无头吗？"))!;
  expect(ask.text).toBe("把 w/a 切回无头吗？\n这会结束 TUI 里的 agent，对话留着接着用。");
  expect(ask.buttons!.map((b) => b.label)).toEqual(["切回无头", "取消"]);
  // Turned down: the agent in the terminal goes on.
  await say("2");
  await posted("已取消，w/a 没动。");
  await Bun.sleep(500);
  expect(alive(agent.pid)).toBe(true);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");

  // The switch's notice has a button for it too.
  const notice = (await rhodium.im.log("q", ME)).find((p) => p.text.includes("切到 TUI 了"))!;
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "", button: { data: notice.buttons![0]!.data, message: notice.messageId } });
  await asked(2);
  await say("1");
  await posted("正在把 w/a 切回无头…");
  await posted("w/a 切回无头了。");
  expect(alive(agent.pid)).toBe(false);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect((await snapshot()).tabs).toEqual([]);
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${session}`);
}, 45_000);

test("on Telegram, /status's 切回无头 asks you in a message of its own, and /status says what was picked, its buttons off (docs/im-style.md §9.1)", async () => {
  await begin({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  const t = (text: string) => rhodium.im.inject("t", { chat: ME, sender: ME, text });
  const shown = () => rhodium.im.shown("t", ME);
  await t("hi");
  await until(async () => (await shown()).some((p) => p.text === "done"), 15_000);
  await rhodium.ok("tui", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式", 15_000);
  await t("/status");
  const STATUS = `w/a\nTUI 模式\n\n模型设置\nAgent：Claude Code\n\n状态\n目录：${join(rhodium.dir, "w")}`;
  await until(async () => (await shown()).some((p) => p.text === STATUS), 15_000);
  const status = (await shown()).find((p) => p.text === STATUS)!;
  await rhodium.im.press("t", ME, status, "切回无头");
  await until(async () => (await shown()).some((p) => p.text.startsWith("把 w/a 切回无头吗？")), 15_000);
  await until(async () => (await shown()).some((p) => p.messageId === status.messageId && p.text === `${STATUS}\n已选：切回无头`), 5_000);
  const now = (await shown()).find((p) => p.messageId === status.messageId)!;
  expect(now.buttons ?? []).toEqual([]);
}, 45_000);

test("on Telegram, 换模型 pressed on a /status from before rh tui is turned away in place of that /status, in no message of its own (docs/im-style.md §9.1)", async () => {
  await begin({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } } });
  const t = (text: string) => rhodium.im.inject("t", { chat: ME, sender: ME, text });
  const shown = () => rhodium.im.shown("t", ME);
  await t("hi");
  await until(async () => (await shown()).some((p) => p.text === "done"), 15_000);
  await t("/status");
  await until(async () => (await shown()).some((p) => p.text.startsWith("w/a\n空闲\n")), 15_000);
  const status = (await shown()).find((p) => p.text.startsWith("w/a\n空闲\n"))!;
  await rhodium.ok("tui", "w/a");
  await until(async () => (await shown()).some((p) => p.text.startsWith("w/a 切到 TUI 了")), 15_000);
  const n = (await shown()).length;
  await rhodium.im.press("t", ME, status, "换模型");
  const REFUSED = "w/a 在 TUI 里，这条没交给它。发 /rh_release 把它切回无头。";
  await until(async () => (await shown()).some((p) => p.text === REFUSED), 15_000);
  const now = await shown();
  expect(now).toHaveLength(n);
  expect(now.find((p) => p.messageId === status.messageId)).toMatchObject({ text: REFUSED });
  expect(now.find((p) => p.messageId === status.messageId)!.buttons).toEqual([
    { label: "切回无头", data: "/rh_release w/a" },
    { label: "换一个槽位", data: "/rh_use" },
  ]);
}, 45_000);

test("/rh_release of a slot this chat does not go to: its buttons answer as for this chat's slot, naming no asker (docs/im-style.md §5.4)", async () => {
  await begin();
  await rhodium.ok("send", "w/b", "hi");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await say("/rh_tui w/b");
  await posted("w/b 切到 TUI 了");
  /** Asks for /rh_release w/b, presses the button so labelled, and returns the reply to the press. */
  async function press(label: string): Promise<string> {
    const n = (await texts()).length;
    await say("/rh_release w/b");
    await until(async () => (await texts()).slice(n).some((t) => t.startsWith("把 w/b 切回无头吗？")), 15_000);
    const ask = (await rhodium.im.log("q", ME)).slice(n).find((p) => p.text.startsWith("把 w/b 切回无头吗？"))!;
    const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "", button: { data: ask.buttons!.find((b) => b.label === label)!.data, message: ask.messageId } });
    const reply = async () => (await rhodium.im.log("q", ME)).find((p) => p.replyTo === messageId);
    await until(async () => (await reply()) !== undefined, 15_000);
    return (await reply())!.text;
  }
  expect(await press("取消")).toBe("已取消，w/b 没动。");
  expect(await press("切回无头")).toBe("正在把 w/b 切回无头…");
  await posted("w/b 切回无头了。");
}, 45_000);

test("story 99: /rh_tui takes over a child the dispatcher spawned, as any slot", async () => {
  await begin();
  await say(plan(["spawn", "c", "fix the bug"]));
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  await say("/rh_use c");
  await posted("w/c");
  await say("/rh_tui");
  expect(await posted("切到 TUI 了")).toContain("w/c");
  await until(() => runs("w/c").some(inPane), 15_000);
  expect(runs("w/c").find(inPane)!.argv).toEqual(["--permission-mode", "bypassPermissions", "--resume", sessionOf("w/c")]);
  expect((await snapshot()).tabs.map((t: any) => t.label)).toEqual(["c"]);
  expect(await rhodium.state("w/c")).toBe("TUI 模式");
}, 30_000);

/** What the slot's headless claude runs were told, oldest first, without the line saying where it came from. */
const told = (ref: string) =>
  runs(ref)
    .filter((r) => !inPane(r))
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"))
    .map((m) => withoutSource(m.message.content[0].text) as string);

test("story 110: a child's report and an rh send that come while the slot is in the terminal wait, and reach it in order once back", async () => {
  // The child is a pi that asks before it works: stuck at once, done once you answer.
  await begin({ pi: { script: "pi-ask" }, bots: { q: { like: "qq", owner: ME, target: "w/a" }, qc: { like: "qq", owner: ME, target: "w/c" } } });
  await say(plan(["spawn", "c", "--agent", "pi", "do it"]));
  await posted("允许吗？");
  await until(() => told("w/a").some((t) => t.includes("w/c 卡住了")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await say("/rh_tui");
  await posted("切到 TUI 了");
  const [pane] = (await snapshot()).panes;

  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "1" });
  await until(async () => (await rhodium.state("w/c")) === "空闲", 15_000);
  expect(await rhodium.ok("send", "w/a", "later")).toContain("它在 TUI 里，切回无头后再交给它。");
  await Bun.sleep(500);
  expect(runs("w/a").filter((r) => !inPane(r))).toHaveLength(1);
  const before = told("w/a").length;

  await quit(pane.pane_id);
  await posted("切回无头了");
  await until(() => told("w/a").length === before + 2, 15_000);
  const [report, sent] = told("w/a").slice(before);
  expect(report).toContain("w/c 完成了");
  expect(sent).toBe("later");
  expect(runs("w/a").filter((r) => !inPane(r))).toHaveLength(2);
}, 45_000);

/** The pi runs of the slot, oldest first: headless ones in rpc mode, a pane's not. */
const piRuns = (ref: string) => rhodium.pi.runs().filter((r) => r.env.RHODIUM_SLOT === ref);
const rpc = (r: Run) => r.argv.includes("--mode");
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const replies = async () => (await texts()).filter((t) => t === "fake reply").length;

/** The pi slot w/p, which bot q goes to, switched to the terminal after one turn; returns its
 *  headless run and session, its pane once the pane reports pi's session, and the pane's pi run. */
async function piInTerminal(opts: InstanceOptions = {}) {
  // Keys of your Claude's where Herdr runs, which a pane's pi must not get (architecture §6.3).
  const keys = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-test" };
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, env: keys, ...opts });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  const headless = piRuns("w/p")[0]!;
  const session = flag(headless.argv, "--session-id")!;
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  return { headless, session, pane, tui: piRuns("w/p").find((r) => !rpc(r))! };
}

test("story 108: a pi slot switches to the terminal on its session and back; the phone carries on with the same conversation, or the one you moved to there", async () => {
  const { headless, session, pane, tui } = await piInTerminal();
  const folder = dirname(pane.agent_session.value); // the slot directory's pi sessions
  expect(alive(headless.pid)).toBe(false);
  // pi's own terminal on the same session, in the slot's directory (architecture §6.3).
  expect(tui.argv).toEqual(["--session-id", session]);
  expect(tui.cwd).toBe(headless.cwd);
  expect(Object.keys(tui.env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
  // Your pi's Herdr extension reports the session's file to the pane, from the pane's variables.
  expect(tui.env.HERDR_PANE_ID).toBe(pane.pane_id);
  expect(pane.agent_session).toMatchObject({ agent: "pi", value: expect.stringMatching(new RegExp(`_${session}\\.jsonl$`)) });
  expect(await rhodium.state("w/p")).toBe("TUI 模式");
  await say("are you there?");
  await posted("在 TUI 里，这条没交给它。发 /rh_release 把它切回无头。");

  await quit(pane.pane_id);
  await posted("切回无头了");
  expect(alive(tui.pid)).toBe(false);
  await say("back on the phone");
  await until(async () => (await replies()) === 2, 15_000);
  expect(flag(piRuns("w/p").at(-1)!.argv, "--session-id")).toBe(session);

  // /new in pi's terminal: its Herdr extension reports the new session's file, which is named after its id.
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  const [again] = (await snapshot()).panes;
  const moved = crypto.randomUUID();
  const file = join(folder, `2026-10-21T08-00-00-000Z_${moved}.jsonl`);
  await herdr("pane.report_agent_session", { pane_id: again.pane_id, source: "herdr:pi", agent: "pi", agent_session_path: file });
  await Bun.sleep(1500);
  await quit(again.pane_id);
  expect(await posted("切回无头了，接着用")).toBe("w/p 切回无头了，接着用你在 TUI 里最后那段对话。");
  await say("on the phone again");
  await until(async () => (await replies()) === 3, 15_000);
  expect(flag(piRuns("w/p").at(-1)!.argv, "--session-id")).toBe(moved);
}, 60_000);

test("#372: pi's tab runs pi itself too, without your Claude's keys, nothing typed into a shell", async () => {
  const { session } = await piInTerminal();
  const { applied, typed } = await launches();
  expect(typed).toEqual([]);
  // Those pi reads go by name even where rhodium's environment lacks them, as Herdr's may have them.
  const unset = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].flatMap((k) => ["-u", k]);
  expect(applied.map((p) => [p.tab_label, p.root.command])).toEqual([
    ["p", ["/usr/bin/env", ...unset, `PATH=${rhodium.env.PATH}`, rhodium.pi.path, "--session-id", session]],
  ]);
  expect(Object.keys(applied[0].root.env).sort()).toEqual(RH_ENV);
}, 30_000);

test("#419: pi's terminal goes without every variable of Claude's that its headless agent goes without, not only the two keys pi reads", async () => {
  const more = { ANTHROPIC_AUTH_TOKEN: "a", ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDE_CODE_OAUTH_TOKEN: "c", CLAUDE_CONFIG_DIR: "/x/.claude" };
  const { headless, pane, tui } = await piInTerminal({ env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-test", ...more } });
  const claude = (env: Record<string, string>) => Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE)/.test(k));
  expect(claude(headless.env)).toEqual([]);
  expect(claude(tui.env)).toEqual([]);
  expect(tui.env.HERDR_PANE_ID).toBe(pane.pane_id); // pi's Herdr extension still reports with them
}, 30_000);

test("story 108: a conversation of another directory you /resume in pi's terminal is not carried back, as headless pi cannot open it there: the slot keeps its own, and says why", async () => {
  const { session, pane } = await piInTerminal();
  const elsewhere = join(rhodium.home, ".pi/agent/sessions/--elsewhere--", `2026-10-21T08-00-00-000Z_${crypto.randomUUID()}.jsonl`);
  await herdr("pane.report_agent_session", { pane_id: pane.pane_id, source: "herdr:pi", agent: "pi", agent_session_path: elsewhere });
  await Bun.sleep(1500); // read from the pane within a second
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/p 切回无头了。你在 TUI 里最后用的那段对话不在它的目录里，无头的 pi 接不上，它接着用原来那段。");
  await say("back on the phone");
  await until(async () => (await replies()) === 2, 15_000);
  expect(flag(piRuns("w/p").at(-1)!.argv, "--session-id")).toBe(session);
}, 45_000);

/** pi-turn, its session starting on pi-fake at medium, written down as pi does; in a Herdr pane, it
 *  writes down each change typed into it, as pi does once you press Shift+Tab or Ctrl+P there. */
const piChangesInPane: Script = {
  on: piOn,
  steps: [
    { goto: 9, env: "HERDR_ENV" },
    {
      transcript: [
        JSON.stringify({ type: "model_change", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", provider: "fake", modelId: "pi-fake" }),
        JSON.stringify({ type: "thinking_level_change", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", thinkingLevel: "medium" }),
      ],
    },
    ...piStart,
    ...piEnd("fake reply"),
    { goto: 2 },
    { wait: { type: "change" } },
    { transcript: [JSON.stringify({ type: "{{in.change}}", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", provider: "fake", modelId: "{{in.modelId}}", thinkingLevel: "{{in.level}}" })] },
    { goto: 9 },
  ],
};

test("what you change in pi's terminal stays with the slot once back, as if set with /effort or /model: the notice says so, and the next headless pi is set so", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { script: piChangesInPane } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  await each("/effort high");
  /** Switches w/p to the terminal, makes these changes there, and quits it once pi has written them down. */
  const changing = async (...changes: object[]) => {
    const n = (await texts()).filter((t) => t.includes("切到 TUI 了")).length;
    await say("/rh_tui");
    await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length > n, 15_000);
    await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
    const [pane] = (await snapshot()).panes;
    const file: string = pane.agent_session.value;
    const lines = readFileSync(file, "utf8").split("\n").length;
    for (const c of changes) await herdr("pane.send_input", { pane_id: pane.pane_id, text: JSON.stringify({ type: "change", ...c }), keys: ["enter"] });
    await until(() => readFileSync(file, "utf8").split("\n").length === lines + changes.length, 15_000);
    await quit(pane.pane_id);
  };
  /** The model and level the slot's newest headless pi was set to as it started. */
  const setTo = () => piRuns("w/p").at(-1)!.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "set_model" || m.type === "set_thinking_level").map(({ id, ...m }) => m);

  // Shift+Tab, down to off.
  await changing({ change: "thinking_level_change", level: "off" });
  expect(await posted("切回无头了")).toBe("w/p 切回无头了。\n已应用 TUI 中的设置：思考强度 off。");
  await each("/status");
  expect((await texts()).at(-1)).toContain("\n模型：默认 off\n");
  await say("back on the phone");
  await until(async () => (await replies()) === 2, 15_000);
  expect(setTo()).toEqual([{ type: "set_thinking_level", level: "off" }]);

  // Ctrl+P, on to pi-other, which resets the level to that model's: the model is kept, the slot's level stays.
  await changing({ change: "model_change", modelId: "pi-other" }, { change: "thinking_level_change", level: "low" });
  expect(await posted("模型 fake/pi-other")).toBe("w/p 切回无头了。\n已应用 TUI 中的设置：模型 fake/pi-other。");
  await say("on the phone again");
  await until(async () => (await replies()) === 3, 15_000);
  expect(setTo()).toEqual([
    { type: "set_model", provider: "fake", modelId: "pi-other" },
    { type: "set_thinking_level", level: "off" },
  ]);

  // Both remembered now: still told against what the terminal resumed from the session file.
  await changing({ change: "thinking_level_change", level: "high" });
  expect(await posted("思考强度 high")).toBe("w/p 切回无头了。\n已应用 TUI 中的设置：思考强度 high。");

  // /new there: pi starts the new session on your defaults, another model here, and writes them down
  // after the terminal started. They are not your change: the slot goes on with that session, keeping its own.
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 4, 15_000);
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  const moved = crypto.randomUUID();
  const file = join(dirname(pane.agent_session.value), `2026-10-24T08-00-00-000Z_${moved}.jsonl`);
  const timestamp = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: moved, timestamp, cwd: piRuns("w/p")[0]!.cwd },
    { type: "model_change", id: "a1", parentId: null, timestamp, provider: "fake", modelId: "pi-new" },
    { type: "thinking_level_change", id: "a2", parentId: "a1", timestamp, thinkingLevel: "medium" },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  await herdr("pane.report_agent_session", { pane_id: pane.pane_id, source: "herdr:pi", agent: "pi", agent_session_path: file });
  await Bun.sleep(1500); // read from the pane within a second
  await quit(pane.pane_id);
  expect(await posted("接着用")).toBe("w/p 切回无头了，接着用你在 TUI 里最后那段对话。");
}, 60_000);

/** As piChangesInPane, with pi in the pane on a new session writing down first what it started on:
 *  the slot's model, and off for the slot's high, as pi narrows a level to what the model takes. */
const piNarrowsInPane: Script = {
  on: piOn,
  steps: [
    { goto: piChangesInPane.steps.length, env: "HERDR_ENV" },
    ...piChangesInPane.steps.slice(1),
    {
      transcript: [
        JSON.stringify({ type: "model_change", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", provider: "fake", modelId: "pi-other" }),
        JSON.stringify({ type: "thinking_level_change", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", thinkingLevel: "off" }),
      ],
    },
    { goto: 9 },
  ],
};

test("stories 58, 544: pi's terminal on a session with nothing written down yet starts on the slot's /model and /effort; a change made there stays with the slot once back", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { script: piNarrowsInPane } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await each("/model pi-other", "/effort high", "/new");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  const session = sessionInDb("p")!;
  expect(piRuns("w/p").find((r) => !rpc(r))!.argv).toEqual(["--model", "fake/pi-other", "--thinking", "high", "--session-id", session]);
  // The new session's file has no settings of its own before the terminal: they are the slot's.
  await herdr("pane.send_input", { pane_id: pane.pane_id, text: JSON.stringify({ type: "change", change: "thinking_level_change", level: "low" }), keys: ["enter"] });
  await until(() => existsSync(pane.agent_session.value) && readFileSync(pane.agent_session.value, "utf8").includes(`"thinkingLevel":"low"`), 15_000);
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/p 切回无头了。\n已应用 TUI 中的设置：思考强度 low。");
}, 45_000);

test("pi's terminal on a new session, started on a level its model lacks, which pi narrows: with nothing changed there, nothing changes once back", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { script: piNarrowsInPane } });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await each("/model pi-other", "/effort high", "/new");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const [pane] = (await snapshot()).panes;
  await until(() => existsSync(pane.agent_session.value), 15_000);
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/p 切回无头了。");
}, 45_000);

/** Acts out a rhodium killed after starting the agent in the slot's tab, before it heard back; and restarts it. */
async function crashMidSwitch() {
  await rhodium.kill9();
  const db = new Database(join(rhodium.dir, "state/rh.db"));
  db.run("UPDATE slot SET herdrTab = NULL, herdrPane = NULL, tuiPid = NULL, tuiStart = NULL");
  db.run("UPDATE workspace SET herdrWorkspace = NULL");
  db.close();
  await rhodium.start();
}

test("story 107: a rhodium killed after starting pi in the slot's tab takes that pane over on restart, known by the session it reports, instead of opening another", async () => {
  const { pane, tui } = await piInTerminal();
  await crashMidSwitch();

  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 15_000);
  expect((await texts()).at(-1)).toContain("w 工作区的 p 标签页");
  expect(await rhodium.state("w/p")).toBe("TUI 模式");
  expect((await snapshot()).panes.map((p: any) => p.pane_id)).toEqual([pane.pane_id]);
  expect(alive(tui.pid)).toBe(true);
  expect(piRuns("w/p").filter((r) => !rpc(r))).toHaveLength(1);
  // Watched as before: quitting it puts the slot back.
  await quit(pane.pane_id);
  await posted("切回无头了");
  expect(await rhodium.state("w/p")).toBe("未运行");
}, 45_000);

test("story 107: a pi left in that pane that reports no session may have the conversation: on restart its tab is closed before another opens, so no two pis write it", async () => {
  // Herdr ignores a report from a pane it has not detected an agent in. Taking the pane over waits holdStartTimeout for one.
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/p" } }, pi: { herdrReport: false }, toml: '[durations]\nholdStartTimeout = "3s"' });
  await rhodium.ok("new", "w/p", "--agent", "pi");
  await say("hi");
  await posted("fake reply");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await until(() => piRuns("w/p").some((r) => !rpc(r)), 15_000);
  const [left] = (await snapshot()).panes;
  const tui = piRuns("w/p").find((r) => !rpc(r))!;
  await crashMidSwitch();

  // It waits holdStartTimeout for a report first.
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length === 2, 30_000);
  expect(alive(tui.pid)).toBe(false);
  const [pane, ...more] = (await snapshot()).panes;
  expect(more).toEqual([]);
  expect(pane.pane_id).not.toBe(left.pane_id);
  expect((await texts()).at(-1)).toContain("w 工作区的 p 标签页");
  expect(piRuns("w/p").filter((r) => !rpc(r))).toHaveLength(2);
}, 60_000);

/** obey, in an agent that ignores these signals. */
const ignoring = (...signals: NodeJS.Signals[]): Script => ({ on, steps: [...signals.map((ignore) => ({ ignore })), ...obey.steps.slice(0, -1), { goto: signals.length }] });
/** Asks for /rh_release and agrees. */
async function release() {
  await say("/rh_release");
  await posted("把 w/a 切回无头吗？");
  await say("1");
}

test("story 115: an agent that does not quit on its exit keys is ended with SIGTERM", async () => {
  await begin({ claude: { script: ignoring("SIGINT") }, toml: '[durations]\nreleaseGrace = "1s"' });
  const { agent } = await inTerminal();
  await release();
  await posted("切回无头了");
  expect(alive(agent.pid)).toBe(false);
  expect(await rhodium.state("w/a")).toBe("未运行");
  // The log says how, should an agent outlive its exit keys for a reason to look into.
  expect(await endedBy()).toBe("SIGTERM");
}, 30_000);

test("an agent that outlives /rh_release keeps the slot in the terminal and is still watched: once it goes, the slot is back", async () => {
  await begin({ claude: { script: ignoring("SIGINT", "SIGTERM") }, toml: '[durations]\nreleaseGrace = "1s"\nstopGrace = "1s"' });
  const { agent } = await inTerminal();
  await release();
  expect(await posted("没能切回无头")).toContain("没有退出");
  expect(alive(agent.pid)).toBe(true);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  process.kill(agent.pid, "SIGKILL");
  await posted("切回无头了");
  expect(await rhodium.state("w/a")).toBe("未运行");
}, 30_000);

test("story 115: rh release from your terminal ends the agent in the terminal at once, asking no one", async () => {
  await begin();
  const { agent } = await inTerminal();
  expect(await rhodium.ok("release", "w/a")).toBe("正在把 w/a 切回无头…\n");
  await posted("切回无头了");
  expect(alive(agent.pid)).toBe(false);
  expect(await endedBy()).toBe("exit keys");
  expect((await texts()).filter((t) => t.includes("切回无头吗？"))).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("未运行");
}, 30_000);

test("story 115: /rh_release asks you in IM; quitting the agent meanwhile closes that ask, so your next message reaches the agent", async () => {
  await begin();
  const { pane } = await inTerminal();
  await say("/rh_release");
  expect(await posted("把 w/a 切回无头吗？")).toContain("这会结束 TUI 里的 agent，对话留着接着用。");
  await quit(pane);
  await posted("切回无头了");
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
}, 30_000);

/** The claude runs Herdr's own auto-resume typed: `claude --resume <id>`, with none of the slot's variables. */
const resumedByHerdr = () => rhodium.claude.runs().filter((r) => r.argv[0] === "--resume" && !r.env.RHODIUM_SLOT);
/** Waits until rh ls shows the slot so. */
const shows = (ref: string, what: string) => until(async () => (await rhodium.ok("ls", ref)).includes(`状态: ${what}`), 15_000);

test("stories 116, 117: Herdr restarting takes the agent; meanwhile your messages hear so; once it is back, the tab goes before Herdr resumes the agent, and the slot is headless", async () => {
  await begin({ herdr: { resumeDelay: 1000 } });
  const { session, agent } = await inTerminal();
  await rhodium.herdr.stop();
  await shows("w/a", "Herdr 重启中");
  await until(() => !alive(agent.pid), 15_000); // Herdr's exit hangs it up; systemd reaps it a moment later
  const a = await card("a");
  expect([a.group, a.state]).toEqual(["running", "Herdr 重启中"]);
  await say("are you there?");
  await posted("Herdr 正在重启，这条没交给 w/a。等一会儿再发。");
  expect((await texts()).filter((t) => t.includes("在 TUI 里，这条没交给它"))).toEqual([]);

  await rhodium.herdr.start();
  expect(await posted("在 TUI 里的进程没了")).toBe("Herdr 重启了，w/a 在 TUI 里的进程没了，已经切回无头。");
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect((await snapshot()).tabs).toEqual([]);
  await Bun.sleep(1500); // past Herdr's own resume
  expect(resumedByHerdr()).toEqual([]);
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${session}`);
}, 45_000);

test("story 116: Herdr gone just as rhodium starts to watch it, the agent with it: the slot waits for Herdr, not switched back as if you quit", async () => {
  await begin({ herdr: { stopOnSubscribe: true } });
  await say("hi");
  await posted("done");
  await say("/rh_tui");
  await posted("切到 TUI 了");
  await shows("w/a", "Herdr 重启中");
  expect((await texts()).filter((t) => t.includes("切回无头了"))).toEqual([]);
}, 30_000);

test("story 116: Herdr away past durations.herdrRestartWait: the slot goes headless; once Herdr is back, the tab goes before Herdr resumes the agent beside the headless one", async () => {
  await begin({ herdr: { resumeDelay: 1000 }, toml: '[durations]\nherdrRestartWait = "2s"' });
  const { session } = await inTerminal();
  await rhodium.herdr.stop();
  await shows("w/a", "Herdr 重启中");
  expect(await posted("在 TUI 里的进程没了")).toBe("Herdr 重启了，w/a 在 TUI 里的进程没了，已经切回无头。");
  expect(await rhodium.state("w/a")).toBe("未运行");
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  const headless = runs("w/a").at(-1)!;
  expect(headless.argv).toContain(`--resume=${session}`);

  await rhodium.herdr.start();
  await Bun.sleep(1500); // past Herdr's own resume
  expect((await snapshot()).tabs).toEqual([]);
  expect(resumedByHerdr()).toEqual([]);
  expect(alive(headless.pid)).toBe(true);
}, 45_000);

test("story 116: the wait for Herdr counts from when it went, across a restart of rhodium", async () => {
  await begin({ toml: '[durations]\nherdrRestartWait = "4s"' });
  await inTerminal();
  await rhodium.herdr.stop();
  await shows("w/a", "Herdr 重启中");
  await rhodium.stop();
  await Bun.sleep(4000);
  await rhodium.start();
  const restarted = Date.now();
  expect(await posted("在 TUI 里的进程没了")).toBe("Herdr 重启了，w/a 在 TUI 里的进程没了，已经切回无头。");
  expect(Date.now() - restarted).toBeLessThan(3000);
  expect(await rhodium.state("w/a")).toBe("未运行");
}, 45_000);

test("Herdr resumed the agent itself while rhodium was away: the slot stays in the terminal with no notice, and quitting that agent puts it back, keeping none of its settings", async () => {
  await begin({ herdr: { resumeDelay: 300 }, claude: { script: ultracodeInPane } });
  await each("/effort medium");
  const { session } = await inTerminal();
  await rhodium.stop();
  await rhodium.herdr.stop();
  await rhodium.herdr.start();
  await until(() => resumedByHerdr().length === 1, 15_000);
  const resumed = resumedByHerdr()[0]!;
  expect(resumed.argv).toEqual(["--resume", session]);
  const told = (await texts()).length;

  await rhodium.start();
  await Bun.sleep(1500);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  expect((await texts()).slice(told)).toEqual([]);
  expect(alive(resumed.pid)).toBe(true);
  // Watched as its own: it goes, and the slot is back. Herdr's shell stays after it, until the tab is closed.
  // Launched with none of the slot's settings, it runs at your default: what it ran at tells nothing of yours.
  // It has no rh socket, Herdr's restored pane having none of the tab's variables: its turn is seen in the transcript.
  const [pane] = (await snapshot()).panes;
  await typeInto(pane.pane_id, "go");
  const file = join(rhodium.home, ".claude/projects", claudeProjectDir(resumed.cwd), `${session}.jsonl`);
  await until(() => readFileSync(file, "utf8").includes("ultra_effort_enter"), 15_000);
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。");
  expect((await snapshot()).tabs).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("未运行");
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toEqual(expect.arrayContaining(["--effort", "medium"]));
}, 45_000);

test("Herdr resumed, while rhodium was away, the conversation you had moved to in the terminal: the slot stays in the terminal with that agent, and goes on with that conversation once back", async () => {
  await begin({ herdr: { resumeDelay: 300 } });
  const { pane } = await inTerminal();
  const second = crypto.randomUUID();
  await moveTo(pane, second, join(rhodium.dir, "w"));
  await rhodium.stop();
  await rhodium.herdr.stop();
  await rhodium.herdr.start();
  await until(() => resumedByHerdr().length === 1, 15_000);
  const resumed = resumedByHerdr()[0]!;
  expect(resumed.argv).toEqual(["--resume", second]);
  const told = (await texts()).length;

  await rhodium.start();
  await Bun.sleep(1500);
  expect(await rhodium.state("w/a")).toBe("TUI 模式");
  expect((await texts()).slice(told)).toEqual([]);
  expect(alive(resumed.pid)).toBe(true);
  await quit(pane);
  expect(await posted("切回无头了")).toBe("w/a 切回无头了，接着用你在 TUI 里最后那段对话。");
  await say("on the phone");
  await until(async () => (await dones()) === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${second}`);
}, 45_000);

test("Herdr restarted while rhodium was away, resuming pi itself, which rhodium cannot tell from its command line: once back, rhodium closes that pane and you hear of it as of a fault (architecture §10.2)", async () => {
  const { pane } = await piInTerminal({ herdr: { resumeDelay: 300 } });
  await rhodium.stop();
  await rhodium.herdr.stop();
  await rhodium.herdr.start();
  const byHerdr = () => rhodium.pi.runs().filter((r) => !r.env.RHODIUM_SLOT);
  await until(() => byHerdr().length === 1, 15_000);
  const resumed = byHerdr()[0]!;
  expect(resumed.argv).toEqual(["--session", pane.agent_session.value]);

  await rhodium.start();
  expect(await posted("在 TUI 里的进程没了")).toBe("Herdr 重启了，w/p 在 TUI 里的进程没了，已经切回无头。");
  expect((await texts()).filter((t) => t.startsWith("w/p 切回无头了"))).toEqual([]);
  expect(alive(resumed.pid)).toBe(false);
  expect(await rhodium.state("w/p")).toBe("未运行");
  expect((await snapshot()).tabs).toEqual([]);
}, 45_000);

test("the agent in the terminal quit while rhodium was away: once back, the slot is headless, with no word of Herdr", async () => {
  await begin();
  const { pane } = await inTerminal();
  await rhodium.stop();
  await quit(pane);
  await until(async () => (await snapshot()).tabs.length === 0, 15_000);
  await rhodium.start();
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。");
}, 45_000);

test("another process has the conversation once the agent in the terminal is gone: the slot waits for you, in 需要你 on the board, and /rh_release tries again, keeping what you set there", async () => {
  await begin({ claude: { script: ultracodeInPane } });
  await each("/effort medium");
  const { session, pane } = await inTerminal();
  await typeInto(pane, plan(["send", "me", "in the terminal"]));
  await posted("in the terminal");
  // Say you resumed it by hand in a terminal of your own meanwhile.
  const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)", "--resume", session]);
  try {
    await quit(pane);
    const failed = await posted("没能切回无头");
    expect(failed).toContain("\n原因：另一个进程正在用这段对话");
    const retry = [{ label: "再试一次", data: "/rh_release w/a" }];
    const buttons = async (text: string) => (await rhodium.im.log("q", ME)).find((p) => p.text === text)!.buttons;
    expect(await buttons(failed)).toEqual(retry);
    expect(await card("a")).toMatchObject({ group: "needsYou", state: "没能切回无头" });
    await say("are you there?");
    expect(await buttons(await posted("w/a 没能切回无头，这条没交给它。"))).toEqual(retry);
    expect(runs("w/a").filter((r) => !inPane(r))).toHaveLength(1);
  } finally {
    other.kill();
    await other.exited;
  }
  await say("/rh_release");
  await posted("把 w/a 切回无头吗？");
  await say("1");
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。\n已应用 TUI 中的设置：思考强度 xhigh，ultracode 开。");
  expect(await rhodium.state("w/a")).toBe("未运行");
}, 45_000);

test("the conversation you moved to in the terminal is another slot's: the slot goes back to its own, so no two slots resume one conversation", async () => {
  await begin();
  await rhodium.ok("send", "w/b", "hi");
  await until(async () => (await rhodium.state("w/b")) === "空闲", 15_000);
  await rhodium.ok("stop", "w/b");
  await until(async () => (await rhodium.state("w/b")) === "未运行", 15_000);
  const theirs = sessionOf("w/b");
  const { session, pane } = await inTerminal();
  await moveTo(pane, theirs);
  await Bun.sleep(1500);
  await quit(pane);
  expect(await posted("切回无头了")).toBe("w/a 切回无头了。你在 TUI 里最后用的那段对话是 w/b 的，它接着用原来那段。");
  expect(await rhodium.state("w/a")).toBe("未运行");
  await rhodium.ok("send", "w/a", "one");
  await rhodium.ok("send", "w/b", "two");
  await until(() => runs("w/a").filter((r) => !inPane(r)).length === 2 && runs("w/b").length === 2, 15_000);
  expect(runs("w/a").at(-1)!.argv).toContain(`--resume=${session}`);
  expect(runs("w/b").at(-1)!.argv).toContain(`--resume=${theirs}`);
}, 45_000);

// ---- Codex's terminal (spec codex.md, stories 503-506; architecture §10.3) ----

/** The codex runs of the slot, oldest first: headless ones run its app-server, a pane's `codex resume`. */
const cxRuns = (ref: string) => rhodium.codex.runs().filter((r) => r.env.RHODIUM_SLOT === ref);
const cxPane = (r: Run) => r.argv[0] !== "app-server";
/** The threads the slot's headless runs went on with, by what each was sent. */
const threads = (ref: string) =>
  cxRuns(ref)
    .filter((r) => !cxPane(r))
    .map((r) => r.stdin.map((l) => JSON.parse(l)).find((m) => m.method === "turn/start" || m.method === "thread/resume")?.params.threadId);
/** Codex's record of the thread in the sandbox's CODEX_HOME. */
const rollout = (thread: string) => [...new Bun.Glob(`**/*-${thread}.jsonl`).scanSync({ cwd: join(rhodium.home, ".codex/sessions"), absolute: true })][0]!;
/** Writes down a turn's settings as Codex does at each turn's start (architecture §6.4). */
const ranOn = (thread: string, model: string, effort: string) =>
  appendFileSync(rollout(thread), JSON.stringify({ timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: crypto.randomUUID(), model, effort, approval_policy: "never" } }) + "\n");
/** Types a turn into the pane's codex, as you would at its prompt. */
const turnIn = (pane: string, thread: string) =>
  herdr("pane.send_input", { pane_id: pane, text: JSON.stringify({ method: "turn/start", id: 1, params: { threadId: thread, input: [{ type: "text", text: "in the terminal" }] } }), keys: ["enter"] });
const cxReplies = async () => (await texts()).filter((t) => t === "fake reply").length;

/** The Codex slot w/x, which bot q goes to, after one turn; returns its directory and thread. */
async function codexSlot(): Promise<{ dir: string; thread: string }> {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/x" } } });
  await rhodium.ok("new", "w/x", "--agent", "codex");
  await say("hi");
  await posted("fake reply");
  return { dir: cxRuns("w/x")[0]!.cwd, thread: threads("w/x")[0]! };
}
/** Switches w/x to the terminal; returns its pane's codex run and pane id. */
async function cxLaunched(): Promise<{ run: Run; pane: string }> {
  const n = cxRuns("w/x").filter(cxPane).length;
  const told = (await texts()).filter((t) => t.includes("切到 TUI 了")).length;
  await say("/rh_tui");
  await until(async () => (await texts()).filter((t) => t.includes("切到 TUI 了")).length > told, 15_000);
  await until(() => cxRuns("w/x").filter(cxPane).length > n, 15_000);
  return { run: cxRuns("w/x").filter(cxPane).at(-1)!, pane: (await snapshot()).panes[0].pane_id };
}
/** What the slot's terminal ends with after its settings: no update or folder-trust prompt, for this launch alone. */
const quiet = (dir: string) => ["-c", "check_for_update_on_startup=false", "-c", `projects={${JSON.stringify(dir)}={trust_level="trusted"}}`];

test("stories 503, 504: /rh_tui opens the slot's thread in codex, on no shared app-server, asking nothing with approval off; told once Herdr names codex, before its hook reports the thread; quitting there puts the slot back on it", async () => {
  const { dir, thread } = await codexSlot();
  await say("/rh_tui");
  await posted("切到 TUI 了");
  // Your Codex hook reports the thread only at the first turn: the switch did not wait for it.
  const [pane] = (await snapshot()).panes;
  expect(pane.agent).toBe("codex");
  expect(pane.agent_session).toBeUndefined();
  const calls: { method: string }[] = (await herdr("fake.calls")).calls;
  const looks = calls.slice(calls.findIndex((c) => c.method === "layout.apply")).filter((c) => c.method === "pane.get");
  expect(looks.length).toBeLessThan(10); // not polled for the 3 s a session report is waited for
  await until(() => cxRuns("w/x").some(cxPane), 15_000); // its log may come after Herdr names it
  const run = cxRuns("w/x").find(cxPane)!;
  expect(run.argv).toEqual(["resume", thread, "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", ...quiet(dir)]);
  expect(run.cwd).toBe(dir);
  expect(Object.keys(run.env).filter((k) => /^(ANTHROPIC_|CLAUDE)/.test(k))).toEqual([]);
  expect(run.env.HERDR_PANE_ID).toBe(pane.pane_id); // your hook reports with it

  await turnIn(pane.pane_id, thread);
  await until(async () => (await snapshot()).panes[0]?.agent_session?.value === thread, 15_000);
  await quit(pane.pane_id);
  expect(await posted("切回无头了")).toBe("w/x 切回无头了。");
  await say("back on the phone");
  await until(async () => (await cxReplies()) === 2, 15_000);
  expect(threads("w/x")).toEqual([thread, thread]);
}, 45_000);

test("stories 506, 544: /rh_tui on a Codex thread with no turn written down, which codex resume cannot open, starts a new codex in the terminal instead", async () => {
  // Codex opens the thread, then turns your message away: no turn, so no record.
  const refusing: Script = { on: [{ match: { method: "turn/start" }, emit: [JSON.stringify({ error: { code: -32600, message: "refused" }, id: "{{in.id}}" })] }, ...codexOn!], steps: [] };
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/x" } }, codex: { script: refusing } });
  await rhodium.ok("new", "w/x", "--agent", "codex");
  await say("hi");
  await until(() => cxRuns("w/x").some((r) => r.stdin.some((l) => l.includes("turn/start"))), 15_000);
  await until(async () => (await rhodium.state("w/x")) === "空闲", 15_000);
  const { run } = await cxLaunched();
  expect(run.argv).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", ...quiet(run.cwd)]);
  expect(sessionInDb("x")).toBeNull();
}, 30_000);

test("story 545: a Codex slot with no conversation yet starts a new codex in the terminal; quit before a turn, it still has none; after a turn there, it goes on with the thread Herdr reported once back", async () => {
  await begin({ bots: { q: { like: "qq", owner: ME, target: "w/x" } } });
  await rhodium.ok("new", "w/x", "--agent", "codex");
  let { run, pane } = await cxLaunched();
  expect(run.argv).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", ...quiet(run.cwd)]);
  await quit(pane);
  await posted("切回无头了");
  expect(sessionInDb("x")).toBeNull();

  ({ pane } = await cxLaunched());
  await turnIn(pane, "");
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  const thread = (await snapshot()).panes[0].agent_session.value;
  await Bun.sleep(1500); // rhodium's next look at the pane
  await quit(pane);
  await until(async () => (await texts()).filter((t) => t.includes("切回无头了")).length === 2, 15_000);
  expect((await texts()).filter((t) => t.includes("切回无头了"))[1]).toBe("w/x 切回无头了。");
  expect(sessionInDb("x")).toBe(thread);
  // The thread went on the slot's one conversation: its timeline has that one alone.
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT c.sessionId FROM conversation c JOIN slot s ON s.id = c.slot WHERE s.name = 'x'").all()).toEqual([{ sessionId: thread }]);
  db.close();
  await say("back on the phone");
  await posted("fake reply");
  expect(threads("w/x")).toEqual([thread]);
}, 45_000);

test("story 505: a model or level you switch to in Codex's terminal, then run a turn on, stays with the slot once back, as for Claude; the terminal then starts with them, and with approval on asks on its own judgement", async () => {
  const { dir, thread } = await codexSlot();
  ranOn(thread, "gpt-fake", "medium"); // the headless turn, on your defaults
  await say("/model"); // Codex's models' names, for the notice
  await until(() => cxRuns("w/x").some((r) => r.stdin.some((l) => l.includes("model/list"))), 15_000);

  // A model there: kept, by its name as Codex has it, told by its display name, not the level it ran at.
  let { run, pane } = await cxLaunched();
  expect(run.argv).toEqual(["resume", thread, "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", ...quiet(dir)]);
  await turnIn(pane, thread);
  await until(async () => (await snapshot()).panes[0]?.agent_session !== undefined, 15_000);
  ranOn(thread, "gpt-6-luna", "medium");
  await quit(pane);
  expect(await posted("切回无头了")).toBe("w/x 切回无头了。\n已应用 TUI 中的设置：模型 GPT-6-Luna。");

  // A level there, against the turn before the terminal, as the slot has none.
  ({ run, pane } = await cxLaunched());
  expect(run.argv).toEqual(["resume", thread, "--no-daemon", "-m", "gpt-6-luna", "--dangerously-bypass-approvals-and-sandbox", ...quiet(dir)]);
  ranOn(thread, "gpt-6-luna", "high");
  await rhodium.ok("set", "w/x", "approval=on");
  await quit(pane);
  await until(async () => (await texts()).filter((t) => t.includes("切回无头了")).length === 2, 15_000);
  expect((await texts()).filter((t) => t.includes("切回无头了"))[1]).toBe("w/x 切回无头了。\n已应用 TUI 中的设置：思考强度 high。");

  // Nothing run there: nothing kept.
  ({ run, pane } = await cxLaunched());
  expect(run.argv).toEqual(["resume", thread, "--no-daemon", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=high", "-a", "on-request", "-s", "danger-full-access", ...quiet(dir)]);
  await quit(pane);
  await until(async () => (await texts()).filter((t) => t.includes("切回无头了")).length === 3, 15_000);
  expect((await texts()).filter((t) => t.includes("切回无头了"))[2]).toBe("w/x 切回无头了。");
}, 60_000);
