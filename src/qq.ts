// QQ adapter (architecture §8) on the official SDK. Connection, sending and chunking (now
// src/render.ts's chunkText) are adapted from qq-cli (github.com/Rhapsody0x1/qq-cli), under this notice:
//
// MIT License
//
// Copyright (c) 2026 Rhapsody0x1
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { setTimeout as sleep } from "node:timers/promises";
import {
  ApiError,
  MediaFileType,
  MsgType,
  QQBot,
  type InteractionEvent,
  type MessageResponse,
  type QQBotOptions,
  type QQBotInboundMessage,
  type SendMessageOptions,
  type UploadMediaResponse,
} from "@tencent-connect/qqbot-nodejs";
import { ApiClient, type SessionPersistencePort } from "@tencent-connect/qqbot-nodejs/protocol";
import type { BotConfig } from "./config";
import type { AdapterDeps, Capabilities, Connected, ImAdapter, InboundMessage, Kept, MenuItem, OutboundMessage, Profile, RowButton, SendResult } from "./contracts";
import { QQ_CAPABILITIES } from "./platforms";
import { errorKind } from "./avatars";
import { buttonRows } from "./panels";
import { literal } from "./render";

// msg_seq runs 1 to SEQ_MAX: QQ took 100000 (probe 13), past the SDK's own 16 bits, so two replies
// to one message rarely share one.
const SEQ_MAX = 2 ** 31 - 1;
// QQ's answer to a msg_id + msg_seq it has taken already: "消息被去重，请检查请求msgseq" (probe 13).
const DEDUPED = 40054005;

/** The fixed msg_seq for an outbound record (architecture §7.4). QQ drops a resend with the same
 *  msg_id + msg_seq; the SDK's default is random, so a retry would get through twice. */
export const msgSeq = (outboundId: string): number => (Bun.hash.crc32(outboundId) % SEQ_MAX) + 1;

/** An error's message with your openid, which the SDK's API paths hold, as <chat>: errors reach the
 *  log, which the board shows. */
const hidden = (e: unknown, chat: string): string => String((e as Error)?.message ?? e).replaceAll(chat, "<chat>");

/** failed only when the message surely did not arrive; anything else is unknown (architecture §7.4). */
function sendError(e: unknown, chat: string): { status: "failed" | "unknown"; error: string } {
  const error = hidden(e, chat);
  // Only the message request itself throws ApiError; a plain Error (no token, say) comes before it.
  if (!(e instanceof ApiError)) return { status: "failed", error };
  // The platform said no: a business code, or a 4xx. A timeout, a dropped connection (status 0) or
  // a gateway error page (5xx) may have come after QQ took the message.
  if (e.bizCode !== undefined) return { status: "failed", error: `${e.bizCode} ${error}` };
  if (e.httpStatus >= 400 && e.httpStatus < 500) return { status: "failed", error };
  return { status: "unknown", error };
}

/** The part of the SDK's QQBot the adapter uses; tests pass a fake. */
export type QQClient = {
  on(event: "message", handler: (ctx: unknown, msg: QQBotInboundMessage) => void): unknown;
  on(event: "interaction", handler: (ctx: unknown, event: InteractionEvent) => void): unknown;
  on(event: "ready" | "resumed" | "disconnected", handler: () => void): unknown;
  acknowledgeInteraction(id: string, code: number): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  send(opts: SendMessageOptions): Promise<MessageResponse>;
  uploadMedia(opts: Parameters<QQBot["uploadMedia"]>[0]): Promise<UploadMediaResponse>;
  api: { getToken(): Promise<string>; get<T>(path: string): Promise<T> };
};

/** Marks an event's id (a button press's) among message ids: QQ takes a reply to it as event_id, not msg_id. */
const EVENT = "event:";

// The menu and panel APIs live on the newer domain, not the SDK's default one (qq-cli).
const MENU_API = new ApiClient({ baseUrl: "https://api.bot.qq.com" });
// What marks Rhodium's own / panel among the bot's panels, as qq-cli marks its own "qq-cli".
const PANEL_REMARK = "rhodium";

/** A panel item's desc: QQ takes at most 30 characters, a Chinese one counting 2 (bot.qq.com's
 *  /v2/panels docs). Longer is cut short, with an ellipsis. */
function panelDesc(text: string, max = 30): string {
  const width = (c: string) => (c.charCodeAt(0) < 128 ? 1 : 2);
  const chars = [...text];
  if (chars.reduce((n, c) => n + width(c), 0) <= max) return text;
  let used = width("…");
  const kept: string[] = [];
  for (const c of chars) {
    if ((used += width(c)) > max) break;
    kept.push(c);
  }
  return `${kept.join("").trimEnd()}…`;
}

// The SDK reconnects a dropped socket by itself. These waits are for when its start() gives up:
// credentials refused, 4914 offline, 4915 banned, no network at startup. Same steps as the SDK's.
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000, 60_000];

type Log = (msg: string) => void;
type Download = (url: string) => Promise<Uint8Array>;
type MenuApi = Pick<ApiClient, "request">;
// cdn: QQ's avatar CDN, a test's stand-in in tests.
type Options = { client?: QQClient; delays?: readonly number[]; log?: Log; download?: Download; menuApi?: MenuApi; cdn?: string };

/** Fetches an attachment the message links to, as qq-cli does. */
async function httpDownload(url: string): Promise<Uint8Array> {
  // Downloads run one at a time, in order: a hung one must not hold up every message after it.
  const res = await fetch(url.startsWith("//") ? "https:" + url : url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const defaultLog = (name: string): Log => (msg) => console.error(`[qq ${name}] ${msg}`);

/** The SDK client for one [bots.<name>] entry. Credentials come from that entry alone: never from
 *  the env or ~/.config/qq-cli, which belong to qq-cli's own bot (story 157). sessionPersistence
 *  keeps the gateway session across restarts (architecture §5 step 7); tests point the URLs at a fake QQ. */
export function qqClient(
  name: string,
  config: BotConfig,
  log: Log = defaultLog(name),
  sdk: Pick<QQBotOptions, "sessionPersistence" | "baseUrl" | "tokenBaseUrl"> = {},
): QQBot {
  for (const key of ["appId", "secret"]) {
    if (!config[key]) throw new Error(`config: bots.${name}.${key} is required for a QQ bot`);
  }
  return new QQBot({
    ...sdk,
    appId: config.appId!,
    appSecret: config.secret!,
    logger: { info: () => {}, warn: log, error: log }, // info logs every API call
  });
}

/** Where the QQ bot's gateway session stands, kept so the next rhodium resumes it and QQ sends again
 *  what came meanwhile (architecture §5 step 7). Kept by the bot's appId, so another bot put under
 *  this name starts afresh. */
export function qqSession(kept: Kept, appId: string, bot: string): SessionPersistencePort {
  const key = `qqSession:${appId}`;
  return {
    load: () => JSON.parse(kept.get(key) ?? "null"),
    // ponytail: the SDK saves a frame's seq before it hands us the message, so a message rhodium dies
    // on before it is on record is not sent again on resume. A window of milliseconds.
    save: (session) => kept.set(key, JSON.stringify(session)),
    // The SDK takes the session as invalid (4006, 4007, 4009, 4900–4913, or op 9 not resumable) and
    // starts a new one: what came while it was disconnected is not sent again. QQ allows a resume on
    // 4009, but the SDK starts a new session anyway.
    clear: () => {
      kept.set(key, undefined);
      kept.event("qq_session_lost", { bot });
    },
  };
}

/** The daemon's QQ bot (id: its row id), resuming its gateway session. */
export const makeQQ = (id: string, name: string, bot: BotConfig, deps: AdapterDeps): QQAdapter =>
  new QQAdapter(id, name, bot, { client: qqClient(name, bot, undefined, { sessionPersistence: qqSession(deps.kept, bot.appId!, name) }) });

export { QQ_CAPABILITIES }; // the platform table's (platforms.ts), as tests know it

/** The message as it goes to QQ: one with buttons as Markdown, the only message QQ shows a keyboard
 *  on (2026-10-22, on a phone); its own Markdown if it has some, else its text as written. The fake
 *  IM's QQ-like bots send it so too. */
export const withKeyboard = (m: OutboundMessage): OutboundMessage =>
  m.buttons?.length && m.markdown === undefined ? { ...m, markdown: literal(m.text) } : m;

/** A message's plain text, sent once QQ turned its Markdown down: QQ shows no keyboard on it, so its
 *  buttons are written under it. Only an ask's (ask:) and one of the asks to pick from (pick:) get a
 *  number, the router reading a reply's number as theirs; a command's is written as the command to
 *  send, a copy button as the text it copies. Cancel, a page (muted) and a fill button not at all. */
function unbuttoned(m: OutboundMessage): string {
  const buttons = m.buttons ?? [];
  const numbered = buttons.filter((b) => /^(ask|pick):/.test(b.data)).map((b, i) => `${i + 1}. ${b.label}`);
  const commands = buttons.filter((b) => b.data.startsWith("/") && !b.muted && b.fill === undefined).map((b) => `${b.label}：${b.data}`);
  const copies = buttons.filter((b) => b.copy).map((b) => `${b.label}：${b.data}`);
  return [m.text, ...(numbered.length ? [numbered.join("\n"), "回编号选一个。"] : []), ...(commands.length ? [commands.join("\n")] : []), ...copies].join("\n\n");
}

export class QQAdapter implements ImAdapter {
  readonly capabilities: Capabilities = QQ_CAPABILITIES;
  private readonly client: QQClient;
  private readonly delays: readonly number[];
  private readonly log: Log;
  private readonly download: Download;
  private readonly menuApi: MenuApi;
  private readonly appId: string | undefined;
  private readonly cdn: string;

  constructor(
    readonly botId: string,
    readonly name: string,
    config: BotConfig,
    opts: Options = {},
  ) {
    this.log = opts.log ?? defaultLog(name);
    this.client = opts.client ?? qqClient(name, config, this.log);
    this.delays = opts.delays ?? RECONNECT_DELAYS;
    this.download = opts.download ?? httpDownload;
    this.menuApi = opts.menuApi ?? MENU_API;
    this.appId = config.appId;
    this.cdn = opts.cdn ?? "https://q.qlogo.cn";
  }

  /** The bot's avatar by /users/@me on the SDK's own token; yours from the public avatar CDN, by
   *  this bot's appId and your openid under it. QQ gives no name. The CDN's default penguin, marked
   *  X-Info: notexist, is none. */
  async profile(you: string | null): Promise<Profile> {
    const get = (what: string, f: () => Promise<Uint8Array | undefined>) =>
      f().catch((e) => void this.log(`cannot get ${what}: ${errorKind(e)}`));
    const [bot, mine] = await Promise.all([
      get("the bot's avatar", async () => {
        const { avatar } = await this.client.api.get<{ avatar?: string }>("/users/@me");
        return avatar ? this.download(avatar) : undefined;
      }),
      you && this.appId
        ? get("your avatar", async () => {
            const res = await fetch(`${this.cdn}/qqapp/${this.appId}/${you}/100`, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.headers.get("x-info") === "notexist" ? undefined : new Uint8Array(await res.arrayBuffer());
          })
        : undefined,
    ]);
    return { ...(bot && { bot }), ...(mine && { you: mine }) };
  }

  /** Holds the gateway connection while iterated; stopping the iteration disconnects. One reader at a
   *  time: the SDK allows one start() per bot. Sending needs no connection. */
  messages(connected: Connected = () => {}): AsyncIterable<InboundMessage> {
    const stop = new AbortController();
    return new ReadableStream<InboundMessage>({
      start: (out) => {
        this.client.on("message", (_ctx, msg) => {
          // v1 does private chats only (architecture §8).
          if (msg.kind !== "c2c" || stop.signal.aborted) return;
          out.enqueue(this.inbound(msg));
        });
        this.client.on("interaction", (_ctx, e) => {
          // QQ waits 3 s for an answer, and shows the press failed without one; the answer is a code,
          // no words. So every press is answered at once, before rhodium decides what it means.
          void this.client.acknowledgeInteraction(e.id, 0).catch((err) => this.log(`cannot answer a button press: ${err?.message ?? err}`));
          if (e.scene !== "c2c" || !e.user_openid || stop.signal.aborted) return;
          out.enqueue(this.press(e));
        });
        // The SDK reconnects a dropped socket by itself, and says so.
        this.client.on("ready", () => connected(true));
        this.client.on("resumed", () => connected(true));
        this.client.on("disconnected", () => connected(false));
        void this.connect(stop.signal, connected);
      },
      cancel: () => stop.abort(),
    });
  }

  /** A private message, its attachments not yet downloaded; a quote is the quoted message's index
   *  (architecture §8.3). A voice message's text is QQ's own transcript of it, as qq-cli takes it;
   *  the recording comes as a file. */
  private inbound(msg: QQBotInboundMessage): InboundMessage {
    const attachments = (msg.attachments ?? []).map((a) => ({
      kind: a.content_type?.startsWith("image/") ? ("image" as const) : ("file" as const),
      ...(a.filename && { name: a.filename }),
      fetch: () => this.download(a.url),
    }));
    const asr = (msg.attachments ?? []).map((a) => a.asr_refer_text?.trim()).filter(Boolean).join(" ");
    return {
      bot: this.botId,
      chat: msg.senderId, // a private chat is named by the user's openid
      messageId: msg.messageId,
      sender: msg.senderId,
      text: [(msg.content ?? "").trim(), asr && `[语音转写] ${asr}`].filter(Boolean).join("\n"),
      at: Date.parse(msg.timestamp) || Date.now(),
      ...(attachments.length > 0 && { attachments }),
      ...(msg.msgIdx && { ref: msg.msgIdx }),
      ...(msg.refMsgIdx && { quote: { ref: msg.refMsgIdx } }),
    };
  }

  /** A button pressed in a private chat. QQ does not say which message carried it, and nothing needs
   *  to know. Its id is the event's, marked as one, so a reply to the press goes as event_id (send). */
  private press(e: InteractionEvent): InboundMessage {
    const user = e.user_openid!;
    const button = { data: e.data.resolved.button_data ?? "", message: "" };
    return { bot: this.botId, chat: user, messageId: EVENT + e.id, sender: user, text: "", at: Date.parse(e.timestamp ?? "") || Date.now(), button };
  }

  /** Never throws: a failed bot waits and tries again, the others carry on (architecture §8.6). */
  private async connect(stop: AbortSignal, connected: Connected) {
    let attempt = 0;
    this.client.on("ready", () => (attempt = 0));
    for (; !stop.aborted; attempt++) {
      let error: string | undefined;
      try {
        await this.client.start(stop);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
        this.log(`gateway stopped: ${error}`);
      }
      if (!stop.aborted) connected(false, error);
      const delay = this.delays[Math.min(attempt, this.delays.length - 1)];
      await sleep(delay, undefined, { signal: stop }).catch(() => {});
    }
  }

  /** chat is the user's openid. One message per call: the renderer splits long text (render.ts's chunkText).
   *  message.seq is required (msgSeq of the outbound record); without it the SDK would pick a random one. */
  async send(chat: string, sent: OutboundMessage): Promise<SendResult> {
    const message = withKeyboard(sent);
    if (message.seq === undefined) return { status: "failed", error: "qq: outbound message has no seq" };
    // A reply to a button press names the press's event, by event_id; one to a message, by msg_id.
    const event = message.replyTo?.startsWith(EVENT) ? { event_id: message.replyTo.slice(EVENT.length) } : undefined;
    const target = { scope: "c2c" as const, targetId: chat, ...(message.replyTo && !event ? { msgId: message.replyTo } : {}) };
    let media: { file_info: string } | undefined;
    if (message.file) {
      // Uploaded on its own first, so the message itself goes out with our fixed msg_seq (architecture §7.4).
      const { kind, path, name } = message.file;
      const fileType = kind === "image" ? MediaFileType.IMAGE : MediaFileType.FILE;
      try {
        const up = await this.client.uploadMedia({ target, fileType, localPath: path, ...(kind === "file" && { fileName: name }), srvSendMsg: false });
        media = { file_info: up.file_info };
      } catch (e) {
        // ponytail: a timed-out upload is failed too: whatever QQ kept of it, no message was sent.
        return { status: "failed", error: `upload: ${hidden(e, chat)}` };
      }
    }
    // Callback buttons (action.type 1), anyone may press (permission.type 2): a press comes back as an
    // interaction event (messages()), as probe 15 showed in private chats. A fill or copy button is a
    // command button (action.type 2) that only puts its text in the input box (enter false). Pressed,
    // a button reads ✓ and its label, without the ★ of the one in use when it was sent; cancel, back
    // and the pages are grey (docs/im-style.md §2.1, §11.2).
    let n = 0;
    const qqButton = (b: NonNullable<OutboundMessage["buttons"]>[number]) => {
      const fill = b.copy ? b.data : b.fill;
      return {
        id: String(++n),
        render_data: { label: b.label, visited_label: `✓ ${b.label.replace(/^★ /, "")}`, style: b.muted ? 0 : 1 },
        action: fill === undefined ? { type: 1, permission: { type: 2 }, data: b.data } : { type: 2, permission: { type: 2 }, data: fill, enter: false },
      };
    };
    const keyboard = message.buttons?.length ? { content: { rows: buttonRows(message.buttons).map((r) => ({ buttons: r.map(qqButton) })) } } : undefined;
    const post = async (body: Partial<SendMessageOptions>, seq: number, again = false): Promise<SendResult> => {
      try {
        const r = await this.client.send({ target, ...body, extra: { msg_seq: seq, ...event } });
        return { status: "sent", messageId: r.id, ...(r.ext_info?.ref_idx && { ref: r.ext_info.ref_idx }) };
      } catch (e) {
        const r = sendError(e, chat);
        if (again) {
          // QQ dropped the second try as a resend: the first got there, under an id we never heard.
          if (e instanceof ApiError && e.bizCode === DEDUPED) return { status: "sent" };
          // Anything else leaves the first try's fate open: unknown, never failed, so it goes neither
          // as plain text nor as an active message, and cannot arrive twice (architecture §7.4).
          return { status: "unknown", error: r.error };
        }
        // A passive reply that may have arrived goes once more under the same msg_seq, which QQ
        // dedupes on with the msg_id (probe 13). Not an active one, nor a reply to a button press
        // (event_id, no msg_id): whether QQ dedupes those is untested.
        if (r.status === "unknown" && target.msgId) {
          this.log(`passive reply outcome unknown, sending again: ${r.error}`);
          return post(body, seq, true);
        }
        // ponytail: any business code on a passive reply means its msg_id is spent, as qq-cli has it,
        // a seq clash (DEDUPED on the first try) included; on an active message, that the bot has none
        // left. Narrow to QQ's quota codes once they show up: probe 12 met none.
        const spent = r.status === "failed" && e instanceof ApiError && e.bizCode !== undefined;
        return spent ? { ...r, quota: true } : r;
      }
    };
    if (media) return post({ msgType: MsgType.MEDIA, media, ...(message.text && { content: message.text }) }, message.seq);
    if (message.markdown === undefined) return post({ content: message.text }, message.seq);
    // QQ takes Markdown only from a bot it approved for it. Whatever it turns down goes again as plain
    // text, under a msg_seq of its own in case QQ counts the first as used; refused for the quota, it
    // is refused again, and reported as before. QQ shows no keyboard on plain text: it goes without one.
    const r = await post({ msgType: MsgType.MARKDOWN, markdown: { content: message.markdown }, ...(keyboard && { keyboard }) }, message.seq);
    if (r.status !== "failed") return r;
    this.log(`markdown turned down, sending plain text: ${r.error}`);
    return post({ content: unbuttoned(message) }, (message.seq % SEQ_MAX) + 1);
  }

  async edit(_chat: string, _messageId: string, _message: OutboundMessage): Promise<SendResult> {
    return { status: "failed", error: "qq: messages cannot be edited" };
  }

  // A sent message cannot change, so its buttons stay; a press on one for a settled ask gets 已失效.
  async dropButtons(_chat: string, _messageId: string): Promise<SendResult> {
    return { status: "failed", error: "qq: messages cannot be edited, so their buttons stay" };
  }

  /** The press was answered to QQ as it came in (messages()). QQ shows no words for it, so words come
   *  as a reply to the press: one of the passive replies it brings, no other quota. QQ turned the
   *  interaction's id down as event_id on the dev bot (40034025, 2026-10-22): then an active message. */
  // ponytail: the active one skips the router's quota count, as rare as a press on a spent button; drop
  // it once the event_id QQ takes (likely the gateway dispatch's id, which the SDK keeps) is known.
  async answerPress(chat: string, press: string, text: string): Promise<void> {
    if (!text) return;
    let r = await this.send(chat, { text, replyTo: press, seq: msgSeq(press) });
    if (r.status === "failed") r = await this.send(chat, { text, seq: (msgSeq(press) % SEQ_MAX) + 1 });
    if (r.status !== "sent") throw new Error(r.error);
  }

  /** The row: the custom menu all private chats share (architecture §8.4), as qq-cli's `qq commands`
   *  sets it, each button sending its command; a folder a menu of such. */
  async setRow(row: RowButton[]): Promise<void> {
    const send = (b: { label: string; command: string }) => ({ type: "send_message", name: b.label, send_message: b.command });
    const items = row.map((b) => ("sub" in b ? { type: "menu", name: b.label, sub_menu_items: b.sub.map(send) } : send(b)));
    await this.menuApi.request(await this.client.api.getToken(), "PUT", "/v2/menu", { menu: { items } });
  }

  /** The / menu: the panel typing / brings up, Rhodium's own one, found by its remark and made if
   *  missing; the bot's other panels are left alone. */
  async setMenu(items: MenuItem[]): Promise<void> {
    const token = await this.client.api.getToken();
    const body = { remark: PANEL_REMARK, items: items.map((i) => ({ type: "command", name: i.command, desc: panelDesc(i.description) })) };
    // One page holds them all: a bot has at most 20 panels.
    const list = await this.menuApi.request<{ records?: { panel_id: string; panel?: { remark?: string } }[] }>(token, "GET", "/v2/panels?scope=c2c&limit=50");
    const ours = list.records?.find((r) => r.panel?.remark === PANEL_REMARK);
    if (ours) await this.menuApi.request(token, "PUT", `/v2/panels/${ours.panel_id}`, { panel: body });
    else await this.menuApi.request(token, "POST", "/v2/panels", { scope: "c2c", target_type: "all", panel: body });
  }
}

