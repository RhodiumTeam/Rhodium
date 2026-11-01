// Probes 12-15 (QQ): passive reply quota and lifetime, msg_seq dedup, missed messages after a
// disconnect, and buttons in private chats. Connects to the dev bot the way src/qq.ts does (same
// SDK, WebSocket gateway) and prints one JSON line per received message, gateway event and command
// result. Every send is a passive reply to a message the owner sent: nothing proactive, ever.
//
// Usage: bun scripts/probes/qq/probe.ts [command-file]
// Commands come from stdin and, if given, from lines appended to command-file:
//   reply <msg_id> <n>          n replies to one message, msg_seq 1, 2, 3... (probe 12)
//   reply-after <msg_id> <sec>  one more reply after a delay (probe 12, lifetime)
//   dup <msg_id> <seq>          the same msg_seq twice in a row (probe 13)
//   down                        drop the gateway connection, no reconnect (probe 14)
//   up [resume|new]             connect again, resuming the old session or identifying anew (probe 14)
//   button <msg_id> [md|text]   a reply with buttons: markdown (default) or text message (probe 15);
//                               since 2026-10-22, on a phone, a text message shows no buttons
//   quit
// <msg_id> may be `last`, the latest message from the owner.
// Credentials: ~/.config/rhodium-dev/qq-cli/config.env (QQBOT_APP_ID, QQBOT_APP_SECRET);
// owner openid: allow.txt next to it.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { ApiError, MsgType, QQBot, type InlineKeyboard, type SendMessageOptions } from "@tencent-connect/qqbot-nodejs";

const dir = `${homedir()}/.config/rhodium-dev/qq-cli`;
const env = Object.fromEntries(
  readFileSync(`${dir}/config.env`, "utf8")
    .split("\n")
    .map((l) => l.trim().match(/^(?:export\s+)?(\w+)=["']?(.*?)["']?$/))
    .filter((m) => m !== null)
    .map((m) => [m[1], m[2]]),
);
const owner = readFileSync(`${dir}/allow.txt`, "utf8").trim().split(/\s+/)[0]!;
const appId = env.QQBOT_APP_ID!;
const secret = env.QQBOT_APP_SECRET!;
if (!appId || !secret || !owner) throw new Error(`missing QQBOT_APP_ID, QQBOT_APP_SECRET or owner openid in ${dir}`);

const scrub = (s: string) => s.replaceAll(secret, "<secret>");
const out = (ev: string, data: Record<string, unknown> = {}) =>
  console.log(scrub(JSON.stringify({ t: new Date().toISOString(), ev, ...data })));

// The last gateway session, kept so `up resume` can RESUME it; `up new` makes the SDK IDENTIFY.
let saved: { sessionId: string; lastSeq: number | null } | null = null;
let resume = false;
const bot = new QQBot({
  appId,
  appSecret: secret,
  logger: {
    info: (msg) => out("sdk", { level: "info", msg }),
    warn: (msg) => out("sdk", { level: "warn", msg }),
    error: (msg) => out("sdk", { level: "error", msg }),
  },
  sessionPersistence: {
    load: () => (resume ? saved : null),
    save: (s) => (saved = s),
    clear: () => (saved = null),
  },
});

const chats = new Map<string, string>(); // msg_id -> sender openid
const seqs = new Map<string, number>(); // msg_id -> last msg_seq used
let last: string | undefined;
let downAt: number | undefined;
let upAt = Date.now();

bot.on("ready", (d) => out("ready", { data: d }));
bot.on("resumed", (d) => out("resumed", { data: d }));
bot.on("disconnected", (d) => out("disconnected", { ...d }));
bot.on("error", (e) => out("error", { message: e.message }));
bot.on("message", (_ctx, m) => {
  chats.set(m.messageId, m.senderId);
  if (m.senderId === owner && m.kind === "c2c") last = m.messageId;
  const sentAt = Date.parse(m.timestamp);
  out("message", {
    msg_id: m.messageId,
    openid: m.senderId,
    owner: m.senderId === owner,
    kind: m.kind,
    timestamp: m.timestamp,
    content: m.content,
    msg_idx: m.msgIdx,
    attachments: m.attachments?.length,
    // Sent while we were offline, delivered on reconnect (probe 14).
    late: sentAt < upAt,
    ...(downAt !== undefined && sentAt < upAt && { sent_after_down_s: (sentAt - downAt) / 1000 }),
    delay_s: (Date.now() - sentAt) / 1000,
  });
});
bot.on("interaction", async (_ctx, e) => {
  out("interaction", { event: e });
  // Without an ack the phone shows the button press as failed.
  try {
    await bot.acknowledgeInteraction(e.id, 0);
    out("interaction-ack", { id: e.id, ok: true });
  } catch (err) {
    out("interaction-ack", { id: e.id, ok: false, ...apiError(err) });
  }
});
bot.on("rawEvent", (ctx) => out("raw", { type: ctx.eventType, data: ctx.data }));

let run: AbortController | undefined;
function up(mode: "resume" | "new") {
  if (run) return out("cmd-error", { error: "already up" });
  resume = mode === "resume";
  out("up", { mode, saved_session: saved, down_for_s: downAt ? (Date.now() - downAt) / 1000 : null });
  upAt = Date.now();
  const r = (run = new AbortController());
  bot
    .start(r.signal)
    .then(() => out("stopped"))
    .catch((e) => out("start-failed", { message: String(e?.message ?? e) }))
    .finally(() => run === r && (run = undefined));
}
function down() {
  if (!run) return out("cmd-error", { error: "already down" });
  run.abort();
  run = undefined;
  downAt = Date.now();
  out("down", { saved_session: saved });
}

function apiError(e: unknown) {
  if (e instanceof ApiError) return { http: e.httpStatus, code: e.bizCode, error: e.bizMessage ?? e.message };
  return { error: String((e as Error)?.message ?? e) };
}

/** One passive reply. msg_id is always set, so this can never be a proactive message. */
async function reply(probe: string, msgId: string, seq: number, body: Partial<SendMessageOptions>) {
  const openid = chats.get(msgId)!;
  seqs.set(msgId, Math.max(seqs.get(msgId) ?? 0, seq));
  const started = Date.now();
  try {
    const r = await bot.send({ target: { scope: "c2c", targetId: openid, msgId }, ...body, extra: { msg_seq: seq } });
    out("sent", { probe, msg_id: msgId, seq, ok: true, ms: Date.now() - started, response: r });
  } catch (e) {
    out("sent", { probe, msg_id: msgId, seq, ok: false, ms: Date.now() - started, ...apiError(e) });
  }
}
const text = (s: string) => ({ msgType: MsgType.TEXT, content: s });

// Custom keyboard, as in the docs: action.type 1 = callback (INTERACTION_CREATE, ack within 3 s),
// 2 = command (puts data in the input box; enter: true sends it at once, private chats only);
// permission.type 2 = everyone.
const keyboard = {
  content: {
    rows: [
      {
        buttons: [
          { id: "cb", render_data: { label: "回调", visited_label: "已点回调", style: 1 }, action: { type: 1, permission: { type: 2 }, data: "probe15-callback" } },
          { id: "cmd", render_data: { label: "指令", visited_label: "已点指令", style: 0 }, action: { type: 2, permission: { type: 2 }, data: "probe15 指令按钮", enter: true } },
        ],
      },
    ],
  },
} as InlineKeyboard; // the SDK's type lacks `enter`

async function command(line: string) {
  const [cmd, a, b] = line.trim().split(/\s+/);
  if (!cmd) return;
  out("cmd", { line: line.trim() });
  const id = a === "last" ? last : a;
  const needsMsg = ["reply", "reply-after", "dup", "button", "say"].includes(cmd);
  if (needsMsg && (!id || chats.get(id) !== owner)) return out("cmd-error", { error: `unknown msg_id or not the owner's: ${a}` });
  const msgId = id!;
  const next = () => (seqs.get(msgId) ?? 0) + 1;
  switch (cmd) {
    case "reply": {
      const n = Number(b ?? 1);
      for (let i = 1; i <= n; i++) {
        const seq = next();
        await reply("12", msgId, seq, text(`probe12 reply ${i}/${n} seq=${seq}`));
      }
      return;
    }
    case "reply-after": {
      const sec = Number(b ?? 0);
      out("scheduled", { msg_id: msgId, at: new Date(Date.now() + sec * 1000).toISOString() });
      setTimeout(() => {
        const seq = next();
        void reply("12-after", msgId, seq, text(`probe12 reply after ${sec}s seq=${seq}`));
      }, sec * 1000);
      return;
    }
    case "dup": {
      const seq = Number(b ?? next());
      await reply("13", msgId, seq, text(`probe13 seq=${seq} (1/2)`));
      await reply("13", msgId, seq, text(`probe13 seq=${seq} (2/2)`));
      return;
    }
    case "button": {
      const seq = next();
      const body =
        b === "text"
          ? { msgType: MsgType.TEXT, content: `probe15 text+buttons seq=${seq}`, keyboard }
          : { msgType: MsgType.MARKDOWN, markdown: { content: `probe15 markdown+buttons seq=${seq}` }, keyboard };
      return reply(`15-${b ?? "md"}`, msgId, seq, body);
    }
    case "say": {
      // A passive reply with free text, for telling you what to do next during a probe.
      const seq = next();
      return reply("say", msgId, seq, text(line.trim().split(/\s+/).slice(2).join(" ")));
    }
    case "down":
      return down();
    case "up":
      return up(a === "new" ? "new" : "resume");
    case "quit":
      return quit();
    default:
      out("cmd-error", { error: `unknown command: ${cmd}` });
  }
}

// Commands run one at a time, in order.
let queue = Promise.resolve();
const enqueue = (line: string) => (queue = queue.then(() => command(line)).catch((e) => out("cmd-error", { error: String(e) })));

const file = process.argv[2];
if (file) {
  if (!existsSync(file)) writeFileSync(file, "");
  let offset = statSync(file).size; // skip commands left over from an earlier run
  let partial = "";
  setInterval(() => {
    const size = statSync(file).size;
    if (size <= offset) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop()!;
    lines.forEach(enqueue);
  }, 250);
}
(async () => {
  for await (const line of console) enqueue(line);
})();
function quit(): never {
  run?.abort();
  out("quit");
  process.exit(0);
}
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

out("start", { app_id: appId, owner, command_file: file ?? null });
up("new");
