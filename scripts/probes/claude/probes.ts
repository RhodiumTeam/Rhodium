// Real-machine probes 1–11 for the Claude driver (spec "真机探针") and the
// seam-3 recording scenarios. Usage: bun probes.ts <name>... | all | cleanup
// Raw recordings go to $RH_PROBE_OUT (default ~/Rhodium/.scratch/recordings/claude),
// results are appended to results.jsonl there.
// Every probe except p1, p2, p8 and p11 runs haiku turns and uses subscription quota.
// p11 needs RH_PROBE_BIG="label=/path/to/big.jsonl,..." (copies are resumed, never the originals).
// Afterwards: `bun make-fixtures.ts` rebuilds test/fixtures/claude, `bun probes.ts cleanup` tidies up.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { missingNames } from "../../../src/doctor";
import { BASE_ARGS, CLAUDE, Session, claudeVersion, isCanUseTool, probeEnv } from "./session";

const OUT = process.env.RH_PROBE_OUT ?? join(homedir(), "Rhodium/.scratch/recordings/claude");
const PREFIX = "rh-probe-";

const workdir = () => mkdtempSync(join(tmpdir(), PREFIX));
const open = (scenario: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  new Session(join(OUT, scenario), scenario, [...BASE_ARGS, ...args], { cwd: opts.cwd ?? workdir(), env: opts.env });

// A slot launch as architecture §6.2 has it: own work dir, slot prompt file, snapshot off, fixed session id.
type Slot = { s: Session; sid: string; cwd: string; promptFile: string };
function slot(scenario: string, extra: string[] = [], o: { sid?: string; resume?: boolean; prompt?: string; cwd?: string; promptFile?: string; env?: Record<string, string>; snapshot?: boolean } = {}): Slot {
  const root = o.cwd ? join(o.cwd, "..") : workdir();
  const cwd = o.cwd ?? join(root, "work");
  const promptFile = o.promptFile ?? join(root, "slot.md");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  if (!o.promptFile || o.prompt) Bun.write(promptFile, o.prompt ?? "You are a test agent hosted by Rhodium. Keep replies very short.\n");
  const sid = o.sid ?? crypto.randomUUID();
  const args = ["--append-system-prompt-file", promptFile, ...(o.snapshot === true ? [] : ["--system-prompt-snapshot", "off"]),
    o.resume ? `--resume=${sid}` : `--session-id=${sid}`, ...extra];
  return { s: open(scenario, args, { cwd, env: o.env }), sid, cwd, promptFile };
}
const isDelta = (j: any) => j.type === "stream_event" && j.event?.type === "content_block_delta";
const allow = (s: Session, req: any) => s.answer(req.request_id, { behavior: "allow", updatedInput: req.request.input, decisionClassification: "user_temporary" });
const deny = (s: Session, req: any, message: string) => s.answer(req.request_id, { behavior: "deny", message, decisionClassification: "user_reject" });
const kinds = (s: Session) => s.lines.map((l) => l.json
  ? [l.json.type, l.json.subtype ?? l.json.request?.subtype ?? l.json.response?.subtype ?? l.json.event?.type ?? "", l.json.state ?? l.json.request?.tool_name ?? ""].filter(Boolean).join("/")
  : `RAW:${l.raw.slice(0, 60)}`);
const compactKinds = (s: Session) => kinds(s).filter((k) => !k.startsWith("stream_event/content_block_delta"));
// Answer every approval with allow until the turn's result, then wait for idle.
async function allowUntilIdle(s: Session, timeout = 180_000) {
  for (;;) {
    const l = await s.waitFor((j) => isCanUseTool()(j) || j.type === "result", timeout);
    if (l.json.type === "result") { await s.idle(); return l.json; }
    allow(s, l.json);
  }
}
const texts = (s: Session) => s.find((j) => j.type === "result").map((r) => r.result);
const init = (s: Session) => s.control("initialize", { perTaskStopAffordance: true });
const idleAfterResult = async (s: Session) => { const r = await s.waitFor((j) => j.type === "result"); await s.idle(); return r.json; };
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

const probes: Record<string, () => Promise<unknown>> = {
  // 1. Protocol names present in the binary, without running it. rh doctor runs the same check.
  async p1_names() {
    return { version: claudeVersion(), missing: await missingNames(realpathSync(CLAUDE)) };
  },

  // 2. Handshake only: initialize plus query-type control requests, no user message. rh doctor's
  // handshake sends the two of them shown here to use no quota.
  async p2_handshake() {
    const dbg = join(OUT, "p2-handshake-debug.log");
    const s = open("p2-handshake", ["--debug-file", dbg]);
    const t0 = performance.now();
    const initRes = await init(s);
    const initMs = Math.round(performance.now() - t0);
    const ctx = await s.control("get_context_usage", { detail: "summary" });
    const usage = await s.control("get_usage", {});
    const sysInit = await s.waitFor((j) => j.type === "system" && j.subtype === "init", 10_000).then(() => true, () => false);
    await Bun.sleep(15_000);
    const mem = s.memory();
    const usage2 = await s.control("get_usage", {});
    const closeMs = await s.close();
    const debug = readFileSync(dbg, "utf8");
    const apiLines = debug.split("\n").filter((l) => /\/v1\/messages|api\.anthropic\.com|POST |count_tokens|Stream started|API request/i.test(l));
    return {
      initMs, closeMs, exit: s.exitCode,
      initializeResponseKeys: Object.keys(initRes),
      innerKeys: Object.keys(initRes.response ?? {}),
      pending: initRes.pending_permission_requests ?? initRes.response?.pending_permission_requests,
      commandsCount: initRes.response?.commands?.length, models: initRes.response?.models?.map((m: any) => m.value ?? m),
      claude_code_version: initRes.response?.claude_code_version,
      contextUsage: pick(ctx.response, ["totalTokens", "maxTokens", "percentage", "model"]),
      usage: usage.response, usageAfter: usage2.response,
      systemInitWithoutUserMessage: sysInit,
      kinds: s.lines.map((l) => [l.json?.type, l.json?.subtype ?? l.json?.response?.subtype].filter(Boolean).join("/")),
      memory: mem, apiDebugLines: apiLines.slice(0, 40),
    };
  },

  // 8. Garbage on stdin, no model.
  // 3. Minimal turn: result before idle; process survives the turn and takes another.
  async p3_minimal_turn() {
    const { s } = slot("p3-minimal-turn");
    await init(s);
    s.say("Reply with exactly: OK");
    const r1 = await idleAfterResult(s);
    await Bun.sleep(3000);
    const aliveAfterTurn = s.exitCode === null;
    const memoryAfterTurn = s.memory();
    s.say("Reply with exactly: OK2");
    const r2 = await idleAfterResult(s);
    await s.close();
    const k = compactKinds(s);
    const states = s.find((j) => j.type === "system" && j.subtype === "session_state_changed").map((j) => j.state);
    const order = k.filter((x) => x.startsWith("result") || x.includes("session_state_changed"));
    return { aliveAfterTurn, memoryAfterTurnKB: pick(memoryAfterTurn, ["claudeRssKB", "claudePssKB", "treeRssKB", "treePssKB"]), results: [r1.result, r2.result], states, order, kinds: k, exit: s.exitCode,
      systemInitCount: s.find((j) => j.type === "system" && j.subtype === "init").length,
      capabilities: s.find((j) => j.type === "system" && j.subtype === "init")[0]?.capabilities,
      resultKeys: Object.keys(r1), initKeys: Object.keys(s.find((j) => j.type === "system" && j.subtype === "init")[0] ?? {}),
      rateLimitEvents: s.find((j) => j.type === "rate_limit_event") };
  },

  // Seam-3 scenario: a normal turn with streamed text and a tool call (Read needs no approval).
  async basic_turn() {
    const root = workdir();
    Bun.spawnSync(["mkdir", "-p", join(root, "work")]);
    await Bun.write(join(root, "work/notes.txt"), "Lighthouse inventory: 3 lamps, 12 wicks, 1 cat.\n");
    const { s } = slot("basic-turn", [], { cwd: join(root, "work") });
    await init(s);
    s.say("Use the Read tool to read notes.txt, then tell me in one short sentence how many wicks there are.");
    const r = await idleAfterResult(s);
    await s.close();
    return { result: r.result, kinds: compactKinds(s), deltas: s.find(isDelta).length,
      tools: s.find((j) => j.type === "assistant").flatMap((a) => a.message.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.name)),
      approvals: s.find(isCanUseTool()).length };
  },

  // 4a. Approval round trip: allow once, deny once. Records can_use_tool fields.
  async approval() {
    const { s } = slot("approval-allow-deny");
    await init(s);
    s.say("Use the Bash tool to run exactly: echo first > a.txt");
    const a = (await s.waitFor(isCanUseTool("Bash"))).json;
    allow(s, a);
    const r1 = await idleAfterResult(s);
    s.say("Use the Bash tool to run exactly: echo second > b.txt");
    const d = (await s.waitFor(isCanUseTool("Bash"))).json;
    deny(s, d, "The user denied this command.");
    const r2 = await idleAfterResult(s);
    await s.close();
    return { requestKeys: Object.keys(a.request), request: a.request, results: [r1.result, r2.result],
      deniedResult: r2.permission_denials, kinds: compactKinds(s), cancels: s.find((j) => j.type === "control_cancel_request") };
  },

  // 4b + "!" scenario: interrupt while an approval is pending, then send the new message.
  async interrupt_pending() {
    const { s } = slot("interrupt-pending-approval");
    await init(s);
    s.say("Use the Bash tool to run exactly: touch c.txt");
    const a = (await s.waitFor(isCanUseTool("Bash"))).json;
    const intr = await s.control("interrupt");
    const cancel = await s.waitFor((j) => j.type === "control_cancel_request" && j.request_id === a.request_id, 15_000, true)
      .then((l) => l.json, () => null);
    const r1 = await idleAfterResult(s);
    s.say("Never mind that. Reply with exactly: OK");
    const r2 = await idleAfterResult(s);
    await s.close();
    return { interruptResponse: intr, cancel, interruptedResult: pick(r1, ["subtype", "is_error", "result", "stop_reason", "terminal_reason"]),
      after: r2.result, kinds: compactKinds(s) };
  },

  // 5. Re-send initialize while an approval is pending; it should come back in the response.
  async reinitialize() {
    const { s } = slot("reinitialize-pending-approval");
    await init(s);
    s.say("Use the Bash tool to run exactly: touch d.txt");
    const a = (await s.waitFor(isCanUseTool("Bash"))).json;
    const re = await init(s);
    const bg = await s.waitFor((j) => j.type === "system" && j.subtype === "background_tasks_changed", 10_000, true).then((l) => l.json, () => null);
    allow(s, a);
    const r = await idleAfterResult(s);
    await s.close();
    const pending = re.pending_permission_requests ?? [];
    return { pending, matches: pending.some((p: any) => p.request_id === a.request_id || JSON.stringify(p).includes(a.request_id)),
      backgroundTasksChanged: bg, result: r.result, kinds: compactKinds(s) };
  },

  // 6a. Question (AskUserQuestion) in default mode; answer goes into updatedInput.answers.
  async question() {
    const { s } = slot("question");
    await init(s);
    s.say("Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options red and blue. After I answer, reply with just the color.");
    const q = (await s.waitFor(isCanUseTool("AskUserQuestion"))).json;
    const input = q.request.input;
    const first = input.questions[0];
    const choice = first.options.find((o: any) => /blue/i.test(o.label))?.label ?? first.options[1].label;
    s.answer(q.request_id, { behavior: "allow", updatedInput: { ...input, answers: { [first.question]: choice } }, decisionClassification: "user_temporary" });
    const r = await idleAfterResult(s);
    await s.close();
    const toolResult = s.find((j) => j.type === "user" && JSON.stringify(j.message?.content ?? "").includes("tool_result"));
    return { request: q.request, choice, result: r.result, toolResult: toolResult.map((t) => t.message.content), toolUseResult: toolResult.map((t) => t.tool_use_result), kinds: compactKinds(s) };
  },

  // 6b. Plan confirmation in plan mode; records where the plan text lives, then approves.
  async plan() {
    const { s } = slot("plan-confirm", ["--permission-mode", "plan"]);
    await init(s);
    s.say("Make a one-step plan to create hello.txt containing the word hi, then call ExitPlanMode with that plan. Do not ask questions.");
    const p = (await s.waitFor(isCanUseTool("ExitPlanMode"), 180_000)).json;
    allow(s, p);
    const w = await s.waitFor((j) => isCanUseTool()(j) || j.type === "result", 180_000);
    let writeReq = null;
    if (w.json.type === "control_request") { writeReq = w.json.request; allow(s, w.json); }
    const r = await idleAfterResult(s);
    await s.close();
    return { request: p.request, inputKeys: Object.keys(p.request.input), afterApproval: writeReq?.tool_name, result: r.result,
      modes: s.find((j) => j.type === "system" && j.subtype === "status").map((j) => j.permissionMode), kinds: compactKinds(s) };
  },

  // 6c. With approvals off (bypassPermissions): do questions and plan confirmations still reach the host?
  async p6_bypass() {
    const { s } = slot("p6-bypass", ["--permission-mode", "bypassPermissions"]);
    await init(s);
    s.say("Use the AskUserQuestion tool to ask me one question: tea or coffee? After I answer, reply with just my answer.");
    const q = await s.waitFor((j) => isCanUseTool("AskUserQuestion")(j) || j.type === "result", 120_000);
    let question = null;
    if (q.json.type === "control_request") {
      question = q.json.request;
      const first = question.input.questions[0];
      s.answer(q.json.request_id, { behavior: "allow", updatedInput: { ...question.input, answers: { [first.question]: first.options[0].label } } });
    }
    const r1 = await idleAfterResult(s);
    const mode = await s.control("set_permission_mode", { mode: "plan" });
    s.say("Make a one-step plan to create tea.txt, then call ExitPlanMode with that plan. Do not ask questions.");
    const p = await s.waitFor((j) => isCanUseTool("ExitPlanMode")(j) || j.type === "result", 180_000);
    let plan = null;
    if (p.json.type === "control_request") {
      plan = p.json.request;
      deny(s, p.json, "Not now. Stop here without doing anything.");
    }
    const r2 = await idleAfterResult(s);
    await s.close();
    return { questionReachedHost: !!question, planReachedHost: !!plan, setModeResponse: mode, results: [r1.result, r2.result],
      otherApprovals: s.find(isCanUseTool()).filter((j) => !["AskUserQuestion", "ExitPlanMode"].includes(j.request.tool_name)).map((j) => j.request.tool_name),
      modes: s.find((j) => j.type === "system" && (j.subtype === "status" || j.subtype === "init")).map((j) => j.permissionMode), kinds: compactKinds(s) };
  },

  // Seam-3 scenario: a background task finishes after the turn and wakes the session for another round.
  async background_wake() {
    const { s } = slot("background-wake");
    await init(s);
    s.say("Use the Bash tool with run_in_background set to true to run exactly: sleep 8; echo bg-done. Then reply STARTED and end your turn. When it finishes, reply with its output.");
    const r1 = await allowUntilIdle(s);
    const r2 = await s.waitFor((j) => j.type === "result", 90_000).then((l) => l.json, () => null);
    await s.idle(30_000).catch(() => null);
    await s.close();
    return { first: r1.result, second: r2?.result, secondResultKeys: r2 && pick(r2, ["result_index", "resume_reason", "num_turns"]),
      tasks: s.find((j) => j.type === "system" && /task|background/.test(j.subtype)).map((j) => pick(j, ["subtype", "status", "task_id", "tasks", "summary"])),
      kinds: compactKinds(s) };
  },

  // #226: a background Agent subagent outlives its turn. Records the order of result, session state,
  // background_tasks_changed and task_notification across that turn, your next message, and the
  // subagent's end. The subagent runs on haiku too.
  async background_agent() {
    const { s } = slot("background-agent", ["--permission-mode", "bypassPermissions"], { env: probeEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku" }) });
    await init(s);
    s.say("Use the Agent tool with run_in_background set to true to start one general-purpose subagent with this task: " +
      "\"Run the Bash command `sleep 30`, then reply with exactly SUB-DONE.\" Do not wait for it. Reply STARTED and end your turn.");
    const r1 = (await s.waitFor((j) => j.type === "result", 120_000)).json;
    await Bun.sleep(2000);
    s.say("Reply with exactly: SECOND");
    const r2 = (await s.waitFor((j) => j.type === "result", 60_000)).json;
    const r3 = await s.waitFor((j) => j.type === "result", 120_000).then((l) => l.json, () => null);
    await s.idle(60_000).catch(() => null);
    await s.close();
    const order = compactKinds(s).filter((k) => /^(result|command_lifecycle|system\/(session_state_changed|background_tasks_changed|task_notification|init))/.test(k));
    return { results: [r1.result, r2.result, r3?.result], queued: [r1, r2, r3].map((r) => r?.queued_turn_count),
      tasks: s.find((j) => j.type === "system" && j.subtype === "background_tasks_changed").map((j) => j.tasks.map((t: any) => t.task_type)), order };
  },

  // 7. Close stdin while a background task runs: does the CLI wait for it, and does --resume continue?
  async p7_close_with_bg() {
    const a1 = slot("p7-close-with-bg");
    const s = a1.s;
    await init(s);
    s.say("Use the Bash tool with run_in_background set to true to run exactly: sleep 15; echo bg-finished-42. Then reply STARTED and end your turn.");
    await allowUntilIdle(s);
    const closeMs = await s.close(120_000);
    const after = s.find((j) => j.type === "system" && j.subtype === "task_notification");
    const b = slot("p7-resume-after-close", [], { sid: a1.sid, resume: true, cwd: a1.cwd, promptFile: a1.promptFile });
    await init(b.s);
    b.s.say("What did the background command print? Reply with just its output, or UNKNOWN.");
    const r = await idleAfterResult(b.s);
    await b.s.close();
    return { closeMs, exit: s.exitCode, taskNotificationsBeforeExit: after.map((j) => pick(j, ["status", "summary"])),
      resultsBeforeExit: s.find((j) => j.type === "result").map((j) => j.result), tail: compactKinds(s).slice(-12),
      resumedAnswer: r.result };
  },

  // Seam-3 scenario: a second user message while the turn is still running (merged by default).
  async mid_turn() {
    const { s } = slot("mid-turn-message");
    await init(s);
    s.say("Count from 1 to 40, one number per line, nothing else.");
    await s.waitFor(isDelta);
    s.say("Also, after the last number, write the word DONE.");
    const r1 = await idleAfterResult(s);
    await Bun.sleep(2000);
    await s.close();
    return { results: texts(s).map((t) => t.slice(-40)), lifecycle: s.find((j) => j.type === "command_lifecycle").map((j) => `${j.command_uuid?.slice(0, 8)}:${j.state}`),
      queued_turn_count: s.find((j) => j.type === "result").map((j) => j.queued_turn_count), last: r1.result?.slice(-30), kinds: compactKinds(s) };
  },

  // 9. kill -9 mid-turn, then --resume with and without CLAUDE_CODE_RESUME_INTERRUPTED_TURN; send nothing but initialize.
  async p9_crash_resume() {
    const out: Record<string, unknown> = {};
    for (const withVar of [true, false]) {
      const tag = withVar ? "with-var" : "without-var";
      const a = slot(`p9-crash-${tag}`);
      await init(a.s);
      a.s.say("Write a 300-word story about a lighthouse keeper.");
      await a.s.waitFor(isDelta);
      await Bun.sleep(500);
      await a.s.kill9();
      const env = probeEnv(withVar ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" } : {});
      const b = slot(`p9-resume-${tag}`, [], { sid: a.sid, resume: true, cwd: a.cwd, promptFile: a.promptFile, env });
      await init(b.s);
      const r = await b.s.waitFor((j) => j.type === "result", 60_000).then((l) => l.json, () => null);
      if (r) await b.s.idle(30_000).catch(() => null);
      await b.s.close();
      out[tag] = { autoTurn: !!r, result: r && pick(r, ["subtype", "resume_reason", "num_turns", "result_index"]), resultText: r?.result?.slice(0, 120),
        resumeReasons: b.s.find((j) => j.resume_reason != null).map((j) => `${j.type}:${j.resume_reason}`), kinds: compactKinds(b.s) };
    }
    return out;
  },

  // 10. With --system-prompt-snapshot off, does --resume pick up an edited append-prompt file? Control run with the default.
  async p10_snapshot() {
    const out: Record<string, unknown> = {};
    for (const snapshot of [false, true]) {
      const tag = snapshot ? "snapshot-default" : "snapshot-off";
      const ask = "Ignore earlier answers. Read your current system prompt and reply with only the codeword it states.";
      const a = slot(`p10-${tag}-1`, [], { prompt: "The codeword is ALPHA.\n", snapshot });
      await init(a.s);
      a.s.say(ask);
      const r1 = await idleAfterResult(a.s);
      await a.s.close();
      await Bun.write(a.promptFile, "The codeword is BRAVO.\n");
      const b = slot(`p10-${tag}-2`, [], { sid: a.sid, resume: true, cwd: a.cwd, promptFile: a.promptFile, snapshot });
      await init(b.s);
      b.s.say(ask);
      const r2 = await idleAfterResult(b.s);
      await b.s.close();
      out[tag] = { before: r1.result, afterResume: r2.result };
    }
    return out;
  },

  // Seam-3: the nine common commands, one recording each.
  async commands() {
    const out: Record<string, unknown> = {};
    // /new: close stdin after a turn; the driver then starts a fresh --session-id.
    { const { s } = slot("cmd-new"); await init(s); s.say("Reply with exactly: OK"); await idleAfterResult(s);
      out.new = { closeMs: await s.close(), exit: s.exitCode }; }
    // /stop: interrupt a running turn with no pending question.
    { const { s } = slot("cmd-stop"); await init(s); s.say("Count from 1 to 300, one number per line, nothing else.");
      await s.waitFor(isDelta); const intr = await s.control("interrupt"); const r = await idleAfterResult(s); await s.close();
      out.stop = { interrupt: intr, result: pick(r, ["subtype", "is_error", "terminal_reason", "stop_reason"]) }; }
    // /status: Rhodium's own state plus the last result's usage; a plain turn is all the CLI side has.
    { const { s } = slot("cmd-status"); await init(s); s.say("Reply with exactly: OK"); const r = await idleAfterResult(s); await s.close();
      out.status = pick(r, ["usage", "modelUsage", "total_cost_usd"]); }
    // /model: list from initialize, then set_model and run a turn on it.
    { const { s } = slot("cmd-model"); const i = await init(s);
      const m = await s.control("set_model", { model: "claude-haiku-4-5-20251001" }); s.say("Reply with exactly: OK"); await idleAfterResult(s); await s.close();
      out.model = { models: i.response.models.map((x: any) => x.value), setModel: m,
        initModels: s.find((j) => j.type === "system" && j.subtype === "init").map((j) => j.model) }; }
    // /compact: send the text command after one turn, wait for compact_boundary.
    { const { s } = slot("cmd-compact"); await init(s); s.say("Remember the word PINEAPPLE. Reply with exactly: OK"); await idleAfterResult(s);
      s.say("/compact"); const b = await s.waitFor((j) => j.type === "system" && j.subtype === "compact_boundary", 180_000).then((l) => l.json, () => null);
      await s.idle(60_000).catch(() => null); await s.close();
      out.compact = { boundary: b && b.compact_metadata, kinds: compactKinds(s).slice(-15) }; }
    // /usage and /context: control requests only, no model.
    { const { s } = slot("cmd-usage"); await init(s); const u = await s.control("get_usage", { skip_behaviors: true }); await s.close(); out.usage = Object.keys(u.response ?? {}); }
    { const { s } = slot("cmd-context"); await init(s); const c = await s.control("get_context_usage", { detail: "summary" }); await s.close();
      out.context = Object.keys(c.response ?? {}); }
    // /resume <id>: a second process resumes the first one's conversation.
    { const a = slot("cmd-resume-source"); await init(a.s); a.s.say("Remember the word MANGO. Reply with exactly: OK"); await idleAfterResult(a.s); await a.s.close();
      const b = slot("cmd-resume", [], { sid: a.sid, resume: true, cwd: a.cwd, promptFile: a.promptFile }); await init(b.s);
      b.s.say("Which word did I ask you to remember? Reply with just the word."); const r = await idleAfterResult(b.s); await b.s.close();
      out.resume = r.result; }
    out.effort = await probes.cmd_effort!();
    return out;
  },

  // /effort: picking a level asks get_settings whether ultracode is on, then sets the level with
  // apply_flag_settings, ultracode as it was (#276); then a turn.
  // /usage after a turn (#326): get_usage's session block then has the conversation's cost and tokens by model.
  async cmd_usage_session() {
    const { s } = slot("cmd-usage-session"); await init(s);
    s.say("Reply with exactly: OK"); await idleAfterResult(s);
    const u = await s.control("get_usage", { skip_behaviors: true }); await s.close();
    return u.response?.session;
  },

  async cmd_effort() {
    const { s } = slot("cmd-effort"); await init(s);
    const g = await s.control("get_settings");
    const e = await s.control("apply_flag_settings", { settings: { effortLevel: "low", ultracode: false } });
    s.say("Reply with exactly: OK"); await idleAfterResult(s); await s.close();
    return { applied: g.response?.applied, response: e, initEffort: s.find((j) => j.type === "system" && j.subtype === "init").map((j) => [j.effort, j.per_turn_effort_active]) };
  },

  // ultracode apart from the level (#276): launched with --effort high and the ultracode settings key,
  // get_settings says high with ultracode on; a level set with ultracode: true keeps it; ultracode
  // alone keeps the level; then a turn with ultracode on, and the markers the transcript has.
  async cmd_ultracode() {
    const { s, sid, cwd } = slot("cmd-ultracode", ["--effort", "high", "--settings", JSON.stringify({ ultracode: true })]); await init(s);
    const applied = async () => (await s.control("get_settings")).response?.applied;
    const launched = await applied();
    await s.control("apply_flag_settings", { settings: { effortLevel: "low", ultracode: true } }); const level = await applied();
    await s.control("apply_flag_settings", { settings: { ultracode: false } }); const off = await applied();
    await s.control("apply_flag_settings", { settings: { ultracode: true } }); const on = await applied();
    s.say("Reply with exactly: OK"); const r = await idleAfterResult(s); await s.close();
    const transcript = join(homedir(), ".claude/projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
    const markers = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((j) => j.type === "attachment" && /ultra/.test(j.attachment?.type ?? "")).map((j) => j.attachment.type);
    return { launched, level, off, on, result: r.result, init: s.find((j) => j.type === "system" && j.subtype === "init").map((j) => j.effort), markers };
  },

  // 11. Resume copies of big conversations under a new session id: time until initialize answers, and memory then.
  // Sources come from RH_PROBE_BIG="label=path,..."; a subagent transcript is turned into a main-chain one.
  async p11_big_resume() {
    const sources = (process.env.RH_PROBE_BIG ?? "").split(",").filter(Boolean).map((x) => x.split("=") as [string, string]);
    const out: Record<string, unknown> = {};
    for (const [label, src] of sources) {
      const root = workdir(); const cwd = join(root, "work"); Bun.spawnSync(["mkdir", "-p", cwd]);
      const proj = join(homedir(), ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      Bun.spawnSync(["mkdir", "-p", proj]);
      const sid = crypto.randomUUID();
      const lines = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => {
        const j = JSON.parse(l);
        if (j.sessionId) j.sessionId = sid;
        if (j.isSidechain) { j.isSidechain = false; delete j.agentId; }
        return JSON.stringify(j);
      });
      const copy = join(proj, `${sid}.jsonl`);
      await Bun.write(copy, lines.join("\n") + "\n");
      const bytes = Bun.file(copy).size;
      const s = open(`p11-resume-${label}`, [`--resume=${sid}`], { cwd });
      let peakKB = 0;
      const sampler = setInterval(() => { peakKB = Math.max(peakKB, s.memory().treeRssKB); }, 100);
      const t0 = performance.now();
      const ir = await s.control("initialize", { perTaskStopAffordance: true }, 300_000);
      const initMs = Math.round(performance.now() - t0);
      const memAtInit = s.memory();
      // get_context_usage needs the loaded conversation, so its answer bounds when the history is in memory.
      const ctx = await s.control("get_context_usage", { detail: "summary" }, 120_000).catch(() => null);
      const ctxMs = Math.round(performance.now() - t0);
      await Bun.sleep(10_000);
      clearInterval(sampler);
      const memSettled = s.memory();
      await s.close(60_000);
      rmSync(copy);
      out[label] = { mb: +(bytes / 1048576).toFixed(1), lines: lines.length, initMs, ctxMs, initOk: ir.subtype,
        peakMB: Math.round(peakKB / 1024), memAtInitMB: Math.round(memAtInit.treeRssKB / 1024), memSettledMB: Math.round(memSettled.treeRssKB / 1024), pssSettledMB: Math.round(memSettled.treePssKB / 1024),
        contextTokens: ctx?.response?.totalTokens, systemInitSeen: s.find((j) => j.type === "system" && j.subtype === "init").length > 0,
        modelCalls: s.find((j) => j.type === "result").length };
    }
    return out;
  },

  // Each case in its own process, since one bad line may end it.
  async p8_bad_input() {
    const cases: Record<string, (s: Session) => Promise<unknown>> = {
      "not-json": async (s) => s.sendRaw("not json"),
      "unknown-type": async (s) => s.sendRaw(`{"type":"rh_unknown_type","x":1}`),
      "user-without-message": async (s) => s.send({ type: "user", uuid: crypto.randomUUID(), parent_tool_use_id: null }),
      "unknown-control-subtype": (s) => s.control("rh_unknown_subtype", {}, 15_000).catch((e) => ({ noResponse: String(e) })),
      "unknown-field": (s) => s.control("get_context_usage", { detail: "summary", rh_unknown_field: 1 }, 15_000)
        .then((r) => r.subtype, (e) => ({ noResponse: String(e) })),
    };
    const out: Record<string, unknown> = {};
    for (const [name, act] of Object.entries(cases)) {
      const s = open(`p8-bad-input-${name}`);
      await init(s);
      const response = await act(s);
      await Bun.sleep(3000);
      const alive = s.exitCode === null && await s.control("get_context_usage", { detail: "summary" }, 15_000).then(() => true, () => false);
      await s.close();
      out[name] = { response, stillAnswering: alive, exit: s.exitCode,
        err: readFileSync(join(OUT, `p8-bad-input-${name}/err.log`), "utf8").slice(-500) };
    }
    return out;
  },
};

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "cleanup") return cleanup();
  const names = args[0] === "all" ? Object.keys(probes) : args;
  for (const name of names) {
    const fn = probes[name];
    if (!fn) throw new Error(`unknown probe ${name}; known: ${Object.keys(probes).join(" ")}`);
    const t0 = Date.now();
    let result: unknown;
    try { result = await fn(); } catch (e) { result = { error: String(e), stack: (e as Error).stack }; }
    const rec = { probe: name, at: new Date().toISOString(), ms: Date.now() - t0, result };
    appendFileSync(join(OUT, "results.jsonl"), JSON.stringify(rec) + "\n");
    console.log(JSON.stringify(rec, null, 2));
  }
}

// Remove the temp work dirs and only what the probes left under ~/.claude:
// project records for the temp dirs, and plan files plan mode wrote for them.
function cleanup() {
  const projects = join(homedir(), ".claude/projects");
  for (const d of readdirSync(projects)) if (d.includes(PREFIX)) { rmSync(join(projects, d), { recursive: true }); console.log("rm", d); }
  const plans = join(homedir(), ".claude/plans");
  for (const f of readdirSync(plans)) if (readFileSync(join(plans, f), "utf8").includes(`/${PREFIX}`)) { rmSync(join(plans, f)); console.log("rm plan", f); }
  for (const d of readdirSync(tmpdir())) if (d.startsWith(PREFIX)) rmSync(join(tmpdir(), d), { recursive: true });
  // Background-task output files Claude keeps under its own temp dir, keyed by the work dir.
  const ctmp = join(tmpdir(), `claude-${process.getuid!()}`);
  for (const d of existsSync(ctmp) ? readdirSync(ctmp) : []) if (d.includes(PREFIX)) rmSync(join(ctmp, d), { recursive: true });
}

await Bun.$`mkdir -p ${OUT}`;
await main();
process.exit(0);
