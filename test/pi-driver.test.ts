// Seam 3 (docs/spec/v1.md "接缝三") for pi: the pi driver against the fake agent replaying each
// recording in test/fixtures/pi. The replayer exits 1 with a diff when a line the driver writes
// differs from in.log, so every replay also checks what the driver wrote.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentLink } from "../src/contracts.ts";
import { installApprovalExtension, PiDriver } from "../src/pi.ts";
import { installFakeAgent } from "./fake-agent/fake-agent.ts";

const FIXTURES = join(import.meta.dir, "fixtures/pi");
const replayed = new Set<string>();
const base = mkdtempSync(join(tmpdir(), "rhodium-test-pi-driver-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;

/** Starts the replayer for one recording and attaches a fresh driver to it as process 1. */
function replay(fixture: string) {
  replayed.add(fixture);
  const dir = mkdtempSync(join(base, `${count++}-`));
  const agent = installFakeAgent(dir, { replay: join(FIXTURES, fixture) }, "pi");
  const proc = Bun.spawn([agent.path], { cwd: dir, env: { HOME: dir }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: AgentEvent[] = [];
  const driver = new PiDriver({ conv: "conv-1", boot: 1, emit: (e) => events.push(e), stopGrace: 2000 });
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
  driver.replayed(); // nothing to replay
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

describe("replaying the pi recordings", () => {
  test("turn: a tool call, streamed text, and the turn ends only on agent_settled", async () => {
    const r = replay("turn");
    await r.driver.send(human("Run `echo hello from bash` with the bash tool, then reply with the single word: done."), "turn");
    expect(await r.until(turnEnd)).toMatchObject({ type: "turn_end", reply: "done" });
    // The model pi is on, which /status names (docs/im-style.md §2.4).
    expect((await r.driver.rpc("get_state")).model).toMatchObject({ name: "DeepSeek V4.1 Flash" });
    expect((await r.driver.rpc("get_entries")).entries).toHaveLength(7);
    await done(r);

    expect(brief(r.events)).toEqual([
      "pending:0",
      "turn_start", "state:running", "tool:bash", "text", "message", "usage", "state:idle", "turn_end",
    ]);
    expect(r.events.every((e) => e.conv === "conv-1" && e.proc === 1)).toBe(true);
    expect(text(r.events)).toBe("done");
    const bash = { id: "call_000051070417743505142745048097", name: "bash", input: { command: "echo hello from bash", timeout: null } };
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "tool_start", ...bash });
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "item", item: { kind: "tool", ...bash } });
    // The run's two model calls, added up; the context is what the last one carried.
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "usage", inputTokens: 1220 + 512 + 141 + 1664, outputTokens: 57 + 2, contextTokens: 141 + 1664 });
  });

  test("steer: a message sent while the turn runs goes as steer and joins it; one turn end", async () => {
    const r = replay("steer");
    const first = human("Run `sleep 3 && echo one` with the bash tool and tell me its output.");
    await r.driver.send(first, "turn");
    await r.until((e) => e.type === "turn_start");
    // The runner sends every message as a turn; the driver knows one is running.
    const steer = human("Also end your reply with the word banana.");
    await r.driver.send(steer, "turn");
    const end = (await r.until(turnEnd)) as { reply?: string };
    await done(r);
    expect(end.reply).toEndWith("banana");
    expect(brief(r.events).filter((w) => w === "turn_start" || w === "turn_end")).toEqual(["turn_start", "turn_end"]);
    // Each is taken as it joins the conversation: the steer only once the tool call it came during is over.
    const order = r.events.flatMap((e) => (e.type === "taken" ? [e.inputId] : e.type === "item" && e.item.kind === "tool" ? ["tool"] : []));
    expect(order).toEqual([first.id, "tool", steer.id]);
  });

  test("abort: stops the running tool; the turn ends once pi settles, before abort is answered", async () => {
    const r = replay("abort");
    await r.driver.send(human("Run `sleep 30` with the bash tool."), "turn");
    await r.until((e) => e.type === "turn_start");
    await r.driver.interrupt();
    expect(r.events.filter(turnEnd)).toHaveLength(1);
    await done(r);
    // The aborted turn said nothing, so it has no reply.
    expect(r.events.filter(turnEnd)).toEqual([{ conv: "conv-1", proc: 1, type: "turn_end" }]);
    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running", "tool:bash", "usage", "state:idle", "turn_end"]);
  });

  test("approval-allow: the bash call waits for the approval, read-only tools do not ask", async () => {
    const r = replay("approval-allow");
    await r.driver.send(human("Read notes.txt with the read tool, then run `echo approved` with the bash tool, then reply with the single word: done."), "turn");
    const ask = (await r.until((e) => e.type === "ask")) as Extract<AgentEvent, { type: "ask" }>;
    expect(ask).toMatchObject({ requestId: "00000000-0000-4000-8000-958512fd646c", kind: "permission", tool: "bash", input: { command: "echo approved" } });
    await r.driver.answer(ask.requestId, { kind: "permission", allow: true });
    expect(await r.until(turnEnd)).toMatchObject({ reply: "done" });
    await done(r);
    expect(brief(r.events)).toEqual([
      "pending:0",
      "turn_start", "state:running", "state:waiting", "ask:permission:bash", "state:running",
      "tool:bash", "tool:read", "text", "message", "usage", "state:idle", "turn_end",
    ]);
  });

  test("approval-deny: the reason goes back with the deny", async () => {
    const r = replay("approval-deny");
    await r.driver.send(human("Run `touch denied.txt` with the bash tool."), "turn");
    const ask = (await r.until((e) => e.type === "ask")) as Extract<AgentEvent, { type: "ask" }>;
    await r.driver.answer(ask.requestId, { kind: "permission", allow: false, message: "Not now. Do not retry; just reply with the single word: skipped." });
    expect(await r.until(turnEnd)).toMatchObject({ reply: "skipped." });
    await done(r);
  });

  test("abort-pending-approval: abort settles the turn, and the approval it left is withdrawn", async () => {
    const r = replay("abort-pending-approval");
    await r.driver.send(human("Run `echo pending` with the bash tool."), "turn");
    const ask = (await r.until((e) => e.type === "ask")) as Extract<AgentEvent, { type: "ask" }>;
    await r.driver.interrupt();
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "ask_cancel", requestId: ask.requestId });
    expect(brief(r.events).slice(-5)).toEqual(["tool:bash", "ask_cancel", "usage", "state:idle", "turn_end"]);
    // A withdrawn ask can no longer be answered. pi would ignore the answer anyway, as the
    // recording shows: it was sent, and pi said nothing.
    await expect(r.driver.answer(ask.requestId, { kind: "permission", allow: true })).rejects.toThrow(/no pending ask/);
    await r.link.write("late", JSON.stringify({ type: "extension_ui_response", id: ask.requestId, value: "allow" }));
    expect((await r.driver.rpc("get_state")).isStreaming).toBe(false);
    await done(r);
  });

  test("close-mid-turn: the driver will not close stdin while a turn runs", async () => {
    const r = replay("close-mid-turn");
    await r.driver.send(human("Run `sleep 4 && touch late.txt` with the bash tool, then reply with the single word: done."), "turn");
    await r.until((e) => e.type === "turn_start");
    expect((await r.driver.rpc("get_state")).isStreaming).toBe(true);
    await expect(r.driver.close()).rejects.toThrow(/turn runs/);
    // As the recording did: pi exits at once and never settles.
    await r.link.eof();
    expect(await r.finish()).toEqual({ code: 0, stderr: "" });
    expect(r.events.filter(turnEnd)).toEqual([]);
  });

  test("get-session-stats: /context is the context window's use", async () => {
    const r = replay("get-session-stats");
    expect(await r.driver.command("context", "")).toEqual({ command: "context", usedTokens: 1807, maxTokens: 1_000_000 });
    await done(r);
  });

  test("get-session-stats: stories 395, 397, /usage is the conversation's cost and tokens, and no quota", async () => {
    const r = replay("get-session-stats");
    expect(await r.driver.command("usage", "")).toEqual({
      command: "usage",
      limits: [],
      session: { cost: 0.000492156, tokens: { input: 1361, output: 59, cacheRead: 2176, cacheWrite: 0, total: 3596 } },
    });
    await done(r);
  });

  test("compact: /compact reports the size before and the estimate after", async () => {
    const r = replay("compact");
    expect(await r.driver.command("compact", "")).toEqual({ command: "compact", beforeTokens: 1807, afterTokens: 1593 });
    await done(r);
  });

  test("set-model: a model pi does not have is refused with pi's error", async () => {
    const r = replay("set-model");
    expect(await r.driver.rpc("set_model", { provider: "deepseek", modelId: "deepseek-v4-pro" })).toMatchObject({ id: "deepseek-v4-pro" });
    await expect(r.driver.rpc("set_model", { provider: "deepseek", modelId: "no-such-model" })).rejects.toThrow("Model not found: deepseek/no-such-model");
    expect((await r.driver.rpc("get_state")).model).toMatchObject({ id: "deepseek-v4-pro" });
    await done(r);
  });

  test("set-thinking-level, get-available-models: commands answered with data, no events", async () => {
    const thinking = replay("set-thinking-level");
    await thinking.driver.rpc("set_thinking_level", { level: "bogus" });
    await thinking.driver.rpc("set_thinking_level", { level: "low" });
    expect((await thinking.driver.rpc("get_state")).thinkingLevel).toBe("low");
    await done(thinking);
    expect(brief(thinking.events)).toEqual(["pending:0"]);

    const models = replay("get-available-models");
    expect((await models.driver.rpc("get_available_models")).models.map((m: { provider: string }) => m.provider)).not.toContain("anthropic");
    await done(models);
  });

  test("resume-session-id, new-session, switch-session: session commands", async () => {
    const resumed = replay("resume-session-id");
    for (const type of ["get_state", "get_entries", "get_messages"]) await resumed.driver.rpc(type);
    await done(resumed);

    const fresh = replay("new-session");
    const before = (await fresh.driver.rpc("get_state")).sessionId;
    expect(await fresh.driver.rpc("new_session")).toEqual({ cancelled: false });
    expect((await fresh.driver.rpc("get_state")).sessionId).not.toBe(before);
    await done(fresh);

    const back = replay("switch-session");
    const first = (await back.driver.rpc("get_state")).sessionId;
    await back.driver.rpc("new_session");
    await back.driver.rpc("get_state");
    // the first session, by the path the recording switched back to
    const switched = readFileSync(join(FIXTURES, "switch-session/in.log"), "utf8").split("\n").find((l) => l.includes('"switch_session"'))!;
    const { sessionPath } = JSON.parse(switched.slice(switched.indexOf(" ") + 1));
    expect(await back.driver.rpc("switch_session", { sessionPath })).toEqual({ cancelled: false });
    expect((await back.driver.rpc("get_state")).sessionId).toBe(first);
    await back.driver.rpc("get_messages");
    await done(back);
  });
});

test("every pi recording is replayed above", () => {
  expect(readdirSync(FIXTURES).filter((f) => !replayed.has(f))).toEqual([]);
});

describe("launching pi", () => {
  const bin = mkdtempSync(join(base, "bin-"));
  writeFileSync(join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
  const extensionDir = join(base, "state/pi");
  const driver = () => new PiDriver({ conv: "conv-1", boot: 1, emit: () => {}, extensionDir });
  const opts = (env: Record<string, string>, more: object = {}) => ({
    cwd: "/slot/work",
    session: { new: "11111111-2222-4333-8444-555555555555" } as { new: string } | { resume: string },
    systemPromptFile: "/slot/prompt.md",
    env,
    approval: false,
    program: "pi",
    ...more,
  });

  test("story 13: rpc mode, the session id and the slot's prompt; nothing of Claude's or Anthropic's in the environment", () => {
    const env = {
      PATH: bin, HOME: "/home/x", DEEPSEEK_API_KEY: "sk-ds", RHODIUM_SOCKET: "/run/rh.sock",
      ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_OAUTH_TOKEN: "o", ANTHROPIC_AUTH_TOKEN: "a", CLAUDE_CODE_OAUTH_TOKEN: "c",
      CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "/home/x/.claude", AI_AGENT: "claude", HERDR_PANE_ID: "p",
    };
    expect(driver().spawn(opts(env))).toEqual({
      argv: [join(bin, "pi"), "--mode", "rpc", "--session-id", "11111111-2222-4333-8444-555555555555", "--append-system-prompt", "/slot/prompt.md"],
      env: { PATH: bin, HOME: "/home/x", DEEPSEEK_API_KEY: "sk-ds", RHODIUM_SOCKET: "/run/rh.sock" },
      cwd: "/slot/work",
    });
    expect(existsSync(extensionDir)).toBe(false); // approval mode is off: no extension written
  });

  test("resuming opens the session by the same flag; approval mode writes out the approval extension and loads it", () => {
    const { argv } = driver().spawn(opts({ PATH: bin }, { session: { resume: "abc" }, approval: true }));
    expect(argv.slice(3)).toEqual(["--session-id", "abc", "--append-system-prompt", "/slot/prompt.md", "-e", join(extensionDir, "rhodium-approval.ts")]);
    expect(readFileSync(argv.at(-1)!, "utf8")).toBe(readFileSync(join(import.meta.dir, "../src/pi-approval.ts"), "utf8"));
  });

  test("pi, a `#!/usr/bin/env node` script, is not launched when node is not on the configured PATH", () => {
    const dir = mkdtempSync(join(base, "bin-"));
    writeFileSync(join(dir, "pi"), "#!/usr/bin/env node\nconsole.log(1)\n", { mode: 0o755 });
    expect(() => driver().spawn(opts({ PATH: dir }))).toThrow(/node not found/);
    const node = mkdtempSync(join(base, "bin-"));
    writeFileSync(join(node, "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(driver().spawn(opts({ PATH: `${dir}:${node}` })).argv[0]).toBe(join(dir, "pi"));
    expect(() => driver().spawn(opts({ PATH: node }))).toThrow(/pi not found/);
  });
});

describe("the approval extension", () => {
  /** Loads the installed extension into a stand-in for pi and returns its tool_call handler. */
  async function handler() {
    const dir = mkdtempSync(join(base, "ext-"));
    const file = installApprovalExtension(join(dir, "pi"));
    expect(installApprovalExtension(join(dir, "pi"))).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(join(import.meta.dir, "../src/pi-approval.ts"), "utf8"));
    let on: ((event: object, ctx: object) => Promise<unknown>) | undefined;
    (await import(file)).default({ on: (name: string, f: typeof on) => name === "tool_call" && (on = f) });
    return on!;
  }
  const asking = (answer: string | undefined) => {
    const asked: unknown[][] = [];
    const signal = new AbortController().signal;
    return { asked, signal, ui: { select: async (...a: unknown[]) => (asked.push(a), answer) } };
  };

  test("read-only tools go ahead unasked; any other asks, with its call in the title, and gives up on pi's abort signal", async () => {
    const on = await handler();
    const ctx = asking("allow");
    expect(await on({ toolName: "read", toolCallId: "c1", input: { path: "a" } }, ctx)).toBeUndefined();
    expect(ctx.asked).toEqual([]);
    expect(await on({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, ctx)).toBeUndefined();
    expect(ctx.asked).toEqual([
      ['{"rhodium":"approval","toolCallId":"c2","toolName":"bash","input":{"command":"ls"}}', ["allow", "deny"], { signal: ctx.signal }],
    ]);
  });

  test("a deny blocks the call, with its reason or a plain one; so does a dialog that ended unanswered", async () => {
    const on = await handler();
    const call = { toolName: "edit", toolCallId: "c3", input: {} };
    expect(await on(call, asking("deny: Not now."))).toEqual({ block: true, reason: "Not now." });
    expect(await on(call, asking("deny"))).toEqual({ block: true, reason: "Denied by the user." });
    expect(await on(call, asking(undefined))).toEqual({ block: true, reason: "Denied by the user." });
  });
});

/** A driver on an in-memory link: what it writes, as JSON. */
function wired(proc = 1) {
  const written: Record<string, any>[] = [];
  const link = (): AgentLink => ({
    async write(_id, line) {
      written.push(JSON.parse(line));
    },
    eof: async () => {},
    signal: async () => {},
    exited: new Promise(() => {}),
  });
  const events: AgentEvent[] = [];
  const driver = new PiDriver({ conv: "conv-1", boot: 7, emit: (e) => events.push(e), stopGrace: 100 });
  driver.attach(link(), proc);
  driver.replayed(); // nothing to replay
  const feed = (o: unknown) => driver.feed(Buffer.from(`${typeof o === "string" ? o : JSON.stringify(o)}\n`));
  const respond = (id: string, data?: object, more: object = {}) => feed({ id, type: "response", success: true, ...(data && { data }), ...more });
  return { driver, written, events, feed, respond, link };
}

/** Runs the common command on w's driver, answering each rpc command it writes with answer's. */
async function answering(w: ReturnType<typeof wired>, answer: (c: Record<string, any>) => object, command: "model" | "status", arg: string) {
  let seen = w.written.length;
  let done = false;
  const result = w.driver.command(command, arg);
  result.then(() => (done = true), () => (done = true)); // checked by the caller, after the answers below
  while (!done) {
    await Bun.sleep(0);
    while (seen < w.written.length) w.respond(w.written[seen]!.id, answer(w.written[seen++]!));
  }
  return result;
}

const approval = (id: string, input: object = {}) => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: JSON.stringify({ rhodium: "approval", toolCallId: "c1", toolName: "bash", input }),
  options: ["allow", "deny"],
});

describe("the driver on its own", () => {
  test("a prompt goes under its input's id, other commands under ids with the boot number; images go in the images field", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "what is this?", human: true, images: [{ mimeType: "image/png", data: "iVBORw0K" }] }, "turn");
    w.driver.rpc("get_state").catch(() => {});
    expect(w.written).toEqual([
      { id: "in-1", type: "prompt", message: "what is this?", images: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }] },
      { id: "rh-7-1", type: "get_state" },
    ]);
  });

  test("a message an extension command handled, or one pi refused, starts no run, so its turn ends at once", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "/scoped-model", human: true }, "turn");
    w.respond("in-1", { disposition: "handled" });
    // Nothing runs now, so the next message is a plain prompt, not steering.
    await w.driver.send({ id: "in-2", text: "hello", human: true }, "turn");
    w.respond("in-2", undefined, { success: false, error: "No model selected" });
    expect(w.written.map((c) => c.streamingBehavior)).toEqual([undefined, undefined]);
    expect(brief(w.events)).toEqual(["pending:0", "turn_end", "error:unexpected", "turn_end"]);
    // Neither waits in pi to be taken in.
    expect(w.events.flatMap((e) => (e.type === "taken" ? [e.inputId] : []))).toEqual(["in-1", "in-2"]);
  });

  test("a message pi takes in after a restart says so; one fed again from before the restart took nothing", () => {
    const w = wired();
    w.driver.untaken(["in-old"]);
    const user = (text: string) => Buffer.from(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    w.driver.feed(user("taken before the restart"), 1, true);
    expect(w.events.filter((e) => e.type === "taken")).toEqual([]);
    w.driver.feed(user("taken while rhodium was down"), 1);
    expect(w.events.filter((e) => e.type === "taken")).toEqual([{ conv: "conv-1", proc: 1, type: "taken", inputId: "in-old" }]);
  });

  test("a prompt pi refused or handled while rhodium was down is taken by its answer; the next message pi takes in is the new one", async () => {
    // The last rhodium wrote them and was killed before it read pi's answers.
    const w = wired();
    w.driver.untaken(["in-refused", "in-handled"]);
    w.feed({ id: "in-refused", type: "response", command: "prompt", success: false, error: "No model selected" });
    w.respond("in-handled", { disposition: "handled" });
    await w.driver.send({ id: "in-new", text: "hello", human: true }, "turn");
    w.feed({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
    expect(w.events.flatMap((e) => (e.type === "taken" ? [e.inputId] : []))).toEqual(["in-refused", "in-handled", "in-new"]);
  });

  test("a message or an abort waits for pi to answer the prompt before it: until then pi has no run to steer or stop", async () => {
    // pi reads every line at once and counts a prompt as running only when it answers it, so a
    // second prompt written sooner would start a run of its own, and an abort would find none.
    const w = wired();
    await w.driver.send({ id: "in-1", text: "first", human: true }, "turn");
    const second = w.driver.send({ id: "in-2", text: "second", human: true }, "turn");
    const stop = w.driver.interrupt();
    await Bun.sleep(5);
    expect(w.written.map((c) => c.type)).toEqual(["prompt"]);
    w.respond("in-1", { disposition: "started" });
    await second;
    await Bun.sleep(5);
    expect(w.written.map((c) => [c.type, c.streamingBehavior])).toEqual([["prompt", undefined], ["prompt", "steer"]]);
    w.respond("in-2", { disposition: "queued" });
    await Bun.sleep(5);
    expect(w.written.map((c) => c.type)).toEqual(["prompt", "prompt", "abort"]);
    w.respond(w.written[2]!.id);
    await stop;
  });

  test("an abort also waits for a message that was waiting with it: after a refused prompt that one starts a run of its own", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "first", human: true }, "turn");
    const second = w.driver.send({ id: "in-2", text: "second", human: true }, "turn");
    const stop = w.driver.interrupt();
    w.respond("in-1", undefined, { success: false, error: "No model selected" });
    await second;
    await Bun.sleep(5);
    expect(w.written.map((c) => [c.type, c.streamingBehavior])).toEqual([["prompt", undefined], ["prompt", undefined]]);
    w.respond("in-2", { disposition: "started" });
    await Bun.sleep(5);
    expect(w.written.map((c) => c.type)).toEqual(["prompt", "prompt", "abort"]);
    w.respond(w.written[2]!.id);
    await stop;
  });

  test("a message or a command that could not be written fails, and holds up nothing after it", async () => {
    const w = wired();
    const link = w.link();
    let fail = 2;
    w.driver.attach({ ...link, write: async (id, line) => (fail-- > 0 ? Promise.reject(new Error("holder gone")) : link.write(id, line)) }, 1);
    await expect(w.driver.send({ id: "in-1", text: "first", human: true }, "turn")).rejects.toThrow("holder gone");
    await expect(w.driver.rpc("get_state")).rejects.toThrow("holder gone");
    await w.driver.send({ id: "in-2", text: "second", human: true }, "turn");
    expect(w.written.map((c) => [c.message, c.streamingBehavior])).toEqual([["second", undefined]]);
  });

  test("/compact is refused while a turn runs or is about to: pi's compact aborts the run first", async () => {
    const w = wired();
    await w.driver.send({ id: "in-1", text: "first", human: true }, "turn");
    await expect(w.driver.command("compact", "")).rejects.toThrow("回合还在进行，先 /stop 再 /compact");
    w.respond("in-1", { disposition: "started" });
    w.feed({ type: "agent_start" });
    await expect(w.driver.command("compact", "")).rejects.toThrow("回合还在进行");
    expect(w.written.map((c) => c.type)).toEqual(["prompt"]);
  });

  test("a message waits for /compact to be answered: pi refuses a prompt while it compacts", async () => {
    const w = wired();
    const compact = w.driver.command("compact", "");
    const sent = w.driver.send({ id: "in-1", text: "after", human: true }, "turn");
    await Bun.sleep(5);
    expect(w.written.map((c) => c.type)).toEqual(["compact"]);
    w.respond("rh-7-1", { tokensBefore: 30000, estimatedTokensAfter: 4000 });
    expect(await compact).toEqual({ command: "compact", beforeTokens: 30000, afterTokens: 4000 });
    await sent;
    expect(w.written.map((c) => [c.type, c.streamingBehavior])).toEqual([["compact", undefined], ["prompt", undefined]]);
  });

  test("another extension's dialog is cancelled, or pi would wait for good; its notices are ignored", () => {
    const w = wired();
    w.feed({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Clear session?" });
    w.feed({ type: "extension_ui_request", id: "d2", method: "select", title: "Pick one", options: ["a", "b"] });
    w.feed({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
    expect(w.written).toEqual([
      { type: "extension_ui_response", id: "d1", cancelled: true },
      { type: "extension_ui_response", id: "d2", cancelled: true },
    ]);
    expect(brief(w.events)).toEqual(["pending:0"]);
  });

  test("a line over 64MB, a broken line and a line that is no JSON object are protocol errors", () => {
    const w = wired();
    const big = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
    big[0] = 0x7b;
    w.driver.feed(big);
    w.feed('{"type":"agent_start",');
    w.feed("42");
    expect(brief(w.events)).toEqual(["pending:0", "error:line_too_long", "error:bad_line", "error:bad_line"]);
  });

  test("a new process: events carry its number, old commands fail, their late answers are dropped, and old asks are gone", async () => {
    const w = wired();
    w.feed({ type: "agent_start" });
    w.feed(approval("ask-1"));
    const state = w.driver.rpc("get_state");
    await Bun.sleep(0);
    w.driver.attach(w.link(), 2);
    w.driver.replayed();
    await expect(state).rejects.toThrow(/replaced/);
    await expect(w.driver.answer("ask-1", { kind: "permission", allow: true })).rejects.toThrow(/no pending ask/);
    const before = w.events.length;
    w.respond("rh-7-1", {});
    w.feed({ type: "agent_start" });
    expect(w.events.at(before - 1)).toEqual({ conv: "conv-1", proc: 2, type: "pending_asks", asks: [] });
    expect(w.events.slice(before).map((e) => [e.proc, e.type])).toEqual([[2, "turn_start"], [2, "state"]]);
  });

  test("/model takes a model by its number, its full name, or its id alone when only one provider has it; it shows each by its name", async () => {
    const w = wired();
    const models = { models: [{ provider: "a", id: "flash", name: "A Flash" }, { provider: "b", id: "flash", name: "B Flash" }, { provider: "b", id: "pro", name: "B Pro" }] };
    // pi's answer to each command /model and /status send.
    const answers: Record<string, object> = {
      get_available_models: models,
      get_state: { model: models.models[0], thinkingLevel: "off" },
      set_model: {},
      get_available_thinking_levels: { levels: ["off", "high"] },
      get_session_stats: { contextUsage: { tokens: 48_000, contextWindow: 1_000_000, percent: 4.8 } },
    };
    const run = (arg: string, command: "model" | "status" = "model") => answering(w, (c) => answers[c.type]!, command, arg);
    // Switched, it offers the levels the model takes, for the panel's second step (docs/im-style.md §9.5).
    // Shown by name (docs/im-style.md §2.4); named in commands by provider/id.
    // Each in its provider's group, for the board's (#455).
    expect(await run("")).toEqual({ command: "model", model: "a/flash", level: "off", choices: [
      { id: "a/flash", label: "A Flash", group: "a", current: true }, { id: "b/flash", label: "B Flash", group: "b" }, { id: "b/pro", label: "B Pro", group: "b" },
    ] });
    const efforts = [{ id: "off", label: "off", current: true as const }, { id: "high", label: "high" }];
    expect(await run("2")).toEqual({ command: "model", model: "b/flash", label: "B Flash", efforts, level: "off" });
    expect(await run("a/flash")).toMatchObject({ command: "model", model: "a/flash" });
    expect(await run("pro")).toMatchObject({ command: "model", model: "b/pro" });
    // With a level, it sets that too.
    expect(await run("pro high")).toEqual({ command: "model", model: "b/pro", label: "B Pro", level: "high", was: "off" });
    await expect(run("flash")).rejects.toThrow("叫 flash 的模型不止一个，写全它：a/flash、b/flash");
    await expect(run("4")).rejects.toThrow("没有模型 4。可选：a/flash、b/flash、b/pro");
    expect(w.written.filter((c) => c.type === "set_model").map(({ provider, modelId }) => `${provider}/${modelId}`)).toEqual(["b/flash", "a/flash", "b/pro", "b/pro"]);
    expect(w.written.filter((c) => c.type === "set_thinking_level").map((c) => c.level)).toEqual(["high"]);
    // Story 403: pi's state, and the context as /context has it, as answered above.
    expect(await run("", "status")).toEqual({ command: "status", model: "A Flash", context: { usedTokens: 48_000, maxTokens: 1_000_000 } });
  });

  test("#455: switched, /model marks the level pi is on then, which pi sets anew for the model", async () => {
    const w = wired();
    const model = { provider: "a", id: "pro", name: "A Pro" };
    let level = "off";
    const answer = (c: Record<string, any>) => {
      if (c.type === "set_model") level = "high"; // say, the model's own default in your settings
      return ({ get_available_models: { models: [model] }, get_state: { model, thinkingLevel: level }, get_available_thinking_levels: { levels: ["off", "high"] } } as Record<string, object>)[c.type] ?? {};
    };
    expect(await answering(w, answer, "model", "a/pro")).toEqual({
      command: "model", model: "a/pro", label: "A Pro", efforts: [{ id: "off", label: "off" }, { id: "high", label: "high", current: true }], level: "high",
    });
  });

  test("after a restart, the asks the replayed output leaves open are handed back once it is all fed, not at attach", () => {
    const w = wired();
    w.driver.attach(w.link(), 2); // the restarted rhodium's number for the same process
    const replay = (o: object) => w.driver.feed(Buffer.from(`${JSON.stringify(o)}\n`), 2, true);
    expect(w.events.filter((e) => e.type === "pending_asks")).toHaveLength(1); // wired()'s own
    replay({ type: "agent_start" });
    replay(approval("ask-1", { command: "ls" }));
    w.driver.replayed();
    expect(w.events.at(-1)).toEqual({ conv: "conv-1", proc: 2, type: "pending_asks", asks: [{ requestId: "ask-1", kind: "permission", tool: "bash", input: { command: "ls" }, toolUse: "c1" }] });
  });
});
