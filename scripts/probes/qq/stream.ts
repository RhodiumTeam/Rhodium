// QQ's C2C stream messages (stream_messages, #797, architecture §8.2 QQ): what a stream takes, how long
// it lives, and what QQ answers. Each mode streams replies to the latest message you sent the bot, so
// send it one first, and watch the replies on a phone. Every stream is a passive reply: nothing proactive.
//
// Usage: bun scripts/probes/qq/stream.ts <config.toml> <bot> <rh.db> <mode> [minutes]
//   config.toml, bot: the Rhodium config and the [bots.<bot>] table whose appId and secret it uses.
//   rh.db: that instance's database, where the latest message you sent the bot is found.
// Modes (results of 2026-11-17 in brackets):
// - basic: text typed out, a frame every 400 ms; a frame that changes what was shown; a 70 s pause;
//   then three plain passive replies to the same message [all taken but the changed frame, 40111001;
//   six passive replies to one message all went].
// - rescue: a frame that changes what was shown, then one that grows the old one, then the close
//   [refused, then both taken].
// - prefix: a closing frame that changes what was shown, then one that grows it [40111001, then taken].
// - idle <minutes>: a frame, then nothing for that long, then more and the close [5 min taken;
//   15 min 40034020, the close too].
// - long: one stream grown to about 2600 characters [58 frames, all shown, none cut].
// - reopen: frames after the close, and the index from 0 again [40034018; 40111002].
// - recall: a plain reply and a stream, each recalled after 3 s [the plain one goes, leaving
//   "对方撤回了一条消息"; the stream 40061001, not recalled].
// - keep: a frame every 60 s till refused [9 min 03 s taken, 10 min 03 s 40034020: counted from the start].
// - normal: a plain reply while a stream is open, then the stream grows and closes [all taken; what
//   the stream grew after shows above the plain reply].
//
// Out: /tmp/rhodium-test-qq-probe/stream.jsonl, each call's step, HTTP status, code, message and
// time, appended run after run; no credentials, ids or contents.
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

const [configPath, botName, dbPath, mode, arg] = process.argv.slice(2);
if (!configPath || !botName || !dbPath || !mode) throw new Error("usage: stream.ts <config.toml> <bot> <rh.db> <mode> [minutes]");
const bot = (Bun.TOML.parse(readFileSync(configPath, "utf8")) as { bots?: Record<string, { appId?: string; secret?: string }> }).bots?.[botName];
if (!bot?.appId || !bot.secret) throw new Error(`no appId and secret in [bots.${botName}]`);

// The latest message you sent the bot: what every stream replies to.
const db = new Database(dbPath, { readonly: true });
const anchor = db
  .query("select i.platformMsgId msg, c.platformChatId chat from inbound i join chat c on c.id = i.chat join bot b on b.id = c.bot where b.name = ? order by i.receivedAt desc limit 1")
  .get(botName) as { msg: string; chat: string } | null;
if (!anchor) throw new Error(`no message to ${botName} on record: send it one first`);
const { msg, chat } = anchor;

const OUT = "/tmp/rhodium-test-qq-probe";
mkdirSync(OUT, { recursive: true });
const log = (o: object) => {
  appendFileSync(`${OUT}/stream.jsonl`, `${JSON.stringify({ t: new Date().toISOString(), mode, ...o })}\n`);
  console.log(JSON.stringify(o));
};
const sleep = (ms: number) => Bun.sleep(ms);
const token = ((await (await fetch("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: bot.appId, clientSecret: bot.secret }) })).json()) as { access_token: string }).access_token;

async function call(step: string, method: string, path: string, body?: object): Promise<{ id?: string; code?: number }> {
  const t0 = performance.now();
  const r = await fetch(`https://api.sgroup.qq.com${path}`, { method, headers: { authorization: `QQBot ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { id?: string; code?: number; err_code?: number; message?: string };
  log({ step, http: r.status, code: j.code ?? j.err_code, msg: j.message, ms: Math.round(performance.now() - t0) });
  return { id: j.id, code: j.code ?? j.err_code };
}

/** A stream replying to the anchor: frame() sends the next frame, the index one up, done closing it. */
function stream(name: string, seq: number) {
  let sid: string | undefined;
  let index = 0;
  return {
    async frame(text: string, done = false, step = `${name}-${index}${done ? "-done" : ""}`, at = index++) {
      const r = await call(step, "POST", `/v2/users/${chat}/stream_messages`, { input_mode: "replace", input_state: done ? 10 : 1, content_type: "markdown", content_raw: text, event_id: msg, msg_id: msg, msg_seq: seq, index: at, ...(sid && { stream_msg_id: sid }) });
      sid ??= r.id;
      return r;
    },
    get id() {
      return sid;
    },
  };
}
const plain = (step: string, seq: number, text: string) => call(step, "POST", `/v2/users/${chat}/messages`, { msg_type: 2, markdown: { content: text }, msg_id: msg, msg_seq: seq });
// msg_seqs of their own per mode and run: one used on this message before is taken and never shown.
const SEQ = 1000 + (Date.now() % 100_000) * 10;

if (mode === "basic") {
  const s = stream("typed", SEQ);
  const words = [..."探针：这是一段模拟 agent 逐字输出的文字，用来看 QQ 流式消息的效果。每次传累积的全量文本。"];
  let t = "**[逐字]** ";
  for (let i = 0; i < words.length; i += 3) (await s.frame((t += words.slice(i, i + 3).join(""))), await sleep(400));
  await s.frame(t, true);
  const c = stream("changed", SEQ + 1);
  await c.frame("**[改前缀]** 读了 3 个文件，正在运行 Bash"), await sleep(1500);
  await c.frame("**[改前缀]** 读了 3 个文件，跑了 Bash"), await sleep(1500);
  await c.frame("**[改前缀]** 读了 3 个文件，正在运行 Bash。收尾", true);
  const p = stream("pause70", SEQ + 2);
  await p.frame("**[停 70 秒]** 这一帧之后 70 秒不更新"), await sleep(70_000);
  await p.frame("**[停 70 秒]** 这一帧之后 70 秒不更新。接上了", true);
  for (const i of [1, 2, 3]) await plain(`passive-${i}`, SEQ + 2 + i, `**[被动回复 ${i}]** 同一条入站消息`);
} else if (mode === "rescue" || mode === "prefix") {
  const s = stream(mode, SEQ);
  const a = `**[${mode}]** 前缀`;
  await s.frame(a), await sleep(1000);
  await s.frame("改了前缀的一帧", mode === "prefix"), await sleep(1000);
  await s.frame(`${a}，被拒之后接着原来的前缀发，再收尾`, true);
} else if (mode === "idle") {
  const min = Number(arg ?? 5);
  const s = stream(`idle${min}`, SEQ);
  const a = `**[停 ${min} 分钟]** 这一帧之后 ${min} 分钟不更新`;
  await s.frame(a), await sleep(min * 60_000);
  await s.frame(`${a}\n${min} 分钟后追加的一行`), await sleep(1000);
  await s.frame(`${a}\n${min} 分钟后追加的一行\n\n收尾。`, true);
} else if (mode === "long") {
  const s = stream("long", SEQ);
  let t = "**[超长]** 一条流逐步长到 2600 字：\n\n";
  while (t.length < 2600) (await s.frame((t += "这是一段用来凑长度的文字，每段五十个字左右，看一条流超过两千字的上限时平台怎么处理它。\n\n"))), await sleep(400);
  await s.frame(`${t}（共 ${t.length} 字）`, true);
} else if (mode === "reopen") {
  const s = stream("reopen", SEQ);
  const a = "**[收尾后再发]** 第一版";
  await s.frame(a), await sleep(1500);
  await s.frame(`${a}。`, true), await sleep(1500);
  await s.frame(`${a}。收尾后追加的`, false, "after-done"), await sleep(1500);
  await s.frame(`${a}。index 从 0 再来`, false, "index-reset", 0);
} else if (mode === "recall") {
  const r = await plain("recall-plain", SEQ, "**[撤回]** 这条普通回复 3 秒后撤回");
  await sleep(3000);
  if (r.id) await call("recall-plain-delete", "DELETE", `/v2/users/${chat}/messages/${encodeURIComponent(r.id)}`);
  const s = stream("recall-stream", SEQ + 1);
  await s.frame("**[撤回流]** 收尾 3 秒后撤回"), await sleep(1000);
  await s.frame("**[撤回流]** 收尾 3 秒后撤回", true), await sleep(3000);
  if (s.id) await call("recall-stream-delete", "DELETE", `/v2/users/${chat}/messages/${encodeURIComponent(s.id)}`);
} else if (mode === "keep") {
  const s = stream("keep", SEQ);
  let t = "**[保活]** 每 60 秒推一帧，看第几分钟被拒";
  for (let k = 0; k <= 25; k++) {
    if ((await s.frame((t += `\n第 ${k} 分钟`))).code) {
      await s.frame(`${t}（收尾）`, true);
      break;
    }
    await sleep(60_000);
  }
} else if (mode === "normal") {
  const s = stream("normal", SEQ);
  const a = "**[普通消息打断]** 流开着";
  await s.frame(a), await sleep(2000);
  await plain("normal-plain", SEQ + 1, "**[普通消息打断]** Bot 在流开着时发的一条普通消息"), await sleep(2000);
  await s.frame(`${a}，普通消息之后追加`), await sleep(1000);
  await s.frame(`${a}，普通消息之后追加。收尾`, true);
} else throw new Error(`unknown mode ${mode}`);
log({ step: "done" });
