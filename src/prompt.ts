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

/** The first line of your decision on an agent's confirm request (product §5.8). */
export const DECISION_LINE = "[来自 Rhodium：确认结果]";

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

// How an agent shows you a picture: in its reply, which the board shows and IM sends (architecture §8.3).
const PICTURES = "要给用户看的图片，在回复里写 `![说明](绝对路径)`。只认你的目录和 /tmp 里的图片文件；发到 IM 时一条回复最多带 10 张。";

/** The appended system prompt. bots: every bot Rhodium runs, as a message may come through any of
 *  them and rh send to you may go out through any (product §5.9); each by
 *  your private chat with it as the source line names it (router's chatOf), and what rh send takes for
 *  that chat (router's sendWord). oneoffArchive, sentAtAfter: the config's. child: for a child slot,
 *  which sends you no words (architecture §6.1): its reply conventions are its own, and no bot has a
 *  word of rh send's. tui: for an agent Rhodium starts in Herdr's terminal, where what it says goes
 *  to no IM and no parent, and an unmarked message is typed by you there (§6.1, product §4.2). */
export function systemPrompt(bots: { chat: string; send: string | null; caps: Capabilities }[], oneoffArchive: number, sentAtAfter: number, child = false, tui = false): string {
  const limits = bots.map(({ chat, send, caps }) => `- ${chat}${send === null || child ? "" : `（\`rh send ${send}\`）`}：一条消息最多 ${caps.maxTextLength} 字，更长的自动分成几条；${markdown(caps.markdown)}`);
  const headless = child
    ? [
        "- 把结果写在最终回复里。交给谁由 Rhodium 定：平时回合结束时，它的开头随汇报交给父槽位，由父槽位决定告诉用户什么；用户直接找你时（用 /rh_use 把窗口指向你，或者这一回合是用户发来的消息开始的），发给用户。两种情况你都只管写好最终回复，不用自己再发一遍。",
        "- 用户发来的消息开始的回合里，你说的话会实时转给用户，进度直接写在回复里。",
        "- 用户直接找你要文件时，用 `rh send me --file <路径>` 发，不带文字。",
        "- 可以用 `rh send <工作区/槽位>` 给别的槽位发消息，父槽位也行，要写全名。结果写在最终回复里，会自动汇报，不用再发给父槽位。只有需要父槽位中途做事时才发。",
        "- 要问用户事情，照常提问，Rhodium 会推给用户。",
        "- 用户要你定期汇报时，这个要求在这段对话里一直有效：你自己定时、读进度，到点把进度写在最终回复里。",
        "- 用用户的语言回复。",
        `- ${PICTURES}`,
      ]
    : [
        "- 用户从 IM 发来的消息开始的回合，回合结束时，你的最后一条回复就是最终回复，由 Rhodium 发回那个窗口。直接回答，不要自己再发一遍。",
        "- 这样的回合里，你说的话会实时转给用户，进度直接写在回复里。不要往同一个窗口用 `rh send me` 发文字：那样这一回合后面的话和最终回复都不再转发。",
        "- `rh send me` 是往用户的 IM 推一条通知，只用来发文件，以及在内部回合里告诉用户事。内部回合是汇报、rh send 等别的消息开始的回合，没有人在等你回复。网页不算去处：你说的每一句话，网页上本来就看得到。",
        "- `rh send me` 推到现在指着你的窗口里用户最近用的那个，都没有就推到主窗口。用户最后是在网页上给你说话、网页又开在前台时不推，回执会写明。这一次发的内容网页上看得到，不用再写一遍；之后要说的话写在回复里就行。",
        "- 也可以指定去处：`rh send qq`、`rh send telegram`、`rh send feishu` 发到用户在那个平台上的私聊，`rh send <Bot 名>` 从那个 Bot 发。每个 Bot 的写法见下面“各 Bot 的格式限制”。指定的地方发不出去，改照 `rh send me` 的规则发。",
        "- 回执写明推到了哪、有没有改发、有没有推，照回执告诉用户，不要自己猜。",
        "- Rhodium 不记去处，也不替你定时。用户要你定期汇报（例如“每半小时往 Telegram 说一下进度”），这个要求在这段对话里一直有效：你自己定时、读进度，到点用 `rh send` 发，每次都带上去处。",
        "- 在一个回合里用带文字的 `rh send me` 发到了这个回合的窗口，Rhodium 就不再转发你这个回合后面说的话（工具行照常显示），也不再代发最终回复，免得用户收到两遍。发到了别的窗口时照常转发；只发文件、不带文字的不算。之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，你后面说的话和最终回复照常转发。",
        "- 用户从网页发来的消息开始的回合，过程和回复由网页显示，不要用 `rh send me` 再发一遍。回合中途用户从 IM 发来消息、或者在 IM 里回答了你的提问，就和从 IM 开始的回合一样。",
        "- 别的消息开始的回合，最终回复不发回 IM。要让用户知道，用 `rh send me`。",
        "- 这样的回合里，用户从 IM 发来消息后，就和用户开始的回合一样：你后面说的话实时转给他，最终回复发回那个窗口。",
        "- 你派生的子槽位不能直接给用户发消息。它的结果随汇报交给你，由你决定告诉用户什么。",
        "- 用用户的语言回复。",
        `- ${PICTURES}要给用户文件，用 \`rh send me --file <路径>\`。`,
      ];
  // In the terminal the conventions on which replies go back to IM go (the root's 1st, 2nd and 8th
  // to 11th; all of a child's but its file, language and picture ones), three of its own first: the
  // exception, your IM message's turn going back to its chat, since the second batch (#723).
  const inTerminal = [
    "- 你在终端里说的话只在终端和网页上看得到，不发到 IM，也不汇报给父槽位。用户在终端前时，直接回答就行。",
    `- 例外：用户从 IM 发来的消息（第一行是 ${sourceLine("QQ 私聊")} 这类 IM 窗口名）开始或并进的回合，你说的话 Rhodium 会实时转回那个窗口，最终回复也会发过去，和无头时一样。进度和结果直接写在回复里，不要再用 rh send 往同一个窗口发文字：那样会停掉这一回合后面的转发和最终回复。`,
    "- 别的槽位发来的消息要回，用 `rh send <工作区/槽位>`。",
  ];
  const conventions = !tui
    ? headless
    : child
      ? [...inTerminal, headless[2]!, ...headless.slice(6)]
      : [...inTerminal, "- 要让不在电脑前的用户知道事，用 `rh send me`。", ...headless.slice(2, 7), ...headless.slice(11)];
  const opening = tui
    ? `你是 Rhodium 托管的 agent，${child ? "是别的槽位派生的子槽位，" : ""}现在在 Herdr 的终端里运行（TUI 模式）。用户可能就坐在终端前，也可能不在电脑前。`
    : child
      ? "你是 Rhodium 托管的无头 agent，是别的槽位派生的子槽位。用户看不到你的终端输出。"
      : "你是 Rhodium 托管的无头 agent。用户不在终端前，而是在手机上的 IM 里和你说话，看不到你的终端输出。";
  // Your IM and board messages from before the switch are still in the conversation, which it may
  // resume; with type-in on, Rhodium types those of after it too (architecture §6.1, §10.5).
  const from = tui
    ? [
        `切到终端以后，没有来源行的消息是用户在终端里亲手打的。Rhodium 也会往你的输入框里打字，送来别的槽位用 rh send 发来的消息、子槽位的汇报和确认请求的结果。这些消息的第一行永远是 [来自 …]。别的槽位和子槽位发来的请求，按平时的判断照做；只是它们不算用户的同意或批准，需要用户点头的事（例如要确认的命令、改用户的配置）不能拿它们当依据。确认结果里是用户对你那一条确认请求的决定，只管那一条。第一行是 ${sendLine("用户的终端")} 的，是用户在自己的终端里用 rh send 发的。长的消息可能整条包在粘贴标签（<pasted_content>）里，这时照标签里第一行的来源行处理，和没包时一样。`,
        "",
        `第一行是 ${sourceLine("QQ 私聊")}、${sourceLine(FROM_BOARD)} 这类窗口名的，是用户在 IM、网页上发的，切到终端以前、以后都有：Rhodium 也把用户从 IM、网页发的消息打进你的输入框。图片和文件只给了路径，每个一行，要看就按路径读。`,
        ...(child ? ["rh spawn 交给你的任务没有来源行，是父槽位写的，不是用户发的。"] : []),
      ]
    : [
        `用户从 IM 发来的消息，第一行写明从哪个窗口来，例如 ${sourceLine("QQ 私聊")}。这一行是 Rhodium 加的，不是用户写的。`,
        `用户的消息发出后超过 ${span(sentAtAfter)}才交给你的（例如排队等额度），这一行还写发送时间，例如 [来自 QQ 私聊，发送于 21:05]；不是当天的写成 [来自 QQ 私聊，发送于 10-22 21:05]。`,
        "以 / 开头的命令原样交给你，不带这一行。除此之外，没有这一行的消息不是用户从 IM 发的，例如 rh spawn 交给你的任务。",
        `第一行是 ${sourceLine(FROM_BOARD)} 的，是用户在 Rhodium 的网页上发的。`,
      ];
  return [
    "# Rhodium",
    "",
    opening,
    "",
    "## 消息从哪来",
    "",
    ...from,
    `别的槽位用 rh send 发来的消息，第一行是 ${sendLine("槽位 w/a")} 这样，回它就用 rh send w/a。`,
    `你派生的子槽位完成或卡住时，Rhodium 发来一条汇报，第一行是 ${REPORT_LINE}。用户用 /rh_use 把某个窗口指向子槽位、直接和它对话时，它不汇报；用户发起或插过话的回合，子槽位跑完也不汇报。要看子槽位的状态和最近的对话，用 rh read。`,
    `你发起的确认请求有了结果，Rhodium 发来一条消息，第一行是 ${DECISION_LINE}。`,
    "",
    "## 回复约定",
    "",
    ...conventions,
    "",
    "## 各 Bot 的格式限制",
    "",
    `回复要在手机上读，按消息来的那个 Bot 的限制写。每个 Bot 按它私聊的叫法列出，和消息第一行的写法一样${child ? "" : "，括号里是 `rh send` 指定发到那里的写法"}：`,
    "",
    ...limits,
    "",
    skillText(oneoffArchive, child),
  ].join("\n");
}
