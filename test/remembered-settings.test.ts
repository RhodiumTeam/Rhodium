// /model and /effort stay with the slot (product §5.6): every new agent process the slot starts gets
// them again, until you set the default or switch agents. Seen from seam one, with fake agents.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Posted } from "../src/fake-im";
import { updateClaude } from "./claude-update";
import { installFakeAgent, type Run } from "./fake-agent/fake-agent";
import { crashing } from "./fake-agent/scripts";
import { newInstance, until, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** A rhodium whose bot q sends your private chat to the slot w/a, run by agent; lists come numbered. */
async function slot(agent: "claude" | "pi", opts: InstanceOptions = {}): Promise<void> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a", buttons: "false" } }, ...opts });
  await rhodium.start();
  const dir = join(rhodium.dir, "a");
  mkdirSync(dir);
  await rhodium.ok("ws", "w", dir);
  await rhodium.ok("new", "w/a", "--agent", agent);
}

const say = (text: string) => rhodium.im.inject("q", { chat: ME, sender: ME, text });

/** Waits until the bot has posted n messages in your chat, and returns their text. */
async function posts(n: number): Promise<string[]> {
  await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
  return (await rhodium.im.log("q", ME)).map((p: Posted) => p.text);
}

/** Says each command and waits for its reply, one at a time. */
async function each(...commands: string[]): Promise<void> {
  for (const c of commands) {
    const before = (await rhodium.im.log("q", ME)).length;
    await say(c);
    await posts(before + 1);
  }
}

const off = () => until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
const stop = async () => (await rhodium.ok("stop", "w/a"), off());
/** What the run was written, parsed. */
const sent = (run: Run) => run.stdin.map((l) => JSON.parse(l));
const flagOf = (run: Run, name: string) => (run.argv.includes(name) ? run.argv[run.argv.indexOf(name) + 1] : undefined);

test("Claude: /model and /effort outlive an idle reap: the next process starts with both, and /effort there shows it", async () => {
  await slot("claude", { toml: '[durations]\nidleReap = "1s"' });
  await each("hello", "/model 2", "/effort high");
  await off();
  await each("/status");
  // The model by the name the last handshake gave it, not the alias it was launched with (docs/im-style.md §2.4).
  expect((await posts(4))[3]).toContain("未运行，来消息就启动\n\n模型设置\nAgent：Claude Code\n模型：Haiku high\n");

  await each("again", "/effort");
  const [reply, effort] = (await posts(6)).slice(4);
  expect(reply).toBe("fake reply");
  expect(effort).toContain("\n现在：high\n");
  const last = rhodium.claude.runs().at(-1)!;
  expect(flagOf(last, "--model")).toBe("haiku");
  expect(flagOf(last, "--effort")).toBe("high");
}, 30_000);

test("Claude: /status names a remembered model, while no process runs, by the last handshake's list, rh doctor's included", async () => {
  await slot("claude");
  await each("/model haiku");
  await stop();
  // Claude was upgraded meanwhile, and rh doctor met the new one first: its Haiku has a new name.
  updateClaude(rhodium, "2.1.305", { extra: { models: [{ value: "haiku", displayName: "Haiku 9" }] } });
  await rhodium.ok("doctor");
  await each("/status");
  expect((await posts(2))[1]).toContain("未运行，来消息就启动\n\n模型设置\nAgent：Claude Code\n模型：Haiku 9\n");
}, 30_000);

test("Claude: the turn it runs again by itself after a crash, before its handshake, has the effort: it comes with the launch", async () => {
  await slot("claude");
  await each("hello", "/effort high");
  await stop();
  installFakeAgent(dirname(rhodium.claude.path), { script: crashing("resumed") });
  await say("work");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "resumed"), 15_000);
  const again = rhodium.claude.runs().at(-1)!;
  expect(again.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
  expect(flagOf(again, "--effort")).toBe("high");
}, 30_000);

test("pi: /model and /effort are set again on the next process with pi's own commands, before your message", async () => {
  await slot("pi");
  await each("hello", "/model 2", "/effort high");
  await stop();
  await each("again", "/status");
  const [reply, status] = (await posts(5)).slice(3);
  expect(reply).toBe("fake reply");
  expect(status).toMatch(/\n模型：.+ high\n/);
  const frames = sent(rhodium.pi.runs().at(-1)!).filter((m) => m.type !== "get_state");
  expect(frames.slice(0, 3).map(({ id: _, ...m }) => (m.type === "prompt" ? "prompt" : m))).toEqual([
    { type: "set_model", provider: "fake", modelId: "pi-other" },
    { type: "set_thinking_level", level: "high" },
    "prompt",
  ]);
}, 30_000);

test("Claude: a level picked with the model (/model's second step) is remembered as /effort's", async () => {
  await slot("claude");
  await each("hello", "/model 2 high");
  await stop();
  await each("again");
  const last = rhodium.claude.runs().at(-1)!;
  expect(flagOf(last, "--model")).toBe("haiku");
  expect(flagOf(last, "--effort")).toBe("high");
}, 30_000);

test("Claude: /new keeps /model and /effort: the new conversation's process starts with them", async () => {
  await slot("claude");
  await each("hello", "/model 2", "/effort high", "/new", "again");
  const runs = rhodium.claude.runs();
  expect(runs).toHaveLength(2);
  expect(flagOf(runs[1]!, "--model")).toBe("haiku");
  expect(flagOf(runs[1]!, "--effort")).toBe("high");
}, 30_000);

test("pi: /model keeps the level /effort set on the running process, though pi resets it on a model switch", async () => {
  await slot("pi");
  installFakeAgent(dirname(rhodium.pi.path), { script: "pi-turn-model-resets-thinking" }, "pi");
  await each("hello", "/effort high", "/model 2", "/effort");
  expect((await posts(4))[3]).toContain("\n现在：high\n");
}, 30_000);

/** The slot's next process exits before it answers anything, as one that fails to start, with your
 *  message waiting for its settings; the one after runs as usual. Returns that one's run. */
async function diesBeforeSettings(agent: "claude" | "pi"): Promise<Run> {
  const fake = agent === "pi" ? rhodium.pi : rhodium.claude;
  const plain = { script: agent === "pi" ? "pi-turn" : "turn" };
  installFakeAgent(dirname(fake.path), { script: { steps: [{ sleep: 300 }, { exit: 1 }] } }, agent);
  await say("lost");
  await until(async () => (await rhodium.state("w/a")) === "崩溃", 15_000);
  installFakeAgent(dirname(fake.path), plain, agent);
  const before = (await rhodium.im.log("q", ME)).length;
  await say("again");
  await until(async () => (await rhodium.im.log("q", ME)).slice(before).some((p) => p.text === "fake reply"), 15_000);
  return fake.runs().at(-1)!;
}

const mentions = (frames: any[], text: string) => frames.filter((m) => JSON.stringify(m).includes(text));

test("Claude: a message waiting for the settings of a process that died is not written to the next one, which still gets yours", async () => {
  await slot("claude");
  await each("hello", "/model 2", "/effort high");
  await stop();
  const frames = sent(await diesBeforeSettings("claude"));
  expect(mentions(frames, "lost")).toEqual([]);
  expect(mentions(frames, "again")).toHaveLength(1);
}, 30_000);

test("pi: a message waiting for the settings of a process that died is not written to the next one, nor set twice there", async () => {
  await slot("pi");
  await each("hello", "/model 2", "/effort high");
  await stop();
  const frames = sent(await diesBeforeSettings("pi"));
  expect(mentions(frames, "lost")).toEqual([]);
  expect(mentions(frames, "again")).toHaveLength(1);
  expect(frames.filter((m) => m.type === "set_thinking_level")).toHaveLength(1);
}, 30_000);

test("pi taken over after a restart of rhodium: /model still keeps the level /effort set before the restart", async () => {
  await slot("pi");
  installFakeAgent(dirname(rhodium.pi.path), { script: "pi-turn-model-resets-thinking" }, "pi");
  await each("hello", "/effort high");
  await rhodium.kill9();
  await rhodium.start();
  await each("/model 2", "/effort");
  expect((await posts(4))[3]).toContain("\n现在：high\n");
  expect(rhodium.pi.runs()).toHaveLength(1);
}, 30_000);

test("a restart of rhodium takes the agent over as it is: nothing is set again, and /status still shows the effort", async () => {
  await slot("claude");
  await each("hello", "/effort high");
  await rhodium.kill9();
  await rhodium.start();
  await each("/status", "again");
  expect((await posts(4))[2]).toStartWith("w/a\n空闲\n\n模型设置\nAgent：Claude Code\n模型：默认（Opus 5.5）high\n");
  const runs = rhodium.claude.runs();
  expect(runs).toHaveLength(1);
  expect(sent(runs[0]!).filter((m) => m.request?.subtype === "apply_flag_settings")).toHaveLength(1);
}, 30_000);

test("a model switched to with no turn since is the one /status names after a restart of rhodium, not the one the last startup message named", async () => {
  await slot("claude");
  await each("hello", "/model 2");
  await rhodium.kill9();
  await rhodium.start();
  await each("/status");
  expect((await posts(3))[2]).toContain("\n模型：Haiku\n");
}, 30_000);

test("/model default forgets the model, and /rh_agent forgets both: the next process goes by your own settings", async () => {
  await slot("claude");
  await each("/model 2", "/effort high", "/model default"); // the agent starts for the first
  await stop();
  await each("hello");
  const last = rhodium.claude.runs().at(-1)!;
  expect(last.argv).not.toContain("--model");
  expect(flagOf(last, "--effort")).toBe("high");

  await each("/model 2", "/rh_agent pi", "/status", "hi");
  expect((await posts(8))[6]).toContain("未运行，来消息就启动\n\n模型设置\nAgent：Pi\n\n状态\n");
  expect(sent(rhodium.pi.runs()[0]!).map((m) => m.type)).not.toContain("set_thinking_level");
}, 30_000);

test("Claude: a remembered model the upgraded CLI no longer offers goes back to the default, is forgotten, and you hear of it", async () => {
  await slot("claude");
  await each("/model haiku");
  await stop();
  // Claude was upgraded meanwhile: its handshake offers no Haiku any more.
  installFakeAgent(dirname(rhodium.claude.path), { script: "turn-without-haiku" });
  await say("hello");
  const [notice, reply] = (await posts(3)).slice(1);
  expect(notice).toBe("w/a 记着的模型 haiku 在这一版 Claude 里没有了，改用了默认模型。");
  expect(reply).toBe("fake reply");
  const frames = sent(rhodium.claude.runs().at(-1)!);
  const reset = frames.findIndex((m) => m.request?.subtype === "set_model");
  expect(frames[reset]?.request.model).toBe("default");
  expect(reset).toBeLessThan(frames.findIndex((m) => m.type === "user"));

  await stop();
  await each("/status");
  expect((await posts(4))[3]).toContain("未运行，来消息就启动\n\n模型设置\nAgent：Claude Code\n\n状态\n");
}, 30_000);

test("pi: a remembered model pi refuses on the next process is forgotten, and you hear of it", async () => {
  await slot("pi");
  await each("/model pi-other");
  await stop();
  installFakeAgent(dirname(rhodium.pi.path), { script: "pi-turn-without-other" }, "pi");
  await say("hello");
  const [notice, reply] = (await posts(3)).slice(1);
  expect(notice).toBe("w/a 记着的模型 fake/pi-other 在这一版 pi 里没有了，改用了默认模型。\n原因：Model not found: fake/pi-other");
  expect(reply).toBe("fake reply");
  await stop();
  await each("/status");
  expect((await posts(4))[3]).toContain("未运行，来消息就启动\n\n模型设置\nAgent：Pi\n\n状态\n");
}, 30_000);
