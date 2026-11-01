// Seam 3 (docs/spec/v1.md "接缝三"): the Claude driver against the fake agent replaying
// each recording in test/fixtures/claude. The replayer exits 1 with a diff when a frame
// the driver writes differs from in.log, so every replay also checks the written frames.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ClaudeDriver, refuseBare } from "../src/claude.ts";
import type { AgentEvent, AgentLink, CommandResult } from "../src/contracts.ts";
import { installFakeAgent } from "./fake-agent/fake-agent.ts";
import { exec } from "./instance";

const FIXTURES = join(import.meta.dir, "fixtures/claude");
const replayed = new Set<string>();
const base = mkdtempSync(join(tmpdir(), "rhodium-test-claude-driver-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/** Starts the replayer for one recording and attaches a fresh driver to it as process 1. */
function replay(fixture: string) {
  replayed.add(fixture);
  const dir = mkdtempSync(join(base, `${count++}-`));
  const agent = installFakeAgent(dir, { replay: join(FIXTURES, fixture) });
  const proc = Bun.spawn([agent.path], { cwd: dir, env: { HOME: dir }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: AgentEvent[] = [];
  const driver = new ClaudeDriver({ conv: "conv-1", boot: 1, emit: (e) => events.push(e), stopGrace: 2000 });
  const link: AgentLink = {
    async write(_id, line) {
      proc.stdin.write(line + "\n");
      await proc.stdin.flush();
    },
    async eof() {
      await proc.stdin.end();
    },
    async signal(sig) {
      proc.kill(`SIG${sig}`);
    },
    exited: proc.exited,
  };
  // Like the holder: split on byte 0x0A only and hand over whole lines.
  const pump = (async () => {
    let rest = Buffer.alloc(0);
    for await (const chunk of proc.stdout) {
      let b = Buffer.concat([rest, Buffer.from(chunk)]);
      for (let i = b.indexOf(10); i >= 0; i = b.indexOf(10)) {
        driver.feed(b.subarray(0, i + 1));
        b = b.subarray(i + 1);
      }
      rest = b;
    }
  })();
  const finish = async () => {
    const code = await proc.exited;
    await pump;
    return { code, stderr: await new Response(proc.stderr).text() };
  };
  driver.attach(link, 1);
  return {
    driver,
    events,
    link,
    finish,
    /** Waits until `n` events match; fails with the replayer's diff if it exits first. */
    async until(pred: (e: AgentEvent) => boolean, n = 1): Promise<AgentEvent> {
      for (;;) {
        const hits = events.filter(pred);
        if (hits.length >= n) return hits[n - 1]!;
        if (proc.exitCode !== null) {
          const { stderr } = await finish();
          if (events.filter(pred).length >= n) continue;
          throw new Error(`replayer exited (${proc.exitCode}) first:\n${stderr}\nevents: ${brief(events).join(" ")}`);
        }
        await Bun.sleep(5);
      }
    },
  };
}

/** Closes stdin and expects the replayer to have seen every in.log line and nothing else. */
async function done(r: ReturnType<typeof replay>) {
  await r.driver.close();
  expect(await r.finish()).toEqual({ code: 0, stderr: "" });
}

/** One word per event; runs of text deltas count once. */
function brief(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "tool_start" || e.type === "taken") continue; // checked on their own: one before each tool, one per message
    const word = (() => {
      switch (e.type) {
        case "text_delta":
          return "text";
        case "item":
          return e.item.kind === "tool" ? `tool:${e.item.name}` : "message";
        case "ask":
          return `ask:${e.kind}:${e.tool}`;
        case "state":
          return `state:${e.state}`;
        case "usage":
          return e.quota ? `quota:${e.quota.exhausted ? "out" : "ok"}` : "usage";
        case "background":
          return `background:${e.tasks.length}`;
        case "pending_asks":
          return `pending:${e.asks?.length ?? "too_old"}`;
        case "protocol_error":
          return `error:${e.reason}`;
        default:
          return e.type;
      }
    })();
    if (!(word === "text" && out.at(-1) === "text")) out.push(word);
  }
  return out;
}

const turnEnd = (e: AgentEvent) => e.type === "turn_end";
const human = (text: string) => ({ id: `in-${count++}`, text, human: true });
const text = (events: AgentEvent[]) => events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");

describe("replaying the Claude recordings", () => {
  test("basic-turn: a turn with a tool call streams text and ends on idle", async () => {
    const r = replay("basic-turn");
    await r.driver.send(human("Use the Read tool to read notes.txt, then tell me in one short sentence how many wicks there are."), "turn");
    // The final reply is the last assistant message, not the tool call or the thinking before it.
    expect(await r.until(turnEnd)).toMatchObject({ type: "turn_end", reply: "There are 12 wicks in notes.txt." });
    await done(r);

    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "quota:ok", "tool:Read", "text", "message", "usage", "state:idle", "turn_end",
    ]);
    expect(r.events.every((e) => e.conv === "conv-1" && e.proc === 1)).toBe(true);
    expect(text(r.events)).toBe("There are 12 wicks in notes.txt.");
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "item", item: { kind: "message", text: "There are 12 wicks in notes.txt." } });
    // The tool call shows as it starts, with what it was given, and again once its result is back.
    const read = { id: "toolu_000082292603842861592517", name: "Read", input: { file_path: "/tmp/rh-probe/work/notes.txt" } };
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "tool_start", ...read });
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "item", item: { kind: "tool", ...read } });
    expect(r.events.findIndex((e) => e.type === "tool_start")).toBeLessThan(r.events.findIndex((e) => e.type === "item" && e.item.kind === "tool"));
    const commands = r.events.find((e) => e.type === "commands");
    expect(commands?.type === "commands" && commands.commands[0]).toEqual({ name: "design", description: expect.any(String) });
    expect(r.driver.info).toMatchObject({ version: "2.1.304", model: "claude-haiku-5-5" });
    expect(r.driver.info.capabilities).toContain("interrupt_receipt_v1");
  });

  test("approval-allow-deny: an approval allowed once, then one denied with a reason", async () => {
    const r = replay("approval-allow-deny");
    await r.driver.send(human("Use the Bash tool to run exactly: echo first > a.txt"), "turn");
    const first = await r.until((e) => e.type === "ask");
    expect(first).toMatchObject({ kind: "permission", tool: "Bash", input: { command: "echo first > a.txt" } });
    await r.driver.answer((first as { requestId: string }).requestId, { kind: "permission", allow: true });
    await r.until(turnEnd);
    await r.driver.send(human("Use the Bash tool to run exactly: echo second > b.txt"), "turn");
    const second = await r.until((e) => e.type === "ask", 2);
    await r.driver.answer((second as { requestId: string }).requestId, {
      kind: "permission",
      allow: false,
      message: "The user denied this command.",
    });
    await r.until(turnEnd, 2);
    await done(r);
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "state:waiting", "ask:permission:Bash", "quota:ok", "state:running",
      "tool:Bash", "text", "message", "usage", "state:idle", "turn_end",
      "turn_start", "state:running", "state:waiting", "ask:permission:Bash", "state:running",
      "tool:Bash", "text", "message", "usage", "state:idle", "turn_end",
    ]);
  });

  test("question: the chosen option's label goes back as the answer", async () => {
    const r = replay("question");
    await r.driver.send(
      human("Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options red and blue. After I answer, reply with just the color."),
      "turn",
    );
    const ask = await r.until((e) => e.type === "ask");
    expect(ask).toMatchObject({ kind: "question", tool: "AskUserQuestion" });
    await r.driver.answer((ask as { requestId: string }).requestId, { kind: "question", answers: { "Which color do you prefer?": "Blue" } });
    await r.until(turnEnd);
    await done(r);
    expect(brief(r.events).slice(-7)).toEqual(["tool:AskUserQuestion", "quota:ok", "text", "message", "usage", "state:idle", "turn_end"]);
  });

  test("plan-confirm: the plan is approved, then the write it leads to", async () => {
    const r = replay("plan-confirm");
    await r.driver.send(
      human("Make a one-step plan to create hello.txt containing the word hi, then call ExitPlanMode with that plan. Do not ask questions."),
      "turn",
    );
    const plan = await r.until((e) => e.type === "ask");
    expect(plan).toMatchObject({ kind: "plan", tool: "ExitPlanMode", input: { planFilePath: "/home/user/.claude/plans/make-a-one-step-plan-typed-bumblebee.md" } });
    await r.driver.answer((plan as { requestId: string }).requestId, { kind: "plan", approve: true });
    const write = await r.until((e) => e.type === "ask", 2);
    expect(write).toMatchObject({ kind: "permission", tool: "Write" });
    await r.driver.answer((write as { requestId: string }).requestId, { kind: "permission", allow: true });
    await r.until(turnEnd);
    await done(r);
  });

  test("interrupt-pending-approval: '!' interrupts, the pending approval is withdrawn, then the new message runs", async () => {
    const r = replay("interrupt-pending-approval");
    await r.driver.send(human("Use the Bash tool to run exactly: touch c.txt"), "turn");
    const ask = await r.until((e) => e.type === "ask");
    await r.driver.interrupt();
    await r.driver.send(human("Never mind that. Reply with exactly: OK"), "turn");
    await r.until(turnEnd, 2);
    await done(r);
    // The interrupted turn said nothing, so it has no reply; nothing carries over into the next.
    expect(r.events.filter(turnEnd).map((e) => (e as { reply?: string }).reply)).toEqual([undefined, "OK"]);
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "ask_cancel", requestId: (ask as { requestId: string }).requestId });
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "state:waiting", "ask:permission:Bash", "quota:ok", "ask_cancel", "state:running",
      "tool:Bash", "usage", "state:idle", "turn_end",
      "turn_start", "state:running", "text", "message", "usage", "state:idle", "turn_end",
    ]);
    // A withdrawn ask can no longer be answered.
    await expect(r.driver.answer((ask as { requestId: string }).requestId, { kind: "permission", allow: true })).rejects.toThrow();
  });

  test("background-wake: no turn end at the first result, only at idle; the task's wake-up is a turn of its own", async () => {
    const r = replay("background-wake");
    await r.driver.send(
      human("Use the Bash tool with run_in_background set to true to run exactly: sleep 8; echo bg-done. Then reply STARTED and end your turn. When it finishes, reply with its output."),
      "turn",
    );
    await r.until(turnEnd, 2);
    await done(r);
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "quota:ok", "background:1", "tool:Bash", "tool:Read", "text", "message", "usage", "state:idle", "turn_end",
      "background:0",
      "turn_start", "state:running", "tool:Read", "text", "message", "usage", "state:idle", "turn_end",
    ]);
    expect(r.events).toContainEqual({
      conv: "conv-1", proc: 1, type: "background", tasks: [{ id: "bwfcauk3o", description: "Run background sleep and echo marker" }],
    });
    // The first turn ends with the task still running, so a child is not done yet (architecture §9.2).
    expect(r.events.filter(turnEnd).map((e) => (e as { background?: true }).background)).toEqual([true, undefined]);
  });

  // #226: while a background subagent runs, the CLI sends a result for each turn but no idle until
  // the subagent ends, and no running for the turns between.
  test("background-agent: with a subagent in the background a turn ends on its result; your next message and the wake-up are turns of their own", async () => {
    const r = replay("background-agent");
    const first = human(
      "Use the Agent tool with run_in_background set to true to start one general-purpose subagent with this task: \"Run the Bash command `sleep 30`, then reply with exactly SUB-DONE.\" Do not wait for it. Reply STARTED and end your turn.",
    );
    await r.driver.send(first, "turn");
    expect(await r.until(turnEnd)).toMatchObject({ reply: "STARTED", background: true });
    const second = human("Reply with exactly: SECOND");
    await r.driver.send(second, "turn");
    expect(await r.until(turnEnd, 2)).toMatchObject({ reply: "SECOND", background: true });
    await r.until(turnEnd, 3);
    await r.until((e) => e.type === "background" && e.tasks.length === 0);
    await done(r);
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "background:1", "tool:Agent", "quota:ok", "text", "message", "usage", "state:idle", "turn_end",
      "turn_start", "state:running", "text", "message", "usage", "state:idle", "turn_end",
      "background:2", "background:1",
      "turn_start", "state:running", "text", "message", "usage", "state:idle", "turn_end",
      "background:0",
    ]);
    // Your message begins its turn; the subagent's end wakes the session for one of its own.
    expect(r.events.filter((e) => e.type === "turn_start").map((e) => (e as { input?: string }).input)).toEqual([first.id, second.id, undefined]);
    expect(r.driver.info.selfStarted).toBe(false);
  });

  test("mid-turn-message: a message sent mid-turn joins the turn; two results, one turn end", async () => {
    const r = replay("mid-turn-message");
    await r.driver.send(human("Count from 1 to 40, one number per line, nothing else."), "turn");
    await r.until((e) => e.type === "text_delta");
    await r.driver.send(human("Also, after the last number, write the word DONE."), "steer");
    // Two results, and the reply is the second: the one that answered both messages.
    expect((await r.until(turnEnd)) as { reply?: string }).toMatchObject({ reply: expect.stringMatching(/^1\n2\n.*\n40\nDONE$/s) });
    await done(r);
    const b = brief(r.events);
    expect(b.filter((w) => w === "turn_start" || w === "turn_end")).toEqual(["turn_start", "turn_end"]);
    expect(b.filter((w) => w === "usage")).toHaveLength(2);
    expect(text(r.events)).toEndWith("DONE");
  });

  test("close-with-background: the background task wakes the session after its turn; close waits for none of it", async () => {
    const r = replay("close-with-background");
    await r.driver.send(
      human("Use the Bash tool with run_in_background set to true to run exactly: sleep 15; echo bg-finished-42. Then reply STARTED and end your turn."),
      "turn",
    );
    await r.until(turnEnd, 2);
    await r.until((e) => e.type === "background" && e.tasks.length === 0);
    await done(r);
  });

  test("reinitialize-pending-approval: a new handshake hands back the unanswered approval, which can then be answered", async () => {
    const r = replay("reinitialize-pending-approval");
    await r.driver.send(human("Use the Bash tool to run exactly: touch d.txt"), "turn");
    const ask = (await r.until((e) => e.type === "ask")) as Extract<AgentEvent, { type: "ask" }>;
    r.driver.attach(r.link, 1); // reconnect to the same process
    const pending = await r.until((e) => e.type === "pending_asks", 2);
    const { conv, proc, type, ...asked } = ask;
    expect(pending).toEqual({ conv, proc, type: "pending_asks", asks: [asked] });
    await r.driver.answer(ask.requestId, { kind: "permission", allow: true });
    await r.until(turnEnd);
    await done(r);
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "state:waiting", "ask:permission:Bash", "quota:ok",
      "commands", "pending:1", "background:0",
      "state:running", "tool:Bash", "text", "message", "usage", "state:idle", "turn_end",
    ]);
  });

  test("unknown-messages: unknown types, fields and lines are skipped, an unknown CLI request gets an error", async () => {
    const r = replay("unknown-messages");
    await r.driver.send(human("Use the Read tool to read notes.txt, then tell me in one short sentence how many wicks there are."), "turn");
    await r.until(turnEnd);
    await done(r); // in.log holds the error reply, so the replayer checked it
    expect(brief(r.events)).toEqual([
      "commands", "pending:0",
      "turn_start", "state:running", "quota:ok", "tool:Read", "text", "message", "usage", "state:idle", "turn_end",
    ]);
    expect([...r.driver.unknown.keys()].sort()).toEqual([
      "control_request/rh_future_request", "non_json", "rh_future_event", "stream_event/rh_future_stream_event", "system/rh_future_subtype",
    ]);
  });

  test("rate-limit-rejected: the quota is reported as used up until its reset time", async () => {
    const r = replay("rate-limit-rejected");
    await r.driver.send(human("Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    await done(r);
    const resetsAt = recorded("rate-limit-rejected").find((m) => m.type === "rate_limit_event").rate_limit_info.resetsAt * 1000;
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "usage", quota: { exhausted: true, resetsAt } });
    expect(r.events).toContainEqual({
      conv: "conv-1", proc: 1, type: "item", item: { kind: "message", text: expect.stringMatching(/^You've hit your limit · resets \d\d:\d\d \(UTC\)$/) },
    });
  });

  test("crash-resume-auto-turn: a turn that starts before the handshake answers is reported in full", async () => {
    const r = replay("crash-resume-auto-turn");
    await r.until(turnEnd);
    await done(r);
    expect(brief(r.events)).toEqual(["turn_start", "state:running", "commands", "pending:0", "text", "message", "quota:ok", "usage", "state:idle", "turn_end"]);
    // So the runner writes no resume prompt (architecture §4.8).
    expect(r.driver.info.selfStarted).toBe(true);
  });

  // One plain turn each: /new and /resume differ only in how the process was launched,
  // and /status is answered by Rhodium from its own state.
  for (const fixture of ["cmd-new", "cmd-status"]) {
    test(`${fixture}: a plain turn`, async () => {
      const r = replay(fixture);
      await r.driver.send(human("Reply with exactly: OK"), "turn");
      await r.until(turnEnd);
      await done(r);
      expect(text(r.events)).toBe("OK");
    });
  }

  test("cmd-resume: a turn in a resumed conversation", async () => {
    const r = replay("cmd-resume");
    await r.driver.send(human("Which word did I ask you to remember? Reply with just the word."), "turn");
    await r.until(turnEnd);
    await done(r);
    expect(text(r.events)).toBe("MANGO");
  });

  test("cmd-stop: interrupting a running turn ends it", async () => {
    const r = replay("cmd-stop");
    await r.driver.send(human("Count from 1 to 300, one number per line, nothing else."), "turn");
    await r.until((e) => e.type === "text_delta");
    await r.driver.interrupt();
    await r.until(turnEnd);
    await done(r);
    expect(brief(r.events).slice(-3)).toEqual(["usage", "state:idle", "turn_end"]);
  });

  test("cmd-model: story 57, /model lists the models of the handshake, and one picked is switched to with set_model", async () => {
    const r = replay("cmd-model");
    // Asked right away: the list waits for the handshake's answer, and writes nothing.
    const list = await r.driver.command("model", "");
    expect(list).toMatchObject({ command: "model", model: null });
    expect(list.command === "model" && list.choices?.slice(0, 3)).toEqual([
      { id: "default", label: "默认（Opus 5.5）" },
      { id: "opus", label: "Opus 5.5" },
      { id: "fable", label: "Fable 5.1" },
    ]);
    // Its name with it, and the levels it takes: none, so /model's panel has no second step.
    expect(await r.driver.command("model", "claude-haiku-4-5-20251001")).toEqual({ command: "model", model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] });
    // /model and /status have it before the next turn says so, by its name (docs/im-style.md §2.4).
    const now = await r.driver.command("model", "");
    expect(now.command === "model" && now.choices?.find((c) => c.current)?.label).toBe("Haiku 4.5");
    await r.driver.send(human("Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    await done(r);
    expect(r.driver.info.model).toBe("claude-haiku-4-5-20251001");
  });

  test("cmd-effort: story 58, /effort lists the model's levels, sets one with apply_flag_settings, and keeps it for /status", async () => {
    const r = replay("cmd-effort");
    // Before the first turn the model is not known yet: the default's levels, ultracode not among them (#276).
    // None set yet: the one Claude uses, get_settings' applied.effort, is marked (#454).
    expect(await r.driver.command("effort", "")).toEqual({
      command: "effort",
      level: "-",
      choices: ["low", "medium", "high", "xhigh", "max"].map((l) => ({ id: l, label: l, ...(l === "medium" && { current: true }) })),
    });
    // ultracode as get_settings has it, off here, goes with the level (in.log has the frame).
    expect(await r.driver.command("effort", "low")).toEqual({ command: "effort", level: "low" });
    expect(await r.driver.command("effort", "")).toMatchObject({ level: "low" });
    await r.driver.send(human("Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    await done(r);
  });

  test("cmd-ultracode: #276, ultracode apart from the level: a level keeps it on, /ultracode turns it off and on, its panel marks it as get_settings says", async () => {
    const r = replay("cmd-ultracode");
    // Launched with --effort high and the ultracode settings key: setting effortLevel alone would turn it off.
    expect(await r.driver.command("effort", "low")).toEqual({ command: "effort", level: "low" });
    expect(await r.driver.command("ultracode", "off")).toEqual({ command: "ultracode", on: false });
    expect(await r.driver.command("ultracode", "on")).toEqual({ command: "ultracode", on: true });
    expect(await r.driver.command("ultracode", "")).toEqual({
      command: "ultracode",
      on: true,
      choices: [
        { id: "on", label: "开", current: true },
        { id: "off", label: "关" },
      ],
    });
    await r.driver.send(human("Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    await done(r);
  });

  test("cmd-usage: stories 59, 393, /usage gives every quota window Claude lists, a model's own 7 days too, and this conversation's use", async () => {
    const r = replay("cmd-usage");
    const listed = recorded("cmd-usage").find((m) => m.response?.response?.rate_limits).response.response.rate_limits;
    const at = (iso: string) => Date.parse(iso);
    expect(await r.driver.command("usage", "")).toEqual({
      command: "usage",
      limits: [
        { window: "5h", usedPercent: 12, resetsAt: at(listed.five_hour.resets_at) },
        { window: "7d", usedPercent: 52, resetsAt: at(listed.seven_day.resets_at) },
        { window: "7d", model: "Fable", usedPercent: 38, resetsAt: at(listed.model_scoped[0].resets_at) },
      ],
      // Extra usage is off; no turn has run.
      session: { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, models: [] },
    });
    await done(r);
  });

  test("cmd-usage-session: story 395, after a turn /usage gives the conversation's cost and its four kinds of tokens, by model too", async () => {
    const r = replay("cmd-usage-session");
    await r.driver.send(human("Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    const u = (await r.driver.command("usage", "")) as Extract<CommandResult, { command: "usage" }>;
    const tokens = { input: 2, output: 4, cacheRead: 12_808, cacheWrite: 13_735, total: 26_549 };
    expect(u.session).toEqual({ cost: 0.0028772800000000003, tokens, models: [{ name: "Haiku 5.5", cost: 0.0028772800000000003, tokens }] });
    expect(u.limits.map((l) => [l.window, l.model])).toEqual([["5h", undefined], ["7d", undefined], ["7d", "Fable"]]);
    await done(r);
  });

  test("cmd-context: stories 60, 400, /context gives the tokens in use out of the window, and what holds them by name, ones Rhodium knows in Chinese", async () => {
    const r = replay("cmd-context");
    expect(await r.driver.command("context", "")).toEqual({
      command: "context",
      usedTokens: 22358,
      maxTokens: 1000000,
      // Not the deferred tools nor the free space: they hold none of it.
      categories: [
        { name: "系统提示", tokens: 3399 },
        { name: "工具", tokens: 10247 },
        { name: "Custom agents", tokens: 44 },
        { name: "Memory files", tokens: 135 },
        { name: "技能", tokens: 6766 },
        { name: "消息", tokens: 1767 },
        { name: "自动压缩预留", tokens: 33000 },
      ],
    });
    await done(r);
  });

  test("cmd-compact: story 60, /compact goes to Claude as text and is done at its compact boundary, with the sizes before and after", async () => {
    const r = replay("cmd-compact");
    await r.driver.send(human("Remember the word PINEAPPLE. Reply with exactly: OK"), "turn");
    await r.until(turnEnd);
    expect(await r.driver.command("compact", "")).toEqual({ command: "compact", beforeTokens: 26478, afterTokens: 8274 });
    // The compaction is a turn of its own, with nothing to reply and no work to report.
    expect(await r.until(turnEnd, 2)).toEqual({ conv: "conv-1", proc: 1, type: "turn_end", compactOnly: true });
    await done(r);
  });

  test("approvals-off-questions: with approvals off, questions and plans still reach the user", async () => {
    const r = replay("approvals-off-questions");
    await r.driver.send(
      human("Use the AskUserQuestion tool to ask me one question: tea or coffee? After I answer, reply with just my answer."),
      "turn",
    );
    const q = (await r.until((e) => e.type === "ask")) as Extract<AgentEvent, { type: "ask" }>;
    expect(q.kind).toBe("question");
    await r.driver.answer(q.requestId, { kind: "question", answers: { "Tea or coffee?": "Tea" } });
    await r.until(turnEnd);
    await r.driver.control("set_permission_mode", { mode: "plan" });
    await r.driver.send(human("Make a one-step plan to create tea.txt, then call ExitPlanMode with that plan. Do not ask questions."), "turn");
    const plan = (await r.until((e) => e.type === "ask", 2)) as Extract<AgentEvent, { type: "ask" }>;
    expect(plan.kind).toBe("plan");
    await r.driver.answer(plan.requestId, { kind: "plan", approve: false, message: "Not now. Stop here without doing anything." });
    await r.until(turnEnd, 2);
    await done(r);
    expect(r.events.filter((e) => e.type === "ask").map((e) => (e as { tool: string }).tool)).toEqual(["AskUserQuestion", "ExitPlanMode"]);
  });

  test("answering an ask that is no longer pending fails and writes nothing", async () => {
    const r = replay("basic-turn");
    await expect(r.driver.answer("no-such-ask", { kind: "permission", allow: true })).rejects.toThrow();
    await r.driver.send(human("Use the Read tool to read notes.txt, then tell me in one short sentence how many wicks there are."), "turn");
    await r.until(turnEnd);
    await done(r);
  });
});

test("every Claude recording is replayed above", () => {
  expect(readdirSync(FIXTURES).filter((f) => !replayed.has(f))).toEqual([]);
});

describe("launching claude", () => {
  const bin = mkdtempSync(join(base, "bin-"));
  const [a, b] = ["a", "b"].map((d) => join(bin, d)) as [string, string];
  for (const d of [a, b]) {
    mkdirSync(d);
    writeFileSync(join(d, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const driver = () => new ClaudeDriver({ conv: "conv-1", boot: 1, emit: () => {} });
  const opts = (env: Record<string, string>, more: object = {}) => ({
    cwd: "/slot/work",
    session: { new: "11111111-2222-4333-8444-555555555555" } as { new: string } | { resume: string },
    systemPromptFile: "/slot/prompt.md",
    env,
    approval: true,
    program: "claude",
    ...more,
  });

  test("a new conversation with approvals on: stream-json, prompt file, snapshot off, session id, bypass allowed but off; the parent session's variables are dropped", () => {
    const env = {
      PATH: `${a}:${b}`, HOME: "/home/x", FOO: "bar", CLAUDE_CONFIG_DIR: "/home/x/.claude", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PID: "1", AI_AGENT: "claude", HERDR_PANE_ID: "p",
    };
    expect(driver().spawn(opts(env))).toEqual({
      argv: [
        join(a, "claude"), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--permission-prompt-tool", "stdio", "--include-partial-messages",
        "--append-system-prompt-file", "/slot/prompt.md", "--system-prompt-snapshot", "off",
        "--session-id=11111111-2222-4333-8444-555555555555", "--allow-dangerously-skip-permissions",
      ],
      env: {
        PATH: `${a}:${b}`, HOME: "/home/x", FOO: "bar", CLAUDE_CONFIG_DIR: "/home/x/.claude", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      },
      cwd: "/slot/work",
    });
  });

  test("resuming with approvals off: --resume and bypassPermissions; never --bare or --setting-sources", () => {
    const { argv } = driver().spawn(opts({ PATH: a }, { session: { resume: "abc" }, approval: false }));
    expect(argv.slice(-3)).toEqual(["--resume=abc", "--permission-mode", "bypassPermissions"]);
    expect(argv.filter((x) => x.startsWith("--bare") || x.startsWith("--setting-sources"))).toEqual([]);
  });

  test("the slot's model and effort come as --model and --effort, max included, which --settings would drop", () => {
    const { argv } = driver().spawn(opts({ PATH: a }, { session: { resume: "abc" }, approval: false, model: "haiku", effort: "max" }));
    expect(argv.slice(-7)).toEqual(["--model", "haiku", "--effort", "max", "--resume=abc", "--permission-mode", "bypassPermissions"]);
    expect(argv).not.toContain("--settings");
  });

  test("the slot's ultracode comes as the ultracode settings key, apart from --effort; none set, none passed", () => {
    const on = driver().spawn(opts({ PATH: a }, { session: { resume: "abc" }, approval: false, effort: "high", ultracode: true })).argv;
    expect(on.slice(-7)).toEqual(["--effort", "high", "--settings", '{"ultracode":true}', "--resume=abc", "--permission-mode", "bypassPermissions"]);
    const off = driver().spawn(opts({ PATH: a }, { session: { resume: "abc" }, approval: false, ultracode: false })).argv;
    expect(off.slice(-5)).toEqual(["--settings", '{"ultracode":false}', "--resume=abc", "--permission-mode", "bypassPermissions"]);
  });

  test("a bare program name is looked up on the configured PATH at every launch, so an update is picked up by the next process", () => {
    const d = driver();
    const dir = mkdtempSync(join(base, "bin-"));
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(d.spawn(opts({ PATH: `${dir}:${b}` })).argv[0]).toBe(join(dir, "claude"));
    rmSync(join(dir, "claude"));
    expect(d.spawn(opts({ PATH: `${dir}:${b}` })).argv[0]).toBe(join(b, "claude"));
    expect(() => d.spawn(opts({ PATH: dir }))).toThrow(/claude/);
    expect(() => d.spawn(opts({}))).toThrow(/claude/);
    writeFileSync(join(dir, "my-claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(d.spawn(opts({ PATH: `${a}:${dir}` }, { program: "my-claude" })).argv[0]).toBe(join(dir, "my-claude"));
  });

  test("an absolute program ([programs] claude, the fake agent in tests) is launched as is, whatever claude PATH holds", () => {
    expect(driver().spawn(opts({ PATH: a }, { program: "/opt/fake/claude" })).argv[0]).toBe("/opt/fake/claude");
  });

  test("--bare, in the arguments or as its environment variable, refuses the launch", () => {
    expect(() => driver().spawn(opts({ PATH: a, CLAUDE_CODE_SIMPLE: "1" }))).toThrow(/--bare/);
    expect(() => refuseBare({ argv: ["claude", "-p", "--bare"], env: {}, cwd: "/" })).toThrow(/--bare/);
    expect(() => refuseBare({ argv: ["claude", "-p"], env: { CLAUDE_CODE_SIMPLE: "true" }, cwd: "/" })).toThrow(/--bare/);
    expect(() => refuseBare({ argv: ["claude", "-p"], env: { CLAUDE_CODE_SIMPLE: "0" }, cwd: "/" })).not.toThrow();
  });

  test("the process records the command it was launched with", () => {
    const d = driver();
    const spec = d.spawn(opts({ PATH: a }));
    d.attach(idle(), 1);
    expect(d.info.argv).toEqual(spec.argv);
  });

  test("stories 5 and 6: with the login shell's PATH, claude is the one `command -v claude` finds there", async () => {
    const { shell, username } = userInfo();
    const sh = shell ?? "/bin/sh";
    const login = await exec([sh, "-lic", 'printf "%s\\n" "$PATH"; command -v claude'], {
      env: { HOME: homedir(), USER: username, LOGNAME: username, SHELL: sh, TERM: "dumb", DISABLE_AUTO_UPDATE: "true" },
      timeoutMs: 20_000,
    });
    const [path, claude] = login.out.trim().split("\n").slice(-2);
    if (!claude?.startsWith("/")) return console.warn("no claude in the login shell; nothing to compare");
    expect(driver().spawn(opts({ PATH: path! })).argv[0]).toBe(claude);
  });
});

/** A driver on an in-memory link: what it writes, which signals it sends, and a switch for "exited".
 *  model: the slot's remembered model, which the process is launched with. */
function wired(proc = 1, model?: string) {
  const written: Record<string, any>[] = [];
  const calls: string[] = [];
  let exit = () => {};
  let isDown = false;
  const link = (): AgentLink => ({
    async write(_id, line) {
      if (isDown) throw new Error("link down");
      written.push(JSON.parse(line));
    },
    async eof() {
      calls.push("eof");
    },
    async signal(sig) {
      calls.push(sig);
    },
    exited: new Promise((resolve) => (exit = () => resolve(undefined))),
  });
  const events: AgentEvent[] = [];
  const driver = new ClaudeDriver({ conv: "conv-1", boot: 7, emit: (e) => events.push(e), stopGrace: 100 });
  if (model) driver.spawn({ cwd: "/slot", session: { new: "s-1" }, systemPromptFile: "/slot/prompt.md", env: {}, approval: true, program: "/opt/fake/claude", model });
  driver.attach(link(), proc);
  const feed = (o: unknown) => driver.feed(Buffer.from(`${typeof o === "string" ? o : JSON.stringify(o)}\n`));
  const reply = (id: string, response: object = {}, outer: object = {}) =>
    feed({ type: "control_response", response: { subtype: "success", request_id: id, response, ...outer } });
  return { driver, written, calls, events, feed, reply, link, exit: () => exit(), down: (on: boolean) => (isDown = on) };
}

/** /status, its context and usage requests turned down, as by a CLI without them. */
async function statusOf(w: ReturnType<typeof wired>): Promise<CommandResult> {
  const status = w.driver.command("status", "");
  await Bun.sleep(10);
  for (const m of w.written.splice(0)) {
    if (m.type === "control_request") w.feed({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `Unsupported control request subtype: ${m.request.subtype}` } });
  }
  return status;
}

/** A link that takes every write and never exits. */
const idle = (): AgentLink => ({ write: async () => {}, eof: async () => {}, signal: async () => {}, exited: new Promise(() => {}) });

const sessionState = (state: string) => ({ type: "system", subtype: "session_state_changed", state });
const canUseTool = (id: string) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" },
});

/** A recording's out.log as objects. Its times are read from it, not written in the test: synthesis moves them. */
const recorded = (fixture: string) => readFileSync(join(FIXTURES, fixture, "out.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** The models of the cmd-model recording's handshake: default and opus both resolve to claude-opus-5-5. */
const recordedModels = () =>
  readFileSync(join(FIXTURES, "cmd-model/out.log"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l).response?.response?.models).find(Boolean);

describe("the driver on its own", () => {
  test("request ids carry the boot number", () => {
    const w = wired();
    expect(w.written[0]).toEqual({ type: "control_request", request_id: "rh-7-1", request: { subtype: "initialize", perTaskStopAffordance: true } });
  });

  test("a line over 64MB is skipped with a protocol error; so is a broken JSON line", () => {
    const w = wired();
    const big = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
    big[0] = 0x7b;
    w.driver.feed(big);
    w.feed('{"type":"system",');
    expect(w.events.map((e) => e.type === "protocol_error" && e.reason)).toEqual(["line_too_long", "bad_line"]);
  });

  test("a line replayed after a restart, processed before it, writes nothing: a CLI request is not answered again", async () => {
    const w = wired();
    const before = w.written.length;
    const line = { type: "control_request", request_id: "cli-1", request: { subtype: "hook_callback", callback_id: "x" } };
    w.driver.feed(Buffer.from(`${JSON.stringify(line)}\n`), undefined, true);
    await Bun.sleep(0);
    expect(w.written.slice(before)).toEqual([]);
  });

  test("a handshake reply without pending_permission_requests says the CLI is too old to reconcile", () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [] });
    expect(w.events.at(-1)).toEqual({ conv: "conv-1", proc: 1, type: "pending_asks", asks: null });
  });

  test("a new process: events carry its number, old requests fail, and replies meant for them are dropped", async () => {
    const w = wired();
    w.feed(sessionState("running"));
    w.feed(canUseTool("ask-1"));
    const model = w.driver.control("set_model", { model: "x" });
    await Bun.sleep(0);
    w.driver.attach(w.link(), 2);
    await expect(model).rejects.toThrow();
    await expect(w.driver.answer("ask-1", { kind: "permission", allow: true })).rejects.toThrow();
    const before = w.events.length;
    w.reply("rh-7-2"); // set_model's reply, late
    expect(w.events.length).toBe(before);
    w.reply("rh-7-3", { commands: [] }, { pending_permission_requests: [] });
    w.feed(sessionState("running"));
    expect(w.events.slice(before).map((e) => [e.proc, e.type])).toEqual([
      [2, "commands"], [2, "pending_asks"], [2, "turn_start"], [2, "state"],
    ]);
  });

  test("a new handshake leaves only the asks the CLI still waits on; a reply too old to say leaves none", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [] }, { pending_permission_requests: [] });
    w.feed(canUseTool("ask-1"));
    w.feed(canUseTool("ask-2"));
    w.driver.attach(w.link(), 1); // reconnect to the same process
    w.reply("rh-7-2", { commands: [] }, { pending_permission_requests: [canUseTool("ask-2")] });
    await expect(w.driver.answer("ask-1", { kind: "permission", allow: true })).rejects.toThrow(/no pending ask/);
    w.driver.attach(w.link(), 1);
    w.reply("rh-7-3", { commands: [] });
    await expect(w.driver.answer("ask-2", { kind: "permission", allow: true })).rejects.toThrow(/no pending ask/);
    expect(w.written.filter((f) => f.type === "control_response")).toEqual([]);
  });

  test("an ask answered twice at once is answered once; one whose answer was not written can be answered again", async () => {
    const w = wired();
    w.feed(canUseTool("ask-1"));
    const answers = [true, false].map((allow) => w.driver.answer("ask-1", { kind: "permission", allow }));
    expect((await Promise.allSettled(answers)).map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(w.written.filter((f) => f.type === "control_response")).toHaveLength(1);
    w.feed(canUseTool("ask-2"));
    w.down(true);
    await expect(w.driver.answer("ask-2", { kind: "permission", allow: true })).rejects.toThrow(/link down/);
    w.down(false);
    await w.driver.answer("ask-2", { kind: "permission", allow: true });
    expect(w.written.filter((f) => f.type === "control_response")).toHaveLength(2);
  });

  test("a new process's turn end does not carry the old process's last message as its reply", () => {
    const w = wired();
    w.feed(sessionState("running"));
    w.feed({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "from the old process" }] } });
    w.driver.attach(w.link(), 2);
    w.feed(sessionState("running"));
    w.feed(sessionState("idle"));
    // A second idle, as the CLI sends when a background shell stops after the turn, ends nothing.
    w.feed(sessionState("idle"));
    expect(w.events.filter((e) => e.type === "turn_end")).toEqual([{ conv: "conv-1", proc: 2, type: "turn_end" }]);
  });

  test("a late line from the old process, fed with its number, is dropped", () => {
    const w = wired();
    w.driver.attach(w.link(), 2);
    const before = w.events.length;
    w.driver.feed(Buffer.from(JSON.stringify(canUseTool("ask-old")) + "\n"), 1);
    expect(w.events.length).toBe(before);
    w.driver.feed(Buffer.from(JSON.stringify(sessionState("running")) + "\n"), 2);
    expect(w.events.slice(before).map((e) => [e.proc, e.type])).toEqual([[2, "turn_start"], [2, "state"]]);
  });

  // A background task woke the CLI: that turn's result is its own. A message written as it ends,
  // before Rhodium reads its result and idle, starts the next turn (#129).
  test("a message written as a turn the CLI began itself ends starts the next turn, which says so", async () => {
    const w = wired();
    w.feed(sessionState("running"));
    await w.driver.send({ id: "in-late", text: "hello", human: true }, "turn");
    // Queued is not taken: the message still begins the next turn.
    const uuid = w.written.findLast((f) => f.type === "user")!.uuid;
    w.feed({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
    w.feed({ type: "result", subtype: "success", num_turns: 1, usage: {} });
    w.feed(sessionState("idle"));
    w.feed(sessionState("running"));
    expect(w.events.filter((e) => e.type === "turn_start")).toEqual([
      { conv: "conv-1", proc: 1, type: "turn_start" },
      { conv: "conv-1", proc: 1, type: "turn_start", input: "in-late" },
    ]);
  });

  // Claude takes a message that comes between tool calls into the running turn, with no result of
  // its own; command_lifecycle says when it took each one (#54 acceptance, 2026-10-22).
  test("a message taken into the running turn between its tool calls is no input of a later turn", async () => {
    const w = wired();
    const taken = (state: string) => feed(state, w.written.findLast((f) => f.type === "user")!.uuid);
    const feed = (state: string, uuid: string) => w.feed({ type: "command_lifecycle", command_uuid: uuid, state });
    await w.driver.send({ id: "in-1", text: "look", human: true }, "turn");
    w.feed(sessionState("running"));
    taken("queued");
    taken("started");
    await w.driver.send({ id: "in-2", text: "and also", human: true }, "turn");
    taken("queued");
    taken("started");
    w.feed({ type: "result", subtype: "success", num_turns: 2, usage: {} });
    w.feed(sessionState("idle"));
    // A turn the CLI begins by itself, then one a report begins.
    w.feed(sessionState("running"));
    w.feed({ type: "result", subtype: "success", num_turns: 1, usage: {} });
    w.feed(sessionState("idle"));
    await w.driver.send({ id: "report-1", text: "child done", human: false }, "turn");
    w.feed(sessionState("running"));
    expect(w.events.filter((e) => e.type === "turn_start")).toEqual([
      { conv: "conv-1", proc: 1, type: "turn_start", input: "in-1" },
      { conv: "conv-1", proc: 1, type: "turn_start" },
      { conv: "conv-1", proc: 1, type: "turn_start", input: "report-1" },
    ]);
  });

  // Claude may take a message in while no rhodium runs: the rhodium started since is told what was
  // written and not yet taken, and knows it by its frame's uuid all the same (architecture §4.6).
  test("an input Claude takes into a turn says so, also after a restart; one only queued is not taken", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "look", human: true }, "turn");
    const uuid = w.written.findLast((f) => f.type === "user")!.uuid;
    const lifecycle = (state: string) => ({ type: "command_lifecycle", command_uuid: uuid, state });
    w.feed(lifecycle("queued"));
    expect(w.events.filter((e) => e.type === "taken")).toEqual([]);

    const after = wired(); // the driver of a rhodium started since
    after.driver.untaken(["in-1"]);
    after.feed(lifecycle("started"));
    after.feed(lifecycle("completed"));
    expect(after.events.filter((e) => e.type === "taken")).toEqual([{ conv: "conv-1", proc: 1, type: "taken", inputId: "in-1" }]);
  });

  // A request left behind by a failed write would be rejected by the next attach with no one
  // listening, and an unhandled rejection takes the whole rhodium process down.
  test("interrupt before any process is attached fails, and the attach after it is clean", async () => {
    const d = new ClaudeDriver({ conv: "conv-1", boot: 7, emit: () => {} });
    await expect(d.interrupt()).rejects.toThrow(/no agent process/);
    d.attach(idle(), 1);
    await Bun.sleep(5);
  });

  test("when the link is down, control and interrupt fail, and the next process starts clean", async () => {
    const w = wired();
    w.down(true);
    await expect(w.driver.control("set_model", { model: "x" })).rejects.toThrow(/link down/);
    await expect(w.driver.interrupt()).rejects.toThrow(/link down/); // no receipt capability: still the write counts
    w.down(false);
    w.driver.attach(w.link(), 2);
    await Bun.sleep(5);
  });

  test("a process change while a request is still being written fails that request", async () => {
    const d = new ClaudeDriver({ conv: "conv-1", boot: 7, emit: () => {} });
    const gates: (() => void)[] = [];
    d.attach({ ...idle(), write: () => new Promise<void>((r) => gates.push(r)) }, 1);
    const model = d.control("set_model", { model: "x" });
    d.attach(idle(), 2);
    for (const open of gates) open();
    await expect(model).rejects.toThrow(/replaced/);
  });

  test("story 393: a CLI with no list of windows still gives the 5 hours and the 7 days; extra usage that is on comes in its currency's units; a window of a kind Rhodium does not know is left out", async () => {
    const w = wired();
    const old = w.driver.command("usage", "");
    await Bun.sleep(0);
    w.reply("rh-7-2", {
      rate_limits: {
        five_hour: { utilization: 28, resets_at: "2026-10-24T21:00:00+00:00" },
        seven_day: { utilization: 91, resets_at: null },
        extra_usage: { is_enabled: true, used_credits: 1230, monthly_limit: 5000, utilization: 24.6, currency: "usd", decimal_places: 2 },
      },
    });
    expect(await old).toEqual({
      command: "usage",
      limits: [
        { window: "5h", usedPercent: 28, resetsAt: Date.parse("2026-10-24T21:00:00Z") },
        { window: "7d", usedPercent: 91, resetsAt: null },
      ],
      extra: { usedPercent: 24.6, used: 12.3, limit: 50, currency: "USD" },
    });
    const listed = w.driver.command("usage", "");
    await Bun.sleep(0);
    w.reply("rh-7-3", {
      rate_limits: {
        limits: [{ kind: "session", group: "session", percent: 5, resets_at: null, scope: null }, { kind: "x", group: "monthly", percent: 1, resets_at: null, scope: null }, { kind: "weekly_all", group: "weekly", percent: null, resets_at: null, scope: null }],
        extra_usage: { is_enabled: false, used_credits: null },
      },
    });
    expect(await listed).toEqual({ command: "usage", limits: [{ window: "5h", usedPercent: 5, resetsAt: null }] });
  });

  test("stories 403, 404: /status asks the running process for its context and its quota windows, which cost none, and has the number /context has", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    /** Answers the context and usage requests written since the last answer. */
    const answer = async () => {
      await Bun.sleep(10);
      for (const m of w.written.splice(0)) {
        if (m.request?.subtype === "get_context_usage") w.reply(m.request_id, { totalTokens: 52_000, maxTokens: 200_000, categories: [] });
        if (m.request?.subtype === "get_usage") w.reply(m.request_id, { rate_limits: { limits: [{ kind: "weekly_all", group: "weekly", percent: 91, resets_at: null, scope: null }] } });
      }
    };
    const status = w.driver.command("status", "");
    await answer();
    expect(await status).toEqual({ command: "status", model: null, context: { usedTokens: 52_000, maxTokens: 200_000 }, limits: [{ window: "7d", usedPercent: 91, resetsAt: null }] });
    const context = w.driver.command("context", "");
    await answer();
    expect(await context).toMatchObject({ usedTokens: 52_000, maxTokens: 200_000 });
  });

  test("a CLI without get_context_usage makes /status leave the context out, not fail", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    expect(await statusOf(w)).toEqual({ command: "status", model: null, context: null, limits: [] });
  });

  test("/status answers without the context and the quota when the CLI fails them or keeps them waiting", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    const failed = w.driver.command("status", "");
    await Bun.sleep(10);
    for (const m of w.written.splice(0)) if (m.type === "control_request") w.feed({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "boom" } });
    expect(await failed).toEqual({ command: "status", model: null, context: null, limits: [] });
    const t = Date.now();
    expect(await w.driver.command("status", "")).toEqual({ command: "status", model: null, context: null, limits: [] });
    expect(Date.now() - t).toBeLessThan(5_000);
  }, 10_000);

  test("get_usage is experimental: a CLI without it, or a login without plan limits, makes /usage say there are none, not fail", async () => {
    const w = wired();
    const old = w.driver.command("usage", "");
    await Bun.sleep(0);
    w.feed({ type: "control_response", response: { subtype: "error", request_id: "rh-7-2", error: "Unsupported control request subtype: get_usage" } });
    expect(await old).toEqual({ command: "usage", limits: [] });
    const apiKey = w.driver.command("usage", "");
    await Bun.sleep(0);
    w.reply("rh-7-3", { rate_limits_available: false, rate_limits: null });
    expect(await apiKey).toEqual({ command: "usage", limits: [] });
  });

  test("get_settings is undocumented: a CLI without it makes /effort set the levels, not fail, and /ultracode say the model cannot take it", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    const unsupported = (id: string) =>
      w.feed({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported control request subtype: get_settings" } });
    const set = w.driver.command("effort", "low");
    await Bun.sleep(0);
    unsupported("rh-7-2");
    await Bun.sleep(0);
    w.reply("rh-7-3");
    expect(await set).toEqual({ command: "effort", level: "low" });
    const ultracode = w.driver.command("ultracode", "on");
    await Bun.sleep(0);
    unsupported("rh-7-4");
    expect(await ultracode).toEqual({ command: "ultracode", on: false, unavailable: true });
  });

  test("the model picked is the one marked, not the one listed first that resolves to the same model (docs/im-style.md §9.5)", async () => {
    const w = wired();
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    w.feed({ type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s-1" });
    const marked = async () => {
      const r = await w.driver.command("model", "");
      return r.command === "model" && r.choices?.find((c) => c.current)?.label;
    };
    expect(await marked()).toBe("默认（Opus 5.5）");
    const set = w.driver.command("model", "opus");
    await Bun.sleep(0);
    w.reply("rh-7-2");
    // Then, none set, the level Claude uses on it, marked for the second step (#454).
    await Bun.sleep(0);
    w.reply("rh-7-3", { applied: { effort: "high" } });
    const r = await set;
    expect(r).toMatchObject({ model: "opus", label: "Opus 5.5" });
    expect(r.command === "model" && r.efforts?.filter((c) => c.current).map((c) => c.id)).toEqual(["high"]);
    expect(await marked()).toBe("Opus 5.5");
    expect(await statusOf(w)).toMatchObject({ model: "Opus 5.5" });
    // The next turn's init names the model it resolves to: still the one picked.
    w.feed({ type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s-1" });
    expect(await marked()).toBe("Opus 5.5");
  });

  test("launched with a remembered alias, the model is known before a turn's init names it: /model marks it, /status names it (docs/im-style.md §9.5)", async () => {
    const w = wired(1, "sonnet");
    w.reply("rh-7-1", { commands: [], models: recordedModels() }, { pending_permission_requests: [] });
    const r = await w.driver.command("model", "");
    expect(r.command === "model" && r.choices?.find((c) => c.current)?.label).toBe("Sonnet 5.5");
    expect(await statusOf(w)).toMatchObject({ model: "Sonnet 5.5" });
  });

  test("/compact fails, never hangs, when its turn ends without a boundary; it waits for a running turn to end, being refused till then", async () => {
    const w = wired();
    const failed = w.driver.command("compact", "");
    await Bun.sleep(0);
    expect(w.written.at(-1)).toMatchObject({ type: "user", origin: { kind: "human" }, message: { content: [{ type: "text", text: "/compact" }] } });
    w.feed(sessionState("running"));
    w.feed({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact." });
    await expect(failed).rejects.toThrow("Claude 没有压缩：Not enough messages to compact.");
    w.feed(sessionState("idle"));

    const silent = w.driver.command("compact", "");
    await Bun.sleep(0);
    w.feed(sessionState("running"));
    w.feed(sessionState("idle"));
    await expect(silent).rejects.toThrow("Claude 没有压缩上下文");

    const before = w.written.length;
    w.feed(sessionState("running"));
    await expect(w.driver.command("compact", "")).rejects.toThrow("回合还在进行，先 /stop 再 /compact");
    expect(w.written.length).toBe(before);
  });

  test("a message that joins the /compact's turn makes it a turn of work again", async () => {
    const w = wired();
    const compact = w.driver.command("compact", "");
    await Bun.sleep(0);
    w.feed(sessionState("running"));
    await w.driver.send(human("And now?"), "turn");
    w.feed({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9000, post_tokens: 3000 } });
    await compact;
    w.feed(sessionState("idle"));
    // The next turn, though no message began it, is no compaction either.
    w.feed(sessionState("running"));
    w.feed(sessionState("idle"));
    expect(w.events.filter(turnEnd)).toEqual([
      { conv: "conv-1", proc: 1, type: "turn_end" },
      { conv: "conv-1", proc: 1, type: "turn_end" },
    ]);
  });

  // #226: a subagent in the background holds back the CLI's idle, so its results end the turns.
  test("with a subagent in the background, a result followed by a queued message ends nothing; the queued one's result ends the turn", async () => {
    const w = wired();
    const uuid = () => w.written.findLast((f) => f.type === "user")!.uuid;
    await w.driver.send(human("start it"), "turn");
    w.feed(sessionState("running"));
    w.feed({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "sub" }] });
    await w.driver.send(human("and this"), "steer");
    w.feed({ type: "command_lifecycle", command_uuid: uuid(), state: "queued" });
    w.feed({ type: "result", subtype: "success", num_turns: 1, queued_turn_count: 1, usage: {} });
    w.feed({ type: "command_lifecycle", command_uuid: uuid(), state: "started" });
    w.feed({ type: "system", subtype: "init" });
    w.feed({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "both" }] } });
    w.feed({ type: "result", subtype: "success", num_turns: 1, queued_turn_count: 0, usage: {} });
    expect(w.events.filter((e) => e.type === "turn_start" || e.type === "turn_end").map((e) => e.type)).toEqual(["turn_start", "turn_end"]);
    expect(w.events.find(turnEnd)).toMatchObject({ reply: "both", background: true });
  });

  test("with a subagent in the background, /compact is a turn of its own that ends on its result", async () => {
    const w = wired();
    w.feed(sessionState("running"));
    w.feed({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "sub" }] });
    w.feed({ type: "result", subtype: "success", num_turns: 1, usage: {} });
    const compact = w.driver.command("compact", "");
    await Bun.sleep(0);
    w.feed({ type: "command_lifecycle", command_uuid: w.written.findLast((f) => f.type === "user")!.uuid, state: "started" });
    w.feed({ type: "system", subtype: "init" });
    w.feed({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9000, post_tokens: 3000 } });
    w.feed({ type: "result", subtype: "success", num_turns: 0, usage: {} });
    expect(await compact).toEqual({ command: "compact", beforeTokens: 9000, afterTokens: 3000 });
    expect(w.events.filter(turnEnd).at(-1)).toEqual({ conv: "conv-1", proc: 1, type: "turn_end", background: true, compactOnly: true });
    expect(w.events.filter((e) => e.type === "turn_start")).toHaveLength(2);
  });

  test("a message that is not from you carries no human origin", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "[from child] done", human: false }, "turn");
    expect(w.written[1]).toMatchObject({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[from child] done" }] } });
    expect(w.written[1]!.origin).toBeUndefined();
    expect(w.written[1]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a frame that fails the self-check is not written and is reported", async () => {
    const w = wired();
    await expect(w.driver.send({ id: "in-1", text: undefined as unknown as string, human: true }, "turn")).rejects.toThrow();
    expect(w.written).toHaveLength(1); // only initialize
    expect(w.events.at(-1)).toMatchObject({ type: "protocol_error", reason: "unexpected" });
  });

  test("close: stdin first; it is enough when the process exits in time", async () => {
    const w = wired();
    const closed = w.driver.close();
    await Bun.sleep(20);
    w.exit();
    await closed;
    await Bun.sleep(250);
    expect(w.calls).toEqual(["eof"]);
  });

  test("close: TERM after the grace, KILL after another", async () => {
    const w = wired();
    const t0 = performance.now();
    await w.driver.close();
    expect(w.calls).toEqual(["eof", "TERM", "KILL"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
  });

  test("close refuses while a turn runs or a background task is alive", async () => {
    const w = wired();
    w.feed(sessionState("running"));
    await expect(w.driver.close()).rejects.toThrow();
    w.feed(sessionState("idle"));
    w.feed({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", description: "sleep" }] });
    await expect(w.driver.close()).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
});
