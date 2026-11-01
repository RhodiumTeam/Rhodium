// pi driver: speaks `pi --mode rpc` (architecture §6.3, ADR-0009) and turns it into the unified
// operations and events of architecture §6.1. Field names follow pi 1.3.0's docs/rpc*.md and the
// probe 17 recordings in test/fixtures/pi/.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headlessEnv } from "./agents";
import { locate } from "./config";
import type {
  AgentAsk,
  AgentDriver,
  AgentEmit,
  AgentEvent,
  AgentLink,
  AgentMessage,
  AskAnswer,
  Choice,
  CommandResult,
  CommonCommand,
  SendMode,
  SpawnSpec,
  TokenUsage,
} from "./contracts";
import { closeLink } from "./holder";
import { pick } from "./im-commands";
// Embedded, so a compiled rhodium can write it out for pi. Imported only as text: once compiled,
// any other import of the same file would be this text too.
import approvalText from "./pi-approval.ts" with { type: "text" };

// TypeScript types the import as the module, not as its text.
const approvalSource = approvalText as unknown as string;

type Json = Record<string, any>;
// `then` sees the whole response record, in line order; a promise continuation would not.
type Pending = { resolve: (data: Json) => void; reject: (e: Error) => void; then?: (record: Json) => void };
// Distributive, so each event variant keeps its own fields once conv and proc are taken off.
type Event = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "conv" | "proc"> : never) : never;

const MAX_LINE = 64 * 1024 * 1024;
// Extension UI methods that block until answered; the others (notify, setStatus...) only inform.
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// Kinds of output the driver knows and has no use for. Anything else is counted as unknown.
const IGNORED = new Set([
  "agent_end", // a run can go on after it (retries, steering); only agent_settled ends the turn
  "turn_start", // pi's turn is one model call; ours is everything up to agent_settled
  "turn_end",
  "tool_execution_update",
  "queue_update",
  "thinking_level_changed",
  "session_info_changed",
  "entry_appended",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

/** Writes the approval extension into dir, unless it is there already, and returns its path. */
export function installApprovalExtension(dir: string): string {
  const file = join(dir, "rhodium-approval.ts");
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current !== approvalSource) {
    mkdirSync(dir, { recursive: true });
    // Whole or not at all: a pi starting meanwhile may be loading it.
    writeFileSync(`${file}.${process.pid}`, approvalSource);
    renameSync(`${file}.${process.pid}`, file);
  }
  return file;
}

const modelName = (m: Json | undefined): string | null => (m ? `${m.provider}/${m.id}` : null);
/** A model as you read it: its name, as /model lists it (docs/im-style.md §2.4). */
const displayName = (m: Json): string => String(m.name ?? modelName(m));

/** Input counts cached tokens too: they are part of what the call read. */
const inputTokens = (u: Json): number => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

export class PiDriver implements AgentDriver {
  readonly conv: string;
  private readonly boot: number;
  private readonly out: AgentEmit;
  private readonly stopGrace: number;
  private readonly extensionDir: string | null; // where the approval extension is written out

  private link: AgentLink | null = null;
  private proc = 0;
  private seq = 0;
  private pending = new Map<string, Pending>();
  // Per process; reset when a new one attaches.
  private state: "idle" | "running" | "waiting" = "idle";
  private starting = false; // a prompt is written and pi has not started its run yet
  // The message pi said it starts a run for (disposition "started"), until that run starts: a steer
  // written just as the last turn settled is one, run as a new turn (#129).
  private startedBy: string | undefined;
  // The messages written and not yet in the conversation, oldest first: pi takes each in, in this
  // order, with a user message_start; a steer only once the model call or tool running ends.
  private waiting: string[] = [];
  // The last prompt's (or /compact's) answer. pi reads every line at once, and a prompt counts as
  // running only once pi has answered it: a prompt or an abort written before then would miss its run.
  private prompted: Promise<unknown> = Promise.resolve();
  private tools = new Map<string, { id: string; name: string; input: unknown }>();
  private asks = new Map<string, AgentAsk>();
  private reply: string | undefined; // the run's last assistant message so far
  private run: Required<TokenUsage> | null = null; // the run's usage so far
  // The level /effort set on this process: a model switch resets pi's to your settings' default.
  private effort: string | null = null;
  // The slot's remembered /model and /effort for the process that attaches next: set on one just
  // spawned; one taken over after a restart (adopt) has them already.
  private want: { model: string | null; effort: string | null; set: boolean } | null = null;
  // Settles once they are set on this process: your messages and commands wait for it. null: none to set,
  // so a command goes at once, ahead of a message sent after it.
  private ready: Promise<unknown> | null = null;
  /** Unknown kinds of output seen so far, with how often; each is logged once. */
  readonly unknown = new Map<string, number>();

  constructor(o: { conv: string; boot: number; emit: AgentEmit; stopGrace?: number; extensionDir?: string }) {
    this.conv = o.conv;
    this.boot = o.boot;
    this.out = o.emit;
    this.stopGrace = o.stopGrace ?? 5000;
    this.extensionDir = o.extensionDir ?? null;
  }

  /** What the runner asks every driver after a restart. pi reports no session id in its output,
   *  so a new conversation's id the restart cut off before its first write is not taken back. */
  // ponytail: always null; a get_state on reattach could recover the id if that window matters.
  readonly info = { session: null };
  readonly sessionOnWrite = true;

  /** A turn is under way, or about to be: a message now has to steer it. */
  private get busy(): boolean {
    return this.starting || this.state !== "idle";
  }

  spawn(o: Parameters<AgentDriver["spawn"]>[0]): SpawnSpec {
    const pi = locate(o.program, o.env.PATH ?? "");
    if (!pi) throw new Error(`pi: ${o.program} not found on PATH ${o.env.PATH ?? "(unset)"}`);
    // pi is a `#!/usr/bin/env node` script: without node on that PATH it cannot start at all.
    if (/^#!.*\benv\s+node\b/.test(readFileSync(pi, "latin1").slice(0, 200)) && !Bun.which("node", { PATH: o.env.PATH ?? "" }))
      throw new Error(`pi: node not found on PATH ${o.env.PATH ?? "(unset)"}`);
    // --session-id opens the session if this directory has it and starts it if not, so a new
    // conversation and a resumed one launch alike.
    const id = "new" in o.session ? o.session.new : o.session.resume;
    const argv = [pi, "--mode", "rpc", "--session-id", id, "--append-system-prompt", o.systemPromptFile];
    if (o.approval) {
      if (!this.extensionDir) throw new Error("pi: approval mode needs the approval extension");
      argv.push("-e", installApprovalExtension(this.extensionDir));
    }
    // pi must not use your Claude subscription (product §12), nor report a parent Herdr pane's state (agents.ts).
    const env = headlessEnv("pi", o.env);
    this.want = o.model || o.effort ? { model: o.model ?? null, effort: o.effort ?? null, set: true } : null;
    return { argv, env, cwd: o.cwd };
  }

  /** The process attaching next is one the last rhodium started, taken over after a restart: it set
   *  the slot's remembered /effort on it, which a /model here sets again. */
  adopt(effort: string | null): void {
    this.want = { model: null, effort, set: false };
  }

  attach(link: AgentLink, proc: number): void {
    this.link = link;
    if (proc !== this.proc) {
      // A new process: nothing of the old one carries over, and its replies match nothing.
      for (const p of this.pending.values()) p.reject(new Error("pi: the agent process was replaced"));
      this.pending.clear();
      this.state = "idle";
      this.starting = false;
      this.startedBy = undefined;
      this.waiting = [];
      this.tools.clear();
      this.asks.clear();
      this.reply = undefined;
      this.run = null;
      this.effort = null;
      this.ready = null;
    }
    this.proc = proc;
    // Set only on a process just spawned; one taken over has them already. A prompt waits for them
    // as it waits for the one before it.
    if (this.want && !this.want.set) this.effort = this.want.effort;
    else if (this.want) {
      const ready: Promise<void> = (this.ready = this.prompted = this.reapply(this.want).finally(() => {
        if (this.ready === ready) this.ready = null;
      }));
    }
    this.want = null;
  }

  /** The slot's remembered /model and /effort on a new process (product §5.6), one after the other:
   *  a model switch resets the thinking level. A model pi no longer has, it refuses; it then runs on
   *  its own default. pi's rpc sets them for this process only, never in your settings. */
  private async reapply(want: { model: string | null; effort: string | null }): Promise<void> {
    const proc = this.proc;
    const model = want.model;
    if (model) {
      const at = model.indexOf("/");
      const gone = (r: Json) => r.success === false && this.emit({ type: "model_gone", model, error: String(r.error) });
      await this.put(null, { type: "set_model", provider: model.slice(0, at), modelId: model.slice(at + 1) }, gone).answered.catch(() => {});
    }
    const effort = want.effort;
    if (effort && this.proc === proc) await this.rpc("set_thinking_level", { level: effort }).then(() => (this.effort = effort), () => {});
  }

  /** pi has no handshake to ask: what it still waits on is what the replayed output asked and
   *  did not settle. */
  replayed(): void {
    this.emit({ type: "pending_asks", asks: [...this.asks.values()] });
  }

  feed(line: Uint8Array, proc?: number, replay = false): void {
    if (proc !== undefined && proc !== this.proc) return; // a late line from a replaced process
    // The holder takes lines of any length; the cap lives here (architecture §4.1).
    if (line.length > MAX_LINE)
      return this.emit({ type: "protocol_error", reason: "line_too_long", detail: `${line.length} bytes, skipped` });
    // pi keeps stdout for protocol records; anything that is not a JSON object is a broken line.
    let m: Json;
    try {
      m = JSON.parse(new TextDecoder().decode(line));
      if (typeof m !== "object" || m === null) throw new Error("not a JSON object");
    } catch (e) {
      return this.emit({ type: "protocol_error", reason: "bad_line", detail: String(e) });
    }
    switch (m.type) {
      case "response":
        return this.response(m);
      case "extension_ui_request":
        return this.dialog(m, replay);
      case "agent_start":
        // Retries and steering start more runs before the turn settles; only the first starts it.
        this.starting = false;
        const input = this.startedBy;
        this.startedBy = undefined;
        if (this.state !== "idle") return;
        this.reply = undefined;
        this.run = null;
        this.emit({ type: "turn_start", ...(input !== undefined && { input }) });
        return this.setState("running");
      case "message_start":
        // Your message joins the conversation. One fed again after a restart joined before it.
        if (m.message?.role === "user" && !replay && this.waiting.length) this.take(this.waiting[0]!);
        return;
      case "message_update":
        if (m.assistantMessageEvent?.type === "text_delta") this.emit({ type: "text_delta", text: String(m.assistantMessageEvent.delta) });
        return;
      case "message_end":
        return this.message(m.message ?? {});
      case "tool_execution_start":
        // Out before the approval is even asked (architecture §6.3): not a sign the tool runs.
        this.tools.set(m.toolCallId, { id: String(m.toolCallId), name: String(m.toolName), input: m.args });
        return this.emit({ type: "tool_start", id: String(m.toolCallId), name: String(m.toolName), input: m.args });
      case "tool_execution_end": {
        const tool = this.tools.get(m.toolCallId) ?? { id: String(m.toolCallId), name: String(m.toolName), input: undefined };
        this.tools.delete(m.toolCallId);
        return this.emit({ type: "item", item: { kind: "tool", ...tool } });
      }
      case "agent_settled":
        return this.settled();
      case "extension_error":
        // Say, the approval extension threw: the tool call may have gone ahead unasked.
        return this.emit({ type: "protocol_error", reason: "unexpected", detail: `pi extension ${m.extensionPath}: ${m.error}` });
      default:
        return this.note(String(m.type));
    }
  }

  /** A message while a turn runs steers it: pi refuses a plain prompt then. Its prompt
   *  response comes before its run starts, so `starting` covers the time in between. Messages come
   *  one at a time (the runner's delivery), each once pi has answered the prompt before it. */
  async send(message: AgentMessage, mode: SendMode): Promise<void> {
    const proc = this.proc;
    await this.prompted;
    this.still(proc);
    const steer = mode === "steer" || this.busy;
    if (!steer) this.starting = true;
    const command = {
      type: "prompt",
      message: message.text,
      ...(message.images?.length && { images: message.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) }),
      ...(steer && { streamingBehavior: "steer" }),
    };
    this.waiting.push(message.id);
    const { written, answered } = this.put(message.id, command, (r) => {
      if (r.success === false) this.emit({ type: "protocol_error", reason: "unexpected", detail: `pi refused a message: ${r.error}` });
      if (r.data?.disposition === "started") this.startedBy = message.id;
      // No run follows a prompt pi refused, or one an extension command handled: the turn is over.
      if ((r.success === false || r.data?.disposition === "handled") && this.starting && this.state === "idle") {
        this.starting = false;
        this.emit({ type: "turn_end" });
      }
    });
    this.prompted = answered.catch(() => {});
    try {
      await written;
    } catch (e) {
      if (!steer) this.starting = false;
      this.waiting = this.waiting.filter((i) => i !== message.id);
      throw e;
    }
  }

  untaken(ids: string[]): void {
    this.waiting = [...ids];
  }

  /** The message is out of pi's queue: in the conversation, or turned down. */
  private take(id: string): void {
    if (!this.waiting.includes(id)) return;
    this.waiting = this.waiting.filter((i) => i !== id);
    this.emit({ type: "taken", inputId: id });
  }

  /** abort: pi answers once the run has stopped and settled (architecture §6.3). It waits for
   *  the last prompt's answer, including one a message waiting alongside it writes meanwhile. */
  async interrupt(): Promise<void> {
    for (let p; p !== this.prompted; ) await (p = this.prompted);
    await this.rpc("abort");
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const ask = this.asks.get(requestId);
    if (!ask) throw new Error(`pi: no pending ask ${requestId}`);
    // The approval extension's are pi's only asks.
    if (answer.kind !== "permission") throw new Error(`pi: ask ${requestId} is a permission, not a ${answer.kind}`);
    const value = answer.allow ? "allow" : answer.message ? `deny: ${answer.message}` : "deny";
    // Taken off before the write, so a second answer meanwhile finds nothing; put back if it fails
    // while the same process still waits on it.
    this.asks.delete(requestId);
    const proc = this.proc;
    try {
      await this.write(this.nextId(), { type: "extension_ui_response", id: requestId, value });
    } catch (e) {
      if (this.proc === proc) this.asks.set(requestId, ask);
      throw e;
    }
    if (this.asks.size === 0 && this.state === "waiting") this.setState("running");
  }

  /** The approval extension loads at launch or not at all; the router restarts pi to switch. */
  async approval(_on: boolean): Promise<void> {
    throw new Error("pi: approval mode switches only with a restart (architecture §6.3)");
  }

  /** The agent's part of a common command (architecture §6.1). The router does /new itself, by
   *  closing the process as for Claude, /stop is interrupt(), and /resume is Rhodium's own. */
  async command(name: CommonCommand, args: string): Promise<CommandResult> {
    const arg = args.trim();
    const proc = this.proc;
    if (this.ready) await this.ready;
    this.still(proc);
    switch (name) {
      case "status": {
        // The model pi is on, by its name: no answer carries the name, so pi's state is asked. The
        // context as /context has it, none right after a compaction.
        const { model } = await this.rpc("get_state");
        const c = await this.command("context", "").catch(() => null);
        const context = c?.command === "context" ? { usedTokens: c.usedTokens, maxTokens: c.maxTokens } : null;
        return { command: "status", model: model ? displayName(model) : null, context };
      }
      case "usage": {
        // pi has no quota interface; its stats add up the whole session file, across restarts.
        const { tokens: t, cost } = await this.rpc("get_session_stats");
        return { command: "usage", limits: [], session: { cost: cost ?? 0, tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.total } } };
      }
      case "context": {
        const c = (await this.rpc("get_session_stats")).contextUsage;
        // Absent with no model; tokens null right after a compaction, until the next answer.
        if (typeof c?.tokens !== "number") throw new Error("pi 现在给不出上下文用量，下个回合之后再试");
        return { command: "context", usedTokens: c.tokens, maxTokens: c.contextWindow ?? null };
      }
      case "compact": {
        // pi's compact aborts the run first: the tools in it would be killed, its half reply sent.
        if (this.busy) throw new Error("回合还在进行，先 /stop 再 /compact");
        // pi refuses a prompt while it compacts, so the next message waits for the answer.
        const done = this.rpc("compact");
        this.prompted = done.catch(() => {});
        const r = await done;
        return { command: "compact", beforeTokens: r.tokensBefore ?? null, afterTokens: r.estimatedTokensAfter ?? null };
      }
      case "model": {
        // /model <model> <level> sets the level too: the second step of /model's panel (docs/im-style.md §9.5).
        const models: Json[] = (await this.rpc("get_available_models")).models ?? [];
        const state = await this.rpc("get_state");
        const now = modelName(state.model);
        const level = String(state.thinkingLevel);
        const choices = models.map((m) => ({ id: modelName(m)!, label: displayName(m), group: String(m.provider), ...(modelName(m) === now && { current: true as const }) }));
        const [name, wanted] = arg.split(/\s+/).filter(Boolean);
        if (!name) return { command: "model", model: now, choices, level };
        const chosen = pick(choices, name, "模型");
        const model = models.find((m) => modelName(m) === chosen.id)!;
        await this.rpc("set_model", { provider: model.provider, modelId: model.id });
        // pi resets the level on a model switch: the one set on this process goes back on (architecture §6.3).
        if (this.effort) await this.rpc("set_thinking_level", { level: this.effort });
        const switched = { command: "model" as const, model: chosen.id, label: chosen.label };
        if (wanted === undefined) {
          // Not always the one before: the model's own default, or one cut to what the model takes.
          const after = String((await this.rpc("get_state")).thinkingLevel);
          return { ...switched, efforts: await this.levels(after), level: after };
        }
        const set = pick(await this.levels(level), wanted, "思考强度").id;
        await this.rpc("set_thinking_level", { level: set });
        this.effort = set;
        return { ...switched, level: set, was: level };
      }
      case "effort": {
        const now = String((await this.rpc("get_state")).thinkingLevel);
        const choices = await this.levels(now);
        if (!arg) return { command: "effort", level: now, choices };
        // Checked here: pi takes a level it does not know as off, without a word.
        const level = pick(choices, arg, "思考强度").id;
        await this.rpc("set_thinking_level", { level });
        this.effort = level;
        return { command: "effort", level };
      }
    }
    throw new Error(`pi: /${name} is not the driver's`);
  }

  /** The thinking levels the model in use takes, the one now marked. */
  private async levels(now: string): Promise<Choice[]> {
    const levels: string[] = (await this.rpc("get_available_thinking_levels")).levels ?? [];
    return levels.map((l) => ({ id: l, label: l, ...(l === now && { current: true as const }) }));
  }

  /** Stdin first, then TERM, then KILL, stopGrace apart (architecture §6.2). Only while no turn
   *  runs: closing stdin mid-turn ends pi at once and the turn with it (architecture §6.3). */
  async close(): Promise<void> {
    if (this.busy) throw new Error("pi: not closing while a turn runs");
    if (!this.link) throw new Error("pi: no agent process attached");
    await closeLink(this.link, this.stopGrace);
  }

  /** Sends one rpc command and resolves with its data; rejects with pi's error. */
  rpc(type: string, fields: Json = {}): Promise<Json> {
    return this.put(null, { type, ...fields }).answered;
  }

  // ---- commands ----

  /** Writes a command under writeId, the holder's id for the write, or else a fresh id. A prompt's is
   *  its input's id, so its answer still matches the input after a restart (response()).
   *  written settles with the write; answered with pi's answer, or with the write's failure. */
  private put(writeId: string | null, command: Json, then?: (record: Json) => void) {
    const id = writeId ?? this.nextId();
    const answered = new Promise<Json>((resolve, reject) => this.pending.set(id, { resolve, reject, then }));
    // A process change rejects it, maybe mid-write or with no one waiting (prompts).
    answered.catch(() => {});
    const written = this.write(id, { id, ...command }).catch((e) => {
      this.pending.get(id)?.reject(e); // never written, so never answered
      this.pending.delete(id);
      throw e;
    });
    written.catch(() => {}); // rpc waits on answered alone
    return { written, answered };
  }

  /** Fails if another process attached since proc, while the caller waited: what it waited to write
   *  was meant for the one that is gone, and the next must not get it (architecture §4.6). */
  private still(proc: number): void {
    if (this.proc !== proc) throw new Error("pi: the agent process was replaced");
  }

  /** Ids carry the boot number, so an answer meant for an earlier boot matches nothing. */
  private nextId() {
    return `rh-${this.boot}-${++this.seq}`;
  }

  private response(m: Json) {
    // Without an id: pi could not parse a line it was sent.
    if (m.id === undefined) return this.emit({ type: "protocol_error", reason: "unexpected", detail: `pi: ${m.command}: ${m.error}` });
    // A prompt refused, or an extension command's, never joins the conversation, nor waits to. Its
    // answer may come after a restart, with nothing here waiting on it (architecture §4.6).
    if (m.success === false || m.data?.disposition === "handled") this.take(String(m.id));
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    p.then?.(m);
    if (m.success === false) p.reject(new Error(String(m.error)));
    else p.resolve(m.data ?? {});
  }

  /** An extension asks something. Only the approval extension's is ours to put to you; any other
   *  dialog is cancelled, or pi would wait for the answer forever. A replayed one was cancelled already. */
  private dialog(m: Json, replay: boolean) {
    if (!DIALOGS.has(m.method)) return;
    let title: Json | undefined;
    try {
      title = JSON.parse(m.title);
    } catch {}
    if (m.method === "select" && title?.rhodium === "approval") {
      const ask: AgentAsk = { requestId: String(m.id), kind: "permission", tool: String(title.toolName), input: title.input, toolUse: String(title.toolCallId) };
      this.asks.set(ask.requestId, ask);
      this.setState("waiting");
      return this.emit({ type: "ask", ...ask });
    }
    this.note(`extension_ui_request/${m.method}`);
    if (replay) return;
    this.write(this.nextId(), { type: "extension_ui_response", id: String(m.id), cancelled: true }).catch(() => {});
  }

  // ---- output ----

  private message(msg: Json) {
    if (msg.role !== "assistant") return; // the system prompt, your messages, tool results
    if (msg.usage) {
      const input = inputTokens(msg.usage);
      const run = (this.run ??= { inputTokens: 0, outputTokens: 0, contextTokens: 0 });
      run.inputTokens += input;
      run.outputTokens += msg.usage.output ?? 0;
      run.contextTokens = input;
    }
    const text = (Array.isArray(msg.content) ? msg.content : [])
      .filter((b: Json) => b?.type === "text")
      .map((b: Json) => String(b.text))
      .join("");
    if (!text) return;
    this.reply = text;
    this.emit({ type: "item", item: { kind: "message", text } });
  }

  /** The turn ends only here (architecture §6.1). */
  private settled() {
    // pi withdraws nothing when a run is aborted (architecture §6.3): what it still asks is void.
    for (const requestId of this.asks.keys()) this.emit({ type: "ask_cancel", requestId });
    this.asks.clear();
    this.tools.clear();
    this.starting = false;
    if (this.run) {
      this.emit({ type: "usage", ...this.run });
      this.run = null;
    }
    this.setState("idle");
    this.emit({ type: "turn_end", ...(this.reply !== undefined && { reply: this.reply }) });
    this.reply = undefined;
  }

  private setState(state: "idle" | "running" | "waiting") {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: "state", state });
  }

  private note(kind: string) {
    if (IGNORED.has(kind)) return;
    const n = this.unknown.get(kind) ?? 0;
    this.unknown.set(kind, n + 1);
    if (n === 0) console.warn(`pi driver (${this.conv}): skipping unknown ${kind}`);
  }

  private emit(e: Event) {
    this.out({ ...e, conv: this.conv, proc: this.proc } as AgentEvent);
  }

  private async write(id: string, command: Json) {
    if (!this.link) throw new Error("pi: no agent process attached");
    await this.link.write(id, JSON.stringify(command));
  }
}
