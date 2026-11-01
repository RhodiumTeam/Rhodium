// Codex driver: speaks `codex app-server --listen stdio://` (architecture §6.4, ADR-0011) and turns
// its JSON-RPC into the unified operations and events of architecture §6.1. Field names follow
// codex-cli 0.162.1's generated types and the recordings in test/fixtures/codex/.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { version } from "../package.json";
import { headlessEnv } from "./agents";
import { locate } from "./config";
import type { AgentAsk, AgentDriver, AgentEmit, AgentEvent, AgentLink, AgentMessage, AskAnswer, Choice, CommandResult, CommonCommand, QuotaWindow, SendMode, SpawnSpec, TokenUsage } from "./contracts";
import { closeLink } from "./holder";
import { pick } from "./im-commands";

type Json = Record<string, any>;
type Pending = { resolve: (result: Json) => void; reject: (e: Error) => void };
// Distributive, so each event variant keeps its own fields once conv and proc are taken off.
type Event = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "conv" | "proc"> : never) : never;

const MAX_LINE = 64 * 1024 * 1024;
// Deltas Rhodium has no use for, left out of out.log (architecture §6.4); the reply's text stays.
const OPT_OUT = [
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "turn/diff/updated",
];
// Approval off: Codex asks nothing; on: it asks before every command and patch (untrusted). Never its
// sandbox, which cannot start here (architecture §6.4).
const policy = (approval: boolean) => (approval ? "untrusted" : "never");
const SHELLS = new Set(["zsh", "bash", "sh"]);
// A quota window by its length in minutes (architecture §6.4).
const WINDOW: Record<number, QuotaWindow["window"]> = { 300: "5h", 10080: "7d" };
// How long Rhodium waits for what it asks Codex besides, for /status or a turn out of quota: it goes on
// without what is slow.
const EXTRA_WAIT = 2_000;
/** What Codex answers within EXTRA_WAIT; none if it fails or is slow. */
const within = <T>(p: Promise<T>, none: T) => Promise.race([p.catch(() => none), Bun.sleep(EXTRA_WAIT).then(() => none)]);
// An MCP server's elicitation answered no (architecture §6.4).
const DECLINE = { action: "decline", content: null, _meta: null };

export const NO_UNTRUSTED = "这一版 Codex 不再接受“每条都问”的审批设置，审批开的 Codex 槽位起不来。关掉这个槽位的审批再发一条，或者换回旧版 codex。";
// Its writer lock: your own codex, or the shared app-server it left the thread loaded in (spec codex.md).
const LOCKED = "Codex 说别的程序开着它。你自己的 codex 退出后，它连的后台服务还会占一阵，最长 30 分钟。";

/** The words of a shell line, quotes taken off; null if a quote is left open. */
function words(s: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let t = "";
      for (i++; i < s.length && s[i] !== '"'; i++) t += s[i] === "\\" && '$`"\\\n'.includes(s[i + 1] ?? "") ? s[++i] : s[i];
      if (i >= s.length) return null;
      word = (word ?? "") + t;
    } else if (c === "\\") word = (word ?? "") + (s[++i] ?? "");
    else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}

/** The command as typed (architecture §6.4): Codex runs it as one quoted string after `<shell> -lc`
 *  or `-c`; anything else is shown whole. Not its commandActions, which leave parts out. */
export function typedCommand(command: string): string {
  const w = words(command);
  return w?.length === 3 && SHELLS.has(basename(w[0]!)) && (w[1] === "-lc" || w[1] === "-c") ? w[2]! : command;
}

/** A tool-like item as a tool call: its name as Codex's model calls the tool (architecture §6.4), and
 *  what it was given. null for what is no tool: your messages, its own, reasoning, compaction. */
function toolOf(item: Json): { name: string; input: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "exec_command", input: { command: typedCommand(String(item.command)) } };
    case "fileChange":
      return { name: "apply_patch", input: { changes: item.changes ?? [] } };
    case "webSearch":
      return { name: "web_search", input: { query: item.query } };
    case "imageView":
      return { name: "view_image", input: { path: item.path } };
    case "imageGeneration":
      return { name: "image_gen", input: {} };
    case "mcpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "dynamicToolCall":
      return { name: String(item.tool), input: item.arguments };
    case "collabAgentToolCall": // spawnAgent is spawn_agent
      return { name: String(item.tool).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), input: {} };
    case "plan":
      return { name: "update_plan", input: { text: item.text } };
  }
  return null;
}

/** Codex's answer to a request put to you, by the request (architecture §6.4): a question's by its
 *  questions' ids; more permissions, those it asked for or none; else accept or decline. */
function result(method: string, params: Json, answer: AskAnswer): Json {
  if (answer.kind === "question") return { answers: Object.fromEntries((params.questions ?? []).map((q: Json) => [q.id, { answers: [answer.answers[q.question] ?? ""] }])) };
  const yes = answer.kind === "permission" && answer.allow;
  if (method === "item/permissions/requestApproval") return { permissions: yes ? Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, v]) => v !== null)) : {}, scope: "turn" };
  if (method === "mcpServer/elicitation/request") return { ...DECLINE, action: yes ? "accept" : "decline" };
  return { decision: yes ? "accept" : "decline" };
}

/** What a new process opens: the conversation (a thread to resume, or none yet), and how; model: the
 *  slot's remembered one, put on its turns if Codex still lists it. */
type Open = { cwd: string; thread: string | null; instructions: string; model: string | null };
/** A model as you read it (docs/im-style.md §2.4): its display name; Codex's default, 默认（GPT-6.1-Sol）. */
const modelName = (m: Json): string => (m.isDefault ? `默认（${m.displayName ?? m.id}）` : String(m.displayName ?? m.id));
/** A model as /model lists it: Codex's default is "default", as Claude's is, so picking it goes back to Codex's own. */
const choiceId = (m: Json): string => (m.isDefault ? "default" : String(m.id));
/** The names a model/list's models are kept by (store's modelNames): each model's by its id, the
 *  default's also by "default". */
export function codexModelNames(models: Json[]): Record<string, string> {
  const fallback = models.find((m) => m.isDefault);
  return Object.fromEntries([...models.map((m) => [String(m.id), String(m.displayName ?? m.id)]), ...(fallback ? [["default", modelName(fallback)]] : [])]);
}

export class CodexDriver implements AgentDriver {
  readonly conv: string;
  private readonly boot: number;
  private readonly out: AgentEmit;
  private readonly stopGrace: number;
  private readonly onModels?: (names: Record<string, string>) => void;

  private link: AgentLink | null = null;
  private proc = 0;
  private seq = 0;
  private pending = new Map<unknown, Pending>();
  private thread: string | null = null;
  private busy?: string;
  private why?: string;
  // The process attaching next, if it is one just launched: the handshake and the thread to open.
  private want: Open | null = null;
  // Settles once the thread is open; your messages and commands wait for it. Rejects if it never is.
  private ready: Promise<void> | null = null;
  // Per process; reset when a new one attaches.
  private state: "idle" | "running" | "waiting" = "idle";
  private turn: string | null = null; // the running turn's id, from its turn/started
  private starting = false; // a turn/start went out while idle, and its turn has not started yet
  private startedBy = new Map<string, string>(); // a turn's id, as turn/start's answer gave it, to the input that began it
  // The last turn/start's answer: an interrupt waits for it, or it could miss the turn it starts.
  private prompted: Promise<unknown> = Promise.resolve();
  private tools = new Map<string, { id: string; name: string; input: unknown }>(); // started, not completed
  private reply: { final?: string; last?: string } = {};
  private run: Required<TokenUsage> | null = null;
  private model: string | null = null; // the thread's, as Codex said on opening it
  private effort: string | null = null; // likewise
  // The /model and /effort each turn/start carries: the slot's remembered ones, then what the commands
  // set. Codex keeps them for the turns after, but a message joining a turn does not set them (architecture §6.4).
  private picked: { model?: string; effort?: string } = {};
  private carry: { model?: string; effort?: string } = {}; // the process attaching next has these set already, or will
  private list: Promise<Json[]> | null = null; // model/list's, once asked
  private usage: Json | null = null; // the thread's last thread/tokenUsage/updated
  private limits = new Map<string, Json>(); // the account's quota as Codex last pushed it, by bucket (architecture §6.4)
  private agents = new Map<string, string>(); // sub-agents at work, by thread id: their paths
  // Your /compact: settles as the compaction's turn ends; your messages wait for it (Codex refuses them meanwhile).
  private compaction: { done: Promise<void>; settle: (e?: Error) => void } | null = null;
  private approvalOn = false; // the slot's mode, which each turn/start carries (story 497)
  private asks = new Map<string, { id: unknown; method: string; params: Json; ask: AgentAsk }>(); // put to you, not settled

  constructor(o: { conv: string; boot: number; emit: AgentEmit; stopGrace?: number; onModels?: (names: Record<string, string>) => void }) {
    this.conv = o.conv;
    this.boot = o.boot;
    this.out = o.emit;
    this.stopGrace = o.stopGrace ?? 5000;
    this.onModels = o.onModels;
  }

  /** The thread is the conversation's id (spec codex.md): Codex makes it, so a new conversation's comes
   *  from thread/start's answer, which the runner then records. */
  get info() {
    return { session: this.thread, ...(this.busy && { busy: this.busy }), ...(this.why && { why: this.why }) };
  }

  /** A turn is under way, or about to be. */
  private get running(): boolean {
    return this.starting || this.state !== "idle";
  }

  spawn(o: Parameters<AgentDriver["spawn"]>[0]): SpawnSpec {
    this.busy = this.why = undefined;
    this.approvalOn = o.approval;
    const codex = locate(o.program, o.env.PATH ?? "");
    if (!codex) throw new Error(`codex: ${o.program} not found on PATH ${o.env.PATH ?? "(unset)"}`);
    this.want = { cwd: o.cwd, thread: "resume" in o.session ? o.session.resume : null, instructions: readFileSync(o.systemPromptFile, "utf8"), model: o.model ?? null };
    this.carry = o.effort ? { effort: o.effort } : {};
    // Codex must not see your Claude keys (product §12), nor a parent Herdr pane or Codex session (agents.ts).
    return { argv: [codex, "app-server", "--listen", "stdio://"], env: headlessEnv("codex", o.env), cwd: o.cwd };
  }

  /** The process attaching next is one the last rhodium started and opened the thread on: what it
   *  is doing comes back from its output fed again; the slot's model and level, from its turns, which
   *  Codex keeps; its approval mode goes with its next turn. */
  adopt(effort: string | null, approval: boolean, model: string | null): void {
    this.want = null;
    this.carry = { ...(model && { model }), ...(effort && { effort }) };
    this.approvalOn = approval;
    this.busy = this.why = undefined;
  }

  attach(link: AgentLink, proc: number): void {
    this.link = link;
    if (proc !== this.proc) {
      // A new process: nothing of the old one carries over, and its answers match nothing.
      for (const p of this.pending.values()) p.reject(new Error("codex: the agent process was replaced"));
      this.pending.clear();
      this.thread = null;
      this.ready = null;
      this.state = "idle";
      this.turn = null;
      this.starting = false;
      this.startedBy.clear();
      this.prompted = Promise.resolve();
      this.tools.clear();
      this.asks.clear();
      this.reply = {};
      this.run = null;
      this.model = this.effort = null;
      this.picked = this.carry;
      this.list = null;
      this.usage = null;
      this.limits.clear();
      this.agents.clear();
      this.compaction?.settle(new Error("codex: the agent process was replaced"));
      this.compaction = null;
    }
    this.carry = {};
    this.proc = proc;
    if (!this.want) return;
    const ready = (this.ready = this.open(this.want));
    ready.catch(() => {}); // a message or command waiting on it hears why
    this.want = null;
  }

  /** The handshake, then the thread (architecture §6.4): approval and sandbox every time, as a resumed
   *  thread would otherwise come back read-only; the slot's prompt as developer instructions, which a
   *  resumed thread keeps from its start (developer-resume). One that does not open lets Codex go:
   *  its exit says why. Approval on opens it untrusted or not at all, never quietly unasked (story 498). */
  private async open(w: Open): Promise<void> {
    const proc = this.proc;
    const on = this.approvalOn;
    try {
      await this.request("initialize", { clientInfo: { name: "rhodium", title: "Rhodium", version }, capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT } });
      await this.write(this.nextId(), { method: "initialized" });
      // The slot's model, if Codex still has it; else Codex's default, by its id, as a resumed thread
      // would keep the model it had (architecture §6.1).
      if (w.model) {
        const models = await this.models();
        const model = models.find((m) => m.id === w.model) ?? models.find((m) => m.isDefault);
        if (model?.id !== w.model) this.emit({ type: "model_gone", model: w.model });
        if (model) this.picked.model = String(model.id);
        if (model && this.picked.effort) this.picked.effort = this.fit(model, this.picked.effort);
      }
      const opening = { cwd: w.cwd, approvalPolicy: policy(on), sandbox: "danger-full-access", developerInstructions: w.instructions };
      const r = await (w.thread ? this.request("thread/resume", { threadId: w.thread, ...opening, excludeTurns: true }) : this.request("thread/start", opening));
      if (on && r.approvalPolicy !== "untrusted") throw new Error(`Codex opened it with ${r.approvalPolicy}, not untrusted`);
    } catch (e) {
      if (this.proc !== proc) throw e;
      const said = (e as Error).message;
      if (!this.busy) this.why = on && /untrusted/.test(said) ? NO_UNTRUSTED : `Codex 没能打开这段对话：${said}`;
      void this.link?.eof().catch(() => {});
      throw e;
    }
  }

  /** What Codex still asks after a restart: what the output fed again asked and did not settle. */
  replayed(): void {
    this.emit({ type: "pending_asks", asks: [...this.asks.values()].map((a) => a.ask) });
  }

  /** Codex says which input a user message is (clientId), so nothing is matched by order. */
  untaken(_ids: string[]): void {}

  feed(line: Uint8Array, proc?: number, replay = false): void {
    if (proc !== undefined && proc !== this.proc) return; // a late line from a replaced process
    // The holder takes lines of any length; the cap lives here (architecture §4.1).
    if (line.length > MAX_LINE) return this.emit({ type: "protocol_error", reason: "line_too_long", detail: `${line.length} bytes, skipped` });
    let m: Json;
    try {
      m = JSON.parse(new TextDecoder().decode(line));
      if (typeof m !== "object" || m === null) throw new Error("not a JSON object");
    } catch (e) {
      return this.emit({ type: "protocol_error", reason: "bad_line", detail: String(e) });
    }
    if (m.method === undefined) return this.response(m);
    if (m.id !== undefined) return this.asked(m, replay);
    const p = m.params ?? {};
    // A sub-agent's thread is not the conversation: its turns, items and tokens are its own (live check 7).
    if (this.thread && typeof p.threadId === "string" && p.threadId !== this.thread) return;
    switch (m.method) {
      case "turn/started": {
        this.starting = false;
        const id = String(p.turn?.id);
        if (this.turn === id) return;
        this.turn = id;
        this.reply = {};
        this.run = null;
        const input = this.startedBy.get(id);
        this.startedBy.delete(id);
        this.emit({ type: "turn_start", ...(input !== undefined && { input }) });
        return this.setState("running");
      }
      case "item/started": {
        const item = p.item ?? {};
        // Your message joins the conversation, under the id it was sent with. One fed again joined before.
        if (item.type === "userMessage" && typeof item.clientId === "string" && !replay) this.emit({ type: "taken", inputId: item.clientId });
        if (item.type === "subAgentActivity") return this.subAgent(item);
        const tool = toolOf(item);
        if (!tool) return;
        const call = { id: String(item.id), ...tool };
        this.tools.set(call.id, call);
        return this.emit({ type: "tool_start", ...call });
      }
      case "item/completed": {
        const item = p.item ?? {};
        if (item.type === "agentMessage") return this.message(item);
        if (item.type === "subAgentActivity") return this.subAgent(item);
        const tool = toolOf(item);
        if (!tool) return;
        this.tools.delete(String(item.id));
        return this.emit({ type: "item", item: { kind: "tool", id: String(item.id), ...tool } });
      }
      case "item/agentMessage/delta":
        return this.emit({ type: "text_delta", text: String(p.delta) });
      case "thread/tokenUsage/updated": {
        this.usage = p.tokenUsage ?? null;
        // One model request's tokens: its input holds the cached ones, and is the context it carried.
        const last = p.tokenUsage?.last ?? {};
        const run = (this.run ??= { inputTokens: 0, outputTokens: 0, contextTokens: 0 });
        run.inputTokens += last.inputTokens ?? 0;
        run.outputTokens += last.outputTokens ?? 0;
        run.contextTokens = last.inputTokens ?? 0;
        return;
      }
      case "serverRequest/resolved": {
        // Settled without you, say by an interrupt: withdrawn. One you answered is gone already.
        const id = String(p.requestId);
        if (!this.asks.delete(id)) return;
        this.emit({ type: "ask_cancel", requestId: id });
        if (this.asks.size === 0 && this.state === "waiting") this.setState("running");
        return;
      }
      case "account/rateLimits/updated":
        return this.rated(p.rateLimits);
      case "turn/completed":
        return this.completed(p.turn ?? {}, replay);
    }
    // Anything else, known or not, Rhodium has no use for (architecture §6.4).
  }

  /** Every message is a turn/start: while a turn runs, Codex makes it join that turn (start-mid-turn),
   *  and one written as the turn ends starts the next, so no steer can come too late. Its id is the
   *  input's, as is its clientUserMessageId, which the user message it becomes carries. */
  async send(message: AgentMessage, _mode: SendMode): Promise<void> {
    const proc = this.proc;
    if (this.ready) await this.ready;
    while (this.compaction) await this.compaction.done;
    this.still(proc);
    if (!this.thread) throw new Error("codex: no thread open");
    const idle = !this.running;
    if (idle) this.starting = true;
    const input = [
      { type: "text", text: message.text, text_elements: [] },
      ...(message.images ?? []).map((i) => ({ type: "image", url: `data:${i.mimeType};base64,${i.data}` })),
    ];
    const params = { threadId: this.thread, input, clientUserMessageId: message.id, approvalPolicy: policy(this.approvalOn), sandboxPolicy: { type: "dangerFullAccess" }, ...this.picked };
    const { written, answered } = this.put(message.id, "turn/start", params);
    this.prompted = answered.catch(() => {});
    try {
      await written;
    } catch (e) {
      if (idle) this.starting = false;
      throw e;
    }
  }

  /** Stops the running turn, once the last turn/start is answered: it may be the one that starts it. */
  async interrupt(): Promise<void> {
    for (let p; p !== this.prompted; ) await (p = this.prompted);
    if (!this.thread || !this.turn) return;
    await this.request("turn/interrupt", { threadId: this.thread, turnId: this.turn });
  }

  /** Your answer, under the request's own id. Codex's no takes no words: yours go into the turn that
   *  asked, right after it (architecture §6.4), as the careful answer of a timeout does. */
  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const a = this.asks.get(requestId);
    if (!a) throw new Error(`codex: no pending ask ${requestId}`);
    if (answer.kind !== a.ask.kind) throw new Error(`codex: ask ${requestId} is a ${a.ask.kind}, not a ${answer.kind}`);
    // Taken off before the write, so a second answer meanwhile finds nothing; put back if it fails
    // while the same process still waits on it.
    this.asks.delete(requestId);
    const proc = this.proc;
    try {
      await this.write(this.nextId(), { id: a.id, result: result(a.method, a.params, answer) });
    } catch (e) {
      if (this.proc === proc) this.asks.set(requestId, a);
      throw e;
    }
    if (this.asks.size === 0 && this.state === "waiting") this.setState("running");
    if (answer.kind !== "permission" || answer.allow || !answer.message || !this.thread) return;
    const input = [{ type: "text", text: answer.message, text_elements: [] }];
    this.put(this.nextId(), "turn/steer", { threadId: this.thread, input, expectedTurnId: a.params.turnId ?? this.turn }).answered.catch((e) =>
      this.emit({ type: "protocol_error", reason: "unexpected", detail: `Codex did not take the words that came with your no: ${e.message}` }),
    );
  }

  /** Takes effect from the next turn/start on, which carries it (architecture §6.4). */
  async approval(on: boolean): Promise<void> {
    this.approvalOn = on;
  }

  /** The agent's part of a common command (architecture §6.1). /model and /effort take effect from
   *  the next turn/start, which carries them; the rest only reads, but for /compact. */
  async command(name: CommonCommand, args: string): Promise<CommandResult> {
    const arg = args.trim();
    const proc = this.proc;
    if (this.ready) await this.ready;
    this.still(proc);
    const level = this.picked.effort ?? this.effort;
    const now = { ...(level && { level }) };
    switch (name) {
      case "status": {
        // What it asks Codex besides, the names and the quota, cost nothing; one slow is left out.
        const [models, quota] = await Promise.all([within(this.models(), []), within(this.quota(), null)]);
        const using = this.using(models);
        return { command: "status", model: using ? modelName(using) : (this.picked.model ?? this.model), context: this.context(), limits: quota?.limits ?? [], ...(level && { effort: level }) };
      }
      case "context": {
        const context = this.context();
        // A new thread's, until its first answer.
        if (!context) throw new Error("Codex 现在给不出上下文用量，下个回合之后再试");
        return { command: "context", ...context };
      }
      case "usage": {
        // No cost: Codex gives none. The tokens of the whole thread, as Codex counts them across processes.
        const quota = await this.quota();
        const t = this.usage?.total;
        const tokens = t && { input: t.inputTokens - t.cachedInputTokens, output: t.outputTokens, cacheRead: t.cachedInputTokens, cacheWrite: t.cacheWriteInputTokens, total: t.totalTokens };
        return { command: "usage", limits: quota?.limits ?? [], ...(quota?.credits !== undefined && { credits: quota.credits }), ...(tokens && { session: { tokens } }) };
      }
      case "model": {
        // /model <model> <level> sets the level too: the second step of /model's panel (docs/im-style.md §9.5).
        const models = await this.models();
        const using = this.using(models);
        const choices = models.map((m) => ({ id: choiceId(m), label: modelName(m), ...(m === using && { current: true as const }) }));
        const [name, wanted] = arg.split(/\s+/).filter(Boolean);
        if (!name) return { command: "model", model: this.picked.model ?? this.model, choices, ...now };
        // The default by its own id is the default too.
        const chosen = pick(choices, models.find((m) => m.isDefault)?.id === name ? "default" : name, "模型");
        const model = models.find((m) => choiceId(m) === chosen.id)!;
        // A level the model lacks moves to its default, as the model switches now; so it is set too.
        const fitted = level && this.fit(model, level);
        const efforts = this.levels(model, fitted);
        const set = wanted === undefined ? undefined : pick(efforts, wanted, "思考强度").id;
        // The default by its id, so a model picked before is not kept.
        this.picked.model = String(model.id);
        if (fitted) this.picked.effort = fitted;
        const switched = { command: "model" as const, model: model.isDefault ? null : String(model.id), label: chosen.label };
        if (set === undefined) return { ...switched, efforts, ...(fitted && { level: fitted }), ...(fitted !== level && { was: level! }) };
        this.picked.effort = set;
        return { ...switched, level: set, was: level ?? "-" };
      }
      case "effort": {
        const models = await this.models();
        const choices = this.levels(this.using(models) ?? models.find((m) => m.isDefault), level);
        if (!arg) return { command: "effort", level: level ?? "-", choices };
        const set = pick(choices, arg, "思考强度").id;
        this.picked.effort = set;
        return { command: "effort", level: set };
      }
      case "compact": {
        // Only between turns, as on Claude and pi. Codex runs it as a turn of its own, which ends it.
        if (this.running) throw new Error("回合还在进行，先 /stop 再 /compact");
        const before = this.context()?.usedTokens ?? null;
        let settle!: (e?: Error) => void;
        const done = new Promise<void>((resolve, reject) => (settle = (e) => (e ? reject(e) : resolve())));
        this.compaction = { done: done.catch(() => {}), settle };
        this.starting = true;
        try {
          await this.request("thread/compact/start", { threadId: this.thread });
        } catch (e) {
          this.starting = false;
          this.compaction = null;
          throw e;
        }
        await done;
        return { command: "compact", beforeTokens: before, afterTokens: this.context()?.usedTokens ?? null };
      }
    }
    throw new Error(`codex: /${name} is not the driver's`);
  }

  /** Codex's models, the hidden ones left out, as model/list gives them: asked once a process, and their
   *  names kept for when no process runs (architecture §6.1). */
  private models(): Promise<Json[]> {
    const list = (this.list ??= this.request("model/list", { includeHidden: false }).then((r) => {
      const models: Json[] = r.data ?? [];
      this.onModels?.(codexModelNames(models));
      return models;
    }));
    list.catch(() => this.list === list && (this.list = null)); // asked again next time
    return list;
  }

  /** The model in use: the one picked, else the thread's. */
  private using(models: Json[]): Json | undefined {
    const id = this.picked.model ?? this.model;
    return models.find((m) => m.id === id);
  }

  /** The levels the model takes, the one set marked. */
  private levels(model: Json | undefined, level: string | null): Choice[] {
    return ((model?.supportedReasoningEfforts ?? []) as Json[]).map((e) => String(e.reasoningEffort ?? e)).map((l) => ({ id: l, label: l, ...(l === level && { current: true as const }) }));
  }

  /** The level the model takes in place of this one: the same, or, for one it lacks, the model's default
   *  (GPT-6-Luna has no ultra). */
  private fit(model: Json, level: string): string {
    return this.levels(model, null).some((l) => l.id === level) ? level : String(model.defaultReasoningEffort ?? level);
  }

  /** How full the context is: the last model request's tokens, out of the model's window. */
  private context() {
    const u = this.usage;
    return u?.last ? { usedTokens: Number(u.last.totalTokens), maxTokens: u.modelContextWindow ?? null } : null;
  }

  /** The account's quota windows, its own and a model's, and the credits left (architecture §6.4); null
   *  with none, as an API key login has. */
  private async quota(): Promise<{ limits: QuotaWindow[]; credits?: number } | null> {
    const r = await this.request("account/rateLimits/read", {}).catch(() => null);
    if (!r?.rateLimits) return null;
    const main: Json = r.rateLimits;
    const buckets: Json[] = [main, ...Object.values((r.rateLimitsByLimitId ?? {}) as Record<string, Json>).filter((b) => b.limitId !== main.limitId)];
    // A model's bucket by the model's name.
    const names = new Map(buckets.some((b) => b.normalModelSlug) ? (await this.models().catch(() => [])).map((m) => [m.id, m.displayName]) : []);
    const limits = buckets.flatMap((b) =>
      [b.primary, b.secondary].flatMap((w: Json | null): QuotaWindow[] => {
        const window = w && WINDOW[w.windowDurationMins];
        if (!window) return [];
        const model = b.normalModelSlug && String(names.get(b.normalModelSlug) ?? b.normalModelSlug);
        return [{ window, ...(model && { model }), usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null }];
      }),
    );
    const c = main.credits;
    return { limits, ...(c?.hasCredits && c.balance != null && { credits: Number(c.balance) }) };
  }

  /** Stdin first, then TERM, then KILL, stopGrace apart. Only while no turn runs: closing stdin
   *  mid-turn kills the turn at once (close-mid-turn). */
  async close(): Promise<void> {
    if (this.running) throw new Error("codex: not closing while a turn runs");
    if (!this.link) throw new Error("codex: no agent process attached");
    await closeLink(this.link, this.stopGrace);
  }

  // ---- requests ----

  private request(method: string, params: Json): Promise<Json> {
    return this.put(this.nextId(), method, params).answered;
  }

  /** Writes a request under id; written settles with the write, answered with Codex's answer. */
  private put(id: string, method: string, params: Json) {
    const answered = new Promise<Json>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    answered.catch(() => {}); // a process change rejects it, maybe with no one waiting
    const written = this.write(id, { id, method, params }).catch((e) => {
      this.pending.get(id)?.reject(e); // never written, so never answered
      this.pending.delete(id);
      throw e;
    });
    written.catch(() => {});
    return { written, answered };
  }

  /** Fails if another process attached since proc, while the caller waited (architecture §4.6). */
  private still(proc: number): void {
    if (this.proc !== proc) throw new Error("codex: the agent process was replaced");
  }

  /** The driver's own ids carry the boot number, so an answer meant for an earlier boot matches
   *  nothing; a turn/start's is its input's. */
  private nextId() {
    return `rh-${this.boot}-${++this.seq}`;
  }

  /** An answer. What it says of the thread and the turn counts also when fed again after a restart. */
  private response(m: Json) {
    const r = m.result ?? {};
    if (typeof r.thread?.id === "string") {
      this.thread = r.thread.id;
      this.model = typeof r.model === "string" ? r.model : null;
      this.effort = typeof r.reasoningEffort === "string" ? r.reasoningEffort : null;
    }
    if (/already has an active writer/.test(m.error?.message ?? "")) this.busy = LOCKED;
    // A turn/start's id is its input's: the turn it starts begins with it. One that joins a running turn
    // names that one. One refused never joins the conversation, nor waits to.
    const input = typeof m.id === "string" && !m.id.startsWith("rh-") ? m.id : null;
    if (input && typeof r.turn?.id === "string" && r.turn.id !== this.turn) this.startedBy.set(r.turn.id, input);
    if (input && m.error) {
      this.emit({ type: "taken", inputId: input });
      this.emit({ type: "protocol_error", reason: "unexpected", detail: `Codex refused a message: ${m.error.message}` });
      if (this.starting && this.state === "idle") {
        this.starting = false;
        this.emit({ type: "turn_end" });
      }
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(String(m.error.message)));
    else p.resolve(r);
  }

  // ---- output ----

  /** The reply is the turn's last message, its final answer first; an empty one says nothing. */
  private message(item: Json) {
    const text = String(item.text ?? "");
    if (!text) return;
    this.reply.last = text;
    if (item.phase === "final_answer") this.reply.final = text;
    this.emit({ type: "item", item: { kind: "message", text } });
  }

  /** A sub-agent Codex set to work, or one done: what runs is a background task, which keeps the process
   *  (product §4.4). Its end wakes no turn here (live check 7). */
  private subAgent(item: Json) {
    const id = String(item.agentThreadId);
    if (item.kind === "started") {
      if (this.agents.has(id)) return;
      this.agents.set(id, String(item.agentPath ?? id));
    } else if (item.kind !== "completed" && item.kind !== "interrupted") return;
    else if (!this.agents.delete(id)) return;
    this.emit({ type: "background", tasks: [...this.agents].map(([id, description]) => ({ id, description })) });
  }

  /** Codex asks something (architecture §6.4). An approval or a multiple choice is put to you; an MCP
   *  server's form or link to open is declined, and anything else gets an error, at once, or its turn
   *  would wait on it for good. One fed again was answered before the restart, unless still open. */
  private asked(m: Json, replay: boolean) {
    const ask = this.toAsk(m);
    if (ask) {
      this.asks.set(ask.requestId, { id: m.id, method: m.method, params: m.params ?? {}, ask });
      this.setState("waiting");
      return this.emit({ type: "ask", ...ask });
    }
    if (replay) return;
    const answer = m.method === "mcpServer/elicitation/request" ? { result: DECLINE } : { error: { code: -32601, message: `rhodium does not handle ${m.method}` } };
    this.write(this.nextId(), { id: m.id, ...answer }).catch(() => {});
  }

  /** The ask a request of Codex's puts to you, by Codex's tool names; null for one not yours to answer. */
  private toAsk(m: Json): AgentAsk | null {
    const p = m.params ?? {};
    const requestId = String(m.id);
    const toolUse = String(p.itemId);
    switch (m.method) {
      case "item/commandExecution/requestApproval":
        return { requestId, kind: "permission", tool: "exec_command", input: { command: typedCommand(String(p.command ?? "")) }, toolUse };
      case "item/fileChange/requestApproval":
        // It has no changes: the item it asks about came with them.
        return { requestId, kind: "permission", tool: "apply_patch", input: this.tools.get(toolUse)?.input ?? { changes: [] }, toolUse };
      case "item/permissions/requestApproval":
        return { requestId, kind: "permission", tool: "request_permissions", input: p.permissions, toolUse };
      case "item/tool/requestUserInput":
        return { requestId, kind: "question", tool: "request_user_input", input: { questions: (p.questions ?? []).map((q: Json) => ({ question: q.question, options: q.options ?? [], multiSelect: false })) } };
      case "mcpServer/elicitation/request": {
        // An MCP tool's approval is a form marked as one; it asks about that server's call just started.
        if (p.mode !== "form" || p._meta?.codex_approval_kind !== "mcp_tool_call") return null;
        const call = [...this.tools.values()].findLast((t) => t.name.startsWith(`mcp__${p.serverName}__`));
        return { requestId, kind: "permission", tool: call?.name ?? `mcp__${p.serverName}`, input: call?.input ?? p._meta.tool_params ?? {}, ...(call && { toolUse: call.id }) };
      }
    }
    return null;
  }

  /** A bucket of the account's quota, merged into what Codex said of it before: an update leaves out
   *  what it does not know (architecture §6.4). */
  private rated(b: Json | null | undefined) {
    if (!b) return;
    const id = String(b.limitId ?? "codex");
    this.limits.set(id, { ...this.limits.get(id), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null)) });
  }

  /** When the quota used up comes back, in ms: the last reset of the windows full (story 502); null if
   *  none is, as Codex said. */
  private reset(): number | null {
    const at = [...this.limits.values()].flatMap((b) => [b.primary, b.secondary]).filter((w) => w?.usedPercent >= 100 && typeof w.resetsAt === "number");
    return at.length ? Math.max(...at.map((w) => w.resetsAt * 1000)) : null;
  }

  /** A turn out of quota with no full window known waits for Codex's quota, read now. One fed again
   *  after a restart does not: what it reports goes nowhere then. The read ends only its own turn:
   *  your next message may have begun another meanwhile. */
  private completed(turn: Json, replay: boolean) {
    if (turn.error?.codexErrorInfo !== "usageLimitExceeded" || replay || this.reset() !== null) return this.ended(turn);
    const proc = this.proc;
    const id = this.turn;
    // ponytail: a restart before the read answers loses this end: the output offset is past its
    // turn/completed, fed again for state only, its turn_end dropped, so the slot stays running until
    // your next message. Hold the offset back until the read answers if that bites.
    void within(this.request("account/rateLimits/read", {}), null) // none to read, as on an API key login
      .then((r) => r && [r.rateLimits, ...Object.values(r.rateLimitsByLimitId ?? {})].forEach((b) => this.rated(b as Json)))
      .then(() => this.proc === proc && this.turn === id && this.ended(turn));
  }

  /** The turn ends only here (architecture §6.1). A command it cut short never completes: closed off
   *  here, so no tool line is left running. What it still asked is void. Your /compact's ends it. Out
   *  of quota with a full window to wait for, the slot waits (story 502), Codex's words its reply as
   *  Claude's refusal is; else it failed as any other turn. */
  private ended(turn: Json) {
    for (const requestId of this.asks.keys()) this.emit({ type: "ask_cancel", requestId });
    this.asks.clear();
    for (const call of this.tools.values()) this.emit({ type: "item", item: { kind: "tool", ...call } });
    this.tools.clear();
    this.turn = null;
    this.starting = false;
    const reset = turn.error?.codexErrorInfo === "usageLimitExceeded" ? this.reset() : null;
    if (reset !== null) this.emit({ type: "usage", quota: { exhausted: true, resetsAt: reset } });
    else if (turn.status === "failed") this.emit({ type: "protocol_error", reason: "unexpected", detail: `Codex: ${turn.error?.message ?? "the turn failed"}` });
    if (this.run) {
      this.emit({ type: "usage", ...this.run });
      this.run = null;
    }
    this.setState("idle");
    const reply = reset !== null ? String(turn.error.message) : (this.reply.final ?? this.reply.last);
    const compaction = this.compaction;
    this.compaction = null;
    this.emit({ type: "turn_end", ...(reply !== undefined && { reply }), ...(compaction && { compactOnly: true as const }) });
    this.reply = {};
    compaction?.settle(turn.status === "completed" ? undefined : new Error(`Codex 没有压缩上下文：${turn.error?.message ?? turn.status}`));
  }

  private setState(state: "idle" | "running" | "waiting") {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: "state", state });
  }

  private emit(e: Event) {
    this.out({ ...e, conv: this.conv, proc: this.proc } as AgentEvent);
  }

  private async write(id: string, message: Json) {
    if (!this.link) throw new Error("codex: no agent process attached");
    await this.link.write(id, JSON.stringify(message));
  }
}
