// Seam 3 (docs/spec/v1.md "接缝三") for Codex: the Codex driver against the fake agent replaying the
// recordings in test/fixtures/codex (architecture §6.4). The replayer exits 1 with a diff when a line
// the driver writes is not the method the probe wrote there, names another thread or turn, or answers
// a request of Codex's under another id; so every replay also checks what the driver wrote.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver } from "../src/codex.ts";
import type { AgentEvent, AgentLink } from "../src/contracts.ts";
import { installFakeAgent } from "./fake-agent/fake-agent.ts";

const FIXTURES = join(import.meta.dir, "fixtures/codex");
const base = mkdtempSync(join(tmpdir(), "rhodium-test-codex-driver-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const PROMPT = join(base, "prompt.md");
writeFileSync(PROMPT, "the slot's system prompt");

let count = 0;
type Session = { new: string } | { resume: string };

/** The launch options the runner gives; approval off, a new conversation unless said otherwise. */
const opts = (program: string, more: { session?: Session; approval?: boolean; model?: string; effort?: string } = {}) => ({
  cwd: "/slot/work",
  session: { new: "rhodium-made-id" } as Session,
  systemPromptFile: PROMPT,
  env: { PATH: "/usr/bin", HOME: "/home/x" },
  approval: false,
  program,
  ...more,
});

/** Starts the replayer for one recording, launches a fresh driver on it as process 1. */
function replay(fixture: string, more: Parameters<typeof opts>[1] = {}) {
  const dir = mkdtempSync(join(base, `${count++}-`));
  const agent = installFakeAgent(dir, { replay: join(FIXTURES, fixture) }, "codex");
  const proc = Bun.spawn([agent.path], { cwd: dir, env: { HOME: dir }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: AgentEvent[] = [];
  const written: any[] = [];
  const driver = new CodexDriver({ conv: "conv-1", boot: 1, emit: (e) => events.push(e), stopGrace: 2000 });
  const link: AgentLink = {
    async write(_id, line) {
      written.push(JSON.parse(line));
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
  driver.spawn(opts(agent.path, more));
  driver.attach(link, 1);
  driver.replayed();
  return {
    driver,
    events,
    written,
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

/** Closes stdin and expects the replayer to have seen what it needed and nothing else. */
async function done(r: ReturnType<typeof replay>) {
  await r.driver.close();
  expect(await r.finish()).toEqual({ code: 0, stderr: "" });
}

/** One word per event; runs of text deltas count once. */
function brief(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "tool_start" || e.type === "taken") continue; // checked on their own
    const word = e.type === "text_delta" ? "text" : e.type === "item" ? (e.item.kind === "tool" ? `tool:${e.item.name}` : "message") : e.type === "state" ? `state:${e.state}` : e.type === "pending_asks" ? `pending:${e.asks?.length}` : e.type;
    if (!(word === "text" && out.at(-1) === "text")) out.push(word);
  }
  return out;
}

const turnEnd = (e: AgentEvent) => e.type === "turn_end";
const toolStart = (e: AgentEvent) => e.type === "tool_start";
const human = (text: string) => ({ id: `in-${count++}`, text, human: true });
const taken = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "taken" ? [e.inputId] : []));
const sent = (r: { written: any[] }, method: string) => r.written.filter((m) => m.method === method);
type Ask = Extract<AgentEvent, { type: "ask" }>;
const isAsk = (e: AgentEvent) => e.type === "ask";
/** The driver's answers to Codex's requests, in order. */
const answers = (written: any[]) => written.filter((m) => m.method === undefined);
/** The asks, their withdrawals, the states and the turn's ends: what an approval does to a turn. */
const flow = (events: AgentEvent[]) => brief(events).filter((w) => /^(ask|state:|turn_)/.test(w));
const allow = { kind: "permission", allow: true } as const;

describe("replaying the Codex recordings", () => {
  test("story 486: turn: the handshake, a new thread, one turn to turn/completed and its final answer", async () => {
    const r = replay("turn");
    const message = human("Run the shell command `env | grep ^RHODIUM_ | sort`. Then use apply_patch to create hello.txt containing the line hi. Then reply with the single word: ok.");
    await r.driver.send(message, "turn");
    expect(await r.until(turnEnd)).toMatchObject({ type: "turn_end", reply: "ok" });
    await done(r);

    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running", "tool:exec_command", "tool:apply_patch", "text", "message", "usage", "state:idle", "turn_end"]);
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "turn_start", input: message.id });
    // The command as you would type it, out of zsh -lc's quoting (architecture §6.4).
    const exec = r.events.find((e) => e.type === "item" && e.item.kind === "tool" && e.item.name === "exec_command");
    expect(exec).toMatchObject({ item: { input: { command: "env | grep ^RHODIUM_ | sort" } } });
    expect(r.events.find((e) => e.type === "item" && e.item.kind === "tool" && e.item.name === "apply_patch")).toMatchObject({ item: { input: { changes: [{ path: "/tmp/codex-probe/work/project/hello.txt" }] } } });
    // The thread Codex made is the conversation's from now on.
    expect(r.driver.info.session).toBe("00000000-0000-7000-8000-8d5c554c3185");

    // No experimental interface, and none of the deltas Rhodium has no use for.
    const [init] = sent(r, "initialize");
    expect(init.params.capabilities.experimentalApi).toBe(false);
    expect(init.params.capabilities.optOutNotificationMethods).toContain("item/commandExecution/outputDelta");
    expect(init.params.clientInfo.name).toBe("rhodium");
    // Approval off, no sandbox, the slot's prompt as developer instructions, on the thread and on each turn.
    expect(sent(r, "thread/start")[0].params).toEqual({ cwd: "/slot/work", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "the slot's system prompt" });
    expect(sent(r, "turn/start")[0].params).toEqual({
      threadId: "00000000-0000-7000-8000-8d5c554c3185",
      input: [{ type: "text", text: message.text, text_elements: [] }],
      clientUserMessageId: message.id,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("story 488: start-mid-turn: a message while the turn runs is a turn/start too, and joins it", async () => {
    const r = replay("start-mid-turn");
    const first = human("Run the shell command `sleep 5; env | grep ^CODEX_ | cut -d= -f1 | sort`, then reply with the single word: ok.");
    await r.driver.send(first, "turn");
    await r.until(toolStart);
    const second = human("Also end your reply with the word banana.");
    await r.driver.send(second, "steer");
    expect(await r.until(turnEnd)).toMatchObject({ reply: "ok" });
    await done(r);
    expect(brief(r.events).filter((w) => w === "turn_start" || w === "turn_end")).toEqual(["turn_start", "turn_end"]);
    // Each is taken as its user message, which carries its id, joins the conversation.
    expect(taken(r.events)).toEqual([first.id, second.id]);
    expect(sent(r, "turn/start").map((m) => m.params.clientUserMessageId)).toEqual([first.id, second.id]);
    expect(sent(r, "turn/steer")).toEqual([]);
  });

  test("story 488: interrupt: turn/interrupt names the running turn; the command it cut short is closed off, no tool left running", async () => {
    const r = replay("interrupt");
    await r.driver.send(human("Run the shell command `sleep 30`, then reply with the single word: ok."), "turn");
    const start = (await r.until(toolStart)) as Extract<AgentEvent, { type: "tool_start" }>;
    expect(start).toMatchObject({ name: "exec_command", input: { command: "sleep 30" } });
    await r.driver.interrupt();
    await r.until(turnEnd);
    await done(r);
    expect(sent(r, "turn/interrupt")[0].params).toEqual({ threadId: "00000000-0000-7000-8000-b740ae5cbead", turnId: "00000000-0000-7000-8000-36ea5f98ede0" });
    // Codex never completes it: the driver does, before the turn ends.
    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running", "tool:exec_command", "usage", "state:idle", "turn_end"]);
    expect(r.events).toContainEqual({ conv: "conv-1", proc: 1, type: "item", item: { kind: "tool", id: start.id, name: "exec_command", input: { command: "sleep 30" } } });
  });

  test("story 490: restart-idle: an existing conversation is resumed, with approval and sandbox given again, and its turns left out", async () => {
    const r = replay("restart-idle", { session: { resume: "00000000-0000-7000-8000-8d5c554c3185" } });
    await r.driver.send(human("Which file did you create earlier in this conversation? Reply with just the file name."), "turn");
    expect(await r.until(turnEnd)).toMatchObject({ reply: "hello.txt" });
    await done(r);
    expect(sent(r, "thread/resume")[0].params).toEqual({
      threadId: "00000000-0000-7000-8000-8d5c554c3185",
      cwd: "/slot/work",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "the slot's system prompt",
      excludeTurns: true,
    });
    expect(sent(r, "thread/start")).toEqual([]);
  });

  test("story 499: restart-idle: the slot's remembered level goes on each turn/start of the new process", async () => {
    const r = replay("restart-idle", { session: { resume: "00000000-0000-7000-8000-8d5c554c3185" }, effort: "low" });
    await r.driver.send(human("Which file did you create earlier in this conversation? Reply with just the file name."), "turn");
    await r.until(turnEnd);
    await done(r);
    expect(sent(r, "turn/start")[0].params).toMatchObject({ effort: "low" });
    expect(sent(r, "turn/start")[0].params.model).toBeUndefined();
  });

  test("story 501: compact: thread/compact/start runs as a turn of its own, which says it only compacted; the tokens before and after it", async () => {
    const r = replay("compact", { session: { resume: "00000000-0000-7000-8000-8d5c554c3185" } });
    expect(await r.driver.command("compact", "")).toEqual({ command: "compact", beforeTokens: 19328, afterTokens: 8204 });
    await done(r);
    expect(sent(r, "thread/compact/start")[0].params).toEqual({ threadId: "00000000-0000-7000-8000-8d5c554c3185" });
    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running", "usage", "state:idle", "turn_end"]);
    expect(r.events.find(turnEnd)).toEqual({ conv: "conv-1", proc: 1, type: "turn_end", compactOnly: true });
  });

  test("live check 7, ultra-agents: a sub-agent's thread is not the conversation: the turn ends while it runs, and it is a background task till it is done", async () => {
    const r = replay("ultra-agents");
    await r.driver.send(human("Spawn one sub-agent (model gpt-6-luna, reasoning effort low) to run the shell command `sleep 20 && touch agent-done.txt`. Do not wait for it: right after spawning it, reply with the single word: ok."), "turn");
    expect(await r.until(turnEnd)).toMatchObject({ reply: "ok" });
    await r.until((e) => e.type === "background", 2);
    await done(r);
    // Its turn, items and tokens are its own: none of them are the slot's.
    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running", "background", "text", "message", "usage", "state:idle", "turn_end", "background"]);
    expect(r.events.filter((e) => e.type === "tool_start")).toEqual([]);
    const tasks = r.events.flatMap((e) => (e.type === "background" ? [e.tasks] : []));
    expect(tasks).toEqual([[{ id: "00000000-0000-7000-8000-a1d0022d0c27", description: "/root/touch_file" }], []]);
  });

  test("story 491: kill-mid-turn: the process dies mid-command; no turn end comes", async () => {
    const r = replay("kill-mid-turn");
    await r.driver.send(human("Run the shell command `sleep 6 && touch late.txt`, then reply with the single word: ok."), "turn");
    await r.until(toolStart);
    await r.link.eof(); // the recording ends here, as the process did
    expect(await r.finish()).toEqual({ code: 0, stderr: "" });
    expect(brief(r.events)).toEqual(["pending:0", "turn_start", "state:running"]);
  });

  test("story 491: resume-after-kill: the killed turn does not run again by itself, and the driver says so", async () => {
    const r = replay("resume-after-kill", { session: { resume: "00000000-0000-7000-8000-535ba914e173" } });
    // Rhodium writes the resume prompt, as for pi (architecture §4.8).
    expect("selfStarted" in r.driver.info).toBe(false);
    await Bun.sleep(200);
    await done(r);
    expect(brief(r.events)).toEqual(["pending:0"]);
  });

  test("close-mid-turn: the driver will not close stdin while a turn runs", async () => {
    const r = replay("close-mid-turn");
    await r.driver.send(human("Run the shell command `sleep 6 && touch closed.txt`, then reply with the single word: ok."), "turn");
    await r.until(toolStart);
    await expect(r.driver.close()).rejects.toThrow(/turn runs/);
    await r.link.eof();
    expect(await r.finish()).toEqual({ code: 0, stderr: "" });
  });

  test("story 492: resume-locked: the thread is open elsewhere: the driver says so, writes nothing more and lets Codex go", async () => {
    const r = replay("resume-locked", { session: { resume: "00000000-0000-7000-8000-8d5c554c3185" } });
    const message = r.driver.send(human("hello"), "turn");
    await expect(message).rejects.toThrow(/active writer/);
    expect(await r.finish()).toEqual({ code: 0, stderr: "" });
    expect(r.driver.info.busy).toBe("Codex 说别的程序开着它。你自己的 codex 退出后，它连的后台服务还会占一阵，最长 30 分钟。");
    expect(sent(r, "turn/start")).toEqual([]);
  });

  // Recorded under on-request with a read-only sandbox, which the check of approval on refuses
  // (untrusted below); launched with approval off, the asks come all the same.
  test("story 494: approval-accept: a command and a patch each ask, the patch with its diff from item/started; allowed, both run", async () => {
    const r = replay("approval-accept");
    await r.driver.send(human("Run `touch by-shell.txt` (you need write access, so request escalated permissions). Then use apply_patch to create by-patch.txt containing the line hi. Then reply with the single word: done."), "turn");
    const command = (await r.until(isAsk)) as Ask;
    expect(command).toMatchObject({ kind: "permission", tool: "exec_command", input: { command: "touch by-shell.txt" }, toolUse: "exec-00000000-0000-4000-8000-ef97362ec699" });
    await r.driver.answer(command.requestId, allow);
    const patch = (await r.until(isAsk, 2)) as Ask;
    expect(patch).toMatchObject({ kind: "permission", tool: "apply_patch", toolUse: "exec-00000000-0000-4000-8000-9d6da2b67ce2" });
    expect(patch.input).toEqual({ changes: [{ path: "/tmp/codex-probe/work/project/by-patch.txt", kind: { type: "add" }, diff: "hi\n" }] });
    await r.driver.answer(patch.requestId, allow);
    expect(await r.until(turnEnd)).toMatchObject({ reply: "done" });
    await done(r);
    expect(answers(r.written)).toEqual([{ id: 0, result: { decision: "accept" } }, { id: 1, result: { decision: "accept" } }]);
    // Answered by you, so no withdrawal follows Codex's serverRequest/resolved.
    expect(flow(r.events)).toEqual(["turn_start", "state:running", "state:waiting", "ask", "state:running", "state:waiting", "ask", "state:running", "state:idle", "turn_end"]);
  });

  test("story 494: approval-decline: a no without words is a decline, and nothing is steered in", async () => {
    const r = replay("approval-decline");
    await r.driver.send(human("Run `touch by-shell.txt` (you need write access, so request escalated permissions). Then use apply_patch to create by-patch.txt containing the line hi. Then reply with the single word: done."), "turn");
    const command = (await r.until(isAsk)) as Ask;
    await r.driver.answer(command.requestId, { kind: "permission", allow: false });
    await r.until(turnEnd);
    await done(r);
    expect(answers(r.written)).toEqual([{ id: 0, result: { decision: "decline" } }]);
    expect(sent(r, "turn/steer")).toEqual([]);
  });

  test("story 494: patch-decline: the patch's ask shows its diff; declined, Codex goes without it", async () => {
    const r = replay("patch-decline");
    await r.driver.send(human("Use apply_patch to create by-patch.txt containing the line hi. If that is rejected, reply with the single word: skipped."), "turn");
    const patch = (await r.until(isAsk)) as Ask;
    expect(patch).toMatchObject({ tool: "apply_patch", input: { changes: [{ path: "/tmp/codex-probe/work/project/by-patch.txt", diff: "hi\n" }] } });
    await r.driver.answer(patch.requestId, { kind: "permission", allow: false });
    expect(await r.until(turnEnd)).toMatchObject({ reply: "skipped" });
    await done(r);
    expect(answers(r.written)).toEqual([{ id: 0, result: { decision: "decline" } }]);
  });

  test("story 488: interrupt-pending-approval: /stop with an approval open ends the turn and withdraws the ask, once", async () => {
    const r = replay("interrupt-pending-approval");
    await r.driver.send(human("Create an empty file pending.txt with `touch pending.txt`. You need write access, so request escalated permissions."), "turn");
    const ask = (await r.until(isAsk)) as Ask;
    await r.driver.interrupt();
    await r.until(turnEnd);
    await done(r);
    expect(r.events.filter((e) => e.type === "ask_cancel")).toEqual([{ conv: "conv-1", proc: 1, type: "ask_cancel", requestId: ask.requestId }]);
    expect(flow(r.events)).toEqual(["turn_start", "state:running", "state:waiting", "ask", "ask_cancel", "state:idle", "turn_end"]);
    expect(answers(r.written)).toEqual([]);
  });

  test("stories 494, 495: untrusted: approval on asks for every command, ls too, and every patch; a no with your words declines, then steers them into the turn", async () => {
    const r = replay("untrusted", { approval: true });
    await r.driver.send(human("Run the shell command `ls`. Then run `touch a.txt`. Then use apply_patch to create b.txt containing the line hi. Then reply with the single word: done."), "turn");
    for (const n of [1, 2, 3]) await r.driver.answer(((await r.until(isAsk, n)) as Ask).requestId, allow);
    expect(await r.until(turnEnd)).toMatchObject({ reply: "done" });
    await r.driver.send(human("Run the shell command `rm a.txt`, then reply with the single word: done."), "turn");
    const rm = (await r.until(isAsk, 4)) as Ask;
    const words = "Don't delete a.txt. Rename it to a.txt.bak instead, then reply with the single word: renamed.";
    await r.driver.answer(rm.requestId, { kind: "permission", allow: false, message: words });
    await r.driver.answer(((await r.until(isAsk, 5)) as Ask).requestId, allow);
    expect(await r.until(turnEnd, 2)).toMatchObject({ reply: "renamed" });
    await done(r);

    const asked = r.events.flatMap((e) => (e.type === "ask" ? [e.tool === "exec_command" ? (e.input as any).command : e.tool] : []));
    expect(asked).toEqual(["ls", "touch a.txt", "apply_patch", "rm a.txt", "mv a.txt a.txt.bak"]);
    // Every ask, without a sandbox: on the thread and on each turn.
    expect(sent(r, "thread/start")[0].params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
    expect(sent(r, "turn/start").map((m) => m.params.approvalPolicy)).toEqual(["untrusted", "untrusted"]);
    // Codex's no carries no words: they follow it into the turn that asked.
    const decline = r.written.findIndex((m) => m.result?.decision === "decline");
    expect(r.written[decline]).toEqual({ id: 3, result: { decision: "decline" } });
    expect(r.written[decline + 1]).toMatchObject({
      method: "turn/steer",
      params: { threadId: "00000000-0000-7000-8000-63d43a9d34ff", expectedTurnId: "00000000-0000-7000-8000-79a3f54a7a39", input: [{ type: "text", text: words, text_elements: [] }] },
    });
    expect(answers(r.written).map((m) => m.result.decision)).toEqual(["accept", "accept", "accept", "decline", "accept"]);
  });

  test("story 496: mcp-elicitation: an MCP tool's approval asks as an approval of the tool it runs; a form the tool puts is declined unasked", async () => {
    const r = replay("mcp-elicitation", { approval: true });
    await r.driver.send(human("Call the rhprobe MCP tool `note` with the text hi. Then call the rhprobe MCP tool `ask`. Then reply with the single word: done."), "turn");
    const note = (await r.until(isAsk)) as Ask;
    expect(note).toMatchObject({ kind: "permission", tool: "mcp__rhprobe__note", input: { text: "hi" }, toolUse: "exec-00000000-0000-4000-8000-3c1320fad09c" });
    await r.driver.answer(note.requestId, allow);
    const ask = (await r.until(isAsk, 2)) as Ask;
    expect(ask).toMatchObject({ tool: "mcp__rhprobe__ask", input: {}, toolUse: "exec-00000000-0000-4000-8000-cf7f576267a8" });
    await r.driver.answer(ask.requestId, allow);
    await r.until(turnEnd);
    await done(r);
    expect(r.events.filter(isAsk)).toHaveLength(2);
    const accept = { action: "accept", content: null, _meta: null };
    expect(answers(r.written)).toEqual([{ id: 0, result: accept }, { id: 1, result: accept }, { id: 2, result: { ...accept, action: "decline" } }]);
  });

  test("story 502: usage-limit (by hand): a turn refused for the usage limit says the quota is used up till the full window's reset, not that it failed", async () => {
    const r = replay("usage-limit");
    await r.driver.send(human("Run the shell command `env | grep ^RHODIUM_ | sort`. Then reply with the single word: ok."), "turn");
    const end = await r.until(turnEnd);
    await done(r); // with the quota Codex pushed, nothing more is asked
    const quota = r.events.findIndex((e) => e.type === "usage" && e.quota !== undefined);
    const refusal = line("usage-limit", (m) => m.method === "account/rateLimits/updated" && m.params.rateLimits.primary.usedPercent === 100);
    expect(r.events[quota]).toEqual({ conv: "conv-1", proc: 1, type: "usage", quota: { exhausted: true, resetsAt: refusal.params.rateLimits.primary.resetsAt * 1000 } });
    expect(quota).toBeLessThan(r.events.indexOf(end));
    expect(r.events.filter((e) => e.type === "protocol_error")).toEqual([]);
    // Codex's words are the reply, as Claude's refusal is: the router drops it while the slot waits.
    expect(end).toMatchObject({ reply: expect.stringMatching(/^You’ve hit your usage limit\./) });
  });
});

/** A driver on a link that only records what is written, for lines made up here. */
function bare() {
  const events: AgentEvent[] = [];
  const written: any[] = [];
  const driver = new CodexDriver({ conv: "conv-1", boot: 2, emit: (e) => events.push(e), stopGrace: 100 });
  const link: AgentLink = { write: async (_id, line) => void written.push(JSON.parse(line)), eof: async () => {}, signal: async () => {}, exited: new Promise(() => {}) };
  const feed = (m: object, replay = false) => driver.feed(Buffer.from(JSON.stringify(m) + "\n"), undefined, replay);
  return { driver, events, written, link, feed };
}

type Json = Record<string, any>;
const lines = (fixture: string, file: string): string[] =>
  readFileSync(join(FIXTURES, fixture, file), "utf8").split("\n").filter(Boolean);
/** The recorded answer to each method, the first one: the requests' methods from in.log, by id. */
function recorded(...fixtures: string[]): Map<string, Json> {
  const answers = new Map<string, Json>();
  for (const f of fixtures) {
    const methods = new Map(lines(f, "in.log").map((l) => JSON.parse(l.slice(l.indexOf(" ") + 1))).map((m) => [m.id, m.method]));
    for (const m of lines(f, "out.log").map((l) => JSON.parse(l)))
      if (m.method === undefined && methods.has(m.id) && !answers.has(methods.get(m.id))) answers.set(methods.get(m.id), m);
  }
  return answers;
}
/** A recorded line of a recording, the first that matches. */
const line = (fixture: string, pred: (m: Json) => boolean): Json => lines(fixture, "out.log").map((l) => JSON.parse(l)).find(pred);

/** When the handshake's quota window resets, in seconds: a time of the recording's own, which its synthesis moves. */
const handshakeReset = (): number => recorded("handshake").get("account/rateLimits/read")!.result.rateLimits.primary.resetsAt;

/** A new conversation's driver whose every request Codex answers as it did in these recordings (the
 *  handshake's models and quota, the turn's thread), or as `answers` says, null for never; spawn: the slot's remembered settings. */
function answering(fixtures: string[], o: { answers?: Record<string, Json | null>; spawn?: { model?: string; effort?: string } } = {}) {
  const answers = new Map<string, Json | null>(recorded(...fixtures));
  for (const [method, m] of Object.entries(o.answers ?? {})) answers.set(method, m);
  const events: AgentEvent[] = [];
  const written: any[] = [];
  const models: Record<string, string>[] = [];
  const driver = new CodexDriver({ conv: "conv-1", boot: 2, emit: (e) => events.push(e), stopGrace: 100, onModels: (names) => models.push(names) });
  const feed = (m: object) => driver.feed(Buffer.from(JSON.stringify(m) + "\n"));
  const link: AgentLink = {
    async write(_id, l) {
      const m = JSON.parse(l);
      written.push(m);
      const a = m.id !== undefined && answers.get(m.method);
      if (a) queueMicrotask(() => feed({ ...a, id: m.id }));
    },
    eof: async () => {},
    signal: async () => {},
    exited: new Promise(() => {}),
  };
  driver.spawn({ ...opts("/bin/sh"), ...o.spawn });
  driver.attach(link, 1);
  return { driver, events, written, feed, models };
}
const thread = "00000000-0000-7000-8000-8d5c554c3185"; // the turn recording's
/** The tokens the turn recording's thread had in use as the compact recording resumed it. */
const resumedUsage = () => line("compact", (m) => m.method === "thread/tokenUsage/updated");
const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const levels = (ids: string[], now?: string) => ids.map((id) => ({ id, label: id, ...(id === now && { current: true as const }) }));

describe("Codex's common commands", () => {
  test("story 499: /model lists Codex's models by their names, its default as 默认（GPT-6.1-Sol）, the thread's marked; the names are kept for when it does not run", async () => {
    const r = answering(["handshake", "turn"]);
    expect(await r.driver.command("model", "")).toEqual({
      command: "model",
      model: "gpt-6-luna",
      level: "high",
      choices: [
        { id: "default", label: "默认（GPT-6.1-Sol）" },
        { id: "gpt-6-astra", label: "GPT-6-Astra" },
        { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
        { id: "gpt-6-sol", label: "GPT-6-Sol" },
        { id: "gpt-6-luna", label: "GPT-6-Luna", current: true },
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
      ],
    });
    expect(sent(r, "model/list")[0].params).toEqual({ includeHidden: false });
    expect(r.models.at(-1)).toMatchObject({ default: "默认（GPT-6.1-Sol）", "gpt-6.1-sol": "GPT-6.1-Sol", "gpt-6-luna": "GPT-6-Luna" });
  });

  test("story 499: /model <model> takes effect from the next turn, which carries it; its levels follow for the second step; the default is Codex's own again", async () => {
    const r = answering(["handshake", "turn"]);
    expect(await r.driver.command("model", "gpt-6-astra")).toEqual({ command: "model", model: "gpt-6-astra", label: "GPT-6-Astra", level: "high", efforts: levels(LEVELS, "high") });
    await r.driver.send(human("hi"), "turn");
    expect(sent(r, "turn/start")[0].params).toMatchObject({ threadId: thread, model: "gpt-6-astra" });
    // Picked with its level, as the panel's second step does; the default by its own id too.
    expect(await r.driver.command("model", "gpt-6.1-sol low")).toEqual({ command: "model", model: null, label: "默认（GPT-6.1-Sol）", level: "low", was: "high" });
    await r.driver.send(human("again"), "turn");
    expect(sent(r, "turn/start")[1].params).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(await r.driver.command("model", "default")).toMatchObject({ model: null, label: "默认（GPT-6.1-Sol）" });
    await expect(r.driver.command("model", "gpt-9")).rejects.toThrow("没有模型 gpt-9");
    // GPT-6-Luna has no ultra.
    await expect(r.driver.command("model", "gpt-6-luna ultra")).rejects.toThrow("没有思考强度 ultra");
  });

  test("story 499: /model to a model without the level in use moves the level to that model's default, as a level it set too", async () => {
    const r = answering(["handshake", "turn"], { spawn: { model: "gpt-6-astra", effort: "ultra" } });
    // GPT-6-Luna has no ultra; its default is medium.
    expect(await r.driver.command("model", "gpt-6-luna")).toEqual({ command: "model", model: "gpt-6-luna", label: "GPT-6-Luna", level: "medium", was: "ultra", efforts: levels(LEVELS.slice(0, 5), "medium") });
    await r.driver.send(human("hi"), "turn");
    expect(sent(r, "turn/start")[0].params).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
  });

  test("story 499: /effort lists the levels of the model in use, six on GPT-6.1-Sol, five on GPT-6-Luna; the one picked goes on the next turn", async () => {
    const r = answering(["handshake", "turn"]);
    expect(await r.driver.command("effort", "")).toEqual({ command: "effort", level: "high", choices: levels(LEVELS.slice(0, 5), "high") });
    await r.driver.command("model", "default");
    expect(await r.driver.command("effort", "")).toEqual({ command: "effort", level: "high", choices: levels(LEVELS, "high") });
    expect(await r.driver.command("effort", "ultra")).toEqual({ command: "effort", level: "ultra" });
    await r.driver.send(human("hi"), "turn");
    expect(sent(r, "turn/start")[0].params).toMatchObject({ model: "gpt-6.1-sol", effort: "ultra" });
  });

  test("story 499: the slot's remembered model goes on each turn/start of a new process; for one Codex no longer lists, its default does, and it says so", async () => {
    const kept = answering(["handshake", "turn"], { spawn: { model: "gpt-6-astra", effort: "low" } });
    await kept.driver.send(human("hi"), "turn");
    expect(kept.written.map((m) => m.method).slice(0, 4)).toEqual(["initialize", "initialized", "model/list", "thread/start"]);
    expect(sent(kept, "turn/start")[0].params).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    expect(kept.events.filter((e) => e.type === "model_gone")).toEqual([]);

    const gone = answering(["handshake", "turn"], { spawn: { model: "gpt-4-gone", effort: "low" } });
    await gone.driver.send(human("hi"), "turn");
    expect(gone.events).toContainEqual({ conv: "conv-1", proc: 1, type: "model_gone", model: "gpt-4-gone" });
    // Codex's default by its id: a resumed thread would keep the model it had.
    expect(sent(gone, "turn/start")[0].params).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });

    // A level the slot's model does not take: that model's default goes instead.
    const unfit = answering(["handshake", "turn"], { spawn: { model: "gpt-6-luna", effort: "ultra" } });
    await unfit.driver.send(human("hi"), "turn");
    expect(sent(unfit, "turn/start")[0].params).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
  });

  test("story 500: /usage is the account's windows, a model's own, the credits left and this conversation's tokens, with no cost", async () => {
    const r = answering(["handshake", "turn"]);
    r.feed(resumedUsage());
    expect(await r.driver.command("usage", "")).toEqual({
      command: "usage",
      limits: [{ window: "7d", usedPercent: 35, resetsAt: handshakeReset() * 1000 }],
      credits: 1000,
      session: { tokens: { input: 19618, output: 108, cacheRead: 44544, cacheWrite: 0, total: 64270 } },
    });
    // Made up: an account with five hours and seven days, and a model's own bucket; no credits.
    const limits = recorded("handshake").get("account/rateLimits/read")!.result;
    const w = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: handshakeReset() });
    const main = { ...limits.rateLimits, primary: w(28, 300), secondary: w(91, 10080), credits: null };
    const astra = { ...main, limitId: "gpt-6-astra", normalModelSlug: "gpt-6-astra", primary: w(12, 10080), secondary: null };
    const more = answering(["handshake", "turn"], { answers: { "account/rateLimits/read": { result: { ...limits, rateLimits: main, rateLimitsByLimitId: { codex: main, "gpt-6-astra": astra } } } } });
    expect(await more.driver.command("usage", "")).toEqual({
      command: "usage",
      limits: [
        { window: "5h", usedPercent: 28, resetsAt: handshakeReset() * 1000 },
        { window: "7d", usedPercent: 91, resetsAt: handshakeReset() * 1000 },
        { window: "7d", model: "GPT-6-Astra", usedPercent: 12, resetsAt: handshakeReset() * 1000 },
      ],
    });
    // An API key login has no quota (architecture §6.4).
    const key = answering(["handshake", "turn"], { answers: { "account/rateLimits/read": { error: { code: -32600, message: "chatgpt authentication required to read rate limits" } } } });
    expect(await key.driver.command("usage", "")).toEqual({ command: "usage", limits: [] });
  });

  test("story 500: /context is the last request's tokens out of the model's window; before any, Codex cannot say", async () => {
    const r = answering(["handshake", "turn"]);
    await expect(r.driver.command("context", "")).rejects.toThrow("Codex 现在给不出上下文用量，下个回合之后再试");
    r.feed(resumedUsage());
    expect(await r.driver.command("context", "")).toEqual({ command: "context", usedTokens: 19328, maxTokens: 258400 });
  });

  test("story 500: /status is the model by its name and its level, the context as /context has it, and the quota windows", async () => {
    const r = answering(["handshake", "turn"]);
    r.feed(resumedUsage());
    expect(await r.driver.command("status", "")).toEqual({
      command: "status",
      model: "GPT-6-Luna",
      effort: "high",
      context: { usedTokens: 19328, maxTokens: 258400 },
      limits: [{ window: "7d", usedPercent: 35, resetsAt: handshakeReset() * 1000 }],
    });
  });

  test("story 501: a message while Codex compacts waits for the compaction to end, then starts a turn of its own", async () => {
    const r = answering(["handshake", "turn"]);
    const out = lines("compact", "out.log").map((l) => JSON.parse(l));
    const turn = out.slice(out.findIndex((m) => m.id === 2) + 1); // the compaction's turn, after Codex answered thread/compact/start
    const started = turn.findIndex((m) => m.method === "turn/started") + 1;
    r.feed(resumedUsage());
    const compacted = r.driver.command("compact", "");
    await Bun.sleep(10);
    r.feed({ id: sent(r, "thread/compact/start")[0].id, result: {} });
    for (const m of turn.slice(0, started)) r.feed(m);
    await expect(r.driver.command("compact", "")).rejects.toThrow("回合还在进行，先 /stop 再 /compact");
    const message = r.driver.send(human("hi"), "turn");
    await Bun.sleep(10);
    expect(sent(r, "turn/start")).toEqual([]);
    for (const m of turn.slice(started)) r.feed(m);
    expect(await compacted).toEqual({ command: "compact", beforeTokens: 19328, afterTokens: 8204 });
    await message;
    expect(sent(r, "turn/start")).toHaveLength(1);
  });
});

describe("the Codex driver", () => {
  test("story 487: a command Codex splits into two commandActions shows as the whole command, not its first part", () => {
    const { driver, events, link, feed } = bare();
    driver.adopt?.(null, false, null);
    driver.attach(link, 1);
    const item = {
      type: "commandExecution",
      id: "exec-1",
      command: "/usr/bin/zsh -lc 'cat a.txt && cat b.txt'",
      status: "inProgress",
      commandActions: [
        { type: "read", command: "cat a.txt", name: "a.txt", path: "a.txt" },
        { type: "read", command: "cat b.txt", name: "b.txt", path: "b.txt" },
      ],
    };
    feed({ method: "item/started", params: { threadId: "t", turnId: "u", item } });
    expect(events).toContainEqual({ conv: "conv-1", proc: 1, type: "tool_start", id: "exec-1", name: "exec_command", input: { command: "cat a.txt && cat b.txt" } });
  });

  test("story 490: after a Rhodium restart, the thread and the running turn come back from out.log, and /stop stops that turn", async () => {
    const { driver, written, link, feed } = bare();
    const lines = (await Bun.file(join(FIXTURES, "interrupt/out.log")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const upTo = lines.findIndex((m) => m.method === "item/started" && m.params.item.type === "commandExecution");
    driver.adopt?.(null, false, null);
    driver.attach(link, 1);
    for (const m of lines.slice(0, upTo + 1)) feed(m, true);
    driver.replayed();
    expect(driver.info.session).toBe("00000000-0000-7000-8000-b740ae5cbead");
    void driver.interrupt(); // answered by no one here
    await Bun.sleep(10);
    expect(written).toEqual([{ id: "rh-2-1", method: "turn/interrupt", params: { threadId: "00000000-0000-7000-8000-b740ae5cbead", turnId: "00000000-0000-7000-8000-36ea5f98ede0" } }]);
    // Taken over, the process is not set up again.
    expect(written.filter((m) => m.method === "initialize")).toEqual([]);
  });

  test("a request of Codex's the driver does not know gets an error, or the turn would wait on it for good", () => {
    const { driver, written, link, feed } = bare();
    driver.adopt?.(null, false, null);
    driver.attach(link, 1);
    feed({ method: "item/tool/call", id: 7, params: {} });
    feed({ method: "item/tool/call", id: 8, params: {} }, true); // answered before the restart
    expect(written).toEqual([{ id: 7, error: { code: -32601, message: "rhodium does not handle item/tool/call" } }]);
  });

  test("story 494: the approval of a command Codex splits into two commandActions shows the whole command", () => {
    const { driver, events, link, feed } = bare();
    driver.adopt?.(null, true, null);
    driver.attach(link, 1);
    const command = "/usr/bin/zsh -lc 'cat a.txt && cat b.txt'";
    const commandActions = [
      { type: "read", command: "cat a.txt", name: "a.txt", path: "a.txt" },
      { type: "read", command: "cat b.txt", name: "b.txt", path: "b.txt" },
    ];
    feed({ method: "item/commandExecution/requestApproval", id: 0, params: { kind: "command", threadId: "t", turnId: "u", itemId: "exec-1", command, cwd: "/w", commandActions, availableDecisions: ["accept", "cancel"] } });
    expect(events.filter(isAsk)).toEqual([{ conv: "conv-1", proc: 1, type: "ask", requestId: "0", kind: "permission", tool: "exec_command", input: { command: "cat a.txt && cat b.txt" }, toolUse: "exec-1" }]);
  });

  test("story 496: a multiple choice is put to you as a question, and answered by its question's id", async () => {
    const { driver, events, written, link, feed } = bare();
    driver.adopt?.(null, true, null);
    driver.attach(link, 1);
    const question = { id: "pick", header: "Pick", question: "Which one?", isOther: false, isSecret: false, options: [{ label: "A", description: "the first" }, { label: "B", description: "the second" }] };
    feed({ method: "item/tool/requestUserInput", id: 5, params: { threadId: "t", turnId: "u", itemId: "call-q", questions: [question], isBlocking: true, autoResolutionMs: null } });
    const ask = events.find(isAsk) as Ask;
    expect(ask).toMatchObject({ requestId: "5", kind: "question", input: { questions: [{ question: "Which one?", options: question.options, multiSelect: false }] } });
    await driver.answer(ask.requestId, { kind: "question", answers: { "Which one?": "B" } });
    expect(written).toEqual([{ id: 5, result: { answers: { pick: { answers: ["B"] } } } }]);
  });

  test("story 494: more permissions are asked for; allowed, Codex gets what it asked, refused, nothing", async () => {
    const { driver, events, written, link, feed } = bare();
    driver.adopt?.(null, true, null);
    driver.attach(link, 1);
    const permissions = { network: { enabled: true }, fileSystem: { read: null, write: ["/etc/hosts"] } };
    for (const id of [6, 7]) feed({ method: "item/permissions/requestApproval", id, params: { threadId: "t", turnId: "u", itemId: `call-${id}`, environmentId: null, startedAtMs: 0, cwd: "/w", reason: null, permissions } });
    const [yes, no] = events.filter(isAsk) as Ask[];
    expect(yes).toMatchObject({ kind: "permission", tool: "request_permissions", input: permissions, toolUse: "call-6" });
    await driver.answer(yes!.requestId, allow);
    await driver.answer(no!.requestId, { kind: "permission", allow: false });
    expect(written).toEqual([
      { id: 6, result: { permissions, scope: "turn" } },
      { id: 7, result: { permissions: {}, scope: "turn" } },
    ]);
  });

  test("story 496: an MCP server's form or link to open is declined at once, not put to you; one fed again was answered before", () => {
    const { driver, events, written, link, feed } = bare();
    driver.adopt?.(null, true, null);
    driver.attach(link, 1);
    const form = { threadId: "t", turnId: "u", serverName: "s", mode: "form", _meta: null, message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } };
    feed({ method: "mcpServer/elicitation/request", id: 8, params: form });
    feed({ method: "mcpServer/elicitation/request", id: 9, params: { threadId: "t", turnId: "u", serverName: "s", mode: "url", _meta: null, message: "Sign in", url: "https://example.com", elicitationId: "e" } });
    feed({ method: "mcpServer/elicitation/request", id: 10, params: form }, true);
    expect(events.filter(isAsk)).toEqual([]);
    const decline = { action: "decline", content: null, _meta: null };
    expect(written).toEqual([{ id: 8, result: decline }, { id: 9, result: decline }]);
  });

  test("story 490: after a Rhodium restart an approval still open is still asked, and your answer reaches Codex; one answered is not", async () => {
    const lines = (await Bun.file(join(FIXTURES, "untrusted/out.log")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const asked = lines.findIndex((m) => m.method === "item/commandExecution/requestApproval");
    const resolved = lines.findIndex((m) => m.method === "serverRequest/resolved");
    const restart = (upTo: number) => {
      const b = bare();
      b.driver.adopt?.(null, true, null);
      b.driver.attach(b.link, 1);
      for (const m of lines.slice(0, upTo + 1)) b.feed(m, true);
      b.driver.replayed();
      return b;
    };
    const open = restart(asked);
    const pending = open.events.find((e) => e.type === "pending_asks") as Extract<AgentEvent, { type: "pending_asks" }>;
    expect(pending.asks).toEqual([{ requestId: "0", kind: "permission", tool: "exec_command", input: { command: "ls" }, toolUse: expect.any(String) }]);
    await open.driver.answer("0", allow);
    expect(open.written).toEqual([{ id: 0, result: { decision: "accept" } }]);
    expect(restart(resolved).events).toContainEqual({ conv: "conv-1", proc: 1, type: "pending_asks", asks: [] });
  });

  test("story 497: approval switched while Codex runs holds from its next turn/start, which carries it; one taken over after a restart carries the slot's", async () => {
    const { driver, written, link, feed } = bare();
    driver.adopt?.(null, true, null);
    driver.attach(link, 1);
    feed({ id: "rh-0-1", result: { thread: { id: "t" } } }, true); // the thread the last rhodium opened
    await driver.send(human("one"), "turn");
    await driver.approval(false);
    feed({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
    await driver.send(human("two"), "turn");
    await driver.approval(true);
    await driver.send(human("three"), "steer");
    expect(written.filter((m) => m.method === "turn/start").map((m) => m.params.approvalPolicy)).toEqual(["untrusted", "never", "untrusted"]);
  });

  test("story 498: approval on, and Codex no longer takes untrusted: no start, and the reason says so", async () => {
    const why = "这一版 Codex 不再接受“每条都问”的审批设置，审批开的 Codex 槽位起不来。关掉这个槽位的审批再发一条，或者换回旧版 codex。";
    for (const answer of [{ result: { thread: { id: "t" }, approvalPolicy: "on-request" } }, { error: { code: -32600, message: "unknown variant `untrusted`" } }]) {
      const { driver, written, link, feed } = bare();
      let eof = false;
      link.eof = async () => void (eof = true);
      driver.spawn(opts("/bin/sh", { approval: true }));
      driver.attach(link, 1);
      const message = driver.send(human("hello"), "turn");
      feed({ id: "rh-2-1", result: {} });
      await Bun.sleep(10);
      expect(written.find((m) => m.method === "thread/start").params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
      feed({ id: "rh-2-3", ...answer });
      await expect(message).rejects.toThrow();
      expect(driver.info.why).toBe(why);
      expect(eof).toBe(true);
      expect(written.filter((m) => m.method === "turn/start")).toEqual([]);
    }
  });

  /** The usage-limit recording's turn without the refusal's own quota: the one before it has no window full. */
  const refusal = () =>
    lines("usage-limit", "out.log")
      .map((l) => JSON.parse(l))
      .filter((m) => m.method && !(m.method === "account/rateLimits/updated" && m.params.rateLimits.primary.usedPercent === 100));

  test("story 502: with no full window known, Codex's quota is read first; with none to read, as on an API key login, the turn failed as any other", async () => {
    const limits = recorded("handshake").get("account/rateLimits/read")!.result;
    const resetsAt = handshakeReset() + 86_400; // a day after the handshake's window
    const full = { ...limits.rateLimits, primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt } };
    const turn = refusal();
    const read = { result: { ...limits, rateLimits: full, rateLimitsByLimitId: { codex: full } } };
    const key = { error: { code: -32600, message: "chatgpt authentication required to read rate limits" } };
    for (const answer of [read, key]) {
      const r = answering(["handshake", "turn"], { answers: { "account/rateLimits/read": answer } });
      await r.driver.send(human("hi"), "turn");
      for (const m of turn) r.feed(m);
      while (!r.events.some(turnEnd)) await Bun.sleep(1);
      expect(sent(r, "account/rateLimits/read")).toHaveLength(1);
      const failed = r.events.filter((e) => e.type === "protocol_error" || (e.type === "usage" && e.quota));
      if (answer === read) expect(failed).toMatchObject([{ type: "usage", quota: { exhausted: true, resetsAt: resetsAt * 1000 } }]);
      else expect(failed).toMatchObject([{ type: "protocol_error", reason: "unexpected", detail: expect.stringMatching(/^Codex: You’ve hit your usage limit\./) }]);
    }
  });

  test("story 502: Codex's quota never answered holds the refused turn's end only a moment: then it failed as any other", async () => {
    const r = answering(["handshake", "turn"], { answers: { "account/rateLimits/read": null } });
    await r.driver.send(human("hi"), "turn");
    for (const m of refusal()) r.feed(m);
    const until = Date.now() + 4_000;
    while (!r.events.some(turnEnd) && Date.now() < until) await Bun.sleep(5);
    expect(r.events.filter((e) => e.type === "protocol_error")).toMatchObject([{ reason: "unexpected", detail: expect.stringMatching(/^Codex: You’ve hit your usage limit\./) }]);
    expect(r.events.filter(turnEnd)).toHaveLength(1);
  });

  test("story 502: your next message's turn, begun while Codex's quota is read, is not ended by the refused turn's late end", async () => {
    const r = answering(["handshake", "turn"], { answers: { "account/rateLimits/read": null } });
    await r.driver.send(human("hi"), "turn");
    const turn = refusal();
    for (const m of turn) r.feed(m);
    await r.driver.send(human("again"), "turn");
    const started = turn.find((m) => m.method === "turn/started");
    const next = { ...started.params.turn, id: "turn-2" };
    r.feed({ ...started, params: { ...started.params, turn: next } });
    const [read] = sent(r, "account/rateLimits/read");
    r.feed({ id: read.id, result: recorded("handshake").get("account/rateLimits/read")!.result });
    await Bun.sleep(10);
    expect(r.events.filter(turnEnd)).toEqual([]);
    r.feed({ method: "turn/completed", params: { threadId: thread, turn: { ...next, status: "completed" } } });
    expect(r.events.filter(turnEnd)).toHaveLength(1);
    expect(r.events.filter((e) => e.type === "state").at(-1)).toMatchObject({ state: "idle" });
  });

  test("story 484: codex app-server over stdio, on the configured PATH; no Claude keys, no Herdr pane, no parent Codex session", () => {
    const { driver } = bare();
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      CODEX_HOME: "/home/x/.codex",
      OPENAI_API_KEY: "sk-o",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "c",
      HERDR_PANE_ID: "p",
      CODEX_THREAD_ID: "t",
      CODEX_SESSION_ID: "s",
      CODEX_CI: "1",
      CODEX_VERSION: "0.162.1",
      CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1",
    };
    expect(driver.spawn({ ...opts("sh"), env })).toEqual({
      argv: ["/usr/bin/sh", "app-server", "--listen", "stdio://"],
      env: { PATH: "/usr/bin", HOME: "/home/x", CODEX_HOME: "/home/x/.codex", OPENAI_API_KEY: "sk-o" },
      cwd: "/slot/work",
    });
  });
});
