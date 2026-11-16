// Your own messages from IM and the board typed into a slot's terminal (stories 617, 621-624, 626,
// docs/spec/tui-user-input.md, architecture §10.5): the slot's type-in switch, what is not typed and
// why, what you hear when it cannot go in at once or is not known to have got there, and the queue on
// the board. The fake Herdr's pane shows Claude's screens recorded in test/fixtures/herdr.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inBox, inputState } from "../src/tui";
import { claudeProjectDir, type Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { call } from "./fake-herdr/fake-herdr";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance } from "./instance";

type Screen = { name: string; status: string; typed?: string; text: string };
const load = (file: string): Record<string, Screen> =>
  Object.fromEntries(
    readFileSync(join(import.meta.dir, "fixtures/herdr", file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [JSON.parse(l).name, JSON.parse(l)]),
  );
const plain = load("claude-screens.jsonl");
const typed = load("claude-typed-screens.jsonl");

test("story 626: a picture's line, [图片] and its path, typed into Claude, Codex or pi shows as typed in the box, no image placeholder: the look before Enter takes it (probe 4, 2026-11-16)", () => {
  for (const [agent, file] of [["claude", "claude-typed-screens.jsonl"], ["codex", "codex-screens.jsonl"], ["pi", "pi-screens.jsonl"]] as const) {
    const s = load(file)["image-path-typed"]!;
    expect(s.typed!.split("\n").at(-1)).toStartWith("[图片] /");
    expect([agent, inBox(agent, s.text, s.typed!), inputState(agent, s.status, s.text)]).toEqual([agent, true, "draft"]);
  }
});

const ME = "you-openid";
const obey: Script = { on, steps: [...startTurn, ...endTurn("done"), { goto: 0 }] };
let rhodium: Instance;
let board = "";
afterEach(() => rhodium?.cleanup());

/** An instance with a fake Herdr whose bot q goes to w/a, w/a switched to the terminal by /rh_tui after a
 *  turn, its pane showing a recorded Claude screen; defaults.typeIn left on, its default, unless told otherwise. Returns the
 *  pane, the transcript file of its session, and the slot's id. */
async function inTerminal({ typeIn = true, screen = "empty-bare", held = "3s" } = {}) {
  const toml = `[durations]\ntuiHeld = "${held}"\ntuiConfirm = "3s"\n${typeIn ? "" : "[defaults]\ntypeIn = false"}`;
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey }, herdr: true, toml });
  const daemon = await rhodium.start();
  board = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  await say("hi");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const session = rhodium.claude.runs()[0]!.argv.find((a) => a.startsWith("--session-id="))!.slice("--session-id=".length);
  await say("/rh_tui");
  await until(async () => (await rhodium.state("w/a")) === "TUI 模式" && (await sent()).some((t) => t.includes("切到 TUI 了")), 15_000);
  const pane = (await herdr("session.snapshot")).snapshot.panes[0].pane_id as string;
  await show(pane, screen, "idle");
  await until(() => rows("SELECT tuiInput FROM slot")[0]?.tuiInput === (screen === "draft" ? "draft" : "ready"), 10_000);
  const groups = (await fromBoard("/api/board")).workspaces[0].groups;
  const slot = (Object.values(groups).flat() as { id: string; name: string }[]).find((c) => c.name === "a")!.id;
  const file = join(rhodium.home, ".claude/projects", claudeProjectDir(join(rhodium.dir, "w")), `${session}.jsonl`);
  return { pane, file, slot };
}
const say = (text: string, more: object = {}) => rhodium.im.inject("q", { chat: ME, sender: ME, text, ...more });
const herdr = async (method: string, params: object = {}) => (await call(rhodium.herdr.socket, method, params)).result;
const fromBoard = async (path: string) => (await fetch(board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
const show = (pane: string, screen: string, status: string) => herdr("fake.set_screen", { pane_id: pane, text: plain[screen]?.text ?? typed[screen]?.text ?? screen, status });
const calls = async (method: string) => ((await herdr("fake.calls")).calls as { method: string; params: any }[]).filter((c) => c.method === method);
const queue = async (slot: string) => (await fromBoard(`/api/slot?id=${slot}`)).queue as { id: string; text: string; from: string; via?: string; wait?: string; unsure?: true }[];
/** What the bot sent to your chat since the n-th message. */
const sent = async (n = 0) => (await rhodium.im.log("q", ME)).slice(n).map((p) => p.text);
function write(file: string, ...lines: object[]) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.map((l) => JSON.stringify({ timestamp: new Date().toISOString(), ...l }) + "\n").join(""));
}
const userLine = (content: string) => ({ type: "user", message: { role: "user", content } });
function rows(sql: string): any[] {
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

test("stories 617, 621: type-in on, your IM message goes into the terminal, its source line first, and you get no reply; switched off with rh set, the next is refused as ever and nothing is typed; the switch-over notice says which", async () => {
  const { pane, file, slot } = await inTerminal();
  expect((await sent()).find((t) => t.includes("切到 TUI 了"))).toEndWith("在 TUI 里退出 agent，它会自动切回无头。这之前，这里的消息会打进终端，回复照常发回这里。");
  const n = (await sent()).length;
  await say("看下测试为什么挂了");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await calls("pane.send_input"))[0]!.params).toEqual({ pane_id: pane, text: "[来自 假 IM 私聊]\n看下测试为什么挂了", keys: [] });
  // Typed in is not yet you writing to the slot there (product §5.9); its trace is.
  const at = () => rows("SELECT slot.imAt, chat.contactedAt FROM slot, chat")[0] as { imAt: number; contactedAt: number };
  const before = at();
  write(file, userLine("[来自 假 IM 私聊]\n看下测试为什么挂了"));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  expect(at().imAt).toBeGreaterThan(before.imAt);
  expect(at().contactedAt).toBeGreaterThan(before.contactedAt);
  expect(await sent(n)).toEqual([]);
  await rhodium.ok("set", "w/a", "type-in=off");
  await say("这条不打");
  await until(async () => (await sent(n)).length === 1, 5_000);
  expect((await sent(n))[0]).toBe("w/a 在 TUI 里，这条没交给它。发 /rh_release 把它切回无头。");
  await Bun.sleep(1500);
  expect((await calls("pane.send_input")).length).toBe(1);
  // The board's settings show it, off now, its default on here.
  expect((await fromBoard(`/api/slot?id=${slot}`)).settings.find((s: { key: string }) => s.key === "type-in")).toMatchObject({ label: "你的消息打进终端", kind: "flag", value: 0, default: 1 });
}, 60_000);

test("story 621: with defaults.typeIn switched off, your IM message to a slot in the terminal is refused as before, and the switch-over notice says so", async () => {
  const { slot } = await inTerminal({ typeIn: false });
  expect((await sent()).find((t) => t.includes("切到 TUI 了"))).toEndWith("这之前，这里的消息不会交给它。");
  const n = (await sent()).length;
  await say("no");
  await until(async () => (await sent(n)).length === 1, 5_000);
  expect((await sent(n))[0]).toStartWith("w/a 在 TUI 里，这条没交给它。");
  expect(await queue(slot)).toEqual([]);
}, 60_000);

test("story 622: / and ! messages are not typed and you are told why, a full-width ！ and a bare ! too; /status is still Rhodium's to answer", async () => {
  const { slot } = await inTerminal();
  const n = (await sent()).length;
  const slash = "w/a 在终端里，/ 开头的命令不打进终端，这条没交给它。到终端里自己打，或者发 /rh_release 把它切回无头。";
  const bang = "w/a 在终端里，! 开头在 IM 里是打断再发，终端里 Rhodium 不替你打断，这条没交给它。去掉 ! 再发；要打断，到终端里按 Esc。";
  for (const [i, text] of ["/compact", "/model x", "!停一下", "！停一下", "!"].entries()) {
    await say(text);
    await until(async () => (await sent(n)).length === i + 1, 5_000);
    expect([text, (await sent(n))[i]]).toEqual([text, text.startsWith("/") ? slash : bang]);
  }
  await say("/status");
  await until(async () => (await sent(n)).length === 6, 5_000);
  expect((await sent(n))[5]).toContain("w/a");
  expect((await sent(n))[5]).not.toContain("没交给它");
  await Bun.sleep(1500);
  expect(await calls("pane.send_input")).toEqual([]);
  expect(await queue(slot)).toEqual([]);
}, 60_000);

test("stories 623, 626: with text in the box, your message waits and you hear once what for; a second waits unsaid; the box empty, both go in, type-in switched off meanwhile, one with a quote and a picture as its source line, quote, words and the picture's path; the board lists them as yours with the chat", async () => {
  const { pane, file, slot } = await inTerminal({ screen: "draft", held: "1m" });
  const n = (await sent()).length;
  await say("第一条");
  await until(async () => (await sent(n)).length === 1, 5_000);
  expect((await sent(n))[0]).toBe("w/a 在终端里，这条先排着：输入框里有没发出去的字。空出来就打进去，回复照常发回这里。");
  await say("图里是什么", { quote: { ref: "earlier", text: "上一句" }, attachments: [{ kind: "image", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) }] });
  await until(async () => (await queue(slot)).length === 2, 5_000);
  expect(await queue(slot)).toMatchObject([
    { text: "第一条", from: "你", via: "假 IM 私聊", wait: "等输入框空出来" },
    { from: "你", via: "假 IM 私聊", wait: "等输入框空出来" },
  ]);
  await Bun.sleep(1500);
  expect(await sent(n)).toHaveLength(1);
  expect(await calls("pane.send_input")).toEqual([]);
  // Switched off meanwhile: what waits already still goes in, as the switch is read only as a message comes.
  await rhodium.ok("set", "w/a", "type-in=off");
  await show(pane, "empty-bare", "idle");
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  write(file, userLine("[来自 假 IM 私聊]\n第一条"));
  await until(async () => (await calls("pane.send_keys")).length === 2, 10_000);
  const second: string = (await calls("pane.send_input"))[1]!.params.text;
  const [line, quote, blank, words, picture, more] = second.split("\n");
  expect([line, quote, blank, words, more]).toEqual(["[来自 假 IM 私聊]", "> 上一句", "", "图里是什么", undefined]);
  expect(picture).toMatch(new RegExp(`^\\[图片\\] ${join(rhodium.dir, "state/media/")}\\S+$`));
  write(file, userLine(second));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  expect(await sent(n)).toHaveLength(1);
}, 60_000);

test("story 624: yours typed in and not known to have got there is told at once in its chat by your own words, not after durations.tuiHeld, and once; with the box still holding it, it says so", async () => {
  const { pane, slot } = await inTerminal({ held: "1m" });
  const n = (await sent()).length;
  // A dialog over it as it goes in: no Enter, unknown at once.
  await herdr("fake.on_input", { pane_id: pane, text: typed["typed-then-permission-renamed"]!.text, status: "blocked" });
  // Your words alone are quoted, not the message you quoted nor the picture's line (im-style §6.7).
  await say("在不在", { quote: { ref: "earlier", text: "很长的一段被引用的话。".repeat(20) }, attachments: [{ kind: "image", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) }] });
  await until(async () => (await sent(n)).length === 1, 10_000);
  expect((await sent(n))[0]).toBe("打进 w/a 终端的这条尚未确认收到，没有再发：\n“在不在”\n要再发，到网页上点“重发”。");
  // The look before Enter hangs once: the box holds it when you are told.
  await show(pane, "empty-bare", "idle");
  await herdr("fake.fail", { method: "pane.read", how: "hang", times: 1, after: "pane.send_input" });
  await say("还在吗");
  await until(async () => (await sent(n)).length === 2, 10_000);
  expect((await sent(n))[1]).toBe("打进 w/a 终端的这条尚未确认收到，没有再发：\n“还在吗”\n它还在输入框里，到终端里按回车发出去，或者删掉。");
  await Bun.sleep(4000); // past durations.tuiConfirm: no second notice
  expect(await sent(n)).toHaveLength(2);
  expect((await queue(slot)).map((q) => q.unsure)).toEqual([true, true]);
}, 60_000);

test("story 617: from the board, your message to a slot in the terminal with type-in on goes into its queue, [来自 网页] first, and is typed in", async () => {
  const { pane, slot } = await inTerminal();
  const r = await (await boardAct(board, { kind: "say", slot, text: "网页来的" })).json();
  expect(r.ok).toBe(true);
  await until(async () => (await calls("pane.send_input")).length === 1, 10_000);
  expect((await calls("pane.send_input"))[0]!.params).toEqual({ pane_id: pane, text: "[来自 网页]\n网页来的", keys: [] });
  expect(await queue(slot)).toMatchObject([{ text: "网页来的", from: "你", via: "网页", wait: "正在打进去" }]);
}, 60_000);

test("story 631: from the board, a / or ! command goes into Claude's terminal bare, as typed, one after another; the queue lists it as yours from the board; /rh_ ones stay Rhodium's, a lone / or ! and a full-width ！ are refused as before; from IM they still are", async () => {
  const { pane, file, slot } = await inTerminal();
  const said = async (text: string) => (await (await boardAct(board, { kind: "say", slot, text })).json()) as { ok: boolean; text?: string; error?: string };
  expect(await said("  /greet hello world ")).toMatchObject({ ok: true, text: "排进终端" });
  await until(async () => (await calls("pane.send_keys")).length === 1, 10_000);
  expect((await calls("pane.send_input"))[0]!.params).toEqual({ pane_id: pane, text: "/greet hello world", keys: [] });
  expect(await queue(slot)).toMatchObject([{ text: "/greet hello world", from: "你", via: "网页", wait: "正在打进去" }]);
  write(file, userLine("<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>hello world</command-args>"));
  await until(async () => (await queue(slot)).length === 0, 5_000);
  expect(await said("!echo hi")).toMatchObject({ ok: true });
  await until(async () => (await calls("pane.send_input")).length === 2, 10_000);
  expect((await calls("pane.send_input"))[1]!.params.text).toBe("!echo hi");
  const slash = "w/a 在终端里，/ 开头的命令不打进终端，这条没交给它。到终端里自己打，或者点顶栏“⋯”里的“收回终端”把它切回无头。";
  const bang = "w/a 在终端里，! 开头是打断再发，终端里 Rhodium 不替你打断，这条没交给它。去掉 ! 再发；要打断，到终端里按 Esc。";
  for (const [text, error] of [["/", slash], ["！停一下", bang]] as const) expect([text, await said(text)]).toEqual([text, { ok: false, error }]);
  expect((await said("/rh_ls")).text).toBe("槽位都在首页和拓扑图上。");
  const n = (await sent()).length;
  await say("/greet from im");
  await until(async () => (await sent(n)).length === 1, 5_000);
  expect((await sent(n))[0]).toStartWith("w/a 在终端里，/ 开头的命令不打进终端");
  await Bun.sleep(1500);
  expect((await calls("pane.send_input")).length).toBe(2);
}, 60_000);

test("#737: from the board, /status to a Claude slot in the terminal, type-in on, is Rhodium's to answer, as from IM: its status card, nothing typed", async () => {
  const { slot } = await inTerminal();
  const r = await (await boardAct(board, { kind: "say", slot, text: "/status" })).json();
  expect(r).toMatchObject({ ok: true, card: { command: "status", ref: "w/a", agent: "claude" } });
  await Bun.sleep(1500);
  expect(await calls("pane.send_input")).toEqual([]);
  expect(await queue(slot)).toEqual([]);
}, 60_000);

test("#737: from the board, a ! command with a file or picture is refused, as the shell would run their lines as commands; nothing typed", async () => {
  const { slot } = await inTerminal();
  const form = new FormData();
  form.set("id", crypto.randomUUID());
  form.set("slot", slot);
  form.set("text", "!wc -l");
  form.append("file", new File(["log"], "build-log.txt", { type: "text/plain" }));
  const r = await (await fetch(`${board}/api/send`, { method: "POST", headers: { "Tailscale-User-Login": BOARD_LOGIN, "sec-fetch-site": "same-origin" }, body: form })).json();
  expect(r).toEqual({ ok: false, error: "w/a 在终端里，! 开头的 bash 命令带不了图片和文件，这条没交给它。去掉附件再发。" });
  await Bun.sleep(1500);
  expect(await calls("pane.send_input")).toEqual([]);
  expect(await queue(slot)).toEqual([]);
}, 60_000);
