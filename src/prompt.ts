// What Rhodium tells the agent (architecture §6.1). What stays the same goes in the appended system
// prompt: rh's usage, the reply conventions (product §5.5), each bot's format limits. Where a
// message came from goes in its first line. Agent-facing text is Chinese, like rh --skill.
import { skillText } from "./commands";
import { FROM_BOARD, SENT_AT, type Capabilities } from "./contracts";
import { span } from "./panels";

/** The first line of a message of yours from IM: the chat it came through, as you call it (router's chatName). */
export const sourceLine = (chat: string): string => `[来自 ${chat}]`;

/** When at was, as now sees it: 21:05, or 10-22 21:05 on another day. Not 昨天: the agent reads it. */
export function clockAt(at: number, now: number): string {
  const [t, n] = [new Date(at), new Date(now)];
  const two = (x: number) => String(x).padStart(2, "0");
  const day = t.toDateString() === n.toDateString() ? "" : `${two(t.getMonth() + 1)}-${two(t.getDate())} `;
  return `${day}${two(t.getHours())}:${two(t.getMinutes())}`;
}

/** Your message from IM with its source line saying when you sent it (clockAt): for one the agent
 *  gets long after (runner's deliver). */
export function withSentAt(text: string, at: number, now: number): string {
  return text.replace(/^(\[来自 [^\n]*)\]\n/, `$1${SENT_AT}${clockAt(at, now)}]\n`);
}

/** The first line of a message rh send brings, from, say, 槽位 w/a or 用户的终端. */
export const sendLine = (from: string): string => `[来自 ${from}，经 rh send]`;

/** The first line of a child slot's report to its parent (architecture §9.3). */
export const REPORT_LINE = "[来自 Rhodium：子槽位汇报]";

/** What Rhodium tells an agent it resumes after a crash (product §4.5). Claude gets its own instead
 *  (architecture §4.8). */
export const RESUME_PROMPT = "上一回合被打断，先检查现状再继续。";

const SOURCE = /^\[来自 ([^\n]*)\]\n/;

/** A message's text without the source line at its start, if it has one. */
export const withoutSource = (text: string): string => text.replace(SOURCE, "");

/** Where a message came from as its source line says, say QQ 私聊 (null without one), and its text without that line. */
export function splitSource(text: string): { source: string | null; text: string } {
  const m = SOURCE.exec(text);
  return { source: m?.[1] ?? null, text: m ? text.slice(m[0].length) : text };
}

const EXTENSION: Record<NonNullable<Capabilities["markdown"]>["extensions"][number], string> = {
  math: "公式",
  spoiler: "剧透",
  mark: "高亮",
  html: "HTML 标签",
  emoji: ":表情名:",
  heading: "行首 # 后不带空格",
};

/** What Markdown a bot shows (render.ts's markdown escapes the syntax it adds to GFM). */
function markdown(md: Capabilities["markdown"]): string {
  if (!md) return "只显示纯文本，不要用 Markdown。";
  const raw = md.extensions.map((x) => EXTENSION[x]);
  return raw.length ? `可以用 Markdown；${raw.join("、")}的写法会按原文显示。` : "可以用 Markdown。";
}

/** The appended system prompt. bots: every bot Rhodium runs, as a message may come through any of
 *  them and rh send to you may go out through any (product §5.9); each by
 *  your private chat with it as the source line names it (router's chatOf), and what rh send takes for
 *  that chat (router's sendWord). oneoffArchive, sentAtAfter: the config's. */
export function systemPrompt(bots: { chat: string; send: string | null; caps: Capabilities }[], oneoffArchive: number, sentAtAfter: number): string {
  const limits = bots.map(({ chat, send, caps }) => `- ${chat}${send === null ? "" : `（\`rh send ${send}\`）`}：一条消息最多 ${caps.maxTextLength} 字，更长的自动分成几条；${markdown(caps.markdown)}`);
  return [
    "# Rhodium",
    "",
    "你是 Rhodium 托管的无头 agent。用户不在终端前，而是在手机上的 IM 里和你说话，看不到你的终端输出。",
    "",
    "## 消息从哪来",
    "",
    `用户从 IM 发来的消息，第一行写明从哪个窗口来，例如 ${sourceLine("QQ 私聊")}。这一行是 Rhodium 加的，不是用户写的。`,
    `用户的消息发出后超过 ${span(sentAtAfter)}才交给你的（例如排队等额度），这一行还写发送时间，例如 [来自 QQ 私聊，发送于 21:05]；不是当天的写成 [来自 QQ 私聊，发送于 10-22 21:05]。`,
    "以 / 开头的命令原样交给你，不带这一行。除此之外，没有这一行的消息不是用户从 IM 发的，例如 rh spawn 交给你的任务。",
    `第一行是 ${sourceLine(FROM_BOARD)} 的，是用户在 Rhodium 的网页上发的。`,
    `别的槽位用 rh send 发来的消息，第一行是 ${sendLine("槽位 w/a")} 这样，回它就用 rh send w/a。`,
    `你派生的子槽位完成或卡住时，Rhodium 发来一条汇报，第一行是 ${REPORT_LINE}。用户用 /rh_use 把某个窗口指向子槽位、直接和它对话时，它不汇报；用户发起或插过话的回合，子槽位跑完也不汇报。要看子槽位的状态和最近的对话，用 rh read。`,
    "",
    "## 回复约定",
    "",
    "- 用户从 IM 发来的消息开始的回合，回合结束时，你的最后一条回复就是最终回复，由 Rhodium 发回那个窗口。直接回答，不要自己再发一遍。",
    "- 这样的回合里，你说的话会实时转给用户，进度直接写在回复里。不要往同一个窗口用 `rh send me` 发文字：那样这一回合后面的话和最终回复都不再转发。",
    "- `rh send me` 只用来发文件、图片，以及内部回合里要告诉用户的话。内部回合是汇报、rh send 等别的消息开始的回合，没有人在等你回复。",
    "- `rh send me` 按默认规则发：用户最后在哪给你说话就发到哪，网页也算。在 IM 里，是现在指着你的窗口里用户最近用的那个；你是子槽位、没有窗口指着你时，发到指着根槽位的窗口里用户最近用的那个；都没有就发主窗口。落在网页上时，有网页开在前台就留在网页上，没有就改发 IM。",
    "- 也可以指定去处：`rh send qq`、`rh send telegram`、`rh send feishu` 发到用户在那个平台上的私聊，`rh send web` 留在网页上，`rh send <Bot 名>` 从那个 Bot 发。每个 Bot 的写法见下面“各 Bot 的格式限制”。指定的地方发不出去，改按默认规则发。",
    "- 回执写明发到了哪、有没有改发，照回执告诉用户，不要自己猜。",
    "- Rhodium 不记去处。用户要你定期往某处推，例如“往 Telegram 推进度”，每次都带上去处。",
    "- 在一个回合里用带文字的 `rh send me` 发到了这个回合的窗口，Rhodium 就不再转发你这个回合后面说的话（工具行照常显示），也不再代发最终回复，免得用户收到两遍。发到了别的窗口时照常转发；只发文件、不带文字的不算。之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，你后面说的话和最终回复照常转发。",
    "- 用户从网页发来的消息开始的回合，过程和回复由网页显示，不要用 `rh send me` 再发一遍。回合中途用户从 IM 发来消息、或者在 IM 里回答了你的提问，就和从 IM 开始的回合一样。",
    "- 别的消息开始的回合，最终回复不发回 IM；你是子槽位时，它的开头会随汇报交给父槽位。要让用户知道，用 `rh send me`；你有父槽位时，见最后一条。",
    "- 这样的回合里，用户从 IM 发来消息后，就和用户开始的回合一样：你后面说的话实时转给他，最终回复发回那个窗口。",
    "- 你有父槽位、用户又没在直接和你说话（没有窗口用 /rh_use 指着你，这一回合也不是用户从 IM 或网页发起或插过话的）时，`rh send me` 会被拒：把结果和文件路径写进最终回复，它会随汇报交给父槽位，由父槽位决定告诉用户什么，不用再 `rh send` 给父槽位。用户要你往某处推时，带上去处就能发，例如 `rh send telegram`。",
    "",
    "## 各 Bot 的格式限制",
    "",
    "回复要在手机上读，按消息来的那个 Bot 的限制写。每个 Bot 按它私聊的叫法列出，和消息第一行的写法一样，括号里是 `rh send` 指定发到那里的写法：",
    "",
    ...limits,
    "",
    skillText(oneoffArchive),
  ].join("\n");
}
