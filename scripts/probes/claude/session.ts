// Drive one real `claude -p` stream-json process and record it in the
// fixture format: meta, in.log ("<out.log bytes at write time> <raw line>"),
// out.log (raw stdout), err.log (stderr, never committed).
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { packageVersion } from "../../../src/doctor";

export const CLAUDE = process.env.RH_PROBE_CLAUDE ?? Bun.which("claude")!;

export function claudeVersion(): string | null {
  // Read package.json near the binary, as rh doctor does; never run claude for this (architecture §12).
  return packageVersion(CLAUDE);
}

// Launch line from architecture §6.2, minus the per-slot bits callers add.
export const BASE_ARGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--permission-prompt-tool", "stdio", "--include-partial-messages", "--model", "haiku",
];

// Clean environment: nothing from the calling Claude/Herdr session leaks in,
// so the user's Herdr hook and Telegram channel plugin stay inert (architecture §6.2).
export function probeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CLAUDE|HERDR_|ANTHROPIC_|TELEGRAM_)/.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  env.TELEGRAM_STATE_DIR = "/nonexistent/rh-probe-telegram-off";
  return { ...env, ...extra };
}

export type Line = { raw: string; json: any; end: number };
type Pred = (j: any) => boolean;

export class Session {
  lines: Line[] = [];
  outBytes = 0;
  cursor = 0;
  exitCode: number | null = null;
  proc: import("bun").Subprocess<"pipe", "pipe", any>;
  private seq = 0;
  private inFd: number;
  private outFd: number;
  private waiters = new Set<() => void>();
  private done: Promise<void>;
  readonly startedAt = performance.now();

  constructor(readonly dir: string, scenario: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
    mkdirSync(dir, { recursive: true });
    Bun.write(join(dir, "meta"), JSON.stringify({ agent: "claude", version: claudeVersion(), scenario, edited: false }) + "\n");
    this.inFd = openSync(join(dir, "in.log"), "w");
    this.outFd = openSync(join(dir, "out.log"), "w");
    this.proc = Bun.spawn([CLAUDE, ...args], {
      cwd: opts.cwd, env: opts.env ?? probeEnv(), stdin: "pipe", stdout: "pipe",
      stderr: Bun.file(join(dir, "err.log")),
    });
    this.done = this.pump();
  }

  get pid() { return this.proc.pid; }

  private async pump() {
    let buf = new Uint8Array(0);
    for await (const chunk of this.proc.stdout) {
      writeSync(this.outFd, chunk);
      this.outBytes += chunk.length;
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf); merged.set(chunk, buf.length);
      let start = 0;
      const base = this.outBytes - merged.length;
      for (let i = 0; i < merged.length; i++) {
        if (merged[i] !== 0x0a) continue;
        const raw = new TextDecoder().decode(merged.subarray(start, i));
        let json: any = null;
        try { json = JSON.parse(raw); } catch {}
        this.lines.push({ raw, json, end: base + i + 1 });
        start = i + 1;
      }
      buf = merged.slice(start);
      for (const w of this.waiters) w();
    }
    this.exitCode = await this.proc.exited;
    closeSync(this.outFd);
    for (const w of this.waiters) w();
  }

  sendRaw(line: string) {
    writeSync(this.inFd, `${this.outBytes} ${line}\n`);
    const sink = this.proc.stdin;
    sink.write(line + "\n");
    sink.flush();
  }
  send(frame: unknown) { this.sendRaw(JSON.stringify(frame)); }

  nextId() { return `rh-1-${++this.seq}`; }

  /** Send a control request and wait for its response (the inner `response` object). */
  async control(subtype: string, fields: Record<string, unknown> = {}, timeout = 60_000) {
    const id = this.nextId();
    this.send({ type: "control_request", request_id: id, request: { subtype, ...fields } });
    const l = await this.waitFor((j) => j.type === "control_response" && j.response?.request_id === id, timeout, true);
    return l.json.response;
  }

  /** User frame as architecture §6.2 describes it. Returns its uuid. */
  say(text: string, extra: Record<string, unknown> = {}) {
    const uuid = randomUUID();
    this.send({ type: "user", uuid, parent_tool_use_id: null, origin: { kind: "human" },
      message: { role: "user", content: [{ type: "text", text }] }, ...extra });
    return uuid;
  }

  answer(requestId: string, response: unknown) {
    this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  /** Wait for a line after the cursor (or anywhere with `anywhere`), advance the cursor past it. */
  waitFor(pred: Pred, timeout = 120_000, anywhere = false): Promise<Line> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const from = anywhere ? 0 : this.cursor;
        for (let i = from; i < this.lines.length; i++) {
          const line = this.lines[i]!;
          const j = line.json;
          if (j && pred(j)) {
            if (!anywhere) this.cursor = i + 1;
            cleanup(); resolve(line); return;
          }
        }
        if (this.exitCode !== null) { cleanup(); reject(new Error(`claude exited (${this.exitCode}) before match`)); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout after ${timeout}ms`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  idle(timeout?: number) { return this.waitFor(isState("idle"), timeout); }

  find(pred: Pred) { return this.lines.filter((l) => l.json && pred(l.json)).map((l) => l.json); }

  /** Close stdin and wait for exit; returns ms waited, or null on timeout. */
  async close(timeout = 30_000): Promise<number | null> {
    const t0 = performance.now();
    this.proc.stdin.end();
    const ok = await Promise.race([this.done.then(() => true), Bun.sleep(timeout).then(() => false)]);
    closeSync(this.inFd);
    if (!ok) { this.proc.kill("SIGKILL"); await this.done; return null; }
    return Math.round(performance.now() - t0);
  }

  async kill9() {
    this.proc.kill("SIGKILL");
    await this.done;
    closeSync(this.inFd);
  }

  /** RSS and PSS (KB) of claude plus all descendants, e.g. plugin MCP servers. */
  memory() { return treeMemory(this.pid); }
}

export const isState = (s: string) => (j: any) => j.type === "system" && j.subtype === "session_state_changed" && j.state === s;
export const isCanUseTool = (tool?: string) => (j: any) =>
  j.type === "control_request" && j.request?.subtype === "can_use_tool" && (!tool || j.request.tool_name === tool);

function children(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const t of readdirSync(`/proc/${pid}/task`)) {
      const c = readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim();
      if (c) for (const k of c.split(/\s+/)) { const n = Number(k); out.push(n, ...children(n)); }
    }
  } catch {}
  return out;
}

function kb(file: string, key: string) {
  try { return Number(readFileSync(file, "utf8").match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0); } catch { return 0; }
}

export function treeMemory(pid: number) {
  const procs = [pid, ...children(pid)].map((p) => {
    let cmd = "";
    try { cmd = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").slice(0, 3).join(" "); } catch {}
    return { pid: p, cmd, rssKB: kb(`/proc/${p}/status`, "VmRSS"), pssKB: kb(`/proc/${p}/smaps_rollup`, "Pss") };
  });
  return {
    claudeRssKB: procs[0]!.rssKB, claudePssKB: procs[0]!.pssKB,
    treeRssKB: procs.reduce((a, p) => a + p.rssKB, 0), treePssKB: procs.reduce((a, p) => a + p.pssKB, 0),
    procs,
  };
}
