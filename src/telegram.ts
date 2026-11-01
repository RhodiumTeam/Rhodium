// Telegram adapter (architecture §8) on grammY: long polling for private messages, sending and
// editing. How far it has read (the getUpdates offset) is kept by rhodium, so a restart reads on
// from there.
import { setTimeout as sleep } from "node:timers/promises";
import { Api, GrammyError, InputFile } from "grammy";
import type { CallbackQuery, Message, Update } from "grammy/types";
import type { BotConfig } from "./config";
import { errorKind } from "./avatars";
import type { AdapterDeps, Button, Capabilities, Connected, ImAdapter, InboundMessage, MenuItem, OutboundMessage, Profile, RowButton, SendResult } from "./contracts";
import { buttonRows } from "./panels";
import { TELEGRAM_CAPABILITIES } from "./platforms";

export { TELEGRAM_CAPABILITIES }; // the platform table's (platforms.ts), as tests know it

/** Inline buttons in their rows; none takes them off a message edited (docs/im-style.md §11.3). */
const button = (b: Button) => (b.copy ? { text: b.label, copy_text: { text: b.data } } : { text: b.label, callback_data: b.data });
const keyboard = (buttons: Button[]) => ({ reply_markup: { inline_keyboard: buttonRows(buttons).map((r) => r.map(button)) } });

const POLL_SECONDS = 30;
// Every call gives up after a long poll's time and some. A send not answered by then may still
// have arrived: unknown (architecture §7.4).
const TIMEOUT_SECONDS = POLL_SECONDS + 10;
const RETRY_DELAYS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
// A flood wait longer than this, or past this many tries, fails the request instead.
const FLOOD_WAIT_MAX = 60;
const FLOOD_TRIES = 3;

type Log = (msg: string) => void;
type Options = {
  offset?: number; // the getUpdates offset to start from, as last saved
  saveOffset?: (offset: number) => void;
  log?: Log;
};

export class TelegramAdapter implements ImAdapter {
  readonly capabilities: Capabilities = TELEGRAM_CAPABILITIES;
  private readonly api: Api;
  private readonly token: string;
  private readonly apiRoot: string;
  private readonly log: Log;

  /** The token and an optional apiRoot (a local Bot API server, or a test's) come from the
   *  [bots.<name>] table. */
  constructor(
    readonly botId: string,
    readonly name: string,
    config: BotConfig,
    private readonly opts: Options = {},
  ) {
    if (!config.token) throw new Error(`config: bots.${name}.token is required for a Telegram bot`);
    this.token = config.token;
    this.apiRoot = config.apiRoot ?? "https://api.telegram.org";
    this.api = new Api(config.token, { timeoutSeconds: TIMEOUT_SECONDS, apiRoot: this.apiRoot });
    this.log = opts.log ?? ((msg) => console.error(`[telegram ${name}] ${msg}`));
  }

  /** Call once. An update counts as read once the next one is asked for, by when rhodium has
   *  taken it in; only then is its offset saved. Never throws: a failed poll waits and tries again.
   *  The first poll, and the first after a failed one, comes back at once, so connected hears right away. */
  async *messages(connected: Connected = () => {}): AsyncGenerator<InboundMessage> {
    let offset = this.opts.offset;
    for (let failures = 0, first = true; ; ) {
      let updates: Update[];
      try {
        updates = await this.api.getUpdates({ offset, timeout: first ? 0 : POLL_SECONDS, allowed_updates: ["message", "callback_query"] });
        failures = 0;
        first = false;
        connected(true);
      } catch (e) {
        first = true;
        const error = this.redact(e);
        connected(false, error);
        this.log(`getUpdates failed: ${error}`);
        await sleep(RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)]);
        continue;
      }
      for (const u of updates) {
        const m = this.inbound(u.message) ?? this.press(u.callback_query);
        if (m) yield m;
        offset = u.update_id + 1;
        this.opts.saveOffset?.(offset);
      }
    }
  }

  /** A button pressed in a private chat: its data, and the message that carried the button. Its id
   *  is the press's, which answerPress answers. */
  private press(q: CallbackQuery | undefined): InboundMessage | null {
    const m = q?.message;
    if (!q || !m || m.chat.type !== "private" || q.data === undefined) return null;
    const button = { data: q.data, message: String(m.message_id), ...("text" in m && m.text !== undefined && { text: m.text }) };
    return { bot: this.botId, chat: String(m.chat.id), messageId: q.id, sender: String(q.from.id), text: "", at: Date.now(), button };
  }

  /** A private message as Rhodium takes it: text, or a picture or a file with its caption, not yet
   *  downloaded; a voice message only as such, caption and all, as there is no transcript of it yet.
   *  null for anything else (architecture §8). */
  private inbound(m: Message | undefined): InboundMessage | null {
    const media = m?.photo?.at(-1) ?? m?.document; // a photo comes in several sizes, the largest last
    const caption = m?.text ?? m?.caption;
    if (!m?.from || m.chat.type !== "private") return null;
    if (m.voice) return { bot: this.botId, chat: String(m.chat.id), messageId: String(m.message_id), sender: String(m.from.id), text: "", at: m.date * 1000, voice: true };
    if (caption === undefined && !media) return null;
    // A picture sent as a file is still a picture.
    const kind = m.photo || m.document?.mime_type?.startsWith("image/") ? "image" : "file";
    const r = m.reply_to_message;
    return {
      bot: this.botId,
      chat: String(m.chat.id),
      messageId: String(m.message_id),
      sender: String(m.from.id),
      text: caption ?? "",
      at: m.date * 1000,
      ...(media && { attachments: [{ kind, ...(m.document?.file_name && { name: m.document.file_name }), fetch: () => this.download(media.file_id) }] }),
      ...(r && { quote: this.quote(r, m.quote?.text) }),
    };
  }

  /** Telegram brings the quoted text along: the part you picked, else the whole message. A picture's
   *  or a file's caption leaves out where it is kept, so the store's text comes first then, the
   *  caption only if the store has none (architecture §8.3). */
  private quote(r: Message, picked?: string): NonNullable<InboundMessage["quote"]> {
    const ref = String(r.message_id);
    if (picked !== undefined) return { ref, text: picked };
    return r.photo || r.document ? { ref, ...(r.caption !== undefined && { fallback: r.caption }) } : { ref, text: r.text ?? r.caption };
  }

  /** The bot's avatar and yours, each the smallest size of at least 160px, else the largest, which
   *  rhodium downloads: the file's URL holds the token. Your name, from getChat: your first and last
   *  names, else @username. */
  async profile(you: string | null): Promise<Profile> {
    const get = <T>(what: string, f: () => Promise<T | undefined>) => f().catch((e) => void this.log(`cannot get ${what}: ${errorKind(e)}`));
    const photo = async (user: number) => {
      const sizes = (await this.api.getUserProfilePhotos(user, { limit: 1 })).photos[0] ?? [];
      const size = sizes.filter((s) => s.width >= 160).sort((a, b) => a.width - b.width)[0] ?? sizes.toSorted((a, b) => b.width - a.width)[0];
      return size && this.download(size.file_id);
    };
    const [bot, mine, name] = await Promise.all([
      get("the bot's avatar", async () => photo((await this.api.getMe()).id)),
      you ? get("your avatar", () => photo(Number(you))) : undefined,
      you
        ? get("your name", async () => {
            const c = (await this.api.getChat(you)) as { first_name?: string; last_name?: string; username?: string };
            return [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : undefined);
          })
        : undefined,
    ]);
    return { ...(bot && { bot }), ...(mine && { you: mine }), ...(name && { name }) };
  }

  /** Its error never carries the token, which is in the file's URL. */
  private async download(fileId: string): Promise<Uint8Array> {
    try {
      const { file_path } = await this.api.getFile(fileId);
      if (!file_path) throw new Error("getFile gave no file_path");
      const res = await fetch(`${this.apiRoot}/file/bot${this.token}/${file_path}`, { signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Error(this.redact(e));
    }
  }

  /** A file goes as a photo, a GIF as an animation (as a photo it would stand still), anything else
   *  as a document; the text as its caption. A photo Telegram turns down, say one too tall or too
   *  long (PHOTO_INVALID_DIMENSIONS), goes as a document: it took nothing, so it never comes twice. */
  // ponytail: an upload over TIMEOUT_SECONDS comes back unknown; give sends with files longer if large ones time out.
  send(chat: string, message: OutboundMessage): Promise<SendResult> {
    const f = message.file;
    const caption = message.text ? { caption: message.text } : {};
    const markup = message.buttons?.length ? keyboard(message.buttons) : {};
    return this.result(async () => {
      if (!f) {
        const sent = await this.markdownOr<{ message_id: number }>(
          message.markdown,
          (markdown) => this.api.sendRichMessage(chat, { markdown }, markup),
          () => this.api.sendMessage(chat, message.text, markup),
        );
        return String(sent.message_id);
      }
      const file = () => new InputFile(f.path, f.name);
      const photo = () =>
        this.api.sendPhoto(chat, file(), caption).catch((e) => {
          if (!(e instanceof GrammyError && e.error_code === 400)) throw e;
          this.log(`photo turned down, sending it as a document: ${e.description}`);
          return this.api.sendDocument(chat, file(), caption);
        });
      const sent =
        f.kind === "file"
          ? await this.api.sendDocument(chat, file(), caption)
          : /\.gif$/i.test(f.name)
            ? await this.api.sendAnimation(chat, file(), caption)
            : await photo();
      return String(sent.message_id);
    });
  }

  /** A plain message edits into a rich one and back (scripts/probes/telegram/rich.ts). Buttons, even
   *  none, replace the message's; left out, an edit shows none (Telegram's way). */
  edit(chat: string, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const id = Number(messageId);
    const markup = message.buttons ? keyboard(message.buttons) : {};
    return this.edited(messageId, () =>
      this.markdownOr(
        message.markdown,
        (markdown) => this.api.editMessageText(chat, id, { markdown }, markup),
        () => this.api.editMessageText(chat, id, message.text, markup),
      ),
    );
  }

  dropButtons(chat: string, messageId: string): Promise<SendResult> {
    return this.edited(messageId, () => this.api.editMessageReplyMarkup(chat, Number(messageId), { reply_markup: { inline_keyboard: [] } }));
  }

  /** An edit; one to what the message shows already, which Telegram calls an error, is done too. */
  private edited(messageId: string, call: () => Promise<unknown>): Promise<SendResult> {
    return this.result(async () => {
      await call().catch((e) => {
        if (!(e instanceof GrammyError && /message is not modified/.test(e.description))) throw e;
      });
      return messageId;
    });
  }

  /** Rich Markdown where there is any, else plain text. Plain text too when Telegram turns the
   *  Markdown down, so a message never fails for its formatting. */
  private async markdownOr<T>(markdown: string | undefined, rich: (markdown: string) => Promise<T>, plain: () => Promise<T>): Promise<T> {
    if (markdown === undefined) return plain();
    try {
      return await rich(markdown);
    } catch (e) {
      if (!(e instanceof GrammyError && e.error_code === 400) || /message is not modified/.test(e.description)) throw e;
      this.log(`rich message turned down, sending plain text: ${e.description}`);
      return plain();
    }
  }

  async answerPress(_chat: string, press: string, text: string): Promise<void> {
    await this.api.answerCallbackQuery(press, text ? { text } : {});
  }

  /** Per chat, as probe 16 found (architecture §8.4): the default menu stays as it is. */
  async setMenu(items: MenuItem[], chat?: string): Promise<void> {
    // Telegram refuses the whole menu for one description over 256 characters.
    const short = (d: string) => (d.length > 256 ? `${d.slice(0, 255)}…` : d);
    const commands = items.map((i) => ({ command: i.command.replace(/^\//, ""), description: short(i.description) }));
    await this.api.setMyCommands(commands, chat ? { scope: { type: "chat", chat_id: chat } } : {});
  }

  /** The row (architecture §8.4): a reply keyboard comes only with a message, so a short one to the
   *  chat carries it, one row that stays under the input box. Its buttons send their command as you. */
  async setRow(row: RowButton[], chat?: string): Promise<void> {
    const keyboard = [row.flatMap((b) => ("command" in b ? [{ text: b.command }] : []))];
    await this.api.sendMessage(chat!, "常用按钮放在输入框下面了。", { reply_markup: { keyboard, is_persistent: true, resize_keyboard: true } });
  }

  /** failed only when Telegram said no; a timeout, a dropped connection or a 5xx may have come
   *  after it took the message, so those are unknown (architecture §7.4). Over its flood limit
   *  (429) Telegram took nothing, so that is waited out and tried again, a few times; past that it
   *  is failed, for its flood. */
  private async result(call: () => Promise<string>): Promise<SendResult> {
    for (let tries = 1; ; tries++) {
      try {
        return { status: "sent", messageId: await call() };
      } catch (e) {
        const wait = e instanceof GrammyError && e.error_code === 429 ? e.parameters.retry_after : undefined;
        if (wait !== undefined && wait <= FLOOD_WAIT_MAX && tries < FLOOD_TRIES) {
          this.log(`flood limit: trying again in ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        const error = this.redact(e);
        if (wait !== undefined) return { status: "failed", error, flood: true };
        return e instanceof GrammyError && e.error_code < 500 ? { status: "failed", error } : { status: "unknown", error };
      }
    }
  }

  /** grammY leaves the token out of its errors; this makes sure of it. */
  private redact(e: unknown): string {
    return String((e as Error)?.message ?? e).replaceAll(this.token, "<token>");
  }
}

/** The daemon's Telegram bot (id: its row id), reading on from where the last rhodium had read. */
export function makeTelegram(id: string, name: string, bot: BotConfig, { kept }: AdapterDeps): TelegramAdapter {
  // Kept by the bot's own id, the token's part before ':', so another bot put under this name starts afresh.
  const key = `telegramOffset:${bot.token?.split(":")[0]}`;
  const offset = kept.get(key);
  return new TelegramAdapter(id, name, bot, { offset: offset === undefined ? undefined : Number(offset), saveOffset: (n) => kept.set(key, String(n)) });
}
