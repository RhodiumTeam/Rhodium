// Contracts between the main loop, the router, agent drivers and IM adapters.
// Fixed before milestone 1 is split up: add fields and variants, never change what one means.

// ---- Agent drivers (architecture §6.1) ----

export type AgentKind = "claude" | "pi" | "codex";

/** Every event names its conversation and agent process. proc goes up by one each time an
 *  agent process starts; events carrying an older proc than the current one are dropped. */
export type AgentEvent = { conv: string; proc: number } & (
  // input: the agent input whose message began the turn, when the driver can tell. A message written
  // just as the last turn ended runs as this one, though the router took it for joining that one.
  | { type: "turn_start"; input?: string }
  // Only on the agent's idle signal: Claude's session_state_changed idle, pi's agent_settled.
  // reply: the text of the turn's last assistant message, which Rhodium sends as the final reply.
  // background: background tasks still run, and one finishing wakes the agent for another turn.
  // compactOnly: the turn did nothing but your /compact (Claude's), so it is no work to report.
  | { type: "turn_end"; reply?: string; background?: true; compactOnly?: true }
  | { type: "text_delta"; text: string }
  // One whole assistant message, or one tool call whose result came back. id: the tool call's, as
  // its tool_start gave it.
  | { type: "item"; item: { kind: "message"; text: string } | { kind: "tool"; name: string; input: unknown; id?: string } }
  // A tool call the agent made, before its result: it may still wait for your approval (an ask).
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | ({ type: "ask" } & AgentAsk)
  | { type: "ask_cancel"; requestId: string }
  // After every handshake: the asks the agent is still waiting on, for the caller to reconcile
  // with its own. null: the agent is too old to say (Claude before 2.1.268), so treat every
  // unanswered ask of this process as stale.
  | { type: "pending_asks"; asks: AgentAsk[] | null }
  | { type: "state"; state: "idle" | "running" | "waiting" }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      // Claude's rate_limit_event; exhausted means the slot must wait until resetsAt.
      quota?: { exhausted: boolean; resetsAt: number | null };
    }
  | { type: "commands"; commands: { name: string; description: string }[] }
  | { type: "background"; tasks: { id: string; description: string }[] }
  | { type: "protocol_error"; reason: "bad_line" | "line_too_long" | "unexpected"; detail: string }
  // The agent took this input into its conversation, or turned it down: it no longer waits in the
  // agent's own memory, where a crash would lose it (architecture §4.6).
  | { type: "taken"; inputId: string }
  // The four below come from the slot runner, not from the agent's protocol.
  | { type: "written"; inputId: string } // the holder acked this agent input
  // busy: no agent started, as someone else uses the conversation (architecture §10.1); why.
  // missing: no agent started, as its program was not there for all of durations.programWait (§4.2); its path, or its bare name.
  // stopped: no agent started, as rh stop (1) or the emergency stop (2) ended that wait.
  // stderr: the last lines the agent process, or its holder, wrote to err.log, if any (runner's errTail).
  // why: why it did not start, in your words, where its driver knows (driver.info.why).
  | { type: "exit"; code: number | null; signal: string | null; from: "agent" | "holder"; busy?: string; missing?: string; stopped?: 1 | 2; stderr?: string; why?: string }
  // A common command the driver ran, for the reply to the IM message (inbound) in chat that asked for it.
  // panel: how its reply shows, as the command effect had it.
  | { type: "command_result"; command: CommonCommand; chat: string; inbound: string; result: CommandResult | { error: string }; panel?: PanelUi }
  // The running agent did not take rh set approval's switch (driver.approval failed).
  | { type: "approval_failed"; error: string }
  // A new process does not have the slot's remembered model (spawn's model), say after an upgrade:
  // it runs on its own default instead. error: what the agent said, if it said why.
  | { type: "model_gone"; model: string; error?: string }
);

/** toolUse: the id of the tool call it asks about, as its tool_start gave it, where the agent says. */
export type AgentAsk = { requestId: string; kind: "question" | "plan" | "permission"; tool: string; input: unknown; toolUse?: string };

export type AgentEmit = (event: AgentEvent) => void;

/** How to launch an agent; the runner passes it to the holder's start message. */
export type SpawnSpec = { argv: string[]; env: Record<string, string>; cwd: string };

/** The runner's connection to one agent process, over which the driver speaks the agent's protocol. */
export interface AgentLink {
  /** One line to the agent's stdin; resolves once the holder acks it. */
  write(inputId: string, line: string): Promise<void>;
  eof(): Promise<void>;
  signal(sig: "TERM" | "KILL"): Promise<void>;
  /** Settles once the agent process has exited. */
  exited: Promise<unknown>;
}

/** turn: start a new turn. steer: merge into the running turn. A ! message is the router's
 *  interrupt() first, then a turn once the interrupted one ends (architecture §6.1). */
export type SendMode = "turn" | "steer";

/** human: from you, so Claude gets origin {kind: "human"}; reports and other agents' messages are not.
 *  images: pictures for the agent to look at (architecture §8.3), data in base64. */
export type AgentMessage = { id: string; text: string; human: boolean; images?: { mimeType: string; data: string }[] };

export type AskAnswer =
  | { kind: "permission"; allow: boolean; message?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; approve: boolean; message?: string };

export type CommonCommand = "new" | "stop" | "status" | "model" | "compact" | "usage" | "context" | "resume" | "effort" | "ultracode";
export const COMMON: readonly CommonCommand[] = ["new", "stop", "status", "model", "compact", "usage", "context", "resume", "effort", "ultracode"];

/** rh: /rh_x, or /rh-x, is Rhodium's own. common: one of the ten. A message that is neither,
 *  /btw and skills' commands included, goes to the agent as typed. Here, so the board's send key
 *  reads what you type as Rhodium will (spec web-write "待发队列"). */
export type ImCommand = { kind: "rh"; word: string; args: string } | { kind: "common"; name: CommonCommand; args: string };

export function parseCommand(text: string): ImCommand | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const [, word, args] = m as unknown as [string, string, string];
  if (/^rh[_-]/.test(word)) return { kind: "rh", word: `/${word}`, args };
  if ((COMMON as string[]).includes(word)) return { kind: "common", name: word as CommonCommand, args };
  return null;
}

/** What the source line of your message from the board's page names (spec web-write): [来自 网页]. */
export const FROM_BOARD = "网页";
/** What a source line adds after the chat it names, before when you sent it, for a message Rhodium
 *  held past durations.sentAtAfter: [来自 网页，发送于 21:05] (prompt's withSentAt). */
export const SENT_AT = "，发送于 ";
/** Whether a message's source line is the board's, by the chat it names: [来自 网页], or one held as SENT_AT says. */
export const fromBoard = (source: string | null): boolean => source?.split(SENT_AT)[0] === FROM_BOARD;

/** One entry of a list to pick from, such as /model or /resume with no argument: label is what
 *  you see, id is what picking it hands back to the command; current: the one in use now; group:
 *  what the board groups it under, pi's provider of a model (spec web-write). */
export type Choice = { id: string; label: string; current?: true; group?: string };

/** Token counts of the agent's last turn; context is what its last request carried. */
export type TokenUsage = { inputTokens?: number; outputTokens?: number; contextTokens?: number };

/** How full the context is: the tokens in use out of the model's window, null where unknown. */
export type ContextUse = { usedTokens: number; maxTokens: number | null };
export type QuotaWindow = { window: "5h" | "7d"; model?: string; usedPercent: number; resetsAt: number | null };
export type ExtraUsage = { usedPercent: number; used: number; limit: number | null; currency: string };
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
// cost: none where the agent gives none (Codex).
export type SessionUse = { cost?: number; tokens: Tokens; models?: { name: string; cost: number; tokens: Tokens }[] };

/**
 * What a common command did. The same shape for every agent, and one formatter (src/im-commands.ts)
 * turns it into the IM reply, so the ten read the same on Claude and pi (product §5.6).
 * A list to pick from comes as choices, numbered where the platform has no buttons for them all.
 */
export type CommandResult =
  | { command: "new" } // the next message starts a new conversation
  | { command: "stop"; stopped: boolean } // false: no turn was running
  // The agent's part of /status; Rhodium adds the slot's directory, agent and state. effort: the
  // level /effort set, where the agent does not say it otherwise. ultracode: the slot keeps it on, Claude's alone.
  // context: as /context has it, null with no process to ask; limits: /usage's, while Claude's process runs.
  | { command: "status"; model: string | null; context: ContextUse | null; limits?: QuotaWindow[]; effort?: string; ultracode?: true }
  // With choices: the current model, and the list. Without: the model switched to, null for the default.
  // label: that model's name as the agent shows it. level: the thinking level now, where known; was:
  // the one before, where /model set it too: /model <model> <level>, or, on Codex, a switch to a model
  // without the level, which moves it to the model's default. efforts: the levels the model switched
  // to takes, for the panel's second step (docs/im-style.md §9.5); none for a model with no levels.
  | { command: "model"; model: string | null; choices?: Choice[]; label?: string; level?: string; was?: string; efforts?: Choice[] }
  | { command: "effort"; level: string; choices?: Choice[] }
  // Claude's ultracode switch, apart from the level (#276): on as it is now, or as set; with choices, on and
  // off to pick from. unavailable: the model in use cannot take it, so nothing was set.
  | { command: "ultracode"; on: boolean; choices?: Choice[]; unavailable?: true }
  // limits: the quota windows in Claude's order, none where there is no quota (pi, an API key login);
  // window, the kind; model, the one model it is for, if any; usedPercent 0-100; resetsAt in ms since
  // the epoch. extra: extra usage, when it is on, in currency's units. credits: the credits left, where the
  // account has some (Codex's). session: the conversation's use, cost in USD; Claude's by model too (architecture §6.1).
  | { command: "usage"; limits: QuotaWindow[]; extra?: ExtraUsage; credits?: number; session?: SessionUse }
  // categories: what holds it, by name, Claude's alone.
  | { command: "context"; usedTokens: number; maxTokens: number | null; categories?: { name: string; tokens: number }[] }
  | { command: "compact"; beforeTokens: number | null; afterTokens: number | null }
  // With choices: the list to go back to. Without: the session to go back to, and the agent it is of.
  // name: the conversation as you call it, 昨天 22:10 那段: the one gone back to, or with choices the current one.
  | { command: "resume"; session: string | null; agent?: AgentKind; choices?: Choice[]; name?: string };

/** A driver is built with the conversation id and an AgentEmit, and reports only through it. */
export interface AgentDriver {
  readonly conv: string;
  /** What the runner reads of the attached process (architecture §5, §6.2). session: the session id
   *  its output reported; null if none yet, or if the agent never reports it (pi). selfStarted: whether
   *  it ran the turn a crash cut short again by itself (spawn's resumed), null till it says; left out by
   *  an agent that never does, which is written the resume prompt. busy: the agent would not open the
   *  conversation, as another process has it open (Codex's writer lock, architecture §6.4), so its exit
   *  is the exit's busy, no crash. why: why the process did not start, or gave up starting, in words
   *  for you: its exit's why. Both are of the last launch or attach. */
  readonly info: { readonly session: string | null; readonly selfStarted?: boolean | null; readonly busy?: string; readonly why?: string };
  /** The session a new process was launched with is the agent's once an input is written to it, as
   *  its output never names it (pi, architecture §6.3). */
  readonly sessionOnWrite?: boolean;
  /** The process attaching next is one the last rhodium started, found running after a restart; it
   *  set the slot's remembered /effort on it (pi, architecture §6.3). approval: the slot's mode, which
   *  Codex takes with each turn (§6.4), as it does the slot's /model and /effort. */
  adopt?(effort: string | null, approval: boolean, model: string | null): void;
  /** Launch arguments. */
  spawn(opts: {
    cwd: string;
    session: { new: string } | { resume: string };
    systemPromptFile: string;
    env: Record<string, string>;
    approval: boolean; // the slot's approval mode; off lets tools run without asking
    program: string; // [programs] in the config: an absolute path, or a bare name looked up on env.PATH
    // The slot's remembered /model and /effort, set on the new process before your first message
    // (product §5.6); null or left out: the agent's own default.
    model?: string | null;
    effort?: string | null;
    // The slot's ultracode switch, Claude's: null or left out, your own settings'.
    ultracode?: boolean | null;
    // A crash cut the conversation's turn short: an agent that runs it again by itself is told to
    // (architecture §4.8). Otherwise it is written the resume prompt.
    resumed?: boolean;
  }): SpawnSpec;
  /** Called on every (re)connect to the agent process numbered proc. */
  attach(link: AgentLink, proc: number): void;
  /**
   * One whole line of agent output, as forwarded by the holder. proc: the process the line came
   * from; a line from any process but the attached one is dropped. Without it the line counts
   * as the attached process's, and its events carry that number. replay: rhodium processed the
   * line before a restart (architecture §4.5); it only brings the driver's state back and writes
   * nothing to the agent.
   */
  feed(line: Uint8Array, proc?: number, replay?: boolean): void;
  /** After a restart, before any output is fed again: the inputs written to this process that it
   *  had not taken yet, oldest first, so that their taken events still come (architecture §4.6). */
  untaken(ids: string[]): void;
  /** Called once per attach, when the output processed before a restart has been fed again; at
   *  once if there is none. pi reports the asks it still waits on here (architecture §5 step 6). */
  replayed(): void;
  send(message: AgentMessage, mode: SendMode): Promise<void>;
  interrupt(): Promise<void>;
  answer(requestId: string, answer: AskAnswer): Promise<void>;
  /** Switches the slot's approval mode in the running process. pi has no way to: it rejects, and
   *  the switch is a restart with the same session once the slot is idle (architecture §6.3). */
  approval(on: boolean): Promise<void>;
  /** The agent's own part of a common command; /stop is interrupt(). The router does /new itself,
   *  for every agent: it closes the process, and the next message starts a new session. /resume is
   *  Rhodium's too: it lists the slot's timeline and directory, with no agent needed. */
  command(name: CommonCommand, args: string): Promise<CommandResult>;
  /** Close stdin and let the agent exit by itself. */
  close(): Promise<void>;
}

// ---- IM adapters (architecture §8.1). Adapters report what the platform can do;
// the renderer and the router make every fallback decision (architecture §8). ----

export type Platform = "qq" | "telegram" | "feishu" | "fake";

export type Capabilities = {
  progress: "append" | "edit"; // QQ can only add messages; Telegram edits one message in place
  // The least time (ms) between two edits of a turn's message, from its send or its last edit (Feishu's).
  editEvery?: number;
  // "markdown": shown on a Markdown message only (QQ), so the adapter sends a message with buttons as one.
  buttons: boolean | "markdown";
  maxButtons?: number; // the most buttons one message shows
  // The longest text a copy button carries (OutboundMessage.buttons); left out, the platform has none.
  copy?: number;
  sendLimit: { kind: "qq_quota" } | { kind: "rate"; perChatPerSecond: number };
  // The / menu and the row (product §5.7): one for all chats, or one per chat; the most commands the
  // / menu holds; the kind of row, left out where the platform has none.
  menu: { scope: "global" | "per_chat"; maxItems: number; row?: "custom_menu" | "reply_keyboard" };
  maxTextLength: number;
  maxFileBytes: { image: number; file: number }; // the largest picture and file a bot may send
  // The Markdown the platform shows: GFM, plus syntax of its own that plain words can trip, which the
  // renderer escapes outside code (emoji: :name:; heading: a line's # opens a heading with no space
  // after it). null: plain text only. links "http": the platform turns down a message with a link to
  // anything else, so such a link keeps only its text. literal: a query reply's values show as
  // written only with a backslash before each mark and no code (render.ts's literal, QQ's).
  markdown: { extensions: ("html" | "math" | "spoiler" | "mark" | "emoji" | "heading")[]; links?: "http"; literal?: true } | null;
};

/** About how many characters of a whole message a quote brings the agent (product §5.4). */
const QUOTE_HEAD = 100;

/** A quote as the agent gets it over your words, from IM or the board's page (docs/im-style.md §2.6):
 *  each line after "> ". A whole message brings its first 100 characters as you see them, then "…";
 *  a part you picked, all of it (product §5.4). */
export function quoting(text: string, picked = false): string {
  const chars = [...new Intl.Segmenter().segment(text)];
  const head = picked || chars.length <= QUOTE_HEAD ? text : `${chars.slice(0, QUOTE_HEAD).map((c) => c.segment).join("").trimEnd()}…`;
  return head.replace(/^/gm, "> ");
}

/** A message's leading quote, as quoting writes it over your words ("> " lines, then an empty line),
 *  and what follows; null with none. */
export function quoteOf(text: string): { quote: string; rest: string } | null {
  const m = /^((?:> .*(?:\n|$))+)\n?/.exec(text);
  return m && { quote: m[1]!.replace(/^> /gm, ""), rest: text.slice(m[0].length) };
}

/** Markdown read as one line of plain words, for one shown cut where it does not fit (story 573): no
 *  fence or its language, * or `, nor a line's leading # or >; a line naming a kept picture or file,
 *  as media's mediaLine writes it into an IM quote, is [图片] or [文件] alone; the … a cut quote ends
 *  in stays. What goes to the agent keeps them. */
export const plain = (md: string) =>
  md
    .replace(/^(\[(?:图片|文件)\]) .*\/[0-9a-f]{64}$/gm, "$1")
    .replace(/^\s*(?:```[\w+-]*|[#>]+ ?)/gm, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export type InboundMessage = {
  bot: string; // bot row id
  chat: string; // the platform's chat id
  messageId: string; // the platform's message id
  sender: string; // the platform's user id
  text: string;
  at: number;
  // A quoted message. QQ gives only a reference, so the text comes from the store (§8.3);
  // Telegram gives the text too. Without text, fallback is what to show if the store has none.
  // picked: text is only the part of it you picked (Telegram), which the agent gets whole (product §5.4).
  quote?: { ref: string; text?: string; fallback?: string; picked?: true };
  // What a later quote names this message by, where that is not messageId (QQ's msg_idx).
  ref?: string;
  // Images and files, not yet downloaded: rhodium fetches them only once it knows the message is
  // yours, and stores each before routing (§8.3). name is the platform's and never part of a path;
  // path is where it is kept, mimeType that of a picture an agent can be shown.
  attachments?: { kind: "image" | "file"; name?: string; fetch: () => Promise<Uint8Array>; path?: string; mimeType?: string }[];
  // A button press, with text "": the button's data and the message that carried the button; what
  // that message read, where the platform says (Telegram).
  button?: { data: string; message: string; text?: string };
  // A voice message Rhodium can't read yet (Telegram's, product §5.4): you are told, the agent gets nothing.
  voice?: true;
};

/** A button; data comes back when it is pressed. row: buttons with the same row go side by side, in
 *  order; one without a row has a row of its own. muted: cancel, back or a page, not a choice (QQ
 *  shows it grey). fill: where the platform can, pressing it puts this text in the input box for you
 *  to finish, sending nothing (QQ); elsewhere it is pressed as any other. copy: pressing it copies
 *  data for you to send again, rather than sending it back (docs/im-style.md §11.5). */
export type Button = { label: string; data: string; row?: number; muted?: true; fill?: string; copy?: true };

/** Where a reply to a press on a panel shows (docs/im-style.md §9.1): its page of the list, and on a
 *  platform that edits, the message to show it in place of, by its platform id or its outbound record. */
export type PanelUi = { page?: number; edit?: { message: string } | { outbound: string } };

export type OutboundMessage = {
  text: string;
  // text in the platform's Markdown (Capabilities.markdown). The adapter sends this, and text instead
  // should the platform turn it down, so a message never fails for its formatting.
  markdown?: string;
  buttons?: Button[];
  replyTo?: string; // platform message id; on QQ this makes it a passive reply
  seq?: number; // QQ msg_seq, fixed per outbound record (architecture §7.4)
  // Sent as a picture or a file, text as its caption; name is what it goes out called.
  file?: { kind: "image" | "file"; path: string; name: string };
};

/** Mirrors the outbound record's states: unknown means it may or may not have arrived.
 *  quota: the platform turned down a passive reply for its quota (QQ), so it can go out another way.
 *  refused: it turned down an active message for another reason (QQ: you turned them off, moderation,
 *  the per-minute limit): this one can go out another way, the quota left alone (product §5.5).
 *  flood: turned down for the chat's flood limit (Telegram's 429), still, after the adapter's waits:
 *  another message now would be turned down too. */
// ref: what a later quote names the sent message by, where that is not messageId (QQ's ref_idx).
// sent with no messageId: QQ's dedupe answer to a retry, the first try having got there (architecture §7.4).
export type SendResult = { status: "sent"; messageId?: string; ref?: string } | { status: "failed" | "unknown"; error: string; quota?: boolean; refused?: true; flood?: true };

export type MenuItem = { command: string; description: string };
/** A button on the row (product §5.7): one that sends its command, or a folder of such (QQ's). */
export type RowButton = { label: string; command: string } | { label: string; sub: { label: string; command: string }[] };

/** Told, again and again, whether the bot's connection is up: true once the platform has answered,
 *  false with why, if known, each time a try fails or the connection drops. rhodium counts the falses
 *  in a row (architecture §8.6). */
export type Connected = (up: boolean, error?: string) => void;

export interface ImAdapter {
  readonly capabilities: Capabilities;
  /** Holds the connection to the platform while iterated, telling connected how it goes. */
  messages(connected?: Connected): AsyncIterable<InboundMessage>;
  send(chat: string, message: OutboundMessage): Promise<SendResult>;
  edit(chat: string, messageId: string, message: OutboundMessage): Promise<SendResult>;
  /** Takes the buttons off a sent message. */
  dropButtons(chat: string, messageId: string): Promise<SendResult>;
  /** Answers a button press (the messageId of its InboundMessage) with a notice for whoever pressed
   *  it, "" for none: the platform waits for an answer to every press. */
  answerPress(chat: string, press: string, text: string): Promise<void>;
  /** The / menu; chat only where menu.scope is per_chat. */
  setMenu(items: MenuItem[], chat?: string): Promise<void>;
  /** The row, only where menu.row is set; chat as for setMenu. */
  setRow(row: RowButton[], chat?: string): Promise<void>;
  /** The bot's own avatar, and yours and your name under it (you: your user id there, null before
   *  pairing). What it cannot get it leaves out, logging only which and the kind of error. Never throws. */
  profile(you: string | null): Promise<Profile>;
}

/** What an adapter keeps across restarts (architecture §5 step 7): rows of the store's meta table by
 *  keys it names itself, undefined to delete one; and the events it puts on record. */
export type Kept = {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
  event(type: string, data: Record<string, unknown>): void;
};

/** What rhodium hands every adapter it makes (the daemon's ADAPTERS). seen: whether the message is on
 *  record already (architecture §7.3). durations: the config's. */
export type AdapterDeps = { kept: Kept; seen(chat: string, messageId: string): boolean; durations: Durations };
/** The config's durations the platforms' capability tables read (architecture §8.1). */
export type Durations = { feishuEdit: number };

/** What an adapter's profile gives (spec web-topology "头像"): pictures as the platform has them. */
export type Profile = { bot?: Uint8Array; you?: Uint8Array; name?: string };

// ---- Main loop inputs (architecture §2). Everything that happens arrives as one of these. ----

// herdr_wait: how long a slot in the terminal waits for Herdr to come back (architecture §10.2).
// tool_running: a minute more of the tool call a turn's message shows running (key: the conversation).
export type TimerKind = "ask_timeout" | "idle_reap" | "quota_reset" | "quota_notice" | "oneoff_archive" | "herdr_wait" | "tool_running";

/** What rhodium knows about an rh caller (docs/spec/v1.md "rh 怎么认出调用者"). rh reports its own
 *  pid; unit is the systemd unit rhodium finds that pid in, and ancestors that pid and the ones up its
 *  parent chain, each "<pid>:<start time>" as /proc gives them. Neither is taken from rh's request. */
export type RhCaller = { token: string | null; pid: number | null; tty: boolean; cwd: string; unit?: string | null; ancestors?: string[] };

/** What a write from the board does (spec web-write "写请求"): a common command to the slot, as typed
 *  in IM; an rh command, as at your terminal, sure once you confirmed it on the page; new targets for
 *  chats and bots, each with what the page saw before, the slot unarchive names restored first; an
 *  answer to an ask, its text as you would reply in IM; what you typed to the slot, with what you
 *  attached, kept as IM's are (POST /api/send alone sets those); one of those queued for the slot
 *  sent in now, or taken off; how a chat writes tool lines, as /rh_verbose on or off there; or a slot
 *  pinned or not. */
export type BoardAct =
  | { kind: "common"; slot: string; name: CommonCommand; args?: string }
  | { kind: "rh"; argv: string[]; sure?: true }
  | { kind: "bind"; changes: BindChange[]; unarchive?: string }
  | { kind: "answer"; ask: string; text: string }
  | { kind: "say"; slot: string; text: string; attachments?: { kind: "image" | "file"; name: string; path: string; mimeType?: string }[] }
  // The queue (spec web-write "待发队列"): input, the request id it was sent under; now with none lets the paused go on.
  | { kind: "queued"; slot: string; op: "now" | "drop"; input?: string }
  | { kind: "verbose"; chat: string; on: boolean }
  | { kind: "pin"; slot: string; on: boolean };

/** A chat's new target (null: its bot's default), or a bot's new default, by Rhodium's ids; from: what it
 *  was as the page saw it: the slot the chat's messages go to, and whether the chat picked it itself. */
export type BindChange = { chat: string; from: { slot: string | null; use: boolean }; to: string | null } | { bot: string; from: string | null; to: string };

/** A TUI slot's pane as the Herdr bridge opened it (architecture §10.1): Herdr's ids, and its agent's
 *  pid with that process's start time. */
export type TuiPane = { workspace: string; tab: string; pane: string; pid: number; start: number };
/** What a Claude turn ran on, as its transcript says: the effort level and the full model id; and
 *  whether ultracode was on, if a marker says. */
export type Used = { effort?: string; model?: string; ultra?: boolean };

/** A conversation rh import found, with the directory it was started in: on disk, or that of the
 *  agent in a Herdr pane, which goes with it. */
export type ImportFound = { agent: AgentKind; session: string; dir: string; pane?: TuiPane };
/** What rh import alone lists: the agent in a Herdr pane, or a conversation on disk, with when it was
 *  last active and what was said first. */
export type Importable = { agent: AgentKind; session: string; dir: string; pane?: string; at?: number; said?: string };

export type Input =
  | { kind: "im"; message: InboundMessage }
  // credentials: what rh bot's scan or paste gave, kept out of argv so that nothing which records
  // argv ever has them.
  | { kind: "rh"; id: string; caller: RhCaller; argv: string[]; credentials?: Record<string, string> }
  // A write from the board's page (spec web-write): id is the page's, the same when it sends again.
  | { kind: "board"; id: string; act: BoardAct }
  | { kind: "clock"; timer: TimerKind; key: string } // key: the ask, slot or conversation it is for; for quota_notice, the agent kind
  | { kind: "agent"; event: AgentEvent }
  // Rhodium has started: what the state tables say is owed gets done (architecture §5).
  | { kind: "recovery" }
  // The platform refused this outbound record, a passive reply to inbound in chat or an active message
  // (null): for its quota, or not (an active message only). payload: its message, as the record keeps it.
  | { kind: "refused"; outbound: string; chat: string; inbound: string | null; payload: string; quota: boolean }
  // An outbound record failed for good, not to go another way (refused): payload, its message, as the
  // record keeps it. What rh send's message marked its slot's turn with goes (architecture §8.7).
  | { kind: "send_failed"; payload: string }
  // An edit to show text did not take: the platform turned it down, or the message (this outbound
  // record, with its chat and trace) never went out. final: text is the turn's last. markdown: the
  // same in the platform's Markdown.
  | { kind: "edit_failed"; outbound: string; chat: string; trace: string | null; text: string; markdown?: string; final: boolean }
  // Rhodium's own word to you about no slot, for the main chat: a run of rh doctor nobody asked for
  // found something you should hear about, or this build is new (architecture §12).
  | { kind: "notice"; text: string }
  // The bot (row id) failed to reach its platform limits.botFailures times in a row, error the last
  // failure; or it got through, for the first time since it failed (architecture §8.6).
  | { kind: "connection"; bot: string; up: boolean; error?: string }
  // The Herdr bridge opened the slot's pane for its switch to the terminal, or could not, and why.
  // session: the one it opened there, a new one's id, or null for a new Codex thread, whose id comes
  // at its first turn (architecture §10.3).
  | { kind: "tui"; slot: string; opened: (TuiPane & { session: string | null }) | { error: string } }
  // The slot's agent in the terminal is gone and its tab closed, and no one else has the conversation:
  // the slot goes back to headless on the session its pane last reported, null for none yet. Or it can't, and why
  // (architecture §10.1, §10.2); running: because the agent did not exit. elsewhere: the pane last
  // reported another directory's pi session, so the slot keeps the one it had (§6.3). restarted: Herdr
  // restarted while rhodium was away, and took the agent with it. used: what the agent Rhodium launched
  // there by the slot's settings ran last on, from the session its pane last reported, ultra as the
  // newest ultracode marker there says; before: what it started on: for pi, from the lines of that same
  // session before it; for Claude, what the slot's conversation ran on before it, read only while the
  // slot leaves a model or level to your default (§6.3, §10.1). Each absent, or without what no line tells.
  | { kind: "tui_back"; slot: string; back: { session: string | null; elsewhere?: true; restarted?: true; used?: Used; before?: Used } | { error: string; running?: true } }
  // The Herdr bridge lost Herdr's socket, or has it again (architecture §10.2). resumed: the slots
  // whose agent Herdr resumed itself meanwhile, with that agent's pid and start time.
  | { kind: "herdr"; up: false }
  | { kind: "herdr"; up: true; resumed: Record<string, { pid: number; start: number }> }
  // What rh import (call id, or /rh_import in chat) looked up, with no one else using it; or why not;
  // or, asked for nothing, what there is to import, dir's conversations on disk among it. name: the
  // slot's name, if the call gave one. chat: where to answer; point: the chat goes to the slot made
  // from now on (/rh_import typed there), rather than only hearing of it (an rh import you agreed to).
  // panel: how the answer shows, should it come to a press on a panel.
  | { kind: "import"; id: string; chat?: string; point?: true; name?: string; panel?: PanelUi; found: ImportFound | { dir: string; list: Importable[] } | { error: string } };
