// Codex app-server probes. Runs the user's real `codex app-server --listen stdio://` (their own
// login and quota, real ~/.codex; its config, hooks and auth are never edited) and records each scenario as a replay
// fixture: <fixtures>/<scenario>/{meta,in.log,out.log}.
// Usage: bun scripts/probes/codex/probe.ts <work-dir> <scenario>... [--fixtures dir]
// Scenarios share state (model, thread ids) through <work-dir>/state.json, so run them in order.
// Every model turn is counted in state.json ("turns"); keep the total small.
// Fixtures swap your home directory for /home/user, and account ids, emails, installation ids and
// JWTs for fixed placeholders (see swap below), then go through ../synth.ts. Run "cleanup" last: it
// deletes the probe's threads.
import { $, type Subprocess } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { synthPath } from "../synth";

type Rec = Record<string, any>;

const args = process.argv.slice(2);
const fx = args.indexOf("--fixtures");
const FIXTURES = resolve(fx >= 0 ? args.splice(fx, 2)[1]! : join(import.meta.dir, "../../../test/fixtures/codex"));
const WORK = resolve(args.shift() ?? (console.error("usage: probe.ts <work-dir> <scenario>..."), process.exit(2)));
const CWD = join(WORK, "project");
const VERSION = (await $`codex --version`.text()).trim().replace(/^codex-cli /, "");
const STATE_FILE = join(WORK, "state.json");
const state: Rec = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { turns: 0 };
// Cheapest model in model/list on 2026-10-27 ("Fast and affordable"), at its lowest effort.
state.model ??= "gpt-6-luna";
state.effort ??= "low";
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// No HERDR_* (the user's Codex SessionStart hook would report this process to a Herdr pane),
// no Claude session or Anthropic credentials. RHODIUM_* stand in for what Rhodium injects.
const ENV: Rec = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR_|CLAUDE|ANTHROPIC_|RHODIUM_)/.test(k))),
  RHODIUM_SLOT: "probe-slot",
  RHODIUM_TOKEN: "probe-token-not-secret",
};

// Private values found in responses; swapped for placeholders when a recording is closed.
const SECRET_KEYS = /^(email|accountId|account_id|userId|user_id|chatgptAccountId|chatgpt_account_id|chatgptUserId|organizationId|workspaceId|installationId|creator_user_id|creator_account_id)$/;
const secrets = new Map<string, string>();
function collectSecrets(v: unknown, key = "") {
  if (typeof v === "string") {
    if (SECRET_KEYS.test(key) && v.length > 3 && !secrets.has(v)) secrets.set(v, key === "email" ? "user@example.com" : `redacted-${key}`);
  } else if (Array.isArray(v)) v.forEach((x) => collectSecrets(x, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collectSecrets(x, k);
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const swap = (s: string) => {
  for (const [v, p] of secrets) s = s.replaceAll(v, p);
  return s.replaceAll(homedir(), "/home/user").replace(JWT, "redacted-jwt");
};

class Recording {
  records: Rec[] = [];
  mark = 0;
  outSize = 0;
  nextId = 0;
  onRequest?: (req: Rec) => Rec | undefined;
  proc: Subprocess<"pipe", "pipe", any>;
  reader: Promise<void>;
  dir: string;

  constructor(readonly scenario: string, extra: string[] = [], dir = join(FIXTURES, scenario), env = ENV) {
    this.dir = dir;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "in.log"), "");
    writeFileSync(join(this.dir, "out.log"), "");
    this.proc = Bun.spawn(["codex", "app-server", "--listen", "stdio://", ...extra], {
      cwd: CWD,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(WORK, `${scenario}.stderr`)),
    });
    this.reader = this.read();
  }

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
        collectSecrets(rec);
        if (rec.method && rec.id !== undefined && this.onRequest) {
          const result = this.onRequest(rec);
          if (result !== undefined) this.send({ id: rec.id, result }, false);
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

  async waitFor(pred: (r: Rec) => boolean, ms = 180_000, fromMark = true): Promise<Rec> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.records.slice(fromMark ? this.mark : 0).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`${this.scenario}: timed out waiting`);
      await Bun.sleep(50);
    }
  }

  // Sends a request and returns the whole response (result or error).
  async call(method: string, params: Rec = {}, ms?: number): Promise<Rec> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return this.waitFor((r) => r.id === id && !r.method, ms);
  }

  async init(experimental = true) {
    const res = await this.call("initialize", {
      clientInfo: { name: "rhodium_probe", title: "Rhodium probe", version: "0.0.0" },
      capabilities: { experimentalApi: experimental, requestAttestation: false },
    });
    this.send({ method: "initialized" });
    return res;
  }

  async startThread(params: Rec = {}) {
    return (await this.call("thread/start", { cwd: CWD, model: state.model, ...params })).result;
  }

  // Starts a turn; counts it against the probe's turn budget.
  async startTurn(threadId: string, text: string, params: Rec = {}) {
    state.turns++;
    save();
    return this.call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], effort: state.effort, ...params });
  }

  turnCompleted(ms = 300_000) {
    return this.waitFor((r) => r.method === "turn/completed", ms);
  }

  async close(ms = 15_000) {
    this.proc.stdin.end();
    const code = await Promise.race([this.proc.exited, Bun.sleep(ms).then(() => "timeout" as const)]);
    if (code === "timeout") this.proc.kill("SIGKILL");
    await this.reader;
    return this.finish(code);
  }

  async kill() {
    this.proc.kill("SIGKILL");
    const code = await this.proc.exited;
    await this.reader;
    return this.finish(code);
  }

  finish(code: number | string) {
    const out = readFileSync(join(this.dir, "out.log"));
    writeFileSync(join(this.dir, "out.log"), swap(out.toString()));
    const lines = readFileSync(join(this.dir, "in.log"), "utf8").split("\n").filter(Boolean);
    const moved = lines.map((l) => {
      const at = l.indexOf(" ");
      return `${Buffer.byteLength(swap(out.subarray(0, Number(l.slice(0, at))).toString()))} ${swap(l.slice(at + 1))}\n`;
    });
    writeFileSync(join(this.dir, "in.log"), moved.join(""));
    const meta = { agent: "codex", version: VERSION, scenario: this.scenario, edited: false };
    writeFileSync(join(this.dir, "meta"), JSON.stringify(meta) + "\n");
    synthPath(this.dir, "codex");
    return code;
  }

  methods() {
    return [...new Set(this.records.map((r) => r.method ?? (r.error ? "error-response" : "response")))];
  }
}

/** A CODEX_HOME of its own under the work dir, holding these files: your ~/.codex is not used. */
function homeOf(name: string, files: Record<string, string> = {}): Rec {
  const home = join(WORK, `home-${name}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(home, f), text);
  return { ...ENV, CODEX_HOME: home };
}

/** What rh doctor asks (architecture §12), in its order, no model turn: the login; with none needed, the
 *  config, for the provider; the models; and whether an ephemeral thread, never written down, takes untrusted. */
async function doctor(r: Recording, more?: () => Promise<unknown>) {
  await r.init(false);
  const account = (await r.call("account/read", { refreshToken: false })).result;
  const config = !account?.account && !account?.requiresOpenaiAuth ? await r.call("config/read", { cwd: CWD }) : undefined;
  const models = await r.call("model/list", {});
  const thread = await r.call("thread/start", { cwd: CWD, ephemeral: true, approvalPolicy: "untrusted", sandbox: "danger-full-access" });
  const t = thread.result;
  const after = await more?.();
  return {
    account,
    config: config && (config.error ?? { model_provider: config.result.config.model_provider, model_providers: config.result.config.model_providers }),
    models: models.error ?? models.result.data.map((m: Rec) => m.model),
    thread: thread.error ?? { id: t.thread.id, path: t.thread.path, ephemeral: t.thread.ephemeral, approvalPolicy: t.approvalPolicy },
    after,
    exit: await r.close(),
  };
}

const accept = (decision: string) => (req: Rec) => (/requestApproval$/.test(req.method) ? { decision } : undefined);
const report: Rec = {};

const scenarios: Record<string, () => Promise<void>> = {
  // No model turn: handshake, models, account, rate limits, thread list, config read.
  async handshake() {
    const r = new Recording("handshake");
    report.initialize = (await r.init()).result;
    const models = (await r.call("model/list", { includeHidden: false })).result;
    report.models = models.data.map((m: Rec) => ({
      model: m.model ?? m.id,
      isDefault: m.isDefault,
      efforts: (m.supportedReasoningEfforts ?? []).map((e: Rec) => e.reasoningEffort ?? e),
      defaultEffort: m.defaultReasoningEffort,
    }));
    report.account = (await r.call("account/read", { refreshToken: false })).result?.account?.type;
    report.rateLimits = (await r.call("account/rateLimits/read")).result ?? "error";
    // Filtered to the probe's own directory so the user's other threads stay out of the fixture.
    await r.call("thread/list", { limit: 3, cwd: CWD, sourceKinds: ["appServer", "cli", "vscode", "exec"] });
    report.exit = await r.close();
  },

  // Turn 1: streamed items, a command (also shows which RHODIUM_* reach it), a file change.
  async turn() {
    const r = new Recording("turn");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    state.thread = thread.id;
    state.rollout = thread.path;
    await r.startTurn(thread.id, "Run the shell command `env | grep ^RHODIUM_ | sort`. Then use apply_patch to create hello.txt containing the line hi. Then reply with the single word: ok.");
    const done = await r.turnCompleted();
    await r.call("thread/read", { threadId: thread.id, includeTurns: true });
    await r.call("thread/loaded/list");
    await r.call("thread/list", { limit: 5, cwd: CWD });
    await r.call("thread/list", { limit: 5, cwd: CWD, sourceKinds: ["appServer"] });
    await r.call("account/rateLimits/read");
    report.turn = { status: done.params.turn.status, methods: r.methods(), rollout: thread.path, exit: await r.close() };
  },

  // Turn 2: a new process resumes the thread from turn 1; does history continue? Also a per-turn model and effort.
  async "restart-idle"() {
    const r = new Recording("restart-idle");
    await r.init();
    const res = await r.call("thread/resume", { threadId: state.thread, cwd: CWD });
    await r.startTurn(state.thread, "Which file did you create earlier in this conversation? Reply with just the file name.", { model: "gpt-5.6-luna", effort: "low" });
    const done = await r.turnCompleted();
    const msg = r.records.filter((x) => x.method === "item/completed" && x.params.item.type === "agentMessage").at(-1);
    report.restartIdle = { resumedTurns: res.result?.thread?.turns?.length, status: done.params.turn.status, reply: msg?.params.item.text, exit: await r.close() };
  },

  // Turns 3 and 4: on-request approvals in a read-only sandbox, answered accept and decline.
  async "approval-accept"() {
    await approvals("approval-accept", "accept");
  },
  async "approval-decline"() {
    await approvals("approval-decline", "decline");
  },

  // Turn 5: interrupt while an approval is pending.
  async "interrupt-pending-approval"() {
    const r = new Recording("interrupt-pending-approval");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "on-request", sandbox: "read-only" });
    const turn = (await r.startTurn(thread.id, "Create an empty file pending.txt with `touch pending.txt`. You need write access, so request escalated permissions.")).result.turn;
    const req = await r.waitFor((x) => /requestApproval$/.test(x.method ?? ""));
    await r.call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const done = await r.turnCompleted();
    await Bun.sleep(500);
    r.send({ id: req.id, result: { decision: "accept" } }, false); // a late answer
    await Bun.sleep(1500);
    report.interruptPending = { status: done.params.turn.status, sideEffect: existsSync(join(CWD, "pending.txt")), methods: r.methods(), exit: await r.close() };
  },

  // Turn 6: interrupt a running command.
  async interrupt() {
    const r = new Recording("interrupt");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    const turn = (await r.startTurn(thread.id, "Run the shell command `sleep 30`, then reply with the single word: ok.")).result.turn;
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const t = Date.now();
    await r.call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const done = await r.turnCompleted();
    report.interrupt = { ms: Date.now() - t, status: done.params.turn.status, exit: await r.close() };
  },

  // Turn 7: add input to a running turn.
  async steer() {
    const r = new Recording("steer");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    const turn = (await r.startTurn(thread.id, "Run the shell command `sleep 4 && echo one` and tell me its output.")).result.turn;
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const steer = await r.call("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "Also end your reply with the word banana.", text_elements: [] }] });
    const done = await r.turnCompleted();
    const msg = r.records.filter((x) => x.method === "item/completed" && x.params.item.type === "agentMessage").at(-1);
    // Steering an idle thread: expected to fail.
    const idle = await r.call("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "x", text_elements: [] }] });
    report.steer = { steer, status: done.params.turn.status, reply: msg?.params.item.text, idleSteer: idle.error ?? idle.result, exit: await r.close() };
  },

  // Turn 8: SIGKILL the app-server while a command runs, then resume in a new process.
  async "kill-mid-turn"() {
    const r = new Recording("kill-mid-turn");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    state.killed = thread.id;
    state.killedRollout = thread.path;
    await r.startTurn(thread.id, "Run the shell command `sleep 6 && touch late.txt`, then reply with the single word: ok.");
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const exit = await r.kill();
    await Bun.sleep(8000);
    report.killMidTurn = { exit, commandChildFinished: existsSync(join(CWD, "late.txt")), rolloutTail: tail(thread.path, 4) };
    const r2 = new Recording("resume-after-kill");
    await r2.init();
    const res = await r2.call("thread/resume", { threadId: thread.id, cwd: CWD });
    await Bun.sleep(15_000); // does it continue the interrupted turn on its own?
    await r2.call("thread/read", { threadId: thread.id, includeTurns: true });
    report.resumeAfterKill = {
      turns: res.result?.thread?.turns?.map((t: Rec) => ({ status: t.status, items: t.items.map((i: Rec) => i.type) })),
      methods: r2.methods(),
      exit: await r2.close(),
    };
  },

  // Turn 9: close stdin mid-turn; does the process wait, and what happens to the command?
  async "close-mid-turn"() {
    const r = new Recording("close-mid-turn");
    await r.init();
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    await r.startTurn(thread.id, "Run the shell command `sleep 6 && touch closed.txt`, then reply with the single word: ok.");
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const t = Date.now();
    const exit = await r.close(60_000);
    const exitMs = Date.now() - t;
    await Bun.sleep(8000);
    report.closeMidTurn = { exit, exitMs, commandChildFinished: existsSync(join(CWD, "closed.txt")), methods: r.methods(), rolloutTail: tail(thread.path, 4) };
  },

  // Turn 10: manual compaction of the thread from turn 1.
  async compact() {
    const r = new Recording("compact");
    await r.init();
    await r.call("thread/resume", { threadId: state.thread, cwd: CWD });
    state.turns++;
    const res = await r.call("thread/compact/start", { threadId: state.thread });
    const done = await r.waitFor((x) => x.method === "turn/completed" || x.method === "thread/compacted", 300_000);
    await Bun.sleep(1500);
    report.compact = { res, done: done.method, methods: r.methods(), exit: await r.close() };
  },

  // Turn 11: a new turn on the thread whose process was killed mid-command (kill-mid-turn).
  async "turn-after-kill"() {
    const r = new Recording("turn-after-kill");
    await r.init();
    await r.call("thread/resume", { threadId: state.killed, cwd: CWD, excludeTurns: true });
    await r.startTurn(state.killed, "Without running anything: did your last command finish? Reply yes, no, or unknown.");
    const done = await r.turnCompleted();
    const msg = r.records.filter((x) => x.method === "item/completed" && x.params.item.type === "agentMessage").at(-1);
    report.turnAfterKill = { status: done.params.turn.status, reply: msg?.params.item.text, rolloutTail: tail(state.killedRollout, 8), exit: await r.close() };
  },

  // Turn 12: decline a patch (approval-decline stopped after the declined command).
  async "patch-decline"() {
    const r = new Recording("patch-decline");
    await r.init();
    r.onRequest = accept("decline");
    const { thread } = await r.startThread({ approvalPolicy: "on-request", sandbox: "read-only" });
    await r.startTurn(thread.id, "Use apply_patch to create by-patch.txt containing the line hi. If that is rejected, reply with the single word: skipped.");
    const done = await r.turnCompleted();
    report.patchDecline = { status: done.params.turn.status, file: existsSync(join(CWD, "by-patch.txt")), exit: await r.close() };
  },

  // ADR-0011's open item, private side: holds the main thread loaded while `codex resume` opens it
  // in the rhodium-test Herdr session (tui.sh drives it). Touch <work>/tui-done to stop.
  async "tui-coexist"() {
    const r = new Recording("tui-coexist");
    await r.init();
    await r.call("thread/resume", { threadId: state.thread, cwd: CWD, excludeTurns: true });
    writeFileSync(join(WORK, "tui-ready"), String(r.proc.pid));
    while (!existsSync(join(WORK, "tui-done"))) await Bun.sleep(200);
    report.tuiCoexist = { methods: r.methods(), exit: await r.close() };
  },

  // Live checks 1 of the spec (2026-10-27, #429), two turns: a turn/start while a turn runs, and
  // clientUserMessageId on turn/start and turn/steer. The command also lists the CODEX_ variables
  // Codex hands its commands, by name, for the environment filter (agents.ts).
  async "start-mid-turn"() {
    const r = new Recording("start-mid-turn");
    await r.init(false);
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
    const first = (await r.startTurn(thread.id, "Run the shell command `sleep 5; env | grep ^CODEX_ | cut -d= -f1 | sort`, then reply with the single word: ok.", { clientUserMessageId: "c-1" })).result.turn;
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const merged = await r.call("turn/start", { threadId: thread.id, input: text("Also end your reply with the word banana."), clientUserMessageId: "c-2" });
    const done1 = await r.turnCompleted();
    const second = (await r.startTurn(thread.id, "Run the shell command `sleep 4`, then reply with the single word: ok.", { clientUserMessageId: "c-3" })).result.turn;
    await r.waitFor((x) => x.method === "item/started" && x.params.item.type === "commandExecution");
    const steer = await r.call("turn/steer", { threadId: thread.id, expectedTurnId: second.id, input: text("Also end your reply with the word pear."), clientUserMessageId: "c-4" });
    const done2 = await r.turnCompleted();
    const users = r.records.filter((x) => x.method === "item/started" && x.params.item.type === "userMessage").map((x) => ({ turn: x.params.turnId, clientId: x.params.item.clientId }));
    const command = r.records.find((x) => x.method === "item/completed" && x.params.item.type === "commandExecution")?.params.item.aggregatedOutput;
    report.startMidTurn = {
      first: first.id,
      merged: merged.result ?? merged.error,
      turnStarted: r.records.filter((x) => x.method === "turn/started").map((x) => x.params.turn.id),
      done: [done1.params.turn.status, done2.params.turn.status],
      steer: steer.result ?? steer.error,
      users,
      codexVariables: command,
      exit: await r.close(),
    };
  },

  // Live checks 2 and 3 of the spec, four turns. developerInstructions on a thread started with
  // some, given others on resume; and three private app-servers at once (0.164 retries SQLite busy).
  async "developer-resume"() {
    const a = new Recording("developer-start", [], join(WORK, "developer-start"));
    await a.init(false);
    const { thread } = await a.startThread({ approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "End every reply with the word APPLE." });
    await a.startTurn(thread.id, "Say hi.");
    await a.turnCompleted();
    report.developerStart = { exit: await a.close() };
    const resume = new Recording("developer-resume");
    const others = [1, 2].map((n) => new Recording(`concurrent-${n}`, [], join(WORK, `concurrent-${n}`)));
    const all = [resume, ...others];
    await Promise.all(all.map((r) => r.init(false)));
    const resumed = await resume.call("thread/resume", { threadId: thread.id, cwd: CWD, excludeTurns: true, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "End every reply with the word PEAR." });
    const threads = await Promise.all(others.map((r) => r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access" })));
    await Promise.all([resume.startTurn(thread.id, "Say hi again."), ...others.map((r, i) => r.startTurn(threads[i].thread.id, "Reply with the single word: ok."))]);
    const done = await Promise.all(all.map((r) => r.turnCompleted()));
    const reply = resume.records.filter((x) => x.method === "item/completed" && x.params.item.type === "agentMessage").at(-1)?.params.item.text;
    const lines = readFileSync(thread.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const developer = lines.filter((l) => l.type === "response_item" && l.payload?.role === "developer").map((l) => JSON.stringify(l.payload.content).match(/APPLE|PEAR/g));
    const exits = await Promise.all(all.map((r) => r.close()));
    const stderr = all.map((r) => readFileSync(join(WORK, `${r.scenario}.stderr`), "utf8")).join("\n");
    report.developerResume = {
      resumed: resumed.error ?? "ok",
      reply,
      developer,
      statuses: done.map((d) => d.params.turn.status),
      errors: all.flatMap((r) => r.records.filter((x) => x.error || x.method === "error").map((x) => x.error ?? x.params)),
      busy: stderr.split("\n").filter((l) => /busy|locked/i.test(l)),
      exits,
    };
  },

  // Live check 7 of the spec (#431): at ultra, Codex hands work to sub-agents. Does the turn end, and
  // the thread go idle, while one still runs; does its end wake the thread for another turn? The
  // cheapest model that has ultra, the sub-agent on the cheapest at low. Turns counted: the main one,
  // the sub-agent's, and one it wakes. The timeline is in the report; the recording is a fixture.
  async "ultra-agents"() {
    const r = new Recording("ultra-agents");
    await r.init(false);
    const ultra = "gpt-5.6-terra";
    const { thread } = await r.startThread({ approvalPolicy: "never", sandbox: "danger-full-access", model: ultra });
    state.ultra = thread.id;
    const t0 = Date.now();
    const done = join(CWD, "agent-done.txt");
    rmSync(done, { force: true });
    await r.startTurn(
      thread.id,
      `Spawn one sub-agent (model ${state.model}, reasoning effort low) to run the shell command \`sleep 20 && touch agent-done.txt\`. Do not wait for it: right after spawning it, reply with the single word: ok.`,
      { model: ultra, effort: "ultra", clientUserMessageId: "c-1" },
    );
    state.turns += 2; // the sub-agent's turn, and one its end may wake
    save();
    await r.turnCompleted();
    let fileAt: number | null = null;
    for (const end = Date.now() + 90_000; Date.now() < end && (fileAt === null || Date.now() - t0 < fileAt + 20_000); await Bun.sleep(200))
      if (fileAt === null && existsSync(done)) fileAt = Date.now() - t0;
    const at = (x: Rec) => (x.emittedAtMs ? x.emittedAtMs - t0 : null);
    report.ultraAgents = {
      fileAt,
      timeline: r.records
        .filter((x) => /^(turn\/(started|completed)|thread\/status\/changed|thread\/started|item\/(started|completed))$/.test(x.method ?? ""))
        .map((x) => [at(x), x.method, x.params.threadId ?? x.params.thread?.id, x.params.status?.type ?? x.params.turn?.status ?? x.params.item?.type, x.params.item?.tool ?? x.params.item?.kind ?? "", JSON.stringify(x.params.item?.agentsStates ?? "")]),
      exit: await r.close(),
    };
    state.ultraChildren = [...new Set(r.records.flatMap((x) => x.params?.item?.agentThreadId ?? []))];
    rmSync(done, { force: true });
  },

  // No model turn: rh doctor's checks with your login.
  async doctor() {
    report.doctor = await doctor(new Recording("doctor"));
  },
  // The same with no login, with an API key, and with a provider of your own whose env_key is not set,
  // each in a CODEX_HOME of its own. The key is no real one; the provider's base_url resolves nowhere.
  async "doctor-logged-out"() {
    report.loggedOut = await doctor(new Recording("doctor-logged-out", [], undefined, homeOf("logged-out")));
  },
  async "doctor-api-key"() {
    const env = homeOf("api-key");
    await $`printf sk-fake-not-a-key | codex login --with-api-key`.env(env).quiet();
    report.apiKey = await doctor(new Recording("doctor-api-key", [], undefined, env));
  },
  async "doctor-provider"() {
    const config = 'model_provider = "acme"\nmodel = "acme-coder"\n\n[model_providers.acme]\nname = "Acme"\nbase_url = "https://llm.acme.invalid/v1"\nenv_key = "ACME_API_KEY"\n';
    const r = new Recording("doctor-provider", [], undefined, homeOf("provider", { "config.toml": config }));
    // After what rh doctor asks: whether a provider of yours has rate limits.
    report.provider = await doctor(r, () => r.call("account/rateLimits/read"));
  },

  // Live checks 4 and 5 of the spec (#430), two turns, with approval on as Rhodium sets it: untrusted
  // and no sandbox. Turn 1: does a read-only command, a command that writes, and a patch each ask?
  // Turn 2: the rm is declined and words steered in right after: does Codex carry on with them?
  async untrusted() {
    const r = new Recording("untrusted");
    await r.init(false);
    const asked: string[][] = [[], []];
    let turn = 0;
    let steer: Rec | undefined;
    r.onRequest = (req) => {
      asked[turn]!.push(req.params.command ?? req.method);
      if (steer || !/\brm\b/.test(req.params.command ?? "")) return { decision: "accept" };
      r.send({ id: req.id, result: { decision: "decline" } }, false);
      steer = { id: r.nextId++, method: "turn/steer", params: { threadId: req.params.threadId, expectedTurnId: req.params.turnId, input: [{ type: "text", text: "Don't delete a.txt. Rename it to a.txt.bak instead, then reply with the single word: renamed.", text_elements: [] }] } };
      r.send(steer, false);
    };
    const opened = await r.startThread({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
    await r.startTurn(opened.thread.id, "Run the shell command `ls`. Then run `touch a.txt`. Then use apply_patch to create b.txt containing the line hi. Then reply with the single word: done.");
    const done1 = await r.turnCompleted();
    turn = 1;
    await r.startTurn(opened.thread.id, "Run the shell command `rm a.txt`, then reply with the single word: done.");
    const done2 = await r.turnCompleted();
    const replies = r.records.filter((x) => x.method === "item/completed" && x.params.item.type === "agentMessage").map((x) => x.params.item.text);
    report.untrusted = {
      opened: { approvalPolicy: opened.approvalPolicy, sandbox: opened.sandbox },
      asked,
      steer: steer && r.records.find((x) => x.id === steer!.id && !x.method),
      statuses: [done1.params.turn.status, done2.params.turn.status],
      replies,
      files: ["a.txt", "a.txt.bak", "b.txt"].filter((f) => existsSync(join(CWD, f))),
      exit: await r.close(),
    };
    for (const f of ["a.txt", "a.txt.bak", "b.txt"]) rmSync(join(CWD, f), { force: true });
  },

  // Live check 6 of the spec (#430), one turn: an MCP server's tools (mcp-server.ts), approval on.
  // Each call's approval comes as an elicitation, told apart by _meta.codex_approval_kind; the
  // form the `ask` tool puts is declined, as Rhodium declines it.
  async "mcp-elicitation"() {
    const server = join(import.meta.dir, "mcp-server.ts");
    const mcp = ["-c", `mcp_servers.rhprobe.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.rhprobe.args=${JSON.stringify([server])}`];
    const r = new Recording("mcp-elicitation", mcp);
    await r.init(false);
    const requests: Rec[] = [];
    r.onRequest = (req) => {
      const p = req.params;
      requests.push({ method: req.method, mode: p.mode, kind: p._meta?.codex_approval_kind, message: p.message, command: p.command });
      if (req.method !== "mcpServer/elicitation/request") return /requestApproval$/.test(req.method) ? { decision: "accept" } : undefined;
      return { action: p.mode === "form" && p._meta?.codex_approval_kind === "mcp_tool_call" ? "accept" : "decline", content: null, _meta: null };
    };
    const { thread } = await r.startThread({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
    await r.waitFor((x) => x.method === "mcpServer/startupStatus/updated" && x.params?.status !== "starting", 30_000, false).catch(() => {});
    await r.startTurn(thread.id, "Call the rhprobe MCP tool `note` with the text hi. Then call the rhprobe MCP tool `ask`. Then reply with the single word: done.");
    const done = await r.turnCompleted();
    const calls = r.records.filter((x) => x.method === "item/completed" && x.params.item.type === "mcpToolCall").map((x) => ({ tool: x.params.item.tool, status: x.params.item.status, result: x.params.item.result }));
    report.mcpElicitation = { requests, calls, status: done.params.turn.status, methods: r.methods(), exit: await r.close() };
  },

  // No turn: resume the main thread while `codex resume` holds its writer lock, and after it exits.
  "resume-locked": () => resumeOnly("resume-locked"),
  "resume-after-tui": () => resumeOnly("resume-after-tui"),

  // No turn: copy the rollouts of the main thread (turns 1, 2, compaction, TUI) and the killed one.
  async transcripts() {
    copyRollout(state.rollout, "thread.jsonl");
    copyRollout(state.killedRollout, "killed-mid-turn.jsonl");
  },

  // No turn, not a fixture: delete every thread the probes made (all sit in the probe's cwd).
  async cleanup() {
    const r = new Recording("cleanup", [], join(WORK, "cleanup"));
    await r.init();
    const list = await r.call("thread/list", { limit: 100, cwd: CWD, sourceKinds: [] });
    const ids: string[] = list.result.data.map((t: Rec) => t.id);
    for (const id of new Set([...ids, state.thread, state.killed, state.ultra, ...(state.ultraChildren ?? [])].filter(Boolean))) await r.call("thread/delete", { threadId: id });
    report.cleanup = { deleted: ids.length, left: (await r.call("thread/list", { limit: 100, cwd: CWD, sourceKinds: [] })).result.data.length, exit: await r.close() };
  },
};

async function resumeOnly(scenario: string) {
  const r = new Recording(scenario);
  await r.init();
  const res = await r.call("thread/resume", { threadId: state.thread, cwd: CWD, excludeTurns: true });
  await Bun.sleep(2000);
  const t = res.result?.thread;
  report[scenario] = { res: res.error ?? { status: t.status, canAcceptDirectInput: t.canAcceptDirectInput }, methods: r.methods(), exit: await r.close() };
}

// Copies a rollout file into test/fixtures/transcripts/codex with the same placeholders.
function copyRollout(path: string, name: string) {
  const text = readFileSync(path, "utf8");
  for (const l of text.split("\n").filter(Boolean)) collectSecrets(JSON.parse(l));
  const dir = join(FIXTURES, "../transcripts/codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), swap(text));
  synthPath(join(dir, name), "codex");
}

function tail(path: string, n: number) {
  if (!path || !existsSync(path)) return "no file";
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n).map((l) => {
    const o = JSON.parse(l);
    return `${o.type}/${o.payload?.type ?? ""}`;
  });
}

async function approvals(scenario: string, decision: string) {
  const r = new Recording(scenario);
  await r.init();
  r.onRequest = accept(decision);
  const { thread } = await r.startThread({ approvalPolicy: "on-request", sandbox: "read-only" });
  await r.startTurn(thread.id, "Run `touch by-shell.txt` (you need write access, so request escalated permissions). Then use apply_patch to create by-patch.txt containing the line hi. Then reply with the single word: done.");
  const done = await r.turnCompleted();
  report[scenario] = {
    status: done.params.turn.status,
    requests: r.records.filter((x) => x.method && x.id !== undefined).map((x) => x.method),
    files: ["by-shell.txt", "by-patch.txt"].filter((f) => existsSync(join(CWD, f))),
    exit: await r.close(),
  };
  for (const f of ["by-shell.txt", "by-patch.txt"]) rmSync(join(CWD, f), { force: true });
}

mkdirSync(CWD, { recursive: true });
for (const name of args) {
  const run = scenarios[name] ?? (console.error(`unknown scenario ${name}`), process.exit(2));
  await run();
  save();
}
console.log(JSON.stringify({ ...report, turnsSoFar: state.turns }, null, 2));
