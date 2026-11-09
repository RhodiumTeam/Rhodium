// The fake IM platform (docs/spec/v1.md, seam one). A real platform Rhodium can enable like QQ or
// Telegram. The platform runs outside rhodium, in the test process or `rh dev --fake`, so it
// outlives rhodium restarts as a real one does. Rhodium's FakeBot adapters and the tests' FakeImClient
// both reach it through one local socket.
import { chmodSync, rmSync } from "node:fs";
import type { BotConfig } from "./config";
import type {
  AdapterDeps,
  Capabilities,
  Connected,
  ImAdapter,
  InboundMessage,
  MenuItem,
  RowButton,
  OutboundMessage,
  Profile,
  SendResult,
} from "./contracts";
import { feishuCapabilities, PLATFORMS, QQ_CAPABILITIES, TELEGRAM_CAPABILITIES } from "./platforms";
import { withKeyboard } from "./qq";

/** The platforms of architecture §8.1, as far as their capability tables go; Feishu's edits at most
 *  every 3 s, as durations.feishuEdit has it by default. */
export const fakeLike = { qq: QQ_CAPABILITIES, telegram: TELEGRAM_CAPABILITIES, feishu: feishuCapabilities(3000) } satisfies Record<string, Capabilities>;

/** A fake bot's capability table, as its like and its own keys say (platforms.ts); feishuEdit is
 *  durations.feishuEdit. */
export const fakeCapabilities = (bot: BotConfig, feishuEdit = 3000): Capabilities => PLATFORMS.fake.capabilities(bot, { feishuEdit });

/** Rhodium's adapter for a [bots.<name>] table with platform = "fake": like picks the capability
 *  table, socket is where the platform listens. id is the bot's row id. */
export function fakeBotFromConfig(id: string, name: string, bot: BotConfig, { durations }: AdapterDeps): FakeBot {
  if (!bot.socket) throw new Error(`config: bots.${name} needs socket = the fake IM platform's socket path`);
  return new FakeBot(bot.socket, { id, name, capabilities: PLATFORMS.fake.capabilities(bot, durations) });
}

/** What a test injects: an inbound message as the platform would deliver it. */
export type Injection = Omit<InboundMessage, "bot" | "messageId" | "at" | "attachments"> & {
  messageId?: string;
  at?: number;
  // fail: the download fails with this error.
  attachments?: { kind: "image" | "file"; name?: string; data: Uint8Array; fail?: string }[];
};

/** One send or edit as the platform received it, at when (ms) it arrived. unbutton: the message's
 *  buttons taken off (text ""); toast: the answer to a button press, messageId the press's.
 *  buttonsHidden: its buttons are not shown, being on a message that is not Markdown where buttons
 *  show on Markdown only (QQ, 2026-10-22). */
export type Posted = { kind: "send" | "edit" | "unbutton" | "toast"; messageId: string; at: number; buttonsHidden?: true } & OutboundWire;

/** An outbound message on the socket: a file goes as its name and its bytes in base64. */
type OutboundWire = Omit<OutboundMessage, "file"> & { file?: { kind: "image" | "file"; name: string; data: string } };

/** timeout: the platform took the message, but the bot never heard back. hang: it took the message
 *  and holds the request open till the bot hangs up, say a rhodium killed mid-send. refuse: it turned
 *  the message down for another reason than its quota, as QQ does an active message you turned off. */
export type Outcome = "ok" | "fail" | "timeout" | "hang" | "refuse";

/** name is the [bots.<name>] key tests and rhodium address the bot by. A QQ-like bot takes
 *  passiveReplies to each inbound message (limits.qqPassiveReplies) for passiveWindowMs after it
 *  (durations.qqPassiveWindow), and activeMessages in all to each chat, unlimited if left out, and
 *  refuses the rest as QQ does. */
export type PlatformBotOptions = { name: string; capabilities: Capabilities; passiveReplies?: number; passiveWindowMs?: number; activeMessages?: number };

/** Rhodium's side: id is the bot's row id, which the adapter stamps on every inbound message. */
export type FakeBotOptions = { id: string; name: string; capabilities: Capabilities };

/** Attachments travel the socket as base64. */
type Wire = Omit<InboundMessage, "bot" | "attachments"> & {
  attachments?: { kind: "image" | "file"; name?: string; data: string; fail?: string }[];
};
type Update = { seq: number; message: Wire };

/** The fake platform's avatar: a 1x1 grey PNG. */
export const FAKE_AVATAR = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==");

const POLL_MS = 5_000; // under Bun.serve's 10 s idle timeout
const RETRY_MS = 100;

/** One bot as the platform sees it. */
class PlatformBot {
  readonly capabilities: Capabilities;
  private readonly passiveReplies: number;
  private readonly passiveWindowMs: number;
  private readonly activeMessages: number;
  private up = true;
  private polls = 0; // long polls in flight
  private seq = 0;
  private inbound: Update[] = []; // delivered to the platform, not yet acked by the bot
  private changed = Promise.withResolvers<void>();
  private readonly delivered = new Map<string, number>(); // chat + "\n" + messageId -> at
  private readonly chats = new Map<string, Posted[]>();
  private readonly menus = new Map<string, MenuItem[]>(); // "" is the bot-wide menu
  readonly menuPushes: { chat?: string; items: MenuItem[] }[] = []; // every / menu the bot set, oldest first
  readonly rowPushes: { chat?: string; row: RowButton[]; at: number }[] = []; // every row the bot set, oldest first, at when (ms)
  private readonly outcomes: { outcome: Outcome; on?: Posted["kind"] | "row" }[] = [];

  constructor(
    opts: PlatformBotOptions,
    private readonly newId: () => string,
  ) {
    this.capabilities = opts.capabilities;
    this.passiveReplies = opts.passiveReplies ?? 20; // as limits.qqPassiveReplies has it (product §5.5)
    this.passiveWindowMs = opts.passiveWindowMs ?? 3_600_000;
    this.activeMessages = opts.activeMessages ?? Infinity;
  }

  /** Break the bot's connection, or let it back. Down for good is a bot that never connects. */
  connect(up: unknown) {
    if (typeof up !== "boolean") throw new Error(`up must be true or false, not ${JSON.stringify(up)}`);
    this.up = up;
    this.wake();
  }

  private wake() {
    this.changed.resolve();
    this.changed = Promise.withResolvers();
  }

  inject(m: Omit<Wire, "messageId" | "at"> & { messageId?: string; at?: number }): { messageId: string } {
    if (!this.up) throw new Error("the bot is not connected, so the platform cannot deliver");
    if (m.button && !this.capabilities.buttons) throw new Error("this platform has no buttons to press");
    if (m.button && this.log(m.chat).some((p) => p.messageId === m.button!.message && p.buttonsHidden)) throw new Error("that message shows no keyboard to press");
    const messageId = m.messageId ?? this.newId();
    const at = m.at ?? Date.now();
    const key = `${m.chat}\n${messageId}`;
    // A resent message keeps the reply quota it had.
    if (!this.delivered.has(key)) this.delivered.set(key, at);
    this.inbound.push({ seq: ++this.seq, message: { ...m, messageId, at } });
    this.wake();
    return { messageId };
  }

  /** Long poll, as Telegram's getUpdates: drop what the bot acked (seq up to after), hand over the rest.
   *  gone aborts when the bot client hangs up, e.g. a rhodium killed mid-poll. wait false answers at
   *  once. Refused while the connection is down, or once it goes down. */
  async updates(after: number, gone: AbortSignal, wait = true): Promise<Update[]> {
    this.inbound = this.inbound.filter((u) => u.seq > after);
    if (this.up && wait && !this.inbound.length) {
      this.polls++;
      let timer: Timer | undefined;
      await Promise.race([
        this.changed.promise,
        new Promise((r) => (timer = setTimeout(r, POLL_MS))),
        new Promise((r) => gone.addEventListener("abort", r)),
      ]);
      clearTimeout(timer);
      this.polls--;
    }
    if (!this.up) throw new Error("the bot is not connected");
    return this.inbound;
  }

  /** Whether a bot client is long-polling now. It polls again right after each answer,
   *  so between two polls this reads false for a moment. */
  connected(): boolean {
    return this.up && this.polls > 0;
  }

  /** null: set to hang, so no answer. */
  send(chat: string, message: OutboundWire): SendResult | null {
    const refused = this.refusal(message);
    const quota = refused ? undefined : this.quotaRefusal(chat, message.replyTo);
    const hidden = this.capabilities.buttons === "markdown" && message.buttons?.length && message.markdown === undefined;
    const r = this.deliver(chat, { kind: "send", messageId: this.newId(), ...message, at: Date.now(), ...(hidden && { buttonsHidden: true as const }) }, refused ?? quota);
    return quota && r?.status === "failed" ? { ...r, quota: true } : r;
  }

  /** On QQ a reply uses up one of the replied-to message's few passive replies, and any other message one of the bot's active ones. */
  private quotaRefusal(chat: string, replyTo?: string): string | undefined {
    if (this.capabilities.sendLimit.kind !== "qq_quota") return;
    if (replyTo === undefined) {
      const active = this.log(chat).filter((p) => p.kind === "send" && p.replyTo === undefined).length;
      return active >= this.activeMessages ? "no active messages left" : undefined;
    }
    const at = this.delivered.get(`${chat}\n${replyTo}`);
    if (at === undefined) return "no such inbound message to reply to in this chat";
    if (Date.now() - at > this.passiveWindowMs) return "the passive reply window has passed";
    const used = this.log(chat).filter((p) => p.kind === "send" && p.replyTo === replyTo).length;
    if (used >= this.passiveReplies) return `no passive replies left for ${replyTo}`;
  }

  edit(chat: string, messageId: string, message: OutboundWire): SendResult | null {
    const known = this.log(chat).some((p) => p.kind === "send" && p.messageId === messageId);
    const refused =
      this.capabilities.progress === "append"
        ? "this platform cannot edit messages"
        : known
          ? this.refusal(message)
          : "no such message in this chat";
    return this.deliver(chat, { kind: "edit", messageId, ...message, at: Date.now() }, refused);
  }

  dropButtons(chat: string, messageId: string): SendResult | null {
    const known = this.log(chat).some((p) => p.kind === "send" && p.messageId === messageId);
    const refused = !this.capabilities.buttons
      ? "this platform has no buttons"
      : this.capabilities.progress === "append"
        ? "this platform cannot edit messages, so their buttons stay"
        : known
          ? undefined
          : "no such message in this chat";
    return this.deliver(chat, { kind: "unbutton", messageId, text: "", at: Date.now() }, refused);
  }

  answerPress(chat: string, press: string, text: string) {
    if (!this.capabilities.buttons) throw new Error("this platform has no buttons");
    this.post(chat, { kind: "toast", messageId: press, text, at: Date.now() });
  }

  /** Why the platform would turn this message down, going by the capability table. */
  private refusal(m: OutboundWire): string | undefined {
    const caps = this.capabilities;
    if (m.text.length > caps.maxTextLength) return `text is over ${caps.maxTextLength} characters`;
    if (m.buttons?.length && !caps.buttons) return "this platform has no buttons";
    if (m.buttons && m.buttons.length > (caps.maxButtons ?? Infinity)) return `a message shows at most ${caps.maxButtons} buttons`;
    const max = m.file && caps.maxFileBytes[m.file.kind];
    if (max && Buffer.byteLength(m.file!.data, "base64") > max) return `the ${m.file!.kind} is over ${max} bytes`;
  }

  /** Queue how the next send or edit (or either, when on is left out) turns out; on "row", whether
   *  the next row push fails. */
  next(outcome: unknown, on?: unknown) {
    if (!["ok", "fail", "timeout", "hang", "refuse"].includes(outcome as string)) throw new Error(`unknown outcome ${outcome}`);
    if (on !== undefined && on !== "send" && on !== "edit" && on !== "row") throw new Error(`on must be "send", "edit" or "row", not ${on}`);
    this.outcomes.push({ outcome: outcome as Outcome, on });
  }

  /** The platform takes p unless refused; a queued outcome can fail it, or time it out or hang after it lands. */
  private deliver(chat: string, p: Posted, refused?: string): SendResult | null {
    if (!this.up) return { status: "failed", error: "fake-im: not connected" };
    const i = this.outcomes.findIndex((o) => !o.on || o.on === p.kind);
    const outcome = i < 0 ? "ok" : this.outcomes.splice(i, 1)[0]!.outcome;
    if (outcome === "fail") return { status: "failed", error: "fake-im: set to fail" };
    if (outcome === "refuse") return { status: "failed", error: "fake-im: set to refuse", refused: true };
    if (!refused) this.post(chat, p);
    if (outcome === "hang") return null;
    if (outcome === "timeout") return { status: "unknown", error: "fake-im: timed out" };
    return refused ? { status: "failed", error: `fake-im: ${refused}` } : { status: "sent", messageId: p.messageId };
  }

  setMenu(items: MenuItem[], chat?: string) {
    if (!this.up) throw new Error("not connected");
    const { scope, maxItems } = this.capabilities.menu;
    if (chat !== undefined && scope === "global") throw new Error("this platform has one menu for all chats");
    if (items.length > maxItems) throw new Error(`a menu holds at most ${maxItems} items`);
    this.menus.set(chat ?? "", items);
    this.menuPushes.push({ chat, items });
  }

  setRow(row: RowButton[], chat?: string) {
    if (!this.up) throw new Error("not connected");
    if (!this.capabilities.menu.row) throw new Error("this platform has no row");
    if (chat !== undefined && this.capabilities.menu.scope === "global") throw new Error("this platform has one row for all chats");
    const i = this.outcomes.findIndex((o) => o.on === "row");
    if (i >= 0 && this.outcomes.splice(i, 1)[0]!.outcome !== "ok") throw new Error("fake-im: set to fail");
    this.rowPushes.push({ ...(chat !== undefined && { chat }), row, at: Date.now() });
  }

  /** Everything the bot sent or edited in chat, oldest first. */
  log(chat: string): Posted[] {
    return this.chats.get(chat) ?? [];
  }

  /** The menu chat sees: its own if set, else the bot-wide one. */
  menu(chat?: string): MenuItem[] | null {
    return this.menus.get(chat ?? "") ?? this.menus.get("") ?? null;
  }

  private post(chat: string, p: Posted) {
    const log = this.chats.get(chat) ?? [];
    log.push(p);
    this.chats.set(chat, log);
  }
}

/** The platform: every fake bot, behind one socket at path. Its state lives as long as it does. */
export class FakeIm {
  private readonly bots = new Map<string, PlatformBot>();
  private readonly server: ReturnType<typeof Bun.serve>;
  // Counted from the start time, so an rh dev run again on the same state numbers its messages anew:
  // Rhodium drops an id it has on record as a repeat (architecture §7.3).
  // ponytail: a run that numbers more messages than the milliseconds till the next starts collides.
  private ids = Date.now();

  constructor(private readonly path: string) {
    rmSync(path, { force: true }); // a stale socket from a crashed run
    this.server = Bun.serve({
      unix: path,
      fetch: (req) => this.handle(req),
      error: (e) => Response.json({ error: e.message }, { status: 400 }),
    });
    chmodSync(path, 0o600); // whoever can connect speaks as you
  }

  /** Set a bot up on the platform, before or after rhodium connects to it. */
  bot(opts: PlatformBotOptions) {
    this.bots.set(opts.name, new PlatformBot(opts, () => `fake-im:${++this.ids}`));
  }

  close() {
    this.server.stop(true);
    rmSync(this.path, { force: true });
  }

  /** A send or edit's result; one set to hang gets none, and its request stays open till the bot hangs up. */
  private async answer(req: Request, r: SendResult | null): Promise<Response> {
    if (r) return Response.json(r);
    this.server.timeout(req, 0); // past Bun.serve's idle timeout too
    await new Promise((gone) => req.signal.addEventListener("abort", gone));
    return new Response(null, { status: 499 });
  }

  private async handle(req: Request): Promise<Response> {
    const { bot: name, ...args } = (await req.json()) as { bot: string } & Record<string, any>;
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`no fake bot named ${name}`);
    switch (new URL(req.url).pathname) {
      // The test's side: the user, plus control over the platform.
      case "/inject":
        return Response.json(bot.inject(args as Wire));
      case "/log":
        return Response.json(bot.log(args.chat));
      case "/menu":
        return Response.json(bot.menu(args.chat));
      case "/menu-log":
        return Response.json(bot.menuPushes);
      case "/row-log":
        return Response.json(bot.rowPushes);
      case "/next":
        bot.next(args.outcome, args.on);
        return Response.json({});
      case "/connection":
        bot.connect(args.up);
        return Response.json({});
      case "/connected":
        return Response.json(bot.connected());
      // Rhodium's side: the bot.
      case "/bot/updates":
        return Response.json(await bot.updates(args.after, req.signal, args.wait));
      case "/bot/send":
        return this.answer(req, bot.send(args.chat, args.message));
      case "/bot/edit":
        return this.answer(req, bot.edit(args.chat, args.messageId, args.message));
      case "/bot/unbutton":
        return this.answer(req, bot.dropButtons(args.chat, args.messageId));
      case "/bot/press":
        bot.answerPress(args.chat, args.press, args.text);
        return Response.json({});
      case "/bot/menu":
        bot.setMenu(args.items, args.chat);
        return Response.json({});
      case "/bot/row":
        bot.setRow(args.row, args.chat);
        return Response.json({});
    }
    throw new Error(`unknown request ${req.url}`);
  }
}

async function call<T>(path: string, op: string, body: object, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`http://fake-im/${op}`, { unix: path, method: "POST", body: JSON.stringify(body), signal });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`fake-im ${op}: ${out.error}`);
  return out;
}

/** Rhodium's adapter for one fake bot: a client of the platform's socket that keeps retrying
 *  while the platform is not there. */
export class FakeBot implements ImAdapter {
  readonly id: string;
  readonly capabilities: Capabilities;
  private readonly name: string;
  private readonly stop = new AbortController();

  constructor(
    private readonly path: string,
    opts: FakeBotOptions,
  ) {
    this.id = opts.id;
    this.name = opts.name;
    this.capabilities = opts.capabilities;
  }

  /** Call once. A message is acked when the next one is asked for, so one rhodium took but never
   *  finished with comes again after a restart, as with Telegram's offset. The first poll, and the
   *  first after a refused one, is answered at once, so connected hears right away. */
  async *messages(connected?: Connected): AsyncGenerator<InboundMessage> {
    let after = 0;
    let wait = false;
    while (!this.stop.signal.aborted) {
      const updates = await this.call<Update[]>("bot/updates", { after, wait }).then(
        (u) => ((wait = true), connected?.(true), u),
        async (e: Error) => {
          wait = false;
          connected?.(false, e.message);
          await Bun.sleep(RETRY_MS);
          return [];
        },
      );
      for (const { seq, message } of updates) {
        const attachments = message.attachments?.map(({ data, fail, ...a }) => ({
          ...a,
          fetch: async () => {
            if (fail) throw new Error(fail);
            return new Uint8Array(Buffer.from(data, "base64"));
          },
        }));
        yield { ...message, attachments, bot: this.id };
        after = seq;
      }
    }
  }

  /** A message with buttons goes as Markdown where buttons show on Markdown only, as the QQ adapter sends it. */
  send(chat: string, message: OutboundMessage): Promise<SendResult> {
    return this.result(
      (async () => {
        const { file, ...rest } = this.capabilities.buttons === "markdown" ? withKeyboard(message) : message;
        const wire: OutboundWire = file
          ? { ...rest, file: { kind: file.kind, name: file.name, data: Buffer.from(await Bun.file(file.path).bytes()).toString("base64") } }
          : rest;
        return this.call<SendResult>("bot/send", { chat, message: wire });
      })(),
    );
  }

  edit(chat: string, messageId: string, message: OutboundMessage): Promise<SendResult> {
    return this.result(this.call("bot/edit", { chat, messageId, message }));
  }

  dropButtons(chat: string, messageId: string): Promise<SendResult> {
    return this.result(this.call("bot/unbutton", { chat, messageId }));
  }

  async answerPress(chat: string, press: string, text: string): Promise<void> {
    await this.call("bot/press", { chat, press, text });
  }

  /** The platform was not there to take it. */
  private result(r: Promise<SendResult>): Promise<SendResult> {
    return r.catch((e: Error) => ({ status: "failed", error: e.message }));
  }

  async setMenu(items: MenuItem[], chat?: string): Promise<void> {
    await this.call("bot/menu", { items, chat });
  }

  async setRow(row: RowButton[], chat?: string): Promise<void> {
    await this.call("bot/row", { row, chat });
  }

  /** The same picture, a 1x1 PNG, for the bot and for you. */
  async profile(you: string | null): Promise<Profile> {
    return { bot: FAKE_AVATAR, ...(you && { you: FAKE_AVATAR }) };
  }

  /** Stop talking to the platform, as rhodium does when it exits. */
  close() {
    this.stop.abort();
  }

  private call<T>(op: string, body: object): Promise<T> {
    return call(this.path, op, { bot: this.name, ...body }, this.stop.signal);
  }
}

/** The test side of the socket: the user, plus control over the platform. */
export class FakeImClient {
  constructor(private readonly path: string) {}

  inject(bot: string, message: Injection): Promise<{ messageId: string }> {
    const attachments = message.attachments?.map((a) => ({ ...a, data: Buffer.from(a.data).toString("base64") }));
    return call(this.path, "inject", { bot, ...message, attachments });
  }

  log(bot: string, chat: string): Promise<Posted[]> {
    return call(this.path, "log", { bot, chat });
  }

  /** What each message the bot sent in chat shows now, after its edits, oldest first: an edit shows
   *  only the buttons it carries, as on Telegram. */
  async shown(bot: string, chat: string): Promise<Posted[]> {
    const now = new Map<string, Posted>();
    for (const p of await this.log(bot, chat)) {
      if (p.kind === "send") now.set(p.messageId, p);
      else if (p.kind === "edit" && now.has(p.messageId)) now.set(p.messageId, { ...p, kind: "send", at: now.get(p.messageId)!.at });
      else if (p.kind === "unbutton" && now.has(p.messageId)) now.set(p.messageId, { ...now.get(p.messageId)!, buttons: undefined });
    }
    return [...now.values()];
  }

  /** Presses the button labelled so on the message, as you would. */
  press(bot: string, chat: string, message: Posted, label: string): Promise<{ messageId: string }> {
    const button = message.buttons?.find((b) => b.label === label);
    if (!button) throw new Error(`no button ${label} on ${JSON.stringify(message)}`);
    return this.inject(bot, { chat, sender: chat, text: "", button: { data: button.data, message: message.messageId, text: message.text } });
  }

  menu(bot: string, chat?: string): Promise<MenuItem[] | null> {
    return call(this.path, "menu", { bot, chat });
  }

  /** Every / menu the bot has set, oldest first; chat is left out for a bot-wide one. */
  menuLog(bot: string): Promise<{ chat?: string; items: MenuItem[] }[]> {
    return call(this.path, "menu-log", { bot });
  }

  /** Every row the bot has set, oldest first, at when (ms) it arrived; chat is left out for a bot-wide one. */
  rowLog(bot: string): Promise<{ chat?: string; row: RowButton[]; at: number }[]> {
    return call(this.path, "row-log", { bot });
  }

  /** Set how the bot's next send or edit turns out; on narrows it to one of the two. */
  async next(bot: string, outcome: Outcome, on?: Posted["kind"] | "row"): Promise<void> {
    await call(this.path, "next", { bot, outcome, on });
  }

  /** Break a bot's connection (up false) or let it reconnect (up true). */
  async connection(bot: string, up: boolean): Promise<void> {
    await call(this.path, "connection", { bot, up });
  }

  /** Whether rhodium is connected to the bot, as the platform sees it. */
  connected(bot: string): Promise<boolean> {
    return call(this.path, "connected", { bot });
  }
}
