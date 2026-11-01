// Ready-made scripts in the shape of `claude -p --output-format stream-json`,
// picked by name in the fake agent's config. Shapes follow the 2.1.304 recordings.
import type { Script, Step } from "./fake-agent.ts";

const VERSION = "2.1.304";
const j = JSON.stringify;
const ids = { uuid: "{{uuid}}", session_id: "{{session_id}}" };
const system = (subtype: string, fields: object = {}) => j({ type: "system", subtype, ...fields, ...ids });
export const state = (s: "running" | "idle" | "requires_action") => system("session_state_changed", { state: s });
const init = system("init", {
  cwd: "{{cwd}}",
  model: "claude-fake",
  tools: [],
  mcp_servers: [],
  slash_commands: [],
  permissionMode: "default",
  claude_code_version: VERSION,
});
// Content comes before the template fields, so byte offsets inside it are the same after `fill`.
const assistant = (content: object, fields: object = {}) =>
  j({
    type: "assistant",
    message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-fake", content: [content] },
    parent_tool_use_id: null,
    ...fields,
    ...ids,
  });
const text = (t: string) => assistant({ type: "text", text: t });
const result = (t: string, fields: object = {}) =>
  j({ type: "result", subtype: "success", is_error: false, result: t, stop_reason: "end_turn", num_turns: 1, total_cost_usd: 0, ...fields, ...ids });

/** An ask: [request id, tool name, tool input]. */
export type FakeAsk = [id: string, tool: string, input: object];
const canUseTool = ([id, tool, input]: FakeAsk) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: tool,
    display_name: tool,
    input,
    tool_use_id: `toolu_${id}`,
    ...((tool === "AskUserQuestion" || tool === "ExitPlanMode") && { requires_user_interaction: true }),
  },
});

/** The models the handshake offers: the default, which init reports as in use, and one more. */
const MODELS = [
  { value: "default", resolvedModel: "claude-fake", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-fake-haiku", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
];

/** The answer to `initialize`, naming the asks still waiting for an answer, then the background
 *  tasks running: none. Claude says so after a re-sent one (fixture reinitialize-pending-approval);
 *  the fake after each. */
const handshake = (open: FakeAsk[], models = MODELS) => [
  j({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "{{in.request_id}}",
      response: { commands: [], models, account: {}, claude_code_version: VERSION },
      pending_permission_requests: open.map(canUseTool),
      pending_user_dialog_requests: [],
    },
  }),
  system("background_tasks_changed", { tasks: [] }),
];
const initialize = { type: "control_request", request: { subtype: "initialize" } };

const answer = (response: object) => [j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response } })];
const control = (subtype: string) => ({ type: "control_request", request: { subtype } });

/** What get_usage answers: 12% of the five hours, 52% of the seven days and 38% of Fable's used,
 *  resetting at 05:00 on 10/21 and 21:00 on 10/24 UTC; a conversation of $15.35 and 18.9M tokens. */
export const USAGE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: "session", group: "session", percent: 12, resets_at: "2026-10-21T05:00:00+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 52, resets_at: "2026-10-24T21:00:00+00:00", scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 38, resets_at: "2026-10-24T21:00:00+00:00", scope: { model: { id: null, display_name: "Fable" } } },
    ],
    extra_usage: { is_enabled: false },
  },
  session: {
    total_cost_usd: 15.35,
    model_usage: {
      "claude-opus-5-5": { inputTokens: 1_800, outputTokens: 96_000, cacheReadInputTokens: 18_200_000, cacheCreationInputTokens: 612_000, costUSD: 14.92 },
      "claude-haiku-4-5-20251001": { inputTokens: 0, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.43 },
    },
  },
  behaviors: null,
};

/** Answers `initialize` and every other control request, whenever they come: get_usage with USAGE,
 *  get_context_usage with 52,000 of 200,000 tokens. */
export const on: Script["on"] = [
  { match: initialize, emit: handshake([]) },
  { match: control("get_usage"), emit: answer(USAGE) },
  { match: control("get_context_usage"), emit: answer({ totalTokens: 52_000, maxTokens: 200_000, percentage: 26 }) },
  { match: { type: "control_request" }, emit: answer({}) },
];

// Transcript lines in the shape Claude writes to ~/.claude/projects/.
const said = (role: string, content: unknown, uuid: string, parentUuid: string | null) =>
  j({ type: role, uuid, parentUuid, sessionId: "{{session_id}}", cwd: "{{cwd}}", timestamp: "{{now}}", version: VERSION, message: { role, content } });

/** What Claude says of the user frame it just read (command_lifecycle, in every recording): queued,
 *  then started once a turn takes it in. */
export const lifecycle = (s: "queued" | "started") => j({ type: "command_lifecycle", command_uuid: "{{in.uuid}}", state: s, ...ids });

/** Takes the next user message and starts its turn. */
export const startTurn: Step[] = [
  { wait: { type: "user" } },
  { transcript: [said("user", "{{in.message.content}}", "{{in.uuid}}", null)] },
  { emit: [state("running"), lifecycle("queued"), lifecycle("started"), init] },
];
/** Ends the turn with reply as its last assistant message. */
export const endTurn = (reply: string, fields: object = {}): Step[] => [
  { emit: [assistant({ type: "text", text: reply }, fields)] },
  { transcript: [said("assistant", [{ type: "text", text: reply }], "{{uuid}}", "{{in.uuid}}")] },
  { emit: [result(reply, "error" in fields ? { is_error: true } : {}), state("idle")] },
];

/** Claude starts a turn by itself, with no message: say the interrupted one again, resumed (probe 9). */
export const selfStart: Step = { emit: [state("running"), init] };
/** Takes a message sent mid-turn, which joins the turn: Claude answers each message with a result
 *  of its own, so the one before it gets its result first (the mid-turn-message recording). */
export const joinTurn: Step[] = [{ wait: { type: "user" } }, { emit: [lifecycle("queued"), result(""), lifecycle("started")] }];
/** Takes a message sent while the turn is between tool calls: Claude takes it into that turn, with
 *  no result of its own (Claude 2.1.306, a live dispatcher's out.log on 2026-10-22). */
export const joinBetweenTools: Step[] = [{ wait: { type: "user" } }, { emit: [lifecycle("queued"), lifecycle("started")] }];
/** Takes a message sent while a tool runs into Claude's own queue only: it joins the turn at the
 *  next tool boundary (takeQueued), and is gone if Claude dies before then. */
export const queueMidTurn: Step[] = [{ wait: { type: "user" } }, { emit: [lifecycle("queued")] }];
/** Claude takes the message queueMidTurn queued into the turn. */
export const takeQueued: Step = { emit: [lifecycle("started")] };

/** Takes the /compact and compacts, as in the cmd-compact recording, from 80,000 tokens to 12,000.
 *  then: the rest of the turn, such as a message sent meanwhile; by default the turn just ends. */
export const compaction = (then: Step[] = [{ emit: [state("idle")] }]): Step[] => [
  { wait: { type: "user" } },
  {
    emit: [
      state("running"),
      lifecycle("queued"),
      lifecycle("started"),
      system("status", { status: "compacting" }),
      system("status", { status: null, compact_result: "success" }),
      init,
      system("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 80_000, post_tokens: 12_000 } }),
      result("", { num_turns: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }),
    ],
  },
  ...then,
];

/** A tool call the agent makes, its result not back yet. */
export const toolUse = (id: string, name: string, input: object): { emit: string[] } => ({ emit: [assistant({ type: "tool_use", id, name, input })] });
/** The result of tool call id comes back. */
export const toolResult = (id: string): { emit: string[] } => ({
  emit: [j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, parent_tool_use_id: null, ...ids })],
});
/** A tool call whose result came back. */
export const toolCall = (id: string, name: string, input: object): Step => ({ emit: [...toolUse(id, name, input).emit, ...toolResult(id).emit] });
export const textDelta = (text: string) =>
  j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, ...ids });
/** One whole assistant message, mid-turn. */
export const saying = (t: string): Step => ({ emit: [text(t)] });
/** progress: nine 100-character pieces, told apart by their digit. */
export const PROGRESS_PIECES = Array.from({ length: 9 }, (_, i) => String(i).repeat(99) + "\n");

/** Reads a file and runs a command, then streams a 900-character reply in PROGRESS_PIECES,
 *  pausing ms before each tool call and piece. */
const progress = (ms: number): Script => ({
  on,
  steps: [
    ...startTurn,
    ...[
      toolCall("toolu_read", "Read", { file_path: "notes.txt" }),
      toolCall("toolu_bash", "Bash", { command: "ls" }),
      ...PROGRESS_PIECES.map((p): Step => ({ emit: [textDelta(p)] })),
    ].flatMap((s): Step[] => (ms ? [{ sleep: ms }, s] : [s])),
    ...endTurn(PROGRESS_PIECES.join("")),
    { goto: 0 },
  ],
});

const ASK = "fake-ask-1";
const task = { task_id: "fake-task-1", task_type: "local_bash", description: "fake background task" };
const split = text("汉字被切开");

/** A turn whose final reply is `line`, written 300 ms after the message came; `splitAt` as in Step. */
const replyWith = (line: string, splitAt?: number): Step[] => [
  { wait: { type: "user" } },
  { transcript: [said("user", "{{in.message.content}}", "{{in.uuid}}", null)] },
  { sleep: 300 },
  { emit: [state("running"), lifecycle("queued"), lifecycle("started"), init] },
  { emit: [line], splitAt },
  { emit: [result("done"), state("idle")] },
];
const halfHan = Buffer.from(split).indexOf(Buffer.from("汉")) + 1;

/** Every turn ends with Claude's rate limit refusal, or with `once` only the first, the turns after
 *  it going through; `resetsAt` is in epoch seconds. With `wake`, ms after the refusal Claude starts
 *  a turn by itself, as when a background task ends, and replies "woke". A refused turn takes the
 *  steps `first` before its refusal. */
export const rateLimited = (resetsAt: number, once = false, wake?: number, first: Step[] = []): Script => {
  const head: Step[] = [
    ...startTurn,
    ...first,
    {
      emit: [
        j({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", isUsingOverage: false }, ...ids }),
      ],
    },
    ...endTurn("You've hit your limit", { error: "rate_limit" }),
    ...(wake === undefined ? [] : [{ sleep: wake }, { emit: [state("running"), init] }, ...endTurn("woke")]),
  ];
  return { on, steps: [...head, ...(once ? [...startTurn, ...endTurn("fake reply")] : []), { goto: once ? head.length : 0 }] };
};

/**
 * Dies in the middle of each turn. Resumed with CLAUDE_CODE_RESUME_INTERRUPTED_TURN, it runs the
 * interrupted turn again by itself, as Claude does (probe 9): to the end with `resumed` as its reply,
 * then plain turns; or, with `resumed` null, to another crash.
 */
export const crashing = (resumed: string | null): Script => {
  const crash: Step[] = [{ emit: [text("working")] }, { sleep: 100 }, { exit: 1 }];
  const auto = 1 + startTurn.length + crash.length;
  const after: Step[] = resumed === null ? crash : [...endTurn(resumed), ...startTurn, ...endTurn("fake reply"), { goto: auto + 1 + endTurn("").length }];
  return { on, steps: [{ goto: auto, env: "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" }, ...startTurn, ...crash, { emit: [state("running"), init] }, ...after] };
};

/** The turn starts a background task, which runs ms after the turn ends; when it finishes it wakes
 *  the session for one more turn. */
export const background = (ms: number): Script => ({
  on,
  steps: [
    ...startTurn,
    {
      emit: [
        assistant({ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 1", run_in_background: true } }),
        system("background_tasks_changed", { tasks: [task] }),
        system("task_started", { ...task, tool_use_id: "toolu_bg", is_backgrounded: true }),
      ],
    },
    ...endTurn("started"),
    { sleep: ms },
    {
      emit: [
        system("task_notification", { task_id: task.task_id, tool_use_id: "toolu_bg", status: "completed", summary: "fake background task completed" }),
        system("background_tasks_changed", { tasks: [] }),
        state("running"),
        init,
      ],
    },
    ...endTurn("background task done"),
    { goto: 0 },
  ],
});

const answered = ([id]: FakeAsk): Step => ({ wait: { type: "control_response", response: { request_id: id } } });
/** Makes the ask and waits for its answer. */
export const askOnce = (a: FakeAsk): Step[] => [{ emit: [j(canUseTool(a)), state("requires_action")] }, answered(a), { emit: [state("running")] }];
/** A tool call that waits for your answer first, in Claude's order: the call, its ask, and once
 *  that is answered, its result. */
export const askingCall = (a: FakeAsk): Step[] => [toolUse(`toolu_${a[0]}`, a[1], a[2]), ...askOnce(a), toolResult(`toolu_${a[0]}`)];
/** Makes the ask, and after ms withdraws it itself, answered by no one. */
export const askWithdrawn = (a: FakeAsk, ms: number): Step[] => [
  { emit: [j(canUseTool(a)), state("requires_action")] },
  { sleep: ms },
  { emit: [j({ type: "control_cancel_request", request_id: a[0] }), state("running")] },
];

/**
 * Per message, a turn that makes the asks, all at once or each once the one before is answered,
 * then replies "answered". `delay`: ms to wait before the first ask. `handshake`: once the asks are
 * made, the next `initialize`, as a restarted rhodium sends, is answered naming them all.
 */
export const asking = (asks: FakeAsk[], o: { together?: boolean; delay?: number; handshake?: true } = {}): Script => ({
  on,
  steps: [
    ...startTurn,
    ...(o.delay ? [{ sleep: o.delay }] : []),
    ...(o.together || o.handshake
      ? [
          { emit: [...asks.map((a) => j(canUseTool(a))), state("requires_action")] },
          ...(o.handshake ? [{ wait: initialize }, { emit: handshake(asks) }] : []),
          ...asks.map(answered),
        ]
      : asks.flatMap(askOnce)),
    { emit: [state("running")] },
    ...endTurn("answered"),
    { goto: 0 },
  ],
});

// ---- pi-shaped: `pi --mode rpc` records, shapes from the pi 1.3.0 recordings in test/fixtures/pi. ----

/** The fake models' names, which pi shows where the id is for commands. */
const PI_NAMES: Record<string, string> = { "pi-fake": "Pi Fake", "pi-other": "Pi Other" };
const piResponse = (command: string, data?: object) => j({ id: "{{in.id}}", type: "response", command, success: true, ...(data && { data }) });
const piModel = (id: string) => ({
  id, name: PI_NAMES[id], api: "openai-completions", provider: "fake", baseUrl: "http://fake", reasoning: true, input: ["text", "image"],
  contextWindow: 100_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
/** One model call's usage: 120 tokens in, 20 of them from the cache, and 7 out. */
const piUsage = { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: 127, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Answers pi's other commands, whenever they come. The state is fixed: set_model and
 *  set_thinking_level change nothing that get_state reports. */
export const piOn: Script["on"] = [
  {
    match: { type: "get_state" },
    emit: [piResponse("get_state", { model: piModel("pi-fake"), thinkingLevel: "medium", isStreaming: false, isCompacting: false, sessionId: "{{session_id}}", messageCount: 0, pendingMessageCount: 0 })],
  },
  { match: { type: "get_available_models" }, emit: [piResponse("get_available_models", { models: [piModel("pi-fake"), piModel("pi-other")] })] },
  { match: { type: "set_model" }, emit: [piResponse("set_model", piModel("pi-other"))] },
  { match: { type: "get_available_thinking_levels" }, emit: [piResponse("get_available_thinking_levels", { levels: ["off", "low", "medium", "high"] })] },
  { match: { type: "set_thinking_level" }, emit: [piResponse("set_thinking_level")] },
  {
    match: { type: "get_session_stats" },
    emit: [piResponse("get_session_stats", { sessionId: "{{session_id}}", tokens: { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, total: 127 }, cost: 0, contextUsage: { tokens: 127, contextWindow: 100_000, percent: 0.127 } })],
  },
  { match: { type: "compact" }, emit: [piResponse("compact", { summary: "fake summary", firstKeptEntryId: "e1", tokensBefore: 127, estimatedTokensAfter: 30 })] },
  // With nothing running, abort is answered at once.
  { match: { type: "abort" }, emit: [piResponse("abort")] },
  // Mid-run, a steering message is queued into the run.
  { match: { type: "prompt", streamingBehavior: "steer" }, emit: [piResponse("prompt", { disposition: "queued" })] },
];

// Session file entries in the shape pi writes them (architecture §6.3).
const piEntry = (role: string, content: unknown) =>
  j({ type: "message", id: "{{uuid}}", parentId: null, timestamp: "{{now}}", message: { role, content, timestamp: 0 } });
const piAssistant = (content: object[], stopReason = "stop") => ({
  role: "assistant", content, api: "openai-completions", provider: "fake", model: "pi-fake", usage: piUsage, stopReason, timestamp: 0,
});

/** The prompt just taken joins the conversation, as each does in the recordings. */
const piUserStart = j({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "{{in.message}}" }] } });
export const piStart: Step[] = [
  { wait: { type: "prompt" } },
  { transcript: [piEntry("user", [{ type: "text", text: "{{in.message}}" }])] },
  { emit: [piResponse("prompt", { disposition: "started" }), j({ type: "agent_start" }), j({ type: "turn_start" }), piUserStart] },
];
export const piEnd = (reply: string): Step[] => [
  {
    emit: [
      j({ type: "message_update", usage: piUsage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } }),
      j({ type: "message_end", message: piAssistant([{ type: "text", text: reply }]) }),
      j({ type: "turn_end", message: piAssistant([{ type: "text", text: reply }]), toolResults: [] }),
      j({ type: "agent_end", messages: [], willRetry: false }),
    ],
  },
  { transcript: [piEntry("assistant", [{ type: "text", text: reply }])] },
  { emit: [j({ type: "agent_settled", aborted: false })] },
];

/** pi: a steering message comes while the run's tool runs, and pi queues it; with `taken`, the tool
 *  ends and the message joins the conversation. Then pi is killed. */
export const piKilledWithSteer = (taken: boolean): Script => ({
  on: piOn,
  steps: [
    ...piStart,
    { emit: [j({ type: "tool_execution_start", toolCallId: "call_sleep", toolName: "bash", args: { command: "sleep 60" } })] },
    { wait: { type: "prompt", streamingBehavior: "steer" } },
    { emit: [piResponse("prompt", { disposition: "queued" })] },
    ...(taken ? [{ emit: [j({ type: "tool_execution_end", toolCallId: "call_sleep", toolName: "bash", result: {}, isError: false }), piUserStart] }] : []),
    { sleep: 100 },
    { kill: "SIGKILL" },
  ],
});

/** pi: one run to its end; the next prompt it reads and does nothing with, as a pi that hangs. Then
 *  it is killed. Started again, it runs a prompt to its end the same way. */
export const piKilledUntaken: Script = {
  on: piOn,
  steps: [...piStart, ...piEnd("fake reply"), { wait: { type: "prompt" } }, { sleep: 100 }, { kill: "SIGKILL" }],
};

// ---- Codex-shaped: `codex app-server` JSON-RPC, shapes from the codex-cli 0.162.1 recordings in test/fixtures/codex. ----

const cxNote = (method: string, params: object) => j({ method, params });
const cxResult = (result: object) => j({ id: "{{in.id}}", result });
const cxError = (message: string) => j({ error: { code: -32600, message }, id: "{{in.id}}" });
// The thread opened with the approval setting it was asked for.
const cxOpened = { thread: { id: "{{state.thread}}", cwd: "{{cwd}}", status: { type: "idle" }, source: "vscode" }, model: "gpt-6.1-sol", reasoningEffort: "medium", cwd: "{{cwd}}", approvalPolicy: "{{in.params.approvalPolicy}}", sandbox: { type: "dangerFullAccess" } };
/** Two of model/list's models (handshake): Codex's default with all six levels, and one without ultra. */
const cxLevels = (n: number) => ["low", "medium", "high", "xhigh", "max", "ultra"].slice(0, n).map((reasoningEffort) => ({ reasoningEffort, description: "" }));
const cxModels = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, isDefault: true, supportedReasoningEfforts: cxLevels(6), defaultReasoningEffort: "low" },
  { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false, supportedReasoningEfforts: cxLevels(5), defaultReasoningEffort: "medium" },
];
/** account/rateLimits/read's answer (handshake): a 7-day window, 91% used here, and credits. */
const cxQuota = {
  limitId: "codex",
  normalModelSlug: null,
  primary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1767571200 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "58572.7492495000" },
  planType: "pro",
};
const cxTurn = (status: string) => ({ id: "{{state.turn}}", items: [], status, error: null });
const cxIds = { threadId: "{{state.thread}}", turnId: "{{state.turn}}" };
/** One model request's tokens. */
const cxUsage = { totalTokens: 127, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 0 };
/** The record's lines in the shape Codex writes them (architecture §6.4). */
const cxRecord = (item: object) => j({ timestamp: "{{now}}", type: "event_msg", payload: { type: "item_completed", thread_id: "{{state.thread}}", turn_id: "{{state.turn}}", item } });

/** The handshake and the thread, whenever they come: a new thread's id is made up, a resumed one's kept. */
export const codexOn: Script["on"] = [
  { match: { method: "initialize" }, emit: [cxResult({ userAgent: "rhodium/0.162.1 (fake)", codexHome: "/fake/.codex", platformFamily: "unix", platformOs: "linux" })] },
  { match: { method: "thread/start" }, set: { thread: "{{uuid}}" }, emit: [cxResult(cxOpened)] },
  { match: { method: "thread/resume" }, set: { thread: "{{in.params.threadId}}" }, emit: [cxResult(cxOpened)] },
  // With no turn running, there is nothing to stop.
  { match: { method: "turn/interrupt" }, emit: [cxError("no active turn to interrupt")] },
  // What rh doctor asks (architecture §12): a ChatGPT login.
  { match: { method: "account/read" }, emit: [cxResult({ account: { type: "chatgpt", email: "user@example.com", planType: "pro" }, requiresOpenaiAuth: true })] },
  { match: { method: "model/list" }, emit: [cxResult({ data: cxModels, nextCursor: null })] },
  { match: { method: "account/rateLimits/read" }, emit: [cxResult({ rateLimits: cxQuota, rateLimitsByLimitId: { codex: cxQuota } })] },
];

/** Your message joins the conversation, under the id it was sent with. */
const cxUser = [
  cxNote("item/started", { ...cxIds, item: { type: "userMessage", id: "{{uuid}}", clientId: "{{in.params.clientUserMessageId}}", content: "{{in.params.input}}" } }),
  cxNote("item/completed", { ...cxIds, item: { type: "userMessage", id: "{{uuid}}", clientId: "{{in.params.clientUserMessageId}}", content: "{{in.params.input}}" } }),
];
/** A turn/start with no turn running starts one, named by the request's id. */
export const codexStart: Step[] = [
  { wait: { method: "turn/start" }, set: { turn: "{{in.id}}" } },
  { transcript: [cxRecord({ type: "UserMessage", id: "{{uuid}}", client_id: "{{in.params.clientUserMessageId}}", content: "{{in.params.input}}" })] },
  { emit: [cxResult({ turn: cxTurn("inProgress") }), cxNote("turn/started", { threadId: "{{state.thread}}", turn: cxTurn("inProgress") }), ...cxUser] },
];
/** A turn/start while one runs joins it (start-mid-turn). */
const cxJoin: Step[] = [{ wait: { method: "turn/start" } }, { emit: [cxResult({ turn: cxTurn("inProgress") }), ...cxUser] }];
const cxCommand = (state: "started" | "completed", command: string) =>
  cxNote(`item/${state}`, { ...cxIds, item: { type: "commandExecution", id: "exec-fake", command: `/usr/bin/zsh -lc '${command}'`, status: state === "started" ? "inProgress" : "completed", commandActions: [{ type: "unknown", command }] } });
export const codexEnd = (reply: string, status = "completed"): Step[] => [
  {
    emit: [
      cxNote("item/agentMessage/delta", { ...cxIds, itemId: "msg_fake", delta: reply }),
      cxNote("item/completed", { ...cxIds, item: { type: "agentMessage", id: "msg_fake", text: reply, phase: "final_answer" } }),
      cxNote("thread/tokenUsage/updated", { ...cxIds, tokenUsage: { total: cxUsage, last: cxUsage, modelContextWindow: 258400 } }),
      cxNote("turn/completed", { threadId: "{{state.thread}}", turn: cxTurn(status) }),
    ],
  },
  { transcript: [cxRecord({ type: "AgentMessage", id: "msg_fake", content: [{ type: "Text", text: reply }], phase: "final_answer" })] },
];

/** Codex: a message that comes while the turn's command runs joins the turn; with `taken`, it is in the
 *  conversation before Codex is killed. */
export const codexKilledWithSteer = (taken: boolean): Script => ({
  on: codexOn,
  steps: [
    ...codexStart,
    { emit: [cxCommand("started", "sleep 60")] },
    { wait: { method: "turn/start" } },
    { emit: [cxResult({ turn: cxTurn("inProgress") }), ...(taken ? cxUser : [])] },
    { sleep: 100 },
    { kill: "SIGKILL" },
  ],
});

/** Codex: one turn to its end; the next turn/start it reads and does nothing with. Then it is killed. */
export const codexKilledUntaken: Script = {
  on: codexOn,
  steps: [...codexStart, ...codexEnd("fake reply"), { wait: { method: "turn/start" } }, { sleep: 100 }, { kill: "SIGKILL" }],
};

/** Codex: the first turn is refused for the usage limit, the 7-day window full until resetsAt (epoch
 *  seconds), as in the hand-written usage-limit recording; then one turn per turn/start. */
export const codexQuota = (resetsAt: number): Script => {
  const error = { message: "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null };
  const full = { ...cxQuota, primary: { ...cxQuota.primary, usedPercent: 100, resetsAt }, credits: { hasCredits: false, unlimited: false, balance: "0" } };
  const refused: Step = {
    emit: [cxNote("account/rateLimits/updated", { rateLimits: full }), cxNote("error", { error, willRetry: false, ...cxIds }), cxNote("turn/completed", { threadId: "{{state.thread}}", turn: { ...cxTurn("failed"), error } })],
  };
  return { on: codexOn, steps: [...codexStart, refused, ...codexStart, ...codexEnd("fake reply"), { goto: codexStart.length + 1 }] };
};

export const builtins: Record<string, Script> = {
  /** Codex: one turn per turn/start, to turn/completed. */
  "codex-turn": { on: codexOn, steps: [...codexStart, ...codexEnd("fake reply"), { goto: 0 }] },
  /** Codex: the first turn runs a command until a message joins it, then ends with "steered". */
  "codex-until-steered": {
    on: codexOn,
    steps: [...codexStart, { emit: [cxCommand("started", "sleep 30")] }, ...cxJoin, { emit: [cxCommand("completed", "sleep 30")] }, ...codexEnd("steered"), ...codexStart, ...codexEnd("fake reply"), { goto: codexStart.length + 4 + 2 }],
  },
  /** Codex: the first turn runs a command until it is interrupted, which Codex never completes. */
  "codex-until-interrupted": {
    on: codexOn,
    steps: [
      ...codexStart,
      { emit: [cxCommand("started", "sleep 30")] },
      { wait: { method: "turn/interrupt" } },
      { emit: [j({ id: "{{in.id}}", result: {} }), cxNote("turn/completed", { threadId: "{{state.thread}}", turn: cxTurn("interrupted") })] },
      ...codexStart,
      ...codexEnd("fake reply"),
      { goto: codexStart.length + 3 },
    ],
  },
  /** Codex: one turn; then /compact, which runs as a turn of its own for a second (compact), and a
   *  message meanwhile it refuses, as it does mid-compaction; then one turn per turn/start. */
  "codex-compact": {
    on: [{ match: { method: "turn/start" }, emit: [cxError("cannot steer a compact turn")] }, ...(codexOn ?? [])],
    steps: [
      ...codexStart,
      ...codexEnd("fake reply"),
      { wait: { method: "thread/compact/start" }, set: { turn: "compact-turn" } },
      { emit: [cxResult({}), cxNote("turn/started", { threadId: "{{state.thread}}", turn: cxTurn("inProgress") }), cxNote("item/started", { ...cxIds, item: { type: "contextCompaction", id: "compaction" } })] },
      { sleep: 1000 },
      {
        emit: [
          cxNote("thread/tokenUsage/updated", { ...cxIds, tokenUsage: { total: cxUsage, last: { ...cxUsage, totalTokens: 50, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, modelContextWindow: 258400 } }),
          cxNote("item/completed", { ...cxIds, item: { type: "contextCompaction", id: "compaction" } }),
          cxNote("turn/completed", { threadId: "{{state.thread}}", turn: cxTurn("completed") }),
        ],
      },
      ...codexStart,
      ...codexEnd("fake reply"),
      { goto: codexStart.length + 2 + 4 },
    ],
  },
  /** Codex: dies in the middle of each turn. */
  "codex-crash": { on: codexOn, steps: [...codexStart, { sleep: 100 }, { exit: 1 }] },
  /** Codex with approval on: each turn asks to run `make`, and ends once answered. The words of a no
   *  are steered into it. */
  "codex-approval": {
    on: [{ match: { method: "turn/steer" }, emit: [cxResult({ turnId: "{{state.turn}}" })] }, ...(codexOn ?? [])],
    steps: [
      ...codexStart,
      { emit: [cxCommand("started", "make"), j({ method: "item/commandExecution/requestApproval", id: 1, params: { kind: "command", ...cxIds, itemId: "exec-fake", command: "/usr/bin/zsh -lc make", cwd: "{{cwd}}" } })] },
      { wait: { id: 1 } },
      { emit: [cxNote("serverRequest/resolved", { threadId: "{{state.thread}}", requestId: 1 }), cxCommand("completed", "make")] },
      ...codexEnd("answered"),
      { goto: 0 },
    ],
  },
  /** A Codex that no longer takes untrusted, as each opening with approval on asks for, and rh doctor of
   *  an ephemeral thread. */
  "codex-no-untrusted": {
    on: [{ match: { method: "thread/start", params: { approvalPolicy: "untrusted" } }, emit: [cxError("Invalid request: unknown variant `untrusted`, expected one of `never`, `on-request`, `on-failure`")] }, ...(codexOn ?? [])],
    steps: [...codexStart, ...codexEnd("fake reply"), { goto: 0 }],
  },
  /** Codex with the thread open in another process: its writer lock refuses the resume. */
  "codex-locked": {
    on: [{ match: { method: "thread/resume" }, emit: [cxError("thread already has an active writer")] }, ...(codexOn ?? [])],
    steps: [...codexStart, ...codexEnd("fake reply"), { goto: 0 }],
  },
  /** pi: one run per prompt, to agent_settled. */
  "pi-turn": { on: piOn, steps: [...piStart, ...piEnd("fake reply"), { goto: 0 }] },
  /** pi-turn, on a pi that no longer has the model pi-other. */
  "pi-turn-without-other": {
    on: [{ match: { type: "set_model", modelId: "pi-other" }, emit: [j({ id: "{{in.id}}", type: "response", command: "set_model", success: false, error: "Model not found: fake/pi-other" })] }, ...piOn],
    steps: [...piStart, ...piEnd("fake reply"), { goto: 0 }],
  },
  /** pi-turn, on a pi that keeps its thinking level and, as pi 1.3.0 does, resets it to your
   *  settings' default (medium) on a model switch. */
  "pi-turn-model-resets-thinking": {
    state: { thinkingLevel: "medium" },
    on: [
      {
        match: { type: "get_state" },
        emit: [piResponse("get_state", { model: piModel("pi-fake"), thinkingLevel: "{{state.thinkingLevel}}", isStreaming: false, isCompacting: false, sessionId: "{{session_id}}", messageCount: 0, pendingMessageCount: 0 })],
      },
      { match: { type: "set_model" }, set: { thinkingLevel: "medium" }, emit: [piResponse("set_model", piModel("pi-other"))] },
      { match: { type: "set_thinking_level" }, set: { thinkingLevel: "{{in.level}}" }, emit: [piResponse("set_thinking_level")] },
      ...piOn,
    ],
    steps: [...piStart, ...piEnd("fake reply"), { goto: 0 }],
  },
  /** pi with approval mode on: each run asks to run `echo hi`, and ends once answered. */
  "pi-ask": {
    on: piOn,
    steps: [
      ...piStart,
      {
        emit: [
          j({
            type: "extension_ui_request",
            id: "pi-ask-1",
            method: "select",
            title: j({ rhodium: "approval", toolCallId: "call_echo", toolName: "bash", input: { command: "echo hi" } }),
            options: ["allow", "deny"],
          }),
        ],
      },
      { wait: { type: "extension_ui_response", id: "pi-ask-1" } },
      ...piEnd("fake reply"),
      { goto: 0 },
    ],
  },
  /** pi: the first run goes on until a steering message comes, then ends with "steered". */
  "pi-until-steered": {
    on: piOn,
    steps: [
      ...piStart,
      { wait: { type: "prompt", streamingBehavior: "steer" } },
      { emit: [piResponse("prompt", { disposition: "queued" })] },
      ...piEnd("steered"),
      ...piStart,
      ...piEnd("fake reply"),
      { goto: piStart.length + 2 + piEnd("").length },
    ],
  },
  /** pi: the first run holds its agent_settled back until a steering message comes, as when that line
   *  is still on its way to Rhodium. pi had settled before reading the message, so it starts a run
   *  of its own for it: "reply to first", then "reply to second". */
  "pi-steered-late": {
    on: piOn,
    steps: [
      ...piStart,
      { wait: { type: "prompt", streamingBehavior: "steer" } },
      ...piEnd("reply to first"),
      { emit: [piResponse("prompt", { disposition: "started" }), j({ type: "agent_start" }), j({ type: "turn_start" })] },
      ...piEnd("reply to second"),
      { goto: 0 },
    ],
  },
  /** pi: dies in the middle of each run. */
  "pi-crash": { on: piOn, steps: [...piStart, { sleep: 100 }, { exit: 1 }] },
  /** pi refusing every prompt, as with no model or API key to run it on. */
  "pi-refuse": {
    on: piOn,
    steps: [
      { wait: { type: "prompt" } },
      { emit: [j({ id: "{{in.id}}", type: "response", command: "prompt", success: false, error: "No API key found for provider fake" })] },
      { goto: 0 },
    ],
  },
  /** pi whose extension fails on each of two tool calls in its run, with a long error. */
  "pi-ext-error": {
    on: piOn,
    steps: [
      ...piStart,
      { emit: [1, 2].map(() => j({ type: "extension_error", extensionPath: "/ext/approval.ts", event: "tool_call", error: "boom ".repeat(1200) })) },
      ...piEnd("fake reply"),
      { goto: 0 },
    ],
  },
  /** pi: one run per prompt, each taking 1.5 s. */
  "pi-slow": { on: piOn, steps: [...piStart, { sleep: 1500 }, ...piEnd("fake reply"), { goto: 0 }] },

  /** pi with approval mode on: the run asks to run `sleep 8`, and once allowed the command runs on
   *  without a word until a steering message comes; then it ends and the run settles. */
  "pi-approval-long": {
    on: piOn,
    steps: [
      ...piStart,
      {
        emit: [
          j({ type: "tool_execution_start", toolCallId: "call_sleep", toolName: "bash", args: { command: "sleep 8" } }),
          j({
            type: "extension_ui_request",
            id: "pi-ask-1",
            method: "select",
            title: j({ rhodium: "approval", toolCallId: "call_sleep", toolName: "bash", input: { command: "sleep 8" } }),
            options: ["allow", "deny"],
          }),
        ],
      },
      { wait: { type: "extension_ui_response", id: "pi-ask-1" } },
      { wait: { type: "prompt", streamingBehavior: "steer" } },
      { emit: [piResponse("prompt", { disposition: "queued" }), j({ type: "tool_execution_end", toolCallId: "call_sleep", toolName: "bash", result: { content: [] }, isError: false })] },
      ...piEnd("done"),
      { goto: 0 },
    ],
  },

  /** pi: the first run goes on until abort; it settles as aborted 300 ms later, as a run busy
   *  in a tool would, and only then is abort answered. Plain runs follow. */
  "pi-until-interrupted": {
    on: piOn,
    steps: [
      ...piStart,
      { emit: [j({ type: "message_update", usage: piUsage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } })] },
      { wait: { type: "abort" } },
      { sleep: 300 },
      {
        emit: [
          j({ type: "message_end", message: piAssistant([], "aborted") }),
          j({ type: "agent_end", messages: [], willRetry: false }),
          j({ type: "agent_settled", aborted: true }),
          piResponse("abort"),
        ],
      },
      ...piStart,
      ...piEnd("fake reply"),
      { goto: piStart.length + 4 },
    ],
  },


  /** One plain turn per user message. */
  turn: { on, steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }] },
  /** turn, on a newer Claude whose handshake no longer offers Haiku. */
  "turn-without-haiku": { on: [{ match: initialize, emit: handshake([], MODELS.slice(0, 1)) }, ...on], steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }] },
  /** turn, on a Claude whose default model has xhigh and max, and whose get_settings says ultracode
   *  can be turned on; its Haiku still has no xhigh. */
  "turn-ultracode": {
    on: [
      { match: initialize, emit: handshake([], [{ ...MODELS[0]!, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }, MODELS[1]!]) },
      { match: control("get_settings"), emit: answer({ applied: { effort: "high", ultracode: false, ultracodeAvailable: true } }) },
      ...on,
    ],
    steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }],
  },
  /** turn, on a Claude whose get_settings says ultracode is on. */
  "turn-ultracode-on": {
    on: [{ match: control("get_settings"), emit: answer({ applied: { effort: "high", ultracode: true, ultracodeRequested: true, ultracodeAvailable: true } }) }, ...on],
    steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }],
  },
  /** turn, on a Claude whose model cannot take ultracode. */
  "turn-no-ultracode": {
    on: [{ match: control("get_settings"), emit: answer({ applied: { effort: "high", ultracode: false, ultracodeAvailable: false } }) }, ...on],
    steps: [...startTurn, ...endTurn("fake reply"), { goto: 0 }],
  },

  /** One plain turn, then a /compact, as in the cmd-compact recording, that takes the context from
   *  80,000 tokens to 12,000; then plain turns again. */
  compact: {
    on,
    steps: [
      ...startTurn,
      ...endTurn("fake reply"),
      ...compaction(),
      { goto: 0 },
    ],
  },

  progress: progress(0),
  /** progress at a turn's pace, as a fake Telegram-like bot sees it: each step 80 ms, under its
   *  five edits a second (test/instance.ts). */
  "progress-fast": progress(80),

  /** Streams a 900-character reply in PROGRESS_PIECES, with a 1-second pause after the fifth piece. */
  "progress-pause": {
    on,
    steps: [
      ...startTurn,
      ...PROGRESS_PIECES.flatMap((p, i): Step[] => [{ emit: [textDelta(p)] }, ...(i === 4 ? [{ sleep: 1000 }] : [])]),
      ...endTurn(PROGRESS_PIECES.join("")),
      { goto: 0 },
    ],
  },

  /** Streams a 500-character message in the first five PROGRESS_PIECES, pauses 1 second, then
   *  reads a file and replies "final". */
  "progress-then-tool": {
    on,
    steps: [
      ...startTurn,
      ...PROGRESS_PIECES.slice(0, 5).map((p): Step => ({ emit: [textDelta(p)] })),
      { emit: [text(PROGRESS_PIECES.slice(0, 5).join(""))] },
      { sleep: 1000 },
      toolCall("toolu_read", "Read", { file_path: "notes.txt" }),
      ...endTurn("final"),
      { goto: 0 },
    ],
  },

  /** The first turn runs until interrupted and ends as in the cmd-stop recording, 300 ms after
   *  the interrupt, as a turn busy in a tool would; plain turns follow. */
  "until-interrupted": {
    on,
    steps: [
      ...startTurn,
      { emit: [text("working")] },
      { wait: { type: "control_request", request: { subtype: "interrupt" } } },
      { sleep: 300 },
      {
        emit: [
          j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { still_queued: [] } } }),
          result("", { subtype: "error_during_execution", is_error: true, result: null, stop_reason: null, terminal_reason: "aborted_streaming" }),
          state("idle"),
        ],
      },
      ...startTurn,
      ...endTurn("fake reply"),
      { goto: startTurn.length + 4 },
    ],
  },

  /** The first turn says it starts, then runs a long Bash step until interrupted, ending as
   *  until-interrupted's does, or until killed. Resumed with CLAUDE_CODE_RESUME_INTERRUPTED_TURN, it
   *  ends with `resumed`, as crashing's does. Plain turns follow. */
  "step-until-cut-short": (() => {
    const loop = toolUse("toolu_loop", "Bash", { command: "for i in $(seq 8); do ./step.sh $i; sleep 60; done", description: "Run 8-step loop" });
    const turn: Step[] = [
      ...startTurn,
      { emit: [textDelta("开始跑循环。")] },
      loop,
      { wait: { type: "control_request", request: { subtype: "interrupt" } } },
      {
        emit: [
          j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { still_queued: [] } } }),
          result("", { subtype: "error_during_execution", is_error: true, result: null, stop_reason: null, terminal_reason: "aborted_streaming" }),
          state("idle"),
        ],
      },
    ];
    const resumed: Step[] = [{ emit: [state("running"), init] }, ...endTurn("resumed")];
    const plain = 2 + turn.length + resumed.length;
    return { on, steps: [{ goto: 2 + turn.length, env: "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" }, ...turn, { goto: plain }, ...resumed, ...startTurn, ...endTurn("fake reply"), { goto: plain }] };
  })(),

  /** The first turn asks to run a tool. An interrupt withdraws the ask, as in the
   *  interrupt-pending-approval recording, and the turn ends a second later; plain turns follow.
   *  Right before it ends, a control request no Claude sends, which Rhodium answers at once with an
   *  error: that answer marks in the agent's stdin where the interrupted turn ended. */
  "ask-until-interrupted": {
    on,
    steps: [
      ...startTurn,
      { emit: [j(canUseTool([ASK, "Bash", { command: "echo hi" }])), state("requires_action")] },
      { wait: { type: "control_request", request: { subtype: "interrupt" } } },
      { emit: [j({ type: "control_cancel_request", request_id: ASK }), state("running")] },
      { sleep: 1000 },
      {
        emit: [
          j({ type: "control_request", request_id: "fake-turn-end", request: { subtype: "fake_turn_end" } }),
          j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response: { still_queued: [] } } }),
          result("", { subtype: "error_during_execution", is_error: true, result: null, stop_reason: null, terminal_reason: "aborted_streaming" }),
          state("idle"),
        ],
      },
      ...startTurn,
      ...endTurn("fake reply"),
      { goto: startTurn.length + 5 },
    ],
  },

  /** The turn asks to run a tool and waits for the answer. */
  ask: {
    on,
    steps: [
      ...startTurn,
      {
        emit: [
          assistant({ type: "tool_use", id: "toolu_fake", name: "Bash", input: { command: "echo hi" } }),
          j({ type: "control_request", request_id: ASK, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "toolu_fake" } }),
          state("requires_action"),
        ],
      },
      { wait: { type: "control_response", response: { request_id: ASK } } },
      {
        emit: [
          state("running"),
          j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake", content: "hi" }] }, parent_tool_use_id: null, ...ids }),
        ],
      },
      ...endTurn("asked"),
      { goto: 0 },
    ],
  },

  background: background(300),

  /** Out of quota for the next hour. */
  "rate-limit": rateLimited(Math.floor(Date.now() / 1000) + 3600),

  /** Dies in the middle of the turn. */
  crash: { on, steps: [...startTurn, { emit: [text("working")] }, { exit: 1 }] },

  /** Per message, a turn that streams 39 numbers 15 ms apart, then says "40", its one message and
   *  so the final reply; the turn ends 400 ms after it. */
  numbered: {
    on,
    steps: [
      ...startTurn,
      ...Array.from({ length: 39 }, (_, i): Step[] => [{ emit: [textDelta(String(i + 1))] }, { sleep: 15 }]).flat(),
      { emit: [text("40")] },
      { sleep: 400 },
      { emit: [result("40"), state("idle")] },
      { goto: 0 },
    ],
  },

  /** Numbered lines, 100 a second, until killed. */
  seq: { on, steps: [...startTurn, { emit: [j({ type: "seq", seq: "{{seq}}" })] }, { sleep: 10 }, { goto: startTurn.length }] },

  /** Lines that naive line splitters break: U+2028, 3 MiB long, and 汉 cut between two writes. */
  "hard-lines": {
    on,
    steps: [
      ...startTurn,
      { emit: [text("line separator \u2028 inside a line"), text("x".repeat(3 * 1024 * 1024))] },
      { emit: [split], splitAt: Buffer.from(split).indexOf(Buffer.from("汉")) + 1 },
      ...endTurn("done"),
    ],
  },

  /** Answers the first message with "bye" 300 ms after it came, then exits with code 3. */
  "reply-then-exit": { on, steps: [...replyWith(text("bye")), { exit: 3 }] },

  /** The same three lines as final replies of three turns, one per message. The 3 MiB of the long
   *  one sit outside its text, which a chat message could not hold. */
  "hard-replies": {
    on,
    steps: [
      ...replyWith(text("line separator \u2028 inside a line")),
      ...replyWith(assistant({ type: "text", text: "after 3 MiB" }, { padding: "x".repeat(3 * 1024 * 1024) })),
      ...replyWith(split, halfHan),
    ],
  },
};
