// Probe 17: pi sessions and the approval extension. Runs real pi (its own login,
// default model) and records each scenario as a replay fixture:
//   <fixtures>/<scenario>/{meta,in.log,out.log}
// Usage: bun scripts/probes/pi/probe.ts <empty-work-dir> [fixtures-dir]
// Sessions go to <work-dir>/sessions, so ~/.pi is never written. Fixtures go through ../synth.ts; a
// session file copied from there into test/fixtures/transcripts/pi needs `bun scripts/probes/synth.ts`.
import { $, type Subprocess } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { synthPath } from "../synth";

type Rec = Record<string, any>;

const WORK = resolve(process.argv[2] ?? (console.error("usage: probe.ts <work-dir> [fixtures-dir]"), process.exit(2)));
const FIXTURES = resolve(process.argv[3] ?? join(import.meta.dir, "../../../test/fixtures/pi"));
const SESSIONS = join(WORK, "sessions");
const CWD = join(WORK, "project");
const EXT = join(import.meta.dir, "approval.ts");
const VERSION = (await $`pi --version`.text()).trim();

// pi must not report to the user's Herdr pane, see the parent Claude session,
// or pick up Anthropic credentials.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR_|CLAUDE|ANTHROPIC_)/.test(k)));

class Recording {
  records: Rec[] = [];
  mark = 0;
  outSize = 0;
  onRequest?: (req: Rec) => string | undefined;
  proc: Subprocess<"pipe", "pipe", any>;
  reader: Promise<void>;

  constructor(readonly dir: string, readonly scenario: string, args: string[]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "in.log"), "");
    writeFileSync(join(dir, "out.log"), "");
    this.proc = Bun.spawn(["pi", ...args], {
      cwd: CWD,
      env: ENV,
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(WORK, `${scenario}.stderr`)),
    });
    this.reader = this.read();
  }

  // Reads stdout continuously (pi stalls otherwise) and splits only on 0x0A.
  async read() {
    let pending = Buffer.alloc(0);
    for await (const chunk of this.proc.stdout) {
      appendFileSync(join(this.dir, "out.log"), chunk);
      this.outSize += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
        const rec = JSON.parse(pending.subarray(0, nl).toString("utf8"));
        pending = pending.subarray(nl + 1);
        this.records.push(rec);
        if (rec.type === "extension_ui_request" && rec.method === "select" && this.onRequest) {
          const value = this.onRequest(rec);
          if (value !== undefined) this.send({ type: "extension_ui_response", id: rec.id, value }, false);
        }
      }
    }
  }

  send(rec: Rec, moveMark = true) {
    const line = JSON.stringify(rec);
    appendFileSync(join(this.dir, "in.log"), `${this.outSize} ${line}\n`);
    this.proc.stdin.write(line + "\n");
    this.proc.stdin.flush();
    if (moveMark) this.mark = this.records.length;
  }

  // Finds the first record since the last send() that matches.
  async waitFor(pred: (r: Rec) => boolean, ms = 180_000): Promise<Rec> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.records.slice(this.mark).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`${this.scenario}: timed out waiting`);
      await Bun.sleep(50);
    }
  }

  async command(rec: Rec): Promise<Rec> {
    const id = `${rec.type}-${this.records.length}`;
    this.send({ id, ...rec });
    return this.waitFor((r) => r.type === "response" && r.id === id);
  }

  async turn(message: string) {
    const res = await this.command({ type: "prompt", message });
    await this.waitFor((r) => r.type === "agent_settled");
    return res;
  }

  async close() {
    this.proc.stdin.end();
    const code = await Promise.race([this.proc.exited, Bun.sleep(15_000).then(() => "timeout")]);
    if (code === "timeout") this.proc.kill();
    await this.reader;
    // Your home directory goes as the placeholder /home/user (test/pi-fixtures.test.ts), and each
    // in.log offset into out.log moves with it.
    const out = readFileSync(join(this.dir, "out.log"));
    const swap = (s: string) => s.replaceAll(homedir(), "/home/user");
    writeFileSync(join(this.dir, "out.log"), swap(out.toString()));
    const lines = readFileSync(join(this.dir, "in.log"), "utf8").split("\n").filter(Boolean);
    const moved = lines.map((l) => {
      const at = l.indexOf(" ");
      return `${Buffer.byteLength(swap(out.subarray(0, Number(l.slice(0, at))).toString()))} ${swap(l.slice(at + 1))}\n`;
    });
    writeFileSync(join(this.dir, "in.log"), moved.join(""));
    const meta = { agent: "pi", version: VERSION, scenario: this.scenario, edited: false };
    writeFileSync(join(this.dir, "meta"), JSON.stringify(meta) + "\n");
    synthPath(this.dir, "pi");
    return code;
  }
}

function start(scenario: string, sessionId: string, opts: { approval?: boolean | string; args?: string[]; dir?: string } = {}) {
  const args = [
    "--mode", "rpc",
    "--session-dir", SESSIONS,
    "--session-id", sessionId,
    // Keep the probe cheap and away from the user's own pi setup.
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
    ...(opts.approval ? ["-e", opts.approval === true ? EXT : opts.approval] : []),
    ...(opts.args ?? []),
  ];
  return new Recording(join(opts.dir ?? FIXTURES, scenario), scenario, args);
}

mkdirSync(CWD, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });
writeFileSync(join(CWD, "notes.txt"), "rhodium probe notes\n");

const report: Rec = { piVersion: VERSION };
const S1 = crypto.randomUUID();

{
  const r = start("turn", S1);
  await r.turn("Run `echo hello from bash` with the bash tool, then reply with the single word: done.");
  const state = (await r.command({ type: "get_state" })).data;
  const entries = (await r.command({ type: "get_entries" })).data;
  report.turn = { exit: await r.close(), sessionFile: state.sessionFile };
  // Check 2: once stdin is closed and pi has exited, the file holds every entry.
  const lines = readFileSync(state.sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  report.fileComplete = {
    header: lines[0],
    entriesInFile: lines.length - 1,
    entriesInMemory: entries.entries.length,
    lastIdMatchesLeaf: lines.at(-1).id === entries.leafId,
    lineTypes: [...new Set(lines.map((l) => (l.type === "message" ? `message/${l.message.role}` : l.type)))],
  };
}

{
  // Check 1: a new process with the same --session-id continues that session.
  const r = start("resume-session-id", S1);
  await r.command({ type: "get_state" });
  await r.command({ type: "get_entries" });
  await r.command({ type: "get_messages" });
  report.resume = { exit: await r.close() };
}

{
  const r = start("steer", crypto.randomUUID());
  await r.command({ type: "prompt", message: "Run `sleep 3 && echo one` with the bash tool and tell me its output." });
  await r.waitFor((x) => x.type === "tool_execution_start");
  await r.command({ type: "prompt", message: "Also end your reply with the word banana.", streamingBehavior: "steer" });
  await r.waitFor((x) => x.type === "agent_settled");
  report.steer = { exit: await r.close() };
}

{
  const r = start("abort", crypto.randomUUID());
  await r.command({ type: "prompt", message: "Run `sleep 30` with the bash tool." });
  await r.waitFor((x) => x.type === "tool_execution_start");
  const t = Date.now();
  await r.command({ type: "abort" });
  report.abort = { ms: Date.now() - t, settled: await r.waitFor((x) => x.type === "agent_settled") };
  report.abort.exit = await r.close();
}

{
  // Rhodium closes stdin only when idle; see what pi does when it is closed mid-run.
  const r = start("close-mid-turn", crypto.randomUUID());
  await r.command({ type: "prompt", message: "Run `sleep 4 && touch late.txt` with the bash tool, then reply with the single word: done." });
  await r.waitFor((x) => x.type === "tool_execution_start");
  const { sessionFile } = (await r.command({ type: "get_state" })).data;
  const t = Date.now();
  const exit = await r.close();
  const exitMs = Date.now() - t;
  await Bun.sleep(5000);
  report.closeMidTurn = {
    exit,
    exitMs,
    bashChildFinished: existsSync(join(CWD, "late.txt")),
    fileLines: existsSync(sessionFile)
      ? readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => {
          const e = JSON.parse(l);
          return e.type === "message" ? `message/${e.message.role}` : e.type;
        })
      : "no file",
  };
}

{
  const r = start("approval-allow", crypto.randomUUID(), { approval: true });
  r.onRequest = () => "allow";
  await r.turn("Read notes.txt with the read tool, then run `echo approved` with the bash tool, then reply with the single word: done.");
  report.approvalAllow = { exit: await r.close() };
}

{
  const r = start("approval-deny", crypto.randomUUID(), { approval: true });
  r.onRequest = () => "deny: Not now. Do not retry; just reply with the single word: skipped.";
  await r.turn("Run `touch denied.txt` with the bash tool.");
  report.approvalDeny = { exit: await r.close(), sideEffect: existsSync(join(CWD, "denied.txt")) };
}

{
  // Claude withdraws a pending approval on interrupt; see what pi does instead.
  const r = start("abort-pending-approval", crypto.randomUUID(), { approval: true });
  await r.command({ type: "prompt", message: "Run `echo pending` with the bash tool." });
  const req = await r.waitFor((x) => x.type === "extension_ui_request");
  const t = Date.now();
  await r.command({ type: "abort" });
  report.abortPending = { ms: Date.now() - t };
  r.send({ type: "extension_ui_response", id: req.id, value: "allow" });
  await Bun.sleep(1000);
  await r.command({ type: "get_state" });
  report.abortPending.exit = await r.close();
}

{
  // Without ctx.signal on the dialog, does abort wait for the answer? Not a fixture.
  const ext = join(WORK, "approval-nosignal.ts");
  writeFileSync(ext, readFileSync(EXT, "utf8").replace("{ signal: ctx.signal }", "{}"));
  const r = start("abort-nosignal", crypto.randomUUID(), { approval: ext, dir: WORK });
  await r.command({ type: "prompt", message: "Run `echo pending` with the bash tool." });
  await r.waitFor((x) => x.type === "extension_ui_request");
  r.send({ id: "abort-x", type: "abort" });
  const answered = await r.waitFor((x) => x.type === "response" && x.id === "abort-x", 10_000).then(() => true, () => false);
  report.abortWithoutSignal = { abortAnsweredWithin10s: answered, exit: await r.close() };
}

{
  const r = start("new-session", crypto.randomUUID());
  await r.command({ type: "get_state" });
  await r.command({ type: "new_session" });
  const after = (await r.command({ type: "get_state" })).data;
  report.newSession = { exit: await r.close(), sessionFile: after.sessionFile, fileExists: existsSync(after.sessionFile) };
}

{
  const r = start("switch-session", S1);
  await r.command({ type: "get_state" });
  await r.command({ type: "new_session" });
  await r.command({ type: "get_state" });
  await r.command({ type: "switch_session", sessionPath: report.turn.sessionFile });
  await r.command({ type: "get_state" });
  await r.command({ type: "get_messages" });
  report.switchSession = { exit: await r.close() };
}

{
  const r = start("get-session-stats", S1);
  await r.command({ type: "get_session_stats" });
  report.stats = { exit: await r.close() };
}

{
  const r = start("set-thinking-level", crypto.randomUUID());
  await r.command({ type: "set_thinking_level", level: "bogus" });
  await r.command({ type: "set_thinking_level", level: "low" });
  await r.command({ type: "get_state" });
  report.thinking = { exit: await r.close() };
}

{
  const r = start("set-model", crypto.randomUUID());
  await r.command({ type: "set_model", provider: "deepseek", modelId: "deepseek-v4-pro" });
  await r.command({ type: "set_model", provider: "deepseek", modelId: "no-such-model" });
  await r.command({ type: "get_state" });
  report.setModel = { exit: await r.close() };
}

{
  const r = start("get-available-models", crypto.randomUUID());
  const { models } = (await r.command({ type: "get_available_models" })).data;
  report.models = { exit: await r.close(), providers: [...new Set(models.map((m: Rec) => m.provider))] };
}

{
  // Last, because it adds a trusted project config: pi refuses to compact a session
  // under keepRecentTokens (default 20000), so lower it for this run only.
  mkdirSync(join(CWD, ".pi"), { recursive: true });
  writeFileSync(join(CWD, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
  const r = start("compact", S1, { args: ["--approve"] });
  report.compact = { response: await r.command({ type: "compact" }) };
  report.compact.exit = await r.close();
}

console.log(JSON.stringify(report, null, 2));
