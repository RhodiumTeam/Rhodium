// Storage: the only module that touches SQLite (architecture §2, §7).
// State tables are the truth; the event table only feeds the board, resumable clients
// and tracing (ADR-0006). Tables follow docs/spec/v1.md "数据表".
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { AgentKind, Input, Platform } from "./contracts";

// ---- Rows. Timestamps are ms since the epoch, durations are ms, flags are 0 or 1. ----

type Row = { id: string; machine: string };
type Flag = 0 | 1;

export type Workspace = Row & {
  name: string;
  dir: string; // default directory for new slots
  herdrWorkspace: string | null;
};

export type Slot = Row & {
  workspace: string;
  name: string;
  dir: string;
  mode: "headless" | "tui";
  // Product §4's states; TUI is the mode column. waiting: an ask is open (needs you).
  state: "off" | "starting" | "idle" | "running" | "waiting" | "rate_limited" | "crashed";
  conversation: string | null; // current conversation
  parent: string | null;
  lifetime: "longterm" | "oneoff";
  archivedAt: number | null;
  // Per-slot settings from `rh set`; null means the config file's global default.
  approval: Flag | null;
  reapAfter: number | null; // 0 = never reap
  askTimeout: number | null; // 0 = never time out
  crashResume: Flag | null;
  autoContinue: Flag | null;
  // The turn in progress was started by this inbound message in this chat: its final reply goes
  // there and nowhere else (architecture §3). Both null for a turn an internal message started.
  turnChat: string | null;
  turnInbound: string | null;
  // When Rhodium interrupted the turn in progress, until that turn ends: what comes meanwhile is
  // held for the next turn (architecture §6.1). Waiting for quota, when /stop stopped the turn
  // carrying on at the reset.
  interruptedAt: number | null;
  // The agent used rh send me in the turn in progress, so its final reply is not sent (product §5.5).
  turnSentMe: Flag | null;
  // Injected into the slot's agent as RHODIUM_TOKEN; rh carries it to say which slot calls.
  token: string | null;
  // The slot's rh calls in the minute from rhWindowAt on, for the rate limit (product §6.1).
  rhWindowAt: number | null;
  rhCalls: number | null;
  // When the slot's last turn ended: a one-off slot idle since then is archived (product §6.1).
  turnEndedAt: number | null;
  // When its turn began, for /status to say how long it has run (docs/im-style.md §7.1).
  turnStartedAt: number | null;
  // When its agent last started for a command, idle with no turn (product §5.6): the idle reap clock
  // runs from this or turnEndedAt, the later.
  startedIdleAt: number | null;
  // Its agent runs in the approval mode it had before rh set changed it, and can't switch (pi, or a
  // claude that refused): the process is stopped once the slot is idle, and the next one starts in
  // the new mode (architecture §6.3).
  approvalStale: Flag | null;
  // What the slot last reported to its parent in the turn in progress, so each is reported once
  // (architecture §9.2); a new turn clears it.
  reported: "done" | "stuck" | null;
  // In TUI mode, once its pane is open (architecture §10.1): the Herdr tab and pane its agent runs in,
  // and that agent's pid with the start time /proc gives it, so an rh with no token is matched up its
  // parent chain and a reused pid is not. Null while the switch is under way.
  herdrTab: string | null;
  herdrPane: string | null;
  // tuiPid null with the pane on record: its agent is gone, but switching back was given up, as
  // another process has the conversation; it waits for you (architecture §10.2). tuiStart stays, for
  // the next try to read what that agent ran on from when it started.
  tuiPid: number | null;
  tuiStart: number | null;
  // Its agent in the terminal is one Rhodium launched by the slot's settings, so what you changed there
  // is told against them once back (architecture §10.1). Not one Herdr resumed by itself, nor an imported pane's.
  tuiLaunched: Flag | null;
  // When the Herdr bridge lost Herdr's socket, while the slot is in the terminal; null once it is back.
  herdrLostAt: number | null;
  // Waiting for Claude's quota (rate_limited): when it carries on, the reset staggered among the
  // slots waiting (architecture §7.6).
  resumeAt: number | null;
  // Waiting for Claude's quota, you are still to hear so: one notice for each chat tells of all the slots
  // that ran out meanwhile (product §4.6).
  quotaUntold: Flag | null;
  // You agreed to an agent's confirm request to switch this slot to or from the terminal: its decision,
  // JSON of { slot, body }, waits to tell that agent how the switch went (architecture §9.6). Or you
  // switched it from IM: JSON of { chat }, the chat to tell (product §5.9).
  switchDecision: string | null;
  // rh agent came mid-turn: the agent the slot switches to once that turn ends (product §4.7).
  nextAgent: AgentKind | null;
  // You switched it to the terminal yourself (/rh_tui): once its pane is open, Herdr focuses it (architecture §10.1).
  tuiFocus: Flag | null;
  // What /model and /effort last set, given again to each agent process the slot starts; null: the
  // agent's own default (product §5.6). As the agent named them: Claude's model value, pi's provider/id.
  model: string | null;
  effort: string | null;
  // What /ultracode last set, apart from the level (#276): Claude's alone; null, your own settings'.
  ultracode: Flag | null;
  // When it was last active, what the board's list goes by (product §7): a turn began or ended, or it
  // was made or came back from the archive. Null: none of these since it began to be kept (#506).
  activeAt: number | null;
  // When you pinned it on the board, null for not (product §7); kept while it is archived.
  pinnedAt: number | null;
  // When it last took a message of yours from the board: rh send me goes there if that is later than
  // the chat it would go to was written in (product §5.9).
  webAt: number | null;
  // It sent to you this turn with rh send to a destination named, so its report need not say it told
  // you nothing (architecture §9.3); a new turn clears it.
  turnToldYou: Flag | null;
  // Its plan ask timed out this turn, unapproved, and it stops to wait for you: as a child, its turn's
  // end reports it stuck, not done (product §6.1); a new turn clears it.
  turnPlanTimedOut: Flag | null;
};

export type Conversation = Row & {
  slot: string;
  agent: AgentKind;
  sessionId: string | null; // the agent's own session or thread id
  startedAt: number;
  lastActiveAt: number | null;
  crashTimes: string | null; // JSON array of recent crash times, for the circuit breaker
  // JSON of what its turn shows so far, how much of it went out, and on Telegram which message it
  // edits (architecture §7.1).
  // Commits with the out.log offset; cleared when the turn ends.
  progress: string | null;
  // Its agent has background tasks running, which keep it from being reaped (product §4.4).
  background: Flag | null;
  // Its agent has the turn in progress: it took in one of the turn's inputs, or began the turn by
  // itself. Rhodium begins a turn when it hands the agent your message, so a crash before this has
  // no turn to resume (product §4.5). Cleared when the turn ends.
  turnTaken: Flag | null;
};

export type Holder = Row & {
  conversation: string;
  unit: string; // systemd unit name
  proto: number; // hold/<proto>
  outOffset: number; // bytes of out.log already processed
  outStart: number; // where in out.log the current agent process's output begins
  errStart: number; // where in err.log its stderr begins, unless err.log rotated since
  stopRequested: Flag | 2; // rhodium asked it to stop, so its exit is not a crash; 2: the emergency stop did
  exited: Flag; // its exit is on record, so an exit file it left is old news; the next launch clears it
};

// The id doubles as the hold/1 write id. written: in the agent's stdin, not yet taken into its
// conversation; taken: in it, or turned down (architecture §4.6).
export type AgentInput = Row & {
  conversation: string;
  source: "human" | "rh" | "report" | "crash_resume" | "auto_continue" | "confirm";
  status: "queued" | "writing" | "written" | "taken" | "unknown";
  queueReason: string | null;
  body: string | null; // what to write; cleared once taken (architecture §7.1)
  trace: string | null;
  images: string | null; // JSON [{path, mimeType}]: stored pictures to show the agent with body; cleared with it
};

// The bot's token lives in the config file under [bots.<name>], never here.
export type Bot = Row & {
  platform: Platform;
  name: string; // the [bots.<name>] key in the config file
  isMain: Flag;
  // Your user ids under this bot that pairing added, a JSON list; the config's owners come on top
  // (owners(), product §5.11).
  owners: string | null;
  // The code rh pair gave out and until when it works; whoever sends it becomes an owner (architecture
  // §8.5): the only paired one, or with pairAdd (rh pair --add), one more.
  pairCode: string | null;
  pairUntil: number | null;
  pairAdd: Flag | null;
  defaultTarget: string | null;
  // Hashes of the / menu and the row last pushed to the platform, with their chat (architecture §8.4);
  // where the platform has them per chat, a JSON object of them by the chat's platform id.
  menuHash: string | null;
  rowHash: string | null;
  connState: "online" | "reconnecting" | "faulted" | null; // faulted: failing over and over (architecture §8)
};

export type Chat = Row & {
  bot: string;
  platformChatId: string;
  target: string | null; // overrides the bot's default target
  // The last paged panel sent here, for a number you reply with (docs/im-style.md §11.4): JSON of
  // { at, commands, edit? }; cleared by your next message.
  panel: string | null;
  // /rh_verbose: 1 detailed tool lines, 0 short ones; null the platform's default (docs/im-style.md §3.5).
  verbose: Flag | null;
  // When it last became a slot's contact chat: of the chats going to a slot, the latest is its contact chat (product §5.9).
  contactedAt: number | null;
};

export type Inbound = Row & {
  chat: string;
  platformMsgId: string; // unique together with chat: inbound dedupe (architecture §7.3)
  trace: string;
  sender: string;
  receivedAt: number;
  route: string | null; // where it went
  reason: string | null; // why
  text: string | null; // truncated original, only to resolve quotes (architecture §8.3)
  ref: string | null; // what a quote of it names it by: QQ's msg_idx, else platformMsgId
};

export type Outbound = Row & {
  chat: string;
  trace: string | null;
  // held: waiting for your next message, when QQ's quotas left no way to send it (product §5.5).
  status: "pending" | "held" | "sending" | "sent" | "failed" | "unknown";
  platformMsgId: string | null;
  replyTo: string | null; // inbound id this replies to
  qqSeq: number | null; // fixed QQ msg_seq derived from this record (architecture §7.4)
  createdAt: number;
  payload: string | null; // JSON of the message, so a pending send survives a restart; cleared once sent
  text: string | null; // truncated, only to resolve quotes of Rhodium's replies (architecture §8.3)
  ref: string | null; // what a quote of it names it by: QQ's ref_idx, else platformMsgId
  ask: string | null; // the ask it asks, if any, to take its buttons off (or say it was answered) once it is settled
};

export type Ask = Row & {
  slot: string;
  kind: "question" | "plan" | "permission" | "confirm";
  requestId: string | null; // the agent's request id; null for confirm
  prompt: string | null; // JSON of what was asked
  deadline: number | null; // null = never times out
  pushedAt: number | null;
  forwardedTo: string | null; // the chat it was sent to, which takes your answer though it goes to another slot (product §5.3)
  answer: string | null; // JSON
  answeredBy: string | null;
  deliveredAt: number | null;
  // With several asks open, Rhodium lists them for you to pick one by number (product §5.3): its
  // number in the last list you were shown, and when you picked it. Your next message answers the
  // one picked, once it has been sent to you again (pushedAt).
  listNo: number | null;
  pickedAt: number | null;
  // answered: someone answered (you, or the timeout); delivered: the agent has it (architecture §7.5).
  // deferred: a confirm request waiting for its slot's turn to end before it is sent (§9.6).
  status: "deferred" | "open" | "answered" | "delivered" | "cancelled";
};

export type Quota = Row & {
  kind: "qq_passive" | "qq_active";
  owner: string; // inbound message id or bot id
  used: number;
  resetsAt: number | null;
};

// Small key-value facts such as the boot number; id is the key.
export type Meta = Row & { value: string };

export type Tables = {
  workspace: Workspace;
  slot: Slot;
  conversation: Conversation;
  holder: Holder;
  agentInput: AgentInput;
  bot: Bot;
  chat: Chat;
  inbound: Inbound;
  outbound: Outbound;
  ask: Ask;
  quota: Quota;
  meta: Meta;
};
type T = keyof Tables;

type Cols<R> = Exclude<keyof R, "id" | "machine">;
type NullCols<R> = { [K in Cols<R>]: null extends R[K] ? K : never }[Cols<R>];
/** A new row: nullable columns may be left out, the id is generated unless given. */
export type Insert<R> = { [K in Exclude<Cols<R>, NullCols<R>>]: R[K] } & { [K in NullCols<R>]?: R[K] } & {
  id?: string;
};
/** Each column equal to its value, IS NULL for null; a number column may be { before: n } instead, for < n. */
export type Where<R> = { [K in keyof R]?: R[K] | (number extends R[K] ? { before: number } : never) };
export type Patch<R> = { [K in Cols<R>]?: R[K] };

/** What caused the event: the kind of main loop input, or crash recovery at startup. */
export type EventSource = Input["kind"] | "recovery";
export type Event = {
  seq: number;
  machine: string;
  at: number;
  source: EventSource;
  trace: string | null;
  slot: string | null;
  type: string;
  data: unknown; // small JSON
};
export type NewEvent = { source: EventSource; type: string; trace?: string; slot?: string; data?: unknown };

export interface Tx {
  insert<K extends T>(table: K, row: Insert<Tables[K]>): Tables[K];
  get<K extends T>(table: K, id: string): Tables[K] | null;
  find<K extends T>(table: K, where: Where<Tables[K]>): Tables[K][];
  /** Returns how many rows changed, so a filter on the old value makes a compare-and-set. */
  update<K extends T>(table: K, where: Where<Tables[K]>, patch: Patch<Tables[K]>): number;
  delete<K extends T>(table: K, where: Where<Tables[K]>): number;
  /** Appends an event in this transaction and returns its seq. */
  append(event: NewEvent): number;
  /** Deletes the events from before this time (ms since the epoch); returns how many. */
  dropEvents(before: number): number;
}

/** The conversation's inputs going into its agent, or in and not yet taken, oldest first: should the
 *  agent end now, they may or may not have got there (architecture §4.6). */
export const untaken = (tx: Tx, conversation: string): AgentInput[] =>
  (["writing", "written"] as const).flatMap((status) => tx.find("agentInput", { conversation, status })).sort((a, b) => (a.id < b.id ? -1 : 1));

export interface Store {
  /** Runs fn in one transaction: everything it wrote commits together or not at all. */
  tx<R>(fn: (tx: Tx) => R): R;
  /** Events after seq, oldest first. */
  events(after: number, limit?: number): Event[];
  /** The events carrying this trace id, oldest first (rh trace). */
  traced(trace: string): Event[];
  /** The slot's last limit events before seq before, newest first. */
  slotEvents(slot: string, limit: number, before?: number): Event[];
  /** The slot's events of this type from from to to (ms since the epoch), oldest first. */
  slotEventsAt(slot: string, type: string, from: number, to: number): Event[];
  /** The newest event's seq; 0 when there is none. */
  lastSeq(): number;
  /** Calls fn for every event after seq, then for each new one as it commits. Not inside a tx. */
  subscribe(after: number, fn: (e: Event) => void): () => void;
  /** Writes a copy of the whole database to path, which must not exist yet (VACUUM INTO). Not inside a tx. */
  backup(path: string): void;
  /** The bytes of the inbound, outbound and event rows, by the minute they are from (its start), oldest
   *  first: what the size cap counts of the database (architecture §7.8). */
  recordBytes(): { at: number; bytes: number }[];
  close(): void;
}

// ---- Schema. Append a migration to change it; never edit a shipped one. ----

const MIGRATIONS = [
  `
CREATE TABLE workspace (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE, dir TEXT NOT NULL, herdrWorkspace TEXT);
CREATE TABLE slot (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  workspace TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL, mode TEXT NOT NULL,
  state TEXT NOT NULL, conversation TEXT, parent TEXT, lifetime TEXT NOT NULL,
  contactChat TEXT, archivedAt INTEGER, approval INTEGER, reapAfter INTEGER,
  askTimeout INTEGER, crashResume INTEGER, autoContinue INTEGER,
  UNIQUE (workspace, name));
CREATE TABLE conversation (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  slot TEXT NOT NULL, agent TEXT NOT NULL, sessionId TEXT, startedAt INTEGER NOT NULL,
  lastActiveAt INTEGER, crashTimes TEXT);
CREATE TABLE holder (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  conversation TEXT NOT NULL, unit TEXT NOT NULL UNIQUE, proto INTEGER NOT NULL,
  outOffset INTEGER NOT NULL, stopRequested INTEGER NOT NULL);
CREATE TABLE agentInput (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  conversation TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
  queueReason TEXT, body TEXT, trace TEXT);
CREATE TABLE bot (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  platform TEXT NOT NULL, name TEXT NOT NULL UNIQUE, isMain INTEGER NOT NULL,
  ownerId TEXT, defaultTarget TEXT, menuHash TEXT, connState TEXT);
CREATE TABLE chat (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  bot TEXT NOT NULL, platformChatId TEXT NOT NULL, target TEXT,
  UNIQUE (bot, platformChatId));
CREATE TABLE inbound (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  chat TEXT NOT NULL, platformMsgId TEXT NOT NULL, trace TEXT NOT NULL,
  sender TEXT NOT NULL, receivedAt INTEGER NOT NULL, route TEXT, reason TEXT, text TEXT,
  UNIQUE (chat, platformMsgId));
CREATE TABLE outbound (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  chat TEXT NOT NULL, trace TEXT, status TEXT NOT NULL, platformMsgId TEXT,
  replyTo TEXT, qqSeq INTEGER, createdAt INTEGER NOT NULL, payload TEXT, text TEXT);
CREATE TABLE ask (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  slot TEXT NOT NULL, kind TEXT NOT NULL, requestId TEXT, prompt TEXT, deadline INTEGER,
  pushedAt INTEGER, answer TEXT, answeredBy TEXT, deliveredAt INTEGER, status TEXT NOT NULL);
CREATE TABLE quota (id TEXT PRIMARY KEY, machine TEXT NOT NULL,
  kind TEXT NOT NULL, owner TEXT NOT NULL, used INTEGER NOT NULL, resetsAt INTEGER,
  UNIQUE (kind, owner));
CREATE TABLE meta (id TEXT PRIMARY KEY, machine TEXT NOT NULL, value TEXT NOT NULL);
-- AUTOINCREMENT: seqs are never reused, even after old events are pruned.
CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, machine TEXT NOT NULL,
  at INTEGER NOT NULL, source TEXT NOT NULL, trace TEXT, slot TEXT, type TEXT NOT NULL, data TEXT);
`,
  `
ALTER TABLE slot ADD COLUMN turnChat TEXT;
ALTER TABLE slot ADD COLUMN turnInbound TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN interruptedAt INTEGER;
`,
  `
ALTER TABLE slot ADD COLUMN turnSentMe INTEGER;
ALTER TABLE slot ADD COLUMN token TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN rhWindowAt INTEGER;
ALTER TABLE slot ADD COLUMN rhCalls INTEGER;
ALTER TABLE slot ADD COLUMN turnEndedAt INTEGER;
`,
  `
ALTER TABLE holder ADD COLUMN outStart INTEGER NOT NULL DEFAULT 0;
UPDATE holder SET outStart = outOffset;
ALTER TABLE holder ADD COLUMN exited INTEGER NOT NULL DEFAULT 0;
`,
  `
ALTER TABLE conversation ADD COLUMN progress TEXT;
`,
  `
ALTER TABLE bot ADD COLUMN pairCode TEXT;
ALTER TABLE bot ADD COLUMN pairUntil INTEGER;
`,
  `
ALTER TABLE agentInput ADD COLUMN images TEXT;
ALTER TABLE inbound ADD COLUMN ref TEXT;
ALTER TABLE outbound ADD COLUMN ref TEXT;
CREATE INDEX inbound_ref ON inbound (chat, ref);
CREATE INDEX outbound_ref ON outbound (chat, ref);
`,
  `
ALTER TABLE ask ADD COLUMN listNo INTEGER;
ALTER TABLE ask ADD COLUMN pickedAt INTEGER;
ALTER TABLE slot ADD COLUMN approvalStale INTEGER;
`,
  `
ALTER TABLE slot ADD COLUMN reported TEXT;
`,
  `
ALTER TABLE conversation ADD COLUMN background INTEGER;
`,
  `
ALTER TABLE outbound ADD COLUMN ask TEXT;
CREATE INDEX outbound_ask ON outbound (ask);
`,
  // The board's recent events of a slot, and what was sent for them.
  `
CREATE INDEX event_slot ON event (slot, seq);
CREATE INDEX outbound_trace ON outbound (trace);
`,
  `
CREATE INDEX event_trace ON event (trace);
CREATE INDEX event_at ON event (at);
`,
  `
ALTER TABLE slot ADD COLUMN herdrTab TEXT;
ALTER TABLE slot ADD COLUMN herdrPane TEXT;
ALTER TABLE slot ADD COLUMN tuiPid INTEGER;
ALTER TABLE slot ADD COLUMN tuiStart INTEGER;
`,
  `
ALTER TABLE ask ADD COLUMN forwardedTo TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN resumeAt INTEGER;
`,
  `
ALTER TABLE slot ADD COLUMN herdrLostAt INTEGER;
`,
  `
ALTER TABLE slot ADD COLUMN switchDecision TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN nextAgent TEXT;
ALTER TABLE slot ADD COLUMN tuiFocus INTEGER;
`,
  `
ALTER TABLE chat ADD COLUMN verbose INTEGER;
`,
  `
ALTER TABLE chat ADD COLUMN panel TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN model TEXT;
ALTER TABLE slot ADD COLUMN effort TEXT;
`,
  `
ALTER TABLE chat ADD COLUMN contactedAt INTEGER;
ALTER TABLE slot ADD COLUMN quotaUntold INTEGER;
`,
  // written now means not yet taken by the agent; one written before had its body cleared on the
  // holder's ack, and counts as taken, as it did then.
  `
UPDATE agentInput SET status = 'taken' WHERE status = 'written';
`,
  // A turn running at the upgrade is resumed after a crash, as it was before.
  `
ALTER TABLE conversation ADD COLUMN turnTaken INTEGER;
UPDATE conversation SET turnTaken = 1 WHERE id IN (SELECT conversation FROM slot WHERE state IN ('running', 'waiting'));
`,
  `
ALTER TABLE holder ADD COLUMN errStart INTEGER NOT NULL DEFAULT 0;
`,
  `
ALTER TABLE slot ADD COLUMN tuiLaunched INTEGER;
`,
  // ultracode was a level of /effort, xhigh with ultracode on; now a switch of its own (#276).
  `
ALTER TABLE slot ADD COLUMN ultracode INTEGER;
UPDATE slot SET effort = 'xhigh', ultracode = 1 WHERE effort = 'ultracode';
`,
  // The row and the / menu are pushed apart (#300): menuHash keeps the / menu's.
  `
ALTER TABLE bot ADD COLUMN rowHash TEXT;
`,
  `
ALTER TABLE slot ADD COLUMN turnStartedAt INTEGER;
`,
  // A bot may have several owners (#449): its one paired owner is the first of them. What was pushed
  // to your chat with it, on Telegram with a menu per chat, is kept by your user id there now.
  `
ALTER TABLE bot ADD COLUMN owners TEXT;
ALTER TABLE bot ADD COLUMN pairAdd INTEGER;
UPDATE bot SET owners = json_array(ownerId) WHERE ownerId IS NOT NULL;
UPDATE bot SET menuHash = json_object(ownerId, menuHash), rowHash = json_object(ownerId, rowHash) WHERE platform = 'telegram' AND ownerId IS NOT NULL;
ALTER TABLE bot DROP COLUMN ownerId;
`,
  `
ALTER TABLE slot ADD COLUMN startedIdleAt INTEGER;
`,
  // The board's list goes by when a slot was last active (#506): till then, its turn's start if it runs, else its end.
  `
ALTER TABLE slot ADD COLUMN activeAt INTEGER;
ALTER TABLE slot ADD COLUMN pinnedAt INTEGER;
UPDATE slot SET activeAt = COALESCE(turnStartedAt, turnEndedAt);
`,
  // Where rh send to you goes (#593): when you last wrote to the slot on the board, and whether it sent you something itself this turn.
  `
ALTER TABLE slot ADD COLUMN webAt INTEGER;
ALTER TABLE slot ADD COLUMN turnToldYou INTEGER;
`,
  // A child whose plan ask timed out reports stuck as its turn ends (#601).
  `
ALTER TABLE slot ADD COLUMN turnPlanTimedOut INTEGER;
`,
];

/** Sets the meta row id to value, adding the row the first time. */
export function setMeta(store: Store, id: string, value: string): void {
  store.tx((tx) => void (tx.update("meta", { id }, { value }) || tx.insert("meta", { id, value })));
}

/** The meta row with the display name of each model the agent offers, by its id: claudeModels, of
 *  Claude's last handshake, by value; codexModels, of Codex's last model/list, its default also as
 *  "default". That of a process rhodium started, or of rh doctor's. /status names a remembered model by
 *  it while no process runs (docs/im-style.md §2.4). Only an agent with modelNames keeps one. */
export const modelNames = (agent: AgentKind): string => `${agent}Models`;
/** The names the agent's modelNames row keeps; none yet, or none kept, is {}. */
export const namesOf = (tx: Tx, agent: AgentKind): Record<string, string> => JSON.parse(tx.get("meta", modelNames(agent))?.value ?? "{}");

/** The meta row with what each model of that handshake is, by its value: the full model id it
 *  resolves to, if it says, and its effort levels. Switching back from the terminal tells by it whether
 *  you switched models there, and whether Claude narrowed a level (architecture §10.1). */
export const MODEL_INFO = "claudeModelInfo";
export type ModelInfo = Record<string, { resolved?: string; levels: string[] }>;

/** A model of Claude's handshake by the name you read it by (docs/im-style.md §2.4): its display name;
 *  the default's, 默认 and the model it uses, the start of its description up to the first U+00B7, say
 *  默认（Opus 5.5） (architecture §6.1). */
export function claudeModelName(m: { value?: unknown; displayName?: unknown; description?: unknown }): string {
  if (m.value !== "default") return String(m.displayName ?? m.value);
  const uses = typeof m.description === "string" ? m.description.split("\u00b7")[0]!.trim() : "";
  return uses ? `默认（${uses}）` : "默认";
}

/** Keeps the models of a Claude handshake in its modelNames and MODEL_INFO. */
export function setModelNames(store: Store, models: { value?: unknown; displayName?: unknown; description?: unknown; resolvedModel?: unknown; supportedEffortLevels?: unknown }[]): void {
  setMeta(store, modelNames("claude"), JSON.stringify(Object.fromEntries(models.map((m) => [String(m.value), claudeModelName(m)]))));
  const info: ModelInfo = Object.fromEntries(
    models.map((m) => [
      String(m.value),
      { ...(typeof m.resolvedModel === "string" && { resolved: m.resolvedModel }), levels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [] },
    ]),
  );
  setMeta(store, MODEL_INFO, JSON.stringify(info));
}

// ---- ULID: 48-bit ms time + 80 random bits, Crockford base32, sorts by time. ----
// Monotonic: within one ms, or if the clock steps back, the next id keeps the last time
// and adds 1 to the last random part. Queue order (agentInput) depends on this.

/** Crockford base32: no I, L, O or U, so it reads off a screen and types on a phone without mix-ups. */
export const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRand = new Uint8Array(16); // 16 base32 digits

export function ulid(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    lastRand = crypto.getRandomValues(new Uint8Array(16)).map((b) => b % 32);
  } else {
    let i = 15;
    for (; lastRand[i] === 31; i--) lastRand[i] = 0;
    if (i < 0) throw new Error("ulid: random part overflowed within one millisecond");
    lastRand[i]!++;
  }
  let s = "";
  for (let i = 0, t = lastTime; i < 10; i++, t = Math.floor(t / 32)) s = B32[t % 32] + s;
  for (const d of lastRand) s += B32[d];
  return s;
}

// ---- The store. ----

// Column names come from code, but never let one be anything but a plain identifier.
function ident(name: string): string {
  if (!/^[A-Za-z]+$/.test(name)) throw new Error(`store: bad identifier ${JSON.stringify(name)}`);
  return name;
}

function filter(where: object): [string, unknown[]] {
  const parts: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) parts.push(`${ident(k)} IS NULL`);
    else if (typeof v === "object") parts.push(`${ident(k)} < ?`), args.push(v.before);
    else parts.push(`${ident(k)} = ?`), args.push(v);
  }
  return [parts.length ? ` WHERE ${parts.join(" AND ")}` : "", args];
}

function nonEmpty(where: object): void {
  if (!Object.values(where).some((v) => v !== undefined)) {
    throw new Error("store: refusing to update or delete with an empty filter");
  }
}

type EventRow = Omit<Event, "data"> & { data: string | null };
const toEvent = (r: EventRow): Event => ({ ...r, data: r.data === null ? null : JSON.parse(r.data) });

const userVersion = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

/** How far the database at path has migrated, without migrating it; 0 if there is none yet.
 *  deploy/upgrade.sh compares it before and after an upgrade: a rhodium refuses a newer database. */
export function schemaOf(path: string): number {
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readwrite: true, create: false });
  try {
    return userVersion(db);
  } finally {
    db.close();
  }
}

export function openStore(path: string, opts: { machine?: string } = {}): Store {
  const machine = opts.machine ?? hostname();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600); // quoted text and pending messages are private
  db.run("PRAGMA journal_mode = WAL");
  // Another process on rh.db, say one reading it, may hold a lock a moment: wait for it rather than
  // fail, which would drop the inputs of that transaction (architecture §7). The main loop is
  // synchronous, so this is also the longest it can stall.
  db.run("PRAGMA busy_timeout = 5000");

  const version = userVersion(db);
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(`store: ${path} has schema ${version}, newer than this rhodium (${MIGRATIONS.length})`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }

  const get = (table: string, id: string) =>
    db.query(`SELECT * FROM ${ident(table)} WHERE id = ?`).get(id) as any;
  let appended = false;

  const tx: Tx = {
    insert(table, row) {
      const full: Record<string, unknown> = { ...row, id: row.id ?? ulid(), machine };
      const cols = Object.keys(full).filter((k) => full[k] !== undefined);
      db.query(`INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .run(...(cols.map((k) => full[k]) as any[]));
      return get(table, full.id as string);
    },
    get: (table, id) => get(table, id) ?? null,
    find(table, where) {
      const [sql, args] = filter(where);
      return db.query(`SELECT * FROM ${ident(table)}${sql} ORDER BY id`).all(...(args as any[])) as any;
    },
    update(table, where, patch) {
      nonEmpty(where);
      const set = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!set.length) return 0;
      const [sql, args] = filter(where);
      return db
        .query(`UPDATE ${ident(table)} SET ${set.map(([k]) => `${ident(k)} = ?`).join(", ")}${sql}`)
        .run(...(set.map(([, v]) => v) as any[]), ...(args as any[])).changes;
    },
    delete(table, where) {
      nonEmpty(where);
      const [sql, args] = filter(where);
      return db.query(`DELETE FROM ${ident(table)}${sql}`).run(...(args as any[])).changes;
    },
    append(e) {
      appended = true;
      const data = e.data === undefined ? null : JSON.stringify(e.data);
      return Number(
        db
          .query("INSERT INTO event (machine, at, source, trace, slot, type, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(machine, Date.now(), e.source, e.trace ?? null, e.slot ?? null, e.type, data).lastInsertRowid,
      );
    },
    dropEvents: (before) => db.query("DELETE FROM event WHERE at < ?").run(before).changes,
  };

  const events = (after: number, limit = 1000): Event[] =>
    (db.query("SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit) as EventRow[]).map(toEvent);

  type Sub = { last: number; fn: (e: Event) => void };
  const subs = new Set<Sub>();
  // Delivers one event at a time and advances `last` first, so a subscriber that
  // commits its own events from inside fn still sees every event once, in order.
  function deliver(s: Sub): void {
    for (let batch = events(s.last); batch.length && subs.has(s); batch = events(s.last)) {
      for (const e of batch) {
        if (e.seq <= s.last || !subs.has(s)) continue;
        s.last = e.seq;
        try {
          s.fn(e);
        } catch (err) {
          // The transaction already committed; a broken reader must not make it look failed.
          console.error("store: subscriber failed:", err);
        }
      }
    }
  }

  return {
    tx(fn) {
      // IMMEDIATE takes the write lock up front, waiting for it (busy_timeout). A deferred one reads
      // first, and SQLite fails its later upgrade to a write at once, with no wait, when another
      // process holds the WAL write lock. Nested, it is a savepoint as before.
      const result = db.transaction(() => {
        const r = fn(tx);
        if (r instanceof Promise) throw new Error("store: a transaction body must be synchronous");
        return r;
      }).immediate();
      // Nested tx: the outer one delivers once everything has committed.
      if (appended && !db.inTransaction) {
        appended = false;
        for (const s of subs) deliver(s);
      }
      return result;
    },
    events,
    traced: (trace) => (db.query("SELECT * FROM event WHERE trace = ? ORDER BY seq").all(trace) as EventRow[]).map(toEvent),
    slotEvents: (slot, limit, before = Number.MAX_SAFE_INTEGER) =>
      (db.query("SELECT * FROM event WHERE slot = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(slot, before, limit) as EventRow[]).map(toEvent),
    slotEventsAt: (slot, type, from, to) => (db.query("SELECT * FROM event WHERE slot = ? AND type = ? AND at BETWEEN ? AND ? ORDER BY seq").all(slot, type, from, to) as EventRow[]).map(toEvent),
    lastSeq: () => (db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM event").get() as { n: number }).n,
    subscribe(after, fn) {
      // Inside a tx it would read events that may still roll back, and their seqs be reused.
      if (db.inTransaction) throw new Error("store: subscribe outside a transaction");
      const s = { last: after, fn };
      subs.add(s);
      deliver(s);
      return () => subs.delete(s);
    },
    backup(path) {
      if (db.inTransaction) throw new Error("store: backup outside a transaction");
      db.run("VACUUM INTO ?", [path]);
    },
    // ponytail: estimated, the text columns' bytes plus a fixed share for the rest of the row; dbstat if it must be exact.
    recordBytes: () =>
      db
        .query(
          `SELECT at / 60000 * 60000 AS at, SUM(bytes) AS bytes FROM (
             SELECT receivedAt AS at, LENGTH(CAST(COALESCE(text, '') AS BLOB)) + 200 AS bytes FROM inbound
             UNION ALL SELECT createdAt, LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + LENGTH(CAST(COALESCE(text, '') AS BLOB)) + 200 FROM outbound
             UNION ALL SELECT at, LENGTH(CAST(COALESCE(data, '') AS BLOB)) + LENGTH(type) + 100 FROM event
           ) GROUP BY 1 ORDER BY 1`,
        )
        .all() as { at: number; bytes: number }[],
    close: () => db.close(),
  };
}
