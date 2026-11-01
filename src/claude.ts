// Claude driver: speaks `claude -p` stream-json itself (ADR-0004, architecture §6.2)
// and turns it into the unified operations and events of architecture §6.1.
//
// The control-request handling follows the Claude Agent SDK for Python
// (https://github.com/anthropics/claude-agent-sdk-python), under this notice:
//
//   MIT License
//
//   Copyright (c) 2025 Anthropic, PBC
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// Field names follow the official TS SDK's sdk.d.ts, read only, never copied.
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
  ExtraUsage,
  QuotaWindow,
  SendMode,
  SessionUse,
  SpawnSpec,
  Tokens,
  TokenUsage,
} from "./contracts";
import { closeLink } from "./holder";
import { pick } from "./im-commands";
import { claudeModelName } from "./store";

type Json = Record<string, any>;
// `then` runs in line order, before the next line is handled; a promise continuation would not.
type Pending = { resolve: (response: Json) => void; reject: (e: Error) => void; then?: (response: Json) => void };
// Distributive, so each event variant keeps its own fields once conv and proc are taken off.
type Event = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "conv" | "proc"> : never) : never;

/** What one agent process said about itself (architecture §6.2 "能力按进程记"). session: the
 *  session id its init reported, so the session exists by then. selfStarted: whether it began a
 *  turn by itself before it answered initialize, as Claude resumed after a crash does when it has
 *  an interrupted turn to run again (architecture §4.8); null until it answers. */
export type ProcessInfo = {
  argv: readonly string[] | null;
  model: string | null;
  version: string | null;
  capabilities: readonly string[];
  session: string | null;
  selfStarted: boolean | null;
};

const MAX_LINE = 64 * 1024 * 1024;
// /compact waits among the control requests under this id, which none of theirs looks like: its
// compact boundary answers it, and a new process rejects it as it does them.
const COMPACT = "compact";
/** get_context_usage's categories Rhodium names in Chinese (spec info-commands); the rest keep Claude's name. */
const CATEGORY: Record<string, string> = { messages: "消息", system_tools: "工具", system_prompt: "系统提示", skills: "技能", autocompact_buffer: "自动压缩预留" };
/** get_usage's window groups (architecture §6.2): session is the five hours, weekly the seven days. */
const WINDOW: Record<string, QuotaWindow["window"]> = { session: "5h", weekly: "7d" };
/** A model id as you read it: claude-haiku-5-5 as Haiku 5.5; one of another form as it is. */
const modelName = (id: string) => id.replace(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(?=$|\[)/, (_, n: string, a, b) => `${n[0]!.toUpperCase()}${n.slice(1)} ${a}.${b}`);
const SESSION_STATE = { idle: "idle", running: "running", requires_action: "waiting" } as const;
// Kinds of output the driver knows and has no use for. Anything else is counted as unknown.
const IGNORED = new Set([
  ...["hook_started", "hook_response", "task_started", "task_updated", "task_progress", "task_notification", "thinking_tokens"]
    .map((s) => `system/${s}`),
  ...["message_start", "message_delta", "message_stop", "content_block_start", "content_block_stop"].map((s) => `stream_event/${s}`),
]);

/**
 * Throws unless the launch is free of --bare and of CLAUDE_CODE_SIMPLE, which is what --bare
 * sets: it skips the subscription login (product §12). Returns the spec for chaining.
 */
export function refuseBare(spec: SpawnSpec): SpawnSpec {
  const end = spec.argv.indexOf("--");
  const args = end < 0 ? spec.argv : spec.argv.slice(0, end);
  const simple = spec.env.CLAUDE_CODE_SIMPLE;
  if (args.some((a) => a === "--bare" || a.startsWith("--bare=")) || (simple && !/^(0|false|no|off)$/i.test(simple)))
    throw new Error("claude: refusing to launch with --bare (CLAUDE_CODE_SIMPLE): it skips the subscription login");
  return spec;
}

/** The slot's remembered /model, /effort and /ultracode as launch flags (product §5.6), the headless
 *  agent's and the terminal's alike. --effort, not --settings' effortLevel, which drops max; ultracode
 *  by its settings key, which takes it at any level (#276). A model that cannot take it runs without. */
export const claudeFlags = (model: string | null | undefined, effort: string | null | undefined, ultracode?: boolean | null): string[] => [
  ...(model ? ["--model", model] : []),
  ...(effort ? ["--effort", effort] : []),
  ...(typeof ultracode === "boolean" ? ["--settings", JSON.stringify({ ultracode })] : []),
];

/** For an undocumented control request (get_usage, get_settings) that no capability names: a CLI
 *  without it answers that it does not know it, which reads as an empty answer. */
/** How long /status waits for the context and the quota: the CLI answers both in milliseconds, mid-turn too. */
const STATUS_EXTRA_WAIT = 2_000;

const unknownAsEmpty = (e: Error): Json => {
  if (e.message.startsWith("Unsupported control request subtype")) return {};
  throw e;
};

/**
 * Why the CLI would not take this frame, or null. It ignores unknown types and extra fields,
 * but exits on a known frame missing what it needs, such as a user frame without a message
 * (probe 8), so the driver checks each frame before writing it.
 */
function flaw(f: Json): string | null {
  const str = (v: unknown) => typeof v === "string";
  const r = f.response;
  switch (f.type) {
    case "user":
      return str(f.uuid) && f.message?.role === "user" && Array.isArray(f.message.content) && f.message.content.length > 0 &&
        f.message.content.every(
          (b: Json) =>
            (b?.type === "text" && str(b.text)) ||
            (b?.type === "image" && b.source?.type === "base64" && str(b.source.media_type) && str(b.source.data)),
        )
        ? null
        : "a user frame needs a uuid and text or base64 image content";
    case "control_request":
      return str(f.request_id) && str(f.request?.subtype) ? null : "a control request needs request_id and request.subtype";
    case "control_response":
      return str(r?.request_id) && (r.subtype === "success" ? typeof r.response === "object" && r.response !== null : r?.subtype === "error" && str(r.error))
        ? null
        : "a control response needs request_id and a response or an error";
  }
  return `unknown frame type ${f.type}`;
}

/** The uuid of the user frame carrying input id, which command_lifecycle names it by: made from the
 *  id, so a rhodium started since still knows which input that is (untaken). */
export const frameUuid = (id: string): string => Bun.randomUUIDv5(id, "url");

/** Input counts cached tokens too: they are part of what the turn read. */
const inputTokens = (u: Json): number => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** The ask a can_use_tool control request makes, or null for any other request. */
function askOf(m: Json): AgentAsk | null {
  const r = m?.request;
  if (r?.subtype !== "can_use_tool" || typeof m.request_id !== "string") return null;
  const kind = r.tool_name === "AskUserQuestion" ? "question" : r.tool_name === "ExitPlanMode" ? "plan" : "permission";
  return { requestId: m.request_id, kind, tool: String(r.tool_name), input: r.input, ...(typeof r.tool_use_id === "string" && { toolUse: r.tool_use_id }) };
}

export class ClaudeDriver implements AgentDriver {
  readonly conv: string;
  private readonly boot: number;
  private readonly out: AgentEmit;
  private readonly stopGrace: number;
  private readonly onVersion: ((version: string) => void) | undefined;
  private readonly onModels: ((models: Json[]) => void) | undefined;

  private argv: string[] | null = null; // from the last spawn, for the process that attaches next
  private link: AgentLink | null = null;
  private proc = 0;
  private seq = 0;
  private pending = new Map<string, Pending>();
  // Per process; reset when a new one attaches.
  private about: ProcessInfo = { argv: null, model: null, version: null, capabilities: [], session: null, selfStarted: null };
  private state: "idle" | "running" | "waiting" = "idle";
  private started = false; // a turn began since this process attached
  private tools = new Map<string, { id: string; name: string; input: unknown }>();
  private asks = new Map<string, AgentAsk>();
  private tasks: { id: string; description: string }[] = [];
  private subagents = false; // a background task other than a shell runs: the CLI holds back idle (#226)
  private reply: string | undefined; // the turn's last assistant message so far
  private sent: "nothing" | "compact" | "other" = "nothing"; // what was written since the last turn ended
  // The inputs whose user frames were written and not yet taken into a turn, oldest first:
  // command_lifecycle says when the CLI takes each. One still there when a turn starts began it,
  // though written before the last one ended (#129). Results can't tell: one taken in between tool
  // calls gets none of its own.
  private waiting: string[] = [];
  /** Unknown kinds of output seen so far, with how often; each is logged once. */
  readonly unknown = new Map<string, number>();
  private contextTokens: number | undefined;
  private usage: TokenUsage | null = null; // the last turn's, for /status
  // The answer to this process's initialize: its models, for /model and /effort.
  private hello: Promise<Json> = Promise.resolve({});
  private effort: string | null = null; // the level /effort set in this process; Claude does not say it
  // The slot's remembered /model and /effort, from the last spawn, for the process that attaches next.
  private want: { model: string | null; effort: string | null } | null = null;
  // Settles once they are set on this process: your messages and commands wait for it.
  private ready: Promise<unknown> = Promise.resolve();
  private picked: string | null = null; // the value /model set in this process: default and an alias resolve alike

  /** onVersion: called with the claude_code_version each process reports in its handshake; onModels,
   *  with the models it offers. */
  constructor(o: { conv: string; boot: number; emit: AgentEmit; stopGrace?: number; onVersion?: (version: string) => void; onModels?: (models: Json[]) => void }) {
    this.conv = o.conv;
    this.boot = o.boot;
    this.out = o.emit;
    this.stopGrace = o.stopGrace ?? 5000;
    this.onVersion = o.onVersion;
    this.onModels = o.onModels;
  }

  /** What the attached process said about itself. */
  get info(): Readonly<ProcessInfo> {
    return this.about;
  }

  spawn(o: Parameters<AgentDriver["spawn"]>[0]): SpawnSpec {
    refuseBare({ argv: [], env: o.env, cwd: o.cwd });
    const claude = locate(o.program, o.env.PATH ?? "");
    if (!claude) throw new Error(`claude: ${o.program} not found on PATH ${o.env.PATH ?? "(unset)"}`);
    // No --setting-sources: your settings, plugins, skills, MCP servers and hooks load as in the terminal.
    const argv = [
      claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-prompt-tool", "stdio", "--include-partial-messages",
      "--append-system-prompt-file", o.systemPromptFile, "--system-prompt-snapshot", "off",
      // At launch: a turn Claude runs again by itself after a crash starts before the handshake's answer.
      // /effort still changes a level launched with --effort (architecture §6.2).
      ...claudeFlags(o.model, o.effort, o.ultracode),
      "new" in o.session ? `--session-id=${o.session.new}` : `--resume=${o.session.resume}`,
      // Probe 6: questions and plan confirmations still come through can_use_tool in this mode.
      // With approval on, the CLI's default mode asks; the allow flag only lets approval() switch to
      // bypassPermissions later, which the CLI refuses a process launched without it.
      ...(o.approval ? ["--allow-dangerously-skip-permissions"] : ["--permission-mode", "bypassPermissions"]),
    ];
    // What a parent session hands down goes (agents.ts); each launch logs what it dropped.
    const env = headlessEnv("claude", o.env);
    const dropped = Object.keys(o.env).filter((k) => !(k in env));
    if (dropped.length) console.warn(`claude driver (${this.conv}): not passing ${dropped.join(" ")} to claude`);
    env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
    // After a crash Claude runs the interrupted turn again by itself (architecture §4.8).
    if (o.resumed) env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1";
    this.argv = argv;
    this.want = o.model || o.effort ? { model: o.model ?? null, effort: o.effort ?? null } : null;
    return refuseBare({ argv, env, cwd: o.cwd });
  }

  attach(link: AgentLink, proc: number): void {
    this.link = link;
    if (proc !== this.proc) {
      // A new process: nothing of the old one carries over, and its replies match nothing.
      for (const p of this.pending.values()) p.reject(new Error("claude: the agent process was replaced"));
      this.pending.clear();
      this.about = { argv: this.argv, model: null, version: null, capabilities: [], session: null, selfStarted: null };
      this.state = "idle";
      this.started = false;
      this.tools.clear();
      this.asks.clear();
      this.tasks = [];
      this.subagents = false;
      this.reply = undefined;
      this.sent = "nothing";
      this.waiting = [];
      this.contextTokens = undefined;
      this.usage = null;
      this.effort = null;
      this.ready = Promise.resolve();
      this.picked = null;
    }
    this.proc = proc;
    this.hello = this.put("initialize", { perTaskStopAffordance: true }, (r) => this.initialized(r)).then((p) => p.answered);
    this.hello.catch(() => {});
    // Only a process just spawned, which got them with its launch: one taken over after a restart
    // has them already.
    if (this.want) {
      this.effort = this.want.effort;
      this.picked = this.want.model;
      if (this.want.model) this.ready = this.checkModel(this.want.model).catch(() => {});
    }
    this.want = null;
  }

  /** A remembered model the handshake no longer offers, say after an upgrade, goes back to the default. */
  private async checkModel(model: string): Promise<void> {
    if ((await this.models()).some((m) => m.value === model)) return;
    this.emit({ type: "model_gone", model });
    await this.control("set_model", { model: "default" });
  }

  /** Nothing to do: the answer to initialize names the asks still open, and it comes after the replay. */
  replayed(): void {}

  feed(line: Uint8Array, proc?: number, replay = false): void {
    if (proc !== undefined && proc !== this.proc) return; // a late line from a replaced process
    // The holder takes lines of any length; the cap lives here (architecture §4.1).
    if (line.length > MAX_LINE)
      return this.emit({ type: "protocol_error", reason: "line_too_long", detail: `${line.length} bytes, skipped` });
    // Some CLI versions print debug lines to stdout; only JSON objects are protocol.
    if (line[0] !== 0x7b) return this.note("non_json");
    let m: Json;
    try {
      m = JSON.parse(new TextDecoder().decode(line));
    } catch (e) {
      return this.emit({ type: "protocol_error", reason: "bad_line", detail: String(e) });
    }
    switch (m.type) {
      case "control_response":
        return this.response(m.response ?? {});
      case "control_request":
        return this.request(m, replay);
      case "control_cancel_request":
        // The CLI gave up on this ask (say, the turn was interrupted): withdraw it, never answer it.
        if (this.asks.delete(m.request_id)) this.emit({ type: "ask_cancel", requestId: m.request_id });
        return;
      case "system":
        return this.system(m);
      case "stream_event":
        if (m.event?.type !== "content_block_delta") return this.note(`stream_event/${m.event?.type}`);
        if (m.parent_tool_use_id == null && m.event.delta?.type === "text_delta") this.emit({ type: "text_delta", text: m.event.delta.text });
        return;
      case "assistant":
        return this.assistant(m);
      case "user":
        return this.user(m);
      case "rate_limit_event": {
        const info = m.rate_limit_info ?? {};
        const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null;
        return this.emit({ type: "usage", quota: { exhausted: info.status === "rejected", resetsAt } });
      }
      case "command_lifecycle": {
        // Taken into a turn (started), or never to be (cancelled): it begins no turn now.
        const id = m.state === "queued" ? undefined : this.waiting.find((i) => frameUuid(i) === m.command_uuid);
        if (id === undefined) return;
        // With a subagent in the background the CLI never said idle, so it says no running either.
        if (m.state === "started") this.move("running", id);
        this.waiting = this.waiting.filter((i) => i !== id);
        return this.emit({ type: "taken", inputId: id });
      }
      case "result": {
        // No model call, as a /compact's: its usage is all zeros, and /status keeps the last turn's.
        if (m.num_turns !== 0) {
          const u = m.usage ?? {};
          this.usage = { inputTokens: inputTokens(u), outputTokens: u.output_tokens, contextTokens: this.contextTokens };
          this.emit({ type: "usage", ...this.usage });
        }
        // A subagent in the background holds back idle till it ends, though the turn waits for you:
        // the turn ends on its result, unless a queued message runs next (architecture §6.1).
        if (this.subagents && !m.queued_turn_count) this.move("idle", undefined);
        return;
      }
      default:
        return this.note(String(m.type));
    }
  }

  /** turn and steer write the same frame: the CLI queues a message that arrives mid-turn
   *  and runs it before going idle (architecture §6.2). */
  async send(message: AgentMessage, _mode: SendMode): Promise<void> {
    const proc = this.proc;
    await this.ready;
    this.still(proc);
    // Pictures first, then the text, as the API advises; no empty text block beside a picture.
    const images = (message.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }));
    const text = message.text || !images.length ? [{ type: "text", text: message.text }] : [];
    this.sent = message.text === "/compact" && this.sent !== "other" ? "compact" : "other";
    // Counted before it is written: the turn it starts may show before the holder's ack.
    this.waiting.push(message.id);
    try {
      await this.write(message.id, {
        type: "user",
        uuid: frameUuid(message.id),
        parent_tool_use_id: null,
        ...(message.human ? { origin: { kind: "human" } } : {}),
        message: { role: "user", content: [...images, ...text] },
      });
    } catch (e) {
      this.waiting = this.waiting.filter((i) => i !== message.id);
      throw e;
    }
  }

  untaken(ids: string[]): void {
    this.waiting = [...ids];
  }

  async interrupt(): Promise<void> {
    const { answered } = await this.put("interrupt");
    // Without the receipt the CLI may never answer, so then the write is all there is to wait for.
    if (this.info.capabilities.includes("interrupt_receipt_v1")) await answered;
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const ask = this.asks.get(requestId);
    if (!ask) throw new Error(`claude: no pending ask ${requestId}`);
    if (ask.kind !== answer.kind) throw new Error(`claude: ask ${requestId} is a ${ask.kind}, not a ${answer.kind}`);
    const allow = (updatedInput: unknown) => ({ behavior: "allow", updatedInput, decisionClassification: "user_temporary" });
    const deny = (message = "The user said no.") => ({ behavior: "deny", message, decisionClassification: "user_reject" });
    const response =
      answer.kind === "question"
        ? allow({ ...(ask.input as Json), answers: answer.answers })
        : (answer.kind === "permission" ? answer.allow : answer.approve)
          ? allow(ask.input)
          : deny(answer.message);
    // Taken off before the write, so a second answer meanwhile finds nothing; put back if it fails
    // while the same process still waits on it.
    this.asks.delete(requestId);
    const proc = this.proc;
    try {
      await this.write(this.nextId(), { type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    } catch (e) {
      if (this.proc === proc) this.asks.set(requestId, ask);
      throw e;
    }
  }

  /** Approval mode on is the CLI's default permission mode; off skips every permission check. */
  async approval(on: boolean): Promise<void> {
    await this.control("set_permission_mode", { mode: on ? "default" : "bypassPermissions" });
  }

  /** The agent's part of a common command (architecture §6.1). The router does /new itself, and
   *  /stop is interrupt(). /status: the model from the last system/init or switch, the context and
   *  the quota windows. */
  async command(name: CommonCommand, args: string): Promise<CommandResult> {
    const arg = args.trim();
    const proc = this.proc;
    await this.ready;
    this.still(proc);
    switch (name) {
      case "status": {
        // The model by its name, as /model lists it (docs/im-style.md §2.4).
        const using = this.using(await this.models());
        const model = using ? claudeModelName(using) : this.about.model;
        // The context and the quota as /context and /usage have them: neither costs quota (architecture §6.2).
        // Either failing or slow is left out: /status still answers.
        const extra = (p: Promise<CommandResult>) => Promise.race([p.catch(() => null), Bun.sleep(STATUS_EXTRA_WAIT).then(() => null)]);
        const [c, u] = await Promise.all([extra(this.command("context", "")), extra(this.command("usage", ""))]);
        const context = c?.command === "context" ? { usedTokens: c.usedTokens, maxTokens: c.maxTokens } : null;
        return { command: "status", model, context, limits: u?.command === "usage" ? u.limits : [], ...(this.effort !== null && { effort: this.effort }) };
      }
      case "effort": {
        // The levels of the model in use; before the first turn says which, the default's.
        const models = await this.models();
        const now = this.about.model;
        const model = this.using(models) ?? models.find((m) => m.value === "default");
        // ultracode only when the running process says it can turn it on: not on a model without
        // xhigh, nor with workflows turned off, nor on a CLI without get_settings.
        const choices = this.levels(model);
        if (!arg) return { command: "effort", level: this.effort ?? "-", choices: await this.marked(choices) };
        if (!choices.length) throw new Error(`模型 ${now ?? "-"} 不能调思考强度`);
        const level = pick(choices, arg, "思考强度").id;
        await this.setLevel(level);
        return { command: "effort", level };
      }
      case "ultracode": {
        // Only where the running process says it can be on: not on a model without xhigh, nor with
        // workflows turned off, nor on a CLI without get_settings.
        const settings = (await this.control("get_settings").catch(unknownAsEmpty)).applied ?? {};
        const on = settings.ultracodeRequested === true;
        if (settings.ultracodeAvailable !== true) return { command: "ultracode", on, unavailable: true };
        const choices: Choice[] = [
          { id: "on", label: "开", ...(on && { current: true as const }) },
          { id: "off", label: "关", ...(!on && { current: true as const }) },
        ];
        if (!arg) return { command: "ultracode", on, choices };
        const set = pick(choices, arg, "选项").id === "on";
        await this.control("apply_flag_settings", { settings: { ultracode: set } });
        return { command: "ultracode", on: set };
      }
      case "usage": {
        // skip_behaviors: no scan of your transcripts for usage habits, which Rhodium has no use for.
        // get_usage is experimental: a CLI without it reads as no quota and no use, as nothing to show.
        const r = await this.control("get_usage", { skip_behaviors: true }).catch(unknownAsEmpty);
        // rate_limits is null where plan limits do not apply, such as an API key login.
        const rl = r.rate_limits ?? {};
        const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
        const limits: QuotaWindow[] = Array.isArray(rl.limits)
          ? (rl.limits as Json[]).flatMap((l) => {
              const window = WINDOW[l.group];
              if (!window) {
                console.warn(`claude driver (${this.conv}): skipping quota window ${l.group}`);
                return [];
              }
              if (typeof l.percent !== "number") return [];
              const model = l.scope?.model?.display_name;
              return [{ window, ...(model && { model }), usedPercent: l.percent, resetsAt: at(l.resets_at) }];
            })
          : // An older CLI has no list: its five hours and seven days.
            (["5h", "7d"] as const).flatMap((window) => {
              const w = rl[window === "5h" ? "five_hour" : "seven_day"];
              return typeof w?.utilization === "number" ? [{ window, usedPercent: w.utilization, resetsAt: at(w.resets_at) }] : [];
            });
        const x = rl.extra_usage;
        // Credits in minor units, cents for USD.
        const unit = (v: number) => v / 10 ** (x.decimal_places ?? 2);
        const extra: ExtraUsage | undefined = x?.is_enabled && typeof x.used_credits === "number"
          ? { usedPercent: x.utilization ?? (x.monthly_limit ? (x.used_credits * 100) / x.monthly_limit : 0), used: unit(x.used_credits), limit: x.monthly_limit ? unit(x.monthly_limit) : null, currency: (x.currency ?? "USD").toUpperCase() }
          : undefined;
        const s = r.session;
        const tokensOf = (u: Json): Tokens => {
          const t = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 };
          return { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite };
        };
        const models = Object.entries((s?.model_usage ?? {}) as Record<string, Json>).map(([id, u]) => ({ name: modelName(id), cost: u.costUSD ?? 0, tokens: tokensOf(u) }));
        const sum = (k: keyof Tokens) => models.reduce((n, m) => n + m.tokens[k], 0);
        const session: SessionUse | undefined = s && {
          cost: s.total_cost_usd ?? 0,
          tokens: { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), total: sum("total") },
          models,
        };
        return { command: "usage", limits, ...(extra && { extra }), ...(session && { session }) };
      }
      case "context": {
        // summary: from the last answer's usage, without a token count call per category.
        const r = await this.control("get_context_usage", { detail: "summary" });
        // What holds the window: not the deferred tools nor the free space.
        const categories = ((r.categories ?? []) as Json[])
          .filter((c) => (c.kind === "used" || c.kind === "buffer") && c.tokens > 0)
          .map((c) => ({ name: CATEGORY[c.id] ?? c.name, tokens: c.tokens }));
        return { command: "context", usedTokens: r.totalTokens, maxTokens: r.maxTokens ?? null, ...(categories.length && { categories }) };
      }
      case "compact": {
        // No control request does it: /compact goes as text, and runs as a turn of its own. Only
        // between turns, as on pi; mid-turn the CLI would queue it behind the turn.
        if (this.state !== "idle") throw new Error("回合还在进行，先 /stop 再 /compact");
        if (this.pending.has(COMPACT)) throw new Error("已经在压缩了");
        const done = new Promise<Json>((resolve, reject) => this.pending.set(COMPACT, { resolve, reject }));
        done.catch(() => {}); // a process change may reject it while the write fails
        try {
          await this.send({ id: this.nextId(), text: "/compact", human: true }, "turn");
        } catch (e) {
          this.pending.delete(COMPACT);
          throw e;
        }
        const m = (await done).compact_metadata ?? {};
        return { command: "compact", beforeTokens: m.pre_tokens ?? null, afterTokens: m.post_tokens ?? null };
      }
      case "model": {
        // /model <model> <level> sets the level too: the second step of /model's panel (docs/im-style.md §9.5).
        const models = await this.models();
        const now = this.about.model;
        const using = this.using(models);
        const choices = models.map((m) => ({ id: String(m.value), label: claudeModelName(m), ...(m === using && { current: true as const }) }));
        const level = this.effort === null ? {} : { level: this.effort };
        const [name, wanted] = arg.split(/\s+/).filter(Boolean);
        if (!name) return { command: "model", model: now, choices, ...level };
        const { id, label } = pick(choices, name, "模型");
        const model = models.find((m) => m.value === id);
        const efforts = this.levels(model);
        if (wanted !== undefined && !efforts.length) throw new Error(`模型 ${label} 不能调思考强度`);
        const set = wanted === undefined ? undefined : pick(efforts, wanted, "思考强度").id;
        await this.control("set_model", { model: id });
        // The next system/init says so too; /status has it till then.
        this.about.model = model?.resolvedModel ?? id;
        this.picked = id;
        const switched = { command: "model" as const, model: id === "default" ? null : id, label };
        if (set === undefined) return { ...switched, efforts: await this.marked(efforts), ...level };
        const was = this.effort ?? "-";
        await this.setLevel(set);
        return { ...switched, level: set, was };
      }
    }
    throw new Error(`claude: /${name} is not the driver's`);
  }

  /** The model in use as /model lists it: the one /model picked, if it still resolves to it, before
   *  another that does, as default and opus both resolve to claude-opus-5-5. Before a turn's init
   *  names it, the one the process was launched with or switched to, by its value or what it resolves to. */
  private using(models: Json[]): Json | undefined {
    const now = this.about.model ?? this.picked;
    const fits = models.filter((m) => now !== null && (m.value === now || m.resolvedModel === now));
    return fits.find((m) => m.value === this.picked) ?? fits[0];
  }

  /** The thinking levels the model takes, the one set marked. */
  private levels(model: Json | undefined): Choice[] {
    const ids: string[] = model?.supportedEffortLevels ?? [];
    return ids.map((l) => ({ id: l, label: l, ...(l === this.effort && { current: true as const }) }));
  }

  /** The levels, the one in use marked where this process set none, as on a slot that never set one: the
   *  one Claude applies, get_settings' undocumented applied.effort; none where it does not say (architecture §6.2). */
  private async marked(choices: Choice[]): Promise<Choice[]> {
    if (this.effort !== null || !choices.length) return choices;
    const now = (await this.control("get_settings").catch(unknownAsEmpty)).applied?.effort;
    return choices.map((c) => (c.id === now ? { ...c, current: true as const } : c));
  }

  /** Sets the level with apply_flag_settings, ultracode left as get_settings has it: effortLevel alone
   *  would turn it off (architecture §6.2). */
  private async setLevel(level: string): Promise<void> {
    const settings = await this.control("get_settings").catch(unknownAsEmpty);
    await this.control("apply_flag_settings", { settings: { effortLevel: level, ultracode: settings.applied?.ultracodeRequested === true } });
    this.effort = level;
  }

  /** The handshake's models: a command that comes before its answer waits for it. */
  private async models(): Promise<Json[]> {
    return (await this.hello).response?.models ?? [];
  }

  /**
   * Stdin first, giving the CLI stopGrace to finish its transcript (idle, it exits within a
   * second); then TERM, then KILL, stopGrace apart. Only for an idle process with no background
   * task: closing stdin mid-turn cuts the turn short, and with a task alive the CLI waits for it.
   */
  async close(): Promise<void> {
    if (this.state !== "idle" || this.tasks.length > 0)
      throw new Error(`claude: not closing while ${this.state === "idle" ? "a background task runs" : "a turn runs"}`);
    if (!this.link) throw new Error("claude: no agent process attached");
    await closeLink(this.link, this.stopGrace);
  }

  /**
   * Sends a control request (set_model, get_usage...) and resolves with the CLI's answer;
   * rejects with the CLI's error. `then` sees the whole response object, in line order.
   */
  async control(subtype: string, fields: Json = {}, then?: (response: Json) => void): Promise<Json> {
    const { answered } = await this.put(subtype, fields, then);
    return (await answered).response ?? {};
  }

  // ---- control requests ----

  /** Writes a control request. Resolves once it is written, with the CLI's answer still to come. */
  private async put(subtype: string, fields: Json = {}, then?: (response: Json) => void): Promise<{ answered: Promise<Json> }> {
    const id = this.nextId();
    const answered = new Promise<Json>((resolve, reject) => this.pending.set(id, { resolve, reject, then }));
    // A process change rejects it, maybe mid-write or with no one waiting (initialize, interrupt).
    answered.catch(() => {});
    try {
      await this.write(id, { type: "control_request", request_id: id, request: { subtype, ...fields } });
    } catch (e) {
      this.pending.delete(id); // never written, so never answered
      throw e;
    }
    return { answered };
  }

  /** Fails if another process attached since proc, while the caller waited: what it waited to write
   *  was meant for the one that is gone, and the next must not get it (architecture §4.6). */
  private still(proc: number): void {
    if (this.proc !== proc) throw new Error("claude: the agent process was replaced");
  }

  /** Request ids carry the boot number, so a reply meant for an earlier boot matches nothing. */
  private nextId() {
    return `rh-${this.boot}-${++this.seq}`;
  }

  private response(r: Json) {
    const p = this.pending.get(r.request_id);
    if (!p) return;
    this.pending.delete(r.request_id);
    if (r.subtype === "error") return p.reject(new Error(String(r.error)));
    p.then?.(r);
    p.resolve(r);
  }

  /** A control request from the CLI. Only can_use_tool is ours to answer; anything else gets an
   *  error, or the CLI would wait for the answer forever. A replayed one got its error already. */
  private request(m: Json, replay: boolean) {
    const ask = askOf(m);
    if (ask) {
      this.asks.set(ask.requestId, ask);
      return this.emit({ type: "ask", ...ask });
    }
    const subtype = String(m.request?.subtype);
    this.note(`control_request/${subtype}`);
    if (replay) return;
    const error = `Unsupported control request subtype: ${subtype}`;
    this.write(this.nextId(), { type: "control_response", response: { subtype: "error", request_id: String(m.request_id), error } }).catch(
      () => {},
    );
  }

  private initialized(r: Json) {
    const res = r.response ?? {};
    this.about.selfStarted = this.started;
    this.about.version = res.claude_code_version ?? null;
    if (typeof res.claude_code_version === "string") this.onVersion?.(res.claude_code_version);
    if (Array.isArray(res.models)) this.onModels?.(res.models);
    this.about.capabilities = [...new Set([...this.about.capabilities, ...(res.capabilities ?? [])])];
    this.emit({
      type: "commands",
      commands: (res.commands ?? []).map((c: Json) => ({ name: String(c.name), description: String(c.description ?? "") })),
    });
    // Asks the CLI still waits on; missing before 2.1.268, when nothing tells which are still open.
    const list = r.pending_permission_requests;
    const asks = Array.isArray(list) ? list.map(askOf).filter((a): a is AgentAsk => a !== null) : null;
    // Any other ask is no longer waited on; answering it would write a reply that matches nothing.
    this.asks = new Map((asks ?? []).map((a) => [a.requestId, a]));
    this.emit({ type: "pending_asks", asks });
  }

  // ---- output ----

  private system(m: Json) {
    switch (m.subtype) {
      case "init":
        // Each turn begins with one. Past a turn that ended on its result, the next one the CLI
        // begins by itself, as a subagent's end wakes it, says so only here.
        if (this.state === "idle") this.move("running", undefined);
        this.about.model = m.model ?? null;
        this.about.session = typeof m.session_id === "string" ? m.session_id : null;
        this.about.capabilities = [...new Set([...this.about.capabilities, ...(m.capabilities ?? [])])];
        return;
      case "background_tasks_changed":
        this.tasks = (m.tasks ?? []).map((t: Json) => ({ id: String(t.task_id), description: String(t.description ?? "") }));
        this.subagents = (m.tasks ?? []).some((t: Json) => t.task_type !== "local_bash");
        return this.emit({ type: "background", tasks: this.tasks });
      case "compact_boundary": {
        const after = m.compact_metadata?.post_tokens;
        if (typeof after === "number") {
          this.contextTokens = after;
          if (this.usage) this.usage = { ...this.usage, contextTokens: after };
        }
        return this.response({ ...m, request_id: COMPACT });
      }
      case "status":
        if (m.compact_result === "failed") this.response({ request_id: COMPACT, subtype: "error", error: `Claude 没有压缩：${m.compact_error ?? "原因不明"}` });
        return;
      case "session_state_changed": {
        const state = SESSION_STATE[m.state as keyof typeof SESSION_STATE];
        if (state) this.move(state, this.waiting[0]);
        return;
      }
      default:
        return this.note(`system/${m.subtype}`);
    }
  }

  /** Moves the turn to state. A turn begins on running from idle, input the one that began it, and
   *  ends on idle: the CLI's, or a result's while a subagent runs in the background (architecture §6.1).
   *  The CLI's idle after that is no news. */
  private move(state: "idle" | "running" | "waiting", input: string | undefined) {
    const was = this.state;
    if (state === was) return;
    this.state = state;
    if (state === "running" && was === "idle") {
      this.reply = undefined;
      this.started = true;
      this.emit({ type: "turn_start", ...(input !== undefined && { input }) });
    }
    this.emit({ type: "state", state });
    if (state !== "idle") return;
    // A /compact whose turn ended with no boundary did not compact.
    this.response({ request_id: COMPACT, subtype: "error", error: "Claude 没有压缩上下文" });
    const compactOnly = this.sent === "compact";
    this.sent = "nothing";
    this.emit({
      type: "turn_end",
      ...(this.reply !== undefined && { reply: this.reply }),
      ...(this.tasks.length > 0 && { background: true as const }),
      ...(compactOnly && { compactOnly: true as const }),
    });
  }

  private note(kind: string) {
    if (IGNORED.has(kind)) return;
    const n = this.unknown.get(kind) ?? 0;
    this.unknown.set(kind, n + 1);
    if (n === 0) console.warn(`claude driver (${this.conv}): skipping unknown ${kind}`);
  }

  private assistant(m: Json) {
    if (m.parent_tool_use_id != null) return;
    const u = m.message?.usage;
    if (u) this.contextTokens = inputTokens(u);
    const content: Json[] = m.message?.content ?? [];
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) {
      this.reply = text;
      this.emit({ type: "item", item: { kind: "message", text } });
    }
    // What it said comes before the tool calls it makes.
    for (const b of content.filter((b) => b.type === "tool_use")) {
      this.tools.set(b.id, { id: b.id, name: b.name, input: b.input });
      this.emit({ type: "tool_start", id: b.id, name: b.name, input: b.input });
    }
  }

  private user(m: Json) {
    if (m.parent_tool_use_id != null || !Array.isArray(m.message?.content)) return;
    for (const b of m.message.content) {
      const tool = b.type === "tool_result" && this.tools.get(b.tool_use_id);
      if (!tool) continue;
      this.tools.delete(b.tool_use_id);
      this.emit({ type: "item", item: { kind: "tool", ...tool } });
    }
  }

  private emit(e: Event) {
    this.out({ ...e, conv: this.conv, proc: this.proc } as AgentEvent);
  }

  private async write(id: string, frame: Json) {
    const bad = flaw(frame);
    if (bad) {
      this.emit({ type: "protocol_error", reason: "unexpected", detail: `not written: ${bad}` });
      throw new Error(`claude: refusing to write a malformed frame: ${bad}`);
    }
    if (!this.link) throw new Error("claude: no agent process attached");
    await this.link.write(id, JSON.stringify(frame));
  }
}
