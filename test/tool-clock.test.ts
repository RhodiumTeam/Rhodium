// The minutes a running tool's line counts on Telegram (docs/im-style.md §3.1) across a restart of
// rhodium (story 118), from seam one. The line counts real minutes, so each test waits one out; they
// run side by side, each with an instance of its own.
import { expect, test } from "bun:test";
import type { Script, Step } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn, toolResult, toolUse } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-tg-id";
const MINUTE = 60_000;
const SLEEP = toolUse("toolu_sleep", "Bash", { command: "sleep 600" });
const RUNNING = "[🔧 Bash] sleep 600，正在运行";
/** A turn that runs sleep 600, then plays steps. */
const sleeping = (...steps: Step[]): Script => ({ on, steps: [...startTurn, SLEEP, ...steps] });

/** Runs body on a rhodium whose Telegram-like bot t sends your messages to w/a, its claude playing
 *  script; then cleans it up. */
async function onRhodium(script: Script | string, body: (rhodium: Instance) => Promise<void>, toml = ""): Promise<void> {
  const rhodium = newInstance({ bots: { t: { like: "telegram", owner: ME, target: "w/a" } }, claude: { script }, toml });
  try {
    await rhodium.start();
    await rhodium.slots("a");
    await body(rhodium);
  } finally {
    await rhodium.cleanup();
  }
}

/** Every text the bot sent, or edited a message to, in your chat, in order. */
const texts = async (rhodium: Instance) => (await rhodium.im.log("t", ME)).map((p) => p.text);

/** Says go, waits until the turn's message shows its step running, and kill -9s rhodium; starts it
 *  again after down ms. Resolves to when the step started, near enough. */
async function goThenRestart(rhodium: Instance, running = RUNNING, down = 0): Promise<number> {
  await rhodium.im.inject("t", { chat: ME, sender: ME, text: "go" });
  await until(async () => (await texts(rhodium)).includes(running), 15_000);
  const started = Date.now();
  await rhodium.kill9();
  await Bun.sleep(down);
  await rhodium.start();
  return started;
}

/** Waits until a minute and a bit has passed since the step started: past when its line would say 1 分钟. */
const pastTheMinute = (started: number) => Bun.sleep(Math.max(0, started + MINUTE + 3_000 - Date.now()));

/** Checks that, from now until a minute and a bit after the step started, nothing more is sent or edited. */
async function nothingMore(rhodium: Instance, started: number): Promise<void> {
  await Bun.sleep(1_000); // past an edit's wait, so one more would be there by now
  const before = await texts(rhodium);
  await pastTheMinute(started);
  expect(await texts(rhodium)).toEqual(before);
  expect(before.filter((t) => t.includes("正在运行（"))).toEqual([]);
}

test.concurrent("stories 67, 118: rhodium restarted while a tool runs: its line still counts the minutes, with no word from the agent", async () => {
  await onRhodium(sleeping({ wait: { type: "never" } }), async (rhodium) => {
    await goThenRestart(rhodium);
    await until(async () => (await texts(rhodium)).includes(`${RUNNING}（1 分钟）`), MINUTE + 15_000);
  });
}, 120_000);

test.concurrent("stories 67, 118: after a restart, the line stops counting once the tool is done", async () => {
  // Done a few seconds in; the turn goes on, saying nothing, past the minute.
  await onRhodium(sleeping({ sleep: 5_000 }, toolResult("toolu_sleep"), { sleep: MINUTE + 10_000 }, ...endTurn("done")), async (rhodium) => {
    const started = await goThenRestart(rhodium);
    await until(async () => (await texts(rhodium)).at(-1) === "[🔧 Bash] sleep 600", 15_000);
    await nothingMore(rhodium, started);
  });
}, 120_000);

test.concurrent("stories 67, 118: a tool done while rhodium was down: after the restart its line counts nothing", async () => {
  // Done a second in, while rhodium is down; the turn goes on, saying nothing, past the minute.
  await onRhodium(sleeping({ sleep: 1_000 }, toolResult("toolu_sleep"), { sleep: MINUTE + 10_000 }, ...endTurn("done")), async (rhodium) => {
    const started = await goThenRestart(rhodium, RUNNING, 2_000);
    await until(async () => (await texts(rhodium)).at(-1) === "[🔧 Bash] sleep 600", 15_000);
    await nothingMore(rhodium, started);
  });
}, 120_000);

test.concurrent("stories 67, 118: after a restart, the line stops counting once /stop ends the turn", async () => {
  await onRhodium("step-until-cut-short", async (rhodium) => {
    const started = await goThenRestart(rhodium, "开始跑循环。\n\n[🔧 Bash] Run 8-step loop，正在运行");
    await rhodium.im.inject("t", { chat: ME, sender: ME, text: "/stop" });
    await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
    await nothingMore(rhodium, started);
  });
}, 120_000);

test.concurrent.each([
  ["rh stop", (rhodium: Instance): unknown => rhodium.ok("stop", "w/a"), "未运行"],
  ["its agent killed", (rhodium: Instance): unknown => process.kill(rhodium.claude.runs()[0]!.pid, "SIGKILL"), "崩溃"],
] as const)("stories 67, 118: after a restart, the line stops counting once the slot stops (%s)", async (_, cut, settled) => {
  await onRhodium(
    sleeping({ wait: { type: "never" } }),
    async (rhodium) => {
      const started = await goThenRestart(rhodium);
      await cut(rhodium);
      await until(async () => (await rhodium.state("w/a"))?.startsWith(settled) === true, 15_000);
      await nothingMore(rhodium, started);
    },
    "[defaults]\ncrashResume = false",
  );
}, 120_000);
