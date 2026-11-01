// The rhodium daemon: single-instance lock, boot number, the main loop and its clock,
// the rh socket and the IM bots' inbound streams (architecture §2, §5, §8, §9.1).
import { dlopen } from "bun:ffi";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { AGENT_KINDS, AGENTS } from "./agents";
import { avatarDir, errorKind, refreshAvatars } from "./avatars";
import { serveBoard, type Hear } from "./board";
import { version } from "../package.json";
import { addBot, BUILD, COMMIT, fixedOwners, loadConfig, owners, paired, renameTarget, type BotConfig, type Config } from "./config";
import type { AdapterDeps, BoardAct, Connected, ImAdapter, InboundMessage, Input, Kept, OutboundMessage, Platform, RhCaller, SendResult } from "./contracts";
import { createDoctor } from "./doctor";
import { fakeBotFromConfig } from "./fake-im";
import { makeFeishu } from "./feishu";
import { keepFile, mediaLine, storeAttachments } from "./media";
import { freeDisk, trace, upkeep } from "./ops";
import { makeQQ, msgSeq } from "./qq";
import { clip } from "./render";
import { BOARD, menus, route, type Ctx, type Decision, type Effect, type Payload, type RhReply, type Write } from "./router";
import { createRunner } from "./runner";
import { B32, MODEL_INFO, namesOf, openStore, setMeta, ulid, untaken, type EventSource, type Outbound, type Store, type Tx } from "./store";
import { makeTelegram } from "./telegram";
import { recentMessages } from "./transcript";
import { ancestors, createTui } from "./tui";

// rh read shows this many of the slot's last messages, each cut to this many characters.
const READ_COUNT = 10;
const READ_MAX = 500;

/** One JSON object per line on stderr, which journald keeps. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ msg, ...fields }));
}

/** 8 random Crockford base32 characters, 40 bits: a pairing code to type on a phone. */
const newPairCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => B32[b % 32]).join("");

/** Whether the IM message is on record already, by its chat and the platform's message id (architecture §7.3). */
function seen(tx: Tx, m: Pick<InboundMessage, "bot" | "chat" | "messageId">): boolean {
  const chat = tx.find("chat", { bot: m.bot, platformChatId: m.chat })[0];
  return chat !== undefined && tx.find("inbound", { chat: chat.id, platformMsgId: m.messageId }).length > 0;
}

// ---- Main loop: input queue -> route -> one transaction -> hand off effects. ----

export type Loop = {
  enqueue(input: Input): void;
  /** Routes the inputs and applies the writes in one transaction. Agent output comes this way, so
   *  how far out.log is processed commits with what that output changed (architecture §4.5). */
  batch(inputs: Input[], writes: Write[]): void;
};

type Batch = { inputs: Input[]; writes: Write[] };

export function createLoop(opts: {
  store: Store;
  config: Config;
  perform: (effect: Exclude<Effect, { kind: "timer" }>) => void;
  capabilities?: Ctx["capabilities"]; // the adapters' capability tables, by bot row id
  retarget?: Ctx["retarget"];
  stepped?: () => void; // after each batch of inputs has committed and its effects are handed off
}): Loop {
  const { store, config, perform, capabilities = () => undefined, stepped = () => {}, retarget = () => null } = opts;
  const queue: Batch[] = [];
  let draining = false;

  // The clock: a timer that comes due becomes an input. Timers live only in memory;
  // whoever arms one re-arms it from the state tables after a restart.
  const timers = new Map<string, Timer>();
  function arm(e: Extract<Effect, { kind: "timer" }>): void {
    const id = `${e.timer}:${e.key}`;
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (e.at === null) return;
    const at = e.at;
    const tick = () => {
      const left = at - Date.now();
      // setTimeout can't wait longer than about 24.8 days in one go.
      if (left > 0) return void timers.set(id, setTimeout(tick, Math.min(left, 2 ** 31 - 1)));
      timers.delete(id);
      batch([{ kind: "clock", timer: e.timer, key: e.key }], []);
    };
    tick();
  }

  function apply(tx: Tx, w: Write): void {
    if (w.op === "insert") tx.insert(w.table, w.row as never);
    else if (w.op === "delete") tx.delete(w.table, w.where as never);
    else tx.update(w.table, w.where as never, w.patch as never);
  }

  function step({ inputs, writes }: Batch): void {
    let effects: Effect[];
    try {
      effects = store.tx((tx) => {
        const effects: Effect[] = [];
        for (const input of inputs) {
          // Read afresh for each input, so it sees what the one before it wrote.
          const slots = tx.find("slot", {});
          const held = tx.find("outbound", { status: "held" });
          const queued = tx.find("agentInput", { status: "queued" });
          const unsure = input.kind === "agent" && input.event.type === "exit" ? untaken(tx, input.event.conv) : [];
          const state = {
            workspaces: tx.find("workspace", {}),
            slots,
            conversations: tx.find("conversation", {}),
            bots: tx.find("bot", {}),
            chats: tx.find("chat", {}),
            holders: tx.find("holder", {}),
            queued,
            quotas: [
              ...tx.find("quota", { kind: "qq_active" }),
              ...slots.flatMap((s) => (s.turnInbound ? tx.find("quota", { kind: "qq_passive", owner: s.turnInbound }) : [])),
            ],
            held,
            seen: input.kind === "im" ? seen(tx, input.message) : input.kind === "board" && store.traced(input.id).length > 0,
            hints: held.flatMap((o) => {
              const id = (JSON.parse(o.payload!) as Payload).hintedBy;
              const hint = id ? tx.get("outbound", id) : null;
              return hint ? [hint] : [];
            }),
            asks: (["deferred", "open", "answered"] as const).flatMap((status) => tx.find("ask", { status })),
            listed:
              input.kind === "agent" && input.event.type === "pending_asks"
                ? (input.event.asks ?? []).flatMap((a) => tx.find("ask", { requestId: a.requestId }))
                : input.kind === "board" && input.act.kind === "answer"
                  ? [tx.get("ask", input.act.ask)].filter((a) => a !== null)
                  : [],
            unsure,
            chatOf: Object.fromEntries(
              [...queued, ...unsure].flatMap((i) => {
                const chat = i.source === "human" && i.trace ? tx.get("inbound", i.trace)?.chat : undefined;
                return chat ? [[i.id, chat]] : [];
              }),
            ),
            quoted: input.kind === "im" ? quotedText(tx, input.message) : null,
            begun: input.kind === "agent" && input.event.type === "turn_start" && input.event.input ? begunBy(tx, input.event.input) : null,
            models: Object.fromEntries(AGENT_KINDS.filter((a) => AGENTS[a].modelNames).map((a) => [a, namesOf(tx, a)])),
            modelInfo: JSON.parse(tx.get("meta", MODEL_INFO)?.value ?? "{}"),
          };
          const keep = (path: string, max: number) => keepFile(join(config.stateDir, "media"), path, max);
          const diskFree = () => freeDisk(config.stateDir);
          const inboundOf = (chat: string) => tx.find("inbound", { chat }).map((i) => i.id);
          const d: Decision = route(state, input, { now: Date.now(), newId: ulid, newPairCode, config, capabilities, keepFile: keep, diskFree, retarget, inboundOf });
          for (const w of d.writes) apply(tx, w);
          for (const e of d.events) tx.append(e);
          // Every change of a slot's state or mode goes on the event table, which the board's live
          // view follows (architecture §7.2), whichever part of the router made it. web: in a turn
          // your message on the board began, or at its end, which the web reminds you of alone.
          for (const s of tx.find("slot", {})) {
            const was = slots.find((o) => o.id === s.id);
            const web = (s.turnChat ?? was?.turnChat) === BOARD;
            if (was && (was.state !== s.state || was.mode !== s.mode)) tx.append({ source: input.kind, type: "slot_state", slot: s.id, data: { state: s.state, mode: s.mode, ...(web && { web }) } });
          }
          effects.push(...d.effects);
        }
        for (const w of writes) apply(tx, w);
        return effects;
      });
    } catch (err) {
      log("input failed", { kinds: inputs.map((i) => i.kind), error: String(err) });
      for (const input of inputs) {
        // Else rh, or the board's page, waits for good.
        if (input.kind === "rh" || input.kind === "board") perform({ kind: "rh_reply", id: input.id, reply: { ok: false, error: `内部错误：${err}` } });
      }
      return;
    }
    for (const e of effects) {
      try {
        if (e.kind === "timer") arm(e);
        else perform(e);
      } catch (err) {
        log("effect failed", { kind: e.kind, error: String(err) });
      }
    }
    stepped();
  }

  function batch(inputs: Input[], writes: Write[]): void {
    queue.push({ inputs, writes });
    if (draining) return; // an effect fed an input back in; it runs after the current one
    draining = true;
    try {
      while (queue.length) step(queue.shift()!);
    } finally {
      draining = false;
    }
  }

  return { enqueue: (input) => batch([input], []), batch };
}

/** The stored text of the message m quotes, when the platform gave none: your message or
 *  Rhodium's, in the same chat (architecture §8.3). */
function quotedText(tx: Tx, m: InboundMessage): string | null {
  if (!m.quote || m.quote.text !== undefined) return null;
  const chat = tx.find("chat", { bot: m.bot, platformChatId: m.chat })[0];
  const where = chat && { chat: chat.id, ref: m.quote.ref };
  return (where && (tx.find("inbound", where)[0] ?? tx.find("outbound", where)[0])?.text) ?? null;
}

/** The IM message of yours the agent input carried, and its chat (the inbound id doubles as its trace);
 *  or the board's request it came in, and the board. */
function begunBy(tx: Tx, input: string): { inbound: string; chat: string } | null {
  const i = tx.get("agentInput", input);
  if (i?.source !== "human" || !i.trace) return null;
  const m = tx.get("inbound", i.trace);
  // None on record: the board's page sent it (spec web-write), and the turn is the board's.
  return m ? { inbound: m.id, chat: m.chat } : { inbound: i.trace, chat: BOARD };
}

// ---- Locks: flock on a file, freed by the kernel when we die. The holder's conversation lock is
// a flock too (Rust's File::try_lock), so each side shuts the other out. ----

let libc: ReturnType<typeof dlopen<{ flock: { args: ["i32", "i32"]; returns: "i32" } }>> | undefined;

/** Takes the lock on the file at path, made if new, without waiting: its fd, which holds the lock
 *  until closed, or null if someone else has it. */
export function lock(path: string): number | null {
  libc ??= dlopen("libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } });
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const fd = openSync(path, "a");
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return fd;
  closeSync(fd);
  return null;
}

/** The single-instance lock on a dir. Its fd stays open for the life of the process. */
const lockDir = (dir: string) => lock(join(dir, "rhodium.lock")) !== null;

// ---- The rh socket: one JSON request line in, one JSON reply line out, per connection. ----

/** What `rh` sends. credentials: rh bot's, from the scan or paste. */
export type RhRequest = { argv: string[]; caller: RhCaller; credentials?: Record<string, string> };

const MAX_REQUEST = 1 << 20;

function parseRequest(line: string): RhRequest | null {
  try {
    const r = JSON.parse(line);
    const c = r?.caller;
    const ok =
      Array.isArray(r.argv) &&
      r.argv.every((a: unknown) => typeof a === "string") &&
      typeof c === "object" &&
      c !== null &&
      (c.token === null || typeof c.token === "string") &&
      (c.pid === null || Number.isSafeInteger(c.pid)) &&
      typeof c.tty === "boolean" &&
      typeof c.cwd === "string" &&
      c.cwd.startsWith("/") &&
      (r.credentials === undefined || (typeof r.credentials === "object" && r.credentials !== null && Object.values(r.credentials).every((v) => typeof v === "string")));
    if (!ok) return null;
    const req: RhRequest = { argv: r.argv, caller: { token: c.token, pid: c.pid, tty: c.tty, cwd: c.cwd } };
    // fromEntries defines keys, so a credential named __proto__ stays one.
    if (r.credentials !== undefined) req.credentials = Object.fromEntries(Object.entries(r.credentials as Record<string, string>));
    return req;
  } catch {
    return null;
  }
}

/** The systemd service a process runs in, from its cgroup v2 path: the innermost *.service, so a
 *  holder's agent and every process under it, rh included, give the holder's unit. */
// ponytail: trusts the pid rh reports, as Bun can't read SO_PEERCRED; bun:ffi getsockopt if that matters.
function unitOf(pid: number): string | null {
  try {
    const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/^0::(.*)$/m)?.[1] ?? "";
    return [...path.matchAll(/([^/]+)\.service(?=\/|$)/g)].at(-1)?.[1] ?? null;
  } catch {
    return null; // gone already
  }
}

function serveRh(path: string, onRequest: (req: RhRequest, reply: (r: RhReply) => void) => void): Promise<void> {
  rmSync(path, { force: true }); // a socket left behind by a rhodium that died
  const server = createServer((sock: Socket) => {
    let buf = "";
    const reply = (r: RhReply) => sock.end(JSON.stringify(r) + "\n");
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > MAX_REQUEST) sock.destroy();
        return;
      }
      sock.removeAllListeners("data");
      const req = parseRequest(buf.slice(0, nl));
      if (!req) return reply({ ok: false, error: "rh 请求格式不对" });
      onRequest(req, reply);
    });
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      ok();
    });
  });
}

// ---- Outbound: pending, sending, then sent or failed (architecture §7.4). ----

/** Waits for the chat's (row id) next turn to talk to the platform: on a platform with a rate
 *  limit (Telegram), one request a chat, sends and edits alike, every 1/perChatPerSecond s (architecture §8.2). */
type Pace = (chat: string, adapter: ImAdapter) => Promise<void>;
/** The outbound record's message went out, or was edited, just now: on a platform with editEvery
 *  (Feishu), its next edit waits that long from now (architecture §8.2). */
type Touched = (outbound: string, adapter: ImAdapter) => void;

/** An outbound record that may or may not have arrived, and is never sent again: on record for the
 *  board's recent events (product §11). */
function noteUnknown(tx: Tx, source: EventSource, row: Outbound, error: string): void {
  tx.append({ source, type: "outbound_unknown", ...(row.trace && { trace: row.trace }), data: { outbound: row.id, error } });
}

/** After a restart (architecture §5 step 8): what the last rhodium was sending may have arrived, so it
 *  is unknown; what it had pending goes out now. Returns the pending ones. */
function settleOutbound(store: Store): string[] {
  return store.tx((tx) => {
    for (const row of tx.find("outbound", { status: "sending" })) {
      tx.update("outbound", { id: row.id }, { status: "unknown" });
      noteUnknown(tx, "recovery", row, "rhodium restarted mid-send");
      log("send outcome unknown", { outbound: row.id, reason: "rhodium restarted mid-send" });
    }
    return tx.find("outbound", { status: "pending" }).map((o) => o.id);
  });
}

/** Sends one pending outbound record. It waits for its chat's turn first, then is marked sending
 *  right before the platform call, so a restart in between never sends it twice, and one during the
 *  wait still sends it; a failure is recorded and never retried. */
async function send(store: Store, adapters: Map<string, ImAdapter>, id: string, loop: Loop, pace: Pace, quoteMax: number, touched: Touched): Promise<void> {
  const seq = msgSeq(id);
  const chat = store.tx((tx) => {
    const row = tx.get("outbound", id);
    return row?.payload && row.status === "pending" ? tx.get("chat", row.chat)! : null;
  });
  if (!chat) return;
  const adapter = adapters.get(chat.bot);
  if (adapter) await pace(chat.id, adapter);
  const job = store.tx((tx) => {
    const row = tx.get("outbound", id);
    if (!row?.payload || !tx.update("outbound", { id, status: "pending" }, { status: "sending", qqSeq: seq })) return null;
    const replyTo = row.replyTo ? tx.get("inbound", row.replyTo)?.platformMsgId : undefined;
    const payload = JSON.parse(row.payload) as Payload;
    // An ask settled before its message went out gets no buttons to answer it with.
    const buttons = payload.buttons && (!payload.ask || tx.get("ask", payload.ask)?.status === "open") ? payload.buttons : undefined;
    const message: OutboundMessage = { text: payload.text, ...(payload.markdown !== undefined && { markdown: payload.markdown }), replyTo, seq, ...(payload.file && { file: payload.file }), ...(buttons && { buttons }) };
    return { row, payload, message };
  });
  if (!job) return;
  const r: SendResult = adapter ? await adapter.send(chat.platformChatId, job.message) : { status: "failed", error: "the bot has no adapter" };
  if (r.status === "sent") touched(id, adapter!);
  // Once sent, the message gives way to the start of its text, kept for a later quote of it (architecture §8.3);
  // a pairing code, to nothing (§9.9).
  const { file } = job.payload;
  const text = job.payload.secret ? null : clip(file ? mediaLine(file) : job.payload.text, quoteMax);
  store.tx((tx) => {
    tx.update(
      "outbound",
      { id },
      r.status === "sent"
        ? { status: "sent", platformMsgId: r.messageId ?? null, ref: r.ref ?? r.messageId ?? null, payload: null, text, ask: job.payload.ask ?? null }
        : { status: r.status },
    );
    // The ask it carries has reached you, so your plain reply can answer it (product §5.3).
    if (r.status === "sent" && job.payload.ask) tx.update("ask", { id: job.payload.ask, pushedAt: null }, { pushedAt: Date.now() });
    if (r.status === "unknown") noteUnknown(tx, "im", job.row, r.error);
  });
  if (r.status === "sent") return;
  log("send failed", { outbound: id, status: r.status, error: r.error });
  // The router sends it some other way (product §5.5). A hint that can't go out has nothing to wait
  // for; nor has a held message refused again on a fresh passive reply, likely for good (moderation).
  if (r.status === "failed" && r.quota && !job.payload.hint && !job.payload.released) {
    loop.enqueue({ kind: "refused", outbound: id, chat: chat.id, inbound: job.row.replyTo, payload: job.row.payload! });
  }
}

/** How the daemon makes each platform's adapter for a [bots.<name>] table (architecture §8.1): id is
 *  the bot's row id. Loaded with the IM SDKs, so by rhodium alone, not by rh. */
export const ADAPTERS: Record<Platform, (id: string, name: string, bot: BotConfig, deps: AdapterDeps) => ImAdapter> = {
  qq: makeQQ,
  telegram: makeTelegram,
  feishu: makeFeishu,
  fake: fakeBotFromConfig,
};

/** The meta rows and events an adapter keeps in the store. */
export const kept = (store: Store): Kept => ({
  get: (key) => store.tx((tx) => tx.get("meta", key)?.value),
  set: (key, value) => (value === undefined ? store.tx((tx) => void tx.delete("meta", { id: key })) : setMeta(store, key, value)),
  event: (type, data) => store.tx((tx) => void tx.append({ source: "im", type, data })),
});

/** A bot's connection as its adapter last told it (architecture §8.6): on record for the board, with
 *  an event and a log line when it changes. A faulted bot stays so till the router hears it is back. */
function connection(store: Store, bot: string, up: boolean): void {
  const state = up ? "online" : "reconnecting";
  const name = store.tx((tx) => {
    const row = tx.get("bot", bot);
    if (!row || row.connState === state || row.connState === "faulted") return null;
    tx.update("bot", { id: bot }, { connState: state });
    tx.append({ source: "im", type: "bot_connection", data: { bot: row.name, state } });
    return row.name;
  });
  if (name) log("bot connection", { bot: name, state });
}

// ---- Startup. ----

export async function runDaemon(args: string[]): Promise<void> {
  const env = process.env;
  let configPath = `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/rhodium/config.toml`;
  if (args[0] === "--config" && args[1] && args.length === 2) configPath = args[1];
  else if (args.length) {
    console.error("usage: rhodium [--config <path>]");
    process.exit(2);
  }

  process.umask(0o077); // the db, sockets and logs are private
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    log("cannot load config", { path: configPath, error: (err as Error).message });
    process.exit(1);
  }
  // Run by hand, by rh dev or in a Herdr pane, the configured unit's journal is some other process's, if anything.
  if (unitOf(process.pid) !== config.unit) config.unit = "";
  for (const dir of [config.stateDir, config.socketDir, config.lockDir]) mkdirSync(dir, { recursive: true });
  // The socket dir too: a second rhodium there would unlink the first one's rh.sock.
  // A Set, because a second flock on the same file would fail against our own first one.
  for (const dir of new Set([config.stateDir, config.socketDir])) {
    if (!lockDir(dir)) {
      log("another rhodium is running on this state or socket dir", { dir });
      process.exit(1);
    }
  }

  const store = openStore(join(config.stateDir, "rh.db"));
  const boot = Number(store.tx((tx) => tx.get("meta", "boot")?.value ?? 0)) + 1;
  setMeta(store, "boot", String(boot));
  const pending = settleOutbound(store); // before this rhodium sends anything
  upkeep(config, store);

  const waiting = new Map<string, (r: RhReply) => void>();
  const answer = (id: string, reply: RhReply) => {
    waiting.get(id)?.(reply);
    waiting.delete(id);
  };
  // ponytail: one queue for every chat, so a turn's segments arrive in order, and a send waiting out a
  // Telegram chat's spacing holds up other chats' sends too; per chat if sends pile up.
  let sending = Promise.resolve();
  const queueSend = (id: string) => {
    sending = sending.then(() => send(store, adapters, id, loop, pace, config.limits.quoteMaxChars, touched)).catch((err) => log("send failed", { outbound: id, error: String(err) }));
  };
  const adapters = new Map<string, ImAdapter>(); // by bot row id
  const capabilities: Ctx["capabilities"] = (bot) => adapters.get(bot)?.capabilities;

  // The row and the / menu (architecture §8.4), worked out afresh after every input: each is pushed
  // only when its hash, with the chat it goes to, differs from that of the one last pushed. One sync
  // at a time, and at most one more waiting, however many inputs come meanwhile.
  // A failed push is tried again with the first input once durations.menuRetry has passed, not with
  // every input; the other of the two goes on as it would.
  const failed = new Map<string, { hash: string; at: number }>(); // by the bot row id, the chat and the hash column
  let syncing = Promise.resolve();
  let syncQueued = false;
  function syncMenus(): void {
    if (syncQueued) return;
    syncQueued = true;
    syncing = syncing.then(async () => {
      syncQueued = false;
      const state = store.tx((tx) => ({
        workspaces: tx.find("workspace", {}),
        slots: tx.find("slot", {}),
        conversations: tx.find("conversation", {}),
        bots: tx.find("bot", {}),
        chats: tx.find("chat", {}),
      }));
      for (const want of menus(state, { config, capabilities })) {
        const bot = state.bots.find((b) => b.id === want.bot)!;
        const adapter = adapters.get(want.bot)!;
        // Telegram's row is a message: behind what the send queue holds by now, 已配对 say, at the chat's pace.
        const chat = state.chats.find((c) => c.bot === want.bot && c.platformChatId === want.chat);
        const setRow = async () => {
          if (adapter.capabilities.menu.row === "reply_keyboard") {
            await sending;
            await pace(chat?.id ?? `${want.bot} ${want.chat}`, adapter);
          }
          await adapter.setRow(want.row!, want.chat);
        };
        // The row first: it changes the least.
        const pushes = [
          ...(want.row ? [["rowHash", want.row, setRow] as const] : []),
          ["menuHash", want.menu, () => adapter.setMenu(want.menu, want.chat)] as const,
        ];
        // Where there is one of each per chat, the bot keeps them by the chat (store.ts Bot).
        const kept = (column: "rowHash" | "menuHash") => (want.chat === undefined ? bot[column] : (JSON.parse(bot[column] ?? "{}")[want.chat] ?? null));
        for (const [column, body, push] of pushes) {
          const hash = Bun.hash(JSON.stringify([want.chat, body])).toString(36);
          const key = `${want.bot} ${want.chat} ${column}`;
          const f = failed.get(key);
          if (kept(column) === hash || (f?.hash === hash && Date.now() - f.at < config.durations.menuRetry)) continue;
          try {
            await push();
            store.tx((tx) => {
              const now = tx.get("bot", want.bot)![column];
              tx.update("bot", { id: want.bot }, { [column]: want.chat === undefined ? hash : JSON.stringify({ ...JSON.parse(now ?? "{}"), [want.chat]: hash }) });
            });
            failed.delete(key);
          } catch (err) {
            failed.set(key, { hash, at: Date.now() });
            log("menu push failed", { bot: want.bot, what: column, error: String(err) });
          }
        }
      }
    });
  }

  const loop = createLoop({
    store,
    config,
    capabilities,
    stepped: () => syncMenus(),
    retarget(from, to) {
      const done = renameTarget(configPath, from, to);
      // So too the config as read at start: the file may say so only now, or not yet.
      for (const bot of Object.values(config.bots)) if (bot.target === from) bot.target = to;
      if (done) log("config target renamed", { from, to, bots: done.bots, backup: done.backup });
      return done;
    },
    perform(e) {
      switch (e.kind) {
        case "rh_reply":
          return answer(e.id, e.reply);
        case "add_bot": {
          let bot: BotConfig;
          try {
            bot = addBot(configPath, e.name, e.table);
          } catch (err) {
            log("cannot write the bot into the config", { bot: e.name, error: (err as Error).message });
            return answer(e.id, { ok: false, error: `没能把 Bot ${e.name} 写进配置文件 ${configPath}：${(err as Error).message}` });
          }
          // Taken in at once, with no restart (architecture §8.5): this bot alone, so the rest of a
          // config edited by hand still waits for one (product §10).
          config.bots[e.name] = bot;
          const id = takeIn(e.name, bot);
          listen(id);
          avatars(id);
          // Never the table itself: it holds the bot's credentials.
          log("bot added", { bot: e.name, platform: bot.platform });
          return;
        }
        case "avatars":
          return avatars(e.bot);
        case "forget_avatar":
          for (const f of [e.chat, `${e.chat}.name`]) rmSync(join(avatarDir(config), f), { force: true });
          return;
        case "doctor":
          return void doctor.run(true).then(
            (text) => answer(e.id, { ok: true, text }),
            (err) => answer(e.id, { ok: false, error: `rh doctor 出错：${err}` }),
          );
        case "trace":
          return answer(e.id, trace(store, e.message, config));
        case "read":
          return void (e.session ? recentMessages(e.dir, e.agent, e.session, READ_COUNT, READ_MAX) : Promise.resolve([])).then(
            (talk) => {
              const lines = talk.map((m) => `${m.role === "user" ? "收到" : "回复"}：${m.text}`);
              const tail = lines.length ? [`最近的对话（最多 ${READ_COUNT} 条，早的在前）：`, ...lines] : ["还没有对话记录。"];
              answer(e.id, { ok: true, text: [e.text, "", ...tail].join("\n") });
            },
            (err) => answer(e.id, { ok: false, error: `读不了对话记录：${err}` }),
          );
        case "start":
          return void runner.start(e.slot);
        case "deliver":
          return void runner.deliver(e.conversation);
        case "stop":
          return void runner.stop(e.conversation, e.brake);
        case "interrupt":
          return void runner.interrupt(e.conversation);
        case "command":
          return void runner.command(e);
        case "answer":
          return void runner.answer(e.conversation, e.ask);
        case "approval":
          return void runner.approval(e.conversation, e.on);
        case "send":
          return queueSend(e.outbound);
        case "edit":
          return edit(e);
        case "unbutton":
          return unbutton(e);
        case "redraw":
          return redraw(e);
        case "toast": {
          const chat = store.tx((tx) => tx.get("chat", e.chat));
          const adapter = chat && adapters.get(chat.bot);
          return void adapter?.answerPress(chat!.platformChatId, e.press, e.text).catch((err) => log("cannot answer a button press", { error: String(err) }));
        }
        case "tui_open":
          return tui.open(e.slot);
        case "tui_back":
          return tui.back(e.slot, e.force);
        case "tab_label":
          return tui.label(e.slot);
        case "import":
          return tui.import(e);
      }
    },
  });

  const nextAt = new Map<string, number>(); // by chat row id: when it may have its next request
  const pace: Pace = (chat, adapter) => {
    const limit = adapter.capabilities.sendLimit;
    if (limit.kind !== "rate") return Promise.resolve();
    // The turn is taken before the wait, so a send and an edit waiting at once go one after the other.
    const at = Math.max(Date.now(), nextAt.get(chat) ?? 0);
    nextAt.set(chat, at + 1000 / limit.perChatPerSecond);
    return Bun.sleep(at - Date.now());
  };
  // When each message on a platform with editEvery last went out or was edited, by outbound id; those
  // past editEvery are of no more use. After a restart, a message's record's creation stands in.
  const lastTouched = new Map<string, number>();
  const touched: Touched = (id, adapter) => {
    const every = adapter.capabilities.editEvery;
    if (!every) return;
    const now = Date.now();
    for (const [o, at] of lastTouched) if (now - at >= every) lastTouched.delete(o);
    lastTouched.set(id, now);
  };

  // The message an edit platform keeps editing through a turn (architecture §8.2), by outbound id:
  // one request in flight at a time, at the platform's pace; newer text replaces what has not gone out.
  const editing = new Map<string, { text: string; markdown?: string; final: boolean }>();
  function edit(e: Extract<Effect, { kind: "edit" }>): void {
    const id = e.outbound;
    const queued = editing.get(id);
    if (queued) return void Object.assign(queued, { text: e.text, markdown: e.markdown, final: queued.final || !!e.final });
    const job = { text: e.text, markdown: e.markdown, final: !!e.final };
    editing.set(id, job);
    // Behind the message's own send, which is on the send queue already.
    const ahead = sending;
    void ahead.then(async () => {
      // Its send was put off, say to go through another bot (refused): edited once that has gone.
      for (let behind = ahead; store.tx((tx) => tx.get("outbound", id))?.status === "pending" && sending !== behind; ) {
        behind = sending;
        await behind;
      }
      const row = store.tx((tx) => tx.get("outbound", id));
      const chat = row && store.tx((tx) => tx.get("chat", row.chat));
      // The router sends what this edit was to show as a new message instead.
      const failed = (why: Record<string, unknown>) => {
        editing.delete(id);
        log("edit failed", { outbound: id, ...why });
        if (row) loop.enqueue({ kind: "edit_failed", outbound: id, chat: row.chat, trace: row.trace, text: job.text, markdown: job.markdown, final: job.final });
      };
      try {
        const adapter = chat && adapters.get(chat.bot);
        const unchanged = e.unchanged && job.text === e.text;
        // Its send may have arrived with this very text: never twice (architecture §7.4).
        if (row?.status === "unknown" && unchanged) return;
        // Its send failed or may not have arrived: nothing to edit.
        if (!row?.platformMsgId || !chat || !adapter) return failed({ reason: "no sent message to edit" });
        if (unchanged) return;
        for (;;) {
          const every = adapter.capabilities.editEvery;
          if (every) await Bun.sleep((lastTouched.get(id) ?? row.createdAt) + every - Date.now());
          await pace(chat.id, adapter);
          const { text, markdown } = job;
          const r = await adapter.edit(chat.platformChatId, row.platformMsgId, { text, ...(markdown !== undefined && { markdown }) });
          if (r.status !== "failed") touched(id, adapter);
          // Turned down. One that may have taken is left at that: rather than show the text twice.
          // One over the flood limit too: a new message now would be turned down as well.
          if (r.status === "failed" && r.flood) return log("edit failed", { outbound: id, error: r.error, flood: true });
          if (r.status === "failed") return failed({ status: r.status, error: r.error });
          if (r.status === "unknown") log("edit outcome unknown", { outbound: id, error: r.error });
          // What it shows now, for a later quote of it (architecture §8.3).
          else store.tx((tx) => tx.update("outbound", { id }, { text: clip(text, config.limits.quoteMaxChars) }));
          if (job.text === text) break;
        }
      } catch (err) {
        log("edit failed", { outbound: id, error: String(err) });
      } finally {
        // In the same step as the last look at job.text, so no new text is missed; not a newer job of a failed one.
        if (editing.get(id) === job) editing.delete(id);
      }
    });
  }
  /** Takes the buttons off the messages that ask the ask (story 82), at the platform's pace and
   *  behind the send queue, so one still going out is sent by then. */
  function unbutton({ ask, text }: Extract<Effect, { kind: "unbutton" }>): void {
    void sending.then(async () => {
      const sent = store.tx((tx) => tx.find("outbound", { ask, status: "sent" }).map((o) => ({ o, chat: tx.get("chat", o.chat)! })));
      for (const { o, chat } of sent) {
        const adapter = adapters.get(chat.bot);
        if (!adapter) continue;
        await pace(chat.id, adapter);
        const shown = text !== undefined && adapter.capabilities.progress === "edit";
        let r = shown ? await adapter.edit(chat.platformChatId, o.platformMsgId!, { text, buttons: [] }) : undefined;
        // One that won't take the words (too long, say) still loses its buttons.
        if (r?.status !== "sent") r = await adapter.dropButtons(chat.platformChatId, o.platformMsgId!);
        if (r.status !== "sent") log("buttons not taken off", { outbound: o.id, status: r.status, error: r.error });
      }
    }).catch((err) => log("buttons not taken off", { ask, error: String(err) }));
  }

  /** A panel's next step on a platform that edits (docs/im-style.md §9.1): the message shows it in place,
   *  behind the send queue, so a panel still going out is sent by then. One that can't be edited, say
   *  its send failed, goes as a new message instead, with no record: it is a view, not a reply to keep. */
  function redraw(e: Extract<Effect, { kind: "redraw" }>): void {
    void sending
      .then(async () => {
        const chat = store.tx((tx) => tx.get("chat", e.chat));
        const adapter = chat && adapters.get(chat.bot);
        if (!chat || !adapter) return;
        const message = "message" in e.at ? e.at.message : store.tx((tx) => tx.get("outbound", (e.at as { outbound: string }).outbound)?.platformMsgId);
        const shown = { text: e.text, buttons: e.buttons, ...(e.markdown !== undefined && { markdown: e.markdown }) };
        await pace(chat.id, adapter);
        const r = message ? await adapter.edit(chat.platformChatId, message, shown) : { status: "failed" as const, error: "no sent message to edit" };
        if (r.status !== "failed" || r.flood) return;
        log("panel not redrawn, sending it anew", { chat: chat.id, error: r.error });
        await pace(chat.id, adapter);
        const sent = await adapter.send(chat.platformChatId, shown);
        if (sent.status !== "sent") log("panel not sent", { chat: chat.id, error: sent.error });
      })
      .catch((err) => log("panel not redrawn", { chat: e.chat, error: String(err) }));
  }

  const recovered = Promise.withResolvers<void>();
  const doctor = createDoctor({
    cfg: config,
    store,
    ready: recovered.promise,
    notify(text) {
      log("rh doctor found problems", { report: text }); // also for an instance with no main chat
      loop.enqueue({ kind: "notice", text: `rh doctor 自检：\n${text}` });
    },
  });
  const tui = createTui({ cfg: config, store, loop });
  const hearing = new Set<Hear>(); // the board, once it is up
  const runner = createRunner({
    cfg: config,
    store,
    boot,
    loop,
    capabilities: (bot) => adapters.get(bot)?.capabilities,
    onVersion: (v) => doctor.versionSeen(v),
    inUse: tui.inUse,
    writing: (conversation, e) => hearing.forEach((hear) => hear(conversation, e)),
  });
  // Timers live only in memory: each one-off slot's archive clock is set again from the slot table.
  for (const s of store.tx((tx) => tx.find("slot", { lifetime: "oneoff", archivedAt: null }))) {
    loop.enqueue({ kind: "clock", timer: "oneoff_archive", key: s.id });
  }
  // So is each open ask's timeout, from its deadline.
  for (const a of store.tx((tx) => tx.find("ask", { status: "open" }))) {
    if (a.deadline !== null) loop.enqueue({ kind: "clock", timer: "ask_timeout", key: a.id });
  }

  /** Takes the [bots.<name>] table in: its bot row, which it keeps across restarts, and its adapter,
   *  not yet listening. Returns the row id. */
  function takeIn(name: string, bot: BotConfig): string {
    const id = store.tx((tx) => {
      const { id } = tx.find("bot", { name })[0] ?? tx.insert("bot", { platform: bot.platform, name, isMain: 0 });
      // The owners its config table names are owners as it says (owners()), not as a pairing did: one
      // paired before is dropped, so it is no owner once the config leaves it out (architecture §8.5).
      const row = tx.get("bot", id)!;
      const fixed = fixedOwners(bot);
      if (paired(row).some((o) => fixed.includes(o))) tx.update("bot", { id }, { owners: JSON.stringify(paired(row).filter((o) => !fixed.includes(o))) });
      // Not connected yet: the last rhodium's word on it is old news.
      tx.update("bot", { id }, { connState: null });
      return id;
    });
    const deps: AdapterDeps = { kept: kept(store), seen: (chat, messageId) => store.tx((tx) => seen(tx, { bot: id, chat, messageId })), durations: config.durations };
    adapters.set(id, ADAPTERS[bot.platform](id, name, bot, deps));
    return id;
  }
  try {
    for (const [name, bot] of Object.entries(config.bots)) takeIn(name, bot);
  } catch (err) {
    log("cannot start bots", { error: (err as Error).message });
    process.exit(1);
  }
  for (const id of pending) queueSend(id); // now that their bots have adapters
  // Architecture §5 steps 2–4, before IM messages come in. Sending needs no inbound connection,
  // so a reply the agents finished meanwhile goes out now.
  try {
    await runner.recover();
    recovered.resolve();
  } catch (err) {
    log("cannot take over the running agents", { error: String(err) });
    process.exit(1);
  }
  // Wakes waiting for room, only now: recover starts any slot it finds starting, so a slot this
  // had started before it would have been started twice.
  loop.enqueue({ kind: "recovery" });
  // A build the main chat has not heard of says so there, once, with the note upgrade.sh built it
  // with (architecture §12). Run from source with no commit, it is no build to tell of.
  if (COMMIT && store.tx((tx) => tx.get("meta", "toldBuild")?.value) !== BUILD) {
    const note = process.env.RHODIUM_BUILD_NOTE;
    loop.enqueue({ kind: "notice", text: `升级到 ${version}（${COMMIT}）${note ? `：${note}` : "。"}` });
    setMeta(store, "toldBuild", BUILD);
  }
  // So is each idle slot's reap clock, set only now: an agent that died meanwhile is a crash, not
  // one reaped (architecture §4.8).
  for (const s of store.tx((tx) => tx.find("slot", { state: "idle" }))) loop.enqueue({ kind: "clock", timer: "idle_reap", key: s.id });
  // And each quota wait's clock (architecture §7.6).
  for (const s of store.tx((tx) => tx.find("slot", { state: "rate_limited" }))) loop.enqueue({ kind: "clock", timer: "quota_reset", key: s.id });
  // And the minute clock of a step a turn's message shows running (im-style §3.1), which shows the
  // minutes at once; it stops once no step runs.
  for (const s of store.tx((tx) => [...tx.find("slot", { state: "running" }), ...tx.find("slot", { state: "waiting" })])) {
    if (s.conversation) loop.enqueue({ kind: "clock", timer: "tool_running", key: s.conversation });
  }
  // And the notice of a quota wait you have yet to hear of, at once.
  // Each agent's, as its quota is its own.
  const untold = store.tx((tx) => tx.find("slot", { state: "rate_limited", quotaUntold: 1 }).map((s) => tx.get("conversation", s.conversation!)?.agent));
  for (const agent of new Set(untold)) if (agent) loop.enqueue({ kind: "clock", timer: "quota_notice", key: agent });
  syncMenus();
  // Pictures and files are downloaded for your messages only, and kept by their hash before routing
  // (architecture §8.3), so a stranger can't fill the disk. One at a time: messages stay in order.
  const media = join(config.stateDir, "media");
  const yours = (m: InboundMessage) => store.tx((tx) => {
    const bot = tx.get("bot", m.bot);
    return !!bot && owners(bot, config).includes(m.sender);
  });
  // A message's bot and chat as Rhodium names them; a chat not yet routed to has no id yet.
  const named = (m: InboundMessage) =>
    store.tx((tx) => ({ bot: tx.get("bot", m.bot)?.name, chat: tx.find("chat", { bot: m.bot, platformChatId: m.chat })[0]?.id }));
  /** Connects the bot (row id) taken in, and hands what comes to the main loop. */
  function listen(bot: string): void {
    const adapter = adapters.get(bot)!;
    // Its failures in a row: at limits.botFailures the router marks it faulted and tells you, and the
    // first time it gets through after that, back (architecture §8.6).
    let failures = 0;
    const connected: Connected = (up, error) => {
      const { botFailures } = config.limits;
      if (up && failures >= botFailures) loop.enqueue({ kind: "connection", bot, up: true });
      if (up) failures = 0;
      else if (++failures === botFailures) {
        log("bot keeps failing to reach its platform", { bot, failures, error });
        loop.enqueue({ kind: "connection", bot, up: false, error });
      }
      connection(store, bot, up);
    };
    void (async () => {
      for await (const m of adapter.messages(connected)) loop.enqueue({ kind: "im", message: yours(m) ? await storeAttachments(media, m, (msg, f) => log(msg, { ...named(m), ...f })) : m });
    })();
  }
  for (const bot of adapters.keys()) listen(bot);
  // The bots' avatars and yours, and your Telegram name, for the board's topology (spec web-topology):
  // now, then once a day; a bot taken in, or one your private chat with is new, that bot's at once.
  // One that fails keeps the last.
  const avatars = (bot?: string) => {
    const which = bot === undefined ? adapters : new Map([...adapters].filter(([id]) => id === bot));
    void refreshAvatars(store, config, which).catch((err) => log("cannot keep avatars", { error: errorKind(err) }));
  };
  avatars();
  setInterval(() => avatars(), 86_400_000);

  const socket = join(config.socketDir, "rh.sock");
  await serveRh(socket, (req, reply) => {
    const id = ulid();
    waiting.set(id, reply);
    const pid = req.caller.pid;
    const caller = { ...req.caller, unit: pid === null ? null : unitOf(pid), ancestors: pid === null ? [] : ancestors(pid) };
    loop.enqueue({ kind: "rh", id, caller, argv: req.argv, credentials: req.credentials });
  });
  // IM and rh go on without the board. What its page writes comes to the main loop as rh does.
  let board = "";
  try {
    const act = (id: string, a: BoardAct) =>
      new Promise<RhReply>((reply) => {
        waiting.set(id, reply);
        loop.enqueue({ kind: "board", id, act: a });
      });
    const server = serveBoard(store, config, hearing, undefined, act);
    board = `${server.hostname}:${server.port}`;
  } catch (err) {
    log("cannot start the board", { port: config.board.port, error: String(err) });
  }
  log("ready", { boot, socket, board, stateDir: config.stateDir, programs: config.programs });
}
