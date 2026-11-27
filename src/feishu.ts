// Feishu adapter (docs/spec/feishu.md) on the official @larksuiteoapi/node-sdk, loaded only once a
// Feishu bot is: its Client for the open platform, its WSClient for the long connection. Private
// chats only; your chat goes by your open_id, which is also its id here (spec "窗口 ID").
import type * as Lark from "@larksuiteoapi/node-sdk";
import { createReadStream, type ReadStream } from "node:fs";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_KINDS } from "./agents";
import { slashMenu } from "./commands";
import type { BotConfig } from "./config";
import type { AdapterDeps, Capabilities, Connected, ImAdapter, InboundMessage, MenuItem, OutboundMessage, Profile, RowButton, SendResult } from "./contracts";
import { errorKind } from "./avatars";
import { buttonRows } from "./panels";
import { feishuCapabilities } from "./platforms";
import { clockAt } from "./prompt";
import { clip, PANELS } from "./render";

export { feishuCapabilities }; // the platform table's (platforms.ts), as tests know it

const DOMAIN = "https://open.feishu.cn";
const TIMEOUT_MS = 30_000;
// After the SDK gives up on the long connection (onError), a new one after these waits, as Telegram's polls.
const RETRY_DELAYS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
// A rate limit's wait longer than this (seconds), or past this many tries, fails the request instead.
const FLOOD_WAIT_MAX = 60;
const FLOOD_TRIES = 3;
const QUOTA = 99991403; // the month's API calls are used up; its HTTP status is 429 too
const FLOOD = [230020, 99991400];
// Feishu's file_type for an upload, by the file's extension; anything else is a stream. Not opus nor
// mp4: those are for voice and video messages, and Rhodium sends every file as a file message.
const FILE_TYPES: Record<string, string> = { ".pdf": "pdf", ".doc": "doc", ".docx": "doc", ".xls": "xls", ".xlsx": "xls", ".ppt": "ppt", ".pptx": "ppt" };
// The most messages of a forward written out (spec "合并转发"), as Feishu's own wrapper has it.
const FORWARD_MAX = 50;
const DAY = 24 * 3600_000;
// Subscribed to by the scan's template, of no use to Rhodium: acked, so Feishu does not push them again.
const UNUSED = ["im.message.reaction.created_v1", "im.message.reaction.deleted_v1", "im.chat.member.bot.added_v1", "im.chat.member.bot.deleted_v1", "drive.notice.comment_add_v1"];
// Feishu wants a press answered within 3 s: a notice answerPress gives later than this is not shown.
const PRESS_WAIT_MS = 2500;
// The cards sent or edited last whose content is kept, by message id: Feishu reads a card back only as a placeholder.
const CARDS = 500;
const SLASH = "/open-apis/application/v7/app_slash_commands";
const CARDKIT = "/open-apis/cardkit/v1/cards";
// How a streaming card types its text out: a character every 120 ms, a little slower than the edits
// come (durations.feishuEdit plus the call's own time), so it never stops to wait between two. Settled
// by eye on a phone.
const TYPING = { print_frequency_ms: { default: 120 }, print_step: { default: 1 }, print_strategy: "fast" };
// A card's text streams only in streaming mode: closed by hand (300309), or by Feishu after 10 minutes (200850).
const STREAM_CLOSED = [300309, 200850];
// The card is being changed by the answer to a press on it: tried again once, after this wait.
const CARD_BUSY = 200810;
const BUSY_WAIT_MS = 1000;
// More changes than this to a card's elements go as one replacement of the whole card instead.
const MOST_OPS = 4;
// The commands any agent's / menu has: the app's own others are left alone (spec "/ 菜单").
const OURS = new Set(AGENT_KINDS.flatMap((a) => slashMenu(a)).map((i) => i.command.slice(1)));

type Log = (msg: string) => void;
/** A part of a card: its text in Markdown, or plain; a tool part as a folding panel, its text inside. */
type El = { id: string; text: string; plain?: true; panel?: { title: string; open: boolean } };
/** A card sent as a CardKit card entity (spec "发出的卡片"): the entity's id, when it was made (ms),
 *  the last sequence of a change to it, whether its streaming mode is on as far as known, and what it
 *  shows: its parts and buttons, null where not known (after a restart, or a change of unknown outcome). */
type Entity = { id: string; born: number; seq: number; streaming: boolean; shown: { els: El[]; buttons: string } | null };
type Attachment = NonNullable<InboundMessage["attachments"]>[number];
type Options = {
  editEvery: number; // durations.feishuEdit
  log?: Log;
  timeoutMs?: number; // how long a call to the open platform may take before it is unknown
  // Spec "补拉": your private chat's id (oc_…, the meta row feishuChat), and where to keep a new one a
  // send's answer gives; no backfill reaches before since (ms, feishuSince).
  chat?: string;
  saveChat?: (chat: string) => void;
  since?: number;
  /** Whether rhodium has taken the message in already (its inbound table): acked, and not read again. */
  seen?: (chat: string, messageId: string) => boolean;
  /** The card entity a message was sent as ("<card id> <made at ms>"), kept across restarts. */
  entity?: (messageId: string) => string | undefined;
  saveEntity?: (messageId: string, entity: string) => void;
};
/** A call's outcome: Feishu's answer, or the SendResult it fails with. */
type Answer = { ok: true; data: any } | { ok: false; result: Extract<SendResult, { status: "failed" | "unknown" }>; code?: number };
/** A message as Feishu pushes it (or a backfill's, made to look so), or a press read already,
 *  waiting for rhodium to take it: took acks it, dropped fails its ack. */
type Pending = { event?: any; press?: InboundMessage; took: () => void; dropped: (e: Error) => void };

let sdk: Promise<typeof Lark> | undefined;
/** The SDK, its own requests (the token's, the long connection's address) given up after timeout ms:
 *  unset, they have none, and a send stuck on one holds up every bot's (daemon.ts's one queue). One
 *  value for the whole process, as every bot has the same. */
const loadSdk = async (timeout: number) => {
  const lark = await (sdk ??= import("@larksuiteoapi/node-sdk"));
  lark.defaultHttpInstance.defaults.timeout = timeout;
  return lark;
};

export class FeishuAdapter implements ImAdapter {
  readonly capabilities: Capabilities;
  private readonly appId: string;
  private readonly secret: string;
  private readonly domain: string;
  private readonly log: Log;
  private readonly timeout: number;
  private client?: Promise<Lark.Client>;
  private chat?: string;
  private readonly cards = new Map<string, { m: OutboundMessage; e?: Entity }>(); // the last CARDS cards, oldest first
  private readonly presses = new Map<string, (notice: string) => void>(); // presses waiting for answerPress, by event id

  /** appId, secret and an optional apiRoot (a test's fake Feishu) come from the [bots.<name>] table. */
  constructor(
    readonly botId: string,
    readonly name: string,
    config: BotConfig,
    private readonly opts: Options,
  ) {
    for (const key of ["appId", "secret"]) if (!config[key]) throw new Error(`config: bots.${name}.${key} is required for a Feishu bot`);
    this.appId = config.appId!;
    this.secret = config.secret!;
    this.domain = config.apiRoot ?? DOMAIN;
    this.capabilities = feishuCapabilities(opts.editEvery);
    this.log = opts.log ?? ((msg) => console.error(`[feishu ${name}] ${msg}`));
    this.timeout = opts.timeoutMs ?? TIMEOUT_MS;
    this.chat = opts.chat;
  }

  /** The SDK's warnings and errors through log: an error by its message alone, as its request, with
   *  the secret or a token in it, is not to be logged; never the secret. */
  private sdkLogger(): Lark.Logger {
    const line = (level: string) => (...msg: unknown[]) => {
      const say = (m: any): string => (typeof m?.message === "string" ? m.message : typeof m === "string" ? m : safeJson(m));
      this.log(`sdk ${level}: ${clip(this.redact(msg.flat(9).map(say).join(" ")), 500, "…")}`);
    };
    const quiet = () => {};
    return { error: line("error"), warn: line("warn"), info: quiet, debug: quiet, trace: quiet };
  }

  private api(): Promise<Lark.Client> {
    return (this.client ??= loadSdk(this.timeout).then((lark) => new lark.Client({ appId: this.appId, appSecret: this.secret, domain: this.domain, logger: this.sdkLogger(), loggerLevel: lark.LoggerLevel.warn })));
  }

  /** Holds the long connection while iterated. Each message Feishu pushes is acked once rhodium asks
   *  for the next one, by when it has taken it in; one that can't be read is acked as failed, for
   *  Feishu to push again (spec "长连接和回执"). Each time it is up, what you sent meanwhile is
   *  backfilled, ahead of what is pushed after (spec "补拉"). One rhodium took in already is acked
   *  and skipped, never read again. Ending the iteration closes the connection. */
  messages(connected: Connected = () => {}, stop?: AbortSignal): AsyncIterable<InboundMessage> {
    const queue: Pending[] = [];
    let handed: Pending | undefined; // the message rhodium has, acked at its next ask
    let waiting: ((p: Pending | undefined) => void) | undefined;
    let ws: Lark.WSClient | undefined;
    let done = false;
    let failures = 0;
    // Pushed messages wait for each backfill under way, which queues first what came before them.
    let backfilled = Promise.resolve();
    const put = (p: Pending) => {
      if (done) return p.dropped(new Error("rhodium stopped listening"));
      if (!waiting) return void queue.push(p);
      const w = waiting;
      waiting = undefined;
      w(p);
    };
    const onMessage = (event: any) => new Promise<void>((took, dropped) => void backfilled.then(() => put({ event, took, dropped })));
    const nothing = () => {};
    // Feishu pushes a press only once, and takes what this gives back as its answer: the notice
    // answerPress gives, as a toast, if it comes in time (spec "按钮"). It waits for no backfill.
    const onPress = async (event: any) => {
      const message = this.press(event);
      if (!message || done) return {};
      const id = message.messageId;
      const notice = await new Promise<string>((answer) => {
        this.presses.set(id, answer);
        setTimeout(() => answer(""), PRESS_WAIT_MS);
        put({ press: message, took: nothing, dropped: nothing });
      });
      this.presses.delete(id);
      return notice ? { toast: { type: "info", content: notice } } : {};
    };
    const backfill = () => {
      backfilled = backfilled
        .then(async () => {
          for (const event of await this.backfill()) put({ event, took: nothing, dropped: nothing });
        })
        .catch((e) => this.log(`backfill failed: ${this.redact(String(e))}`));
    };
    // The SDK tells of a drop once (onReconnecting), not of each try after it that fails: a new try
    // means the one before failed, the first after a drop excepted, told already. Feishu tries every
    // 2 minutes, so a poll every second sees each.
    let tries = 0; // the current client's
    let ever = false; // whether the current client was ever up: before, its first try is a failed start
    const poll = setInterval(() => {
      const n = ws?.getConnectionStatus().reconnectAttempts ?? 0;
      for (let i = tries + 1; i <= n; i++) if (i > 1 || !ever) connected(false, "reconnecting to Feishu failed");
      tries = n;
    }, 1000);
    const connect = async () => {
      const lark = await loadSdk(this.timeout);
      if (done) return;
      [tries, ever] = [0, false];
      const ignore = () => ({});
      const dispatcher = new lark.EventDispatcher({ logger: this.sdkLogger(), loggerLevel: lark.LoggerLevel.warn }).register({
        "im.message.receive_v1": onMessage,
        "card.action.trigger": onPress,
        ...Object.fromEntries(UNUSED.map((e) => [e, ignore])),
      });
      const client: Lark.WSClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.secret,
        domain: this.domain,
        logger: this.sdkLogger(),
        loggerLevel: lark.LoggerLevel.warn,
        // Unset, the SDK never notices a half-dead connection.
        wsConfig: { pingTimeout: 10 },
        handshakeTimeoutMs: 10_000,
        onReady: () => ((failures = 0), (ever = true), connected(true), backfill()),
        onReconnected: () => (connected(true), backfill()),
        onReconnecting: () => connected(false, "the long connection dropped; the SDK reconnects"),
        // The SDK gave up, as on credentials Feishu turns down: a new one, after a wait.
        onError: (e) => {
          const error = this.redact(e.message);
          connected(false, error);
          this.log(`long connection failed: ${error}`);
          // Without force an old connection goes on reconnecting by itself (node-sdk issue #197).
          client.close({ force: true });
          if (!done) setTimeout(() => void connect(), RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)]);
        },
      });
      ws = client;
      void client.start({ eventDispatcher: dispatcher }).catch((e) => this.log(`long connection failed: ${this.redact(String(e))}`));
    };
    void connect();

    stop?.addEventListener("abort", () => void iterator.return!());
    const iterator: AsyncIterator<InboundMessage> = {
      next: async () => {
        handed?.took();
        handed = undefined;
        for (;;) {
          const p = done ? undefined : (queue.shift() ?? (await new Promise<Pending | undefined>((resolve) => (waiting = resolve))));
          if (!p) return { value: undefined, done: true };
          try {
            const e = p.event;
            // A forward takes a call to read: one at a time, so in the order they came.
            const message = p.press ?? (this.opts.seen?.(String(e?.sender?.sender_id?.open_id), String(e?.message?.message_id)) ? null : await this.inbound(e));
            if (done) {
              p.dropped(new Error("rhodium stopped listening"));
              return { value: undefined, done: true };
            }
            if (!message) {
              p.took();
              continue;
            }
            handed = p;
            return { value: message, done: false };
          } catch (e) {
            p.dropped(e as Error);
          }
        }
      },
      return: async () => {
        done = true;
        clearInterval(poll);
        ws?.close({ force: true });
        for (const p of [...(handed ? [handed] : []), ...queue.splice(0)]) p.dropped(new Error("rhodium stopped listening"));
        handed = undefined;
        waiting?.(undefined);
        return { value: undefined, done: true };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /** What you sent in your private chat in the last 24 h, but none before since, as pushed events,
   *  oldest first (spec "补拉"). None while your chat's id is unknown. A call Feishu turns down ends
   *  it, logged, not tried again: Feishu pushes again what it has not had acked. */
  private async backfill(): Promise<any[]> {
    if (!this.chat) return [];
    const from = Math.max(this.opts.since ?? 0, Date.now() - DAY);
    const params = { container_id_type: "chat", container_id: this.chat, start_time: String(Math.floor(from / 1000)), end_time: String(Math.ceil(Date.now() / 1000)), sort_type: "ByCreateTimeAsc", page_size: "50" };
    const events: any[] = [];
    for (let page = ""; ; ) {
      const a = await this.call("GET", "/open-apis/im/v1/messages", undefined, { ...params, ...(page && { page_token: page }) }, { most: 1 });
      if (!a.ok) {
        this.log(`backfill failed: ${a.result.error}`);
        return events;
      }
      // The list has the bot's own cards too, and goes by whole seconds. A list item has the fields
      // of a pushed message but these.
      for (const m of a.data.items ?? []) {
        if (m.sender?.sender_type === "user" && !m.deleted && Number(m.create_time) >= from) events.push({ message: { ...m, message_type: m.msg_type, content: m.body?.content }, sender: { sender_id: { open_id: m.sender.id } } });
      }
      if (!a.data.has_more || !a.data.page_token) return events;
      page = a.data.page_token;
    }
  }

  /** A message in your private chat as Rhodium takes it (spec "收到的消息"): text, rich text as text
   *  with its pictures; a picture, a sticker, a file or a video as an attachment, not yet downloaded; a
   *  voice message only as such; a forward written out. A reply quotes the message it replies to.
   *  null for anything else. Throws on one it can't read, failing its ack. */
  private async inbound(e: any): Promise<InboundMessage | null> {
    const m = e?.message;
    const sender = e?.sender?.sender_id?.open_id;
    if (m?.chat_type !== "p2p" || !sender) return null;
    const id: string = m.message_id;
    const base = { bot: this.botId, chat: sender, messageId: id, sender, at: Number(m.create_time) };
    if (m.message_type === "audio") return { ...base, text: "", voice: true };
    const c = () => JSON.parse(m.content);
    const image = (key: string): Attachment => ({ kind: "image", fetch: () => this.download(id, key, "image") });
    const file = (key: string, name?: string): Attachment => ({ kind: "file", ...(name && { name }), fetch: () => this.download(id, key, "file") });
    let text = "";
    let attachments: Attachment[] = [];
    switch (m.message_type) {
      case "text":
        text = textOf(c());
        break;
      case "post": {
        const post = c();
        text = postText(post);
        attachments = (post.content ?? []).flat().flatMap((x: any) => (x?.tag === "img" && x.image_key ? [image(x.image_key)] : []));
        break;
      }
      case "image":
        attachments = [image(c().image_key)];
        break;
      case "sticker": // a picture, though Feishu's documents say it can't be downloaded
        attachments = [image(c().file_key)];
        break;
      case "file":
      case "media": {
        // A video, which the agent can't watch: a file is enough.
        const f = c();
        attachments = [file(f.file_key, f.file_name)];
        break;
      }
      case "merge_forward":
        text = await this.forward(id, sender);
        break;
      default:
        return null;
    }
    return { ...base, text, ...(attachments.length && { attachments }), ...(m.parent_id && { quote: { ref: m.parent_id } }) };
  }

  /** A message's picture or file. Its name in the download's header is mangled (UTF-8 read as
   *  Latin-1), so the message's own is used instead. */
  private async download(messageId: string, key: string, type: "image" | "file"): Promise<Uint8Array> {
    const a = await this.call("GET", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`, undefined, { type }, { as: "bytes" });
    if (!a.ok) throw new Error(a.result.error);
    return a.data;
  }

  /** A forward written out, by its messages as Feishu gives them all at once, each naming the one it
   *  is in (spec "合并转发"); one Feishu won't give says so. you: who sent it, 我 in it. */
  private async forward(id: string, you: string): Promise<string> {
    const a = await this.call("GET", `/open-apis/im/v1/messages/${encodeURIComponent(id)}`);
    if (!a.ok) {
      this.log(`cannot fetch a forward's messages: ${a.result.error}`);
      return "[合并转发，没取到]";
    }
    return forwardText(id, a.data.items ?? [], you, this.appId, Date.now());
  }

  /** A button pressed on a card, by whoever pressed it: their open_id is the sender, and the chat, so
   *  the router acts only on yours, not on a card passed on to someone else. Its id is the event's,
   *  which answerPress answers; its text the card's, where the bot has it. */
  private press(e: any): InboundMessage | null {
    const who = e?.operator?.open_id;
    const data = e?.action?.value?.d;
    const card = e?.context?.open_message_id;
    if (!who || typeof data !== "string" || !card) return null;
    const text = this.cards.get(card)?.m.text;
    return { bot: this.botId, chat: who, messageId: e.event_id, sender: who, text: "", at: Date.now(), button: { data, message: card, ...(text !== undefined && { text }) } };
  }

  /** A text message: a card entity made, then sent by its id (spec "发出的卡片"). Making it sends
   *  nothing, so one that fails, or whose outcome is not known, fails the message. */
  async send(chat: string, message: OutboundMessage): Promise<SendResult> {
    if (message.file) return this.sendFile(chat, message.file);
    const born = Date.now();
    let plain = false;
    const made = await this.markdownOr(message, (p) => ((plain = p), this.call("POST", CARDKIT, { type: "card_json", data: JSON.stringify(card(message, p, false)) })));
    if (!made.ok) return { ...made.result, status: "failed" };
    const id: string = made.data.card_id;
    const content = JSON.stringify({ type: "card", data: { card_id: id } });
    const a = await this.call("POST", "/open-apis/im/v1/messages", { receive_id: chat, msg_type: "interactive", content }, { receive_id_type: "open_id" });
    if (!a.ok) return a.result;
    this.opts.saveEntity?.(a.data.message_id, `${id} ${born}`);
    this.keep(a.data.message_id, message, { id, born, seq: 0, streaming: false, shown: { els: elements(message, plain), buttons: buttonsOf(message) } });
    // Rhodium sends only to you, so the chat the answer names is your private chat.
    if (a.data.chat_id && a.data.chat_id !== this.chat) {
      this.chat = a.data.chat_id;
      this.opts.saveChat?.(a.data.chat_id);
    }
    return { status: "sent", messageId: a.data.message_id };
  }

  /** A picture or a file, uploaded and then sent as a message of its own, with no text. An upload
   *  sends nothing, so one that fails, or may not have come through, fails the file. A picture
   *  Feishu turns down, say one over 12000x12000 (234039), goes up again as a file, as its docs say:
   *  the refused upload sent nothing, so it never comes twice. */
  private async sendFile(chat: string, f: NonNullable<OutboundMessage["file"]>): Promise<SendResult> {
    const upload = (kind: "image" | "file") => {
      // A stream, as a Buffer goes with no file name; a new one each try. Each closed after, read or not.
      const streams: ReadStream[] = [];
      const open = () => streams[streams.push(createReadStream(f.path)) - 1]!;
      const form = () => (kind === "image" ? { image_type: "message", image: open() } : { file_type: FILE_TYPES[extname(f.name).toLowerCase()] ?? "stream", file_name: f.name, file: open() });
      return this.call("POST", `/open-apis/im/v1/${kind}s`, form, undefined, { as: "multipart" }).finally(() => streams.forEach((s) => s.destroy()));
    };
    let kind = f.kind;
    let up = await upload(kind);
    if (kind === "image" && !up.ok && up.result.status === "failed" && !up.result.quota && !up.result.flood) {
      this.log(`picture turned down, sending it as a file: ${up.result.error}`);
      up = await upload((kind = "file"));
    }
    if (!up.ok) return { ...up.result, status: "failed" };
    const key = kind === "image" ? { image_key: up.data.image_key } : { file_key: up.data.file_key };
    const a = await this.call("POST", "/open-apis/im/v1/messages", { receive_id: chat, msg_type: kind, content: JSON.stringify(key) }, { receive_id_type: "open_id" });
    return a.ok ? { status: "sent", messageId: a.data.message_id } : a.result;
  }

  /** The card changed to show message (spec "改卡片"). A card entity: text that grew streams in, typed
   *  out; a panel folded or retitled, or a part added, is changed alone; anything else, buttons among
   *  them, replaces the whole card. The last edit (final) closes its streaming mode. A card sent before
   *  card entities, with none on record, is replaced whole (PATCH). */
  async edit(_chat: string, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const e = this.entity(messageId);
    const a = e ? await this.change(e, message) : await this.markdownOr(message, (plain) => this.call("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card(message, plain)) }));
    if (!a.ok) return a.result;
    // The chat list's summary too, which a change to a part leaves as it was, and streaming mode has as 生成中.
    if (e && message.final) {
      const closed = await this.cardkit(e, "PATCH", `${CARDKIT}/${e.id}/settings`, { settings: JSON.stringify({ config: { streaming_mode: false, summary: summary(message) } }) });
      // Left on, Feishu closes it itself after 10 minutes.
      if (closed.ok) e.streaming = false;
      else this.log(`card's streaming mode not closed: ${closed.result.error}`);
    }
    this.keep(messageId, message, e);
    return { status: "sent", messageId };
  }

  /** The card entity a message was sent as: known, else on record from before a restart. */
  private entity(messageId: string): Entity | undefined {
    const known = this.cards.get(messageId);
    if (known) return known.e;
    const [id, born] = this.opts.entity?.(messageId)?.split(" ") ?? [];
    // Taken as off: its first edit replaces it whole, and a card with buttons must not stream (plan).
    // One left on is closed by that replacement or the last edit; text that streams after opens it again.
    return id && born ? { id, born: Number(born), seq: 0, streaming: false, shown: null } : undefined;
  }

  /** The card entity e changed to show m: by the changes plan finds, else replaced whole. */
  private async change(e: Entity, m: OutboundMessage): Promise<Answer> {
    const want = { els: elements(m, false), buttons: buttonsOf(m) };
    const ops = plan(e.shown, want);
    if (!ops) return this.replace(e, m);
    for (const op of ops) {
      const at = `${CARDKIT}/${e.id}/elements`;
      let a: Answer | undefined;
      if ("add" in op) a = await this.cardkit(e, "POST", at, { type: "append", elements: JSON.stringify(op.add.map(element)) });
      else if (op.head) a = await this.cardkit(e, "PATCH", `${at}/${op.el.id}`, { partial_element: JSON.stringify({ expanded: op.el.panel!.open, header: header(op.el.panel!.title) }) });
      else {
        const put = () => this.cardkit(e, "PUT", `${at}/${op.el.panel ? `${op.el.id}t` : op.el.id}/content`, { content: op.el.text });
        // Streaming mode is opened for the first text that streams, and again once Feishu closed it.
        if (e.streaming) a = await put();
        if (!a || (!a.ok && STREAM_CLOSED.includes(a.code!))) {
          const opened = await this.cardkit(e, "PATCH", `${CARDKIT}/${e.id}/settings`, { settings: JSON.stringify({ config: { streaming_mode: true } }) });
          a = opened.ok ? ((e.streaming = true), await put()) : opened;
        }
      }
      if (!a.ok && (a.result.status === "unknown" || a.result.quota || a.result.flood)) return (e.shown = null), a;
      // Turned down otherwise: the whole card replaced instead.
      if (!a.ok) {
        this.log(`card's part not changed, replacing the card: ${a.result.error}`);
        return this.replace(e, m);
      }
    }
    e.shown = want;
    return { ok: true, data: {} };
  }

  /** The card entity e replaced whole, to show m. */
  private async replace(e: Entity, m: OutboundMessage): Promise<Answer> {
    let plain = false;
    const a = await this.markdownOr(m, (p) => ((plain = p), this.cardkit(e, "PUT", `${CARDKIT}/${e.id}`, { card: { type: "card_json", data: JSON.stringify(card(m, p, e.streaming)) } })));
    e.shown = a.ok ? { els: elements(m, plain), buttons: buttonsOf(m) } : null;
    return a;
  }

  /** A change to card entity e, with the next sequence: increasing, as the ms since it was made, so
   *  none need be kept across restarts; Feishu's changes to one card go one at a time (daemon.ts).
   *  One made while a press on the card is being answered is tried again once, after a wait. */
  private async cardkit(e: Entity, method: "POST" | "PUT" | "PATCH", url: string, data: object): Promise<Answer> {
    for (let tries = 1; ; tries++) {
      e.seq = Math.max(e.seq + 1, Date.now() - e.born);
      const a = await this.call(method, url, { ...data, sequence: e.seq });
      if (a.ok || a.code !== CARD_BUSY || tries > 1) return a;
      await sleep(BUSY_WAIT_MS);
    }
  }

  /** What the card shows now, the newest last; the oldest forgotten past CARDS. e: its card entity. */
  private keep(id: string, m: OutboundMessage, e?: Entity): void {
    this.cards.delete(id);
    this.cards.set(id, { m, ...(e && { e }) });
    if (this.cards.size > CARDS) this.cards.delete(this.cards.keys().next().value!);
  }

  /** The card in Markdown where there is any, else plain text (call(true)). Plain text too when Feishu
   *  turns the Markdown down (230099, say, for over 3 tables), so a message never fails for its formatting. */
  private async markdownOr(m: OutboundMessage, call: (plain: boolean) => Promise<Answer>): Promise<Answer> {
    if (m.markdown === undefined) return call(true);
    const a = await call(false);
    if (a.ok || a.result.status === "unknown" || a.result.quota || a.result.flood) return a;
    this.log(`card's Markdown turned down, sending plain text: ${a.result.error}`);
    return call(true);
  }

  /** The card edited to what it last showed, without its buttons. One the bot does not know, sent
   *  before rhodium restarted or too long ago, fails: Feishu can't give it back. */
  async dropButtons(chat: string, messageId: string): Promise<SendResult> {
    const m = this.cards.get(messageId)?.m;
    if (!m) return { status: "failed", error: "the card's content is not known" };
    return this.edit(chat, messageId, { text: m.text, ...(m.markdown !== undefined && { markdown: m.markdown }) });
  }

  async answerPress(_chat: string, press: string, text: string): Promise<void> {
    this.presses.get(press)?.(text);
  }

  /** The app's slash commands: those the menu lacks made, in its order; those described otherwise
   *  changed; Rhodium's it no longer has deleted. Throws on the first Feishu turns down. */
  async setMenu(items: MenuItem[]): Promise<void> {
    const ok = (a: Answer) => {
      if (!a.ok) throw new Error(a.result.error);
      return a.data;
    };
    const have: { command: string; command_id: string; description?: { default_value?: string } }[] = ok(await this.call("GET", SLASH)).items ?? [];
    const want = new Map(items.map((i) => [i.command.replace(/^\//, ""), i.description]));
    for (const c of have) {
      const description = want.get(c.command);
      const at = `${SLASH}/${encodeURIComponent(c.command_id)}`;
      if (description === undefined) {
        if (OURS.has(c.command)) ok(await this.call("DELETE", at));
      } else if (c.description?.default_value !== description) ok(await this.call("PATCH", at, { description: { default_value: description } }));
    }
    for (const [command, description] of want) if (!have.some((c) => c.command === command)) ok(await this.call("POST", SLASH, { command, description: { default_value: description } }));
  }

  async setRow(_row: RowButton[]): Promise<void> {}

  /** The bot's avatar from its info; your name and avatar (240 px) from the contact book. That gives
   *  them only once the app may read them (contact:user.base:readonly), else your open_id alone, and
   *  neither comes (spec "头像和名字"). Avatars need no token. */
  async profile(you: string | null): Promise<Profile> {
    const answer = async (what: string, url: string, params?: Record<string, string>) => {
      const a = await this.call("GET", url, undefined, params);
      if (a.ok) return a.data;
      this.log(`cannot get ${what}: ${a.result.error}`);
    };
    const download = async (what: string, url: unknown) => {
      if (typeof url !== "string" || !url) return;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        this.log(`cannot get ${what}: HTTP ${res.status}`);
      } catch (e) {
        this.log(`cannot get ${what}: ${errorKind(e)}`);
      }
    };
    const [info, user] = await Promise.all([
      answer("the bot's info", "/open-apis/bot/v3/info"),
      you ? answer("your name and avatar", `/open-apis/contact/v3/users/${encodeURIComponent(you)}`, { user_id_type: "open_id" }) : undefined,
    ]);
    const [bot, mine] = await Promise.all([download("the bot's avatar", info?.bot?.avatar_url), download("your avatar", user?.user?.avatar?.avatar_240)]);
    const name = user?.user?.name;
    return { ...(bot && { bot }), ...(mine && { you: mine }), ...(typeof name === "string" && name && { name }) };
  }

  /** One call to the open platform. failed only when Feishu said no; a timeout, a dropped connection
   *  or a 5xx may have come after it took the message, so those are unknown (architecture §7.4).
   *  Over its rate limit Feishu took nothing, so that is waited out and tried again, most tries in
   *  all; past that it fails, for its flood. Out of the month's quota it fails at once, for its quota.
   *  data: a function for a form, whose files are streams read once, so made anew each try.
   *  multipart: data goes as a form. bytes: the answer is a file's, given as its bytes. */
  private async call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, data?: object | (() => object), params?: Record<string, string>, { as, most = FLOOD_TRIES }: { as?: "multipart" | "bytes"; most?: number } = {}): Promise<Answer> {
    const client = await this.api();
    for (let tries = 1; ; tries++) {
      let status = 200;
      let body: any;
      let reset: string | undefined;
      try {
        const req = {
          method,
          url,
          data: typeof data === "function" ? data() : data,
          params,
          timeout: this.timeout,
          ...(as === "multipart" && { headers: { "Content-Type": "multipart/form-data" } }),
          ...(as === "bytes" && { responseType: "arraybuffer" }),
        };
        body = await client.request(req as Parameters<Lark.Client["request"]>[0]);
      } catch (e: any) {
        if (!e?.response) return { ok: false, result: { status: "unknown", error: this.redact(String(e?.message ?? e)) } };
        ({ status, data: body } = e.response);
        reset = e.response.headers?.["x-ogw-ratelimit-reset"];
      }
      // A file comes as its bytes; Feishu's refusal as JSON all the same.
      if (as === "bytes" && (body instanceof ArrayBuffer || body instanceof Uint8Array)) {
        const bytes = new Uint8Array(body);
        if (status < 300) return { ok: true, data: bytes };
        body = safeParse(new TextDecoder().decode(bytes));
      }
      const code = body?.code;
      // The bot's info has its bot beside code, not under data.
      if (status < 300 && code === 0) return { ok: true, data: body.data ?? body };
      const error = this.redact(`HTTP ${status} ${code ?? ""} ${body?.msg ?? ""}`.replace(/ +/g, " ").trim());
      if (code === QUOTA) return { ok: false, result: { status: "failed", error, quota: true }, code };
      if (FLOOD.includes(code) || status === 429) {
        const wait = reset === undefined ? 1 : Number(reset);
        if (wait <= FLOOD_WAIT_MAX && tries < most) {
          this.log(`rate limit: trying again in ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        return { ok: false, result: { status: "failed", error, flood: true }, code };
      }
      return { ok: false, result: status >= 500 ? { status: "unknown", error } : { status: "failed", error }, code };
    }
  }

  private redact(s: string): string {
    return s.replaceAll(this.secret, "<secret>");
  }
}

/** A JSON 2.0 card (spec "发出的卡片"): full width, editable; its parts (elements), then a column set
 *  for each row of buttons, a column for each, as wide as its label; its summary. streaming: a card
 *  entity's streaming mode, with how it types; left out for a card sent as itself. */
function card(m: OutboundMessage, plain: boolean, streaming?: boolean): object {
  const rows = buttonRows(m.buttons ?? []).map((row) => ({
    tag: "column_set",
    flex_mode: "flow",
    columns: row.map((b) => ({
      tag: "column",
      width: "auto",
      elements: [{ tag: "button", text: { tag: "plain_text", content: b.label }, type: b.muted ? "default" : "primary", behaviors: [{ type: "callback", value: { d: b.data } }] }],
    })),
  }));
  const config = { update_multi: true, width_mode: "fill", summary: summary(m), ...(streaming !== undefined && { streaming_mode: streaming, streaming_config: TYPING }) };
  return { schema: "2.0", config, body: { elements: [...elements(m, plain).map(element), ...rows] } };
}

/** A card's summary in the chat list: the last line of text that has any, cut to 50 characters. */
const summary = (m: OutboundMessage) => ({ content: clip((m.text.split("\n").findLast((l) => l.trim()) ?? "").trim(), 50) });

/** A message's parts: its Markdown, each tool part in it (render.ts PANEL) a panel, the text between
 *  a part each; else, plain, its text. Each has an id by its place. */
function elements(m: OutboundMessage, plain: boolean): El[] {
  if (plain || m.markdown === undefined) return [{ id: "e0", text: m.text, plain: true }];
  const md = m.markdown;
  const els: El[] = [];
  const text = (t: string) => (t = t.replace(/^\n+|\n+$/g, "")) && els.push({ id: `e${els.length}`, text: t });
  let at = 0;
  for (const p of md.matchAll(PANELS)) {
    text(md.slice(at, p.index));
    els.push({ id: `e${els.length}`, text: p[3]!, panel: { open: p[1] === "+", title: p[2]! } });
    at = p.index + p[0].length;
  }
  text(md.slice(at));
  return els.length ? els : [{ id: "e0", text: "" }];
}

/** A part as the card's element: Markdown, plain text, or a folding panel with its text in it. */
function element(e: El): object {
  if (e.plain) return { tag: "div", element_id: e.id, text: { tag: "plain_text", content: e.text } };
  if (!e.panel) return { tag: "markdown", element_id: e.id, content: e.text };
  return { tag: "collapsible_panel", element_id: e.id, expanded: e.panel.open, header: header(e.panel.title), border: { color: "grey" }, elements: [{ tag: "markdown", element_id: `${e.id}t`, content: e.text }] };
}

const header = (title: string) => ({ title: { tag: "plain_text", content: title } });
const buttonsOf = (m: OutboundMessage) => JSON.stringify(m.buttons ?? []);

type Op = { add: El[] } | { el: El; head?: true };

/** The changes that take a card entity from showing shown to showing want, part by part: a part's
 *  text changed, a panel folded or retitled, parts added at the end, empty, their text then streamed in. null where the whole card is to be
 *  replaced instead: what it shows is not known, it has buttons or had them, a part's kind changed, a
 *  part went, plain text changed (it does not stream), or more than MOST_OPS changes. */
function plan(shown: Entity["shown"], want: NonNullable<Entity["shown"]>): Op[] | null {
  // A card with buttons, a panel or an ask, never streams: its streaming mode would stay on, as nothing closes it.
  if (!shown || shown.buttons !== "[]" || want.buttons !== "[]" || want.els.length < shown.els.length) return null;
  const ops: Op[] = [];
  // A part added goes empty, its text streamed in after, so that even a short one is typed out.
  const fill: Op[] = [];
  for (const [i, el] of want.els.entries()) {
    const was = shown.els[i];
    if (!was) {
      const add = el.plain || !el.text ? el : (fill.push({ el }), { ...el, text: "" });
      const last = ops.at(-1);
      if (last && "add" in last) last.add.push(add);
      else ops.push({ add: [add] });
      continue;
    }
    if (!!was.panel !== !!el.panel || !!was.plain !== !!el.plain) return null;
    if (was.panel && (was.panel.title !== el.panel!.title || was.panel.open !== el.panel!.open)) ops.push({ el, head: true });
    if (was.text === el.text) continue;
    if (el.plain) return null;
    ops.push({ el });
  }
  ops.push(...fill);
  return ops.length > MOST_OPS ? null : ops;
}

/** A text message's text as you wrote it. A note added to a forward comes as HTML in <p>: a line a
 *  paragraph, tags dropped as a post's styles are, &lt; and the like as characters. */
function textOf(c: { text?: unknown }): string {
  const text = String(c.text ?? "");
  if (!/^<p>[\s\S]*<\/p>$/.test(text)) return text;
  const chars: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", nbsp: " " };
  return text
    .replace(/<\/p>\s*<p>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, e: string) => chars[e]!);
}

/** Rich text (post) as text: the title a line, each paragraph a line; a link as 文字（地址）, or the
 *  address where the two are the same; @ as @name; code fenced; a rule as ---; styles dropped. A
 *  picture as img: none for one that comes as an attachment. */
function postText(post: { title?: string; content?: any[][] }, img = ""): string {
  const piece = (x: any): string => {
    switch (x?.tag) {
      case "a":
        return !x.text || x.text === x.href ? String(x.href ?? "") : `${x.text}（${x.href}）`;
      case "at":
        return `@${x.user_name ?? x.user_id ?? ""}`;
      case "code_block":
        return `\`\`\`${String(x.language ?? "").toLowerCase()}\n${String(x.text ?? "").replace(/\n$/, "")}\n\`\`\``;
      case "hr":
        return "---";
      case "emotion":
        return `[${x.emoji_type}]`;
      case "img":
        return img;
      default:
        return typeof x?.text === "string" ? x.text : "";
    }
  };
  // An empty paragraph is a blank line; one of pictures alone is none.
  const lines = (post.content ?? []).flatMap((p) => (!Array.isArray(p) || !p.length ? [""] : p.some((x) => piece(x)) ? [p.map(piece).join("")] : []));
  return [...(post.title ? [post.title] : []), ...lines].join("\n").replace(/^\n+|\n+$/g, "");
}

type Forwarded = { message_id: string; upper_message_id?: string; msg_type: string; create_time: string; sender?: { id?: string }; body?: { content?: string } };

/** A forward's messages written out (spec "合并转发"): [合并转发，n 条], then each on a line, who
 *  (you 我, this bot Bot, others A, B, … as they first come) at what time, its text. A line after
 *  its first, and a forward's messages in it, indented two spaces more. Pictures, files and videos
 *  not fetched, cards as such: Feishu gives only a placeholder for one. At most FORWARD_MAX
 *  messages, the rest counted. top: the forward's id; items: all its messages, at every depth. */
function forwardText(top: string, items: Forwarded[], you: string, appId: string, now: number): string {
  const under = Map.groupBy(
    items.filter((i) => i.upper_message_id),
    (i) => i.upper_message_id!,
  );
  const others = new Map<string, string>();
  const who = (id = "") => (id === you ? "我" : id === appId ? "Bot" : others.get(id) ?? (others.set(id, letter(others.size)), others.get(id)!));
  const head = (id: string) => `[合并转发，${under.get(id)?.length ?? 0} 条]`;
  const body = (i: Forwarded): string => {
    let c: any = {};
    try {
      c = JSON.parse(i.body?.content ?? "{}");
    } catch {}
    switch (i.msg_type) {
      case "text":
        return textOf(c);
      case "post":
        return postText(c, "[图片，没取]");
      case "image":
        return "[图片，没取]";
      case "file":
        return `[文件 ${c.file_name ?? ""}，没取]`;
      case "media":
        return "[视频，没取]";
      case "sticker":
        return "[表情包，没取]";
      case "audio":
        return "[语音]";
      case "interactive":
        return "[卡片]";
      case "merge_forward":
        return head(i.message_id);
      default:
        return `[${i.msg_type}]`;
    }
  };
  const lines = [head(top)];
  let shown = 0;
  const write = (id: string, indent: string) => {
    for (const i of under.get(id) ?? []) {
      if (shown === FORWARD_MAX) return;
      shown++;
      const [first, ...rest] = body(i).split("\n");
      lines.push(`${indent}${who(i.sender?.id)} ${clockAt(Number(i.create_time), now)}：${first}`, ...rest.map((l) => `${indent}  ${l}`));
      if (i.msg_type === "merge_forward") write(i.message_id, `${indent}  `);
    }
  };
  write(top, "");
  const all = items.filter((i) => i.upper_message_id).length;
  if (all > shown) lines.push(`还有 ${all - shown} 条没展开`);
  return lines.join("\n");
}

/** A, B, … Z, then #27 and on: who else is in a forward, by when they first come. */
const letter = (n: number) => (n < 26 ? String.fromCharCode(65 + n) : `#${n + 1}`);

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The daemon's Feishu bot (id: its row id), with what it keeps for the backfill (spec "配置"): your
 *  private chat's id, kept by the app's id; and when this bot row first took the app in, by both, as
 *  a bot new to rhodium has nothing on record for the backfill to skip. */
// ponytail: a meta row per card sent, never dropped; drop those past the entity's 14 days if meta grows too big.
export function makeFeishu(id: string, name: string, bot: BotConfig, { kept, seen, durations }: AdapterDeps): FeishuAdapter {
  const [chatKey, sinceKey] = [`feishuChat:${bot.appId}`, `feishuSince:${id}:${bot.appId}`];
  if (kept.get(sinceKey) === undefined) kept.set(sinceKey, String(Date.now()));
  return new FeishuAdapter(id, name, bot, {
    editEvery: durations.feishuEdit,
    chat: kept.get(chatKey),
    saveChat: (chat) => kept.set(chatKey, chat),
    since: Number(kept.get(sinceKey)),
    seen,
    entity: (message) => kept.get(`feishuCard:${message}`),
    saveEntity: (message, entity) => kept.set(`feishuCard:${message}`, entity),
  });
}
