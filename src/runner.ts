// The slot runner (architecture §2): starts and stops a conversation's holder and agent, writes
// its queued agent inputs, and feeds the agent's output to the driver, whose events go to the
// main loop. After a restart it takes over the agents the last rhodium left running (§5).
// The runner never reads the agent's protocol; the driver does.
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AGENTS, DEFAULT_AGENT } from "./agents";
import { ClaudeDriver } from "./claude";
import { CodexDriver } from "./codex";
import { locate, type Config } from "./config";
import type { AgentDriver, AgentEmit, AgentEvent, AgentKind, AgentMessage, Capabilities, CommandResult, CommonCommand, PanelUi, SpawnSpec } from "./contracts";
import { log, type Loop } from "./daemon";
import { connectHolder, holderPaths, spawnHolder, unitGone, type HolderEvents, type HolderLink } from "./holder";
import { moment } from "./panels";
import { PiDriver } from "./pi";
import { systemPrompt, withSentAt } from "./prompt";
import { clip } from "./render";
import { chatOf, PASSED, type Write } from "./router";
import { B32, modelNames, setMeta, setModelNames, untaken, type AgentInput, type Conversation, type Holder, type Slot, type Store } from "./store";
import { hasTranscript, listConversations, type Conversation as Found } from "./transcript";

/**
 * One conversation's agent as this rhodium runs it. proc counts its agent processes. session is
 * the new session id the process was launched with, until it is recorded: once Claude's output
 * reports it, once an input is written to pi (architecture §6.2, §6.3). stopping:
 * a stop came for this process (2: the emergency stop, as the holder row has it), so nothing more
 * is written to it; one still starting is stopped as soon as it is attached. adopt: the process was found running after a restart and its
 * session id is not on record, so take the one its output reports. seen: where out.log was
 * processed up to when the process was attached; output before it was processed already and
 * only brings the driver's state back. waiting: the start waits for the agent program (start);
 * missing: the program the last start gave up waiting for.
 */
type Live = {
  driver: AgentDriver;
  proc: number;
  link: HolderLink | null;
  delivering: boolean;
  session: string | null;
  stopping: Holder["stopRequested"];
  adopt: boolean;
  seen: number;
  reapply: boolean;
  waiting: boolean;
  missing: string | null;
};

type ExitFile = { from: "agent" | "holder"; code: number | null; signal: string | null };

/** The exit file (architecture §4.3), or null if there is none. */
function readExit(dir: string): ExitFile | null {
  try {
    const e = JSON.parse(readFileSync(join(dir, "exit"), "utf8"));
    return e.from === "agent" || e.from === "holder" ? e : null;
  } catch {
    return null;
  }
}

/** Holder units under this rhodium's prefix that are up. A stopping one counts as gone. */
export async function activeHolders(cfg: Config): Promise<Set<string>> {
  const argv = ["systemctl", "--user", "list-units", "--state=active", "--plain", "--no-legend", "--full", `${cfg.unitPrefix}hold-*`];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`systemctl list-units failed: ${err.trim()}`);
  return new Set(out.split("\n").filter(Boolean).map((l) => l.split(" ")[0]!.replace(/\.service$/, "")));
}

/** The environment every agent gets: rhodium's own, the configured PATH, and an empty state dir
 *  for the Telegram channel plugin, which then finds no token and leaves your bot to your own
 *  Claude (architecture §6.2). */
export function agentBaseEnv(cfg: Config): Record<string, string> {
  const telegram = join(cfg.stateDir, "telegram-off");
  mkdirSync(telegram, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined));
  return { ...env, PATH: cfg.agentPath, TELEGRAM_STATE_DIR: telegram };
}

// ponytail: the newest 20, so the list fits one message; older ones are reached by the start of their id.
const RESUME_SHOWN = 20;
const OPENING = 12; // characters of a conversation's first message in the /resume list (docs/im-style.md §2.5)
const PROGRAM_RETRY = 2000; // ms between looks for an agent program not there (start)
// What a start-failure notice quotes of err.log (docs/im-style.md §6.1): lines, characters, and the bytes read for them.
const [ERR_LINES, ERR_CHARS, ERR_BYTES] = [3, 300, 4096];

type Resumable = { agent: AgentKind; session: string; label: string; name: string; current?: true };

/** The /resume list (docs/im-style.md §9.6): the slot's timeline, newest first, the current conversation
 *  marked; then the directory's conversations not on it, most recently active first. A row with no
 *  session yet has nothing to go back to. Each shows when it was last active and what was said first,
 *  and, where the list has both agents, which are pi's; name is how you call it, 昨天 22:10 那段. */
function resumable(timeline: Conversation[], found: Found[], current: string): Resumable[] {
  const now = Date.now();
  const files = new Map(found.map((f) => [`${f.agent}:${f.id}`, f]));
  const entry = (agent: AgentKind, session: string, at: number, said: string) => {
    const when = moment(at, now);
    return { agent, session, when, said: clip(said, OPENING, "…") || session.slice(0, 8), name: `${/^\d\d:/.test(when) ? "今天 " : ""}${when} 那段` };
  };
  const mine = timeline
    .filter((c) => c.sessionId !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((c) => {
      const f = files.get(`${c.agent}:${c.sessionId}`);
      files.delete(`${c.agent}:${c.sessionId}`);
      return { ...entry(c.agent, c.sessionId!, f?.modifiedAt.getTime() ?? c.startedAt, f?.title ?? ""), ...(c.id === current && { current: true as const }) };
    });
  const all = [...mine, ...[...files.values()].map((f) => entry(f.agent, f.id, f.modifiedAt.getTime(), f.title))];
  // Only what isn't the default agent's is marked, and before what was said: a long label is cut at its end.
  const mixed = new Set(all.map((e) => e.agent)).size > 1;
  return all.map(({ when, said, ...e }) => ({ ...e, label: `${when}${mixed && e.agent !== DEFAULT_AGENT ? `（${e.agent}）` : " "}${said}` }));
}

/** The slot's name for rh, and its token, made the first time: one per slot, kept for good, as an
 *  agent outlives a rhodium restart and keeps its environment. */
export function slotToken(store: Store, slot: string): { ref: string; token: string } {
  return store.tx((tx) => {
    const s = tx.get("slot", slot)!;
    const token = s.token ?? randomBytes(32).toString("hex");
    tx.update("slot", { id: slot }, { token });
    return { ref: `${tx.get("workspace", s.workspace)!.name}/${s.name}`, token };
  });
}

export type Runner = ReturnType<typeof createRunner>;

/**
 * capabilities: the capability table of each bot (row id) with an adapter running, for the system prompt.
 * onVersion: a Claude process told its version in its handshake.
 * inUse: why the session is someone else's (another process or Herdr pane has it), or null.
 * writing: each piece of text the agent writes of a message as it writes it, then the whole message,
 *   as its driver reports them, and the process's exit, which ends a message never whole: for the
 *   board, which does not keep them (architecture §7.7). Not those of output fed again after a restart.
 */
export function createRunner(o: {
  cfg: Config;
  store: Store;
  boot: number;
  loop: Loop;
  capabilities: (bot: string) => Capabilities | undefined;
  onVersion?: (version: string) => void;
  inUse: (session: string) => Promise<string | null>;
  writing?: (conversation: string, e: Extract<AgentEvent, { type: "text_delta" | "item" | "exit" }>) => void;
}) {
  const { cfg, store, boot, loop, capabilities } = o;
  const live = new Map<string, Live>(); // by conversation id
  const answering = new Set<string>(); // asks whose answer is being written
  let batch: AgentEvent[] | null = null; // what the driver reports while fed one chunk of output

  const report = (event: AgentEvent) => loop.enqueue({ kind: "agent", event });

  /** Each agent's driver, for a conversation. */
  const DRIVERS: Record<AgentKind, (common: { conv: string; boot: number; emit: AgentEmit; stopGrace: number }) => AgentDriver> = {
    claude: (common) => new ClaudeDriver({ ...common, onVersion: o.onVersion, onModels: (models) => setModelNames(store, models) }),
    pi: (common) => new PiDriver({ ...common, extensionDir: join(cfg.stateDir, "pi") }),
    codex: (common) => new CodexDriver({ ...common, onModels: (names) => setMeta(store, modelNames("codex"), JSON.stringify(names)) }),
  };

  function liveFor(conv: Conversation): Live {
    const conversation = conv.id;
    let l = live.get(conversation);
    if (!l) {
      const emit = (e: AgentEvent) => {
        if (batch) batch.push(e);
        else report(e);
        // The handshake is over: a crash resume waiting for it can go (deliver).
        if (e.type === "pending_asks") void deliver(conversation);
      };
      // The agent kind belongs to the conversation, so its driver never changes.
      const driver = DRIVERS[conv.agent]({ conv: conversation, boot, emit, stopGrace: cfg.durations.stopGrace });
      live.set(conversation, (l = { driver, proc: 0, link: null, delivering: false, session: null, stopping: 0, adopt: false, seen: 0, reapply: false, waiting: false, missing: null }));
    }
    return l;
  }

  /** The agent's whole environment: the base one, and rh pointed at this rhodium with the slot's
   *  name and token (architecture §9.1). */
  function agentEnv(slot: { ref: string; token: string }): Record<string, string> {
    return {
      ...agentBaseEnv(cfg),
      RHODIUM_SOCKET: join(cfg.socketDir, "rh.sock"),
      RHODIUM_SLOT: slot.ref,
      RHODIUM_TOKEN: slot.token,
    };
  }

  /** The slot's appended system prompt, written afresh for each agent process (architecture §6.1). */
  function promptFile(slot: string): string {
    const file = join(cfg.stateDir, "prompt", `${slot}.md`);
    const rows = store.tx((tx) => tx.find("bot", {}));
    const bots = rows.flatMap((b) => {
      const caps = capabilities(b.id);
      return caps ? [{ chat: chatOf(rows, cfg, b, "私聊"), caps }] : []; // gone from the config
    });
    mkdirSync(join(cfg.stateDir, "prompt"), { recursive: true });
    writeFileSync(file, systemPrompt(bots, cfg.durations.oneoffArchive, cfg.durations.sentAtAfter));
    return file;
  }

  /** How to launch the slot's agent, resuming its conversation if it has one. */
  async function spawnSpec(me: Live, slot: Slot, conv: Conversation): Promise<SpawnSpec> {
    const { ref, token } = slotToken(store, slot.id);
    // Let through for this start: the last process's exit dropped any resume of its own.
    const resumed = store.tx((tx) => tx.find("agentInput", { conversation: conv.id, status: "queued", source: "crash_resume" }).length > 0);
    // A new session id is recorded only once the agent has the session: Claude once its output says
    // so (output), pi once an input is written (deliver). Resuming one Claude never had would fail
    // every start after. So would one on record that it never wrote down, as an imported pane's or
    // one you switched to in the terminal, before its first message: it starts under that id
    // (architecture §6.2). pi's --session-id opens a session or starts it alike (sessionIdOpens).
    const id = conv.sessionId;
    const session = id && (AGENTS[conv.agent].sessionIdOpens || (await hasTranscript(conv.agent, id))) ? { resume: id } : { new: id ?? randomUUID() };
    me.session = session.new ?? null;
    // After a crash Claude runs the interrupted turn again by itself (architecture §4.8); deliver
    // writes it the resume prompt only if it has none. Only then: rhodium's own environment never
    // turns it on.
    const { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: _, ...env } = agentEnv({ ref, token });
    return me.driver.spawn({
      cwd: slot.dir,
      session,
      systemPromptFile: promptFile(slot.id),
      env,
      resumed,
      approval: Boolean(slot.approval ?? cfg.defaults.approval),
      program: cfg.programs[conv.agent],
      model: slot.model,
      effort: slot.effort,
      ultracode: slot.ultracode === null ? null : slot.ultracode === 1,
    });
  }

  function exited(conversation: string, proc: number, code: number | null, signal: string | null, from: "agent" | "holder") {
    log("agent exited", { conversation, from, code, signal });
    const stderr = errTail(conversation);
    // What the driver knows of why it did not start: another process has the conversation, or its own reason.
    const { busy, why } = live.get(conversation)?.driver.info ?? {};
    const exit = { type: "exit", code, signal, from, conv: conversation, proc, ...(stderr && { stderr }), ...(busy ? { busy } : why && { why }) } as const;
    report(exit);
    o.writing?.(conversation, exit);
  }

  /** The last ERR_LINES lines the conversation's current agent process, or its holder, wrote to
   *  err.log, ERR_CHARS at most and ANSI codes gone; from where its own begin, or from the start once
   *  err.log has rotated since (architecture §4.3). */
  function errTail(conversation: string): string | undefined {
    const errStart = store.tx((tx) => tx.find("holder", { conversation })[0]?.errStart ?? 0);
    let fd: number | undefined;
    try {
      fd = openSync(join(holderPaths(cfg, conversation).dir, "err.log"), "r");
      const size = fstatSync(fd).size;
      const from = Math.max(errStart > size ? 0 : errStart, size - ERR_BYTES);
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      const lines = stripVTControlCharacters(buf.toString()).split("\n").filter((l) => l.trim()).slice(-ERR_LINES);
      return lines.length ? clip(lines.join("\n"), ERR_CHARS, "…") : undefined;
    } catch {
      return undefined; // none written yet
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Runs one agent process of the conversation: open gets a link to its holder, which reports
   * through `on`; then the driver attaches and what is queued gets written. Output before byte
   * `seen` of out.log was processed before a restart; the holder sends it again from byte `from`.
   * Any failure is reported as the agent's exit. A null link means open found the holder gone and
   * settled its end itself.
   */
  async function attach(conv: Conversation, seen: number, open: (me: Live, on: HolderEvents) => Promise<HolderLink | null>, from = seen) {
    const conversation = conv.id;
    const me = liveFor(conv);
    const proc = ++me.proc;
    me.seen = seen;
    me.adopt = false;
    me.stopping = 0;
    me.missing = null;
    let done = false;
    const exit = (code: number | null, signal: string | null, from: "agent" | "holder") => {
      if (done || me.proc !== proc) return;
      done = true;
      me.link = null;
      exited(conversation, proc, code, signal, from);
    };
    // Once the output before `seen` is fed again, the driver has its state back (architecture §5).
    let behind = from < seen;
    const feed = (pos: number, data: Uint8Array) => {
      output(me, proc, pos, data);
      if (behind && me.proc === proc && pos + data.length >= seen) {
        behind = false;
        me.driver.replayed();
      }
    };
    // Output can arrive before the driver is attached; it waits for it.
    let early: [number, Uint8Array][] | null = [];
    const on: HolderEvents = {
      out: (pos, data) => (early ? early.push([pos, data]) : feed(pos, data)),
      // Any connection's ack, so also one for a line the last rhodium left half written (§4.6).
      // The driver's own lines are acked too; they are no agent input, so nothing changes.
      ack: (inputId) => report({ type: "written", inputId, conv: conversation, proc }),
      exit: (code, signal) => exit(code, signal, "agent"),
      close: () => exit(null, null, "holder"),
    };
    try {
      const link = await open(me, on);
      if (done || !link) return;
      me.link = link;
      me.driver.attach(link, proc);
      // After a restart, what the agent took meanwhile may be in the output fed next (architecture §4.6).
      me.driver.untaken(store.tx((tx) => untaken(tx, conversation)).map((i) => i.id));
      if (!behind) me.driver.replayed();
      if (me.reapply) {
        // rh set approval came while it was starting, maybe after its launch read the setting.
        me.reapply = false;
        const [slot] = store.tx((tx) => tx.find("slot", { conversation }));
        if (slot) void approval(conversation, Boolean(slot.approval ?? cfg.defaults.approval));
      }
      for (const [pos, data] of early) feed(pos, data);
      early = null;
      // What is queued stays queued for the next start.
      if (!me.stopping) return void deliver(conversation);
      // A stop that came before the launch put the holder on record found no row, or launchHolder
      // reset it: recorded again, so the exit is not taken for a crash (architecture §4.8).
      store.tx((tx) => tx.update("holder", { conversation, stopRequested: 0 }, { stopRequested: me.stopping }));
      void stop(conversation);
    } catch (err) {
      log("cannot start the agent", { conversation, error: String(err) });
      exit(null, null, "holder");
    }
  }

  /** Launches the slot's agent in a new holder, then writes what is queued for it. An agent program
   *  not there, as while Claude or pi updates itself in place, is waited for, up to
   *  durations.programWait (architecture §4.2); what is queued waits with it, and a stop ends the wait. */
  async function start(slotId: string): Promise<void> {
    const { slot, conv } = store.tx((tx) => {
      const slot = tx.get("slot", slotId)!;
      // The last rh stop is over; a start that fails before its holder launches is a crash.
      tx.update("holder", { conversation: slot.conversation! }, { stopRequested: 0 });
      return { slot, conv: tx.get("conversation", slot.conversation!)! };
    });
    await attach(conv, 0, async (me, on) => {
      // Never two processes on one transcript (architecture §10.1): not while, say, you have the
      // conversation open in a terminal.
      const busy = conv.sessionId ? await o.inUse(conv.sessionId) : null;
      if (busy) return report({ type: "exit", code: null, signal: null, from: "holder", busy, conv: conv.id, proc: me.proc }), null;
      const program = cfg.programs[conv.agent];
      const gone = (why: { missing: string } | { stopped: 1 | 2 }) => report({ type: "exit", code: null, signal: null, from: "holder", ...why, conv: conv.id, proc: me.proc });
      for (const end = Date.now() + cfg.durations.programWait; ; ) {
        const path = locate(program, cfg.agentPath);
        const link = path && existsSync(path) ? await launch(me, slot, conv, on) : null;
        if (link || me.stopping || Date.now() >= end) me.waiting = false;
        if (link) return link;
        // Stopped meanwhile, no agent ran: its exit says it was the stop's, there being maybe no holder row to say so.
        if (me.stopping) return gone({ stopped: me.stopping }), null;
        if (Date.now() >= end) return (me.missing = basename(path ?? program)), gone({ missing: path ?? program }), null;
        me.waiting = true;
        for (const next = Math.min(end, Date.now() + PROGRAM_RETRY); Date.now() < next && !me.stopping; ) await Bun.sleep(50);
      }
    });
  }

  /** One launch of the agent in a new holder. What the holder reports waits till the launch is
   *  over: if the holder could not start the agent as its program, or the program's interpreter,
   *  was not there, it is dropped, and null tells start to try again. */
  async function launch(me: Live, slot: Slot, conv: Conversation, on: HolderEvents): Promise<HolderLink | null> {
    let held: (() => void)[] | null = [];
    const gate =
      <A extends unknown[]>(f: (...a: A) => void) =>
      (...a: A) =>
        held ? void held.push(() => f(...a)) : f(...a);
    const flush = () => {
      const h = held!;
      held = null;
      for (const f of h) f();
    };
    let refused = false; // the holder's answer to a start it could not carry out (architecture §4.4)
    const exit = gate(on.exit);
    const gated: HolderEvents = {
      out: gate(on.out),
      ack: gate((id: string) => on.ack?.(id)),
      exit: (code, signal) => ((refused = code === 127), exit(code, signal)),
      close: gate(() => on.close?.()),
    };
    try {
      const link = await spawnHolder({ cfg, store, conversation: conv.id, holdBin: cfg.holdBin || undefined, spec: await spawnSpec(me, slot, conv), boot, on: gated });
      flush();
      return link;
    } catch (err) {
      // Why is rh-hold's last line in err.log. ENOENT also comes of a cwd not there.
      const tail = refused ? await Bun.file(join(holderPaths(cfg, conv.id).dir, "err.log")).slice(-1024).text().catch(() => "") : "";
      if (/rh-hold: cannot start [^\n]*\(os error 2\)\n$/.test(tail) && existsSync(slot.dir)) {
        // Its exit, dropped, is on record all the same: a restart or rh doctor takes it for no holder.
        store.tx((tx) => tx.update("holder", { conversation: conv.id }, { exited: 1 }));
        return null;
      }
      flush();
      throw err;
    }
  }

  /** Whole lines of output from out.log byte pos on: the events they cause and the new offset
   *  commit in one transaction (architecture §4.5). proc is undefined for lines read straight
   *  from out.log, with no process attached. */
  function output(l: Live, proc: number | undefined, pos: number, data: Uint8Array): void {
    const events: AgentEvent[] = [];
    try {
      for (let at = 0, nl = data.indexOf(10); nl >= 0; at = nl + 1, nl = data.indexOf(10, at)) {
        const replay = pos + nl < l.seen; // processed before the restart: state only
        batch = replay ? [] : events;
        l.driver.feed(data.subarray(at, nl + 1), proc, replay);
      }
    } finally {
      batch = null;
    }
    const conversation = l.driver.conv;
    for (const e of events) if (e.type === "text_delta" || (e.type === "item" && e.item.kind === "message")) o.writing?.(conversation, e);
    const writes: Write[] = [];
    const end = pos + data.length;
    if (end > l.seen) writes.push({ op: "update", table: "holder", where: { conversation }, patch: { outOffset: end } });
    // Claude reports its session once it has read your message, which the holder's ack of it does not say.
    const session = l.adopt || l.session ? l.driver.info.session : null;
    if (session) {
      l.adopt = false;
      l.session = null;
      writes.push({ op: "update", table: "conversation", where: { id: conversation }, patch: { sessionId: session } });
    }
    if (writes.length) loop.batch(events.map((event) => ({ kind: "agent", event })), writes);
  }

  /** Writes the conversation's queued inputs, oldest first, one at a time: queued, writing, then
   *  written once the holder acks it (architecture §4.6). One with a queue reason waits for the
   *  router to clear it, and so does everything after it, but for what waits for the turn's end, or in
   *  the board's queue: your message mid-turn still joins the turn (architecture §9.3). */
  async function deliver(conversation: string): Promise<void> {
    const l = live.get(conversation);
    // Not attached yet: start delivers once it is. Already at it: the loop below picks this up.
    if (!l?.link || l.delivering) return;
    l.delivering = true;
    const link = l.link;
    try {
      // Stopping, the agent would never read it: it stays queued for the start after.
      while (!l.stopping) {
        const input = store.tx((tx) => {
          for (;;) {
            const next = tx.find("agentInput", { conversation, status: "queued" }).find((i) => !PASSED.includes(i.queueReason));
            if (!next || next.queueReason !== null) return undefined;
            // Claude was launched to run the interrupted turn again by itself (spawnSpec), which it
            // starts before it answers initialize. Till that answer the resume waits; then it is
            // written only if Claude had no turn to run again, say one whose message never got there.
            const ran = l.driver.info.selfStarted;
            if (next.source === "crash_resume" && ran !== undefined) {
              if (ran === null) return undefined;
              if (ran) {
                tx.update("agentInput", { id: next.id }, { status: "taken", body: null });
                continue;
              }
            }
            tx.update("agentInput", { id: next.id }, { status: "writing" });
            return next;
          }
        });
        if (!input) return;
        // Mid-turn, Claude takes a turn's frame as is and pi's driver makes it steer. A ! message
        // comes here once the turn it interrupted has ended (the router holds it till then).
        // The ack that settles it reports it written.
        await l.driver.send({ id: input.id, text: told(input), human: input.source === "human", images: images(input.images) }, "turn");
        // pi makes the session it was launched with once it reads this; Claude's is recorded from its output.
        const sessionId = l.driver.sessionOnWrite ? l.session : null;
        if (sessionId) {
          l.session = null;
          store.tx((tx) => tx.update("conversation", { id: conversation }, { sessionId }));
        }
      }
    } catch (err) {
      // It stays "writing": the connection is gone, and the exit that follows marks it unknown.
      log("cannot write to the agent", { conversation, error: String(err) });
    } finally {
      l.delivering = false;
      // A process that attached meanwhile found this busy: what is queued for it goes now.
      if (l.link && l.link !== link) void deliver(conversation);
    }
  }

  /** What the agent is told of an input: your message, written more than durations.sentAtAfter after
   *  you sent it (it waited for the quota, say), says when you sent it. Judged as it is written, not as
   *  it came (architecture §6.1). */
  function told(input: AgentInput): string {
    const body = input.body ?? "";
    // One from the board has no inbound message: the input was made as it came, its ULID's time.
    const made = () => [...input.id.slice(0, 10)].reduce((t, c) => t * 32 + B32.indexOf(c), 0);
    const sent = input.source === "human" && input.trace ? (store.tx((tx) => tx.get("inbound", input.trace!)?.receivedAt) ?? made()) : undefined;
    const now = Date.now();
    return sent !== undefined && now - sent > cfg.durations.sentAtAfter ? withSentAt(body, sent, now) : body;
  }

  /** The stored pictures of an agent input, read for the agent; one gone from disk is left out. */
  function images(json: string | null): AgentMessage["images"] {
    if (!json) return undefined;
    return (JSON.parse(json) as { path: string; mimeType: string }[]).flatMap(({ path, mimeType }) => {
      try {
        return [{ mimeType, data: readFileSync(path).toString("base64") }];
      } catch (err) {
        log("cannot read a picture for the agent", { path, error: String(err) });
        return [];
      }
    });
  }

  /** Lets the agent exit: stdin first, then TERM, then KILL (architecture §6.2). The router has
   *  recorded the stop, so the exit is not taken for a crash. Mid-turn, or with a background task,
   *  the driver won't close, so TERM cuts them short: rh stop means stop now. Still starting, the
   *  agent is stopped once start has attached it. */
  async function stop(conversation: string, brake = false): Promise<void> {
    const l = live.get(conversation);
    if (!l) return;
    l.stopping = brake ? 2 : 1;
    if (!l.link) return;
    const link = l.link;
    const exited = () => Promise.race([link.exited.then(() => true), Bun.sleep(cfg.durations.stopGrace).then(() => false)]);
    // The last catch: with the holder gone, signal fails too, and an unhandled rejection would end rhodium.
    await l.driver
      .close()
      .catch(async () => {
        await link.signal("TERM");
        if (!(await exited())) await link.signal("KILL");
      })
      .catch((err) => log("cannot stop the agent", { conversation, error: String(err) }));
  }

  // ---- After a restart (architecture §5 steps 2–4). ----

  /** Takes over every agent the last rhodium left running, and settles each one that ended while
   *  no rhodium was there. Only holder units under this rhodium's prefix count. A slot switching to
   *  the terminal has its headless agent until its pane opens; one in the terminal is off. */
  async function recover(): Promise<void> {
    const units = await activeHolders(cfg);
    const alive = store.tx((tx) =>
      tx
        .find("slot", {})
        .filter((s) => s.conversation && s.state !== "off" && s.state !== "crashed")
        .map((slot) => ({ slot, conv: tx.get("conversation", slot.conversation!)!, holder: tx.find("holder", { conversation: slot.conversation! })[0] })),
    );
    // Any other holder whose exit is not on record and whose unit is gone has ended: an older
    // rhodium dropped the exit of an agent its slot had moved away from (2026-10-22).
    const below = new Set(alive.map((a) => a.conv.id)); // settled below
    store.tx((tx) => {
      for (const h of tx.find("holder", { exited: 0 })) {
        if (below.has(h.conversation) || units.has(h.unit)) continue;
        tx.update("holder", { conversation: h.conversation }, { exited: 1 });
        const slot = tx.get("conversation", h.conversation)?.slot;
        tx.append({ source: "recovery", type: "holder_gone", ...(slot && { slot }), data: { conversation: h.conversation, unit: h.unit } });
      }
    });
    await Promise.all(
      alive.map(({ slot, conv, holder }) => {
        const p = holderPaths(cfg, conv.id);
        // The restart cut the start short, and that is no crash: before its holder was on record
        // (whatever unit and exit file the last one left), or before its agent ran.
        if (slot.state === "starting" && holder?.exited) return start(slot.id);
        if (holder && units.has(p.unit)) return reattach(slot, conv, holder);
        const exit = readExit(p.dir);
        if (slot.state === "starting" && (!exit || (exit.from === "holder" && exit.code === 0))) return start(slot.id);
        return ended(conv, holder, exit);
      }),
    );
  }

  /** Connects to a holder still running. It replays out.log from where this agent process's
   *  output begins, so the driver gets its state back before the output rhodium missed. */
  function reattach(slot: Slot, conv: Conversation, holder: Holder): Promise<void> {
    const p = holderPaths(cfg, conv.id);
    const offset = Math.min(holder.outStart, holder.outOffset);
    return attach(conv, holder.outOffset, async (me, on) => {
      const link = await connectHolder(p.sock, { boot, offset }, on).catch(async (err) => {
        // It ended after the unit check and took its socket with it: settled from its files. One
        // still up with no socket is stopped first, so no agent runs on that nothing can reach.
        if (!(await unitGone(p.unit, cfg.durations.holderGone))) {
          log("cannot reach the holder, stopping it", { conversation: conv.id, error: String(err) });
          await Bun.spawn(["systemctl", "--user", "stop", `${p.unit}.service`]).exited;
          if (!(await unitGone(p.unit, cfg.durations.holderGone))) throw err;
        }
        await ended(conv, holder, readExit(p.dir));
        return null;
      });
      if (!link) return null;
      // A stop on record before the restart, say the reap clock's at startup, is carried out now.
      me.stopping = holder.stopRequested;
      if (link.hello.pid === null) {
        await link.start(await spawnSpec(me, slot, conv)); // the restart came between launch and start
      } else {
        me.adopt = !conv.sessionId;
        me.driver.adopt?.(slot.effort, Boolean(slot.approval ?? cfg.defaults.approval), slot.model);
        settle(conv.id, link.hello);
      }
      return link;
    }, offset);
  }

  /** The inputs the last rhodium was writing when it went (§4.6): in stdin already; still on their
   *  way, so their ack is coming; or never sent, so written again. */
  function settle(conversation: string, hello: HolderLink["hello"]): void {
    const writing = store.tx((tx) => tx.find("agentInput", { conversation, status: "writing" }));
    for (const input of writing) {
      if (hello.written.includes(input.id)) report({ type: "written", inputId: input.id, conv: conversation, proc: 0 });
      else if (hello.writing !== input.id) store.tx((tx) => tx.update("agentInput", { id: input.id, status: "writing" }, { status: "queued" }));
    }
  }

  /** The holder ended while no rhodium was there (§5 step 3): first out.log from where this agent
   *  process's output begins, the part before the stored offset for state only, then the exit the
   *  exit file records. Inputs still writing become unknown. */
  async function ended(conv: Conversation, holder: Holder | undefined, exit: ExitFile | null): Promise<void> {
    const conversation = conv.id;
    const me = liveFor(conv);
    if (holder) {
      me.seen = holder.outOffset;
      me.adopt = !conv.sessionId; // its first input may have been acked while no rhodium was there
      me.driver.untaken(store.tx((tx) => untaken(tx, conversation)).map((i) => i.id));
      const from = Math.min(holder.outStart, holder.outOffset);
      const file = Bun.file(join(holderPaths(cfg, conversation).dir, "out.log"));
      const rest = await file.slice(from).bytes().catch(() => new Uint8Array());
      const end = rest.lastIndexOf(10) + 1;
      if (end) output(me, undefined, from, rest.subarray(0, end));
    }
    const e = exit ?? { from: "holder", code: null, signal: null };
    exited(conversation, me.proc, e.code, e.signal, e.from);
  }

  /** Stops the current turn; the turn's end comes from the agent as usual. */
  async function interrupt(conversation: string): Promise<void> {
    const l = live.get(conversation);
    if (!l?.link) return;
    await l.driver.interrupt().catch((err) => log("cannot interrupt the agent", { conversation, error: String(err) }));
  }

  /** /resume, Rhodium's own (product §4.7): the slot's timeline, then the other conversations its
   *  directory has; with an argument, the one its number in that list or the start of its id names. */
  async function resume(conversation: string, arg: string): Promise<CommandResult> {
    const { slot, timeline } = store.tx((tx) => {
      const [slot] = tx.find("slot", { conversation });
      return { slot, timeline: slot ? tx.find("conversation", { slot: slot.id }) : [] };
    });
    if (!slot) throw new Error("槽位已经换了对话，再发一次 /resume");
    const all = resumable(timeline, await listConversations(slot.dir), conversation);
    const shown = all.slice(0, RESUME_SHOWN);
    if (!arg) {
      const choices = shown.map((c) => ({ id: c.session, label: c.label, ...(c.current && { current: c.current }) }));
      const now = all.find((c) => c.current)?.name;
      return { command: "resume", session: null, choices, ...(now && { name: now }) };
    }
    // A number past the list may still start an id: pi's start with digits.
    const picked = /^\d+$/.test(arg) ? shown[Number(arg) - 1] : undefined;
    const hits = picked ? [picked] : all.filter((c) => c.session.startsWith(arg));
    if (hits.length !== 1) throw new Error(hits.length ? `不止一段对话的 ID 以 ${arg} 开头` : `这个槽位和目录里没有对话 ${arg}`);
    return { command: "resume", session: hits[0]!.session, agent: hits[0]!.agent, name: hits[0]!.name };
  }

  /** Runs a common command on the agent and reports the result, or why there is none. */
  async function command(e: { conversation: string; command: CommonCommand; args: string; chat: string; inbound: string; panel?: PanelUi }): Promise<void> {
    const l = live.get(e.conversation);
    // An agent still starting, say one started for this command (router), runs it once attached; one
    // whose start waits for its program, once that is back (architecture §4.2).
    // ponytail: polled, up to holdStartTimeout and on while the program is waited for; one whose start
    // failed otherwise is only given up on then.
    for (const end = Date.now() + cfg.durations.holdStartTimeout; e.command !== "resume" && l && !l.link && !l.stopping && !l.missing && (l.waiting || Date.now() < end); ) await Bun.sleep(50);
    let result: CommandResult | { error: string };
    try {
      if (e.command === "resume") result = await resume(e.conversation, e.args.trim());
      else if (!l?.link) throw new Error(l?.missing ? `找不到 ${l.missing} 程序` : "agent 没在运行");
      else result = await l.driver.command(e.command, e.args);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    report({ type: "command_result", command: e.command, chat: e.chat, inbound: e.inbound, result, conv: e.conversation, proc: l?.proc ?? 0, ...(e.panel && { panel: e.panel }) });
  }

  /** Gives the agent the answer on record, and marks it delivered once the holder has written it.
   *  With no agent attached, or one that fails to take it, it stays answered: the next handshake's
   *  list of open asks settles it (architecture §5 step 5). */
  async function answer(conversation: string, askId: string): Promise<void> {
    const l = live.get(conversation);
    const ask = store.tx((tx) => tx.get("ask", askId));
    // Once on its way, a handshake that still lists the ask must not send it a second time.
    if (!l?.link || ask?.status !== "answered" || answering.has(askId)) return;
    answering.add(askId);
    try {
      await l.driver.answer(ask.requestId!, JSON.parse(ask.answer!));
      store.tx((tx) => tx.update("ask", { id: askId, status: "answered" }, { status: "delivered", deliveredAt: Date.now() }));
    } catch (err) {
      log("cannot answer the agent", { conversation, ask: askId, error: String(err) });
    } finally {
      answering.delete(askId);
    }
  }

  /** Switches the running agent's approval mode; one still starting switches once attached. A
   *  failure goes to the router, which tells you and restarts the agent once idle. */
  async function approval(conversation: string, on: boolean): Promise<void> {
    const l = live.get(conversation);
    if (!l?.link) {
      if (l) l.reapply = true; // else its start reads the slot's setting
      return;
    }
    await l.driver.approval(on).catch((err) => {
      log("cannot switch approval mode", { conversation, error: String(err) });
      report({ type: "approval_failed", error: (err as Error).message, conv: conversation, proc: l.proc });
    });
  }

  return { start, deliver, stop, interrupt, command, recover, answer, approval };
}
