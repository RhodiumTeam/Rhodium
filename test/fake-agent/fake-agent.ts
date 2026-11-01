// Fake agent and replayer: stands in for `claude`, `pi` and `codex` in tests.
// It only handles lines; it knows nothing about Claude's, pi's or Codex's types.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { call } from "../../src/herdr.ts";
import { builtins } from "./scripts.ts";

/** One step of a script. Lines in `emit` and `transcript` are templates, see `fill`. */
export type Step =
  /** `splitAt`: write the bytes before that offset, pause, then the rest. */
  | { emit: string[]; splitAt?: number }
  /** Writes this text to stderr as it is: no newline is added. */
  | { stderr: string }
  /** Appends lines to the agent's transcript file for this session: Claude's, or pi's session
   *  file when run as pi, or as `pi --mode rpc` under another name, or Codex's of `state.thread`. */
  | { transcript: string[] }
  /** `set`, as an `on` handler's, with the line it took. */
  | { wait: unknown; set?: Record<string, unknown> }
  | { sleep: number }
  /** With `env`, only when that environment variable is set and not empty; with `kept`, only when
   *  a line matching that pattern came and is kept for a later `wait`. */
  | { goto: number; env?: string; kept?: unknown }
  | { exit: number }
  | { kill: NodeJS.Signals }
  /** Ignores this signal from then on. */
  | { ignore: NodeJS.Signals }
  /** Runs `rh <args>` as a child, as an agent's shell would, and waits for it; `env` overrides
   *  variables of the agent's environment for that call ("" makes rh treat one as unset). */
  | { rh: string[]; env?: Record<string, string> }
  /** Deletes this file, relative to the agent's directory, as an agent cleaning up would. */
  | { rm: string }
  /** Runs each rh call listed at this path of the vars `fill` knows (say "in.message.content.0.text"):
   *  its last line is JSON text of an array of argument arrays, so a message from IM, whose first
   *  line says where it came from, works too. Anything else runs nothing. A call may also be
   *  {args, env}, env as for the `rh` step. */
  | { rhFrom: string };

/**
 * Steps run in order. `wait` takes the next stdin line matching its pattern.
 * A line that no active `wait` takes goes to the first `on` handler it matches,
 * whatever step is running; otherwise it is kept for a later `wait`.
 * A handler's `set` stores values, templates filled with that line, in `state`, which starts as the
 * script's `state`; templates read them back as `{{state.<name>}}`.
 */
export type Script = { on?: { match: unknown; emit: string[]; set?: Record<string, unknown> }[]; steps: Step[]; state?: Record<string, unknown> };

export type Config = {
  /** A script to play, or the name of one in `builtins`. Defaults to "turn". */
  script?: string | Script;
  /** Where each run appends its argv, env and stdin lines. */
  log?: string;
  /** false turns every `transcript` step into a no-op. */
  transcript?: boolean;
  /** A recording directory (meta, in.log, out.log) to replay instead of a script. */
  replay?: string;
  /** Rhodium starts each message of yours from IM with a line saying where it came from (architecture
   *  §6.1); a recording made without Rhodium has none. These lines go, in order, at the start of the
   *  recording's user frames from you (Claude's) or its prompts (pi's), before they are checked. */
  sourceLines?: string[];
  /** Milliseconds to wait before reading stdin at all, so a long first line sticks in the pipe. */
  readAfter?: number;
  /** false: pi in a Herdr pane reports no session, as when Herdr ignores the pane's report. */
  herdrReport?: boolean;
  /** What codex --version says, after codex-cli; 0.162.1 by default. */
  version?: string;
};

export type RhCall = { args: string[]; code: number; out: string; err: string };
export type Run = { pid: number; argv: string[]; env: Record<string, string>; cwd: string; stdin: string[]; rh: RhCall[] };

const SECRET = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;
const MAIN = join(import.meta.dir, "../../src/main.ts");

/** Writes an executable at `<dir>/<name>` that runs the fake agent with `config`. */
export function installFakeAgent(dir: string, config: Config, name = "claude") {
  const path = join(dir, name);
  const log = config.log ?? `${path}.log`;
  // The config in base64: the script's output would put protocol names in the bytes rh doctor searches.
  const encoded = Buffer.from(JSON.stringify({ ...config, log })).toString("base64");
  const entry = `import { run } from ${JSON.stringify(import.meta.path)};\nawait run(JSON.parse(Buffer.from(${JSON.stringify(encoded)}, "base64").toString()), ${JSON.stringify(name)});\n`;
  // Absolute interpreter path: systemd user services have no bun on PATH.
  if (name !== "pi") writeFileSync(path, `#!${process.execPath} --no-env-file\n${entry}`, { mode: 0o755 });
  else {
    // pi sets its process title, and node then shows its command line in /proc as "pi" alone: no
    // program path, no session id. So does this one; its arguments travel in the environment.
    writeFileSync(`${path}.ts`, entry);
    const exec = `exec -a pi ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(`${path}.ts`)}`;
    writeFileSync(path, `#!/bin/bash\nIFS=$'\\x1f'; export FAKE_AGENT_ARGV="$*"\n${exec}\n`, { mode: 0o755 });
  }
  return { path, runs: () => readRuns(log) };
}

function readRuns(log: string): Run[] {
  const runs: Run[] = [];
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {}
  for (const l of text.split("\n").slice(0, -1)) {
    const entry = JSON.parse(l);
    // Concurrent runs share the log, so stdin lines and rh calls go to the latest run with their pid.
    if ("stdin" in entry) runs.findLast((r) => r.pid === entry.pid)!.stdin.push(entry.stdin);
    else if ("rh" in entry) runs.findLast((r) => r.pid === entry.pid)!.rh.push(entry.rh);
    else runs.push({ ...entry, stdin: [], rh: [] });
  }
  return runs;
}

export async function run(config: Config, name = "claude") {
  // The fake pi's arguments, which its command line does not show (installFakeAgent).
  const given = process.env.FAKE_AGENT_ARGV;
  if (given !== undefined) {
    process.argv.splice(2, Infinity, ...(given ? given.split("\x1f") : []));
    delete process.env.FAKE_AGENT_ARGV;
  }
  // Not a run of the agent: none is logged.
  if (name === "codex" && process.argv[2] === "--version") {
    console.log(`codex-cli ${config.version ?? "0.162.1"}`);
    process.exit(0);
  }
  const log = (entry: object) => config.log && appendFileSync(config.log, JSON.stringify(entry) + "\n");
  const env = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, SECRET.test(k) ? "<redacted>" : v]),
  );
  log({ pid: process.pid, argv: process.argv.slice(2), env, cwd: process.cwd() });
  const lines = (async function* () {
    if (config.readAfter) await Bun.sleep(config.readAfter);
    for await (const line of stdinLines()) {
      log({ pid: process.pid, stdin: line });
      yield line;
    }
  })();
  await (config.replay ? replay(config.replay, lines, config.sourceLines) : play(config, lines, log, name));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plays a recording: sends out.log up to where each in.log line was written,
 * then checks the next stdin line against it. Exits 1 with a diff on stderr
 * at the first difference. A uuid, a `request_id` (Claude's) or an `id` (pi's)
 * the writer makes up is random per run, so only its place and kind (a uuid;
 * any string) are checked, and later output and input use the value the writer
 * actually chose. One the agent sent (say, the `request_id` of `can_use_tool`,
 * or the `id` of pi's `extension_ui_request`) must come back exactly.
 */
async function replay(fixture: string, lines: AsyncGenerator<string>, sourceLines: string[] = []) {
  const out = readFileSync(join(fixture, "out.log"));
  // Codex's recordings come from a probe, not from Rhodium: see codexMatch.
  const codex = JSON.parse(readFileSync(join(fixture, "meta"), "utf8")).agent === "codex";
  const ids = new Map<number, unknown>(); // a recorded request's id, by the id the client used
  const sources = [...sourceLines];
  const inputs = readFileSync(join(fixture, "in.log"), "utf8")
    .split("\n")
    .slice(0, -1)
    .map((l) => {
      let line = l.slice(l.indexOf(" ") + 1);
      const m = parse(line) as any;
      if (sources.length && m?.type === "user" && m.origin?.kind === "human") {
        m.message.content[0].text = `${sources.shift()}\n${m.message.content[0].text}`;
        line = JSON.stringify(m);
      } else if (sources.length && m?.type === "prompt") {
        m.message = `${sources.shift()}\n${m.message}`;
        line = JSON.stringify(m);
      }
      return { at: Number(l.slice(0, l.indexOf(" "))), line };
    });
  const fail = (msg: string) => {
    console.error(`replay mismatch: ${msg}`);
    process.exit(1);
  };
  const renamed = new Map<string, string>();
  let sent = 0;
  const sendUpTo = (at: number) => {
    // Whole lines only for Codex, whose responses get the client's ids below.
    if (codex) at = Math.max(sent, at && out.lastIndexOf(10, at - 1) + 1); // (a negative offset counts from the end)
    // ponytail: a random value split across two sends is not renamed; offsets fall between lines in practice.
    let text = out.subarray(sent, at).toString("latin1");
    for (const [from, to] of renamed)
      text = text.replaceAll(latin1(JSON.stringify(from)), latin1(JSON.stringify(to)));
    // A response is {"id":N,"result":…} or {"error":…,"id":N}, a request of Codex's {"method":…,"id":N,…}.
    if (codex)
      text = text
        .replace(/^\{"id":(\d+),"(result|error)"/gm, (m, n, k) => (ids.has(+n) ? `{"id":${latin1(JSON.stringify(ids.get(+n)))},"${k}"` : m))
        .replace(/^(\{"error":.*,"id":)(\d+)\}$/gm, (m, head, n) => (ids.has(+n) ? `${head}${latin1(JSON.stringify(ids.get(+n)))}}` : m));
    write(Buffer.from(text, "latin1"));
    sent = Math.max(sent, at);
  };

  const wasSent = (v: string) => out.subarray(0, sent).includes(JSON.stringify(v));

  for (const [i, want] of inputs.entries()) {
    sendUpTo(want.at);
    const got = await lines.next();
    // The probe asked more than a client needs to, or answered what Codex no longer waited on, its
    // request resolved already (interrupt-pending-approval); one that stops before those lines is done.
    const resolved = (id: unknown) => out.subarray(0, sent).includes(`"requestId":${JSON.stringify(id)}}`);
    if (got.done && codex && inputs.slice(i).every((w) => (parse(w.line) as any)?.method || resolved((parse(w.line) as any)?.id))) process.exit(0);
    if (got.done) fail(`in.log line ${i + 1}: expected\n  ${want.line}\ngot end of input`);
    const d = codex ? codexMatch(parse(want.line) as any, parse(got.value!) as any, ids, renamed) : diff(parse(want.line), parse(got.value!), "$", renamed, wasSent);
    if (d) fail(`in.log line ${i + 1}: ${d}\nexpected\n  ${want.line}\ngot\n  ${got.value}`);
  }
  sendUpTo(out.length);
  const extra = await lines.next();
  if (!extra.done) fail(`unexpected line after the recording ends:\n  ${extra.value}`);
  process.exit(0);
}

const latin1 = (s: string) => Buffer.from(s).toString("latin1");

/**
 * Where a line a Codex client wrote differs from the probe's, or undefined. The probe's requests
 * carry other parameters than Rhodium's, so only these count: the method; the thread and turn a
 * request names; and, for an answer to a request of Codex's, its id. The id a request of the
 * client's has is its own: Codex's response gets it (ids). Its clientUserMessageId too: Codex
 * writes it back (renamed).
 */
function codexMatch(want: any, got: any, ids: Map<number, unknown>, renamed: Map<string, string>): string | undefined {
  if (want?.method !== got?.method) return `method: expected ${want?.method ?? "an answer"}, got ${got?.method ?? "an answer"}`;
  if (want.method === undefined) return want.id === got.id ? undefined : `id: expected ${want.id}, got ${JSON.stringify(got.id)}`;
  for (const k of ["threadId", "turnId", "expectedTurnId"])
    if (want.params?.[k] !== undefined && got.params?.[k] !== want.params[k]) return `params.${k}: expected ${want.params[k]}, got ${got.params?.[k]}`;
  if (want.id !== undefined) {
    if (got.id === undefined) return "id: missing";
    ids.set(want.id, got.id);
  }
  const client = want.params?.clientUserMessageId;
  if (typeof client === "string" && typeof got.params?.clientUserMessageId === "string") renamed.set(client, got.params.clientUserMessageId);
}

/**
 * Where `got` first differs from `want`, or undefined. A random value seen for
 * the first time is renamed; once renamed, or once the agent has sent it, it is
 * fixed and must come back exactly.
 */
function diff(
  want: unknown,
  got: unknown,
  path: string,
  renamed: Map<string, string>,
  wasSent: (v: string) => boolean,
  key?: string,
): string | undefined {
  const show = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));
  const anyString = key === "request_id" || key === "id";
  if (typeof want === "string" && (anyString || UUID.test(want))) {
    const fixed = renamed.get(want) ?? (wasSent(want) ? want : undefined);
    if (fixed !== undefined) return got === fixed ? undefined : `${path}: expected ${show(fixed)}, got ${show(got)}`;
    const random = anyString ? "a string" : "a uuid";
    if (typeof got !== "string" || (!anyString && !UUID.test(got)))
      return `${path}: expected ${random}, got ${show(got)}`;
    renamed.set(want, got);
    return;
  }
  const objects = [want, got].every((v) => v !== null && typeof v === "object");
  if (!objects || Array.isArray(want) !== Array.isArray(got))
    return Bun.deepEquals(want, got) ? undefined : `${path}: expected ${show(want)}, got ${show(got)}`;
  const [w, g] = [want as any, got as any];
  const at = (k: string) => (Array.isArray(w) ? `${path}[${k}]` : `${path}.${k}`);
  for (const k of Object.keys(w)) {
    if (!(k in g)) return `${at(k)}: missing`;
    const d = diff(w[k], g[k], at(k), renamed, wasSent, k);
    if (d) return d;
  }
  for (const k of Object.keys(g)) if (!(k in w)) return `${at(k)}: unexpected`;
}

/**
 * Replaces each whole JSON string `"{{path}}"` with the JSON value at that path:
 * - `in.<field>`: the line the last `wait` (or the handler) took.
 * - `seq`: this line's number on stdout.
 * - `session_id`: from `--session-id` or `--resume`, else random.
 * - `cwd`; `uuid` (fresh each time); `now` (ISO time).
 * Missing values become null.
 */
function fill(template: string, vars: Record<string, unknown>): string {
  return template.replace(/"\{\{([\w.]+)\}\}"/g, (_, path: string) => JSON.stringify(lookup(vars, path) ?? null));
}

function lookup(vars: Record<string, unknown>, path: string): any {
  let v: any = vars;
  for (const k of path.split(".")) v = v?.[k];
  return v;
}

/** True when every key in `pattern` matches `value`; an empty pattern matches any line. */
function matches(pattern: unknown, value: unknown): boolean {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern))
    return Object.entries(pattern).every(
      ([k, p]) => value !== null && typeof value === "object" && matches(p, (value as any)[k]),
    );
  return Bun.deepEquals(pattern, value);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function write(bytes: Buffer) {
  for (let o = 0; o < bytes.length; ) o += writeSync(1, bytes, o);
}

function flag(args: string[], name: string): string | undefined {
  for (const [i, a] of args.entries()) {
    if (a === name) return args[i + 1];
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
}

/** Claude's directory name for a working directory under `~/.claude/projects/`.
 *  A deliberate copy of src/transcript.ts's: the fake writes where Claude would, on its own
 *  reckoning, so a mistake in rhodium's copy shows up as a missing transcript instead of
 *  being shared by both sides. */
export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** The user's real home from /etc/passwd: Bun's userInfo() follows $HOME. */
export function realHome(): string | undefined {
  const uid = String(process.getuid!());
  const passwd = readFileSync("/etc/passwd", "utf8").split("\n").map((l) => l.split(":"));
  return passwd.find((f) => f[2] === uid)?.[5];
}

/** A test that forgot to point HOME at a temp dir must not touch the user's own transcripts. */
function refuseRealHome(dir: string, own: string) {
  const home = realHome();
  const [at, mine] = [resolve(dir), home && join(home, own)];
  if (mine && (at === mine || at.startsWith(`${mine}/`))) {
    console.error(`fake-agent: refusing to write a transcript under ${dir}; set HOME or ${own === ".claude" ? "CLAUDE_CONFIG_DIR" : own === ".codex" ? "CODEX_HOME" : "--session-dir"}`);
    process.exit(2);
  }
}

function transcriptFile(sessionId: string): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  refuseRealHome(dir, ".claude");
  return join(dir, "projects", claudeProjectDir(process.cwd()), `${sessionId}.jsonl`);
}

/** Whether Claude has a transcript of the session, in any directory's folder. */
function claudeHas(sessionId: string): boolean {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  return existsSync(projects) && readdirSync(projects).some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

/** pi's session file (architecture §6.3): in --session-dir, else in pi's directory for the cwd.
 *  The one the session already has, or a new one named by its start time, which opens with pi's
 *  session header. The directory name is a deliberate copy of src/transcript.ts's, as for Claude. */
function piSessionFile(args: string[], sessionId: string): string {
  const cwd = process.cwd();
  const dir = flag(args, "--session-dir") ?? join(homedir(), ".pi/agent/sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  refuseRealHome(dir, ".pi");
  const had = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`)) : undefined;
  if (had) return join(dir, had);
  const now = new Date().toISOString();
  const file = join(dir, `${now.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd }) + "\n");
  return file;
}

/** Codex's record of the thread (architecture §6.4): the one it has, under $CODEX_HOME/sessions by
 *  the day it began, or a new one of today's, which opens with its session_meta line. */
function codexRollout(thread: string): string {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  refuseRealHome(root, ".codex");
  for (const f of existsSync(root) ? readdirSync(root, { recursive: true, encoding: "utf8" }) : []) if (f.endsWith(`-${thread}.jsonl`)) return join(root, f);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = [String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())];
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
  const file = join(root, ...day, `rollout-${day.join("-")}T${time}-${thread}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const meta = { id: thread, cwd: process.cwd(), source: "vscode", originator: "rhodium", cli_version: "0.162.1" };
  writeFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type: "session_meta", payload: meta }) + "\n");
  return file;
}

async function play(config: Config, lines: AsyncGenerator<string>, log: (entry: object) => void, name: string) {
  const script = typeof config.script === "object" ? config.script : builtins[config.script ?? "turn"];
  if (!script) {
    console.error(`fake-agent: no built-in script named ${config.script}`);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  // pi --session <file>, as Herdr resumes pi: the id ends the file's name (architecture §6.3).
  const file = flag(args, "--session");
  const sessionId = flag(args, "--session-id") ?? flag(args, "--resume") ?? (file ? basename(file, ".jsonl").split("_").at(-1)! : randomUUID());
  // As Claude does: it writes a conversation down at its first message, and cannot resume one it never did.
  const resume = flag(args, "--resume");
  if (name === "claude" && resume && config.transcript !== false && !claudeHas(resume)) {
    console.error(`No conversation found with session ID: ${resume}`);
    process.exit(1);
  }
  // pi's own terminal in a Herdr pane: your pi's Herdr extension reports the session to the pane, by
  // its file (~/.pi/agent/extensions/herdr-agent-state.ts). In rpc mode it reports nothing.
  if (name === "pi" && config.herdrReport !== false && flag(args, "--mode") !== "rpc" && process.env.HERDR_ENV === "1") {
    const params = { pane_id: process.env.HERDR_PANE_ID, source: "herdr:pi", agent: "pi", agent_session_path: piSessionFile(args, sessionId) };
    await call(process.env.HERDR_SOCKET_PATH!, "pane.report_agent_session", params).catch(() => {});
  }
  const queue: unknown[] = [];
  let waiter: { pattern: unknown; resolve: (msg: unknown) => void } | undefined;
  let eof = false;
  let emitted = 0;
  const state = { ...script.state };
  // Codex's own terminal, `codex resume <thread>`: on that thread, or a new one with no resume, which
  // your Codex hook reports to the Herdr pane at its first turn there (architecture §6.4). Typed into
  // it: turn/start lines.
  const pane = name === "codex" && args[0] !== "app-server" && process.env.HERDR_ENV === "1";
  if (name === "codex" && args[0] === "resume") state.thread = args[1];
  else if (pane) state.thread = randomUUID();
  let told: unknown; // the thread last reported to the pane
  const vars = (input: unknown, seq?: number) => ({
    in: input,
    seq,
    state,
    session_id: sessionId,
    cwd: process.cwd(),
    get uuid() {
      return randomUUID();
    },
    get now() {
      return new Date().toISOString();
    },
  });
  // Emits queue behind each other, so a handler's reply never lands inside a split line.
  let writing = Promise.resolve();
  const emit = (templates: string[], input: unknown, splitAt = 0) =>
    (writing = writing.then(async () => {
      const bytes = Buffer.from(templates.map((l) => fill(l, vars(input, ++emitted)) + "\n").join(""));
      if (splitAt) {
        write(bytes.subarray(0, splitAt));
        await Bun.sleep(50);
      }
      write(bytes.subarray(splitAt));
    }));
  const transcript = (templates: string[], input: unknown) => {
    if (config.transcript === false) return;
    const file =
      name === "codex" ? codexRollout(String(state.thread)) : name === "pi" || flag(args, "--mode") === "rpc" ? piSessionFile(args, sessionId) : transcriptFile(sessionId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, templates.map((l) => fill(l, vars(input)) + "\n").join(""));
    if (pane && told !== state.thread) {
      told = state.thread;
      const params = { pane_id: process.env.HERDR_PANE_ID, source: "herdr:codex", agent: "codex", agent_session_id: state.thread };
      void call(process.env.HERDR_SOCKET_PATH!, "pane.report_agent_session", params).catch(() => {});
    }
  };
  // Like `claude -p`: stdin closing while there is nothing left to do ends the run.
  const closed = (async () => {
    for await (const line of lines) {
      const msg = parse(line);
      const handler = script.on?.find((h) => matches(h.match, msg));
      if (waiter && matches(waiter.pattern, msg)) {
        waiter.resolve(msg);
        waiter = undefined;
      } else if (handler) {
        if (handler.set) Object.assign(state, JSON.parse(fill(JSON.stringify(handler.set), vars(msg))));
        emit(handler.emit, msg);
      }
      else queue.push(msg);
    }
    eof = true;
    if (waiter) process.exit(0);
  })();
  const next = (pattern: unknown) => {
    const i = queue.findIndex((m) => matches(pattern, m));
    if (i >= 0) return queue.splice(i, 1)[0];
    if (eof) process.exit(0);
    return new Promise((resolve) => (waiter = { pattern, resolve }));
  };

  const rh = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "rh", ...args], {
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    log({ pid: process.pid, rh: { args, code, out, err } });
  };

  let input: unknown;
  for (let pc = 0; pc < script.steps.length; pc++) {
    const step = script.steps[pc]!;
    if ("emit" in step) await emit(step.emit, input, step.splitAt);
    else if ("transcript" in step) transcript(step.transcript, input);
    else if ("stderr" in step) writeSync(2, step.stderr);
    else if ("wait" in step) {
      input = await next(step.wait);
      if (step.set) Object.assign(state, JSON.parse(fill(JSON.stringify(step.set), vars(input))));
    }
    else if ("sleep" in step) await Bun.sleep(step.sleep);
    else if ("goto" in step) {
      if ((!step.env || process.env[step.env]) && (!step.kept || queue.some((m) => matches(step.kept, m)))) pc = step.goto - 1;
    }
    else if ("exit" in step) process.exit(step.exit);
    else if ("ignore" in step) process.on(step.ignore, () => {});
    else if ("rh" in step) await rh(step.rh, step.env);
    else if ("rhFrom" in step) {
      let calls: unknown;
      try {
        calls = JSON.parse(String(lookup(vars(input), step.rhFrom)).split("\n").at(-1)!);
      } catch {}
      if (Array.isArray(calls)) for (const c of calls) await (Array.isArray(c) ? rh(c) : rh(c.args, c.env));
    } else if ("rm" in step) rmSync(step.rm, { force: true });
    else process.kill(process.pid, step.kill);
  }
  await closed;
  process.exit(0);
}

/** Splits stdin on byte 0x0A only, never on U+2028, and decodes each whole line. */
async function* stdinLines() {
  let parts: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    let b = Buffer.from(chunk);
    for (let i = b.indexOf(10); i >= 0; i = b.indexOf(10)) {
      parts.push(b.subarray(0, i));
      yield Buffer.concat(parts).toString();
      parts = [];
      b = b.subarray(i + 1);
    }
    if (b.length) parts.push(b);
  }
}
