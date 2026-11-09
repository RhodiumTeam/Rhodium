// Routing and rules (architecture §2): (current state, input) -> (writes, events, effects).
// A pure function: no network, database or clock. Time and ids come in through ctx, and so does
// the one side effect, rh send --file's copy of its file (architecture §8.3).
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_KINDS, AGENTS, DEFAULT_AGENT } from "./agents";
import { askButtons, askLine, askText, parseAnswer, timeoutAnswer, type Answer, type AskKind, type AskPrompt, type ConfirmInput, type Said } from "./asks";
import { COMMANDS, IM_COMMANDS, homeButtons, imCommand, imUsage, QQ_ROW, SETTINGS, slashMenu, SLOT_HINT, TELEGRAM_ROW, tilde, type Lists, type SettingKey, type SlotEntry } from "./commands";
import { formatDuration, formatGB, fixedOwners, formatMB, owners, paired, parseDuration, type Config } from "./config";
import { FROM_BOARD, parseCommand, quoting, type AgentAsk, type AgentEvent, type AgentKind, type BoardAct, type Button, type Capabilities, type Choice, type CommandResult, type CommonCommand, type Importable, type InboundMessage, type Input, type MenuItem, type PanelUi, type RowButton, type RhCaller, type TimerKind, type Used } from "./contracts";
import { contextText, formatCommand, left, statusText, time, usageText, type SlotInfo } from "./im-commands";
import { fileKind, mediaLine, withoutMedia, type Media } from "./media";
import { buttonRows, CANCEL, layout, moment, PAGE, showPanel, span, unpaged, width, type Candidate, type Panel } from "./panels";
import { amid, MADE, PLATFORMS, series, type BotDef, type Made } from "./platforms";
import { REPORT_LINE, RESUME_PROMPT, sendLine, sourceLine, withoutSource } from "./prompt";
import { append, chunkText, clip, edit, finish, finishEdit, freeze, hide, hush, markdown, md, moveOn, plain, queryMarkdown, runningText, start, type Msg, type Progress, type View } from "./render";
import type { AgentInput, Ask, Bot, Chat, Conversation, Holder, Insert, ModelInfo, NewEvent, Outbound, Patch, Quota, Slot, Tables, Where, Workspace } from "./store";

/** What the router sees: whole tables, read in the same transaction its writes commit in. */
// ponytail: loads every row per input; narrow to what each input needs once tables grow.
export type State = {
  workspaces: Workspace[];
  slots: Slot[];
  conversations: Conversation[];
  bots: Bot[];
  chats: Chat[];
  holders: Holder[];
  queued: AgentInput[]; // agent inputs not yet written
  quotas: Quota[]; // every bot's active quota, and the passive quota of each turn's inbound message
  held: Outbound[]; // messages waiting for your next one (product §5.5)
  hints: Outbound[]; // the hints held messages name in their payload's hintedBy
  asks: Ask[]; // not settled yet: deferred, open, or answered and not yet delivered
  // For an agent's list of the asks it waits on (pending_asks): those on record already, in any status.
  // For an answer from the board: the ask it answers, if on record, in any status.
  listed: Ask[];
  // For an agent's exit: its conversation's inputs still going in, or in and not yet taken, oldest
  // first, which may or may not have got there (architecture §4.6).
  unsure: AgentInput[];
  // The chat each of your messages in queued or unsure came from, by agent input id.
  chatOf: Record<string, string>;
  // For an IM message quoting one on record in its chat (architecture §8.3): that message's stored text, for when the
  // platform gives none; and the slot whose rh send to you it was, led by that slot's name (product §5.3).
  quoted: { text: string | null; slot: string | null } | null;
  // An IM input's message is on record already: the platform delivered it again (architecture §7.3).
  // A board input's id is: the page sent it again, its answer lost (spec web-write).
  seen: boolean;
  // For a turn_start naming the input that began it: your IM message that input carried, if it was one.
  begun: { inbound: string; chat: string } | null;
  // The display name of each model an agent with modelNames offers, by its id (store's modelNames).
  models: Partial<Record<AgentKind, Record<string, string>>>;
  // What each of those models resolves to, and its effort levels (store's MODEL_INFO).
  modelInfo: ModelInfo;
};
/** live: on edit platforms, the outbound record of the turn's one message, once there is one, and
 *  chat, the chat it is in. left: those of the messages the turn moved on from, outgrown or with
 *  something under them, whose last edit may still be to make. told: an agent error was told to you
 *  this turn. toolsOnly: rh send me took the turn over (View); kept here, as rh stop and a switch
 *  forget it on the slot before the turn's last edit (cutShort). */
// lead: the turn's message on went through another bot, its platform out of quota (refused()), and
// says so on top; once: that bot can't edit (QQ), and the message shows this text, under the lead.
export type TurnProgress = Progress & { live?: string; chat?: string; left?: string[]; told?: true; toolsOnly?: true; lead?: { on: string; text: string; once?: string } };
/** capabilities: the table the bot's adapter reports, if it has one (architecture §8.1).
 *  newPairCode: a fresh pairing code no one can guess, for rh pair to give out.
 *  keepFile: copies the file at an absolute path into the media store, as media.ts's keepFile.
 *  diskFree: the free bytes on the disk the state dir is on, read when asked, as the clock is.
 *  herdr: whether Herdr is installed (config.ts's hasHerdr), read when asked as diskFree is.
 *  front: whether a page of the board is in front on some device, as the pages tell it (product §5.9).
 *  retarget: points each bot whose target is the slot from at to, in the config file (config.ts's
 *  renameTarget) and in config; throws when the file cannot be changed so.
 *  inboundOf: the ids of the chat's inbound messages on record, read when asked (rh forget). */
export type Ctx = {
  now: number;
  newId: () => string;
  newPairCode: () => string;
  config: Config;
  capabilities: (bot: string) => Capabilities | undefined;
  keepFile: (path: string, max: number) => { size: number; path?: string } | null;
  diskFree: () => number;
  herdr: () => boolean;
  front: () => boolean;
  retarget: (from: string, to: string) => { bots: string[]; backup: string } | null;
  inboundOf: (chat: string) => string[];
};

export type Write = {
  [K in keyof Tables]:
    | { op: "insert"; table: K; row: Insert<Tables[K]> & { id: string } }
    | { op: "update"; table: K; where: Where<Tables[K]>; patch: Patch<Tables[K]> }
    | { op: "delete"; table: K; where: Where<Tables[K]> };
}[keyof Tables];

/** undo: what the board's page sends to undo the act, as it is (spec web-write "写请求"); slot: the slot
 *  it made, rh new's or an import's, whose chat the page opens; panel: on
 *  the board, what to pick from, as a panel shows it in IM, every candidate at once (spec web-write
 *  "面板回网页"): picked, its command goes as typed; head, the panel's lines, is text too. gone: an
 *  answer from the board to an ask that takes none any more, error saying where or why. */
/** A query's data, as the driver gave it, for the board's info card (spec info-commands "网页"); /usage's
 *  with the agent it is of, whose name its quota goes by. */
export type InfoCard = Extract<CommandResult, { command: "context" }> | (Extract<CommandResult, { command: "usage" }> & { agent: AgentKind }) | StatusCard;
/** /status's card: the agent's part, and the slot's as Rhodium knows it: its name, agent, directory,
 *  state line and running tool as IM has them (docs/im-style.md §7.1), and the commands its buttons
 *  run, none in the terminal (spec info-commands "网页"). */
export type StatusCard = Extract<CommandResult, { command: "status" }> & { ref: string; agent: AgentKind; dir: string; line: string; tool?: string; actions: string[] };
export type RhReply =
  | { ok: true; text: string; undo?: BoardAct; slot?: string; panel?: { head: string[]; candidates: Candidate[] }; card?: InfoCard }
  | { ok: false; error: string; gone?: true };

/** Handed off after the commit. A timer with at = null cancels it. */
export type Effect =
  // sent: rh send's messages to you, which the reply waits for the first try of (architecture §8.7).
  | { kind: "rh_reply"; id: string; reply: RhReply; sent?: string[] }
  // Append [bots.<name>] to the config file and take the bot in. Should the write fail, it answers
  // rh call id with why, and the rh_reply after it finds no one waiting.
  | { kind: "add_bot"; id: string; name: string; table: Record<string, string> }
  // Fetch this bot's profile now (spec web-topology "头像"): your private chat with it has just appeared.
  | { kind: "avatars"; bot: string }
  | { kind: "timer"; timer: TimerKind; key: string; at: number | null }
  // The slot runner: launch the slot's agent, write the conversation's queued inputs, close it.
  | { kind: "start"; slot: string }
  | { kind: "deliver"; conversation: string }
  | { kind: "stop"; conversation: string; brake?: true }
  | { kind: "interrupt"; conversation: string } // stop the current turn, keep the process
  // Give the agent the answer on record for the ask; it is marked delivered once written.
  | { kind: "answer"; conversation: string; ask: string }
  // Switch the running agent's approval mode (product §4.8).
  | { kind: "approval"; conversation: string; on: boolean }
  // Run a common command on the agent; its result comes back as a command_result agent event, with panel.
  | { kind: "command"; conversation: string; command: CommonCommand; args: string; chat: string; inbound: string; panel?: PanelUi }
  // Send a pending outbound record.
  | { kind: "send"; outbound: string }
  // Make a sent outbound record's message show text instead (edit platforms). Newer text replaces
  // text not yet sent. An edit that can't be made comes back as edit_failed. markdown: as in Payload.
  // final: text is the turn's last. unchanged: the message shows text already, if it went out at all.
  | { kind: "edit"; outbound: string; text: string; markdown?: string; final?: true; unchanged?: true }
  // Take the buttons off the messages that ask this ask: it is settled. text: on a platform that
  // edits, what each shows in its place, an answer on the board saying so (spec web-write "提问").
  | { kind: "unbutton"; ask: string; text?: string }
  // Make the message show this instead, buttons and all, none taking them off (a panel's next step on a
  // platform that edits, docs/im-style.md §9.1). One that can't be edited goes as a new message.
  | { kind: "redraw"; chat: string; at: NonNullable<PanelUi["edit"]>; text: string; buttons: Button[]; markdown?: string }
  // Answer the button press (its platform id) in the chat with a notice, "" for none.
  | { kind: "toast"; chat: string; press: string; text: string }
  // Run rh doctor; its report is the reply to the rh call id.
  | { kind: "doctor"; id: string }
  // The Herdr bridge: with the slot's headless agent gone, take the conversation lock, make sure no
  // one else has the conversation, and open it in a pane; what came of it is a tui input.
  | { kind: "tui_open"; slot: string }
  // The Herdr bridge: once the slot's agent in the terminal is gone, close its tab, make sure no one
  // else has the conversation, and say so with a tui_back input. force: end that agent first, with its
  // exit keys, then SIGTERM (/rh_release).
  | { kind: "tui_back"; slot: string; force: boolean }
  // The Herdr bridge: give the slot's tab its name, as rh rename changed it.
  | { kind: "tab_label"; slot: string }
  // rh import (call id, or /rh_import in chat): look up the conversation on disk (its id or the start
  // of it) or the agent in the Herdr pane, and make sure no one else uses it; what came of it is an
  // import input, which carries the rest along.
  // dir: list what there is to import instead, dir's conversations on disk among it.
  | { kind: "import"; id: string; chat?: string; point?: true; name?: string; panel?: PanelUi; what: { session: string } | { pane: string } | { dir: string } }
  // rh trace: where the message (its platform id or trace id) went is the reply to the rh call id.
  | { kind: "trace"; id: string; message: string }
  // rh read: text, then the recent messages of the agent's session started in dir (if it has one yet),
  // are the reply to the rh call id.
  | { kind: "read"; id: string; text: string; dir: string; agent: AgentKind; session: string | null }
  // rh forget: take the chat's avatar and name off the board's cache (spec web-topology "头像").
  | { kind: "forget_avatar"; chat: string };

export type Decision = { writes: Write[]; events: NewEvent[]; effects: Effect[] };

const nothing = (): Decision => ({ writes: [], events: [], effects: [] });

/** The queue reason of a ! message waiting for the turn it interrupts to end. */
const AFTER_INTERRUPT = "after_interrupt";
/** The queue reason of an internal message waiting for the slot's asks to be answered (wake). */
const AFTER_ASKS = "after_asks";
/** The queue reason of a wake of Rhodium's own waiting for room under the running limit (wake). */
const MAX_RUNNING = "max_running";

/** A queued crash resume still waiting for room or disk: its slot resumes by itself once there is
 *  (product §4.5). One let through is the start's, which spawnSpec resumes; the exit drops it. */
export const resumeWaits = (i: AgentInput) => i.status === "queued" && i.source === "crash_resume" && i.queueReason === MAX_RUNNING;
/** The queue reason of an internal message that came while rh stop stopped the slot (wake): the exit starts it again. */
const AFTER_STOP = "after_stop";
/** The queue reason of a message to a slot waiting for Claude's quota: it goes in at the reset (clock). */
const AFTER_QUOTA = "after_quota";
/** The queue reason of an internal message to a slot switching to or in TUI mode (wake): it waits for the switch back. */
const IN_TUI = "tui";
/** The queue reason of an internal message behind a turn with a turn chat, one your message began or
 *  joined (wake): it waits for that turn to end, then runs as a turn of its own, so the agent's answer
 *  to it is not taken for the reply to you (architecture §9.3). */
const AFTER_TURN = "after_turn";
/** The queue reasons of your messages in the board's queue (spec web-write "待发队列"): waiting for the
 *  turn under way to end, to go as the next one, the board's; or paused since a stop, until you let
 *  them go on. */
export const WEB_QUEUE = "web_queue";
export const WEB_PAUSED = "web_paused";
/** What the runner writes past, as nothing after it waits for it (architecture §4.6). */
export const PASSED: readonly (string | null)[] = [AFTER_TURN, WEB_QUEUE, WEB_PAUSED];
/** What your message to a slot in TUI mode gets back (product §4.2, docs/im-style.md §10.2), with
 *  what to do next: while Herdr restarts, it says so. ref: the slot's; home: the bot's default slot's,
 *  when the chat goes to another one (docs/im-style.md §10.2). board: it came from the board, whose
 *  banner takes the slot back (spec web-write). named: the chat goes to another slot, your quote took
 *  the message to this one (im()): the /rh_release you are told to send names it, as a bare one there is not for it. */
function tuiRefused(s: Slot, ref: string, home: string | undefined, board = false, named = false): { text: string; buttons?: Button[] } {
  if (s.herdrLostAt !== null) return { text: `Herdr 正在重启，这条没交给 ${ref}。等一会儿再发。` };
  const release = (label: string): Button => ({ label, data: `/rh_release ${ref}` });
  if (s.herdrPane !== null && s.tuiPid === null) return { text: `${ref} 没能切回无头，这条没交给它。`, buttons: [release("再试一次")] };
  if (board) return { text: `${ref} 在 TUI 里，这条没交给它。点横幅上的“收回终端”把它切回无头。` };
  const text = `${ref} 在 TUI 里，这条没交给它。发 ${home ? `/rh_use - 改和 ${home} 说，或者发 ` : ""}/rh_release ${named ? `${ref} ` : ""}把它切回无头。`;
  return { text, buttons: [release("切回无头"), { label: "换一个槽位", data: "/rh_use" }] };
}

export function route(state: State, input: Input, ctx: Ctx): Decision {
  return panelsLeft(state, routed(state, input, ctx));
}

/** Once a message goes out to a chat, a panel before it is no longer the chat's last: its numbers are
 *  void (docs/im-style.md §11.4). A panel's own message goes out before showIn remembers it. */
function panelsLeft(state: State, d: Decision): Decision {
  const memos = new Map(state.chats.map((c) => [c.id, c.panel]));
  const writes: Write[] = [];
  for (const w of d.writes) {
    writes.push(w);
    if (w.op === "update" && w.table === "chat" && w.patch.panel !== undefined) memos.set(w.where.id!, w.patch.panel);
    if (w.op !== "insert" || w.table !== "outbound") continue;
    const m = memoOf(memos.get(w.row.chat));
    if (!m?.commands) continue;
    memos.set(w.row.chat, unnumbered(m));
    writes.push({ op: "update", table: "chat", where: { id: w.row.chat }, patch: { panel: unnumbered(m) } });
  }
  return { ...d, writes };
}

function routed(state: State, input: Input, ctx: Ctx): Decision {
  if (input.kind === "im") return im(state, input.message, ctx);
  if (input.kind === "agent") return agent(state, input.event, ctx);
  if (input.kind === "clock") return clock(state, input, ctx);
  if (input.kind === "refused") return refused(state, input, ctx);
  if (input.kind === "tui") return tuiOpened(state, input, ctx);
  if (input.kind === "tui_back") return tuiBack(state, input, ctx);
  if (input.kind === "herdr") return herdrLink(state, input, ctx);
  if (input.kind === "import") return imported(state, input, ctx);
  if (input.kind === "edit_failed") return editFailed(state, input, ctx);
  if (input.kind === "send_failed") return unsaid(state, ctx, nothing(), JSON.parse(input.payload) as Payload);
  if (input.kind === "recovery") {
    // Wakes that waited for room, should there be room now: maxRunning may have been raised.
    const d = nothing();
    makeRoom(state, ctx, d);
    // A switch to the terminal whose headless agent was gone, but whose pane the last rhodium had not opened.
    for (const s of state.slots) if (s.mode === "tui" && s.herdrPane === null && (s.state === "off" || s.state === "crashed")) d.effects.push({ kind: "tui_open", slot: s.id });
    return d;
  }
  if (input.kind === "notice") {
    // About no slot: the main chat (product §5.10).
    const d = nothing();
    notify(state, ctx, d, undefined, ctx.newId(), input.text);
    return d;
  }
  if (input.kind === "connection") return connection(state, input, ctx);
  if (input.kind === "board") return board(state, input, ctx);
  if (input.kind !== "rh") return nothing();
  const d = nothing();
  const who = caller(state, input.caller);
  const counted = who.kind === "slot" ? countCall(who.slot, ctx) : null;
  let reply: RhReply | null; // null: an effect replies later
  try {
    if (counted && counted.calls > ctx.config.limits.rhPerMinute) {
      const limit = ctx.config.limits.rhPerMinute;
      const notice = `${slotView(state, counted.slot).ref} 调用 rh 太频繁，超过每分钟 ${limit} 次，超出的调用被拒绝。`;
      // Once a minute is enough to hear about it.
      refuse(`rh 调用太频繁：每分钟最多 ${limit} 次，稍后再试。已通知用户。`, counted.calls === limit + 1 ? notice : undefined);
    }
    const out = rh(state, input, who, ctx, d);
    reply = out === null ? null : { ok: true, text: typeof out === "string" ? out : out.text }; // buttons are IM's alone
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    // A refused command changes nothing.
    d.writes = [];
    d.events = [];
    views.delete(d); // what it took is undone too
    reply = { ok: false, error: err.message };
    if (err.notice && who.kind === "slot") {
      d.events.push({ source: "rh", type: "rh_refused", trace: input.id, slot: who.slot.id, data: { argv: input.argv.slice(0, 1), why: err.notice } });
      notify(state, ctx, d, who.slot, input.id, err.notice);
    }
  }
  if (counted) d.writes.push(counted.write); // refused calls count too
  // rh send to you answers once its messages have been tried, which may have moved them to another bot
  // (architecture §8.7).
  const sent = reply?.ok && d.events.some((e) => e.type === "send_me") ? d.writes.flatMap((w) => (w.op === "insert" && w.table === "outbound" && w.row.status === "pending" ? [w.row.id] : [])) : [];
  if (reply) d.effects.push({ kind: "rh_reply", id: input.id, reply, ...(sent.length && { sent }) });
  return d;
}

/** Counts a slot's rh call in its current minute, or starts a new minute with it. */
// ponytail: a fixed window lets a burst of twice the limit straddle two minutes; a sliding one if that matters.
function countCall(slot: Slot, ctx: Ctx): { slot: Slot; calls: number; write: Write } {
  const fresh = slot.rhWindowAt === null || ctx.now - slot.rhWindowAt >= 60_000;
  const calls = fresh ? 1 : (slot.rhCalls ?? 0) + 1;
  const patch: Patch<Slot> = fresh ? { rhWindowAt: ctx.now, rhCalls: 1 } : { rhCalls: calls };
  return { slot, calls, write: { op: "update", table: "slot", where: { id: slot.id }, patch } };
}

/** Where a reply to the board goes, in place of an IM chat: the page's request, whose id stands in for
 *  the inbound message (answer()). And the turn chat of a turn the board's page began, no chat's id
 *  (spec web-write "网页开始的回合"): its words and reply reach no chat. */
export const BOARD = "board";
/** Who answered an ask on the board, where a chat's id is for one answered in IM (answerAsk()'s by). */
const WEB = "web";
/** The rh commands the board sends (spec web-write "写请求"): what its buttons do. Not a guard, as any
 *  program here can reach the rh socket: it keeps the board to what the page has. */
const BOARD_RH = ["agent", "tui", "release", "stop", "archive", "unarchive", "rm", "rename", "set", "new", "ws", "import"];

/** A write from the board (spec web-write): yours, as at a terminal, by no chat; what it brings about is
 *  the board's, under the request's id. Done once: sent again, it says so. The answer goes back to the
 *  page alone, at once or once an effect is done. */
function board(state: State, { id, act }: Extract<Input, { kind: "board" }>, ctx: Ctx): Decision {
  const d = nothing();
  if (state.seen) {
    d.effects.push({ kind: "rh_reply", id, reply: { ok: true, text: "已经做过了。" } });
    return d;
  }
  let reply: RhReply | null = null; // null: answer() or an effect replies
  try {
    if (act.kind === "common") boardCommon(state, ctx, d, id, act);
    else if (act.kind === "bind") reply = { ok: true, text: boardBind(state, ctx, d, id, act) };
    else if (act.kind === "answer") reply = boardAnswer(state, ctx, d, id, act);
    else if (act.kind === "verbose") reply = { ok: true, text: boardVerbose(state, d, act) };
    else if (act.kind === "pin") reply = { ok: true, text: boardPin(state, ctx, d, act) };
    else if (act.kind === "say") {
      const said = boardSay(state, ctx, d, id, act);
      if (said !== null) reply = { ok: true, text: said };
    } else if (act.kind === "queued") reply = { ok: true, text: boardQueued(state, ctx, d, act) };
    else {
      const [name, ...rest] = act.argv;
      // The emergency stop is not for a phone (product §7): rh stop <slot> only stops that slot.
      if (!BOARD_RH.includes(name!) || (name === "stop" && (rest.length !== 1 || rest[0]!.startsWith("-")))) refuse(`看板不做 rh ${act.argv.join(" ")}。`);
      // A directory as you write it on a phone, under ~, which no shell expands here: a new workspace's,
      // or the one to look in for what to import.
      const argv = act.argv.map((a, i) => ((name === "ws" && i === 2) || (name === "import" && act.argv[i - 1] === "--dir") ? a.replace(/^~(?=\/|$)/, homedir()) : a));
      const out = rh(state, { kind: "rh", id, caller: AT_BOARD, argv }, { kind: "you", board: true }, ctx, d);
      // What there is to import comes back as IM's panel, every candidate at once (imported()).
      d.effects = d.effects.map((e) => (e.kind === "import" ? { ...e, chat: BOARD } : e));
      // An archive comes with its undo, which the page offers for a few seconds (story 268); a new slot
      // with its id, whose chat the page opens (story 320).
      const undo = name === "archive" && d.events.some((e) => e.type === "slot_archived") ? { undo: undoArchive(state, ctx, findSlot(state, rest[0]!)) } : {};
      const made = d.events.find((e) => e.type === "slot_created")?.slot;
      if (out !== null) reply = { ok: true, text: typeof out === "string" ? out : out.text, ...undo, ...(made && { slot: made }) }; // buttons are IM's
    }
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    // A refused act changes nothing, and leaves no record: sent again, it is refused again.
    Object.assign(d, nothing());
    views.delete(d);
    reply = { ok: false, error: err.message };
  }
  if (reply?.ok !== false) {
    // What it gave back stays on the trace of the message given back, which the page and 详情 find it by.
    d.events = d.events.map((e) => ({ ...e, source: "board" as const, trace: (e.type === "input_returned" && e.trace) || id }));
    // A message's own record is board_routed, its text there, kept as IM's is (architecture §8.3).
    const data = act.kind === "say" ? { kind: act.kind, slot: act.slot } : act;
    d.events.unshift({ source: "board", type: "board_act", trace: id, ...(act.kind === "common" && { slot: act.slot }), data });
  }
  if (reply) d.effects.push({ kind: "rh_reply", id, reply });
  return d;
}

/** The board's rh calls are yours, as at a terminal. */
const AT_BOARD: RhCaller = { token: null, pid: null, tty: true, cwd: "/" };

/** What undoes the board's archive of s (spec web-write "归档和撤销"): s back, and each chat the archive
 *  took back to its bot's default pointed at s again, if it is still as the archive left it. */
function undoArchive(state: State, ctx: Ctx, s: Slot): BoardAct {
  const changes = state.chats
    .filter((c) => c.target === s.id)
    .map((c) => ({ chat: c.id, from: { slot: target(state, state.bots.find((b) => b.id === c.bot)!, undefined, ctx)?.id ?? null, use: false }, to: s.id }));
  return { kind: "bind", unarchive: s.id, changes };
}

/** New targets from the board (spec web-write "拓扑图上的改绑定"): each chat's and bot's, all done only
 *  if each was as the page saw it, else none; the slot unarchive names first comes back from the
 *  archive (an archive's undo). Returns the reply. */
function boardBind(state: State, ctx: Ctx, d: Decision, id: string, act: Extract<BoardAct, { kind: "bind" }>): string {
  const back = act.unarchive === undefined ? undefined : findSlot(state, act.unarchive);
  const ref = (s: Slot) => slotView(state, s).ref;
  const stale = (now: string): never => refuse(`${now}，${back ? `没有撤销。${ref(back)} 还在已归档里，能从那里恢复。` : "这一批都没改。"}`);
  const slot = (id: string) => {
    const s = findSlot(state, id);
    if (s.archivedAt !== null && s !== back) refuse(`${ref(s)} 已归档。`);
    return s;
  };
  const chats: [Chat, Slot | null][] = [];
  const bots: [Bot, Slot][] = [];
  for (const c of act.changes) {
    if ("chat" in c) {
      const chat = state.chats.find((x) => x.id === c.chat) ?? refuse("没有这个聊天窗口。");
      const now = target(state, state.bots.find((b) => b.id === chat.bot)!, chat, ctx);
      if ((now?.id ?? null) !== c.from.slot || (chat.target !== null) !== c.from.use) stale(`${chatName(state, ctx, chat)}${now ? `已经改交给 ${ref(now)}` : "现在不交给任何槽位"}`);
      chats.push([chat, c.to === null ? null : slot(c.to)]);
    } else {
      const bot = state.bots.find((b) => b.id === c.bot) ?? refuse("没有这个 Bot。");
      const now = target(state, bot, undefined, ctx);
      if ((now?.id ?? null) !== c.from) stale(`${botName(ctx, bot)} 的默认目标${now ? `已经改成 ${ref(now)}` : "已经没有了"}`);
      bots.push([bot, slot(c.to)]);
    }
  }
  if (new Set(act.changes.map((c) => ("chat" in c ? c.chat : c.bot))).size < act.changes.length) refuse("同一处改了两次。");
  const text = back ? rh(state, { kind: "rh", id, caller: AT_BOARD, argv: ["unarchive", back.id] }, { kind: "you", board: true }, ctx, d) : `已改 ${act.changes.length} 处。`;
  rebind(state, ctx, d, chats, bots);
  return text as string;
}

/** How a chat writes tool lines, from its details on the board's topology (story 319): as /rh_verbose
 *  on or off there, which hears nothing of it. Returns the reply. */
function boardVerbose(state: State, d: Decision, act: Extract<BoardAct, { kind: "verbose" }>): string {
  const chat = state.chats.find((c) => c.id === act.chat) ?? refuse("没有这个聊天窗口。");
  d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { verbose: act.on ? 1 : 0 } });
  return act.on ? `工具行改成详细：${DETAILED}。` : `工具行改成简略：${SHORT}。`;
}

/** 置顶 or 取消置顶 from a row's menu (product §7): the slot pinned from now, or not. Returns the reply. */
function boardPin(state: State, ctx: Ctx, d: Decision, act: Extract<BoardAct, { kind: "pin" }>): string {
  const s = findSlot(state, act.slot);
  d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { pinnedAt: act.on ? ctx.now : null } });
  return `已${act.on ? "" : "取消"}置顶 ${slotView(state, s).ref}。`;
}

/** An answer from an ask's card on the board (spec web-write "提问"), as you would reply in IM, to an
 *  ask still open; one settled says where or why, and that it is gone. It leaves rh send me's hold on
 *  the turn: you are on the board. IM hears it was answered here: on a platform that edits, in place of
 *  the ask; else in a line to the chat it went to, which may wait for no reply. Returns what you are told. */
function boardAnswer(state: State, ctx: Ctx, d: Decision, id: string, act: Extract<BoardAct, { kind: "answer" }>): RhReply {
  const a = state.asks.find((x) => x.id === act.ask && x.status === "open");
  if (!a) return { ok: false, error: askGone(state, ctx, state.listed[0]?.answeredBy), gone: true };
  const slot = state.slots.find((s) => s.id === a.slot)!;
  const r = parseAnswer(a.kind, prompt(a), act.text) ?? refuse("没看懂这个回答。");
  const said = `已在网页回答：${r.said}`;
  const to = toChat(state, a.forwardedTo, ctx);
  const edits = to?.caps?.progress === "edit";
  // The ask as it was sent there, its last message the one with the buttons.
  const shown = edits ? `${askMessages({ ...a, prompt: prompt(a) }, askFrom(state, ctx, slot, to.chat), to.caps).at(-1)!.text}\n\n${said}` : undefined;
  const result = answerAsk(state, ctx, d, slot, a, r.answer, WEB, undefined, shown);
  // You wrote to it here last, as an answer in IM is contact there (product §5.9).
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { webAt: ctx.now } });
  if (to && !edits && place(quotas(state, ctx, d), to, null).status === "pending") outbound(d, ctx, { chat: to.chat.id, replyTo: null, trace: id, text: said });
  return { ok: true, text: r.receipt + (result ?? "") };
}

/** Why an ask takes no answer any more, as the board says it: where it was answered, the chat by its
 *  name, or with that chat forgotten since (rh forget), no more than that; that it timed out; else,
 *  answered by no one, that it was withdrawn. by: who answered it. */
export function askGone(state: Pick<State, "bots" | "chats">, ctx: Pick<Ctx, "config">, by: string | null | undefined): string {
  if (by === "timeout") return "已超时";
  if (by === WEB) return "已在网页回答";
  const chat = state.chats.find((c) => c.id === by);
  return chat ? `已在 ${chatName(state, ctx, chat)}回答` : by ? "已回答" : "提问已撤回";
}

/** A common command from the board, as typed in IM (im()): before the slot's asks, so the stop works
 *  while one waits; in the terminal, only /status. Its answer goes to the page (answer()), once the
 *  agent has given it, if it is the agent's to give. */
function boardCommon(state: State, ctx: Ctx, d: Decision, id: string, act: Extract<BoardAct, { kind: "common" }>): void {
  const slot = state.slots.find((s) => s.id === act.slot) ?? refuse("没有这个槽位。");
  if (slot.mode === "tui") refuse(tuiRefused(slot, slotView(state, slot).ref, undefined, true).text);
  // You wrote to it here last, as a common command in IM is contact there (product §5.9).
  const patch: Patch<Slot> = { webAt: ctx.now };
  common(state, slot, { name: act.name, args: act.args ?? "" }, patch, d, ctx, BOARD, id);
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
}

/** Where the board has the Rhodium commands it does elsewhere (spec web-write "网页开始的回合"): typed
 *  into a chat on the board they only say so. /rh_release run as yours would skip the page's only
 *  confirm; the rest want a chat and its bot, which the page is not. */
export const ELSEWHERE: Record<string, string> = {
  use: "改绑定在拓扑图上做。",
  bind: "改绑定在拓扑图上做。",
  verbose: "工具行的写法在拓扑图上改：点开那个窗口的详情。",
  ls: "槽位都在首页和拓扑图上。",
  help: "打 / 看命令面板。",
  release: "点横幅上的“收回终端”把它切回无头。",
};

/** What you typed into a slot's chat on the board (spec web-write "网页开始的回合"), read as IM reads
 *  yours (im()): ! and the commands Rhodium knows as there, then to the slot's agent, its first line
 *  [来自 网页]. The turn it begins is the board's, by no chat, and the board is no contact chat. What is
 *  turned away, say for an ask waiting on you, changes nothing. Returns where it went, or null for a
 *  command that answers itself. */
function boardSay(state: State, ctx: Ctx, d: Decision, id: string, act: Extract<BoardAct, { kind: "say" }>): string | null {
  const slot = state.slots.find((s) => s.id === act.slot) ?? refuse("没有这个槽位。");
  const attachments = act.attachments ?? [];
  const bang = /^[!！]\s*/.exec(act.text);
  const text = bang ? act.text.slice(bang[0].length) : act.text;
  const cmd = bang && !text.trim() && !attachments.length ? ({ kind: "common", name: "stop", args: "" } as const) : parseCommand(text);
  // Rhodium's own, about this slot, as one typed in a chat is about the slot it goes to.
  if (cmd?.kind === "rh") return ELSEWHERE[cmd.word.slice("/rh_".length)] ?? rhCommand(state, cmd, slot, { chat: BOARD, inbound: id }, ctx, d);
  if (cmd?.kind === "common") {
    boardCommon(state, ctx, d, id, { kind: "common", slot: slot.id, name: cmd.name, args: cmd.args });
    return null;
  }
  const ref = slotView(state, slot).ref;
  const body = [text, ...attachments.map(mediaLine)].filter(Boolean).join("\n");
  if (!body.trim()) refuse("没有要发的。");
  // The page shows the ask in place of where you type; this is for one that came meanwhile.
  if (openAsks(state, slot).length && !bang) refuse(`${ref} 有提问在等你，先答提问。`);
  if (slot.mode === "tui") refuse(tuiRefused(slot, ref, undefined, true).text);
  roomFor(ctx, slot, ref);
  const images = attachments.flatMap((a) => (a.mimeType ? [{ path: a.path, mimeType: a.mimeType }] : []));
  // You wrote to it here last, for where rh send me goes (product §5.9).
  const patch: Patch<Slot> = { webAt: ctx.now };
  const r = toAgent(state, ctx, d, slot, patch, { body, line: sourceLine(FROM_BOARD), bang: bang !== null, images, queue: true }, { turnChat: BOARD, turnInbound: id });
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
  d.events.push({ source: "board", type: "board_routed", trace: id, slot: slot.id, data: { reason: r.reason, text: clip(body, ctx.config.limits.quoteMaxChars) } });
  return r.told ?? r.reason;
}

/** Refuses your message from the board to a slot it would start, short of free disk (architecture §7.8). */
function roomFor(ctx: Ctx, slot: Slot, ref: string): void {
  if ((slot.state === "off" || slot.state === "crashed") && lowDisk(ctx)) refuse(`磁盘只剩 ${(ctx.diskFree() / 2 ** 30).toFixed(1)} GB，这条没交给 ${ref}。清出空间再发。`);
}

/** Your messages from the board to the slot still queued for its agent (spec web-write "待发队列"): no
 *  chat's, as no inbound record has them; each by the id of the request it came in. */
const fromBoard = (state: State, slot: Slot) => state.queued.filter((i) => i.conversation === slot.conversation && i.source === "human" && i.trace && !state.chatOf[i.id]);

/** One of your messages in the board's queue, by the id of the request it came in (spec web-write
 *  "待发队列"). Sent now, it goes to the agent, joining the turn under way or beginning one, the board's,
 *  unless an ask waits on you; dropped, it is gone. Those Rhodium holds for you, for an interrupt, the
 *  quota or a stop, can only be dropped. With none named, now lets the paused go on: after the turn
 *  under way, at the quota's reset, or at once with neither. */
function boardQueued(state: State, ctx: Ctx, d: Decision, act: Extract<BoardAct, { kind: "queued" }>): string {
  const slot = state.slots.find((s) => s.id === act.slot) ?? refuse("没有这个槽位。");
  const ref = slotView(state, slot).ref;
  const mine = fromBoard(state, slot);
  const patch: Patch<Slot> = {};
  let r: { reason: string; told?: string };
  if (act.input === undefined) {
    const paused = mine.filter((i) => i.queueReason === WEB_PAUSED);
    if (!paused.length) return "没有暂停的。";
    if (slot.state === "starting" || slot.state === "running" || slot.state === "waiting") {
      releaseQueued(d, slot.conversation!, WEB_PAUSED, WEB_QUEUE);
      return "这一回合跑完就发。";
    }
    roomFor(ctx, slot, ref);
    // The first begins the turn, or waits for the quota's reset as one sent then does; the rest join it,
    // as those queued do at a turn's end.
    r = toAgent(state, ctx, d, slot, patch, { input: paused[0]! }, { turnChat: BOARD, turnInbound: paused[0]!.trace! });
    releaseQueued(d, slot.conversation!, WEB_PAUSED, slot.state === "rate_limited" ? AFTER_QUOTA : null);
  } else {
    const i = mine.find((i) => i.trace === act.input) ?? refuse("这条已经交给 agent 了。");
    if (act.op === "drop") {
      d.writes.push({ op: "delete", table: "agentInput", where: { id: i.id, status: "queued" } });
      d.events.push({ source: "board", type: "input_returned", slot: slot.id, trace: i.trace!, data: { why: "删掉了" } });
      return "删掉了。";
    }
    if (i.queueReason !== WEB_QUEUE && i.queueReason !== WEB_PAUSED) refuse("这条在等 Rhodium 放行，只能删掉。");
    if (openAsks(state, slot).length) refuse(`${ref} 有提问在等你，先答提问。`);
    if (slot.mode === "tui") refuse(tuiRefused(slot, ref, undefined, true).text);
    roomFor(ctx, slot, ref);
    r = toAgent(state, ctx, d, slot, patch, { input: i }, { turnChat: BOARD, turnInbound: i.trace! });
  }
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
  return r.told ?? r.reason;
}

// ---- IM messages (product §5.3). TUI mode and rate limits come with later issues. ----

function im(state: State, m: InboundMessage, ctx: Ctx): Decision {
  const d = nothing();
  const bot = state.bots.find((b) => b.id === m.bot);
  // Handled the first time: recording it and where it went committed together, before any effect.
  // The unique key on the inbound table backs this up.
  if (!bot || state.seen) return d;
  let chat = state.chats.find((c) => c.bot === bot.id && c.platformChatId === m.chat);
  const fresh = !chat;
  if (!chat) {
    chat = { id: ctx.newId(), machine: "", bot: bot.id, platformChatId: m.chat, target: null, panel: null, verbose: null, contactedAt: null };
    d.writes.push({ op: "insert", table: "chat", row: { id: chat.id, bot: bot.id, platformChatId: m.chat } });
    // What this message leads to finds the chat as it would once stored: its replies have buttons.
    state = { ...state, chats: [...state.chats, chat] };
  }
  // The inbound id doubles as the trace id of everything this message leads to.
  const id = ctx.newId();
  const attachments = m.attachments ?? [];
  const own = owners(bot, ctx.config);
  const yours = own.includes(m.sender);
  const record = (slot: string | null, reason: string) => {
    const row = {
      id, chat: chat.id, platformMsgId: m.messageId, trace: id, sender: m.sender, receivedAt: m.at, route: slot, reason,
      // Only your text is kept, and only its start: for a later quote of it (architecture §8.3).
      ref: m.ref ?? m.messageId,
      ...(yours && { text: clip([m.text, ...attachments.map(mediaLine)].filter(Boolean).join("\n"), ctx.config.limits.quoteMaxChars) }),
    };
    d.writes.push({ op: "insert", table: "inbound", row });
    d.events.push({ source: "im", type: "im_routed", trace: id, ...(slot && { slot }), data: { reason } });
    return d;
  };

  // The code rh pair gave out, sent in time: its sender is an owner of this bot from now on, in place
  // of those paired before, or with rh pair --add beside them (product §5.11, architecture §8.5). It
  // works once. One to replace them is void once the config names an owner: one given out before that.
  if ((bot.pairAdd || !ctx.config.bots[bot.name]?.owner) && bot.pairCode !== null && ctx.now < bot.pairUntil! && m.text.trim().toUpperCase() === bot.pairCode) {
    const now = bot.pairAdd ? [...paired(bot).filter((o) => o !== m.sender), m.sender] : [m.sender];
    d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { owners: JSON.stringify(now), pairCode: null, pairUntil: null, pairAdd: null } });
    d.events.push({ source: "im", type: "bot_paired", trace: id, data: { bot: bot.name } });
    if (m.chat === m.sender) d.effects.push({ kind: "avatars", bot: bot.id });
    reply(d, ctx, chat.id, id, `已配对，以后 Bot ${bot.name} ${bot.pairAdd ? "也" : "只"}认这个账号。`);
    return record(null, "配对");
  }
  // Only you trigger an agent (product §12): the bot's owners. No one else gets a reply, nor does
  // anyone before pairing: a stranger learns nothing from the bot.
  if (!own.length) return record(null, "忽略：还没配对");
  if (!yours) return record(null, "忽略：不是本人");
  // Telegram's 开始 sends /start, say once the chat is cleared and the row maybe gone with it: the row
  // is pushed again (architecture §8.4). /start goes on to the agent as ever.
  if (!m.button && /^\/start(@\S*)?(\s|$)/.test(m.text.trim()) && ctx.capabilities(bot.id)?.menu.row === "reply_keyboard")
    d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { rowHash: JSON.stringify({ ...JSON.parse(bot.rowHash ?? "{}"), [m.chat]: null }) } }); // a row per chat (architecture §8.4)
  // Your avatar and name under the bot are kept by your private chat with it: there at last, they
  // come now, not with the next day's refresh.
  if (fresh && m.chat === m.sender) d.effects.push({ kind: "avatars", bot: bot.id });
  // The panel open here, if any (docs/im-style.md §9.1). Your message is this chat's last now: its
  // numbers are void after this one, which may still pick from it (§11.4).
  const memo = memoOf(chat.panel);
  if (memo?.commands) d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { panel: unnumbered(memo) } });
  // A voice message with no transcript, Telegram's: you are told, nothing reaches the agent (product §5.4).
  if (m.voice) {
    reply(d, ctx, chat.id, id, "暂不支持语音，这条没交给 agent。用文字再发一遍。");
    return record(null, "暂不支持语音");
  }
  // A button press (product §5.8). One that answers an ask does so while the ask is open; else it is
  // 已失效, and nothing reaches the agent. One on a list to pick from runs its command, as if typed.
  // Every press gets an answer: the platform waits for one.
  const toast = (text: string) => d.effects.push({ kind: "toast", chat: chat.id, press: m.messageId, text });
  const pick = m.button && /^ask:(\w+):(\d+)$/.exec(m.button.data);
  // One of the list of asks to pick from (answerFromIm), as its number would.
  const choose = m.button && /^pick:(\w+)$/.exec(m.button.data);
  if (pick || choose) {
    const a = state.asks.find((x) => x.id === (pick ?? choose)![1] && x.status === "open");
    const s = a && state.slots.find((x) => x.id === a.slot);
    if (!a || !s) {
      toast(STALE);
      return record(null, "按钮已失效");
    }
    toast("");
    if (choose) {
      resendAsk(state, ctx, d, a, chat, id);
      return record(s.id, "提问：按钮选了一条");
    }
    const r = parseAnswer(a.kind, prompt(a), pick![2]!)!;
    const result = answerAsk(state, ctx, d, s, a, r.answer, chat.id, id);
    const said = receipt(state, ctx, a, chat, r) + (result ?? "");
    // Yours, on a platform that edits, the answer takes the place of the buttons (docs/im-style.md §5.4).
    const own = a.kind === "confirm" && !(prompt(a).input as ConfirmInput).from;
    const edit = own && ctx.capabilities(bot.id)?.progress === "edit" && m.button!.message;
    if (edit) answer(d, ctx, { chat: chat.id, inbound: id, ui: { edit: { message: edit } } }, `${askText(a.kind, prompt(a), "", true)}\n\n${said}`);
    else reply(d, ctx, chat.id, id, said);
    return record(s.id, "按钮回答提问");
  }
  if (m.button) toast("");
  const caps = ctx.capabilities(bot.id);
  // A page button names the page and the command that shows the panel (docs/im-style.md §11.4). A
  // number picks from the paged panel that is this chat's last message (Memo, panelsLeft()), unless
  // an ask waits for an answer, or it quotes a slot's rh send led by its name: it is for that slot (product §5.3).
  const paged = m.button && /^page:(\d+):(.+)$/s.exec(m.button.data);
  const n = !m.button && /^\d+$/.test(m.text.trim()) ? Number(m.text.trim()) : 0;
  const bound = target(state, bot, chat, ctx);
  // The slot whose rh send you quote, unless it is gone or is the one this chat goes to: then all goes as ever (architecture §8.3).
  const quotedFrom = state.quoted?.slot ? state.slots.find((s) => s.id === state.quoted!.slot && s.id !== bound?.id) : undefined;
  const asked = () => state.asks.some((a) => a.status === "open" && (a.forwardedTo === chat.id || a.slot === bound?.id));
  const byNumber = n && memo?.commands && !asked() && !quotedFrom ? memo.commands[n - 1] : undefined;
  // On a platform that edits, what a press leads to shows in place of the message pressed.
  const edit = caps?.progress !== "edit" ? undefined : m.button?.message ? { message: m.button.message } : byNumber ? memo!.edit : undefined;
  const ui: PanelUi = { ...(paged && { page: Number(paged[1]) }), ...(edit && { edit }) };
  const said = paged?.[2] ?? byNumber ?? m.button?.data ?? m.text;
  // A press or a number moves the panel on, its next step, if any, remembered anew (showIn); a command
  // you type leaves it, on a platform that edits as 取消 would (docs/im-style.md §9.1).
  const typed = !m.button && !byNumber && m.text.trimStart().startsWith("/");
  if (memo && (m.button || byNumber || typed)) {
    if (typed && memo.edit && memo.gone) d.effects.push({ kind: "redraw", chat: chat.id, at: memo.edit, text: memo.gone, buttons: [] });
    d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { panel: null } });
  }
  // Your message on QQ brings a few passive replies of its own (product §5.5).
  if (caps?.sendLimit.kind === "qq_quota") {
    const row = { id: ctx.newId(), machine: "", kind: "qq_passive" as const, owner: id, used: 0, resetsAt: m.at + ctx.config.durations.qqPassiveWindow };
    d.writes.push({ op: "insert", table: "quota", row });
    // It brings what waits in this chat. Only once 完成，回任意字查看 reached you is that all it
    // is for, a command too; else it goes on as well.
    const waiting = state.held.filter((o) => o.chat === chat.id);
    if (waiting.length) {
      const told = waiting.some((o) => state.hints.some((h) => h.id === payload(o).hintedBy && h.status === "sent"));
      releaseHeld({ ...state, quotas: [...state.quotas, row] }, ctx, d, { chat, bot, caps }, waiting, id);
      if (told) return record(null, "补发等着的消息");
    }
  }
  // A panel's [取消] (docs/im-style.md §9.1): on a platform that edits, the message reads as it did,
  // its page line gone, with 已取消 under it, its buttons off; else a message says so.
  if (m.button?.data === CANCEL || m.button?.data === LEVEL_KEPT) {
    const was = m.button.text && unpaged(m.button.text);
    // /model's second step with no level set: the model is switched, and no 已取消 (§9.1, §9.5). On
    // Telegram the step's question goes, the model picked stays.
    if (m.button.data === LEVEL_KEPT) {
      if (edit && was) answer(d, ctx, { chat: chat.id, inbound: id, ui: { edit } }, was.split("\n").slice(0, -1).join("\n"));
      else reply(d, ctx, chat.id, id, "思考强度没改。");
    } else if (edit) answer(d, ctx, { chat: chat.id, inbound: id, ui: { edit } }, was ? `${was}\n已取消` : "已取消");
    else reply(d, ctx, chat.id, id, "已取消，没有改动。");
    return record(null, "面板：取消");
  }
  // A leading ! interrupts the running turn first (product §5.3); so does a phone keyboard's ！.
  const bang = /^[!！]\s*/.exec(said);
  const text = bang ? said.slice(bang[0].length) : said;
  // A bare ! leaves nothing to send, so it is /stop; a picture or a file captioned ! still has something.
  const cmd = bang && !text.trim() && !attachments.length ? ({ kind: "common", name: "stop", args: "" } as const) : parseCommand(text);
  // Rhodium's own commands need no target slot (product §5.3).
  if (cmd?.kind === "rh") {
    const at = { chat: chat.id, inbound: id, ui, ...(m.button?.text !== undefined && { pressed: m.button.text }) };
    const said = rhCommand(state, cmd, bound, at, ctx, d, { bot, chat });
    if (said !== null) answer(d, ctx, { chat: chat.id, inbound: id, ui }, said);
    return record(null, "Rhodium 命令");
  }
  // /stop on a slot named, from its details in /rh_ls (docs/im-style.md §8.3).
  if (cmd?.kind === "common" && cmd.name === "stop" && cmd.args.trim()) {
    const other = slotNamed(state, cmd.args.trim());
    if (typeof other === "string") {
      answer(d, ctx, { chat: chat.id, inbound: id, ui }, other);
      return record(null, "通用命令 /stop：没有这个槽位");
    }
    const patch: Patch<Slot> = {};
    const why = common(state, other, { name: "stop", args: "" }, patch, d, ctx, chat.id, id, ui);
    d.writes.push({ op: "update", table: "slot", where: { id: other.id }, patch });
    return record(other.id, why);
  }
  // Your quote of another slot's rh send to you, led by its name, is for that slot: it goes there, not
  // to the slot this chat goes to, as rh send would, an archived one brought back (product §5.3). A command goes as ever.
  const sender = !cmd ? quotedFrom : undefined;
  const slot = sender ?? bound;
  // An ask pushed here that this chat does not go to, say a child's in its root slot's chat or one
  // another bot forwarded (tell()), takes your answer here, before the slot this chat goes to (product §5.3).
  // With asks of another slot too, this chat's or another one pushed here, you pick from one list of them all.
  const away = !bang && !cmd && !sender ? state.asks.filter((a) => a.status === "open" && a.forwardedTo === chat.id && a.slot !== slot?.id) : [];
  if (away.length) {
    const asks = state.asks.filter((a) => away.includes(a) || (a.status === "open" && a.slot === slot?.id));
    const one = asks.every((a) => a.slot === away[0]!.slot);
    return record(one ? away[0]!.slot : null, answerFromIm(state, ctx, d, asks, text, attachments.length > 0, chat, id));
  }
  if (!slot?.conversation) return record(null, "没有目标槽位");
  const patch: Patch<Slot> = {};
  // What reaches the slot makes this chat the latest to write (product §5.9); a message turned away does not.
  const done = (reason: string, reached = true) => {
    if (reached) contacted(d, ctx, chat.id);
    d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
    return record(slot.id, reason);
  };
  const tui = slot.mode === "tui";
  // In TUI the agent is the terminal's; /status is Rhodium's to answer (common()).
  if (cmd?.kind === "common" && (!tui || cmd.name === "status")) return done(common(state, slot, cmd, patch, d, ctx, chat.id, id, ui));
  // With asks open, your message is for them (product §5.3); a ! message interrupts instead. So it
  // is while the slot waits for its turn to end to switch to the terminal: the turn needs the answers.
  const open = openAsks(state, slot);
  if (open.length && !bang && !cmd) {
    // Your quote brought another slot's asks here: what you type here next, a number too, is for them (away above).
    // As with an ask pushed here (pushAsk()), the picks and lists of the others you answer here are void.
    if (sender) {
      for (const a of open) if (a.forwardedTo !== chat.id) d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch: { forwardedTo: chat.id } });
      for (const o of state.asks) {
        if (o.status === "open" && o.slot !== sender.id && (o.forwardedTo === chat.id || o.slot === bound?.id) && (o.listNo !== null || o.pickedAt !== null)) {
          d.writes.push({ op: "update", table: "ask", where: { id: o.id }, patch: { listNo: null, pickedAt: null } });
        }
      }
    }
    return done(answerFromIm(state, ctx, d, open, text, attachments.length > 0, chat, id));
  }
  // From /rh_tui on, the agent is the terminal's: nothing of yours reaches it from IM (product §4.2).
  if (tui) {
    const home = chat.target !== null && !sender ? target(state, bot, undefined, ctx) : undefined;
    const refused = tuiRefused(slot, slotView(state, slot).ref, home && home.id !== slot.id ? slotView(state, home).ref : undefined, false, !!sender);
    // A press, say on an old /status, has it in place of that message (docs/im-style.md §9.1).
    answer(d, ctx, { chat: chat.id, inbound: id, ui }, refused.text, fitting(caps, refused.buttons));
    return done(refused.text, false);
  }
  // Short of free disk, a slot not running is not started for it (architecture §7.8): you are told, and it goes nowhere.
  const low = (slot.state === "off" || slot.state === "crashed") && lowDisk(ctx);
  if (low) {
    reply(d, ctx, chat.id, id, `磁盘只剩 ${(ctx.diskFree() / 2 ** 30).toFixed(1)} GB，这条没交给 ${slotView(state, slot).ref}。清出空间再发。`);
    return done("磁盘空间不够，没有恢复槽位", false);
  }
  // The quoted text on top; each attachment a line saying where it is kept, and a picture the
  // agent can see goes along too.
  const quoted = m.quote && quotedOf(m.quote.text ?? state.quoted?.text ?? m.quote.fallback ?? "（找不到引用的原文）", m.quote.picked) + "\n";
  const images = attachments.flatMap((a) => (a.path && a.mimeType ? [{ path: a.path, mimeType: a.mimeType }] : []));
  const body = [quoted, text, ...attachments.map(mediaLine)].filter(Boolean).join("\n");
  const r = toAgent(state, ctx, d, slot, patch, { body, line: sourceLine(chatName(state, ctx, chat)), bang: bang !== null, images }, { turnChat: chat.id, turnInbound: id });
  const told = [sender && `已交给 ${slotView(state, sender).ref}。`, r.told].filter(Boolean).join("\n");
  if (told) reply(d, ctx, chat.id, id, told);
  return done(sender ? `按引用交给发消息的槽位，${r.reason}` : r.reason);
}

/** A quoted message as the agent gets it (quoting): of a whole one, the start of its words, but the
 *  lines saying where its pictures and files are kept whole, as the agent finds them by these (§8.3). */
function quotedOf(text: string, picked?: true): string {
  const { text: words, files } = withoutMedia(text);
  const kept = files ? text.split("\n").slice(-files) : [];
  return [words && quoting(words, picked), ...kept.map((l) => `> ${l}`)].filter(Boolean).join("\n");
}

/** Your message to the slot's agent (product §5.3), from a chat or from the board's page, whichever
 *  turn says, ready to go: queued for the agent, its first line line, and the slot started, or its
 *  turn begun or joined; patch takes the slot's changes. Returns why, and what more you are told: that
 *  it waits for the quota, or that it joined a turn another chat began, whose reply goes there. */
function toAgent(
  state: State,
  ctx: Ctx,
  d: Decision,
  slot: Slot,
  patch: Patch<Slot>,
  m: { body: string; line: string; bang: boolean; images: { path: string; mimeType: string }[]; queue?: true } | { input: AgentInput },
  turn: { turnChat: string; turnInbound: string },
): { reason: string; told?: string } {
  const conversation = slot.conversation!;
  const id = turn.turnInbound;
  // rh stop has asked the agent to exit: interrupting it is moot, the exit starts it again (below).
  const halting = slot.state !== "off" && slot.state !== "crashed" && stopping(state, conversation);
  // Once a turn is interrupted, what comes before it ends is held for the next turn, ! or not.
  const held = !halting && (slot.state === "running" || slot.state === "waiting") && (("bang" in m && m.bang) || slot.interruptedAt !== null);
  // Out of Claude's quota, the agent would only be refused again: it waits for the reset (product §4.6).
  const quota = !halting && slot.state === "rate_limited";
  // From the board, what would join a turn under way waits in the queue above where you type, for the
  // turn to end (spec web-write "待发队列"). IM has nowhere to show a queue: yours there joins the turn.
  const queued = "queue" in m && !halting && !held && !quota && (slot.state === "starting" || slot.state === "running" || slot.state === "waiting");
  const queueReason = held ? AFTER_INTERRUPT : quota ? AFTER_QUOTA : queued ? WEB_QUEUE : null;
  // One queued already goes on from where it waits.
  if ("input" in m) d.writes.push({ op: "update", table: "agentInput", where: { id: m.input.id, status: "queued" }, patch: { queueReason } });
  else
    d.writes.push({
      op: "insert",
      table: "agentInput",
      row: {
        id: ctx.newId(),
        conversation,
        source: "human",
        status: "queued",
        // Its first line says where it came from (architecture §6.1). A /x the agent runs as a command
        // goes as typed, which that line would spoil.
        body: m.body.startsWith("/") ? m.body : `${m.line}\n${m.body}`,
        trace: id,
        ...(queueReason && { queueReason }),
        ...(m.images.length > 0 && { images: JSON.stringify(m.images) }),
      },
    });
  // Your message to an archived slot is delivered as ever, and brings the slot back.
  if (slot.archivedAt !== null) {
    Object.assign(patch, { archivedAt: null, activeAt: ctx.now });
    d.events.push({ source: "im", type: "slot_unarchived", trace: id, slot: slot.id });
  }
  if (queued) return { reason: "排队" };
  // A turn the board's page began is yours from IM to take over: its reply goes to you there (product §7).
  const board = slot.turnChat === BOARD && turn.turnChat !== BOARD;
  let reason: string;
  let told: string | undefined;
  if (halting) {
    // The agent is on its way out and would never read it: it waits, and the exit starts the
    // agent again for it. The first such message begins that turn; the rest join it.
    if (slot.turnInbound === null || board) Object.assign(patch, turn);
    reason = "正在停止，停完再起进程";
  } else if (held) {
    // Written once the interrupted turn ends (turn_end below), as the next turn. The first message
    // held takes the turn's chat; the interrupted turn sends no reply.
    if (slot.interruptedAt === null) {
      interrupt(d, ctx, patch, conversation);
      Object.assign(patch, turn);
      reason = "打断当前回合，再开始新回合";
    } else {
      if (slot.turnChat === null || board) Object.assign(patch, turn); // the first since a /stop
      reason = "等打断生效，再开始新回合";
    }
  } else if (quota) {
    // The first message since the refusal takes the turn, should the refused one have had none.
    if (slot.turnChat === null || board) Object.assign(patch, turn);
    lift(state, ctx, d, slot);
    told = `${slotView(state, slot).ref} 在等 ${AGENTS[agentOf(state, slot)].name} 额度，${moment(slot.resumeAt!, ctx.now)} 恢复。这条先存着，到时交给它。`;
    reason = "等额度，排队";
  } else if (slot.state === "off" || slot.state === "crashed") {
    Object.assign(patch, { state: "starting", ...turn });
    d.effects.push({ kind: "start", slot: slot.id });
    releaseQueued(d, conversation, MAX_RUNNING); // a wake waiting for room would hold your message back
    reason = "起进程，开始新回合";
  } else if (slot.state === "idle") {
    Object.assign(patch, { state: "running", ...turn });
    d.effects.push({ kind: "deliver", conversation });
    reason = "开始新回合";
  } else if (slot.turnChat === null || board) {
    // A turn no message of yours began, an internal one say, takes yours as any turn does, and this
    // chat becomes its turn chat: the rest of what it says, and its reply, come here (product §5.3, #215).
    Object.assign(patch, turn);
    d.effects.push({ kind: "deliver", conversation });
    reason = board ? "接过网页开始的回合，回复发到这里" : "并入没有发起窗口的回合，回复发到这里";
  } else {
    d.effects.push({ kind: "deliver", conversation });
    lift(state, ctx, d, slot);
    reason = "插话";
  }
  // It joins a turn another chat began, whose reply goes there: you hear so (product §5.3).
  const there = !quota && patch.turnChat === undefined && slot.turnChat !== turn.turnChat ? state.chats.find((c) => c.id === slot.turnChat) : undefined;
  if (there) told = `已并入 ${chatName(state, ctx, there)}那边正在跑的回合，回复会发在那边。`;
  return { reason, ...(told && { told }) };
}

/** A chat as you would call it, never by its id: its platform, its bot's name too when that platform
 *  has more than one bot, and 私聊 for a private chat of yours with it, whichever owner's. */
export function chatName(state: Pick<State, "bots">, ctx: Pick<Ctx, "config">, chat: Pick<Chat, "bot" | "platformChatId">): string {
  const bot = state.bots.find((b) => b.id === chat.bot)!;
  return chatOf(ctx.config, bot, ownerChat(bot, chat, ctx) ? "私聊" : "聊天窗口");
}

/** Whether the chat is an owner's private chat with the bot: its id is the owner's user id
 *  (docs/spec/v1.md "配置"). */
const ownerChat = (bot: Bot, chat: Pick<Chat, "platformChatId">, ctx: Pick<Ctx, "config">) => owners(bot, ctx.config).includes(chat.platformChatId);

/** Your message joined a turn rh send me took over in its chat, or you answered its ask: what the
 *  agent says from then on, its final reply too, goes there again (product §5.5); what it said before
 *  stays unshown (hush). Its words already on their way when your message reaches it show too. */
function lift(state: State, ctx: Ctx, d: Decision, slot: Slot): void {
  if (!slot.turnSentMe) return;
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { turnSentMe: null } });
  const conv = state.conversations.find((c) => c.id === slot.conversation);
  const p = progressOf(conv?.progress);
  const to = toChat(state, slot.turnChat, ctx);
  if (!conv || !p || !to?.caps) return;
  const progress = JSON.stringify({ ...hush(p, viewOf({ ...to, caps: to.caps }, slot, ctx)), toolsOnly: undefined });
  d.writes.push({ op: "update", table: "conversation", where: { id: conv.id }, patch: { progress } });
}

/** chatName of your private chat with the bot, or of another chat of it. The system prompt names
 *  each bot's format limits so (runner), for the agent to match them to that line. */
export function chatOf(config: Pick<Config, "bots">, bot: Pick<Bot, "name" | "platform">, what: "私聊" | "聊天窗口"): string {
  const name = nameAmong(config, bot);
  // A space between Latin letters and Chinese, none between Chinese and Chinese: QQ 私聊, 飞书私聊.
  const { label } = PLATFORMS[bot.platform];
  return `${label}${name !== null ? ` Bot ${name} 的` : /[A-Za-z]$/.test(label) ? " " : ""}${what}`;
}

/** What rh send takes for your private chat with the bot (product §5.9): its platform's name, where it
 *  is the one bot of its platform in the config and so goes by that, else its own; null for one named
 *  for another platform, as rh send takes that word for the platform. */
export const sendWord = (config: Pick<Config, "bots">, bot: Pick<Bot, "name" | "platform">): string | null =>
  nameAmong(config, bot) === null && PLATFORM_WORDS.includes(bot.platform) ? bot.platform : PLATFORM_WORDS.includes(bot.name) ? null : bot.name;

/** The bot's name where another bot of its platform is in the config (docs/im-style.md §2.6), else
 *  null. A bot taken out of the config keeps its row, but no longer counts (#598). */
function nameAmong(config: Pick<Config, "bots">, bot: Pick<Bot, "name" | "platform">): string | null {
  const several = Object.entries(config.bots).some(([name, b]) => name !== bot.name && b.platform === bot.platform);
  // A bot goes by its label, where it has one; commands name it by its id (docs/spec/v1.md "配置").
  return several ? (config.bots[bot.name]?.label ?? bot.name) : null;
}

/** A Rhodium command typed in chat (im: the chat and its bot), or into a slot's chat on the board;
 *  returns the reply, or null for one that comes once done or a panel it showed. here: the slot the
 *  chat goes to, or the board's page is of. /rh_use, /rh_bind, /rh_ls, /rh_archive and /rh_import are
 *  rh use, rh bind, rh ls, rh archive and rh import run from your terminal, on this chat and this bot;
 *  /rh_agent, /rh_tui, /rh_release and /rh_rename are rh agent, rh tui, rh release and rh rename on here,
 *  or the slot named. With no argument, /rh_use, /rh_bind, /rh_agent, /rh_ls, /rh_archive and /rh_import
 *  show a panel to pick from (docs/im-style.md §9). Arguments a command does not take get an example as
 *  you write it here (§10.2). On the board what is not done is refused, and the commands it does
 *  elsewhere (ELSEWHERE), which want a chat, never come here. */
function rhCommand(state: State, cmd: { word: string; args: string }, here: Slot | undefined, at: At, ctx: Ctx, d: Decision, im?: { bot: Bot; chat: Chat }): string | null {
  const inbound = at.inbound;
  const fail = (text: string) => (im ? text : refuse(text));
  const name = cmd.word.slice("/rh_".length);
  const def = IM_COMMANDS.find((c) => c.name === `rh_${name}`);
  if (!def) return fail(`没有 ${cmd.word} 这个命令，${im ? "发 /rh_help" : "打 /"} 看有哪些。`);
  const args = cmd.args.split(/\s+/).filter(Boolean);
  if (name === "help") {
    // Rhodium's home (docs/im-style.md §10.1): not paged, so its 9 are past a page's 8. A press shows,
    // on Telegram, in place of it, with 返回 to it, as /status's buttons do (§7).
    const buttons = layout(homeButtons(here?.mode).map((c) => ({ label: c.label, data: c.command, ...(c.fill !== undefined && { fill: c.fill }) })), true);
    buttons.push({ label: "取消", data: CANCEL, row: buttons.at(-1)!.row! + 1, muted: true });
    const text = here ? `这里的消息交给 ${slotView(state, here).ref}，用 ${AGENTS[agentOf(state, here)].name}。` : "这里还没指定槽位。";
    answer(d, ctx, at, text, fitting(ctx.capabilities(im!.bot.id), buttons));
    return null;
  }
  if (name === "verbose") return verbose(ctx, d, im!.chat, ctx.capabilities(im!.bot.id), at, args);
  const byDefault = im && target(state, im.bot, undefined, ctx);
  const ref = (s: Slot) => slotView(state, s).ref;
  // Where a pick shows on Telegram, in place of the panel: the question, and what was picked.
  const picked = (question: string, value: string, sentence: string, more = "") =>
    at.ui?.edit ? [question, `已选：${value}`, ...(more ? [more] : [])].join("\n") : sentence + more;
  // The slot an example names (docs/im-style.md §10.2).
  const example = here ?? state.slots[0];
  const usage = () => fail(imUsage(def.name, example ? ref(example) : "dispatcher/main"));
  // A panel pressed for, on Telegram, is /rh_help's in place: it goes back there (§10.1).
  const home = at.ui?.edit && { back: "/rh_help" };
  if (!args.length && (name === "use" || name === "bind" || name === "agent" || name === "archive")) {
    if (name === "agent" && !here) return "这里还没指定槽位。";
    const lists: Lists = { slots: slotEntries(state), here: here && ref(here), byDefault: byDefault && ref(byDefault), own: im !== undefined && im.chat.target !== null, agent: here && agentOf(state, here) };
    // A pick archives at once, as [归档] in a slot's details does: what it costs comes first (§9.8).
    const head =
      name === "use"
        ? ["这里的消息交给谁？", ...(here ? [`现在：${ref(here)}`] : [])]
        : name === "bind"
          ? ["这个 Bot 的默认槽位换成哪个？", ...(byDefault ? [`现在：${ref(byDefault)}`] : [])]
          : name === "archive"
            ? ["归档哪个槽位？", "归档会停掉它的进程，对话保留，随时能恢复。"]
            : [`${ref(here!)} 换哪个 agent？`, `现在：${AGENTS[agentOf(state, here!)].name}`, "换了会开一段新对话，旧对话发 /resume 能回去。"];
    showIn(state, ctx, d, at, { command: `/rh_${name}`, head, candidates: def.list!(lists), ...home });
    return null;
  }
  if (name === "ls" && args.length === 1 && args[0] !== "--all") {
    const s = slotNamed(state, args[0]!);
    if (typeof s === "string") return s;
    showIn(state, ctx, d, at, slotPanel(state, ctx, s, im!.chat, im!.bot));
    return null;
  }
  if (name === "ls" && args.length <= 1) {
    showIn(state, ctx, d, at, { ...lsPanel(state, ctx, im!.bot, im!.chat, args[0] === "--all"), ...home });
    return null;
  }
  // The second step of /rh_import's panel: the slot's name (docs/im-style.md §9.7).
  if (name === "import" && args.length >= 2 && args[1] === "--name" && (args.length === 2 || args[2] === "…")) {
    const what = args[0]!;
    if (args.length === 3) return `${at.ui?.edit ? "导入成槽位，叫什么？\n" : ""}发 /rh_import ${what} --name <名字>`;
    const own = { label: "自己起名…", command: `/rh_import ${what} --name …`, fill: `/rh_import ${what} --name ` };
    const named = what.includes(":")
      ? { label: "用默认名", command: `/rh_import ${what}` }
      : { label: `用 ${what.slice(0, 8)}`, command: `/rh_import ${what} --name ${what.slice(0, 8)}` };
    const panel: Panel = { command: cmd.word, head: ["导入成槽位，叫什么？"], candidates: [named, own], short: true, back: "/rh_import" };
    showIn(state, ctx, d, at, panel);
    return null;
  }
  // Before the slot is looked up, which would say a second word is no slot.
  if ((name === "use" || name === "bind") && args.length > 1) return usage();
  const forms: Record<string, string[] | undefined> = {
    ls: ["ls"],
    import: ["import"],
    archive: ["archive"],
    ...(im && { use: ["use", `${im.bot.name}/${im.chat.platformChatId}`], bind: ["bind", im.bot.name] }),
  };
  if (name === "rename") {
    if (!args.length || args.length > 2) return usage();
    // The slot named first, else the one this chat goes to.
    const named = args.length === 2 ? slotNamed(state, args.shift()!) : here;
    if (typeof named === "string") return fail(named);
    if (!named) return "这里还没指定槽位，发 /rh_use 选一个。";
    forms.rename = ["rename", ref(named)];
  }
  if (name === "agent" || name === "tui" || name === "release") {
    // The slot named first, else the one this chat goes to.
    const named = name !== "agent" && args[0] !== undefined && !/^[!！]$/.test(args[0]) ? slotNamed(state, args.shift()!) : here;
    if (typeof named === "string") return fail(named);
    if (!named) return "这里还没指定槽位，发 /rh_use 选一个。";
    forms[name] = [name, ref(named)];
    // It counts as contact (product §5.9); how the switch went, and the confirm request for a release,
    // come here whatever chat points at the slot (rh()).
    if (name !== "agent" && im) contacted(d, ctx, im.chat.id);
  }
  const argv = forms[name];
  if (!argv) return fail(`/${def.name} 还没做好。`);
  argv.push(...args);
  const sub = nothing();
  try {
    // A slot named by its row id, as a button whose data its name would make too long names it.
    if (name === "archive" && args[0]) argv[1] = ref(findSlot(state, args[0]));
    const chosen = name === "use" || name === "bind" ? (args[0] === "-" ? null : findTarget(state, args[0]!)) : undefined;
    if (chosen) argv[argv.length - 1] = ref(chosen);
    // What it is already: nothing to do (docs/im-style.md §9.1).
    if (name === "use" && (chosen ? im!.chat.target !== null && here?.id === chosen.id : im!.chat.target === null)) {
      const now = chosen ? ref(chosen) : byDefault ? `默认（${ref(byDefault)}）` : "默认";
      const said = chosen ? `这里的消息本来就交给 ${ref(chosen)}，没有改动。` : `这里本来就跟着默认${byDefault ? `，消息交给 ${ref(byDefault)}` : ""}，没有改动。`;
      return picked("这里的消息交给谁？", now, "", said);
    }
    if (name === "bind" && chosen && chosen.id === byDefault?.id) return picked("这个 Bot 的默认槽位换成哪个？", ref(chosen), "", `这个 Bot 的默认槽位本来就是 ${ref(chosen)}，没有改动。`);
    // Only the bot's owners get this far (im()): it is you. /rh_import lists the
    // conversations of the directory of the slot this chat goes to.
    const caller = { token: null, pid: null, tty: true, cwd: (name === "import" && here?.dir) || "/" };
    const out = rh(state, { kind: "rh", id: inbound, caller, argv }, im ? { kind: "you", im: im.chat } : { kind: "you", board: true }, ctx, sub);
    d.writes.push(...sub.writes);
    d.events.push(...sub.events.map((e) => ({ ...e, source: im ? ("im" as const) : ("board" as const), trace: inbound })));
    // An import answers here once done, and points this chat at what it imported (imported()); what
    // it lists is a panel, shown as this press would show one. On the board it answers the page.
    d.effects.push(...sub.effects.map((e) => (e.kind === "import" ? { ...e, chat: im?.chat.id ?? BOARD, ...(im && { point: true as const }), ...(at.ui && { panel: at.ui }) } : e)));
    // The confirm request asks you itself (docs/im-style.md §5.2); a message pressed for it, say
    // /status, says what was picked, its buttons off (§9.1).
    if (name === "release" && sub.writes.some((w) => w.op === "insert" && w.table === "ask")) {
      if (at.ui?.edit && at.pressed !== undefined) answer(d, ctx, at, `${unpaged(at.pressed)}\n已选：切回无头`);
      return null;
    }
    if (name === "use") {
      if (!chosen) {
        const now = byDefault;
        const sentence = now ? `这里改回默认，消息交给 ${ref(now)}。` : `这里改回默认，可 Bot ${im!.bot.name} 没有默认槽位，消息不交给任何槽位。`;
        return picked("这里的消息交给谁？", now ? `默认（${ref(now)}）` : "默认", sentence);
      }
      return picked("这里的消息交给谁？", ref(chosen), `这里的消息改交给 ${ref(chosen)}。`, waitsHere(chosen, ctx.now));
    }
    if (name === "bind") return picked("这个 Bot 的默认槽位换成哪个？", ref(chosen!), `这个 Bot 的默认槽位改成 ${ref(chosen!)}。单独选过槽位的窗口不受影响。`);
    const a = name === "agent" && AGENT_KINDS.includes(args[0] as AgentKind) && AGENTS[args[0] as AgentKind].name;
    if (a && sub.events.some((e) => e.type === "slot_agent")) return picked(`${argv[1]} 换哪个 agent？`, a, `${argv[1]} 换成了 ${a}，下一条消息开始新对话。`);
    if (out === null) return null;
    // A pick whose result is more than the pick, as one waiting for the turn to end, shows in place
    // of the panel all the same: the question, 已选, then that (docs/im-style.md §9.1), with its buttons.
    const { text, buttons } = typeof out === "string" ? { text: out, buttons: undefined } : out;
    const said = a && args.length === 1 ? picked(`${argv[1]} 换哪个 agent？`, a, "", text) : text;
    if (!buttons) return said;
    answer(d, ctx, at, said, im ? fitting(ctx.capabilities(im.bot.id), buttons) : buttons);
    return null;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return err instanceof Usage ? usage() : fail(err.message);
  }
}

/** What waits at a slot this chat now goes to, said after a pick (docs/im-style.md §9.2). */
function waitsHere(s: Slot, now: number): string {
  if (s.mode === "tui") return "它在 TUI 里，切回无头之前，这里的消息不会交给它。";
  if (s.state === "rate_limited" && s.resumeAt !== null) return `它在等额度，${moment(s.resumeAt, now)} 恢复，这之间的消息先存着。`;
  return "";
}

/** A slot as a command names it: its ref, its name alone if no other slot has it, or its row id;
 *  else why there is none, to say. */
function slotNamed(state: State, ref: string): Slot | string {
  try {
    return findTarget(state, ref);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return err.message;
  }
}

const DETAILED = "每个工具一行，带文件名或命令";
const SHORT = "只写工具名和次数";

/** /rh_verbose (im-style §3.5): how this chat writes tool lines. Bare, it switches; on or off sets
 *  it. Either way with a button to switch back, which says on or off, so an old one pressed late
 *  does not get it the wrong way round. Pressed, say on /rh_help, it shows in place of that (§10.1). */
function verbose(ctx: Ctx, d: Decision, chat: Chat, caps: Capabilities | undefined, at: At, args: string[]): string | null {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "on" && args[0] !== "off")) return imUsage("rh_verbose", "");
  const on = args[0] === undefined ? !(caps ? verboseIn(chat, caps) : chat.verbose === 1) : args[0] === "on";
  d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { verbose: on ? 1 : 0 } });
  const [text, back] = on ? [`工具行改成详细：${DETAILED}。`, { label: "改回简略", data: "/rh_verbose off" }] : [`工具行改成简略：${SHORT}。`, { label: "改回详细", data: "/rh_verbose on" }];
  answer(d, ctx, at, text, fitting(caps, [back]));
  return null;
}

/** A common command to the slot (architecture §6.1). Returns why, for the inbound record. */
function common(state: State, slot: Slot, cmd: { name: CommonCommand; args: string }, patch: Patch<Slot>, d: Decision, ctx: Ctx, chat: string, inbound: string, ui: PanelUi = {}): string {
  const conversation = slot.conversation!;
  const info = slotInfo(state, slot, ctx.now);
  const say = (r: CommandResult) => commandReply(state, ctx, d, { chat, inbound, ui }, r, slot);
  // Its result, why it was not done too, shows as a press on a panel would show it (docs/im-style.md §9.1);
  // on the board, as an error.
  const refused = (text: string) => (chat === BOARD ? refuse(text) : answer(d, ctx, { chat, inbound, ui }, text));
  const panel = Object.keys(ui).length ? { panel: ui } : {};
  // Until the agent is attached there is nothing to interrupt yet, and closing it would leave the
  // process being started running on its own.
  // ponytail: refused (product §5.3); rh stop can stop a slot mid-start, /new and /stop could follow it.
  if (slot.state === "starting" && (cmd.name === "new" || cmd.name === "stop")) {
    refused(`${info.ref} 还在启动，过几秒再试。`);
    return `通用命令 /${cmd.name}：还在启动`;
  }
  // Claude's alone: pi is not started for it.
  const kind = agentOf(state, slot);
  if (cmd.name === "ultracode" && !AGENTS[kind].ultracode) {
    refused(`${AGENTS[kind].name} 没有 ultracode。`);
    return `通用命令 /ultracode：${AGENTS[kind].name} 没有`;
  }
  switch (cmd.name) {
    case "new": {
      const agent = state.conversations.find((c) => c.id === conversation)!.agent;
      Object.assign(patch, newConversation(state, d, ctx, slot, agent));
      say({ command: "new" });
      break;
    }
    case "stop": {
      // Waiting for quota, the turn would carry on at the reset (clock): no longer, though what you
      // send meanwhile still goes in then.
      const quota = slot.state === "rate_limited" && slot.interruptedAt === null;
      const stopped = slot.state === "running" || slot.state === "waiting" || quota;
      // The stopped turn sends no final reply: this one says it stopped. With an interrupt already
      // sent, the turn's chat is that of a message held for the next turn, whose reply it keeps.
      if (quota) Object.assign(patch, { interruptedAt: ctx.now, turnChat: null, turnInbound: null, turnSentMe: null });
      else if (stopped && slot.interruptedAt === null) {
        interrupt(d, ctx, patch, conversation);
        Object.assign(patch, { turnChat: null, turnInbound: null });
      }
      // The board's queue is paused: what you queued does not rush out after a stop (spec web-write "待发队列").
      releaseQueued(d, conversation, WEB_QUEUE, WEB_PAUSED);
      say({ command: "stop", stopped });
      break;
    }
    case "resume": {
      // Rhodium's own, the same on every agent and with no agent running: the slot runner lists the
      // timeline and the directory, and a session it names comes back as command_result (agent()).
      // One of the slot's conversations by its id, as the board's timeline names it, goes by its whole
      // session id: the start the timeline shows may start another's too.
      const named = state.conversations.find((c) => c.slot === slot.id && c.id === cmd.args.trim())?.sessionId;
      d.effects.push({ kind: "command", conversation, command: "resume", args: named ?? cmd.args, chat, inbound, ...panel });
      break;
    }
    default: {
      // The rest is the agent's to answer; with no agent process, /status is Rhodium's part alone.
      const off = slot.state === "off" || slot.state === "crashed";
      if (cmd.name === "status" && (off || slot.state === "starting" || slot.mode === "tui")) {
        const alone = { command: "status" as const, model: null, context: null };
        // In the terminal what /model and /effort set may have changed there: only what Rhodium knows (docs/im-style.md §7.1).
        say(slot.mode === "tui" ? alone : remembered(state, alone, slot));
        break;
      }
      if (off) {
        // The agent starts for it, on the slot's conversation (product §5.6), within the running limit,
        // unlike your message: short of room or disk, it is refused and you are told.
        const max = ctx.config.limits.maxRunning;
        const why = lowDisk(ctx) ?? (running(state) >= max ? `同时运行的无头槽位已到上限 ${max} 个` : null);
        if (why) {
          refused(`/${cmd.name} 没做成，${info.ref} 没能启动。发一条消息就能启动它（你的消息不受这个限制），之后再发 /${cmd.name}。\n原因：${why}`);
          return `通用命令 /${cmd.name}：没有拉起 agent`;
        }
        // Idle from the start: no turn comes, and its reap clock runs from now. No turn ended either:
        // the board's 完成 and a one-off slot's archive clock keep its last turn's end (#489).
        // Messages and wakes go in once it is attached, as they do while it starts.
        Object.assign(patch, { state: "idle", startedIdleAt: ctx.now });
        reapAt(d, ctx, slot, ctx.now);
        d.effects.push({ kind: "start", slot: slot.id });
        releaseQueued(d, conversation, MAX_RUNNING); // a wake waiting for room would hold the rest back
        if (slot.archivedAt !== null) {
          Object.assign(patch, { archivedAt: null, activeAt: ctx.now });
          d.events.push({ source: "im", type: "slot_unarchived", trace: inbound, slot: slot.id });
          if (slot.lifetime === "oneoff") turnOver(d, ctx, slot); // its clock starts over, as on rh unarchive
        }
      }
      // Still starting, the slot runner runs it once the agent is attached.
      d.effects.push({ kind: "command", conversation, command: cmd.name, args: cmd.args, chat, inbound, ...panel });
    }
  }
  return `通用命令 /${cmd.name}`;
}

/** Moves the slot to a new conversation of the agent; the one it leaves stays on its timeline. The new
 *  row has no session id yet, so the next start opens a new session. pi's too: one process per
 *  conversation, as one holder is (architecture §6.1). Returns the slot's patch. */
function newConversation(state: State, d: Decision, ctx: Ctx, slot: Slot, agent: Conversation["agent"]): Patch<Slot> {
  const id = ctx.newId();
  d.writes.push({ op: "insert", table: "conversation", row: { id, slot: slot.id, agent, startedAt: ctx.now } });
  return moveTo(state, ctx, d, slot, id, agent);
}

/** Points the slot at another conversation, of agent, and closes the agent of the one it leaves; the
 *  next message starts the new one. What /model, /effort and /ultracode set goes with another agent: it named
 *  that agent's models (product §5.6). Returns the slot's patch. */
function moveTo(state: State, ctx: Ctx, d: Decision, slot: Slot, conversation: string, agent: AgentKind): Patch<Slot> {
  const forget = state.conversations.find((c) => c.id === slot.conversation)?.agent !== agent ? { model: null, effort: null, ultracode: null } : {};
  if (slot.state !== "off" && slot.state !== "crashed") stopAgent(d, slot.conversation!);
  // The old agent's exit no longer finds the slot: what waited on it ends here, as at that exit.
  // What was queued for the turn's end, the asks, the stop or a quota reset goes in first once you go
  // back to that conversation; left queued for them, it would hold back all that came after it.
  cancelAsks(d, agentAsks(state, slot));
  pushDeferred(state, ctx, d, slot);
  for (const r of [AFTER_QUOTA, AFTER_INTERRUPT, AFTER_ASKS, AFTER_STOP, AFTER_TURN]) releaseQueued(d, slot.conversation!, r);
  // The board's queue goes with the slot, paused: what you queued may not suit the new conversation,
  // and left behind it would come out once you go back (spec web-write "待发队列").
  for (const r of [WEB_QUEUE, WEB_PAUSED])
    d.writes.push({ op: "update", table: "agentInput", where: { conversation: slot.conversation!, status: "queued", queueReason: r }, patch: { conversation, queueReason: WEB_PAUSED } });
  return { conversation, state: "off", turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null, approvalStale: null, resumeAt: null, nextAgent: null, ...forget };
}

/** Stops the turn in progress; until it ends, what comes is held for the next turn. */
function interrupt(d: Decision, ctx: Ctx, patch: Patch<Slot>, conversation: string): void {
  patch.interruptedAt = ctx.now;
  d.effects.push({ kind: "interrupt", conversation });
}

/** Recorded first, so the exit that follows is not taken for a crash (architecture §4.8); 2 for the emergency stop. */
function stopAgent(d: Decision, conversation: string, brake = false): void {
  d.writes.push({ op: "update", table: "holder", where: { conversation }, patch: { stopRequested: brake ? 2 : 1 } });
  d.effects.push({ kind: "stop", conversation, ...(brake && { brake: true as const }) });
}

/** Queues a message to the chat in reply to the inbound message, which is its trace too. */
// ponytail: on QQ a command's reply skips the quota count; one the platform refuses for its quota
// still goes out active (refused()). Count it with send() once commands share a turn's passive replies.
function reply(d: Decision, ctx: Ctx, chat: string, inbound: string | null, text: string): void {
  outbound(d, ctx, { chat, replyTo: inbound, trace: inbound, text });
}

/** The buttons, where the platform has buttons and one message holds them all, in at most 5 rows
 *  (QQ's keyboard); else none, and the choices go numbered. */
const fitting = (caps: Capabilities | undefined, buttons: Button[] | undefined): Button[] | undefined =>
  caps?.buttons && buttons && buttons.length <= (caps.maxButtons ?? Infinity) && buttonRows(buttons).length <= 5 ? buttons : undefined;

/** [取消]'s data at /model's second step when no level is set: there is none to set again. */
const LEVEL_KEPT = "cancel:level";

/** /status with what /model and /effort set on the slot where the agent does not say: it is not
 *  running, or does not report it (product §5.6). A Claude or Codex model by the name its last list gave
 *  it (docs/im-style.md §2.4); with none, as it was set. */
function remembered(state: State, r: Extract<CommandResult, { command: "status" }>, slot: Slot): CommandResult {
  const kind = agentOf(state, slot);
  const agent = AGENTS[kind];
  const names = state.models[kind] ?? {};
  const model = slot.model && ((agent.modelNames && names[slot.model]) || slot.model);
  // Claude's: the slot keeps a model once Claude has switched to it, which a startup message re-read
  // after a restart of rhodium may still name the one before (#329); pi's is asked of pi each time.
  const known = agent.modelNames && slot.model !== null && names[slot.model] !== undefined;
  return { ...r, model: (known ? model : r.model) ?? model, ...(r.effort === undefined && slot.effort !== null && { effort: slot.effort }), ...(agent.ultracode && slot.ultracode === 1 && { ultracode: true as const }) };
}

/** Where a reply goes: in reply to inbound in chat, or, on a platform that edits, in place of the
 *  message ui.edit names (a press on a panel, docs/im-style.md §9.1). pressed: what that message
 *  read, where the platform says. */
type At = { chat: string; inbound: string; ui?: PanelUi; pressed?: string };

/** What chat.panel holds while a panel is open here (docs/im-style.md §9.1): the commands of a paged
 *  one's numbers, while it is the chat's last message (§11.4); on a platform that edits, the message it
 *  shows in, for a number's pick to show in place of, and what that reads once the panel is left. */
type Memo = { commands?: string[]; edit?: NonNullable<PanelUi["edit"]>; gone?: string };
/** chat.panel once the memo's numbers are void: what is left of it, still open on a platform that edits. */
const unnumbered = (m: Memo): string | null => (m.edit ? JSON.stringify({ edit: m.edit, gone: m.gone }) : null);
/** The panel open in a chat, from its chat.panel. */
const memoOf = (panel: string | null | undefined): Memo | null => (panel ? JSON.parse(panel) : null);

/** Says text where at says, with buttons if any; in place of a message, none takes its buttons off.
 *  On the board, the buttons but cancel are what to pick from. markdown: a query reply's, in the chat's
 *  platform's Markdown (queryMarkdown). Returns the outbound record of a new message. */
function answer(d: Decision, ctx: Ctx, at: At, text: string, buttons?: Button[], markdown?: string): string | undefined {
  if (at.chat === BOARD) {
    const candidates = (buttons ?? []).filter((b) => !b.muted).map((b) => ({ label: b.label, command: b.data }));
    d.effects.push({ kind: "rh_reply", id: at.inbound, reply: { ok: true, text, ...(candidates.length && { panel: { head: text.split("\n"), candidates } }) } });
    return undefined;
  }
  const edit = at.ui?.edit;
  if (edit) {
    d.effects.push({ kind: "redraw", chat: at.chat, at: edit, text, buttons: buttons ?? [], ...(markdown !== undefined && { markdown }) });
    return undefined;
  }
  return outbound(d, ctx, { chat: at.chat, replyTo: at.inbound, trace: at.inbound, text, ...(buttons?.length && { buttons }), ...(markdown !== undefined && { markdown }) });
}

/** A query reply (docs/im-style.md §7), md as im-commands.ts writes it: in IM, as Markdown and plain
 *  text, with buttons where the platform has them; on the board, its plain text and card, the data the
 *  page draws its info card from (spec info-commands "网页"). */
function query(state: State, ctx: Ctx, d: Decision, at: At, md: string, card: InfoCard, buttons: Button[]): void {
  if (at.chat === BOARD) return void d.effects.push({ kind: "rh_reply", id: at.inbound, reply: { ok: true, text: plain(md), card } });
  const caps = toChat(state, at.chat, ctx)?.caps;
  answer(d, ctx, at, plain(md), caps?.buttons ? buttons : undefined, queryMarkdown(md, caps));
}

/** Shows the panel at the page at asks for, as the chat's platform takes it: buttons, or numbers where
 *  it has none. A paged one's numbers are this chat's to reply with (Memo). On the board, every
 *  candidate at once, for the page to show (spec web-write "面板回网页"). */
function showIn(state: State, ctx: Ctx, d: Decision, at: At, panel: Panel): void {
  if (at.chat === BOARD) {
    const head = panel.head ?? [];
    d.effects.push({ kind: "rh_reply", id: at.inbound, reply: { ok: true, text: head.join("\n"), panel: { head, candidates: panel.candidates } } });
    return;
  }
  const caps = toChat(state, at.chat, ctx)?.caps;
  const said = (text: string) => (panel.query ? plain(text) : text);
  const remember = (commands: string[] | null, id: string | undefined, text: string) => {
    const edit = at.ui?.edit ?? (caps?.progress === "edit" && id ? { outbound: id } : undefined);
    if (!commands && !edit) return;
    const memo: Memo = { ...(commands && { commands }), ...(edit && { edit, gone: panel.gone ?? `${unpaged(text)}\n已取消` }) };
    d.writes.push({ op: "update", table: "chat", where: { id: at.chat }, patch: { panel: JSON.stringify(memo) } });
  };
  if (!caps?.buttons) {
    // ponytail: every platform v1 has has buttons; the fake's buttons = "false" gets the list numbered in one message.
    const lines = panel.candidates.map((c, i) => `${c.current ? "✓ " : ""}${i + 1}. ${c.label}`);
    const head = panel.text ? said(panel.text({ page: 1, pages: 1, again: false })) : (panel.head ?? []).join("\n");
    const text = `${head}\n\n${lines.join("\n")}\n\n回编号选一个。`;
    remember(panel.candidates.map((c) => c.command), answer(d, ctx, at, text), text);
    return;
  }
  // A platform that cannot edit the panel later shows ✓ on a button you pressed (QQ): the one now is ★ there.
  const shown = showPanel(panel, at.ui?.page ?? 1, { edits: Boolean(at.ui?.edit), mark: caps.progress === "edit" ? "✓" : "★" });
  const text = said(shown.text);
  remember(shown.numbered, answer(d, ctx, at, text, shown.buttons, panel.query && queryMarkdown(shown.text, caps)), text);
}

/** The reply to a common command (product §5.6, docs/im-style.md §7, §9): a list to pick from is a
 *  panel; a pick from one shows, on Telegram, in place of it. */
function commandReply(state: State, ctx: Ctx, d: Decision, at: At, r: CommandResult, slot: Slot): void {
  const info = slotInfo(state, slot, ctx.now);
  const edit = Boolean(at.ui?.edit);
  const list = (name: string, choices: Choice[]) => imCommand(name)!.list!({ choices });
  switch (r.command) {
    case "status": {
      const running = slot.state === "running" || slot.state === "waiting";
      // The board's card offers what can be done now: no compacting mid-turn, nothing in the terminal.
      const actions = slot.mode === "tui" ? [] : [...(running ? ["/stop"] : []), "/model", ...(running ? [] : ["/compact", "/new"])];
      const card: StatusCard = { ...r, ref: info.ref, agent: agentOf(state, slot), dir: tilde(slot.dir), line: info.line, ...(info.tool && { tool: info.tool }), actions };
      return query(state, ctx, d, at, statusText(r, info, ctx.now), card, statusButtons(slot));
    }
    case "model": {
      if (r.choices) {
        // Before a turn names the model, the one the slot has, else the default (docs/im-style.md §9.5).
        const choices = marked(r.choices, slot.model ?? "default");
        const now = choices.find((c) => c.current)?.label ?? r.model;
        const head = ["换哪个模型？", ...(now ? [`现在：${now}${r.level ? `，思考强度 ${r.level}` : ""}`] : [])];
        return showIn(state, ctx, d, at, { command: "/model", head, candidates: list("model", choices), ...(edit && { back: "/status" }) });
      }
      const name = r.label ?? r.model ?? "默认模型";
      // Its level set too: the second step's pick (docs/im-style.md §9.5).
      if (r.was !== undefined && !r.efforts) {
        const level = r.was === r.level ? `思考强度还是 ${r.level}` : `思考强度 ${r.level}`;
        return void answer(d, ctx, at, edit ? `换哪个模型？\n已选：${name}，${level}` : `${r.was === r.level ? level : `思考强度改成 ${r.level}`}。`);
      }
      if (!r.efforts?.length) return void answer(d, ctx, at, edit ? `换哪个模型？\n已选：${name}` : `已切到 ${name}。`);
      const ask = `思考强度要改吗？${r.level ? `现在是 ${r.level}。` : ""}`;
      const head = edit ? ["换哪个模型？", `已选：${name}`, ask] : [`已切到 ${name}。`, ask];
      const candidates = r.efforts.map((c) => ({ label: c.label, command: `/model ${r.model ?? "default"} ${c.id}`, current: c.current }));
      // The model is switched already: leaving this step keeps the level, or none (docs/im-style.md §9.5).
      const keep = r.level
        ? { cancel: `/model ${r.model ?? "default"} ${r.level}`, gone: `换哪个模型？\n已选：${name}，思考强度还是 ${r.level}` }
        : { cancel: LEVEL_KEPT, gone: `换哪个模型？\n已选：${name}` };
      return showIn(state, ctx, d, at, { command: "/model", head, candidates, short: true, back: "/model", ...keep });
    }
    case "effort":
      if (r.choices) {
        // The level the slot has where the agent does not say, as Claude taken over after a restart.
        const choices = slot.effort === null ? r.choices : marked(r.choices, slot.effort);
        const now = choices.find((c) => c.current)?.id ?? (r.level !== "-" ? r.level : null);
        const head = ["思考强度改成哪档？", ...(now ? [`现在：${now}`] : [])];
        return showIn(state, ctx, d, at, { command: "/effort", head, candidates: list("effort", choices), short: true, ...(edit && { back: "/status" }) });
      }
      return void answer(d, ctx, at, edit ? `思考强度改成哪档？\n已选：${r.level}` : `思考强度改成 ${r.level}。`);
    case "ultracode": {
      const word = r.on ? "开" : "关";
      if (r.choices) return showIn(state, ctx, d, at, { command: "/ultracode", head: ["ultracode 开还是关？", `现在：${word}`], candidates: list("ultracode", r.choices), short: true, ...(edit && { back: "/status" }) });
      if (r.unavailable) return void answer(d, ctx, at, formatCommand(r, info, ctx.now));
      return void answer(d, ctx, at, edit ? `ultracode 开还是关？\n已选：${word}` : formatCommand(r, info, ctx.now));
    }
    case "resume": {
      if (r.choices?.length) {
        // A conversation not yet begun has no entry to mark (docs/im-style.md §9.6).
        const head = ["回到哪段对话？", `现在：${r.name ?? "新对话"}`];
        return showIn(state, ctx, d, at, { command: "/resume", head, candidates: list("resume", r.choices), ...(edit && { back: "/status" }) });
      }
      if (r.choices) return void answer(d, ctx, at, formatCommand(r, info, ctx.now));
      const which = r.name ?? "那段";
      const other = r.agent && r.agent !== info.agent ? `agent 换成了 ${AGENTS[r.agent].name}。` : "";
      return void answer(d, ctx, at, edit ? `回到哪段对话？\n已选：${which}${other ? `\n${other}` : ""}` : `已回到${which}对话。${other}`);
    }
    case "context":
      return query(state, ctx, d, at, contextText(r), r, [{ label: "压缩上下文", data: "/compact", row: 0 }]);
    case "usage":
      // Nothing to show, a Claude without get_usage: its sentence, with no card to draw empty.
      if (!r.limits.length && !r.extra && r.credits === undefined && !r.session) return void answer(d, ctx, at, formatCommand(r, info, ctx.now));
      return query(state, ctx, d, at, usageText(r, info.agent as AgentKind, ctx.now), { ...r, agent: info.agent as AgentKind }, []);
    default:
      return void answer(d, ctx, at, formatCommand(r, info, ctx.now));
  }
}

/** The choices with the one now marked: as the agent marks it, else the one whose id is fallback. */
const marked = (choices: Choice[], fallback: string): Choice[] =>
  choices.some((c) => c.current) ? choices : choices.map((c) => (c.id === fallback ? { ...c, current: true as const } : c));

/** /status's common buttons, by what the slot is doing (docs/im-style.md §7). */
function statusButtons(slot: Slot): Button[] {
  const cancel = (row: number): Button => ({ label: "取消", data: CANCEL, row, muted: true });
  if (slot.mode === "tui") return [{ label: "切回无头", data: "/rh_release", row: 0 }, cancel(1)];
  const running = slot.state === "running" || slot.state === "waiting";
  const all = layout([
    ...(running ? [{ label: "停止", data: "/stop" }] : []),
    { label: "换模型", data: "/model" },
    { label: "思考强度", data: "/effort" },
    { label: "压缩上下文", data: "/compact" },
    ...(running ? [] : [{ label: "开新对话", data: "/new" }]),
  ]);
  return [...all, cancel(all.at(-1)!.row! + 1)];
}

/** Every slot not archived (all: those too), as the lists see it. */
function slotEntries(state: State, all = false): SlotEntry[] {
  return state.slots
    .filter((s) => all || s.archivedAt === null)
    .map((s) => {
      const ws = state.workspaces.find((w) => w.id === s.workspace)!;
      const urgency = URGENCY.indexOf(s.state);
      return { id: s.id, ref: `${ws.name}/${s.name}`, workspace: ws.name, name: s.name, urgency: urgency < 0 ? URGENCY.length : urgency };
    });
}
/** How /rh_ls orders a workspace's slots: these first, in this order (docs/im-style.md §8.1). */
const URGENCY: Slot["state"][] = ["waiting", "crashed", "running", "rate_limited"];

const agentOf = (state: State, s: Slot): AgentKind => state.conversations.find((c) => c.id === s.conversation)?.agent ?? DEFAULT_AGENT;

/** The slot's state as /rh_ls names it (docs/im-style.md §8.1). */
function stateWord(s: Slot): string {
  if (s.mode === "tui") return s.herdrPane !== null && s.tuiPid === null ? "没能切回无头" : "TUI 模式";
  return STATE[s.state];
}

/** /status's second line, and that of a slot's details: how the slot is, in the board's words, what
 *  to add after a comma (docs/im-style.md §7.1). */
function stateLine(s: Slot, now: number): string {
  if (s.mode === "tui") return s.herdrPane !== null && s.tuiPid === null ? "没能切回无头，这里的消息还不会交给它" : "TUI 模式";
  switch (s.state) {
    case "running":
      return s.turnStartedAt === null ? STATE.running : `运行中，这一回合跑了 ${span(Math.max(0, now - s.turnStartedAt))}`;
    case "rate_limited":
      return s.resumeAt === null ? STATE.rate_limited : `等额度，${moment(s.resumeAt, now)} 恢复`;
    case "off":
      return "未运行，来消息就启动";
    case "crashed":
      return "崩溃，发一条消息就恢复";
    default:
      return STATE[s.state];
  }
}

/** /rh_ls (docs/im-style.md §8.1, §8.2): the slots by workspace, how many, and a button each for its details. */
function lsPanel(state: State, ctx: Ctx, bot: Bot, chat: Chat, all: boolean): Panel {
  const here = target(state, bot, chat, ctx);
  const slots = slotEntries(state, all);
  const hereRef = here && slotView(state, here).ref;
  const candidates = imCommand("rh_ls")!.list!({ slots, here: hereRef });
  const shown = candidates.map((c) => {
    const e = slots.find((x) => c.command === `/rh_ls ${x.ref}` || c.command === `/rh_ls ${x.id}`)!;
    return { e, s: state.slots.find((x) => x.id === e.id)! };
  });
  const urgent = shown.filter(({ s }) => s.state === "waiting").length;
  const text = ({ page, pages, again }: { page: number; pages: number; again: boolean }) => {
    const pageLine = pages > 1 ? `第 ${page} 页，共 ${pages} 页。` : "";
    if (again) return pageLine;
    if (!candidates.length) return state.slots.length ? "没有未归档的槽位。发 /rh_ls --all 连已归档的也列出。" : "还没有槽位。用 rh new <工作区/槽位> 新建。";
    // Headings as a query reply's (docs/im-style.md §8.1); the numbers as written, no list.
    const lines: string[] = [md`## ${candidates.length} 个槽位${urgent ? `，${urgent} 个需要你` : ""}`];
    let ws: string | undefined;
    shown.forEach(({ e, s }, i) => {
      if (e.workspace !== ws) {
        ws = e.workspace;
        lines.push("", md`### ${ws}（\`${tilde(state.workspaces.find((w) => w.id === s.workspace)!.dir)}\`）`);
      }
      const agent = agentOf(state, s);
      const notes = [...(agent === DEFAULT_AGENT ? [] : [agent]), ...(s.state === "rate_limited" && s.resumeAt !== null ? [`${moment(s.resumeAt, ctx.now)} 恢复`] : [])];
      const word = s.archivedAt === null ? stateWord(s) : "已归档";
      lines.push(`${pages > 1 ? `${i + 1}. ` : ""}${e.name} ${word}${notes.length ? `（${notes.join("，")}）` : ""}`);
    });
    const where = hereRef ? `这里的消息交给 ${hereRef}。` : "这里还没指定槽位。";
    lines.push("", `${where}点一个看详情${pages > 1 ? `，也可以回编号。${pageLine}` : "。"}`);
    return lines.join("\n");
  };
  return { command: all ? "/rh_ls --all" : "/rh_ls", candidates, text, query: true };
}

/** /rh_ls <slot> (docs/im-style.md §8.3): what the slot is, and what you can do with it. */
function slotPanel(state: State, ctx: Ctx, s: Slot, chat: Chat, bot: Bot): Panel {
  const ref = slotView(state, s).ref;
  const parent = parentOf(state, s);
  const agent = AGENTS[agentOf(state, s)].name;
  const origin = parent ? `它是 ${slotView(state, parent).ref} 派生的${LIFETIME[s.lifetime]}槽位，用 ${agent}。` : `用 ${agent}。`;
  const changed = changedSettings(s, ctx.config);
  // Its head as /status's, a query reply's (docs/im-style.md §8.3).
  const settings = changed.length ? `改过的设置：${changed.join("，")}。` : "设置都是默认。";
  const text = md`## ${ref}\n${stateLine(s, ctx.now)}\n${origin}\n\n目录：\`${tilde(s.dir)}\`\n${settings}`;
  const arg = Buffer.byteLength(`/rh_release ${ref}`) <= 64 ? ref : s.id;
  const running = s.state === "running" || s.state === "waiting";
  const actions = [
    ...(target(state, bot, chat, ctx)?.id !== s.id ? [{ label: "交给这里", command: `/rh_use ${arg}` }] : []),
    ...(s.mode === "headless" ? [{ label: "切到 TUI", command: `/rh_tui ${arg}` }] : [{ label: "切回无头", command: `/rh_release ${arg}` }]),
    ...(running ? [{ label: "停止", command: `/stop ${arg}` }] : []),
    ...(s.mode === "headless" && !running && s.archivedAt === null ? [{ label: "归档", command: `/rh_archive ${arg}` }] : []),
  ];
  return { command: `/rh_ls ${arg}`, candidates: actions, text: () => text, back: "/rh_ls", query: true };
}

/** The tables the targets and menus are worked out from. */
export type Bindings = Pick<State, "workspaces" | "slots" | "conversations" | "bots" | "chats">;

/** The chat's own target, else the bot's default (/rh_bind), else the `target` in the bot's config table. */
export function target(state: Bindings, bot: Bot, chat: Chat | undefined, ctx: Pick<Ctx, "config">): Slot | undefined {
  const id = chat?.target ?? bot.defaultTarget;
  if (id) return state.slots.find((s) => s.id === id);
  const ref = ctx.config.bots[bot.name]?.target;
  return ref ? slotByRef(state, ref) : undefined;
}

/**
 * What each bot should have on its platform (product §5.7): the / menu, the commands the agent of the
 * slot your private chat goes to takes and /rh_help; and the row of Rhodium's own, where the platform
 * has one. chat: on a platform with them per chat (Telegram), one for each owner's private chat, by
 * its id, your user id; on one with one for the bot (QQ), left out, by the one owner's chat, or with
 * several, by the bot's default target.
 */
// ponytail: your private chats only, as v1 has no group chats; them for each chat once groups come.
export function menus(state: Bindings, ctx: Pick<Ctx, "config" | "capabilities">): { bot: string; chat?: string; row?: RowButton[]; menu: MenuItem[] }[] {
  return state.bots.flatMap((bot) => {
    const caps = ctx.capabilities(bot.id);
    if (!caps) return [];
    const own = owners(bot, ctx.config);
    const chats = state.chats.filter((c) => c.bot === bot.id && own.includes(c.platformChatId));
    const row = caps.menu.row ? { row: caps.menu.row === "custom_menu" ? QQ_ROW : TELEGRAM_ROW } : {};
    const want = (chat: Chat | undefined) => {
      const slot = target(state, bot, chat, ctx);
      return { ...row, menu: slashMenu(state.conversations.find((c) => c.id === slot?.conversation)?.agent) };
    };
    if (caps.menu.scope === "per_chat") return own.map((o) => ({ bot: bot.id, chat: o, ...want(chats.find((c) => c.platformChatId === o)) }));
    return [{ bot: bot.id, ...want(own.length === 1 ? chats[0] : undefined) }];
  });
}

/** The chat row of mainChat in the config, added if new; undefined if there is none. */
function mainChat(state: Bindings, ctx: Pick<Ctx, "config" | "newId">, d: Decision): Chat | undefined {
  if (!ctx.config.mainChat) return undefined;
  const { bot: name, chat } = ctx.config.mainChat;
  const bot = state.bots.find((b) => b.name === name);
  return bot && chatRow(state, ctx, d, bot, chat);
}

/** The bot's chat row with this platform chat id, added if this decision has none yet. */
function chatRow(state: Bindings, ctx: Pick<Ctx, "newId" | "config">, d: Decision, bot: Bot, platformChatId: string): Chat {
  const known = state.chats.find((c) => c.bot === bot.id && c.platformChatId === platformChatId);
  if (known) return known;
  for (const w of d.writes) if (w.op === "insert" && w.table === "chat" && w.row.bot === bot.id && w.row.platformChatId === platformChatId) return { machine: "", target: null, panel: null, verbose: null, contactedAt: null, ...w.row };
  const row = { id: ctx.newId(), bot: bot.id, platformChatId };
  d.writes.push({ op: "insert", table: "chat", row });
  // Your private chat, there before you wrote in it: your avatar and name under the bot come now.
  if (ownerChat(bot, row, ctx)) d.effects.push({ kind: "avatars", bot: bot.id });
  return { ...row, machine: "", target: null, panel: null, verbose: null, contactedAt: null };
}

// ---- Agent events, from the driver or the slot runner. ----

function agent(state: State, e: AgentEvent, ctx: Ctx): Decision {
  const d = agentEvent(state, e, ctx);
  if (e.type === "turn_end" || e.type === "exit") cutShort(state, ctx, d, e.conv);
  return d;
}

/** The conversation's turn is over. Cut short (a crash, rh stop, an interrupt, a switch to another
 *  agent or to the terminal), it gave its message no last edit: the message stays as it was, without
 *  the step still running (im-style §3.1). Nothing edits it after, the clock neither: the turn's
 *  progress is gone (agentEvent). */
function cutShort(state: State, ctx: Ctx, d: Decision, conversation: string): void {
  const conv = state.conversations.find((c) => c.id === conversation);
  const p = progressOf(conv?.progress);
  const to = toChat(state, p?.chat ?? null, ctx);
  const slot = state.slots.find((s) => s.id === conv?.slot);
  if (!p?.live || !to?.caps || !slot || d.effects.some((x) => x.kind === "edit" && x.outbound === p.live)) return;
  const v = viewOf({ ...to, caps: to.caps }, slot, ctx);
  lastEdit(d, p.live, p, p.toolsOnly ? { ...v, toolsOnly: true } : v);
}

function agentEvent(state: State, e: AgentEvent, ctx: Ctx): Decision {
  const d = nothing();
  // What the turn shows so far, and on Telegram which message it edits. It commits with the out.log
  // offset of the output that changed it, so after a restart the output past that offset carries on
  // from it (architecture §4.5).
  // ponytail: rewrites the turn's latest message on each delta; keep only the sent length if that load shows.
  const saved = state.conversations.find((c) => c.id === e.conv)?.progress;
  const progress: TurnProgress = progressOf(saved) ?? start();
  const keep = (p: TurnProgress | null) =>
    d.writes.push({ op: "update", table: "conversation", where: { id: e.conv }, patch: { progress: p && JSON.stringify(p) } });
  // Also once the conversation is no longer its slot's (/new): its turn is over all the same.
  if (saved && (e.type === "turn_end" || e.type === "exit")) keep(null);
  // Whether background tasks run, which keep the agent from being reaped. They end with its process.
  if (e.type === "background" || e.type === "exit") {
    const background = e.type === "background" && e.tasks.length > 0 ? 1 : 0;
    d.writes.push({ op: "update", table: "conversation", where: { id: e.conv }, patch: { background } });
  }
  // The agent has the turn once it takes in one of its inputs, or begins it by itself, as Claude
  // running the interrupted one again (architecture §4.8): only then does a crash cut a turn short.
  const had = state.conversations.find((c) => c.id === e.conv)?.turnTaken;
  if (!had && (e.type === "taken" || (e.type === "turn_start" && e.input === undefined)))
    d.writes.push({ op: "update", table: "conversation", where: { id: e.conv }, patch: { turnTaken: 1 } });
  if (had && (e.type === "turn_end" || e.type === "exit")) d.writes.push({ op: "update", table: "conversation", where: { id: e.conv }, patch: { turnTaken: null } });
  // The agent process ended. What follows is the conversation's, so it is done also once the slot has
  // moved on: /new, /rh_agent and /resume stop the agent the slot leaves, and its exit comes after.
  // With no agent started (busy, missing), nothing ended.
  if (e.type === "exit" && !e.busy && !e.missing) {
    // A line still going in when the agent or its holder went, or written and not yet taken into the
    // conversation, may or may not have got there. It is never written again by itself (architecture §4.6).
    // One that never opened the conversation (its driver's why, Codex's) was written none: it waits.
    for (const status of ["writing", "written"] as const)
      d.writes.push({ op: "update", table: "agentInput", where: { conversation: e.conv, status }, patch: { status: e.why ? "queued" : "unknown" } });
    // A resume let through was this process's: one gone before it answered initialize leaves it
    // queued (runner). It goes; a resume of this crash is queued afresh (wake).
    d.writes.push({ op: "delete", table: "agentInput", where: { conversation: e.conv, status: "queued", source: "crash_resume", queueReason: null } });
    // Its exit file is old news from now on, until the next holder is launched (architecture §4.2).
    d.writes.push({ op: "update", table: "holder", where: { conversation: e.conv }, patch: { exited: 1 } });
  }
  const slot = state.slots.find((s) => s.conversation === e.conv);
  if (!slot) return d;
  const set = (patch: Patch<Slot>) => d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
  // When the turn began, for /status (docs/im-style.md §7.1), as the agent says: a turn a ! began after
  // cutting the last one short counts afresh, as does a child's first. None between turns.
  // It is active as a turn starts, whoever began it (product §7); as it ends, in turnOver.
  if (e.type === "turn_start") set({ turnStartedAt: ctx.now, activeAt: ctx.now });
  else if ((e.type === "turn_end" || e.type === "exit") && slot.turnStartedAt !== null) set({ turnStartedAt: null });
  // rh agent waits for this turn to end: nothing more of this conversation runs, as the slot moves on (below).
  const swap = slot.mode === "headless" ? slot.nextAgent : null;
  // Lets a message held for an interrupt go to the agent.
  const release = () => releaseQueued(d, e.conv, AFTER_INTERRUPT);
  const queuedFor = (reason: string) => state.queued.some((i) => i.conversation === e.conv && i.queueReason === reason);
  // A child waiting on you is stuck (architecture §9.2).
  const stuck = (a: AgentAsk) => report(state, ctx, d, slot, "stuck", `它有提问在等用户回答：${askLine(a.kind, { tool: a.tool, input: a.input })}`, { relay: "提问已经推给用户，不用转告。" });
  switch (e.type) {
    case "turn_start":
      // Also a turn the agent began by itself, say when a background task woke it: it has no
      // chat to reply to.
      if (slot.state === "idle" || slot.state === "starting") set({ state: "running" });
      // Your message reached the agent just as its last turn ended: the router took it for joining
      // that turn, whose end then cleared the turn's chat. It began this one, which replies to it.
      if (slot.turnChat === null && state.begun) set({ turnChat: state.begun.chat, turnInbound: state.begun.inbound });
      // Claude began one by itself while waiting for its quota: the quota is back, the wait is over,
      // and what was queued for the reset joins the turn. Refused again, it waits afresh (usage).
      if (slot.state === "rate_limited") {
        set({ state: "running", resumeAt: null, interruptedAt: null });
        d.effects.push({ kind: "timer", timer: "quota_reset", key: slot.id, at: null });
        releaseQueued(d, e.conv, AFTER_QUOTA);
        d.effects.push({ kind: "deliver", conversation: e.conv });
      }
      // What it reported in its last turn is old news: this one reports afresh, and has told you nothing yet.
      if (slot.reported !== null) set({ reported: null });
      if (slot.turnToldYou !== null) set({ turnToldYou: null });
      if (slot.turnPlanTimedOut) set({ turnPlanTimedOut: null });
      break;
    case "text_delta":
    case "item":
    case "tool_start": {
      const to = shown(state, ctx, slot);
      if (!to) break;
      const v = viewOf(to, slot, ctx);
      if (to.caps.progress === "edit") {
        // What the agent says shows under a panel sent here since: the panel's numbers are void (docs/im-style.md §11.4).
        const memo = memoOf(to.chat.panel);
        const says = e.type === "text_delta" || (e.type === "item" && e.item.kind === "message");
        if (memo?.commands && says && !v.toolsOnly) d.writes.push({ op: "update", table: "chat", where: { id: to.chat.id }, patch: { panel: unnumbered(memo) } });
        keep(showEdit(d, ctx, to, slot, progress, edit(progress, e, v)));
        // Its line says for how long it runs, from a minute on (im-style §3.1).
        if (e.type === "tool_start") d.effects.push({ kind: "timer", timer: "tool_running", key: e.conv, at: ctx.now + MINUTE });
        break;
      }
      const q = quotas(state, ctx, d);
      // Room for what it says: one passive reply stays for the final message, one for the hint.
      const r = append(progress, e, v, q.passive(slot.turnInbound!) - 2);
      keep(r.progress);
      for (const text of r.sends) {
        q.take("qq_passive", slot.turnInbound!);
        outbound(d, ctx, { chat: to.chat.id, replyTo: slot.turnInbound, trace: slot.turnInbound, text, markdown: markdown(text, to.caps) });
      }
      break;
    }
    case "turn_end": {
      turnOver(d, ctx, slot);
      // Your /compact's turn ends with no reply: the event says so before its idle, which the web's
      // 未读 takes as a final_reply (spec web-maximize "未读和跑完提醒怎么做").
      if (e.compactOnly) d.events.push({ source: "agent", type: "compacted", slot: slot.id, ...(slot.turnInbound && { trace: slot.turnInbound }) });
      // Idle now: a child is done, unless a background task will wake it for another turn (architecture §9.2).
      // Your /compact alone is no work of the child's. One whose plan went unapproved at the timeout
      // stopped to wait for you: stuck, its reply holding the plan's summary, though it reported stuck
      // this turn already, of that ask or one it raised since.
      const done = () => {
        if (slot.turnPlanTimedOut) report(state, ctx, d, { ...slot, reported: null }, "stuck", `它的计划确认超时，没有批准，停下来等用户回复。${replyStart(e.reply)}`);
        else if (!e.background && !e.compactOnly) report(state, ctx, d, slot, "done", replyStart(e.reply));
      };
      // Switching to the terminal (rh tui): the turn it waited for is over, so the headless agent goes
      // now, its exit opens the pane, and what was held for an interrupt waits for the switch back.
      const tui = slot.mode === "tui";
      if (tui && !stopping(state, e.conv)) stopAgent(d, e.conv);
      // What waited for this turn to end waits for the switch back instead.
      if (tui) releaseQueued(d, e.conv, AFTER_TURN, IN_TUI);
      // What waited for this turn to end, with no message held for an interrupt to run first, runs now
      // as a turn of its own (AFTER_TURN): an internal message's, with no chat to reply to.
      const next = () => {
        if (tui || swap || !queuedFor(AFTER_TURN)) return;
        releaseQueued(d, e.conv, AFTER_TURN);
        set({ state: "running" });
        d.effects.push({ kind: "deliver", conversation: e.conv });
      };
      // Refused for quota: no reply, as the reply is the refusal, and the turn carries on at the
      // reset (clock), its chat kept for the reply then. What was held for an interrupt or for the
      // turn's end waits too; an interrupt with nothing held was a /stop, so the turn does not carry
      // on (clock). An interrupted turn is over all the same: a send me was its, not the next turn's.
      if (slot.state === "rate_limited") {
        releaseQueued(d, e.conv, AFTER_INTERRUPT, AFTER_QUOTA);
        releaseQueued(d, e.conv, AFTER_TURN, AFTER_QUOTA);
        releaseQueued(d, e.conv, WEB_QUEUE, AFTER_QUOTA);
        if (slot.interruptedAt !== null) set({ turnSentMe: null });
        break;
      }
      // An agent launched in the old approval mode goes now the slot is idle, unless a message held
      // for an interrupt or the turn's end, or queued on the board, runs next. The next message starts
      // it in the new mode (architecture §6.3).
      if (!tui && !swap && slot.approvalStale && !stopping(state, e.conv) && !queuedFor(AFTER_INTERRUPT) && !queuedFor(AFTER_TURN) && !queuedFor(WEB_QUEUE)) {
        stopAgent(d, e.conv);
        set({ approvalStale: null });
      }
      // rh stop cut this turn short: no reply, and the turn fields now belong to your message since (see exit).
      if (stopping(state, e.conv)) {
        set({ state: "idle" });
        break;
      }
      if (slot.interruptedAt !== null) {
        // A turn cut short, by a stop or a !, leaves the board's queue paused (spec web-write "待发队列").
        releaseQueued(d, e.conv, WEB_QUEUE, WEB_PAUSED);
        // The interrupted turn is over and sends no reply. What was held meanwhile runs next, and
        // its chat is the turn's already; what waited for the interrupted turn's end goes in with it.
        if (!tui && !swap && queuedFor(AFTER_INTERRUPT)) {
          release();
          releaseQueued(d, e.conv, AFTER_TURN);
          set({ interruptedAt: null, turnSentMe: null });
          d.effects.push({ kind: "deliver", conversation: e.conv });
        } else {
          set({ state: "idle", turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null });
          done();
          next();
        }
        break;
      }
      set({ state: "idle", turnChat: null, turnInbound: null, turnSentMe: null });
      done();
      // What you queued on the board meanwhile goes now as the next turn, the board's: the first begins
      // it, the rest join it. What waited for this turn's end waits for that one's (spec web-write "待发队列").
      const queued = !tui && !swap ? state.queued.find((i) => i.conversation === e.conv && i.queueReason === WEB_QUEUE) : undefined;
      if (queued) {
        releaseQueued(d, e.conv, WEB_QUEUE);
        set({ state: "running", turnChat: BOARD, turnInbound: queued.trace });
        d.effects.push({ kind: "deliver", conversation: e.conv });
      } else next();
      // Only a turn you started from IM gets its final reply sent, and not once the agent has
      // used rh send me in that chat (product §5.5): then the turn ends with its tool lines alone (View).
      const to = toChat(state, slot.turnChat, ctx);
      const v = to?.caps && viewOf({ ...to, caps: to.caps }, slot, ctx);
      if (!to) break;
      const q = quotas(state, ctx, d);
      let last: Msg[];
      if (!v) {
        // ponytail: a bot with no adapter running gets the reply alone, to fail there as any send would.
        last = e.reply && !slot.turnSentMe ? [{ text: e.reply }] : [];
        send(state, q, ctx, d, to, slot.turnInbound, last, slotView(state, slot).ref);
      } else if (v.caps.progress === "edit") {
        // The turn's message, the final reply its last part, without the step still running; what it
        // can't hold follows. Edited even when unchanged, so a message that never went out comes now (edit_failed).
        last = finishEdit(progress, e.reply, v);
        last.forEach((m, i) => {
          if (i > 0 || !progress.live) return send(state, q, ctx, d, to, slot.turnInbound, [m], slotView(state, slot).ref);
          editLive(d, progress, progress.live, m, { final: true, unchanged: m.text === progress.shown });
        });
      } else {
        // On QQ, what the agent said before its last went out already, or waits for now. A reply
        // that went out mid-turn, tools after it, leaves nothing to send, and was still given.
        last = finish(progress, e.reply, v).map((text) => ({ text }));
        send(state, q, ctx, d, to, slot.turnInbound, last, slotView(state, slot).ref);
      }
      if (!slot.turnSentMe && (e.reply || last.length)) d.events.push({ source: "agent", type: "final_reply", slot: slot.id, ...(slot.turnInbound && { trace: slot.turnInbound }) });
      break;
    }
    case "usage": {
      // The agent refused the turn for quota until resetsAt: the slot waits for it, and you hear when
      // it carries on (product §4.6). A refusal with no reset ahead gives nothing to wait for, and
      // its turn ends as any other. Each agent's quota is its own, as is its notice's clock.
      const q = e.quota;
      if (!q?.exhausted || q.resetsAt === null || q.resetsAt <= ctx.now || (slot.state !== "running" && slot.state !== "rate_limited")) break;
      stagger(state, ctx, d, slot, q.resetsAt);
      if (slot.state === "rate_limited") break;
      set({ state: "rate_limited", quotaUntold: 1 });
      d.events.push({ source: "agent", type: "quota_out", slot: slot.id, data: { resetsAt: q.resetsAt } });
      // You hear a little later, with the other slots running out with it (quotaNotice()).
      const kind = agentOf(state, slot);
      const armed = waitingFor(state, kind).some((s) => s.quotaUntold);
      if (!armed) d.effects.push({ kind: "timer", timer: "quota_notice", key: kind, at: ctx.now + ctx.config.durations.quotaNotice });
      break;
    }
    case "background":
      // The last task is done: the slot is idle from now on. Claude's wakes it for a turn first, maybe
      // in the next chunk, so the clock does not look at the output at once: a stop would cut that turn.
      // Claude also says it runs none after each initialize, as at a restart: no task ended then.
      if (!e.tasks.length && slot.state === "idle" && state.conversations.find((c) => c.id === e.conv)?.background) reapAt(d, ctx, slot, ctx.now);
      break;
    case "written":
      // In the agent's stdin, not yet in its conversation: its body stays till the agent takes it (architecture §4.6).
      d.writes.push({ op: "update", table: "agentInput", where: { id: e.inputId, status: "writing" }, patch: { status: "written" } });
      break;
    case "taken":
      // Also before the holder's ack, which then finds it taken.
      for (const status of ["writing", "written"] as const)
        d.writes.push({ op: "update", table: "agentInput", where: { id: e.inputId, status }, patch: { status: "taken", body: null, images: null } });
      break;
    case "ask": {
      const { conv, proc, type, ...ask } = e;
      // After a restart the agent's own list may name it again (pending_asks): it is on record already.
      if (agentAsks(state, slot).some((a) => a.requestId === ask.requestId)) break;
      // The call it asks about shows as this ask, in no tool line (im-style §3.1).
      const p = hide(progress, ask.toolUse);
      if (p !== progress) keep(p);
      if (addAsk(state, ctx, d, slot, ask) === slot.turnChat) underIt(state, ctx, d, slot, p);
      waiting(state, d, slot, blocking(state, slot).length + 1);
      stuck(ask);
      break;
    }
    case "ask_cancel": {
      const gone = agentAsks(state, slot).filter((a) => a.requestId === e.requestId);
      cancelAsks(d, gone);
      waiting(state, d, slot, blocking(state, slot).filter((a) => !gone.includes(a)).length);
      break;
    }
    case "pending_asks": {
      // Reconciled with what the agent says it still waits on (architecture §5 step 5). An agent too
      // old to say leaves none of them standing.
      const live = e.asks ?? [];
      const mine = agentAsks(state, slot);
      const gone = mine.filter((a) => !live.some((l) => l.requestId === a.requestId));
      cancelAsks(d, gone);
      // You answered while the answer could not reach it: it goes now.
      for (const a of mine) if (a.status === "answered" && !gone.includes(a)) d.effects.push({ kind: "answer", conversation: e.conv, ask: a.id });
      // Only one never on record is new. pi's list comes from its replayed output, which never shows
      // an answer, as that went to its stdin: one answered and delivered may still be on it.
      const fresh = live.filter((l) => !state.listed.some((a) => a.slot === slot.id && a.requestId === l.requestId));
      const chats = fresh.map((a) => addAsk(state, ctx, d, slot, a));
      const p = fresh.reduce((p, a) => hide(p, a.toolUse), progress);
      if (p !== progress) keep(p);
      if (slot.turnChat && chats.includes(slot.turnChat)) underIt(state, ctx, d, slot, p);
      waiting(state, d, slot, blocking(state, slot).filter((a) => !gone.includes(a)).length + fresh.length);
      if (fresh[0]) stuck(fresh[0]);
      break;
    }
    case "exit": {
      if (e.busy || e.missing) {
        // No agent started: someone else has the conversation (architecture §10.1), or its program
        // was not there (§4.2). No crash, and what waits for the agent keeps waiting, for its next start.
        set({ state: "off", turnChat: null, turnInbound: null, turnSentMe: null });
        releaseQueued(d, e.conv, AFTER_TURN); // the turn it waited for is gone; held, it would hold back the rest
        // An agent that would not open the conversation (Codex's writer lock) was given none of it.
        d.writes.push({ op: "update", table: "agentInput", where: { conversation: e.conv, status: "writing" }, patch: { status: "queued" } });
        d.writes.push({ op: "update", table: "holder", where: { conversation: e.conv }, patch: { exited: 1 } });
        const ref = slotView(state, slot).ref;
        if (e.busy) {
          d.events.push({ source: "agent", type: "agent_busy", slot: slot.id, data: { error: e.busy } });
          notify(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${ref} 没能启动，这段对话别处正在用。那边退出后再发一条消息，等着的消息会一起交给它。\n原因：${e.busy}`);
        } else {
          const why = `等了 ${span(ctx.config.durations.programWait)}还是找不到 ${tilde(e.missing!)}`;
          d.events.push({ source: "agent", type: "agent_missing", slot: slot.id, data: { error: why } });
          notify(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${ref} 没能启动，找不到 ${basename(e.missing!)} 程序。\n等着的消息都还在，不用重发。下次来消息时再启动它，到时一起交给它。\n原因：${why}`);
        }
        break;
      }
      // An exit Rhodium did not record asking for is a crash (architecture §4.8): you hear of it, and
      // a turn it cut short is resumed (product §4.5), unless the slot says not to, or it is the
      // crashCount-th crash of the conversation within crashWindow. Only those times count. A stop
      // that ended the wait for the agent's program says so itself: no holder may be on record.
      const asked = stopping(state, e.conv) || e.stopped !== undefined;
      const brake = braked(state, e.conv) || e.stopped === 2;
      const window = ctx.config.durations.crashWindow;
      const crashes = asked ? [] : [...JSON.parse(state.conversations.find((c) => c.id === e.conv)!.crashTimes ?? "[]"), ctx.now].filter((t: number) => ctx.now - t < window);
      if (!asked) d.writes.push({ op: "update", table: "conversation", where: { id: e.conv }, patch: { crashTimes: JSON.stringify(crashes) } });
      const tripped = crashes.length >= ctx.config.limits.crashCount;
      // A turn you were stopping is not run again, nor one the agent never had: killed before it
      // took in any of the turn's inputs, it has no turn to run again (product §4.5).
      const midTurn = hadTurn(state, slot, e.conv) && slot.interruptedAt === null;
      // Switching to the terminal or to another agent, the switch takes over instead.
      const on = !asked && !tripped && slot.mode === "headless" && !swap && Boolean(slot.crashResume ?? ctx.config.defaults.crashResume);
      const resume = on && midTurn;
      // Waiting for quota, its refused turn had ended: the agent starts again and the wait goes on.
      // Short of free disk it is not started again (architecture §7.8).
      const rewait = on && slot.state === "rate_limited" && !lowDisk(ctx);
      // Stopped with your message waiting since the stop: off, then that message starts it (product §4).
      // So does an internal message that came while it stopped or waited for the stopped turn to end
      // (AFTER_STOP, AFTER_TURN). Unless
      // the slot is archived or the emergency stop stopped it: those wait for its next start, and
      // the emergency stop has given yours back to you already.
      const waited = slot.archivedAt === null && !brake && (queuedFor(AFTER_STOP) || queuedFor(AFTER_TURN));
      const again = asked && slot.mode === "headless" && !swap && (slot.turnInbound !== null || waited);
      // Short of free disk it stays off instead (architecture §7.8): what waits, waits for room, as
      // in wake, and the turn your message began keeps its chat for the reply.
      const low = again && lowDisk(ctx);
      // The next start writes them, rather than leave them held for good. The board's queue is paused
      // by a process gone, as by a stop (spec web-write "待发队列").
      release();
      releaseQueued(d, e.conv, WEB_QUEUE, WEB_PAUSED);
      releaseQueued(d, e.conv, AFTER_ASKS);
      releaseQueued(d, e.conv, AFTER_STOP);
      // Resumed, the turn they waited for runs first, and they after it, as ever.
      if (!resume) releaseQueued(d, e.conv, AFTER_TURN);
      if (!rewait) releaseQueued(d, e.conv, AFTER_QUOTA); // the quota wait ends with the process
      if (low) releaseQueued(d, e.conv, null, MAX_RUNNING);
      cancelAsks(d, agentAsks(state, slot)); // no process waits on them any more
      if (slot.approvalStale) set({ approvalStale: null }); // the next process starts in the mode set
      if (slot.state !== "idle") turnOver(d, ctx, slot); // a turn cut short ends here; an idle one's clock runs on
      d.events.push({ source: "agent", type: asked ? "agent_stopped" : "agent_crashed", slot: slot.id, data: { code: e.code, signal: e.signal, from: e.from } });
      // Stopped, it took your messages it had not taken in with it: you hear so, as of a crash (product §4.5).
      if (asked) quoteBack(state, ctx, d, slot, state.unsure.filter((i) => i.source === "human"), (n) => `${slotView(state, slot).ref} 停下了，${n}不确定它收到没有，需要的话再发一遍：`);
      if (rewait) {
        d.effects.push({ kind: "start", slot: slot.id });
        crashed(state, ctx, d, slot, e, `还在等 ${AGENTS[agentOf(state, slot)].name} 额度，已经重新启动，${moment(slot.resumeAt!, ctx.now)} 照常恢复。`);
        break;
      }
      if (again && !low) {
        set({ state: "starting", interruptedAt: null, turnSentMe: null }); // a send me before the restart was the stopped agent's
        d.effects.push({ kind: "start", slot: slot.id });
        break;
      }
      // Switching to the terminal, the headless agent is gone: its pane opens (architecture §10.1),
      // unless the emergency stop came meanwhile, which calls the switch off: what waited for the
      // switch back then waits for the slot's next start.
      const switching = slot.mode === "tui" && slot.herdrPane === null;
      const calledOff = switching && brake;
      if (switching && !calledOff) d.effects.push({ kind: "tui_open", slot: slot.id });
      if (calledOff) {
        releaseQueued(d, e.conv, IN_TUI);
        // Whoever waits to hear how the switch went hears so now: an agent with its next message, as
        // the emergency stop wakes no one; you, in the chat you asked in (product §10).
        const waiting = slot.switchDecision ? (JSON.parse(slot.switchDecision) as { slot?: string; chat?: string }) : undefined;
        const ref = slotView(state, slot).ref;
        const text = `你请求的 rh tui ${ref} 被急停取消了，${ref} 停着，还是无头模式。`;
        const to = waiting?.slot ? state.slots.find((s) => s.id === waiting.slot) : undefined;
        if (to?.conversation) d.writes.push({ op: "insert", table: "agentInput", row: { id: ctx.newId(), conversation: to.conversation, source: "confirm", status: "queued", body: text } });
        else if (waiting?.chat) notify(state, ctx, d, slot, ctx.newId(), text, undefined, state.chats.find((c) => c.id === waiting.chat));
      }
      if (low) notify(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${low}：${slotView(state, slot).ref} 停下后没有再启动，等着的消息先排队。有了空间，等有槽位停下或 Rhodium 重启时再投给它。`);
      // A resumed turn keeps its chat: its reply still goes to you.
      set({
        state: asked ? "off" : "crashed",
        interruptedAt: null,
        resumeAt: null,
        ...(!resume && { turnSentMe: null }),
        ...(!resume && !low && { turnChat: null, turnInbound: null }),
        ...(calledOff && { mode: "headless" as const, switchDecision: null }),
      });
      // The resume is a wake of Rhodium's own, so it waits for room at the running limit (product §6.1).
      const waits = resume ? wake(state, ctx, d, { ...slot, state: "crashed" }, { source: "crash_resume", body: RESUME_PROMPT }, { stopped: slot.id }) : undefined;
      if (!asked) {
        const then = resume
          ? waits
            ? lowDisk(ctx)
              ? "磁盘快满了，有了空间就自动恢复。"
              : "同时运行的槽位满了，有空位就自动恢复。"
            : "正在自动恢复这段对话。"
          : swap
            ? `它换成了 ${swap}，下一条消息开始新对话。`
            : tripped
              ? `${span(window)}里崩了 ${crashes.length} 次，不再自动恢复。发一条消息就重新启动它。`
              : // It never started: what waited for it is still queued, for the next start, as after the
                // wait for a missing program (architecture §4.2).
                slot.state === "starting" && [...state.queued, ...(e.why ? state.unsure : [])].some((i) => i.conversation === e.conv && i.source !== "crash_resume")
                ? "等着的消息都还在，不用重发。下次来消息时再启动它，到时一起交给它。"
                : "发一条消息就恢复这段对话。";
        crashed(state, ctx, d, slot, e, then);
      }
      // Resumed at once, it takes back its own place.
      if (waits !== null) makeRoom(state, ctx, d, slot.id);
      // ponytail: the parent this wakes may take a place makeRoom just gave away, one over the limit.
      if (!asked && !resume) report(state, ctx, d, slot, "stuck", "它崩溃了，没有自动恢复。", { stopped: slot.id, relay: "用户已收到崩溃通知，不用转告。" });
      break;
    }
    case "protocol_error":
      // A line the agent got wrong is for the board. Anything else is a failure you hear of, say pi
      // refusing your message: no turn runs for it, so you would hear nothing else.
      d.events.push({ source: "agent", type: "protocol_error", slot: slot.id, data: { reason: e.reason, detail: clip(e.detail, 500) } });
      // Once a turn: a broken approval extension fails each tool call alike.
      if (e.reason !== "unexpected" || progress.told) break;
      keep({ ...progress, told: true });
      notify(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${slotView(state, slot).ref} 的 agent 出错了。\n原因：${clip(e.detail, 500)}`);
      break;
    case "approval_failed":
      // The process keeps its old mode: it goes once idle, as a pi's does (turn_end), and the next
      // one starts in the mode set. One gone already took its mode with it.
      if (slot.state === "off" || slot.state === "crashed") break;
      inform(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${slotView(state, slot).ref} 没能在运行中切换审批模式，空闲后会重启，按新设置运行。\n原因：${e.error}`);
      if (slot.state === "idle") stop(slot, d, "agent");
      else set({ approvalStale: 1 });
      break;
    case "model_gone": {
      // The agent runs on its own default now, and the next process starts with it too.
      if (slot.model !== e.model) break; // /model set another meanwhile
      set({ model: null });
      const agent = AGENTS[state.conversations.find((c) => c.id === e.conv)!.agent].name;
      const why = e.error ? `\n原因：${clip(e.error, 200)}` : "";
      inform(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), `${slotView(state, slot).ref} 记着的模型 ${e.model} 在这一版 ${agent} 里没有了，改用了默认模型。${why}`);
      break;
    }
    case "command_result": {
      let r = e.result;
      if (!("error" in r) && r.command === "resume" && r.session && !r.choices) {
        // The runner found that session. The slot goes back to it: to its row on the timeline, or a
        // new row for one this slot has not had; the next message opens it, with its agent (product §4.7).
        const session = r.session;
        const agent = r.agent ?? state.conversations.find((c) => c.id === e.conv)!.agent;
        const had = state.conversations.find((c) => c.slot === slot.id && c.agent === agent && c.sessionId === session);
        const other = slotOn(state, slot, agent, session);
        if (had?.id !== slot.conversation) {
          if (other) r = { error: `${slotView(state, other).ref} 正在用这段对话` };
          else if (slot.mode === "tui") r = { error: `${slotView(state, slot).ref} 在 TUI 里` };
          // Only between turns: one may have started while the driver looked, and moving would kill it.
          else if (slot.state === "starting" || slot.state === "running" || slot.state === "waiting") r = { error: "回合还在进行，先 /stop 再 /resume" };
          else {
            const id = had?.id ?? ctx.newId();
            if (!had) d.writes.push({ op: "insert", table: "conversation", row: { id, slot: slot.id, agent, sessionId: session, startedAt: ctx.now } });
            set(moveTo(state, ctx, d, slot, id, agent));
          }
        }
      }
      // What /model, /effort and /ultracode set stays with the slot, for each process it starts (product §5.6).
      if (!("error" in r)) {
        if (r.command === "model" && !r.choices) set({ model: r.model, ...(r.was !== undefined && { effort: r.level }) });
        if (r.command === "effort" && !r.choices) set({ effort: r.level });
        if (r.command === "ultracode" && !r.choices && !r.unavailable) set({ ultracode: r.on ? 1 : 0 });
        if (r.command === "status") r = remembered(state, r, slot);
      }
      const at = { chat: e.chat, inbound: e.inbound, ui: e.panel };
      const failed = "error" in r && `/${e.command} 没做成。\n原因：${r.error}`;
      if (failed && e.chat === BOARD) d.effects.push({ kind: "rh_reply", id: e.inbound, reply: { ok: false, error: failed } });
      else if (failed) answer(d, ctx, at, failed);
      else commandReply(state, ctx, d, at, r as CommandResult, slot);
      break;
    }
  }
  // The turn rh agent waited for is over, or its process is gone (rh stop's exit, a crash): the slot
  // moves to a new conversation of that agent. Your messages the old agent never got, say those held
  // for an interrupt, go to it, and start it, the turn's chat kept for the reply. The confirm requests
  // that waited for the turn go out as the slot moves (moveTo); with no move, they go out here.
  if (swap && (e.type === "exit" || (e.type === "turn_end" && !stopping(state, e.conv)))) {
    // The board's queue goes paused, as the slot moves (moveTo).
    const held = state.queued.filter((i) => i.conversation === e.conv && i.source === "human" && i.queueReason !== WEB_QUEUE && i.queueReason !== WEB_PAUSED);
    const patch = newConversation(state, d, ctx, e.type === "exit" ? { ...slot, state: "off" } : slot, swap);
    for (const i of held) d.writes.push({ op: "update", table: "agentInput", where: { id: i.id }, patch: { conversation: patch.conversation!, queueReason: null } });
    set({ ...patch, ...(held.length > 0 && { state: "starting" as const, turnChat: slot.turnChat, turnInbound: slot.turnInbound }) });
    if (held.length) d.effects.push({ kind: "start", slot: slot.id });
    d.events.push({ source: "agent", type: "slot_agent", slot: slot.id, data: { agent: swap } });
  } else if (e.type === "turn_end" || e.type === "exit") pushDeferred(state, ctx, d, slot);
  return d;
}

/** The slot's turn is over, so its idle reap clock starts (product §4.4), and a one-off slot's archive
 *  clock (product §6.1). A new turn ending sets them again; each clock checks the slot is still idle (clock). */
function turnOver(d: Decision, ctx: Ctx, slot: Slot): void {
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { turnEndedAt: ctx.now, activeAt: ctx.now } });
  if (slot.lifetime === "oneoff") d.effects.push({ kind: "timer", timer: "oneoff_archive", key: slot.id, at: ctx.now + ctx.config.durations.oneoffArchive });
  reapAt(d, ctx, slot, ctx.now, true);
}

/** The slot's reap time: its own, else the config's; 0 never reaps. */
const reapAfter = (slot: Slot, ctx: Ctx) => slot.reapAfter ?? ctx.config.durations.idleReap;

/** Sets the slot's idle reap clock to go off reap time after `from`. soon: the agent may have written
 *  more, so the clock looks at once, that output on record by then, whether it is past limits.outRestartMB. */
function reapAt(d: Decision, ctx: Ctx, slot: Slot, from: number, soon = false): void {
  const reap = reapAfter(slot, ctx);
  const at = soon && ctx.config.limits.outRestartMB ? ctx.now : reap ? from + reap : null;
  d.effects.push({ kind: "timer", timer: "idle_reap", key: slot.id, at });
}

/** Whether the conversation's agent process has written more than limits.outRestartMB since it started (product §4.4).
 *  An exited one's row, till the next launch replaces it, says nothing of the agent starting now. */
function outgrown(state: State, ctx: Ctx, conversation: string): boolean {
  const h = state.holders.find((h) => h.conversation === conversation);
  const max = ctx.config.limits.outRestartMB * 2 ** 20;
  return Boolean(max && h && !h.exited && h.outOffset - h.outStart > max);
}

/** The slots waiting for the agent's quota. */
const waitingFor = (state: State, agent: AgentKind): Slot[] => state.slots.filter((s) => s.state === "rate_limited" && agentOf(state, s) === agent);

/** Sets when each slot waiting for the quota of the slot's agent, the slot too, carries on: the reset
 *  the latest refusal names, as they share one account, spread over quotaStagger in slot order so they
 *  do not all hit the limit again at once (architecture §7.6). */
function stagger(state: State, ctx: Ctx, d: Decision, slot: Slot, resetsAt: number): void {
  const agent = agentOf(state, slot);
  const waiting = state.slots.filter((s) => (s.state === "rate_limited" && agentOf(state, s) === agent) || s.id === slot.id);
  const gap = waiting.length > 1 ? ctx.config.durations.quotaStagger / (waiting.length - 1) : 0;
  waiting.forEach((s, i) => {
    const at = resetsAt + Math.round(i * gap);
    d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { resumeAt: at } });
    d.effects.push({ kind: "timer", timer: "quota_reset", key: s.id, at });
  });
}

/** Tells you of the slots waiting for the agent's quota you have not heard of (product §4.6): one
 *  notice in each of their contact chats, naming all of them there. */
function quotaNotice(state: State, ctx: Ctx, d: Decision, agent: AgentKind): void {
  const chats = new Map<string | undefined, Slot[]>();
  const quota = `${AGENTS[agent].name} 额度`;
  for (const s of waitingFor(state, agent).filter((s) => s.quotaUntold)) {
    d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { quotaUntold: null } });
    const chat = contactChat(state, ctx, d, s)?.id;
    chats.set(chat, [...(chats.get(chat) ?? []), s]);
  }
  const refs = (slots: Slot[]) => slots.map((s) => slotView(state, s).ref).join("、");
  for (const [chat, slots] of chats) {
    const at = Math.min(...slots.map((s) => s.resumeAt ?? ctx.now));
    const when = `${moment(at, ctx.now)} 恢复${left(at, ctx.now)}`;
    const manual = slots.filter((s) => !(s.autoContinue ?? ctx.config.defaults.autoContinue));
    const it = slots.length > 1 ? "它们" : "它";
    // Some of them carry on by themselves and some not: a last line names those that do not (docs/im-style.md §6.2).
    const then =
      manual.length === slots.length
        ? "到时不会自己接着做，要你发一条消息。"
        : `到时${it}自己接着做。这之间发给${it}的消息先存着，到时一起交给${it}。${manual.length ? `\n${refs(manual)} 到时不会自己接着做，要你发一条消息。` : ""}`;
    const text = slots.length > 1 ? `${quota}用完了，${when}。\n在等的：${refs(slots)}。\n${then}` : `${refs(slots)} 用完了 ${quota}，${when}。\n${then}`;
    // A turn you began there makes it a reply to your message.
    const slot = slots.find((s) => s.turnChat === chat) ?? slots[0]!;
    notify(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), text);
  }
}

// ---- The clock: timers that came due. ----

function clock(state: State, input: Extract<Input, { kind: "clock" }>, ctx: Ctx): Decision {
  const d = nothing();
  if (input.timer === "quota_notice") {
    // Also sent at startup, should a slot waiting for quota be untold still. Keyed by the agent.
    if (Object.hasOwn(AGENTS, input.key)) quotaNotice(state, ctx, d, input.key as AgentKind);
    return d;
  }
  if (input.timer === "ask_timeout") {
    // Also sent for each open ask at startup: it arms the clock again.
    const a = state.asks.find((a) => a.id === input.key && a.status === "open");
    const s = a && state.slots.find((s) => s.id === a.slot);
    if (!a || !s || a.deadline === null) return d;
    if (ctx.now < a.deadline) {
      d.effects.push({ kind: "timer", timer: "ask_timeout", key: a.id, at: a.deadline });
      return d;
    }
    answerAsk(state, ctx, d, s, a, timeoutAnswer(a.kind, prompt(a)), "timeout");
    // Unapproved, the plan's agent stops to wait for you: a child's turn's end reports it stuck again
    // (architecture §9.2).
    if (a.kind === "plan" && s.parent !== null) d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { turnPlanTimedOut: 1 } });
    return d;
  }
  if (input.timer === "idle_reap") {
    // Also sent for each idle slot at startup, and on rh set: it arms the clock again.
    const s = state.slots.find((s) => s.id === input.key);
    // Idle since its turn ended, or since it started for a command, with no turn (common()).
    const from = s && Math.max(s.turnEndedAt ?? 0, s.startedIdleAt ?? 0);
    if (!s?.conversation || s.mode !== "headless" || s.state !== "idle" || !from || stopping(state, s.conversation)) return d;
    // A background task keeps the agent (product §4.4); the clock starts again once it is done (agent()).
    if (state.conversations.find((c) => c.id === s.conversation)?.background) return d;
    // So much output, the process goes now, whatever the reap time: the next one's out.log starts afresh (architecture §4.5).
    const [reap, big] = [reapAfter(s, ctx), outgrown(state, ctx, s.conversation)];
    if (!big && !reap) return d;
    if (!big && ctx.now < from + reap) reapAt(d, ctx, s, from);
    else stop(s, d, "clock"); // recorded first, so its exit is no crash; the next message resumes the conversation
    return d;
  }
  if (input.timer === "tool_running") {
    // A minute more of the step the turn's message shows running: its line says so (im-style §3.1).
    const p = progressOf(state.conversations.find((c) => c.id === input.key)?.progress);
    const s = state.slots.find((s) => s.conversation === input.key);
    const to = s && shown(state, ctx, s);
    if (!p?.running || !s || to?.caps.progress !== "edit") return d;
    const next = showEdit(d, ctx, to, s, p, edit(p, null, viewOf(to, s, ctx)));
    d.writes.push({ op: "update", table: "conversation", where: { id: input.key }, patch: { progress: JSON.stringify(next) } });
    const minutes = Math.floor((ctx.now - p.running.since) / MINUTE) + 1;
    d.effects.push({ kind: "timer", timer: "tool_running", key: input.key, at: p.running.since + minutes * MINUTE });
    return d;
  }
  if (input.timer === "herdr_wait") {
    // Herdr has not come back in time (architecture §10.2): the Herdr bridge makes sure the agent is gone,
    // and switches the slot back; its tab is closed once Herdr is back.
    const s = state.slots.find((s) => s.id === input.key);
    if (!s || s.mode !== "tui" || s.herdrLostAt === null || s.tuiPid === null) return d;
    const due = s.herdrLostAt + ctx.config.durations.herdrRestartWait;
    d.effects.push(ctx.now < due ? { kind: "timer", timer: "herdr_wait", key: s.id, at: due } : { kind: "tui_back", slot: s.id, force: false });
    return d;
  }
  if (input.timer === "quota_reset") {
    // Also sent for each slot waiting for quota at startup: it arms the clock again.
    const s = state.slots.find((s) => s.id === input.key);
    if (!s?.conversation || s.state !== "rate_limited" || s.resumeAt === null) return d;
    if (ctx.now < s.resumeAt) {
      d.effects.push({ kind: "timer", timer: "quota_reset", key: s.id, at: s.resumeAt });
      return d;
    }
    // The reset (product §4.6): what was sent meanwhile goes in; with nothing, 继续, unless the slot
    // has auto-continue off or you stopped the turn (/stop). Its agent never stopped, so it takes no
    // new place under the running limit.
    const set = (patch: Patch<Slot>) => d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch });
    const queued = state.queued.some((i) => i.conversation === s.conversation && i.queueReason === AFTER_QUOTA);
    set({ resumeAt: null, interruptedAt: null });
    d.events.push({ source: "clock", type: "quota_reset", slot: s.id });
    releaseQueued(d, s.conversation, AFTER_QUOTA);
    if (queued) {
      set({ state: "running" });
      d.effects.push({ kind: "deliver", conversation: s.conversation });
    } else if (s.interruptedAt === null && (s.autoContinue ?? ctx.config.defaults.autoContinue)) {
      wake(state, ctx, d, { ...s, state: "idle" }, { source: "auto_continue", body: "继续" });
    } else {
      set({ state: "idle", turnChat: null, turnInbound: null, turnSentMe: null });
      reapAt(d, ctx, s, s.turnEndedAt ?? ctx.now, true);
    }
    return d;
  }
  if (input.timer !== "oneoff_archive") return d;
  // Also sent for each one-off slot at startup, as timers live only in memory: it arms the clock again.
  const s = state.slots.find((s) => s.id === input.key);
  if (!s || s.lifetime !== "oneoff" || s.archivedAt !== null || s.turnEndedAt === null) return d;
  // In a turn, stuck after a crash, or in the terminal: the next turn's end sets the clock again. A
  // reaped slot is idle all the same.
  if ((s.state !== "idle" && s.state !== "off") || s.mode === "tui") return d;
  // An input waits for it, say a wake waiting for room: the turn it brings sets the clock again.
  if (state.queued.some((i) => i.conversation === s.conversation)) return d;
  const due = s.turnEndedAt + ctx.config.durations.oneoffArchive;
  if (ctx.now < due) {
    d.effects.push({ kind: "timer", timer: "oneoff_archive", key: s.id, at: due });
    return d;
  }
  // A bot's default target is never archived (rh archive); its next turn's end, or a restart, sets the clock again.
  if (defaultOf(state, ctx, s)) return d;
  stop(s, d, "clock");
  unbind(state, ctx, d, s);
  d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { archivedAt: ctx.now } });
  d.events.push({ source: "clock", type: "slot_archived", slot: s.id });
  return d;
}

/** A slot being archived, or deleted (gone): each chat pointing at it goes back to its bot's default
 *  target, and says so there (product §5.2). The chat the archive command came from, here, is not told:
 *  what it would be told is returned, for the command's reply (docs/im-style.md §6.4). */
function unbind(state: State, ctx: Ctx, d: Decision, s: Slot, here?: Chat, gone = "归档了"): string {
  const ref = slotView(state, s).ref;
  let reply = "";
  for (const chat of state.chats.filter((c) => c.target === s.id)) {
    d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { target: null } });
    const bot = state.bots.find((b) => b.id === chat.bot)!;
    const now = target(state, bot, undefined, ctx);
    const where = now ? `这里的消息改交给 ${slotView(state, now).ref}。` : "这里改回默认，可这个 Bot 还没有默认槽位，发 /rh_use 选一个。";
    if (chat.id === here?.id) {
      reply = where;
      continue;
    }
    const status = place(quotas(state, ctx, d), { chat, bot, caps: ctx.capabilities(bot.id) }, null).status;
    outbound(d, ctx, { chat: chat.id, replyTo: null, trace: null, status, text: `${ref} ${gone}${now ? "，" : "。"}${where}` });
  }
  return reply;
}

/** Points each chat at its slot (null: its bot's default) and each bot's default at its slot, as rh
 *  use and rh bind do, adding a chat not on record. Each chat whose messages now go elsewhere hears so,
 *  once, where they go now (product §7, story 260); one that follows its bot's default hears of the
 *  default moving only in your private chat with the bot, not a stranger's (product §8). here: the chat
 *  the command came from, whose reply says so already. */
function rebind(state: State, ctx: Ctx, d: Decision, chats: [Chat, Slot | null][], bots: [Bot, Slot][], here?: Chat): void {
  for (const [chat, s] of chats) {
    if (state.chats.some((c) => c.id === chat.id)) d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { target: s?.id ?? null } });
    else d.writes.push({ op: "insert", table: "chat", row: { id: chat.id, bot: chat.bot, platformChatId: chat.platformChatId, target: s?.id ?? null } });
    // By the chat's row, not its platform id, which the board must not show (architecture §11).
    d.events.push({ source: "rh", type: "chat_target", ...(s && { slot: s.id }), data: { chat: chat.id } });
  }
  for (const [bot, s] of bots) {
    d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { defaultTarget: s.id } });
    // No bot's default target is archived (rh archive): it comes back, as a message to it would bring it.
    if (s.archivedAt !== null) {
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { archivedAt: null, activeAt: ctx.now } });
      d.events.push({ source: "rh", type: "slot_unarchived", slot: s.id });
    }
    d.events.push({ source: "rh", type: "bot_target", slot: s.id, data: { bot: bot.name } });
  }
  const moved = new Map(chats.map(([c, s]) => [c.id, { ...c, target: s?.id ?? null }]));
  const after: Bindings = {
    ...state,
    chats: [...state.chats.filter((c) => !moved.has(c.id)), ...moved.values()],
    bots: state.bots.map((b) => ({ ...b, defaultTarget: bots.find(([x]) => x.id === b.id)?.[1].id ?? b.defaultTarget })),
  };
  for (const chat of after.chats) {
    const bot = after.bots.find((b) => b.id === chat.bot)!;
    const now = target(after, bot, chat, ctx);
    const was = target(state, state.bots.find((b) => b.id === bot.id)!, state.chats.find((c) => c.id === chat.id), ctx);
    if (chat.id === here?.id || now?.id === was?.id || (!moved.has(chat.id) && !ownerChat(bot, chat, ctx))) continue;
    const back = moved.has(chat.id) && chat.target === null;
    const text = !now ? "这里改回默认，可这个 Bot 还没有默认槽位，发 /rh_use 选一个。" : back ? `这里改回默认，消息交给 ${slotView(state, now).ref}。` : `这里的消息改交给 ${slotView(state, now).ref}。`;
    const status = place(quotas(state, ctx, d), { chat, bot, caps: ctx.capabilities(bot.id) }, null).status;
    outbound(d, ctx, { chat: chat.id, replyTo: null, trace: null, status, text });
  }
}

/** A bot as you call it: its platform, and its name where the platform has more than one (chatName). */
function botName(ctx: Pick<Ctx, "config">, b: Bot): string {
  const name = nameAmong(ctx.config, b);
  return `${PLATFORMS[b.platform].label} Bot${name !== null ? ` ${name}` : ""}`;
}

/** The bots the slot is the default target of, as you call them (botName); "" for none. */
function defaultOf(state: State, ctx: Ctx, s: Slot): string {
  return state.bots
    .filter((b) => target(state, b, undefined, ctx)?.id === s.id)
    .map((b) => botName(ctx, b))
    .join("、");
}

/** Refuses to archive or delete a bot's default target: the bot's messages would go to a slot out of sight (product §5.2). */
function notDefault(state: State, ctx: Ctx, who: Caller, s: Slot, act: "归档" | "删除"): void {
  const bots = defaultOf(state, ctx, s);
  if (!bots) return;
  const ref = slotView(state, s).ref;
  if (who.kind === "you" && who.board) refuse(`${ref} 是 ${bots} 的默认目标，先在拓扑图上给 ${bots} 换一个默认目标，再${act}。`);
  refuse(`${ref} 是 ${bots} 的默认目标，先用 ${who.kind === "you" && who.im ? "/rh_bind" : "rh bind"} 换一个再${act}。`);
}

/** A command the caller got wrong; its message goes back to them. With a notice, an agent hit a
 *  limit, and you are told too (product §6.1). */
class Refusal extends Error {
  constructor(
    message: string,
    readonly notice?: string,
  ) {
    super(message);
  }
}
function refuse(message: string, notice?: string): never {
  throw new Refusal(message, notice);
}
/** A call with arguments its command does not take: rh's usage at a terminal, an example in chat (rhCommand). */
class Usage extends Refusal {}

/** Another slot whose conversation is the agent's session: one agent process per session file (product §4.2). */
const slotOn = (state: State, slot: Slot, agent: string, session: string) =>
  state.slots.find((s) => s.id !== slot.id && state.conversations.some((c) => c.id === s.conversation && c.agent === agent && c.sessionId === session));

/** Headless slots with an agent process, but the one excepted: what the running limit counts (product §6.1). */
const running = (state: State, except?: string) =>
  state.slots.filter((s) => s.id !== except && s.mode === "headless" && s.state !== "off" && s.state !== "crashed").length;

/** Lets the conversation's inputs queued for this reason (null: none) go to the agent, or wait for another (to). */
function releaseQueued(d: Decision, conversation: string, reason: string | null, to: string | null = null): void {
  d.writes.push({ op: "update", table: "agentInput", where: { conversation, status: "queued", queueReason: reason }, patch: { queueReason: to } });
}

/**
 * Writes an internal message to the slot's agent, waking the slot for it (architecture §9.3): a
 * report, rh send, a resume, your decision on a confirm request. It never answers an ask: with asks
 * open it waits until they are answered. While rh stop stops the slot, it waits for the exit, which
 * starts the agent again for it (agent); out of Claude's quota, for the reset (clock). At the
 * running limit it waits for room, till a slot stops, unless it is yours (always): yours always
 * wakes a slot, and an agent's rh send is refused there before it comes this far (product §6.1). In
 * TUI mode, or on the way there, it waits for the switch back (architecture §10.1). A report, rh send
 * or decision to a slot in a turn with a turn chat, one your message began or joined, waits for that turn to end, and runs as one of its
 * own (architecture §9.3). stopped: a slot whose agent just exited, which no longer counts. Returns
 * what it waits for, if anything.
 */
function wake(state: State, ctx: Ctx, d: Decision, slot: Slot, input: { source: AgentInput["source"]; body: string; trace?: string }, o: { stopped?: string; always?: boolean } = {}): string | null {
  const off = slot.state === "off" || slot.state === "crashed";
  const tui = slot.mode === "tui";
  // Short of free disk it waits as for room (architecture §7.8), and you are told. In TUI mode it waits for the switch back anyway.
  const low = !tui && off && lowDisk(ctx);
  if (low) notify(state, ctx, d, slot, input.trace ?? ctx.newId(), `${low}：没有唤醒 ${slotView(state, slot).ref}，给它的消息先排队。有了空间，等有槽位停下或 Rhodium 重启时再投给它。`);
  const reason = tui
    ? IN_TUI
    : off
      ? !low && (o.always || running(state, o.stopped) < ctx.config.limits.maxRunning)
        ? null
        : MAX_RUNNING
      : stopping(state, slot.conversation!)
        ? AFTER_STOP
        : slot.state === "rate_limited"
          ? AFTER_QUOTA
        : blocking(state, slot).length
          ? AFTER_ASKS
          : slot.interruptedAt !== null
            ? AFTER_INTERRUPT
            : slot.turnChat !== null && (input.source === "report" || input.source === "rh" || input.source === "confirm")
              ? AFTER_TURN
              : null;
  d.writes.push({
    op: "insert",
    table: "agentInput",
    row: { id: ctx.newId(), conversation: slot.conversation!, status: "queued", ...input, ...(reason && { queueReason: reason }) },
  });
  if (reason) return reason;
  const set = (patch: Patch<Slot>) => d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
  if (off) {
    set({ state: "starting" });
    d.effects.push({ kind: "start", slot: slot.id });
    releaseQueued(d, slot.conversation!, MAX_RUNNING); // wakes that waited for it would hold this one back
  } else {
    if (slot.state === "idle") set({ state: "running" });
    d.effects.push({ kind: "deliver", conversation: slot.conversation! }); // mid-turn, it joins the turn
  }
  return null;
}

/** Whether you talk to the slot directly (product §6.1): a chat of yours bound to it (/rh_use), or
 *  this turn one you began or joined, from IM or the board (turnChat). Its reply reached you then. */
const direct = (state: State, s: Slot) => s.turnChat !== null || state.chats.some((c) => c.target === s.id);

/** Whether the child's result reaches you by its report alone (architecture §9.2): its parent is still
 *  there, and you are not talking to the child directly. Its rh send me is refused then. */
function reportsUp(state: State, child: Slot): boolean {
  const parent = parentOf(state, child);
  return !!parent && parent.archivedAt === null && !direct(state, child);
}

/**
 * Tells the child's parent that it is done or stuck (architecture §9.2-9.4), each once a turn: an
 * internal message that wakes the parent, or, once the parent is archived or deleted, a notice for
 * you to decide. A parent merely reaped is woken as ever. None while you talk to the child directly
 * (direct()). stopped: as for wake(); relay: why the parent need not pass a stuck one on to you.
 */
function report(state: State, ctx: Ctx, d: Decision, child: Slot, what: "done" | "stuck", detail: string, o: { stopped?: string; relay?: string } = {}): void {
  if (child.parent === null || child.reported === what || direct(state, child)) return;
  d.writes.push({ op: "update", table: "slot", where: { id: child.id }, patch: { reported: what } });
  const parent = parentOf(state, child);
  d.events.push({ source: "agent", type: "child_report", slot: child.id, data: { what, parent: parent?.id ?? null } });
  const ref = slotView(state, child).ref;
  const text = `子槽位 ${ref} ${what === "done" ? "完成了" : "卡住了"}。${detail}`;
  if (!reportsUp(state, child)) return notify(state, ctx, d, child, ctx.newId(), `${text}\n它的父槽位已经不在，需要你拿主意。`);
  // Its rh send me was refused, so what you hear of it is the parent's to say (product §6.1), unless it
  // sent to you this turn to a destination named.
  const told = `${child.turnToldYou ? "" : "它没有直接告诉用户。"}${o.relay ?? ""}`;
  const body = [REPORT_LINE, text, told, `看它的状态和最近的对话：rh read ${ref}`].filter(Boolean).join("\n");
  wake(state, ctx, d, parent!, { source: "report", body }, { stopped: o.stopped });
}

/** What a done report says of the child's last reply: its start; the parent reads the rest with rh read. */
function replyStart(reply: string | undefined): string {
  const text = reply?.trim();
  if (!text) return "它最后没有回复文字。";
  return `最后一条回复的开头：${clip(text, 200, "…")}`;
}

/** A slot stopped, or rhodium started: wakes waiting for room start their slots, oldest first, while there is room. */
function makeRoom(state: State, ctx: Ctx, d: Decision, stopped?: string): void {
  if (lowDisk(ctx)) return; // they wait on (architecture §7.8)
  let room = ctx.config.limits.maxRunning - running(state, stopped);
  for (const conversation of new Set(state.queued.filter((i) => i.queueReason === MAX_RUNNING).map((i) => i.conversation))) {
    if (room <= 0) return;
    const s = state.slots.find((s) => s.conversation === conversation && s.id !== stopped && s.mode === "headless" && (s.state === "off" || s.state === "crashed"));
    // Its slot has moved on to a new conversation, or is archived: your message brings that back.
    if (!s || s.archivedAt !== null) continue;
    releaseQueued(d, conversation, MAX_RUNNING);
    d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { state: "starting" } });
    d.effects.push({ kind: "start", slot: s.id });
    room--;
  }
}

/** Short of limits.minFreeMB of free disk, no slot is made or started (architecture §7.8): why, or null. */
function lowDisk(ctx: Ctx): string | null {
  const free = ctx.diskFree();
  const min = ctx.config.limits.minFreeMB * 2 ** 20;
  return free < min ? `磁盘剩余 ${formatGB(free)}，不到 ${formatGB(min)}，Rhodium 暂停新开和恢复槽位` : null;
}

/** Refuses an rh call that would make or start a slot short of free disk; an agent's, you hear of too. */
function diskRoom(state: State, ctx: Ctx, who: Caller, what: string): void {
  const low = lowDisk(ctx);
  if (!low) return;
  if (who.kind !== "slot") refuse(`${what} 被拒绝：${low}。`);
  refuse(`${what} 被拒绝：${low}。已通知用户。`, `${slotView(state, who.slot).ref} ${what} 被拒绝：${low}。`);
}

/** The slot's parent, if it is still a row. */
const parentOf = (state: Pick<State, "slots">, s: Slot) => (s.parent === null ? undefined : state.slots.find((p) => p.id === s.parent));

/** Refuses an agent's spawn past a limit of product §6.1, and tells you. You are never limited. */
function spawnLimits(state: State, ctx: Ctx, parent: Slot): void {
  const { maxRunning, maxChildren, maxDepth } = ctx.config.limits;
  const over = (what: string) => refuse(`派生被拒绝：${what}。已通知用户。`, `${slotView(state, parent).ref} 派生子槽位被拒绝：${what}。`);
  if (running(state) >= maxRunning) over(`同时运行的无头槽位已到上限 ${maxRunning} 个`);
  const children = state.slots.filter((s) => s.parent === parent.id && s.archivedAt === null).length;
  if (children >= maxChildren) over(`它没归档的子槽位已到上限 ${maxChildren} 个`);
  let depth = 1; // the child's: a slot you made has depth 0
  for (let s = parentOf(state, parent); s; s = parentOf(state, s)) depth++;
  if (depth > maxDepth) over(`派生深度已到上限 ${maxDepth} 层`);
}

/** The chat wrote to the slot (product §5.9): the latest to write of the chats going to the slot. */
function contacted(d: Decision, ctx: Ctx, chat: string): void {
  d.writes.push({ op: "update", table: "chat", where: { id: chat }, patch: { contactedAt: ctx.now } });
}

/** Of the chats, the one that wrote to a slot last (product §5.9). */
const latest = (chats: Chat[]): Chat | undefined => (chats.length ? chats.reduce((a, b) => ((b.contactedAt ?? 0) > (a.contactedAt ?? 0) ? b : a)) : undefined);

/** Your private chats, each owner's with each bot, or with the bots on picks. */
const privateChats = (state: Bindings, ctx: Pick<Ctx, "config">, on: (b: Bot) => boolean = () => true) =>
  state.chats.filter((c) => {
    const bot = state.bots.find((b) => b.id === c.bot);
    return bot && on(bot) && ownerChat(bot, c, ctx);
  });

/** Of your chats going to the slot now, else to its root slot, the one that wrote to a slot last
 *  (product §5.9): each owner's private chat with each bot, or with the bots on picks. */
function pointing(state: Bindings, ctx: Pick<Ctx, "config">, slot: Slot, on?: (b: Bot) => boolean): Chat | undefined {
  const mine = privateChats(state, ctx, on);
  const going = (s: Slot) => mine.filter((c) => target(state, state.bots.find((b) => b.id === c.bot)!, c, ctx)?.id === s.id);
  let root = slot;
  for (let p = parentOf(state, root); p; p = parentOf(state, p)) root = p;
  return latest(going(slot).length ? going(slot) : going(root));
}

/** Of your private chats with the bots on picks, the one pointing() finds for the slot, else the one you
 *  wrote in last (product §5.9): for another bot to send by (elsewhere()), or for rh send to one. */
const yours = (state: Bindings, ctx: Pick<Ctx, "config">, on: (b: Bot) => boolean, slot: Slot | undefined): Chat | undefined =>
  (slot && pointing(state, ctx, slot, on)) || latest(privateChats(state, ctx, on));

/** The slot's contact chat (product §5.9): the chat pointing at it or its root, else the main chat. */
function contactChat(state: Bindings, ctx: Pick<Ctx, "config" | "newId">, d: Decision, slot: Slot | undefined): Chat | undefined {
  return (slot && pointing(state, ctx, slot)) || mainChat(state, ctx, d);
}

/** The slot's contact chat, for the board: null when it is the main chat, not on record yet. */
export const contactOf = (state: Bindings, config: Config, slot: Slot): string | null => contactChat(state, { config, newId: () => "" }, nothing(), slot)?.id || null;

/**
 * Where something that comes to you by itself goes (product §5.10): at, if given; else about a slot,
 * its contact chat; about none, the main chat. A faulted bot, or a QQ bot with neither quota left, has another bot's chat
 * with you take it, its text led by a line saying so; with none to, a QQ one waits for your next
 * message (product §5.5, architecture §8.7). say gives the messages for the chat to, as the
 * platform of caps takes them, after lead; on QQ they go from its bot only if all of them can
 * without waiting, so they keep their order. Returns the chat they went to, and whether any wait for
 * your reply there (held); undefined: nowhere to go, so the event is all there is, or, strict, at
 * can't send them now, so nothing went.
 */
function tell(state: State, ctx: Ctx, d: Decision, slot: Slot | undefined, trace: string, say: (caps: Capabilities | undefined, lead: string, to: To) => Payload[], at?: Chat, strict?: true): { chat: string; held: boolean } | undefined {
  const chat = at ?? contactChat(state, ctx, d, slot);
  if (!chat) return undefined;
  const home: To = { chat, bot: state.bots.find((b) => b.id === chat.bot)!, caps: ctx.capabilities(chat.bot) };
  // In a turn you began there, a passive reply to your message spares an active one.
  const inbound = slot?.turnChat === chat.id ? slot.turnInbound : null;
  const q = quotas(state, ctx, d);
  let messages = say(home.caps, "", home);
  // What QQ sends now (place()): passive replies but the one kept for the hint, then active messages.
  const room = Math.max(0, (inbound ? q.passive(inbound) : 0) - 1) + q.active(home.bot.id);
  const qq = home.caps?.sendLimit.kind === "qq_quota";
  const cannot = home.bot.connState === "faulted" || (qq && room < messages.length);
  if (cannot && strict) return undefined;
  const other = cannot && elsewhere(state, ctx, d, q, home.bot, slot);
  const to = other || home;
  if (other) messages = say(other.caps, `${chatName(state, ctx, home.chat)}那边发不出去，改发在这里。\n\n`, other);
  let hintedBy: string | undefined;
  let held = false;
  for (const p of messages) {
    const placed = place(q, to, other ? null : inbound);
    if (placed.hint) hintedBy = hint(d, ctx, to.chat.id, inbound!, trace);
    held ||= placed.status === "held";
    outbound(d, ctx, { chat: to.chat.id, replyTo: placed.replyTo, trace, status: placed.status, ...(placed.status === "held" && { hintedBy }), ...p });
  }
  return { chat: to.chat.id, held };
}

/** Tells you something that needs your say or went wrong (product §5.10), the way tell() finds, cut up by the platform's limit. */
function notify(state: State, ctx: Ctx, d: Decision, slot: Slot | undefined, trace: string, text: string, buttons?: Button[], at?: Chat): void {
  tell(state, ctx, d, slot, trace, (caps, lead) => {
    const texts = chunkText(lead + text, caps?.maxTextLength ?? Infinity);
    const fit = fitting(caps, buttons);
    return texts.map((text, i) => ({ text, ...(i === texts.length - 1 && fit && { buttons: fit }) }));
  }, at);
}

/** Tells you something the board shows already (product §5.10): in the chat pointing at the slot or
 *  its root, or at; with neither, on the board alone. */
function inform(state: State, ctx: Ctx, d: Decision, slot: Slot, trace: string, text: string, buttons?: Button[], at?: Chat): void {
  const to = at ?? pointing(state, ctx, slot);
  if (to) notify(state, ctx, d, slot, trace, text, buttons, to);
}

/** Your chat with another bot that can send now, for when one bot can't: not faulted, paired, and on
 *  QQ with an active message left. One on another platform first (product §5.5), then the main chat's
 *  bot, with its main chat. Of another bot's owners, the private chat going to the slot or its root, if
 *  any, else the one you wrote in last (yours()). */
function elsewhere(state: State, ctx: Ctx, d: Decision, q: Quotas, not: Bot, slot: Slot | undefined): To | undefined {
  const main = ctx.config.mainChat;
  const ready = (b: Bot) => {
    const caps = ctx.capabilities(b.id);
    return b.id !== not.id && b.connState !== "faulted" && owners(b, ctx.config).length > 0 && caps && (caps.sendLimit.kind !== "qq_quota" || q.active(b.id) > 0);
  };
  const rank = (b: Bot) => 2 * Number(b.platform !== not.platform) + Number(b.name === main?.bot);
  const bot = state.bots.filter(ready).sort((a, b) => rank(b) - rank(a))[0];
  if (!bot) return undefined;
  const there = yours(state, ctx, (b) => b.id === bot.id, slot);
  // A private chat's id is your user id under the bot (docs/spec/v1.md "配置").
  const id = bot.name === main?.bot ? main.chat : (there?.platformChatId ?? owners(bot, ctx.config)[0]!);
  return { chat: chatRow(state, ctx, d, bot, id), bot, caps: ctx.capabilities(bot.id) };
}

/** A bot failed to reach its platform over and over, or got through again after that (architecture
 *  §8.6). Each is told to you once, through another bot. */
function connection(state: State, input: Extract<Input, { kind: "connection" }>, ctx: Ctx): Decision {
  const d = nothing();
  const bot = state.bots.find((b) => b.id === input.bot);
  const conn = input.up ? "online" : "faulted";
  if (!bot || bot.connState === conn) return d;
  d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { connState: conn } });
  if (input.up && bot.connState !== "faulted") return d;
  d.events.push(input.up ? { source: "connection", type: "bot_online", data: { bot: bot.name } } : { source: "connection", type: "bot_faulted", data: { bot: bot.name, error: input.error } });
  const q = quotas(state, ctx, d);
  const to = elsewhere(state, ctx, d, q, bot, undefined);
  const name = `${PLATFORMS[bot.platform].label} Bot ${bot.name}`;
  const text = input.up
    ? `${name} 已恢复，又连上平台了。`
    : `${name} 连不上平台，已经连续失败 ${ctx.config.limits.botFailures} 次。它会一直自动重连，连上之前这个 Bot 的消息收不到也发不出。${input.error ? `\n原因：${input.error}` : ""}`;
  // Rhodium's own words: plain text, not the agent's Markdown (send()).
  if (to) outbound(d, ctx, { chat: to.chat.id, replyTo: null, trace: null, status: place(q, to, null).status, text });
  return d;
}

/** The agent had the turn in progress, so its exit cut that turn short: it took in one of the
 *  turn's inputs, or began the turn by itself (turnTaken). */
const hadTurn = (state: State, slot: Slot, conversation: string) =>
  (slot.state === "running" || slot.state === "waiting") && Boolean(state.conversations.find((c) => c.id === conversation)?.turnTaken);

/** Characters of a message a notice quotes. */
const SHOWN = 60;

/** Tells you the slot's agent crashed (product §4.5): what was lost, which asks are void, which
 *  inputs may or may not have reached it, as they are never written again (architecture §4.6), and
 *  what comes next. */
function crashed(state: State, ctx: Ctx, d: Decision, slot: Slot, e: Extract<AgentEvent, { type: "exit" }>, then: string): void {
  const how = e.signal ? `被信号 ${e.signal} 结束` : e.code !== null ? `退出，退出码 ${e.code}` : "断开了";
  const lost = slot.state === "starting" ? "，没能启动。" : hadTurn(state, slot, e.conv) ? "，这一回合没做完。" : "。";
  const head = [`${slotView(state, slot).ref} 崩溃了${lost}`, then, `原因：${e.why ?? `${e.from === "agent" ? "agent " : "托管进程"}${how}`}`];
  // Not started, it said nothing but its error output, which is why (docs/im-style.md §6.1), unless its driver says.
  if (slot.state === "starting" && e.stderr && !e.why) head.push("它最后报的错：", e.stderr);
  const asks = agentAsks(state, slot).length;
  const unsure = (e.why ? [] : state.unsure).map((i) => withoutSource(i.body ?? "")); // never opened, it was given none
  const lines: string[] = [];
  if (asks) lines.push(`它那${asks > 1 ? ` ${asks} ` : ""}条提问作废了，之后回的编号会当成新消息。`);
  if (unsure.length) lines.push(`${these(unsure.length)}不确定它收到没有，需要的话再发一遍：`, ...unsure.map(quote));
  const text = [head.join("\n"), lines.join("\n")].filter(Boolean).join("\n\n");
  tell(state, ctx, d, slot, slot.turnInbound ?? ctx.newId(), (caps, lead) => withCopies(caps, lead + text, unsure));
}

const these = (n: number) => (n > 1 ? `这 ${n} 条` : "这条");
/** A message a notice quotes, on one line, cut at SHOWN characters. */
const quote = (text: string) => `“${clip(text.replace(/\s+/g, " ").trim(), SHOWN, "…")}”`;

/** Tells you, in the chat each came from, of messages of yours the agent did not or may not get
 *  (docs/im-style.md §6.6): lead's line, given 这条 or 这 n 条, then each quoted, with a copy button
 *  to send it again (§11.5). */
function quoteBack(state: State, ctx: Ctx, d: Decision, slot: Slot, inputs: AgentInput[], lead: (these: string) => string): void {
  for (const [chat, mine] of Map.groupBy(inputs, (i) => state.chatOf[i.id])) {
    const quotes = mine.map((i) => withoutSource(i.body ?? ""));
    const text = [lead(these(mine.length)), ...quotes.map(quote)].join("\n");
    tell(state, ctx, d, slot, mine[0]!.trace ?? ctx.newId(), (caps, l) => withCopies(caps, l + text, quotes), state.chats.find((c) => c.id === chat));
  }
}

/** Takes your messages queued for the slot's agent, or those of them `which` picks, off the queue and
 *  tells you (product §4.2, §10): they would go in long after, when what you said may no longer hold.
 *  happened: what came over the slot; again: how to send them again. */
function giveBack(state: State, ctx: Ctx, d: Decision, source: NewEvent["source"], slot: Slot, happened: string, again: string, which = (_: AgentInput) => true): void {
  const yours = state.queued.filter((i) => i.conversation === slot.conversation && i.source === "human" && which(i));
  // The board's go back where you typed them, should the page be open: on record with their words,
  // never quoted to a chat (spec web-write "待发队列").
  const board = new Set(fromBoard(state, slot));
  for (const i of yours) {
    d.writes.push({ op: "delete", table: "agentInput", where: { id: i.id } });
    const text = board.has(i) ? { text: withoutMedia(withoutSource(i.body ?? "")).text } : {};
    d.events.push({ source, type: "input_returned", slot: slot.id, ...(i.trace && { trace: i.trace }), data: { why: happened, ...text } });
  }
  const quoted = yours.filter((i) => !board.has(i));
  quoteBack(state, ctx, d, slot, quoted, (n) => `${slotView(state, slot).ref} ${happened}，你排着的${n}没交给它，${again}：`);
}

/** A notice quoting what may not have reached the agent, for you to send again (docs/im-style.md §11.5):
 *  cut up by the platform's limit, with a button that copies each quote where the platform has one that
 *  holds it; else the quote follows in a message of its own, should one hold it. */
function withCopies(caps: Capabilities | undefined, text: string, quotes: string[]): Payload[] {
  const max = caps?.maxTextLength ?? Infinity;
  const copies = quotes.flatMap((q, i): Button[] => (caps?.copy !== undefined && [...q].length <= caps.copy ? [{ label: quotes.length > 1 ? `复制第 ${i + 1} 条` : "复制", data: q, copy: true }] : []));
  const buttons = copies.length ? fitting(caps, copies) : undefined;
  const alone = quotes.filter((q) => !buttons?.some((b) => b.data === q) && [...q].length <= max).map((q) => ({ text: q }));
  const texts = chunkText(text, max);
  return [...texts.map((t, i) => ({ text: t, ...(i === texts.length - 1 && buttons && { buttons }) })), ...alone];
}

/** The Herdr bridge's answer to tui_open (architecture §10.1): the slot is in the terminal from now
 *  on, or its switch failed and it stays headless. You hear which as switched() has it. */
function tuiOpened(state: State, input: Extract<Input, { kind: "tui" }>, ctx: Ctx): Decision {
  const d = nothing();
  const slot = state.slots.find((s) => s.id === input.slot);
  if (!slot?.conversation || slot.mode !== "tui" || slot.herdrPane !== null) return d;
  // The slot as the switch leaves it.
  const set = (patch: Patch<Slot>): Slot => (d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch }), { ...slot, ...patch });
  const ref = slotView(state, slot).ref;
  const o = input.opened;
  if ("error" in o) {
    // What waited for the switch back goes in now, as the agent starts again for it.
    // ponytail: past the running limit, by this one slot; check it as wake() does if that matters.
    releaseQueued(d, slot.conversation, IN_TUI);
    // Not for what the runner writes past, say the board's paused queue: no turn would begin.
    const waits = state.queued.some((i) => i.conversation === slot.conversation && !PASSED.includes(i.queueReason));
    const now = set({ mode: "headless", ...(waits && { state: "starting" as const }) });
    if (waits) d.effects.push({ kind: "start", slot: slot.id });
    d.events.push({ source: "tui", type: "tui_failed", slot: slot.id, data: { error: o.error } });
    switched(state, ctx, d, now, `${ref} 没能切到 TUI，还在无头模式，对话不变。\n原因：${o.error}`);
    return d;
  }
  const now = set({ state: "off", herdrTab: o.tab, herdrPane: o.pane, tuiPid: o.pid, tuiStart: o.start, tuiLaunched: 1 });
  // A new conversation opened there, as for a slot with none yet: Claude's id known at once, a Codex
  // thread with no record dropped (architecture §10.3).
  const conv = state.conversations.find((c) => c.id === slot.conversation)!;
  if (o.session !== conv.sessionId) d.writes.push({ op: "update", table: "conversation", where: { id: conv.id }, patch: { sessionId: o.session } });
  d.writes.push({ op: "update", table: "workspace", where: { id: slot.workspace }, patch: { herdrWorkspace: o.workspace } });
  d.events.push({ source: "tui", type: "tui_opened", slot: slot.id, data: { tab: o.tab, pane: o.pane } });
  const ws = state.workspaces.find((w) => w.id === slot.workspace)!.name;
  // Found by names, never by Herdr's ids; the session only when it is not the one you use.
  const session = ctx.config.herdr.session === "default" ? "" : ` ${ctx.config.herdr.session} 会话里`;
  const where = `在 Herdr${session} ${ws} 工作区的 ${slot.name} 标签页。`;
  const text = `${ref} 切到 TUI 了。\n${where}\n在 TUI 里退出 agent，它会自动切回无头。这之前，这里的消息不会交给它。`;
  switched(state, ctx, d, now, text, [{ label: "切回无头", data: `/rh_release ${ref}` }], true);
  // Your messages still queued, say held for an interrupt, are yours to send in the terminal.
  giveBack(state, ctx, d, "tui", now, "切到 TUI 了", "要的话到终端里再发");
  return d;
}

/** The Herdr bridge's answer to the slot's agent in the terminal going (architecture §10.1, §10.2):
 *  back to headless, on the session its pane last reported. What waited for the switch back goes in
 *  now, as the agent starts again for it. Or another process has the conversation, and it waits for you. */
function tuiBack(state: State, input: Extract<Input, { kind: "tui_back" }>, ctx: Ctx): Decision {
  const d = nothing();
  const slot = state.slots.find((s) => s.id === input.slot);
  if (!slot?.conversation || slot.mode !== "tui" || slot.herdrPane === null) return d;
  // The slot as the switch leaves it.
  const set = (patch: Patch<Slot>): Slot => (d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch }), { ...slot, ...patch });
  const ref = slotView(state, slot).ref;
  // Herdr's restart took the agent with it: the notice says so.
  const lost = slot.herdrLostAt !== null;
  if (lost) d.effects.push({ kind: "timer", timer: "herdr_wait", key: slot.id, at: null });
  const b = input.back;
  if ("error" in b) {
    // An agent that did not exit is still watched: once it goes, the slot goes back as usual. One gone
    // keeps its start time, which the next try reads the transcript from.
    const now = set({ ...(!b.running && { tuiPid: null }), herdrLostAt: null });
    d.events.push({ source: "tui_back", type: "tui_back_failed", slot: slot.id, data: { error: b.error } });
    switched(state, ctx, d, now, `${ref} 没能切回无头，这里的消息还不会交给它。\n原因：${b.error}`, [{ label: "再试一次", data: `/rh_release ${ref}` }]);
    return d;
  }
  // You may have moved on to another conversation in the terminal (/clear, /resume): the slot goes on
  // with that one, which joins its timeline as /resume would have it.
  // Not one another slot is on, as for /resume: the slot goes on with its own instead.
  const conv = state.conversations.find((c) => c.id === slot.conversation)!;
  const theirs = b.session === null || b.session === conv.sessionId ? undefined : slotOn(state, slot, conv.agent, b.session);
  const session = theirs ? conv.sessionId : b.session;
  let to = conv.id;
  if (session !== conv.sessionId) {
    const had = state.conversations.find((c) => c.slot === slot.id && c.agent === conv.agent && c.sessionId === b.session);
    // A slot with none before is on the one started there: a Codex thread, reported at its first turn (story 545).
    if (!had && conv.sessionId === null) d.writes.push({ op: "update", table: "conversation", where: { id: conv.id }, patch: { sessionId: session } });
    else {
      to = had?.id ?? ctx.newId();
      if (!had) d.writes.push({ op: "insert", table: "conversation", row: { id: to, slot: slot.id, agent: conv.agent, sessionId: b.session, startedAt: ctx.now } });
    }
  }
  // ponytail: past the running limit, by this one slot, as for a failed switch (tuiOpened).
  const waits = state.queued.some((i) => i.conversation === conv.id);
  d.writes.push({ op: "update", table: "agentInput", where: { conversation: conv.id, status: "queued" }, patch: { conversation: to, queueReason: null } });
  // What you changed in a terminal Rhodium launched, which the slot keeps as if set with /effort or /model.
  const kept = !slot.tuiLaunched ? {} : CARRY[conv.agent](slot, state.modelInfo, b.used, b.before);
  const now = set({ mode: "headless", state: waits ? "starting" : "off", conversation: to, herdrTab: null, herdrPane: null, tuiPid: null, tuiStart: null, tuiLaunched: null, herdrLostAt: null, ...kept });
  if (waits) d.effects.push({ kind: "start", slot: slot.id });
  // A release you have not answered has nothing left to end, and would take your next message as its answer.
  const argv = (a: Ask) => (a.kind === "confirm" ? (prompt(a).input as ConfirmInput).argv : []);
  cancelAsks(d, openAsks(state, slot).filter((a) => argv(a)[0] === "release" && slotByRef(state, argv(a)[1] ?? "") === slot));
  // Herdr restarted while rhodium was away is as much a restart.
  const fault = lost || b.restarted === true;
  d.events.push({ source: "tui_back", type: "tui_back", slot: slot.id, data: { session, lost: fault, ...kept } });
  const which = theirs
    ? `。你在 TUI 里最后用的那段对话是 ${slotView(state, theirs).ref} 的，它接着用原来那段。`
    : b.elsewhere
      ? "。你在 TUI 里最后用的那段对话不在它的目录里，无头的 pi 接不上，它接着用原来那段。"
      : to === conv.id
        ? "。"
        : "，接着用你在 TUI 里最后那段对话。";
  const told = [
    ...(kept.effort ? [`思考强度 ${kept.effort}`] : []),
    ...(kept.ultracode !== undefined ? [`ultracode ${kept.ultracode ? "开" : "关"}`] : []),
    ...(kept.model !== undefined ? [`模型 ${kept.model === null ? "默认模型" : (state.models[conv.agent]?.[kept.model] ?? kept.model)}`] : [])];
  const applied = told.length ? `\n已应用 TUI 中的设置：${told.join("，")}。` : "";
  switched(state, ctx, d, now, (fault ? `Herdr 重启了，${ref} 在 TUI 里的进程没了，已经切回无头${which}` : `${ref} 切回无头了${which}`) + applied, undefined, true);
  return d;
}

/** What the slot keeps of the terminal's settings once back (product §4.2): the model or the level its
 *  agent last ran on, if you changed it there; and ultracode, apart from both, if you turned it on or off
 *  there (#276). The level against the slot's own where it has one, which the
 *  terminal was launched with, else the turn before the terminal's (was), on your default. A model you
 *  switched to goes by the handshake's name for it, without its level: that is the model's default, not
 *  yours. Nor a level Claude narrowed the slot's to, one the model has. Model ids are full ones;
 *  whatever cannot be told is left as it was. */
export function carriedBack(slot: Pick<Slot, "model" | "effort" | "ultracode">, info: ModelInfo, used: Used | undefined, was: Used | undefined): Patch<Slot> {
  const start = slot.model !== null ? info[slot.model]?.resolved : was?.model;
  const end = used?.model ?? start;
  const takes = (level: string) => Object.values(info).some((m) => m.resolved === end && m.levels.includes(level));
  // No marker in the terminal: it ran as launched, as Claude marks only turning it on or off. Any marker
  // counts against a slot that never set it, which follows your own settings, whatever they have.
  const ultra = used?.ultra;
  const ultracode: Patch<Slot> = ultra !== undefined && (slot.ultracode === null || ultra !== (slot.ultracode === 1)) ? { ultracode: ultra ? 1 : 0 } : {};
  if (start === undefined) return ultracode;
  if (end !== start) {
    // Not default where another name has it, which would follow your default wherever it goes.
    const named = Object.entries(info).find(([v, m]) => v !== "default" && m.resolved === end)?.[0];
    const model = named ?? (info.default?.resolved === end ? null : undefined);
    return { ...(model !== undefined && model !== slot.model && { model }), ...ultracode };
  }
  if (slot.effort !== null && !takes(slot.effort)) return ultracode;
  const ran = used?.effort;
  // The turn before is the terminal's start only if it ran on the model the terminal started on.
  const from = slot.effort ?? (was?.model === start ? was.effort : undefined);
  return { ...(ran !== undefined && from !== undefined && ran !== from && { effort: ran }), ...ultracode };
}

/** What each agent's terminal leaves the slot, by its kind. */
const CARRY: Record<AgentKind, typeof carriedBack> = { claude: carriedBack, pi: (_, __, used, was) => piCarriedBack(used, was), codex: (slot, _, used, was) => codexCarriedBack(slot, used, was) };

/** The same for Codex (spec codex.md), from the settings line of its turns, as for Claude: against what
 *  the slot set, which the terminal was launched with, else the turn before the terminal's (was). A
 *  model you switched to is kept by its id, without its level; else the level, if you changed it. */
export function codexCarriedBack(slot: Pick<Slot, "model" | "effort">, used: Used | undefined, was: Used | undefined): Patch<Slot> {
  const start = slot.model ?? was?.model;
  if (start === undefined || used === undefined) return {};
  if (used.model !== undefined && used.model !== start) return { model: used.model };
  // The turn before is the terminal's start only if it ran on the model the terminal started on.
  const from = slot.effort ?? (was?.model === start ? was.effort : undefined);
  return used.effort !== undefined && from !== undefined && used.effort !== from ? { effort: used.effort } : {};
}

/** The same for pi (architecture §6.3), from the newest change lines of its session file. The terminal
 *  started on those before it, which pi resumed (was), whatever the slot remembers: with none, it
 *  started on your defaults, and nothing can be told. A model you switched to is kept, as the slot
 *  keeps one (provider/modelId), and not the level pi then reset to; else the level, if you changed it. */
export function piCarriedBack(used: Used | undefined, was: Used | undefined): Patch<Slot> {
  if (was?.model === undefined || used === undefined) return {};
  if (used.model !== undefined && used.model !== was.model) return { model: used.model };
  return used.effort !== undefined && was.effort !== undefined && used.effort !== was.effort ? { effort: used.effort } : {};
}

/** The Herdr bridge lost Herdr's socket, or has it again (architecture §10.2). Meanwhile the slots in
 *  the terminal tell your messages Herdr is restarting, and wait durations.herdrRestartWait for it;
 *  a slot whose agent Herdr resumed itself stays in the terminal, with that agent. */
function herdrLink(state: State, input: Extract<Input, { kind: "herdr" }>, ctx: Ctx): Decision {
  const d = nothing();
  for (const s of state.slots) {
    if (s.mode !== "tui" || s.herdrPane === null || s.tuiPid === null) continue;
    const set = (patch: Patch<Slot>) => d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch });
    if (!input.up) {
      // Also at startup with Herdr still away: the clock is set again from when it went.
      const at = s.herdrLostAt ?? ctx.now;
      if (s.herdrLostAt === null) {
        set({ herdrLostAt: at });
        d.events.push({ source: "herdr", type: "herdr_lost", slot: s.id });
      }
      d.effects.push({ kind: "timer", timer: "herdr_wait", key: s.id, at: at + ctx.config.durations.herdrRestartWait });
      continue;
    }
    // A new process, without the slot's token: rh knows it by this pid (caller()).
    const agent = input.resumed[s.id];
    if (agent) {
      set({ tuiPid: agent.pid, tuiStart: agent.start, tuiLaunched: null });
      d.events.push({ source: "herdr", type: "tui_resumed", slot: s.id, data: agent });
    }
    if (s.herdrLostAt !== null) {
      set({ herdrLostAt: null });
      d.effects.push({ kind: "timer", timer: "herdr_wait", key: s.id, at: null });
    }
  }
  return d;
}

/** The conversations on disk rh import alone lists, at most: the most recently active. */
const IMPORT_LISTED = 10;

/** What rh import found (product §4.3): a slot on that conversation, in the workspace of its
 *  directory, made if need be. You hear of it where you asked; /rh_import points that chat at it.
 *  Or what there is to import, but for what a slot has. */
function imported(state: State, input: Extract<Input, { kind: "import" }>, ctx: Ctx): Decision {
  const d = nothing();
  const chat = state.chats.find((c) => c.id === input.chat);
  // On the board, /rh_import typed there: the page hears, as a chat would, and nothing is pointed.
  const at = input.chat === BOARD ? { chat: BOARD, inbound: input.id } : chat && { chat: chat.id, inbound: input.id, ui: input.panel };
  // slot: the one it made, for the board's page to open (story 321).
  const say = (ok: boolean, text: string, slot?: string) => {
    if (chat && at) answer(d, ctx, at, text);
    else d.effects.push({ kind: "rh_reply", id: input.id, reply: ok ? { ok, text, ...(slot && { slot }) } : { ok, error: text } });
    return d;
  };
  const f = input.found;
  if ("error" in f) return say(false, `没能导入。\n原因：${f.error}`);
  // One conversation, one slot: two would each resume it. Not one a slot ever had either, archived
  // or not: /resume goes back to that.
  const used = (agent: AgentKind, session: string) => state.conversations.find((c) => c.agent === agent && c.sessionId === session);
  // One pane, one slot, too: a slot's pane reports another conversation after /clear or /resume there.
  const paneOwner = (pane?: string) => (pane ? state.slots.find((s) => s.herdrPane === pane) : undefined);
  if ("list" in f) {
    const free = f.list.filter((i) => !used(i.agent, i.session) && !paneOwner(i.pane));
    const panes = free.filter((i) => i.pane);
    const disk = free.filter((i) => !i.pane).slice(0, IMPORT_LISTED);
    // Herdr's session by name only when it is not your usual one (docs/im-style.md §6.3).
    const where = ctx.config.herdr.session === "default" ? "Herdr 里" : `Herdr ${ctx.config.herdr.session} 会话里`;
    if (!panes.length && !disk.length) return say(true, `没有可以导入的：${where}没有报告了对话的 agent，${f.dir} 里也没有槽位没用过的对话。`);
    // In chat, a panel (docs/im-style.md §9.7); its buttons name the whole id, as a start of one could come to name two.
    if (at) {
      const candidates = imCommand("rh_import")!.list!({ importable: [...panes, ...disk], now: ctx.now });
      showIn(state, ctx, d, at, { command: "/rh_import", head: [`导入哪一个？${where}正在用的排在前面。`], candidates, ...(at.ui?.edit && { back: "/rh_help" }) });
      return d;
    }
    const label = (i: (typeof free)[number]) => (i.pane ? `${i.pane}  ${i.agent}  ${i.dir}` : `${i.session.slice(0, 8)}  ${i.agent}  ${time(i.at!)}  ${clip(i.said ?? "", 30)}`);
    const text = [
      ...(panes.length ? [`Herdr 会话 ${ctx.config.herdr.session} 里的 agent：`, ...panes.map((i) => `rh import ${label(i)}`)] : []),
      ...(disk.length ? [`${f.dir} 里的对话，最近的在前：`, ...disk.map((i) => `rh import ${label(i)}`)] : []),
      `照上面的命令导入，--name <名字> 给槽位起名。`,
    ];
    return say(true, text.join("\n"));
  }
  const paneTheirs = paneOwner(f.pane?.pane);
  if (paneTheirs) return say(false, `没能导入，这个 pane 已经是 ${slotView(state, paneTheirs).ref} 的了。`);
  const theirs = used(f.agent, f.session);
  if (theirs) {
    // Back to it the way you go back to any of a slot's conversations; a pane's agent lets go of it first.
    const ref = slotView(state, state.slots.find((s) => s.id === theirs.slot)!).ref;
    const [use, resume] = chat ? [`/rh_use ${ref}`, "发 /resume 选它"] : [`rh use <Bot>/<窗口 ID> ${ref}`, "在那个窗口发 /resume 选它"];
    const board = `打开 ${ref}，发 /resume 选它`;
    const how = input.chat === BOARD ? (f.pane ? `先在 pane 里退出 agent，再${board}` : board) : f.pane ? `先在 pane 里退出 agent，再 ${use}，${resume}` : `先 ${use}，再${resume}`;
    return say(false, `没能导入，这段对话是 ${ref} 用过的。要接着用，${how}。`);
  }
  const name = input.name ?? f.session.slice(0, 8);
  const had = state.workspaces.find((w) => w.dir === f.dir);
  if (had && state.slots.some((s) => s.workspace === had.id && s.name === name)) return say(false, `没能导入，工作区 ${had.name} 里已经有槽位 ${name}，用 --name 另起一个名字。`);
  const ws = workspaceFor(state, ctx, d, f.dir, "import");
  const slot = addSlot(state, ctx, d, { workspace: ws, name, dir: f.dir, agent: f.agent, state: "off", lifetime: "longterm", session: f.session });
  const ref = `${ws.name}/${name}`;
  // A pane's agent goes on in your terminal, as after /rh_tui; rh knows it by its process (caller()).
  const p = f.pane;
  const patch: Patch<Slot> = p ? { mode: "tui", herdrTab: p.tab, herdrPane: p.pane, tuiPid: p.pid, tuiStart: p.start } : {};
  const point = chat && input.point;
  if (chat) contacted(d, ctx, chat.id);
  if (point) d.writes.push({ op: "update", table: "chat", where: { id: chat.id }, patch: { target: slot.id } });
  d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch });
  d.events.push({ source: "import", type: "slot_imported", trace: input.id, slot: slot.id, data: { ref, dir: f.dir, agent: f.agent, session: f.session, pane: p?.pane } });
  // In IM by names alone (docs/im-style.md §9.7); at your terminal with what you would look up.
  if (chat) {
    if (!p) return say(true, `已导入成 ${ref}，接着那段对话。${point ? "这里的消息改交给它。" : ""}`);
    return say(true, `已导入成 ${ref}，它在 TUI 里。在 TUI 里退出 agent，它会自动切回无头${point ? "，之后这里的消息交给它" : ""}。`);
  }
  const from = p ? `Herdr 里 pane ${p.pane} 的 ${f.agent}` : `${f.agent} 的对话`;
  const next = p ? "它在 TUI 模式，你在 pane 里退出 agent 后切回无头。" : "给它发消息就接着这段对话。";
  return say(true, `已导入成 ${ref}：${from}，目录 ${f.dir}。${next}`, slot.id);
}

// ---- Asks (product §5.8, architecture §7.5). ----

const prompt = (a: Ask) => JSON.parse(a.prompt!) as AskPrompt;
/** The slot's asks not settled yet that its agent waits on. A confirm request is Rhodium's own, and
 *  outlives the agent process. */
const agentAsks = (state: State, slot: Slot) => state.asks.filter((a) => a.slot === slot.id && a.kind !== "confirm");
/** The slot's asks waiting on you, oldest first, confirm requests too. */
const openAsks = (state: State, slot: Slot) => state.asks.filter((a) => a.slot === slot.id && a.status === "open");
/** Those the agent's turn waits on: all but confirm requests (product §5.8). */
const blocking = (state: State, slot: Slot) => agentAsks(state, slot).filter((a) => a.status === "open");

/** A running slot with asks open needs you; once none is left it runs on (product §4), and the
 *  internal messages held for its asks go in (architecture §9.3). */
function waiting(state: State, d: Decision, slot: Slot, open: number): void {
  const to = open && slot.state === "running" ? "waiting" : !open && slot.state === "waiting" ? "running" : null;
  if (to) d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { state: to } });
  if (open || !state.queued.some((i) => i.conversation === slot.conversation && i.queueReason === AFTER_ASKS)) return;
  // An interrupt withdrew the asks: they wait for the interrupted turn to end, as your message does.
  if (slot.interruptedAt !== null) return releaseQueued(d, slot.conversation!, AFTER_ASKS, AFTER_INTERRUPT);
  // In a turn with a turn chat, they wait for it to end, as they would have had they come now (wake).
  if (slot.turnChat !== null) return releaseQueued(d, slot.conversation!, AFTER_ASKS, AFTER_TURN);
  releaseQueued(d, slot.conversation!, AFTER_ASKS);
  d.effects.push({ kind: "deliver", conversation: slot.conversation! }); // after the answer, which goes first
}

/** The messages that ask you the ask (its row id, kind and prompt), as the platform of caps takes it:
 *  with buttons that answer it where it has them, after lead, and cut up by its limit. The last piece
 *  carries the ask, which has reached you once that is sent (pushedAt). */
function askMessages(a: Pick<Ask, "id"> & { kind: AskKind; prompt: AskPrompt }, from: string, caps: Capabilities | undefined, lead = ""): Payload[] {
  // Where the platform has buttons and one page holds them; else none, and the options go numbered.
  const all = askButtons(a.kind, a.prompt, a.id);
  const laid = all && layout(all, a.kind !== "question");
  const buttons = caps?.buttons && laid && laid.length <= Math.min(PAGE, caps.maxButtons ?? Infinity) && laid.at(-1)!.row! < 4 ? laid : undefined;
  const texts = chunkText(lead + askText(a.kind, a.prompt, from, buttons !== undefined), caps?.maxTextLength ?? Infinity);
  return texts.map((text, i) => ({ text, ...(i === texts.length - 1 && { ask: a.id, buttons }) }));
}

/** Something else went to the turn's chat mid-turn, say an ask or a picture: on a platform that
 *  edits, what the turn shows next comes under it, in a new message (story 72). p: the turn's
 *  progress, where it is newer than the kept one. */
function underIt(state: State, ctx: Ctx, d: Decision, slot: Slot, p = progressOf(state.conversations.find((c) => c.id === slot.conversation)?.progress)): void {
  const conversation = slot.conversation!;
  const to = toChat(state, slot.turnChat, ctx);
  if (!p?.live || !to?.caps) return;
  const v = viewOf({ ...to, caps: to.caps }, slot, ctx);
  d.writes.push({ op: "update", table: "conversation", where: { id: conversation }, patch: { progress: JSON.stringify({ ...moveOn(p, v), live: undefined, left: [...(p.left ?? []), p.live] }) } });
  lastEdit(d, p.live, p, v);
}

/** The last edit of the turn's message live, nothing more going to it: as p shows it, without the
 *  step still running, which may still be to make. Turned down, its text goes all the same (editFailed). */
function lastEdit(d: Decision, live: string, p: TurnProgress, v: View): void {
  const m = freeze(p, v);
  editLive(d, p, live, m, { final: true, unchanged: m.text === p.shown });
}

/** Edits the turn's message live to show m; final: m is its last; unchanged: the message shows m
 *  already. One that went through another bot (refused()) says so on top; through one that can't
 *  edit (QQ), only its last text goes, if new, as a new message (editFailed). */
// ponytail: the text keeps the Markdown of the turn's platform, not the other's; render it for that one if it shows wrong.
function editLive(d: Decision, p: TurnProgress, live: string, m: Msg, o: { final?: boolean; unchanged?: boolean } = {}): void {
  const lead = p.lead?.on === live ? p.lead : undefined;
  if (lead?.once !== undefined && (!o.final || m.text === lead.once)) return;
  const on = (s: string) => (lead ? `${lead.text}\n\n${s}` : s);
  const unchanged = o.unchanged && lead?.once === undefined;
  d.effects.push({ kind: "edit", outbound: live, text: on(m.text), markdown: m.markdown && on(m.markdown), ...(o.final && { final: true as const }), ...(unchanged && { unchanged: true as const }) });
}

const MINUTE = 60_000;

/** A turn's progress as the conversation keeps it. One kept before progress took this shape (an
 *  upgrade mid-turn) starts afresh, its messages kept. */
function progressOf(saved: string | null | undefined): TurnProgress | null {
  if (!saved) return null;
  // asked: what an older Rhodium called hidden, in a turn that runs across the upgrade.
  const { asked, ...p } = JSON.parse(saved);
  if (!p.parts) return { ...start(), live: p.live, left: p.left, told: p.told };
  return asked ? { ...p, hidden: asked } : p;
}

/** How the chat shows the slot's turns: detailed tool lines where /rh_verbose says so, else by
 *  default where the platform edits a message (Telegram) and has room for them (im-style §3.5). */
const verboseIn = (chat: Chat, caps: Capabilities) => (chat.verbose ?? (caps.progress === "edit" ? 1 : 0)) === 1;
const viewOf = (to: To & { caps: Capabilities }, slot: Slot, ctx: Ctx): View => ({ verbose: verboseIn(to.chat, to.caps), dir: slot.dir, now: ctx.now, caps: to.caps, toolsOnly: slot.turnSentMe === 1 });

/** The chat the slot's turn shows in as it goes, if it does (product §5.5): a turn you started.
 *  An interrupted turn shows nothing more: its chat already belongs to the next one. Nor does
 *  Claude's quota refusal: the notice says it (usage). A turn whose agent used rh send me in its
 *  chat shows only its tool lines from then on (viewOf, im-style §3.4). */
function shown(state: State, ctx: Ctx, slot: Slot): (To & { caps: Capabilities }) | undefined {
  const to = toChat(state, slot.turnChat, ctx);
  if (!to?.caps || !slot.turnInbound || slot.interruptedAt !== null || slot.state === "rate_limited") return undefined;
  return { ...to, caps: to.caps };
}

/** What edit() made of the turn, in its chat: out[0] in the turn's message, the rest in new ones,
 *  the last of them the turn's message from then on. The edit of a message outgrown is its last:
 *  should it be turned down, its text goes all the same, even once the turn is over (editFailed). */
function showEdit(d: Decision, ctx: Ctx, to: To, slot: Slot, p: TurnProgress, r: { progress: Progress; out: Msg[] }): TurnProgress {
  let live = p.live;
  r.out.forEach((m, i) => {
    if (i === 0 && live) editLive(d, p, live, m, { final: r.out.length > 1 });
    else live = outbound(d, ctx, { chat: to.chat.id, replyTo: slot.turnInbound, trace: slot.turnInbound, text: m.text, markdown: m.markdown });
  });
  const left = r.out.length > 1 && p.live ? [...(p.left ?? []), p.live] : p.left;
  return { ...r.progress, live, chat: to.chat.id, left, ...(slot.turnSentMe === 1 && { toolsOnly: true as const }) };
}

/** An ask from the slot's agent, or a confirm request about the slot's rh call: on record, then sent
 *  to the slot's contact chat, or at, which it returns. deferred: it waits for the slot's turn to end
 *  instead (confirm()), and is sent then (pushDeferred). */
function addAsk(state: State, ctx: Ctx, d: Decision, slot: Slot, a: Omit<AgentAsk, "kind" | "requestId"> & { kind: AskKind; requestId: string | null }, deferred = false, at?: Chat): string | undefined {
  const id = ctx.newId();
  const p: AskPrompt = { tool: a.tool, input: a.input };
  d.writes.push({ op: "insert", table: "ask", row: { id, slot: slot.id, kind: a.kind, requestId: a.requestId, prompt: JSON.stringify(p), status: deferred ? "deferred" : "open" } });
  // Its push carries the same trace, so the board lists the push with the ask.
  d.events.push({ source: a.kind === "confirm" ? "rh" : "agent", type: "ask", trace: slot.turnInbound ?? id, slot: slot.id, data: { kind: a.kind, tool: a.tool, ask: id } });
  return deferred ? undefined : pushAsk(state, ctx, d, slot, { id, kind: a.kind, prompt: p }, at);
}

/** Sends the ask to the slot's contact chat, or at, open from now on, with its deadline counted from
 *  now; returns the chat it went to. */
function pushAsk(state: State, ctx: Ctx, d: Decision, slot: Slot, a: { id: string; kind: AskKind; prompt: AskPrompt }, at?: Chat): string | undefined {
  const timeout = slot.askTimeout ?? ctx.config.durations.askTimeout;
  const deadline = timeout ? ctx.now + timeout : null; // 0: never times out
  const t = tell(state, ctx, d, slot, slot.turnInbound ?? a.id, (caps, lead, to) => askMessages(a, askFrom(state, ctx, slot, to.chat), caps, lead), at);
  // What you type there answers it, should that chat go to another slot (im()).
  const forwardedTo = t?.chat ?? null;
  // The list you saw lacks it, and its message asks for a number: your pick and list are void, the
  // slot's and those of the other slots' asks in that chat (im()).
  for (const o of state.asks) {
    if (o.status === "open" && (o.slot === slot.id || (forwardedTo && o.forwardedTo === forwardedTo)) && (o.listNo !== null || o.pickedAt !== null)) {
      d.writes.push({ op: "update", table: "ask", where: { id: o.id }, patch: { listNo: null, pickedAt: null } });
    }
  }
  d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch: { status: "open", deadline, forwardedTo } });
  if (deadline) d.effects.push({ kind: "timer", timer: "ask_timeout", key: a.id, at: deadline });
  return t?.chat;
}

/** How an ask of the slot names it in the chat: not at all where the chat goes to the slot (docs/im-style.md §4). */
function askFrom(state: State, ctx: Ctx, slot: Slot, chat: Chat): string {
  const bot = state.bots.find((b) => b.id === chat.bot);
  return bot && target(state, bot, chat, ctx)?.id === slot.id ? "" : slotView(state, slot).ref;
}

/** What you are told your answer to the ask was: picked from a list, which ask it was; of another slot
 *  than the one this chat goes to, whose. A confirm request of your own asks for nothing of a slot's:
 *  its receipt says what your decision does, wherever it came from (docs/im-style.md §5.4). */
function receipt(state: State, ctx: Ctx, a: Ask, chat: Chat, r: { said: string; receipt: string }, picked?: string): string {
  if (a.kind === "confirm" && !(prompt(a).input as ConfirmInput).from) return r.receipt;
  if (picked) return `已回答“${picked}”：${r.said}。`;
  const from = askFrom(state, ctx, state.slots.find((s) => s.id === a.slot)!, chat);
  return from ? `已回答 ${from} 的提问：${r.said}。` : r.receipt;
}

/** Sends the ask you picked from a list again, to answer it: it counts as sent to you once this copy
 *  is, and an answer goes to it alone. */
function resendAsk(state: State, ctx: Ctx, d: Decision, a: Ask, chat: Chat, inbound: string): void {
  for (const o of state.asks) if (o !== a && o.status === "open" && o.pickedAt !== null) d.writes.push({ op: "update", table: "ask", where: { id: o.id }, patch: { pickedAt: null } });
  d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch: { pickedAt: ctx.now, pushedAt: null } });
  const from = askFrom(state, ctx, state.slots.find((s) => s.id === a.slot)!, chat);
  for (const p of askMessages({ ...a, prompt: prompt(a) }, from, ctx.capabilities(chat.bot))) outbound(d, ctx, { chat: chat.id, replyTo: inbound, trace: inbound, ...p });
}

/** The slot's turn is over: the confirm requests that waited for it (confirm()) go to you now, after its reply. */
function pushDeferred(state: State, ctx: Ctx, d: Decision, slot: Slot): void {
  for (const a of state.asks) if (a.slot === slot.id && a.status === "deferred") pushAsk(state, ctx, d, slot, { id: a.id, kind: a.kind, prompt: prompt(a) });
}

/** Puts the answer on record, unless someone answered first, and hands it to the agent; a decision on a
 *  confirm request is carried out instead (decide), and returns what came of it. by: the chat, timeout,
 *  or the board (WEB), which leaves rh send me's hold on the turn. inbound: your message from that chat
 *  that answered it. shown: what the ask's messages show in its place, on a platform that edits. */
function answerAsk(state: State, ctx: Ctx, d: Decision, slot: Slot, a: Ask, answer: Answer, by: string, inbound?: string, shown?: string): string | undefined {
  // A decision goes as a message, which the agent input table sees to the agent: the ask is done with.
  const patch: Patch<Ask> = answer.kind === "confirm" ? { status: "delivered", deliveredAt: ctx.now } : { status: "answered" };
  d.writes.push({ op: "update", table: "ask", where: { id: a.id, status: "open" }, patch: { ...patch, answer: JSON.stringify(answer), answeredBy: by } });
  d.effects.push({ kind: "timer", timer: "ask_timeout", key: a.id, at: null }, { kind: "unbutton", ask: a.id, ...(shown !== undefined && { text: shown }) });
  d.events.push({ source: by === "timeout" ? "clock" : "im", type: "ask_answered", slot: slot.id, data: { kind: a.kind, by, ask: a.id } });
  if (answer.kind === "confirm") return decide(state, ctx, d, a, answer, by);
  // As your message from IM would, your answer there takes over a turn the board's page began: the ask
  // called you back to IM, and the rest of the turn, its reply too, goes there (product §7).
  if (inbound && slot.turnChat === BOARD) d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { turnChat: by, turnInbound: inbound } });
  if (by !== "timeout" && by !== WEB) lift(state, ctx, d, slot);
  d.effects.push({ kind: "answer", conversation: slot.conversation!, ask: a.id });
  waiting(state, d, slot, blocking(state, slot).filter((o) => o.id !== a.id).length);
}

/** No agent waits on these any more, say after an interrupt or once its process is gone. */
function cancelAsks(d: Decision, asks: Ask[]): void {
  for (const a of asks) {
    d.writes.push({ op: "update", table: "ask", where: { id: a.id, status: a.status }, patch: { status: "cancelled" } });
    d.effects.push({ kind: "timer", timer: "ask_timeout", key: a.id, at: null });
    if (a.status === "open") d.effects.push({ kind: "unbutton", ask: a.id });
  }
}

/**
 * Your message to a slot with asks open (product §5.3). It answers the ask you picked once that
 * has been sent to you again, or the only one if it reached you and was in no list. Otherwise a
 * number from the list you were shown picks that ask, which is sent again for your answer. The
 * numbers stay as shown until a new list, or a new ask, which voids the list and the pick (addAsk):
 * one whose ask is gone, or anything else, gets a new list. Asks of several slots each name theirs.
 * Returns why, for the inbound record.
 */
function answerFromIm(state: State, ctx: Ctx, d: Decision, open: Ask[], text: string, media: boolean, chat: Chat, inbound: string): string {
  const chatId = chat.id;
  const update = (a: Ask, patch: Patch<Ask>) => d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch });
  const picked = open.find((a) => a.pickedAt !== null && a.pushedAt !== null);
  const only = open.length === 1 && open[0]!.pushedAt !== null && open[0]!.listNo === null ? open[0] : undefined;
  const ask = picked ?? only;
  const slotOf = (a: Ask) => state.slots.find((s) => s.id === a.slot)!;
  // Named by its slot unless that is the one this chat goes to.
  const line = (a: Ask) => [askFrom(state, ctx, slotOf(a), chat), askLine(a.kind, prompt(a))].filter(Boolean).join(" ");
  // An answer is words: a picture or file can't be one, and isn't kept back for later without a word.
  if (media) {
    const ref = [...new Set(open.map((a) => slotView(state, slotOf(a)).ref))].join("、");
    reply(d, ctx, chatId, inbound, `${ref} 在等你回答提问，图片和文件不能当回答，这条没交给它。先用文字回答，再发一遍。`);
    return "提问：带了图片或文件";
  }
  if (ask) {
    const r = parseAnswer(ask.kind, prompt(ask), text);
    if (!r) {
      // Empty, say a sticker with no words.
      const n = Array.isArray(prompt(ask).input?.questions) ? prompt(ask).input.questions.length : 0;
      reply(d, ctx, chatId, inbound, `没看懂这个回答。${text.trim() ? `这条提问有 ${n} 个问题，每行答一个。` : "这条消息没有文字。"}`);
      return "提问：没看懂回答";
    }
    const result = answerAsk(state, ctx, d, slotOf(ask), ask, r.answer, chatId, inbound);
    // One you picked from several is named, so you see which one your words went to.
    reply(d, ctx, chatId, inbound, receipt(state, ctx, ask, chat, r, ask === picked ? line(ask) : undefined) + (result ?? ""));
    return "回答提问";
  }
  // Only a number you have seen in a list picks: until then it may mean an option.
  const chosen = /^\d+$/.test(text.trim()) ? open.find((a) => a.listNo === Number(text.trim())) : undefined;
  if (chosen) {
    resendAsk(state, ctx, d, chosen, chat, inbound);
    return "提问：选了编号";
  }
  const n = open.length;
  const buttons = fitting(ctx.capabilities(chat.bot), open.map((a, i) => ({ label: `第 ${i + 1} 条`, data: `pick:${a.id}` })));
  const how = buttons ? (n > 1 ? "先选一条再回答" : "先选它再回答") : n > 1 ? "先回编号选一条，再回答" : "先回 1 选它，再回答";
  const head = n === 1 && open[0]!.pushedAt === null ? `有 1 条提问还没送到这里，${how}。` : `有 ${n} 条提问在等你，${how}。`;
  const text2 = `${head}刚才那句没交出去。\n\n${open.map((a, i) => `${i + 1}. ${line(a)}`).join("\n")}`;
  outbound(d, ctx, { chat: chatId, replyTo: inbound, trace: inbound, text: text2, buttons });
  open.forEach((a, i) => update(a, { listNo: i + 1, pickedAt: null }));
  return "提问：先选编号";
}

// ---- Sending to a chat, within QQ's reply quotas (product §5.5, architecture §7.6, §8.2). ----

/** A chat to send to; caps is undefined while its bot has no adapter. */
type To = { chat: Chat; bot: Bot; caps: Capabilities | undefined };

function toChat(state: State, id: string | null, ctx: Ctx): To | undefined {
  const chat = state.chats.find((c) => c.id === id);
  const bot = chat && state.bots.find((b) => b.id === chat.bot);
  return bot && { chat: chat!, bot, caps: ctx.capabilities(bot.id) };
}

/** Each decision's one view of the quotas, so what one message uses counts for the next. */
const views = new WeakMap<Decision, Quotas>();

/** QQ's reply quotas as this decision sees them; take() writes what it uses into d. */
function quotas(state: State, ctx: Ctx, d: Decision): Quotas {
  let q = views.get(d);
  if (!q) views.set(d, (q = quotaView(state, ctx, d)));
  return q;
}

function quotaView(state: State, ctx: Ctx, d: Decision) {
  const rows = new Map(state.quotas.map((q) => [`${q.kind}\n${q.owner}`, { ...q }]));
  const window = ctx.config.durations.qqActiveWindow;
  const live = (kind: Quota["kind"], owner: string) => {
    const q = rows.get(`${kind}\n${owner}`);
    // An active count resetting more than a configured period away began on a longer one: it is
    // over, and the next message starts one as configured (architecture §7.6).
    const over = q?.resetsAt != null && (ctx.now >= q.resetsAt || (kind === "qq_active" && q.resetsAt > ctx.now + window));
    return q && !over ? q : undefined;
  };
  const { qqPassiveReplies, qqActive } = ctx.config.limits;
  return {
    /** Passive replies left to an inbound message, counting the last one, which is kept for the hint. */
    passive: (inbound: string) => Math.max(0, qqPassiveReplies - (live("qq_passive", inbound)?.used ?? qqPassiveReplies)),
    active: (bot: string) => Math.max(0, qqActive - (live("qq_active", bot)?.used ?? 0)),
    take(kind: Quota["kind"], owner: string) {
      const key = `${kind}\n${owner}`;
      let q = live(kind, owner);
      if (!q) {
        // Only a bot's active quota starts here, at its first use in a period. A passive one starts
        // with its inbound message (im()), and every caller checks passive() first.
        if (kind !== "qq_active") return;
        const old = rows.get(key);
        const fresh = { kind, owner, used: 0, resetsAt: ctx.now + window };
        q = { ...(old ?? { id: ctx.newId(), machine: "" }), ...fresh };
        rows.set(key, q);
        d.writes.push(old ? { op: "update", table: "quota", where: { id: q.id }, patch: fresh } : { op: "insert", table: "quota", row: { id: q.id, ...fresh } });
      }
      q.used++;
      d.writes.push({ op: "update", table: "quota", where: { id: q.id }, patch: { used: q.used } });
    },
  };
}
type Quotas = ReturnType<typeof quotaView>;

const HINT = "完成，回任意字查看";
/** What a button that does nothing any more says when pressed (docs/im-style.md §5.4). */
const STALE = "这个按钮已经失效了";

type Placed = { status: "pending" | "held"; replyTo: string | null; hint: boolean };

/**
 * How a message goes out on QQ (product §5.5), counting what it uses: a passive reply to the inbound
 * message while it has more than the last one left, else an active message, else held for your next
 * message, with that last passive reply telling you so. last: nothing waits after this message, so it
 * may take that last reply itself.
 */
function place(q: Quotas, to: To, inbound: string | null, last = false): Placed {
  if (to.caps?.sendLimit.kind !== "qq_quota") return { status: "pending", replyTo: inbound, hint: false };
  if (inbound && q.passive(inbound) > (last ? 0 : 1)) {
    q.take("qq_passive", inbound);
    return { status: "pending", replyTo: inbound, hint: false };
  }
  if (q.active(to.bot.id) > 0) {
    q.take("qq_active", to.bot.id);
    return { status: "pending", replyTo: null, hint: false };
  }
  const hint = inbound !== null && q.passive(inbound) > 0;
  if (hint) q.take("qq_passive", inbound);
  return { status: "held", replyTo: null, hint };
}

/** An outbound record's payload: the message, kept until it is sent (src/daemon.ts sends it). */
export type Payload = {
  text: string;
  markdown?: string; // the agent's text in the platform's Markdown (render.ts's markdown); Rhodium's own words go plain
  file?: { kind: "image" | "file"; path: string; name: string }; // from rh send --file: rhodium's copy, and the agent's name for it
  hint?: true; // it is the hint; a refusal never holds it
  hintedBy?: string; // held: the hint that told you it waits
  released?: true; // it was held and your next message brought it; a refusal drops it
  moved?: true; // refused() moved it to another bot: refused there too, it stays failed
  ask?: string; // it asks you this ask: once it is sent, the ask has reached you (pushedAt)
  buttons?: Button[]; // to press: an ask's, gone once it is settled, or ones that copy what a notice quotes
  secret?: true; // a pairing code (product §5.11): once sent, no text of it is kept for a quote
  // rh send's from a slot (sendYou()): what it marked the slot's turn, begun at at, with; taken back
  // should it fail in that turn (unsaid()).
  said?: { slot: string; at?: number | null; toldYou?: true; sentMe?: true };
};
const payload = (o: Outbound) => JSON.parse(o.payload!) as Payload;

type NewOutbound = { chat: string; replyTo: string | null; trace: string | null; status?: "pending" | "held" } & Payload;

function outbound(d: Decision, ctx: Ctx, o: NewOutbound): string {
  const id = ctx.newId();
  const { chat, replyTo, trace, status = "pending", ...p } = o;
  d.writes.push({ op: "insert", table: "outbound", row: { id, chat, replyTo, trace, status, createdAt: ctx.now, payload: JSON.stringify(p) } });
  if (status === "pending") d.effects.push({ kind: "send", outbound: id });
  return id;
}

/** The hint goes out on the inbound message's last passive reply. */
function hint(d: Decision, ctx: Ctx, chat: string, inbound: string, trace: string | null): string {
  return outbound(d, ctx, { chat, replyTo: inbound, trace, text: HINT, hint: true });
}

/** Sends each text to the chat as a reply to the inbound message, as the bot's quota allows: q, so
 *  that several messages count each other's use. What is held waits behind one hint: with no passive
 *  reply left even for that, another bot's chat with you gives it, if one can (product §5.5). */
function send(state: State, q: Quotas, ctx: Ctx, d: Decision, to: To, inbound: string | null, msgs: Msg[], ref: string): void {
  let hintedBy: string | undefined;
  for (const { text, markdown: md = markdown(text, to.caps) } of msgs) {
    const p = place(q, to, inbound);
    if (p.hint) hintedBy = hint(d, ctx, to.chat.id, inbound!, inbound);
    const other = p.status === "held" && !hintedBy && elsewhere(state, ctx, d, q, to.bot, target(state, to.bot, to.chat, ctx));
    if (other) {
      place(q, other, null);
      const note = `${chatName(state, ctx, to.chat)}那边有 ${ref} 的回复在等你，在那边回任意一个字就能收到。`;
      hintedBy = outbound(d, ctx, { chat: other.chat.id, replyTo: null, trace: inbound, text: note, hint: true });
    }
    const held = p.status === "held" ? { hintedBy } : {};
    outbound(d, ctx, { chat: to.chat.id, replyTo: p.replyTo, trace: inbound, text, markdown: md, status: p.status, ...held });
  }
}

/** QQ refused a passive reply for its quota: that message has none left, and the same message goes
 *  out as an active one, or waits for your next message. An active message refused goes through
 *  another bot; for its quota, the bot has none left this period (product §5.5). */
function refused(state: State, r: Extract<Input, { kind: "refused" }>, ctx: Ctx): Decision {
  const d = nothing();
  const to = toChat(state, r.chat, ctx);
  if (!to) return d;
  const qq = to.caps?.sendLimit.kind === "qq_quota";
  if (r.inbound === null || !qq) {
    // An active message on QQ, refused for its quota: the bot has none left; for another reason
    // (you turned them off, say), the next still tries QQ. Or another platform out of its quota
    // (Feishu's month). Another bot's chat with you takes it, led by where it was for; with none, it
    // stays failed (product §5.5). So does one moved already: two Feishu bots share their
    // organization's quota, and it would go back and forth.
    if (qq && r.quota) d.writes.push({ op: "update", table: "quota", where: { kind: "qq_active", owner: to.bot.id }, patch: { used: ctx.config.limits.qqActive } });
    const q = quotas(state, ctx, d);
    const p = JSON.parse(r.payload) as Payload;
    const other = !p.moved && elsewhere(state, ctx, d, q, to.bot, target(state, to.bot, to.chat, ctx));
    if (!other) return unsaid(state, ctx, d, p);
    place(q, other, null);
    // ponytail: the lead may take the text past the other platform's limit; cut it up once that bites.
    const lead = `${chatName(state, ctx, to.chat)}那边发不出去，改发在这里。`;
    const text = `${lead}\n\n${p.text}`;
    const payload = { ...p, text, moved: true, ...(p.markdown !== undefined && { markdown: markdown(text, other.caps) }) };
    d.writes.push({ op: "update", table: "outbound", where: { id: r.outbound, status: "failed" }, patch: { chat: other.chat.id, status: "pending", replyTo: null, payload: JSON.stringify(payload) } });
    // What you type there answers the ask it carries.
    if (p.ask) d.writes.push({ op: "update", table: "ask", where: { id: p.ask }, patch: { forwardedTo: other.chat.id } });
    // A turn's message (an edit platform's): the turn edits it there from now on, the lead kept on top.
    const conv = state.conversations.find((c) => progressOf(c.progress)?.live === r.outbound);
    const once = other.caps?.progress === "edit" ? {} : { once: p.text };
    if (conv) d.writes.push({ op: "update", table: "conversation", where: { id: conv.id }, patch: { progress: JSON.stringify({ ...progressOf(conv.progress), lead: { on: r.outbound, text: lead, ...once } }) } });
    d.effects.push({ kind: "send", outbound: r.outbound });
    return d;
  }
  const patch = { used: ctx.config.limits.qqPassiveReplies };
  d.writes.push({ op: "update", table: "quota", where: { kind: "qq_passive", owner: r.inbound }, patch });
  // ponytail: a refused progress segment goes active too, keeping the text whole at the cost of an
  // active message; only a passive count Rhodium got wrong, or two replies sharing a msg_seq, gets here.
  const p = place(quotas(state, ctx, d), to, null);
  d.writes.push({ op: "update", table: "outbound", where: { id: r.outbound, status: "failed" }, patch: { status: p.status, replyTo: null } });
  if (p.status === "pending") d.effects.push({ kind: "send", outbound: r.outbound });
  return d;
}

/** One of rh send's messages to you did not go out: the marks it set on its slot's turn go. A child's
 *  report then says it told you nothing; the turn's chat gets what the agent says again (lift()).
 *  One failing after its turn, say held for QQ's quota, leaves the next turn's marks alone. */
function unsaid(state: State, ctx: Ctx, d: Decision, p: Payload): Decision {
  const slot = p.said && state.slots.find((s) => s.id === p.said!.slot);
  if (!slot || slot.turnStartedAt !== p.said!.at) return d;
  // ponytail: clears the turn's marks even when an earlier rh send this turn went out, so you may get
  // the agent's words twice; record which sends went out in each turn if that extra copy bites.
  if (p.said!.toldYou && slot.turnToldYou) d.writes.push({ op: "update", table: "slot", where: { id: slot.id }, patch: { turnToldYou: null } });
  if (p.said!.sentMe) lift(state, ctx, d, slot);
  return d;
}

/** An edit that did not take goes as a new message instead (architecture §8.2). A turn still showing
 *  in the old message edits the new one from then on; the turn's last text goes all the same, and so
 *  does the last of a message the turn moved on from; an older edit of one it replaced goes nowhere. */
function editFailed(state: State, e: Extract<Input, { kind: "edit_failed" }>, ctx: Ctx): Decision {
  const d = nothing();
  // A chat that can't edit, which a turn's message went to through another bot (refused()): only the
  // turn's last text goes there, not a new message each time the turn moves on.
  if (!e.final && toChat(state, e.chat, ctx)?.caps?.progress !== "edit") return d;
  const turn = (c: Conversation) => progressOf(c.progress);
  const conv = state.conversations.find((c) => turn(c)?.live === e.outbound);
  if (!conv && !e.final && !state.conversations.some((c) => turn(c)?.left?.includes(e.outbound))) return d;
  const live = outbound(d, ctx, { chat: e.chat, replyTo: null, trace: e.trace, text: e.text, markdown: e.markdown });
  if (conv) d.writes.push({ op: "update", table: "conversation", where: { id: conv.id }, patch: { progress: JSON.stringify({ ...turn(conv), live, shown: e.text }) } });
  return d;
}

/** Your message in a chat with held messages brings them, on the passive replies it comes with.
 *  What still waits then names the hint this round sent, if any: the old one has had its answer. */
function releaseHeld(state: State, ctx: Ctx, d: Decision, to: To, held: Outbound[], inbound: string): void {
  const q = quotas(state, ctx, d);
  let hintedBy: string | undefined;
  held.forEach((o, i) => {
    // The last one may take the reply kept for the hint; so may the first, when nothing else
    // would go out: a hint you'd just answer again brings nothing.
    const p = place(q, to, inbound, i === held.length - 1 || (i === 0 && q.active(to.bot.id) === 0));
    if (p.hint) hintedBy = hint(d, ctx, to.chat.id, inbound, o.trace);
    // The message stays as it was, the ask it carries too.
    const message = payload(o);
    const patch: Patch<Outbound> =
      p.status === "held"
        ? { payload: JSON.stringify({ ...message, hintedBy }) }
        : { status: "pending", replyTo: p.replyTo, payload: JSON.stringify({ ...message, hintedBy: undefined, released: true }) };
    d.writes.push({ op: "update", table: "outbound", where: { id: o.id, status: "held" }, patch });
    if (p.status === "pending") d.effects.push({ kind: "send", outbound: o.id });
  });
}

// Names end up in commands typed on a phone: letters and digits of any script, plus _ . -
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;
/** A bot's name is a bare TOML key, so rh bot writes [bots.<name>] as it is. */
const BOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const MODE: Record<Slot["mode"], string> = { headless: "无头", tui: "TUI" };
const LIFETIME: Record<Slot["lifetime"], string> = { oneoff: "一次性", longterm: "长期" };
// Product §4's names.
export const STATE: Record<Slot["state"], string> = {
  off: "未运行",
  starting: "启动中",
  idle: "空闲",
  running: "运行中",
  waiting: "需要你",
  rate_limited: "等额度",
  crashed: "崩溃",
};

type RhInput = Extract<Input, { kind: "rh" }>;

/** Who called rh (docs/spec/v1.md "rh 怎么认出调用者"). via: you agreed to this caller's confirm request.
 *  im: you, typing a /rh_ command in chat rather than at a terminal, where the reply speaks of "这里".
 *  board: you, on the board, where the reply names its buttons, not a command (spec web-write). */
type Caller = { kind: "slot"; slot: Slot } | { kind: "you"; via?: string; im?: Chat; board?: true } | { kind: "unknown" };
/** Whether a reply to who names commands to type at a terminal, not IM's or the board's buttons. */
const typing = (who: Caller) => !(who.kind === "you" && (who.im || who.board));
const UNKNOWN = "认不出是谁在调用 rh：它不在 Rhodium 的槽位里，也不是从终端调用的。";

/** In order: the slot whose token rh carries, the slot whose holder unit it runs in, the TUI slot
 *  whose pane agent is rh or one of its ancestors, then you at a terminal; anyone else is unknown. */
function caller(state: State, c: RhCaller): Caller {
  let slot = c.token ? state.slots.find((s) => s.token === c.token) : undefined;
  if (!slot && c.unit) {
    const conversation = state.holders.find((h) => h.unit === c.unit)?.conversation;
    const id = state.conversations.find((cv) => cv.id === conversation)?.slot;
    slot = state.slots.find((s) => s.id === id);
  }
  // Its start time with it, so a process that got the pid of an agent long gone is no match.
  slot ??= state.slots.find((s) => s.mode === "tui" && s.tuiPid !== null && c.ancestors?.includes(`${s.tuiPid}:${s.tuiStart}`));
  if (slot) return { kind: "slot", slot };
  return { kind: c.tty ? "you" : "unknown" };
}

/** The reply's text, or null when an effect replies once it is done. */
function rh(state: State, input: RhInput, who: Caller, ctx: Ctx, d: Decision): string | null | { text: string; buttons?: Button[] } {
  const [name, ...rest] = input.argv;
  const def = COMMANDS.find((c) => c.name === name);
  if (!def) refuse(`不认识的命令：${name ?? "（空）"}。看 rh --help。`);
  let args: { values: Record<string, string | undefined>; positionals: string[] };
  try {
    // rh send's text is taken as it is, so it may start with "-", like a list item.
    args =
      def.name === "send"
        ? { values: {}, positionals: rest }
        : (parseArgs({ args: rest, options: def.options ?? {}, allowPositionals: true, strict: true }) as typeof args);
  } catch (err) {
    throw new Usage(`参数不对：${(err as Error).message}\n用法：rh ${def.name} ${def.usage}`);
  }
  const { values, positionals: pos } = args;
  const all = (values as { all?: boolean }).all === true; // rh ls --all, rh stop --all
  const brake = def.name === "stop" && all;
  const { add, rm, list } = values as { add?: boolean; rm?: string; list?: boolean }; // rh pair's
  // rh pair with none of them puts the account that sends its code in place of every paired owner.
  const replace = def.name === "pair" && !add && rm === undefined && !list;
  const usage = (): never => {
    throw new Usage(`用法：rh ${def.name} ${def.usage}`);
  };
  const dir = (p: string) => resolve(input.caller.cwd, p);

  // Product §6.2. These guard against mistakes, not malice (architecture §11).
  if (who.kind !== "you") {
    if (def.who === "you" || brake || replace) {
      const cmd = replace ? "不带参数的 rh pair" : `rh ${def.name}${brake ? " --all" : ""}`;
      refuse(`${cmd} 只有用户本人能用` + (who.kind === "slot" ? "，agent 调用一律拒绝。" : `。${UNKNOWN}`));
    }
    const reads = def.readOnly === true || (def.readOnly === "bare" && pos.length === 0) || (def.readOnly === "list" && !!list);
    // An agent may stop, archive or switch its own slot and its descendants; a caller rh cannot
    // recognize may only read. Anything else needs your say-so.
    const of = who.kind === "slot" && (def.confirm === true || def.confirm === "always") && pos[0] !== undefined ? slotByRef(state, pos[0]) : undefined;
    if ((who.kind === "unknown" && !reads) || (of && who.kind === "slot" && !descends(state, of, who.slot))) return confirm(state, input, who, ctx, d);
    if (who.kind === "slot" && def.confirm === "some" && needsYou(state, ctx, def.name, pos, rm, who.slot)) return confirm(state, input, who, ctx, d);
  }

  switch (def.name) {
    case "doctor": {
      if (pos.length) usage();
      d.effects.push({ kind: "doctor", id: input.id });
      return null;
    }

    case "trace": {
      if (pos.length !== 1) usage();
      d.effects.push({ kind: "trace", id: input.id, message: pos[0]! });
      return null;
    }

    case "ws": {
      if (pos.length === 0) {
        if (!state.workspaces.length) return "还没有工作区。用 rh ws <名字> <目录> 新建。";
        return table(state.workspaces.map((w) => [w.name, w.dir]));
      }
      if (pos.length !== 2) usage();
      const [wsName, wsDir] = pos as [string, string];
      if (!NAME.test(wsName)) refuse(`工作区名字只能由文字、数字和 _ . - 组成，不超过 64 个字符：${wsName}`);
      if (state.workspaces.some((w) => w.name === wsName)) refuse(`已经有工作区 ${wsName}。`);
      const row = { id: ctx.newId(), name: wsName, dir: dir(wsDir) };
      d.writes.push({ op: "insert", table: "workspace", row });
      d.events.push({ source: "rh", type: "workspace_created", data: { name: row.name, dir: row.dir } });
      return `已建工作区 ${row.name}，默认目录 ${row.dir}`;
    }

    case "new": {
      if (pos.length !== 1) usage();
      const [wsName, slotName] = splitRef(pos[0]!);
      const ws = state.workspaces.find((w) => w.name === wsName);
      if (!ws) refuse(`没有工作区 ${wsName}。先用 rh ws ${wsName} <目录> 建一个。`);
      const agent = agentKind(values.agent);
      const slotDir = values.dir === undefined ? ws.dir : dir(values.dir);
      diskRoom(state, ctx, who, `新建槽位 ${pos[0]}`);
      const slot = addSlot(state, ctx, d, { workspace: ws, name: slotName, dir: slotDir, agent, state: "off", lifetime: "longterm" });
      d.events.push({ source: "rh", type: "slot_created", slot: slot.id, data: { ref: pos[0], dir: slotDir, agent } });
      return `已建槽位 ${pos[0]}：${agent}，无头，目录 ${slotDir}`;
    }

    case "spawn": {
      // Product §6.1: the child lands in the workspace whose default dir is the dir, made if there is none.
      const [name, ...words] = pos;
      const task = words.join(" ");
      if (name === undefined || !task.trim()) return usage();
      if (!NAME.test(name)) refuse(`槽位名字只能由文字、数字和 _ . - 组成，不超过 64 个字符：${name}`);
      const agent = agentKind(values.agent);
      const childDir = dir(values.dir ?? ".");
      const parent = who.kind === "slot" ? who.slot : null;
      if (parent) spawnLimits(state, ctx, parent);
      diskRoom(state, ctx, who, `派生 ${name}`);
      const ws = workspaceFor(state, ctx, d, childDir, "rh");
      const lifetime = (values as { longterm?: boolean }).longterm ? "longterm" : "oneoff";
      // The task is the child's first message, so the child starts at once.
      const child = addSlot(state, ctx, d, { workspace: ws, name, dir: childDir, agent, state: "starting", lifetime, parent: parent?.id ?? null });
      d.writes.push({
        op: "insert",
        table: "agentInput",
        row: { id: ctx.newId(), conversation: child.conversation, source: "rh", status: "queued", body: task, trace: input.id },
      });
      d.effects.push({ kind: "start", slot: child.id });
      const ref = `${ws.name}/${name}`;
      d.events.push({ source: "rh", type: "slot_spawned", trace: input.id, slot: child.id, data: { ref, dir: childDir, agent, lifetime, parent: parent?.id ?? null } });
      return `已派生 ${ref}：${agent}，${LIFETIME[lifetime]}，目录 ${childDir}。任务已发给它。`;
    }

    case "set": {
      if (pos.length < 2) usage();
      const s = findSlot(state, pos[0]!);
      const patch: Patch<Slot> = {};
      for (const item of pos.slice(1)) {
        const eq = item.indexOf("=");
        const key = item.slice(0, eq);
        // Not in SETTINGS, as it has no default to go back to: one-off or long-term (product §6.1).
        if (key === "lifetime") {
          const v = item.slice(eq + 1);
          if (v !== "longterm" && v !== "oneoff") refuse(`lifetime 的值不对：${v}。取 longterm（长期）或 oneoff（一次性）。`);
          patch.lifetime = v;
          continue;
        }
        if (eq < 0 || !Object.hasOwn(SETTINGS, key)) {
          refuse(`不认识的设置项：${item}。可用：${Object.keys(SETTINGS).join("、")}、lifetime，写成 <设置>=<值>。`);
        }
        const value = parseSetting(key as SettingKey, item.slice(eq + 1));
        if (value === undefined) {
          const kind = SETTINGS[key as SettingKey].kind;
          refuse(`${key} 的值不对：${item.slice(eq + 1)}。` + (kind === "flag" ? "取 on、off 或 default。" : "写成 30s、10m、1h、7d，或 0（从不）、off、default。"));
        }
        patch[COLUMN[key as SettingKey]] = value as never;
      }
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch });
      d.events.push({ source: "rh", type: "slot_settings", slot: s.id, data: patch });
      // A crash resume still waiting for room would resume what crashed. With the approval mode
      // changed since, it is dropped, and the slot waits for your message (product §4.5). So would a
      // change of the slot's directory, which no command makes in v1.
      const mode = (v: Slot["approval"]) => Boolean(v ?? ctx.config.defaults.approval);
      const resume = state.queued.filter((i) => i.conversation === s.conversation && resumeWaits(i));
      const dropped = patch.approval !== undefined && mode(patch.approval) !== mode(s.approval) && resume.length > 0;
      for (const i of dropped ? resume : []) d.writes.push({ op: "delete", table: "agentInput", where: { id: i.id } });
      // A running agent switches now (product §4.8); one not running starts in the new mode.
      const kind = s.conversation ? state.conversations.find((c) => c.id === s.conversation)?.agent : undefined;
      if (patch.approval !== undefined && s.conversation && s.state !== "off" && s.state !== "crashed") {
        if (kind && !AGENTS[kind].liveApproval) {
          // pi can't switch while it runs: it goes once idle, now if it is (architecture §6.3).
          if (s.state === "idle") stop(s, d);
          else d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { approvalStale: 1 } });
        } else {
          // One still starting switches once it runs (runner), as it may have launched in the old mode.
          d.effects.push({ kind: "approval", conversation: s.conversation, on: Boolean(patch.approval ?? ctx.config.defaults.approval) });
        }
      }
      // A new reap time holds for a slot idle now too, counted from its turn's end: the clock looks again now.
      if (patch.reapAfter !== undefined) d.effects.push({ kind: "timer", timer: "idle_reap", key: s.id, at: ctx.now });
      // A slot made one-off is archived once idle for the archive time, counted from its last turn's
      // end: the clock looks again now. One made long-term the clock lets be.
      if (patch.lifetime !== undefined) d.effects.push({ kind: "timer", timer: "oneoff_archive", key: s.id, at: ctx.now });
      // A new ask timeout holds for the asks open now too, counted from now: 0 lets them wait for you.
      if (patch.askTimeout !== undefined) {
        const timeout = patch.askTimeout ?? ctx.config.durations.askTimeout;
        for (const a of openAsks(state, s)) {
          const deadline = timeout ? ctx.now + timeout : null;
          d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch: { deadline } });
          d.effects.push({ kind: "timer", timer: "ask_timeout", key: a.id, at: deadline });
        }
      }
      // Codex's turn under way keeps the old mode (product §4.8).
      const later = kind && AGENTS[kind].liveApproval === "next turn" && patch.approval !== undefined && mode(patch.approval) !== mode(s.approval) && (s.state === "running" || s.state === "waiting");
      return [
        `已改 ${pos[0]}。`,
        `生命周期: ${LIFETIME[patch.lifetime ?? s.lifetime]}`,
        ...settingLines({ ...s, ...patch }, ctx.config),
        ...(dropped ? ["崩溃后改了审批模式：不再自动恢复这段对话，等你发消息。"] : []),
        ...(later ? [`${AGENTS[kind].name} 从下一个回合起按新设置跑。`] : []),
      ].join("\n");
    }

    case "stop": {
      if (all) {
        if (pos.length) usage();
        // The emergency stop (product §10): the stopped slots' exits make room, but no wake waiting
        // for it starts a slot. Each waits for its slot's next start instead.
        d.writes.push({ op: "update", table: "agentInput", where: { status: "queued", queueReason: MAX_RUNNING }, patch: { queueReason: null } });
        const stopped = state.slots.filter((s) => stop(s, d, "rh", true));
        // Your messages queued for them come back to you: their next start may be long after.
        for (const s of stopped) giveBack(state, ctx, d, "rh", s, "急停了", "需要的话再发一遍");
        const refs = stopped.map((s) => slotView(state, s).ref);
        return refs.length ? `正在停止 ${refs.length} 个槽位：${refs.join("、")}。对话都保留。` : "没有在运行的 agent。";
      }
      if (pos.length !== 1) usage();
      const s = findSlot(state, pos[0]!);
      const ref = slotView(state, s).ref; // the board names it by its id
      return stop(s, d) ? `正在停止 ${ref}，对话保留。` : `${ref} 没在运行。`;
    }

    // Product §4.7: the agent kind belongs to the conversation, so a new agent means a new conversation.
    // As rh tui, a turn under way ends first (with !, cut short); its end switches the slot (agent()).
    case "agent": {
      if (pos.length < 2 || pos.length > 3 || (pos[2] !== undefined && !/^[!！]$/.test(pos[2]))) usage();
      const s = findSlot(state, pos[0]!);
      const agent = agentKind(pos[1]);
      const ref = slotView(state, s).ref;
      if (s.mode === "tui") refuse(`${ref} 在 TUI 里，切回无头后再换 agent。`);
      // The agent it has already: nothing to do, but a switch waiting for the turn is called off
      // (docs/im-style.md §9.1). /new is for a new conversation.
      if (agent === agentOf(state, s)) {
        if (s.nextAgent === null) return `${ref} 本来就是 ${AGENTS[agent].name}，没有改动。`;
        d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { nextAgent: null } });
        return `${ref} 不换成 ${AGENTS[s.nextAgent].name} 了，还是 ${AGENTS[agent].name}。`;
      }
      const turn = (s.state === "starting" || s.state === "running" || s.state === "waiting") && !stopping(state, s.conversation!);
      // Still starting, there is no turn to cut short yet, as for /stop (common()).
      if (pos[2] !== undefined && s.state === "starting") refuse(`${ref} 还在启动，过几秒再发 /rh_agent ${agent} !。`);
      if (!turn) {
        d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: newConversation(state, d, ctx, s, agent) });
        d.events.push({ source: "rh", type: "slot_agent", slot: s.id, data: { agent } });
        return `已把 ${ref} 换成 ${agent}，下一条消息开始一段新对话。`;
      }
      const patch: Patch<Slot> = { nextAgent: agent };
      // In IM, a button cuts the turn short; elsewhere, rh agent <slot> <agent> ! does.
      let text = `${ref} 这一回合还没跑完，跑完就换成 ${agent}，下一条消息开始新对话。` + (typing(who) ? `要马上换，加 !：rh agent ${ref} ${agent} !` : "");
      let buttons: Button[] | undefined = [{ label: "打断，马上换", data: `/rh_agent ${agent} !` }];
      if (pos[2] !== undefined) {
        // As /stop: the turn cut short sends no final reply, and what you send meanwhile starts the new agent.
        if (s.interruptedAt === null) {
          interrupt(d, ctx, patch, s.conversation!);
          Object.assign(patch, { turnChat: null, turnInbound: null });
        }
        text = `已打断 ${ref} 这一回合，停下就换成 ${agent}，下一条消息开始新对话。`;
        buttons = undefined;
      }
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch });
      d.events.push({ source: "rh", type: "agent_switch", trace: input.id, slot: s.id, data: { agent, interrupt: pos[2] !== undefined } });
      return buttons ? { text, buttons } : text;
    }

    // Architecture §10.1: the headless agent goes first, once its turn is over (with !, cut short);
    // its exit opens the pane (agent()). From now on IM messages to the slot are turned away (im()).
    case "tui": {
      if (pos.length < 1 || pos.length > 2 || (pos[1] !== undefined && !/^[!！]$/.test(pos[1]))) usage();
      const s = findSlot(state, pos[0]!);
      const ref = slotView(state, s).ref;
      // Telegram's row has no 切回无头 (docs/im-style.md §6.3): here it is.
      if (s.herdrPane !== null) return { text: `${ref} 已经在 TUI 里了。`, buttons: [{ label: "切回无头", data: `/rh_release ${Buffer.byteLength(`/rh_release ${ref}`) <= 64 ? ref : s.id}` }] };
      // Before anything stops: no switch can go through (product §4.2).
      if (!ctx.herdr()) refuse(`没装 Herdr，${ref} 切不到 TUI。`);
      if (s.nextAgent !== null) refuse(`${ref} 在等这一回合结束换成 ${s.nextAgent}，换完再切到 TUI。`);
      const conv = state.conversations.find((c) => c.id === s.conversation)!;
      // A turn under way gets the session written before it ends; a slot with none yet starts one in
      // the terminal (stories 544, 545).
      const turn = (s.state === "starting" || s.state === "running" || s.state === "waiting") && !stopping(state, conv.id);
      // Still starting, there is no turn to cut short yet, as for /stop (common()).
      if (pos[1] !== undefined && s.state === "starting") refuse(`${ref} 还在启动，过几秒再发 /rh_tui !。`);
      const cut = turn && pos[1] !== undefined;
      // On its way already: only a ! is news, cutting short the turn the switch waits for (story 105).
      if (s.mode === "tui" && !cut) return `${ref} 正在切到 TUI…`;
      // You asked from IM or the board: you will be at the terminal next, so the pane gets Herdr's focus
      // once open (Herdr bridge), as the board's own button says (spec web-write).
      const patch: Patch<Slot> = { mode: "tui", tuiFocus: who.kind === "you" && (who.im || who.board) ? 1 : null };
      // How it went comes to the chat you asked in, or to the board alone unless it failed (switched()),
      // unless an agent waits to hear it.
      if (who.kind === "you" && (who.im || who.board) && !s.switchDecision) patch.switchDecision = JSON.stringify(who.im ? { chat: who.im.id } : { board: true });
      let text = `正在把 ${ref} 切到 TUI…`;
      // In IM, a button cuts the turn short; elsewhere, rh tui <slot> ! does.
      let buttons: Button[] | undefined;
      if (cut) {
        if (s.interruptedAt === null) interrupt(d, ctx, patch, conv.id);
        text = `已打断 ${ref} 这一回合，停下就切到 TUI。`;
      } else if (turn) {
        text = `${ref} 这一回合还没跑完，跑完就切到 TUI。` + (typing(who) ? `要马上切，加 !：rh tui ${ref} !` : "");
        buttons = [{ label: "打断，马上切", data: `/rh_tui ${ref} !` }];
      } else if (s.state !== "off" && s.state !== "crashed") {
        if (!stopping(state, conv.id)) stopAgent(d, conv.id);
      } else d.effects.push({ kind: "tui_open", slot: s.id });
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch });
      d.events.push({ source: "rh", type: "tui_switch", trace: input.id, slot: s.id, data: { interrupt: pos[1] !== undefined } });
      return buttons ? { text, buttons } : text;
    }

    // Architecture §10.1: it ends the agent in your terminal, so you confirm it first, unless you ask
    // from a terminal yourself: a slip of the thumb on /rh_release would end what you work on there.
    // Then the Herdr bridge ends it, and switches the slot back as when you quit it yourself.
    case "release": {
      if (pos.length !== 1) usage();
      const s = findSlot(state, pos[0]!);
      const ref = slotView(state, s).ref;
      if (s.mode !== "tui") return `${ref} 不在 TUI 里。`;
      if (s.herdrPane === null) refuse(`${ref} 正在切到 TUI，切过去之后才能切回。`);
      // An agent's or an unknown caller's request is made by confirm(), which tries it as yours first.
      if (who.kind !== "you") return confirm(state, input, who, ctx, d);
      if (who.im) {
        const p: ConfirmInput = { argv: input.argv, cwd: input.caller.cwd, caller: null, from: "" };
        addAsk(state, ctx, d, s, { kind: "confirm", requestId: null, tool: "rh", input: p }, false, who.im);
        // In IM the ask says it all (docs/im-style.md §5.2).
        return who.im ? null : `已请你确认：rh release ${ref}。`;
      }
      d.effects.push({ kind: "tui_back", slot: s.id, force: true });
      if (who.board && !s.switchDecision) d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { switchDecision: JSON.stringify({ board: true }) } });
      d.events.push({ source: "rh", type: "tui_release", trace: input.id, slot: s.id });
      return `正在把 ${ref} 切回无头…`;
    }

    // Product §4.3: a conversation Rhodium did not start becomes a slot once it is found and no one
    // else uses it (imported()).
    case "import": {
      if (pos.length > 1) usage();
      const what = pos[0];
      if (what === undefined) {
        d.effects.push({ kind: "import", id: input.id, what: { dir: dir(values.dir ?? ".") } });
        return null;
      }
      if (values.name !== undefined && !NAME.test(values.name)) refuse(`槽位名字只能由文字、数字和 _ . - 组成，不超过 64 个字符：${values.name}`);
      // Herdr's pane ids are "<workspace>:<pane>"; session ids are UUIDs, looked up by glob.
      const pane = what.includes(":");
      if (!pane && !/^[0-9a-f-]+$/i.test(what)) refuse(`看不懂 ${what}：写对话 ID（或它的开头），或 Herdr 的 pane ID，例如 w1:p1。`);
      d.effects.push({ kind: "import", id: input.id, name: values.name, what: pane ? { pane: what } : { session: what } });
      return null;
    }

    // Product §5.2: a chat's own target overrides its bot's default; - drops it.
    case "use": {
      if (pos.length !== 2) usage();
      const [botRef, platformChatId] = splitChat(pos[0]!) ?? usage();
      const bot = findBot(state, botRef);
      const s = pos[1] === "-" ? null : findTarget(state, pos[1]!);
      const chat = state.chats.find((c) => c.bot === bot.id && c.platformChatId === platformChatId);
      const here = who.kind === "you" ? who.im : undefined;
      // One not on record, going back to its bot's default, has nothing to change.
      if (chat || s) rebind(state, ctx, d, [[chat ?? { id: ctx.newId(), bot: bot.id, platformChatId, machine: "", target: null, panel: null, verbose: null, contactedAt: null }, s]], [], here);
      // In IM the chat is 这里; elsewhere its name, never its id (docs/im-style.md §2.6, architecture §11).
      const name = chatName(state, ctx, { bot: bot.id, platformChatId });
      if (s) return `${here ? "这里的" : `${name}的`}消息改交给 ${slotView(state, s).ref}。`;
      const now = target(state, bot, undefined, ctx);
      if (here) return now ? `这里改回默认，消息交给 ${slotView(state, now).ref}。` : "这里改回默认，可这个 Bot 还没有默认槽位，发 /rh_bind 指一个。";
      return now ? `${name}的消息改回 Bot ${bot.name} 的默认槽位 ${slotView(state, now).ref}。` : `${name}的消息改回 Bot ${bot.name} 的默认槽位，可它还没有默认槽位。`;
    }

    case "bind": {
      if (pos.length !== 2) usage();
      const bot = findBot(state, pos[0]!);
      const s = findTarget(state, pos[1]!);
      rebind(state, ctx, d, [], [[bot, s]], who.kind === "you" ? who.im : undefined);
      return `${who.kind === "you" && who.im ? "这个 Bot" : `Bot ${bot.name}`} 的默认槽位改成 ${slotView(state, s).ref}。单独选过槽位的窗口不受影响。`;
    }

    // Product §5.11. rh asks twice: first with no credentials, so a wrong name or slot shows before
    // you scan or paste anything; then with what the scan or paste gave, to write the bot in.
    case "bot": {
      if (pos.length < 2 || pos.length > 3) usage();
      const [name, platform, ref] = pos as [string, string, string?];
      if (!BOT_NAME.test(name)) refuse(`Bot 名字只能由英文字母、数字和 _ - 组成，不超过 64 个字符：${name}`);
      if (TO_YOU.includes(name)) refuse(`Bot 不能叫 ${name}：rh send ${name} 另有用处。`);
      if (!Object.hasOwn(MADE, platform)) refuse(`平台只能是 ${series(Object.keys(MADE), "或")}：${platform}`);
      const how = MADE[platform as Made];
      if (state.bots.some((b) => b.name === name) || Object.hasOwn(ctx.config.bots, name)) refuse(`已经有 Bot ${name}。`);
      const apiRoot = values["api-root"];
      // The platforms that take it, by label: Telegram 和飞书.
      const only = (takes: (b: BotDef) => unknown) => amid(series((Object.keys(MADE) as Made[]).filter((p) => takes(MADE[p])).map((p) => PLATFORMS[p].label), "和")).trimEnd();
      if (apiRoot !== undefined && !how.apiRoot) refuse(`--api-root 只用于${only((b) => b.apiRoot)}。`);
      if (values.paste && !how.paste) refuse(`--paste 只用于${only((b) => b.paste)}。`);
      const main = ctx.config.mainChat && state.bots.find((b) => b.name === ctx.config.mainChat!.bot);
      const slot =
        (ref === undefined ? main && target(state, main, undefined, ctx) : findTarget(state, ref)) ??
        refuse(`没有主 Bot 的默认目标可以照搬。写明绑定到哪个槽位：rh bot ${name} ${platform} <工作区/槽位>`);
      const bound = slotView(state, slot).ref;
      const creds = input.credentials;
      if (!creds) return `建${amid(PLATFORMS[platform as Made].label).trimEnd()} Bot ${name}，建完绑定到 ${bound}。`;
      // Only the keys the platform's credentials have, so they cannot stand in for platform or target.
      const { needed, optional } = how;
      const keys = Object.keys(creds);
      if (!needed.every((k) => creds[k]) || !keys.every((k) => needed.includes(k) || optional.includes(k))) {
        refuse(`Bot ${name} 的凭据不对：要有 ${needed.join(" 和 ")}。`);
      }
      // A bot already in use here: a second connection to it would push the first off, and back; on
      // Feishu, each message goes to one of the two at random.
      const key = needed[0]!;
      const twin = Object.keys(ctx.config.bots).find((b) => ctx.config.bots[b]![key] === creds[key]);
      if (twin) refuse(`配置里已经有这个 Bot 了，叫 ${twin}。要再建一个，${how.another}。`);
      d.effects.push({ kind: "add_bot", id: input.id, name, table: { platform, ...creds, ...(apiRoot !== undefined && { apiRoot }), target: bound } });
      return `已把 Bot ${name} 写进配置文件并启用，绑定到 ${bound}。`;
    }

    case "pair": {
      if (pos.length !== 1 || Number(!!add) + Number(rm !== undefined) + Number(!!list) > 1) usage();
      const bot = state.bots.find((b) => b.name === pos[0]) ?? refuse(`没有 Bot ${pos[0]}。`);
      // The config's owners are its, whatever pairing does (product §5.11).
      const fixed = fixedOwners(ctx.config.bots[bot.name]);
      if (list) {
        const all = owners(bot, ctx.config);
        // Where each owner's private chat goes, to tell your accounts apart by (architecture §9.9).
        const goes = (o: string) => {
          const chat = state.chats.find((c) => c.bot === bot.id && c.platformChatId === o);
          const s = chat && target(state, bot, chat, ctx);
          return s ? `：私聊交给 ${slotView(state, s).ref}` : "";
        };
        return all.length ? [`Bot ${bot.name} 的主人：`, ...all.map((o) => `${o}${fixed.includes(o) ? "（配置）" : ""}${goes(o)}`)].join("\n") : `Bot ${bot.name} 还没配对。`;
      }
      if (rm !== undefined) {
        if (fixed.includes(rm)) refuse(`${rm} 是 Bot ${bot.name} 配置里写的主人，以配置为准。要去掉，改配置文件里的 owner。`);
        if (!paired(bot).includes(rm)) refuse(`${rm} 不是 Bot ${bot.name} 的主人。`);
        d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { owners: JSON.stringify(paired(bot).filter((o) => o !== rm)) } });
        d.events.push({ source: "rh", type: "bot_owner_removed", data: { bot: bot.name } });
        // No account: agreed to an unknown caller's request, this goes to IM (docs/im-style.md §2.6).
        return `已去掉${amid(botName(ctx, bot))}的一个主人。`;
      }
      // A plain pairing replaces the paired owners, which can't stand in for the config's.
      if (!add && fixed.length) refuse(`Bot ${bot.name} 的配置里写了 owner，以配置为准。要换账号，改配置文件里的 owner。`);
      const code = ctx.newPairCode();
      const until = ctx.now + ctx.config.durations.pairCode;
      d.writes.push({ op: "update", table: "bot", where: { id: bot.id }, patch: { pairCode: code, pairUntil: until, pairAdd: add ? 1 : null } });
      d.events.push({ source: "rh", type: "pair_code", data: { bot: bot.name, until } }); // never the code itself
      // Not you at your terminal: the code goes to you in IM, never in rh's reply, which an agent led
      // astray might pass on (product §5.11). An unknown caller's, agreed, has no slot: the main chat.
      if (who.kind !== "you" || who.via !== undefined) {
        const from = who.kind === "slot" ? who.slot : undefined;
        const name = amid(botName(ctx, bot));
        const within = span(ctx.config.durations.pairCode);
        let to: Chat | undefined;
        const sent = tell(state, ctx, d, from, input.id, (caps, lead, at) => {
          to = at.chat;
          const say = `${from ? `${slotView(state, from).ref} ` : "有个认不出的程序"}要给${name}加一个主人。\n${within}内，用要加的那个账号私聊${name.trimEnd()}，发下一条里的码。只用你本人的账号。\n不想加就别理它。`;
          // On its own, to copy whole (docs/im-style.md §5.5).
          return [{ text: lead + say }, { text: code, markdown: markdown(`\`${code}\``, caps), secret: true }];
        });
        if (!sent) refuse("找不到发给用户的窗口：没有聊天窗口指着这个槽位，配置里也没写主窗口（mainChat）。配对码发不出去，没有换码。");
        // In the turn's chat, the turn goes on under the code (story 72).
        if (from?.turnChat === sent.chat) underIt(state, ctx, d, from);
        return `配对码已发到用户的${amid(chatName(state, ctx, to!)).trimEnd()}，${within}内有效。配上没有，用 rh pair ${bot.name} --list 看。`;
      }
      return [
        `配对码：${code}`,
        `${formatDuration(ctx.config.durations.pairCode)} 内，用你自己的账号在 IM 里私聊 Bot ${bot.name}，发这个码。发码的账号就是你，从此${add ? "它也" : "只有它"}能触发 agent。`,
        "只用你本人的账号：别人的号加进来，就违反了只有你本人能触发 agent。",
        ...(add ? ["发码的账号加为这个 Bot 的主人，原来的主人不变。"] : paired(bot).length ? ["这个 Bot 已经配对过，发码后原来配对的主人都去掉，换成新账号。"] : []),
        "码只能用一次。再运行 rh pair 会换一个新码，旧码作废。",
      ].join("\n");
    }

    case "send": {
      // To you (sendYou) by me, web, a platform's or a bot's name, any --file <path> right after it; to
      // a slot by its w/name or id. The rest is the text, as it is.
      const [to, ...rest] = pos;
      const you = to !== undefined && (TO_YOU.includes(to) || PLATFORM_WORDS.includes(to) || Object.hasOwn(ctx.config.bots, to));
      const paths: string[] = [];
      while (you && rest[0] === "--file") {
        if (rest[1] === undefined) usage();
        paths.push(dir(rest.splice(0, 2)[1]!));
      }
      const text = rest.join(" ");
      if (to === undefined || (!text.trim() && !paths.length)) usage();
      const from = who.kind === "slot" ? who.slot : undefined;
      if (!you) return sendTo(state, ctx, d, findSlot(state, to!), who, text, input.id);
      // A child you are not talking to hands its result up by report alone, so you hear it once, from
      // its parent (product §6.1); one sent where you asked for it goes. One in its terminal is talking
      // to you there, and reports nothing.
      if (to === "me" && from?.mode === "headless" && reportsUp(state, from))
        refuse(`rh send me 被拒绝：用户没在直接和你说话，结果会随汇报交给父槽位 ${slotView(state, parentOf(state, from)!).ref}，由它决定告诉用户什么。把结果和文件路径写进最终回复，不用再 rh send 给父槽位。`);
      if (to === "web" && !from) refuse("rh send web 只给槽位里的 agent 用：留在网页上的话显示在它的对话里。");
      return sendYou(state, ctx, d, input.id, from, to!, text, paths);
    }

    case "read": {
      if (pos.length !== 1) usage();
      const s = findSlot(state, pos[0]!);
      const conv = state.conversations.find((c) => c.id === s.conversation)!;
      d.effects.push({ kind: "read", id: input.id, text: slotDetail(state, s, ctx), dir: s.dir, agent: conv.agent, session: conv.sessionId });
      return null;
    }

    case "ls": {
      if (pos.length > 1) usage();
      if (pos.length === 1) return slotDetail(state, findSlot(state, pos[0]!), ctx);
      const shown = state.slots.filter((s) => all || s.archivedAt === null);
      if (!shown.length) return state.slots.length ? "没有未归档的槽位。rh ls --all 连已归档的也列出。" : "还没有槽位。用 rh new <工作区/槽位> 新建。";
      return table(
        shown.map((s) => {
          const view = slotView(state, s);
          return [view.ref, view.agent, MODE[s.mode], view.state, s.dir];
        }),
      );
    }

    // Issue #212: what goes to the slot goes by its id, but for a bot's target in the config file.
    case "rename": {
      if (pos.length !== 2) usage();
      const s = findSlot(state, pos[0]!);
      const name = pos[1]!;
      const from = slotView(state, s).ref;
      const ws = state.workspaces.find((w) => w.id === s.workspace)!;
      if (name === s.name) return `${from} 本来就叫 ${name}，没有改动。`;
      if (name.includes("/")) refuse(`只能在同一个工作区里改名，新名字只写槽位名，例如 rh rename ${from} ${name.slice(name.lastIndexOf("/") + 1)}。`);
      if (!NAME.test(name)) refuse(`槽位名字只能由文字、数字和 _ . - 组成，不超过 64 个字符：${name}`);
      if (state.slots.some((o) => o.workspace === s.workspace && o.name === name)) refuse(`工作区 ${ws.name} 里已经有槽位 ${name}。`);
      const to = `${ws.name}/${name}`;
      // Last of all, as it writes the file: a refusal after it would leave the file renamed alone.
      // ponytail: the store's transaction may still fail after it, which never happens in practice.
      let config: ReturnType<Ctx["retarget"]>;
      try {
        config = ctx.retarget(from, to);
      } catch (err) {
        refuse(`没有改名：配置文件改不了，${(err as Error).message}。`);
      }
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { name } });
      // A confirm request waiting for you names the slot as it was, as its object or its caller:
      // agreed, it goes to this slot still, and says who asked by the new name.
      for (const a of state.asks.filter((a) => a.kind === "confirm" && (a.status === "open" || a.status === "deferred"))) {
        const p = prompt(a);
        const c = p.input as ConfirmInput;
        if (c.argv[1] !== from && c.caller !== s.id) continue;
        const input = { ...c, argv: c.argv[1] === from ? [c.argv[0]!, to, ...c.argv.slice(2)] : c.argv, from: c.caller === s.id ? to : c.from };
        d.writes.push({ op: "update", table: "ask", where: { id: a.id }, patch: { prompt: JSON.stringify({ ...p, input }) } });
      }
      d.events.push({ source: "rh", type: "slot_renamed", slot: s.id, data: { from, to } });
      if (s.herdrTab !== null) d.effects.push({ kind: "tab_label", slot: s.id });
      const bots = config && `配置文件里 Bot ${config.bots.join("、")} 的 target 也跟着改了，改之前的备份在 ${config.backup}。`;
      return `已把 ${from} 改名为 ${to}。${bots || ""}`;
    }

    case "archive":
    case "unarchive": {
      if (pos.length !== 1) usage();
      const s = findSlot(state, pos[0]!);
      const ref = slotView(state, s).ref; // the board names it by its id
      const archive = def.name === "archive";
      if ((s.archivedAt !== null) === archive) return `${ref} ${archive ? "已经归档了" : "没有归档"}。`;
      // Archiving reaps the agent too; the conversation stays (GLOSSARY "归档").
      let where = "";
      if (archive) {
        notDefault(state, ctx, who, s, "归档");
        stop(s, d);
        where = unbind(state, ctx, d, s, who.kind === "you" ? who.im : undefined);
      }
      // Back from the archive, a one-off slot's clock starts over. A long-term slot keeps when its
      // turn ended, so the board shows it in the group it left (product §4). No chat points back at it.
      else if (s.lifetime === "oneoff") turnOver(d, ctx, s);
      d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: archive ? { archivedAt: ctx.now } : { archivedAt: null, activeAt: ctx.now } });
      d.events.push({ source: "rh", type: archive ? "slot_archived" : "slot_unarchived", slot: s.id });
      const back = who.kind === "you" && who.board ? "" : `rh unarchive ${ref} 恢复。`;
      return archive ? `已归档 ${ref}，对话保留。${back}${where && `\n${where}`}` : `已恢复 ${ref}。`;
    }

    // Architecture §9.9: Rhodium forgets its own record of the chat and of the messages in and out of
    // it; the account writing again comes back as a new chat. Its events and asks stay, as do the
    // config and the chat on the platform.
    case "forget": {
      if (pos.length !== 1) usage();
      const [botRef, id] = splitChat(pos[0]!) ?? usage();
      const bot = findBot(state, botRef);
      const chat = state.chats.find((c) => c.bot === bot.id && c.platformChatId === id) ?? refuse("Rhodium 没记着这个窗口。");
      // No id in these: agreed to an unknown caller's request, they go to IM (docs/im-style.md §2.6).
      // mainChat() would make the main chat again as soon as it is wanted.
      if (ctx.config.mainChat?.bot === bot.name && ctx.config.mainChat.chat === id) refuse("这是主窗口，不能忘掉。要换主窗口，改配置文件里的 mainChat。");
      if (state.slots.some((s) => s.turnChat === chat.id)) refuse("这个窗口开始的回合还在跑，等它跑完再忘掉。");
      if (state.asks.some((a) => a.status === "open" && a.forwardedTo === chat.id)) refuse("有推到这个窗口的提问还没答，先答掉，网页上也能答。");
      // A queued message knows its chat by its inbound message alone: with that gone, it would pass for the board's.
      if (Object.values(state.chatOf).includes(chat.id)) refuse("有从这个窗口发来的消息还在排队，等它交给 agent 再忘掉。");
      for (const i of ctx.inboundOf(chat.id)) d.writes.push({ op: "delete", table: "quota", where: { kind: "qq_passive", owner: i } });
      d.writes.push({ op: "delete", table: "outbound", where: { chat: chat.id } }, { op: "delete", table: "inbound", where: { chat: chat.id } }, { op: "delete", table: "chat", where: { id: chat.id } });
      d.events.push({ source: "rh", type: "chat_forgotten", data: { bot: bot.name } }); // no platform id (§11)
      d.effects.push({ kind: "forget_avatar", chat: chat.id });
      return `已忘掉${amid(botName(ctx, bot))}的一个${ownerChat(bot, chat, ctx) ? "私聊" : "聊天窗口"}。`;
    }

    // Architecture §9.8: Rhodium forgets its own records of the slot. Its children stay, their parent
    // gone (§9.4); its events stay, and its hold dirs go with the daily cleanup.
    case "rm": {
      if (pos.length !== 1) usage();
      const s = findSlot(state, pos[0]!);
      const ref = slotView(state, s).ref;
      if (s.archivedAt === null) refuse(`${ref} 没有归档，只能删除已归档的槽位。`);
      // Archiving only asks the agent to stop; in the terminal, it is off with its agent running there.
      if ((s.state !== "off" && s.state !== "crashed") || s.mode === "tui") refuse(`${ref} 的 agent 还没停，停了再删除。`);
      notDefault(state, ctx, who, s, "删除");
      unbind(state, ctx, d, s, undefined, "删除了");
      cancelAsks(d, state.asks.filter((a) => a.slot === s.id));
      // Not a row left: the router takes an ask's slot, and a conversation's, for one that is there.
      d.writes.push({ op: "delete", table: "ask", where: { slot: s.id } });
      for (const c of state.conversations.filter((c) => c.slot === s.id))
        d.writes.push({ op: "delete", table: "agentInput", where: { conversation: c.id } }, { op: "delete", table: "holder", where: { conversation: c.id } });
      d.writes.push({ op: "delete", table: "conversation", where: { slot: s.id } }, { op: "delete", table: "slot", where: { id: s.id } });
      d.events.push({ source: "rh", type: "slot_deleted", slot: s.id, data: { ref } });
      return `已删除 ${ref}。`;
    }
  }
  throw new Error(`rh: command ${def.name} is defined but not routed`);
}

/**
 * rh send to a slot (architecture §9.3): an internal message. It joins the turn the slot runs, starts
 * one if it is idle, and wakes it if it is off; an agent waking one at the running limit is refused,
 * and you are told, while yours from a terminal always wakes it (product §6.1). Returns the reply.
 */
function sendTo(state: State, ctx: Ctx, d: Decision, to: Slot, who: Caller, text: string, trace: string): string {
  const ref = slotView(state, to).ref;
  const from = who.kind === "slot" ? who.slot : undefined;
  const { maxRunning } = ctx.config.limits;
  if (to.state === "off" || to.state === "crashed") diskRoom(state, ctx, who, `rh send 唤醒 ${ref}`);
  if (from && (to.state === "off" || to.state === "crashed") && running(state) >= maxRunning) {
    const why = `同时运行的无头槽位已到上限 ${maxRunning} 个`;
    refuse(`rh send 唤醒 ${ref} 被拒绝：${why}。已通知用户。`, `${slotView(state, from).ref} 用 rh send 唤醒 ${ref} 被拒绝：${why}。`);
  }
  // As your message does, it brings an archived slot back, rather than wake it hidden from rh ls.
  if (to.archivedAt !== null) {
    d.writes.push({ op: "update", table: "slot", where: { id: to.id }, patch: { archivedAt: null, activeAt: ctx.now } });
    d.events.push({ source: "rh", type: "slot_unarchived", trace, slot: to.id });
  }
  const label = from ? `槽位 ${slotView(state, from).ref}` : who.kind === "you" && who.via ? `${who.via}（用户已同意）` : "用户的终端";
  const body = `${sendLine(label)}\n${text}`;
  const waits = wake(state, ctx, d, to, { source: "rh", body, trace }, { always: true });
  d.events.push({ source: "rh", type: "send_slot", trace, slot: to.id, data: { from: from?.id ?? null } });
  if (waits === IN_TUI) return `已发给 ${ref}。它在 TUI 里，切回无头后再交给它。`;
  return waits === AFTER_ASKS ? `已发给 ${ref}。它有提问在等用户回答，答完再交给它。` : `已发给 ${ref}。`;
}

/** The words rh send takes for you before a bot's name (product §5.9): me, the default, and web; no bot
 *  may be named so. */
const TO_YOU = ["me", "web"];
/** The platforms rh send names, ahead of a bot of the same name. */
const PLATFORM_WORDS: string[] = ["qq", "telegram", "feishu"];

/**
 * rh send to you (product §5.9, architecture §8.7): to me by the default, where you last wrote to the
 * slot, the board too; to web, a platform's or a bot's name, there, or by the default where that can't
 * send now. Kept on the board it goes to no chat: its send_me event says web, with the files' copies.
 * In a chat, the text first, cut up by the platform's limit, then each file in a message of its own;
 * one the platform of the bot that sends it would not take is refused. It goes as a notice does
 * (tell()). What goes out is a copy taken now: the agent may change or delete its file once rh
 * returns. Returns the receipt, saying where it went.
 */
function sendYou(state: State, ctx: Ctx, d: Decision, trace: string, from: Slot | undefined, to: string, text: string, paths: string[]): string {
  // It told you itself this turn: a child's report need not say it did not (architecture §9.3).
  const toldYou = to !== "me" && !!from?.parent;
  if (toldYou) d.writes.push({ op: "update", table: "slot", where: { id: from!.id }, patch: { turnToldYou: 1 } });
  // Said where the turn began, it takes the turn over (post()).
  const takesOver = (chat: string) => !!from?.conversation && from.turnChat === chat;
  let big: string | undefined;
  let at: Chat | undefined;
  // It went led by the slot's name: a quote of it in that chat goes back to the slot (product §5.3).
  let named = false;
  // What went, by its copy's hash, for the board to show (spec web-images).
  let went: Media[] = [];
  const keep = (path: string, max: number) => {
    const kept = ctx.keepFile(path, max) ?? refuse(`找不到文件 ${path}。`);
    if (kept.path) went.push({ kind: fileKind(path), hash: basename(kept.path), name: basename(path) });
    return kept;
  };
  const say = (caps: Capabilities | undefined, lead: string, to: To): Payload[] => {
    [big, went] = [undefined, []];
    at = to.chat;
    const files = paths.flatMap((path): Payload[] => {
      const kind = fileKind(path);
      const max = caps?.maxFileBytes[kind] ?? Infinity;
      const kept = keep(path, max);
      if (kept.path) return [{ text: "", file: { kind, path: kept.path, name: basename(path) } }];
      big ??= `${path} 有 ${formatMB(kept.size)}，超过了平台对${kind === "image" ? "图片" : "文件"}的上限 ${formatMB(max)}，发不出去。`;
      return [];
    });
    // A slot's, to a chat that goes to another slot, says whose it is (product §5.9).
    const whose = from && target(state, to.bot, to.chat, ctx)?.id !== from.id ? `〔${slotView(state, from).ref}〕\n` : "";
    named = whose !== "";
    const body = lead + whose + text;
    const out = [...(body.trim() ? chunkText(body, caps?.maxTextLength ?? Infinity).map((t) => ({ text: t, markdown: markdown(t, caps) })) : []), ...files];
    // Any of them failing takes back what it marks the turn with (unsaid()).
    const sentMe = takesOver(to.chat.id) && !!text.trim();
    return from && (toldYou || sentMe) ? out.map((p) => ({ ...p, said: { slot: from.id, at: from.turnStartedAt, ...(toldYou && { toldYou }), ...(sentMe && { sentMe }) } })) : out;
  };
  const sent = (web?: true) => {
    const data = { ...(web && { web }), ...(went.length && { files: went }), ...(!web && named && { named }) };
    d.events.push({ source: "rh", type: "send_me", trace, ...(from && { slot: from.id }), ...(Object.keys(data).length && { data }) });
  };
  // Kept on the board: the slot's chat there shows it (spec web-images), and it is unread there.
  const board = () => {
    went = [];
    for (const path of paths) keep(path, Infinity);
    sent(true);
    return "留在网页上，没发 IM。";
  };
  const name = (c: Chat) => amid(chatName(state, ctx, c)).trimEnd();
  // To the chat, unless strict and it can't send now (tell()): undefined then.
  const post = (chat: Chat, strict?: true): string | undefined => {
    const r = tell(state, ctx, d, from, trace, say, chat, strict);
    if (!r) return undefined;
    if (big) refuse(big);
    // Said where the turn began, what the agent says after it there is not forwarded, nor its final
    // reply: you'd get it twice (product §5.5); its tool lines are. A file alone takes nothing over.
    // On Telegram the turn's message stops as it is, and goes on under it (story 72).
    if (from && takesOver(r.chat)) {
      if (text.trim()) d.writes.push({ op: "update", table: "slot", where: { id: from.id }, patch: { turnSentMe: 1 } });
      underIt(state, ctx, d, from);
    }
    sent();
    if (r.held) return `已交给${name(at!)}，那边额度用完了，在等用户回话，回了才发出。`;
    return r.chat === chat.id ? `已发到${name(at!)}。` : `${chatName(state, ctx, chat)}发不出去，改发到了${name(at!)}。`;
  };
  // Where you last wrote to the slot: the chat it would go to, or the board, if later; there with a
  // page in front, else the chat (product §5.9). From you at a terminal: the main chat.
  const byDefault = (): string => {
    const web = from?.webAt != null && from.webAt > (pointing(state, ctx, from)?.contactedAt ?? -Infinity);
    if (web && ctx.front()) return board();
    const chat = contactChat(state, ctx, d, from) ?? refuse("找不到发给用户的窗口：没有聊天窗口指着这个槽位，配置里也没写主窗口（mainChat）。");
    return (web ? "网页没开在前台，" : "") + post(chat)!;
  };
  if (to === "me") return byDefault();
  if (to === "web") return board();
  // Your private chat on the platform, or with the bot: the one going to the slot or its root, else
  // the one you used last, else the main chat if it is there. None, or one that can't send now: the default.
  const bot = PLATFORM_WORDS.includes(to) ? undefined : state.bots.find((b) => b.name === to);
  const on = (b: Bot) => (bot ? b.id === bot.id : b.platform === to) && Object.hasOwn(ctx.config.bots, b.name);
  const what = bot ? `${PLATFORMS[bot.platform].label} Bot ${bot.name}` : (PLATFORMS[to as Made]?.label ?? `Bot ${to}`);
  const main = state.bots.find((b) => b.name === ctx.config.mainChat?.bot);
  const chat = yours(state, ctx, on, from) ?? (main && on(main) ? mainChat(state, ctx, d) : undefined);
  const done = chat && post(chat, true);
  if (done) return done;
  const why = !chat ? "没有能发的私聊" : state.bots.find((b) => b.id === chat.bot)!.connState === "faulted" ? "Bot 故障" : "额度不够";
  return `${amid(what).trimStart()}发不出去：${why}。改按默认规则发：${byDefault()}`;
}

/** rh ls <slot>: what the slot is, its state and its settings. */
function slotDetail(state: State, s: Slot, ctx: Ctx): string {
  const view = slotView(state, s);
  const parent = parentOf(state, s);
  return [
    `槽位: ${view.ref}`,
    `agent: ${view.agent}`,
    `模式: ${MODE[s.mode]}`,
    `状态: ${view.state}`,
    `目录: ${s.dir}`,
    ...(s.parent ? [`父槽位: ${parent ? slotView(state, parent).ref : "（已不在）"}`] : []),
    `生命周期: ${LIFETIME[s.lifetime]}`,
    ...settingLines(s, ctx.config),
  ].join("\n");
}

/** A chat as rh names it, <Bot>/<窗口 ID>: the bot's name and the chat's id on the platform. */
function splitChat(ref: string): [string, string] | undefined {
  const at = ref.indexOf("/");
  return at < 0 ? undefined : [ref.slice(0, at), ref.slice(at + 1)];
}

/**
 * Whether an agent's rh use, bind, pair or forget needs your say-so (product §5.11): a use or bind that
 * moves the main bot, or where the caller's contact chat goes, which is where you talk to it; taking
 * an owner off; and forgetting a chat, but its contact chat, which is refused outright: the request
 * would hang there, so it would be refused even agreed (architecture §9.9). The rest it does.
 */
function needsYou(state: State, ctx: Ctx, name: string, pos: string[], rm: string | undefined, caller: Slot): boolean {
  if (name === "pair") return rm !== undefined;
  const contact = contactChat(state, ctx, nothing(), caller);
  const on = (bot: Bot | undefined): bot is Bot => !!bot && contact?.bot === bot.id;
  if (name === "forget") {
    const bot = state.bots.find((b) => b.name === splitChat(pos[0] ?? "")?.[0]);
    if (on(bot) && pos[0] === `${bot.name}/${contact!.platformChatId}`) refuse("这是你联系用户的窗口。");
    return true;
  }
  if (pos.length !== 2) return false; // its usage says what is wrong
  const bot = state.bots.find((b) => b.name === (name === "use" ? splitChat(pos[0]!)?.[0] : pos[0]));
  if (bot && bot.name === ctx.config.mainChat?.bot) return true;
  if (!on(bot)) return false;
  const now = target(state, bot, contact, ctx);
  const to = pos[1] === "-" ? undefined : findTarget(state, pos[1]!);
  // rh bind moves it when it has no target of its own; rh use, when it is the chat named.
  const named = pos[0] === `${bot.name}/${contact!.platformChatId}`;
  const after = name === "bind" ? (contact!.target === null ? to : now) : named ? (to ?? target(state, bot, undefined, ctx)) : now;
  return after?.id !== now?.id;
}

/**
 * How a confirm request shows an rh call that names a chat or an account (docs/im-style.md §5.3, §2.6):
 * the command with the chat's id or the account as …; what it does, in here, the chat it asks you in,
 * which is 这里, and on the board, where no chat is. Another chat goes by its name and where it goes
 * now, to tell your accounts apart by. undefined: a call its argv shows as it is (asks.ts's action()).
 */
function worded(state: State, ctx: Ctx, argv: string[], here: Chat | undefined): Said | undefined {
  const [name, ...rest] = argv;
  if (name !== "use" && name !== "bind" && name !== "pair" && name !== "forget") return undefined;
  const ref = (s: Slot | undefined) => (s ? slotView(state, s).ref : "");
  const named = (bot: Bot) => amid(botName(ctx, bot));
  /** The bot's chat with this id: whether it is h, its row if on record, and where it goes now. */
  const of = (bot: Bot, id: string, h: Chat | undefined) => {
    const c = state.chats.find((c) => c.bot === bot.id && c.platformChatId === id);
    return { here: h?.bot === bot.id && h.platformChatId === id, c, now: ref(target(state, bot, c, ctx)) };
  };
  const now = (w: ReturnType<typeof of>) => (w.here ? "（就是这里）" : w.now ? `（它现在交给 ${w.now}）` : "");
  const say = (cmd: string[], word: (h: Chat | undefined) => { want: string; then?: string }): Said => ({ cmd: `rh ${cmd.join(" ")}`, ...word(here), web: word(undefined) });
  if (name === "bind") {
    const bot = findBot(state, rest[0]!);
    const to = ref(findTarget(state, rest[1]!));
    // The chat it asks you in follows the bot's default: why it asks you (needsYou()).
    const follows = here?.bot === bot.id && here.target === null;
    return say(argv, (h) => ({ want: `把${named(bot)}的默认槽位改成 ${to}`, ...(follows && { then: `${h ? "这里" : chatName(state, ctx, here)}的消息也会改交给 ${to}。` }) }));
  }
  if (name === "pair") {
    const { values, positionals } = parseArgs({ args: rest, options: COMMANDS.find((c) => c.name === "pair")!.options!, allowPositionals: true, strict: false });
    const rm = values.rm;
    if (typeof rm !== "string") return undefined;
    const bot = findBot(state, positionals[0]!);
    const cmd = argv.map((a, i) => (argv[i - 1] === "--rm" ? "…" : a.startsWith("--rm=") ? "--rm=…" : a));
    return say(cmd, (h) => {
      const w = of(bot, rm, h);
      // Not on record, the account has no private chat to tell it by.
      const which = w.here ? "（就是这里）" : w.c && w.now ? `（它的私聊现在交给 ${w.now}）` : "";
      return { want: `去掉${named(bot)}的一个主人${which}`, then: "那个账号的消息不再触发 agent。" };
    });
  }
  const [botRef, id] = splitChat(rest[0]!)!;
  const bot = findBot(state, botRef);
  const cmd = [name, `${bot.name}/…`, ...rest.slice(1)];
  if (name === "forget") {
    const what = `${named(bot)}的一个${ownerChat(bot, of(bot, id, here).c!, ctx) ? "私聊" : "聊天窗口"}`;
    return say(cmd, (h) => ({ want: `让 Rhodium 忘掉${what}${now(of(bot, id, h))}`, then: "它选的槽位和收发记录都删掉，那个账号再发消息会重新记下。" }));
  }
  const to = rest[1] === "-" ? target(state, bot, undefined, ctx) : findTarget(state, rest[1]!);
  return say(cmd, (h) => {
    const w = of(bot, id, h);
    const where = w.here ? "这里" : `${amid(chatName(state, ctx, { bot: bot.id, platformChatId: id }))}${now(w)}`;
    return { want: rest[1] === "-" ? `把${where}改回默认${to ? `，交给 ${ref(to)}` : ""}` : `把${where}改交给 ${ref(to)}` };
  });
}

/** Whether s is the slot a, or a's child, a child's child and so on. */
function descends(state: State, s: Slot, a: Slot): boolean {
  for (let p: Slot | undefined = s; p; p = parentOf(state, p)) if (p.id === a.id) return true;
  return false;
}

/**
 * An rh call that needs your say-so becomes a confirm request (product §6.2), and rh returns at once:
 * Claude waits on a command 10 minutes at most, less than an ask may wait (product §5.8). The request
 * hangs on the caller's slot, so you answer it as you answer that slot's asks. A caller rh cannot
 * recognize has no slot, nor anyone to tell your decision: it hangs on the slot the main chat goes to.
 */
function confirm(state: State, input: RhInput, who: Caller, ctx: Ctx, d: Decision): string {
  // Tried as yours first: a mistake is refused now, and a call that would change nothing asks no one.
  // What it would do is dropped, and it copies no file.
  const dry = nothing();
  const out = rh(state, input, { kind: "you" }, { ...ctx, keepFile: (path) => ({ size: 0, path }), retarget: () => null }, dry);
  if (typeof out === "string" && !dry.writes.length && !dry.effects.length) return out;
  const caller = who.kind === "slot" ? who.slot : undefined;
  const main = ctx.config.mainChat;
  const bot = main && state.bots.find((b) => b.name === main.bot);
  const slot = caller ?? (bot && target(state, bot, state.chats.find((c) => c.bot === bot.id && c.platformChatId === main!.chat), ctx));
  if (!slot) refuse(`${UNKNOWN}要改东西得用户确认，可是配置里没有主窗口（mainChat），或者它没有目标槽位，确认请求发不出去。请用户本人从终端执行。`);
  // Where it asks you: the chat a call naming a chat calls 这里.
  const at = contactChat(state, ctx, d, slot);
  const said = worded(state, ctx, input.argv, at);
  const p: ConfirmInput = { argv: input.argv, cwd: input.caller.cwd, caller: caller?.id ?? null, from: caller ? slotView(state, caller).ref : "认不出的调用者", ...(said && { said }) };
  // In a turn your message began, one that would ask you in that turn's chat waits for the turn's
  // reply, so the agent's words come first (product §5.8).
  const deferred = caller?.turnChat != null && at?.id === caller.turnChat;
  addAsk(state, ctx, d, slot, { kind: "confirm", requestId: null, tool: "rh", input: p }, deferred);
  const cmd = `rh ${input.argv.join(" ")}`;
  const when = deferred ? "确认请求会在你这一回合结束后推给用户。" : "";
  return caller ? `已请用户确认：${cmd}。${when}用户的决定会作为一条消息发给你，不用等；超时没确认视为拒绝。` : `已请用户确认：${cmd}。${UNKNOWN}用户的决定不会发回给你。`;
}

/** What an agent's decision asks of it once you agreed: in IM you heard 已回答：同意 alone; the board,
 *  where you agreed, shows the turn the decision begins, so its reply will do (product §5.8). A child
 *  whose rh send me is refused by then hands the result up instead (product §6.1): one wording for
 *  both, as whether it reports up may change before the decision reaches it. */
const tellResult = (web?: boolean) =>
  web ? "用户是在网页上同意的，网页上看得到你这一回合的回复。请把结果写在回复里，不用 rh send me。" : "用户在 IM 里只看到“已回答：同意”。请用 rh send me 把结果告诉用户；你有父槽位时，见 rh send me 的说明。";

/** Your decision on a confirm request: the rh call runs as yours if you agreed, and its caller hears
 *  either way, in a message of Rhodium's own (wake). Agreed, the agent it wakes tells you what came of
 *  the call; of a switch to or from the terminal, once it has gone one way or the other (switched()).
 *  Returns what came of the call, for you, when no agent will tell you. by: the chat you decided in,
 *  which hears what comes later; on the board, as at a terminal, the contact chat does. */
function decide(state: State, ctx: Ctx, d: Decision, a: Ask, answer: Extract<Answer, { kind: "confirm" }>, by: string): string | undefined {
  const { argv, cwd, caller, from } = prompt(a).input as ConfirmInput;
  const chat = by === WEB ? undefined : by;
  const cmd = `rh ${argv.join(" ")}`;
  let result: string | undefined;
  let switching: Slot | undefined;
  if (answer.approve) {
    const sub = nothing();
    try {
      const out = rh(state, { kind: "rh", id: ctx.newId(), caller: { token: null, pid: null, tty: true, cwd }, argv }, { kind: "you", via: from }, ctx, sub);
      // An rh import answers once done (imported()), in the chat you agreed in.
      result = typeof out === "string" ? out : (out?.text ?? "已开始执行，结果稍后发到这里。");
      d.writes.push(...sub.writes);
      d.events.push(...sub.events.map((e) => ({ ...e, source: "im" as const }))); // only your answer agrees
      d.effects.push(...sub.effects.map((e) => (e.kind === "import" ? { ...e, chat } : e)));
      if ((argv[0] === "tui" || argv[0] === "release") && (sub.writes.length || sub.effects.length)) switching = slotByRef(state, argv[1]!);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      result = `没有执行：${err.message}`; // say the slot is gone since
    }
  }
  const agreed = `用户同意了你的确认请求：${cmd}`;
  const body = answer.approve
    ? `${agreed}\n结果：${result}`
    : by === "timeout"
      ? `确认请求超时，视为拒绝：${cmd} 没有执行。`
      : `用户拒绝了你的确认请求：${cmd} 没有执行。${answer.message ? `\n用户说：${answer.message}` : ""}`;
  const to = state.slots.find((s) => s.id === caller);
  // Your own switch: how it went comes to the chat you agreed in (switched()).
  if (switching && caller === null && chat) d.writes.push({ op: "update", table: "slot", where: { id: switching.id }, patch: { switchDecision: JSON.stringify({ chat }) } });
  if (!to?.conversation) return result;
  // An archived slot stays out of sight: the decision waits for your next message to it, which brings
  // it back. Meanwhile you hear what came of the call.
  if (to.archivedAt !== null) {
    d.writes.push({ op: "insert", table: "agentInput", row: { id: ctx.newId(), conversation: to.conversation, source: "confirm", status: "queued", body } });
    return result;
  }
  if (!answer.approve) wake(state, ctx, d, to, { source: "confirm", body });
  else if (switching) d.writes.push({ op: "update", table: "slot", where: { id: switching.id }, patch: { switchDecision: JSON.stringify({ slot: to.id, body: agreed, ...(by === WEB && { web: true }) }) } });
  else wake(state, ctx, d, to, { source: "confirm", body: `${body}\n${tellResult(by === WEB)}` });
  return undefined;
}

/** How the slot's switch to or from the terminal went: to the agent whose confirm request for it you
 *  agreed to, as its decision, for it to tell you (decide()); else to you, in the chat you asked for it
 *  in from IM (product §5.9), else in the slot's contact chat: one that went is only told where a chat
 *  points at the slot (inform()). One you asked for on the board shows there, and you hear of it only
 *  when it failed (ok: the slot is where it was headed; spec web-write). now: the slot
 *  as the switch leaves it. One the emergency stop calls off is told at the exit (agent()). */
function switched(state: State, ctx: Ctx, d: Decision, now: Slot, text: string, buttons?: Button[], ok = false): void {
  const waiting = now.switchDecision ? (JSON.parse(now.switchDecision) as { slot?: string; body?: string; web?: true; chat?: string; board?: true }) : undefined;
  if (waiting) d.writes.push({ op: "update", table: "slot", where: { id: now.id }, patch: { switchDecision: null } });
  if (waiting?.board && ok) return;
  const to = waiting?.slot && (waiting.slot === now.id ? now : state.slots.find((s) => s.id === waiting.slot));
  if (!to || !to.conversation || to.archivedAt !== null) return (ok ? inform : notify)(state, ctx, d, now, ctx.newId(), text, buttons, state.chats.find((c) => c.id === waiting?.chat));
  wake(state, ctx, d, to, { source: "confirm", body: `${waiting!.body}\n结果：${text}\n${tellResult(waiting!.web)}` });
}

/** Whether Rhodium has asked the conversation's agent to stop and it has not started since. */
function stopping(state: State, conversation: string): boolean {
  return (state.holders.find((h) => h.conversation === conversation)?.stopRequested ?? 0) > 0;
}

/** Whether that stop was the emergency stop's. */
const braked = (state: State, conversation: string) => state.holders.find((h) => h.conversation === conversation)?.stopRequested === 2;

/** Stops the slot's agent and keeps its conversation; false if no agent of it runs. */
function stop(s: Slot, d: Decision, source: NewEvent["source"] = "rh", brake = false): boolean {
  if (s.state === "off" || s.state === "crashed" || !s.conversation) return false;
  stopAgent(d, s.conversation, brake);
  releaseQueued(d, s.conversation, WEB_QUEUE, WEB_PAUSED); // the board's queue is paused (spec web-write "待发队列")
  // The turn ends here, with no final reply; one your next message begins takes its place (im).
  d.writes.push({ op: "update", table: "slot", where: { id: s.id }, patch: { turnChat: null, turnInbound: null, turnSentMe: null, interruptedAt: null } });
  d.events.push({ source, type: "slot_stop", slot: s.id });
  return true;
}

/** The agent kind --agent names, the default if none. */
function agentKind(agent: string = DEFAULT_AGENT): Conversation["agent"] {
  if (!(AGENT_KINDS as string[]).includes(agent)) refuse(`没有叫 ${agent} 的 agent，可以选 ${AGENT_KINDS.slice(0, -1).join("、")} 或 ${AGENT_KINDS.at(-1)}。`);
  return agent as Conversation["agent"];
}

/** Adds a headless slot with a conversation of the agent: an empty one, or the session imported;
 *  refuses a name taken in the workspace. */
function addSlot(
  state: State,
  ctx: Ctx,
  d: Decision,
  o: { workspace: Workspace; name: string; dir: string; agent: Conversation["agent"]; state: Slot["state"]; lifetime: Slot["lifetime"]; parent?: string | null; session?: string },
): { id: string; conversation: string } {
  if (state.slots.some((s) => s.workspace === o.workspace.id && s.name === o.name)) refuse(`工作区 ${o.workspace.name} 里已经有槽位 ${o.name}。`);
  const id = ctx.newId();
  const conversation = ctx.newId();
  const { workspace, agent, session, ...row } = o;
  d.writes.push(
    { op: "insert", table: "slot", row: { ...row, id, workspace: workspace.id, mode: "headless", conversation, activeAt: ctx.now } },
    // The agent kind belongs to the conversation, so a slot starts with an empty one.
    { op: "insert", table: "conversation", row: { id: conversation, slot: id, agent, startedAt: ctx.now, ...(session && { sessionId: session }) } },
  );
  return { id, conversation };
}

/** The workspace whose default dir is dir, made if there is none (product §6.1). */
function workspaceFor(state: State, ctx: Ctx, d: Decision, dir: string, source: NewEvent["source"]): Workspace {
  const had = state.workspaces.find((w) => w.dir === dir);
  if (had) return had;
  const ws = { id: ctx.newId(), machine: "", name: workspaceName(state.workspaces, dir), dir, herdrWorkspace: null };
  d.writes.push({ op: "insert", table: "workspace", row: { id: ws.id, name: ws.name, dir: ws.dir } });
  d.events.push({ source, type: "workspace_created", data: { name: ws.name, dir: ws.dir } });
  return ws;
}

/** A name for a workspace made for dir: its last part, made a valid name, with -2, -3... if one of
 *  workspaces has it. */
export function workspaceName(workspaces: { name: string }[], dir: string): string {
  const cleaned = basename(dir).replace(/[^\p{L}\p{N}_.-]/gu, "-").replace(/^[^\p{L}\p{N}]+/u, "");
  const base = [...(cleaned || "ws")].slice(0, 56).join("");
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!workspaces.some((w) => w.name === name)) return name;
  }
}

function splitRef(ref: string): [string, string] {
  const parts = ref.split("/");
  if (parts.length !== 2 || !NAME.test(parts[0]!) || !NAME.test(parts[1]!)) {
    refuse(`看不懂槽位 ${ref}。${SLOT_HINT}名字只能由文字、数字和 _ . - 组成。`);
  }
  return parts as [string, string];
}

/** The slot named workspace/slot, or by its row id, as a button too long with its name names it
 *  (docs/im-style.md §11.4); refuses a malformed name or a slot that does not exist. */
function findSlot(state: State, ref: string): Slot {
  const byId = state.slots.find((s) => s.id === ref);
  if (byId) return byId;
  splitRef(ref); // only for its refusal of a malformed name
  return slotByRef(state, ref) || refuse(`没有槽位 ${ref}。`);
}

/** A slot to send messages to: workspace/slot, or the slot's name alone when no other slot has it. */
function findTarget(state: State, ref: string): Slot {
  if (ref.includes("/") || state.slots.some((s) => s.id === ref)) return findSlot(state, ref);
  const named = state.slots.filter((s) => s.name === ref);
  if (named.length === 1) return named[0]!;
  if (!named.length) refuse(`没有槽位 ${ref}。`);
  refuse(`有 ${named.length} 个槽位叫 ${ref}：${named.map((s) => slotView(state, s).ref).join("、")}，写全名。`);
}

function findBot(state: State, name: string): Bot {
  return state.bots.find((b) => b.name === name) ?? refuse(`没有 Bot ${name}。`);
}

/** The slot named workspace/slot, if there is one. */
function slotByRef(state: Pick<State, "workspaces" | "slots">, ref: string): Slot | undefined {
  const [wsName, slotName, extra] = ref.split("/");
  const ws = extra === undefined ? state.workspaces.find((w) => w.name === wsName) : undefined;
  return ws && state.slots.find((s) => s.workspace === ws.id && s.name === slotName);
}

// ---- Per-slot settings: a column on the slot row, null meaning the config file's default. ----

type SettingColumn = "approval" | "reapAfter" | "askTimeout" | "crashResume" | "autoContinue";
const COLUMN: Record<SettingKey, SettingColumn> = {
  approval: "approval",
  reap: "reapAfter",
  "ask-timeout": "askTimeout",
  "crash-resume": "crashResume",
  "auto-continue": "autoContinue",
};
const DEFAULT: Record<SettingKey, (c: Config) => number | boolean> = {
  approval: (c) => c.defaults.approval,
  reap: (c) => c.durations.idleReap,
  "ask-timeout": (c) => c.durations.askTimeout,
  "crash-resume": (c) => c.defaults.crashResume,
  "auto-continue": (c) => c.defaults.autoContinue,
};

/** The stored value for one `rh set` item: null for default, undefined if it's not a valid value. */
function parseSetting(key: SettingKey, v: string): number | null | undefined {
  if (v === "default") return null;
  if (SETTINGS[key].kind === "flag") return v === "on" ? 1 : v === "off" ? 0 : undefined;
  if (v === "off" || v === "0") return 0; // story 81: 0 means never
  return parseDuration(v) ?? undefined;
}

/** The settings changed from the default, as /rh_ls's details say them: 审批模式开, 回收时长 2 小时. */
function changedSettings(s: Slot, config: Config): string[] {
  return (Object.keys(SETTINGS) as SettingKey[]).flatMap((key) => {
    const own = s[COLUMN[key]];
    if (own === null || own === DEFAULT[key](config)) return [];
    const shown = SETTINGS[key].kind === "flag" ? (own ? "开" : "关") : own === 0 ? "从不" : ` ${span(own as number)}`;
    return [`${SETTINGS[key].label}${shown}`];
  });
}

/** The slot's settings as the board shows them (story 322): each rh set item, with its own value, null
 *  for the default, and the default; a flag's as 1 or 0. */
export const settingsOf = (s: Slot, config: Config) =>
  (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({ key, label: SETTINGS[key].label, kind: SETTINGS[key].kind, value: s[COLUMN[key]], default: Number(DEFAULT[key](config)) }));

function settingLines(s: Slot, config: Config): string[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const own = s[COLUMN[key]];
    const v = own ?? DEFAULT[key](config);
    const shown = SETTINGS[key].kind === "flag" ? (v ? "开" : "关") : v === 0 ? "从不" : formatDuration(v as number);
    return `${SETTINGS[key].label}: ${shown}${own === null ? "（默认）" : ""}`;
  });
}

/** The slot's state as rh ls and the board show it: product §4's, or where its switch to the terminal is. */
export const slotState = (s: Slot): string =>
  s.mode === "headless"
    ? STATE[s.state]
    : s.herdrPane === null
      ? "正在切到 TUI"
      : s.herdrLostAt !== null
        ? "Herdr 重启中"
        : s.tuiPid === null
          ? "没能切回无头"
          : "TUI 模式";

function slotView(state: State, s: Slot) {
  const ws = state.workspaces.find((w) => w.id === s.workspace);
  const conv = state.conversations.find((c) => c.id === s.conversation);
  return {
    ref: `${ws?.name ?? "?"}/${s.name}`,
    agent: conv?.agent ?? "-",
    state: slotState(s) + (s.archivedAt === null ? "" : "（已归档）"),
  };
}

/** The slot as a command's reply speaks of it; the tool its turn runs, as its tool line says it,
 *  running or waiting on you alone (docs/im-style.md §7.1). */
function slotInfo(state: State, s: Slot, now: number): SlotInfo {
  const running = s.state === "running" && s.mode === "headless" && progressOf(state.conversations.find((c) => c.id === s.conversation)?.progress)?.running;
  return { ...slotView(state, s), dir: s.dir, line: stateLine(s, now), ...(running && { tool: runningText(running, now) }) };
}


/** Columns separated by two spaces, padded to line up in a terminal. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => width(r[i]!))));
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i]! - width(c)))).join("  "))
    .join("\n");
}
