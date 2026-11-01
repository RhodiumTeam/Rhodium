// rh stop, the emergency stop and archiving (stories 22, 154), seen from seam one.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, queueMidTurn, startTurn, toolUse } from "./fake-agent/scripts";
import { sourceLine } from "../src/prompt";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
/** An echoing agent says this first line of your message back too (architecture §6.1). */
const VIA = sourceLine("假 IM 私聊");

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

test("story 154: rh stop --all stops every running agent, mid-turn too", async () => {
  // Turns that never end: the agents are busy when the brake comes.
  const script: Script = { on, steps: [...startTurn, { wait: { type: "never" } }] };
  rhodium = newInstance({
    bots: { qa: { like: "qq", owner: ME, target: "w/a" }, qb: { like: "qq", owner: ME, target: "w/b" } },
    claude: { script },
  });
  await rhodium.start();
  await rhodium.slots("a", "b", "c");
  await rhodium.im.inject("qa", { chat: ME, sender: ME, text: "work" });
  await rhodium.im.inject("qb", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "运行中" && (await rhodium.state("w/b")) === "运行中", 15_000);

  const out = await rhodium.ok("stop", "--all");
  expect(out).toContain("w/a");
  expect(out).toContain("w/b");
  expect(out).not.toContain("w/c");
  await until(async () => (await rhodium.state("w/a")) === "未运行" && (await rhodium.state("w/b")) === "未运行", 15_000);
  expect(await rhodium.state("w/c")).toBe("未运行");
  expect(await rhodium.ok("stop", "--all")).toContain("没有");
}, 30_000);

test("story 22: rh archive stops the slot's agent and hides it from rh ls; rh unarchive, or rh send to it, brings it back", async () => {
  // Your chat points at w/a: a bot's default target is not archived.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/b" } } });
  await rhodium.start();
  await rhodium.slots("a", "b");
  await rhodium.ok("use", `q/${ME}`, "w/a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  // Its reply, after the line saying the chat now goes to w/a.
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 15_000);

  await rhodium.ok("archive", "w/a");
  const listed = async () => (await rhodium.ok("ls")).trim().split("\n").map((l) => l.split(/ +/)[0]);
  expect(await listed()).toEqual(["w/b"]);
  const all = async () => (await rhodium.ok("ls", "--all")).match(/^w\/a +\S+ +\S+ +(\S+)/m)?.[1];
  await until(async () => (await all()) === "未运行（已归档）", 15_000);

  await rhodium.ok("unarchive", "w/a");
  expect(await listed()).toEqual(["w/a", "w/b"]);

  // Archived again, rh send still reaches it, and it is back in the list.
  await rhodium.ok("archive", "w/a");
  await rhodium.ok("send", "w/a", "second");
  await until(() => rhodium.claude.runs()[1]?.stdin.some((l) => JSON.parse(l).type === "user") === true, 15_000);
  expect(await listed()).toEqual(["w/a", "w/b"]);
  const [first, again, ...more] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
  expect(more).toEqual([]);
}, 30_000);

test("rh stop stops a slot whose agent is still starting", async () => {
  // This claude never reports a turn, so the slot stays starting.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: [{ wait: { type: "never" } }] } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
  expect(await rhodium.ok("stop", "w/a")).toContain("正在停止");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
}, 30_000);

/** An instance whose holder launches wait while the returned gate file is there: systemctl holds
 *  the check a launch begins with, so the launch puts its holder on record only after a stop. */
async function gatedLaunch(): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: [{ wait: { type: "never" } }] } } });
  const gate = join(rhodium.dir, "gate");
  const bin = join(rhodium.dir, "gated-bin");
  mkdirSync(bin);
  const gated = `#!/bin/sh\ncase "$*" in *LoadState*) while [ -e ${gate} ]; do sleep 0.05; done ;; esac\nexec ${Bun.which("systemctl")} "$@"\n`;
  writeFileSync(join(bin, "systemctl"), gated, { mode: 0o755 });
  rhodium.env.PATH = `${bin}:${rhodium.env.PATH}`;
  await rhodium.start();
  await rhodium.slots("a");
  return gate;
}

test("rh stop before the slot's holder is on record is a stop, not a crash, on its first start and on later ones", async () => {
  const gate = await gatedLaunch();

  for (const text of ["first", "second"]) {
    writeFileSync(gate, "");
    await rhodium.im.inject("q", { chat: ME, sender: ME, text });
    await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
    expect(await rhodium.ok("stop", "w/a")).toContain("正在停止");
    rmSync(gate);
    let state: string | undefined;
    await until(async () => (state = await rhodium.state("w/a")) !== "启动中", 15_000);
    expect(state).toBe("未运行");
  }
  expect(await rhodium.im.log("q", ME)).toEqual([]);
}, 30_000);

test("the emergency stop before the slot's holder is on record is still on record as the emergency stop's", async () => {
  const gate = await gatedLaunch();
  writeFileSync(gate, "");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
  expect(await rhodium.ok("stop", "--all")).toContain("w/a");
  rmSync(gate);
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  // What tells the next exit it was the emergency stop's (architecture §9.3).
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT stopRequested FROM holder").all()).toEqual([{ stopRequested: 2 }]);
  db.close();
}, 30_000);

test("rh stop while the holder is still launching stops the agent once it is up, before your message reaches it", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  // An rh-hold that takes half a second to come up.
  const config = readFileSync(rhodium.config, "utf8");
  const holdBin = config.match(/^holdBin = "(.*)"$/m)![1]!;
  const slow = join(rhodium.dir, "slow-rh-hold");
  writeFileSync(slow, `#!/bin/sh\nsleep 0.5\nexec ${holdBin} "$@"\n`, { mode: 0o755 });
  writeFileSync(rhodium.config, config.replace(holdBin, slow));
  await rhodium.start();
  await rhodium.slots("a");

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.state("w/a")) === "启动中", 15_000);
  expect(await rhodium.ok("stop", "w/a")).toContain("正在停止");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  const [run, ...more] = rhodium.claude.runs();
  expect(run!.stdin.map((l) => JSON.parse(l).type)).not.toContain("user");
  expect(more).toEqual([]);
}, 30_000);

test("your message while rh stop is still under way is not lost: the agent starts again for it once it has exited", async () => {
  // It echoes each message. After its first turn it reads nothing for 3 s, so it takes stopGrace and TERM to stop.
  const script: Script = { on, steps: [...startTurn, ...endTurn("{{in.message.content.0.text}}"), { sleep: 3000 }, { goto: 0 }] };
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" } },
    claude: { script },
    toml: '[durations]\nstopGrace = "300ms"',
  });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);

  await rhodium.ok("stop", "w/a");
  const second = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 15_000);
  const [, reply] = await rhodium.im.log("q", ME);
  expect(reply).toMatchObject({ text: `${VIA}\nsecond`, replyTo: second.messageId });
  const [first, again, ...more] = rhodium.claude.runs();
  const session = first!.argv.find((a) => a.startsWith("--session-id="))!.split("=")[1];
  expect(again!.argv).toContain(`--resume=${session}`);
  expect(more).toEqual([]);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
}, 30_000);

test("a turn rh stop cut short that still ends sends no reply, and your message since then still gets its own", async () => {
  // It ignores TERM, and each turn takes 1 s: the first ends while the stop waits out stopGrace.
  const script: Script = { on, steps: [{ ignore: "SIGTERM" }, ...startTurn, { sleep: 1000 }, ...endTurn("{{in.message.content.0.text}}"), { goto: 1 }] };
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" } },
    claude: { script },
    toml: '[durations]\nstopGrace = "2s"',
  });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "first" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.ok("stop", "w/a");
  const second = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });

  await until(async () => (await rhodium.im.log("q", ME)).length > 0, 15_000);
  expect(await rhodium.im.log("q", ME)).toMatchObject([{ text: `${VIA}\nsecond`, replyTo: second.messageId }]);
  expect(rhodium.claude.runs()).toHaveLength(2);
}, 30_000);

test("stories 39/40: rh send me from the agent rh stop is stopping, after your message came, still leaves your message its final reply", async () => {
  // It ignores TERM and runs the rh calls a message lists 1.5 s into its turn, while the stop waits out stopGrace.
  const script: Script = {
    on,
    steps: [{ ignore: "SIGTERM" }, ...startTurn, { sleep: 1500 }, { rhFrom: "in.message.content.0.text" }, ...endTurn("{{in.message.content.0.text}}"), { goto: 1 }],
  };
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" } },
    claude: { script },
    toml: '[durations]\nstopGrace = "3s"',
  });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: JSON.stringify([["send", "me", "old"]]) });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.ok("stop", "w/a");
  const second = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "second" });

  await until(() => rhodium.claude.runs().length === 2, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await Bun.sleep(300); // its reply has gone out by now
  expect(await rhodium.im.log("q", ME)).toMatchObject([{ text: "old" }, { text: `${VIA}\nsecond`, replyTo: second.messageId }]);
}, 30_000);

// Your messages the emergency stop leaves queued would wait for the slot's next start, which may be
// much later, the talk moved on: they are given back to you instead (2026-10-22).
test("story 154: your message held for an interrupt is not kept for later by the emergency stop: you are told, with it quoted to send again", async () => {
  // A turn that never ends, not even when interrupted.
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: { on, steps: [...startTurn, { wait: { type: "never" } }] } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "!排着的话" });
  await Bun.sleep(300);

  await rhodium.ok("stop", "--all");
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.includes("没交给它")), 15_000);
  const notice = (await rhodium.im.log("q", ME)).find((p) => p.text.includes("没交给它"))!;
  expect(notice.text).toBe("w/a 急停了，你排着的这条没交给它，需要的话再发一遍：\n“排着的话”");
  expect(notice.buttons).toEqual([{ label: "复制", data: "排着的话", copy: true }]);

  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "新的" });
  await until(() => rhodium.claude.runs().length === 2 && rhodium.claude.runs()[1]!.stdin.some((l) => l.includes("新的")), 15_000);
  expect(rhodium.claude.runs()[1]!.stdin.join("\n")).not.toContain("排着的话");
}, 30_000);

// Claude keeps a message that comes while a tool runs in its own queue (architecture §4.6): stopped
// then, it never has it. You hear so, as at a crash, in the chat it came from.
for (const stop of ["w/a", "--all"]) {
  test(`stories 22, 154: rh stop ${stop} with a message of yours written and not yet taken in: you are told in the chat you sent it from, with it quoted to send again`, async () => {
    const steps = [...startTurn, toolUse("toolu_sleep", "Bash", { command: "sleep 60" }), ...queueMidTurn, { wait: { type: "never" } }];
    rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" }, t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script: { on, steps } } });
    await rhodium.start();
    await rhodium.slots("a");
    await rhodium.im.inject("t", { chat: ME, sender: ME, text: "跑一下测试" });
    await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
    await rhodium.im.inject("q", { chat: ME, sender: ME, text: "复制测试" });
    await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000); // 已并入…那边正在跑的回合
    const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
    await until(() => db.query("SELECT 1 FROM agentInput WHERE status = 'written'").all().length > 0, 15_000);
    db.close();
    // /status from Telegram makes that the slot's contact chat: the notice still goes where the message came from.
    await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/status" });
    await until(async () => (await rhodium.im.log("t", ME)).some((p) => p.text.includes("w/a")), 15_000);

    await rhodium.ok("stop", stop);
    await until(async () => (await rhodium.im.log("q", ME)).length > 1, 15_000);
    await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
    const [, notice, ...more] = await rhodium.im.log("q", ME);
    expect(notice!.text).toBe("w/a 停下了，这条不确定它收到没有，需要的话再发一遍：\n“复制测试”");
    expect(notice!.buttons).toEqual([{ label: "复制", data: "复制测试", copy: true }]);
    expect(more).toEqual([]);
    expect((await rhodium.im.log("t", ME)).filter((p) => p.text.includes("复制测试"))).toEqual([]);
  }, 30_000);
}
