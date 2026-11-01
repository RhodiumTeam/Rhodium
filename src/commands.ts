// The one definition of rh's commands (docs/spec/v1.md "rh 命令"). `rh --help`, the agent's
// `rh --skill`, IM's /rh_help and the command menus are all generated from it.
// User-facing text is Chinese, like the rest of what the user reads.
import { homedir } from "node:os";
import { AGENT_KINDS, AGENTS, DEFAULT_AGENT } from "./agents";
import { durations, parseDuration } from "./config";
import type { AgentKind, Choice, Importable, MenuItem, RowButton } from "./contracts";
import { moment, span, type Candidate } from "./panels";
import { amid, MADE, PLATFORMS, series, type Made } from "./platforms";
import { clip } from "./render";

/** you: only the user may run it, an agent's call is refused. both: the user and agents. */
export type Who = "you" | "both";

export type CommandDef = {
  name: string;
  usage: string; // after "rh <name> "
  /** Given when a one-off slot is archived (oneoff()), for those that say so. */
  summary: string | ((oneoff: string) => string);
  who: Who;
  options?: Record<string, { type: "string" | "boolean" }>;
  /** Changes nothing, so a caller rh cannot recognize may run it too. "bare": only with no arguments;
   *  "list": only with --list. */
  readOnly?: true | "bare" | "list";
  /** An agent running it on a slot not its own descendant needs your confirmation (product §6.2).
   *  always: an agent's call does on any slot, and so does your /rh_ in chat (rh release, architecture §10.1).
   *  some: an agent's call does in the cases its summary names, which the router knows (product §5.11). */
  confirm?: true | "always" | "some";
};

/** Per-slot settings for `rh set`: key on the command line -> what it is. */
export const SETTINGS = {
  approval: { label: "审批模式", kind: "flag" },
  // Not archive, which is what you mean by 回收 a slot (GLOSSARY): an agent took one for the other.
  reap: { label: "回收时长", kind: "duration", note: "空闲多久停掉进程，槽位还在，不是归档" },
  "ask-timeout": { label: "提问超时", kind: "duration" },
  "crash-resume": { label: "崩溃续跑", kind: "flag" },
  "auto-continue": { label: "额度续跑", kind: "flag" },
} as const;
export type SettingKey = keyof typeof SETTINGS;

export const SLOT_HINT = "槽位写成 工作区/槽位，例如 shop/fix-login。";

/** The agents --agent takes, as usage lines write them: claude|pi. */
const KINDS = AGENT_KINDS.join("|");

export const COMMANDS: CommandDef[] = [
  {
    name: "ls",
    usage: "[<工作区/槽位>] [--all]",
    summary: "列出槽位和状态，--all 连已归档的也列出；给了槽位就看它的详情和设置",
    who: "both",
    options: { all: { type: "boolean" } },
    readOnly: true,
  },
  {
    name: "ws",
    usage: "[<名字> <目录>]",
    summary: "不带参数列出工作区；带参数新建工作区，目录是它的默认目录",
    who: "both",
    readOnly: "bare",
  },
  {
    name: "new",
    usage: `<工作区/槽位> [--dir <目录>] [--agent ${KINDS}]`,
    summary: "新建槽位：无头模式，有消息来才起进程。不给目录就用工作区的默认目录，agent 默认 claude",
    who: "both",
    options: { dir: { type: "string" }, agent: { type: "string" } },
  },
  {
    name: "spawn",
    usage: `<名字> [--dir <目录>] [--agent ${KINDS}] [--longterm] [--] <任务>`,
    summary: (oneoff) =>
      "派生子槽位，任务作为它的第一条消息发给它。子槽位落到默认目录为这个目录的工作区，没有就新建一个；不给目录就用当前目录，agent 默认 claude。" +
      `默认一次性：${oneoff}；--longterm 一直保留。任务以 - 开头时，前面加 --`,
    who: "both",
    options: { dir: { type: "string" }, agent: { type: "string" }, longterm: { type: "boolean" } },
  },
  {
    name: "stop",
    usage: "<工作区/槽位> | --all",
    // --all is the one part agents may not use (product §6.2); the router knows it too.
    summary: "停掉槽位的进程，对话保留；下一条消息来时自动恢复。--all 停掉所有 agent，出事时紧急刹车，只有用户本人能用",
    who: "both",
    options: { all: { type: "boolean" } },
    confirm: true,
  },
  {
    name: "archive",
    usage: "<工作区/槽位>",
    summary: "归档槽位：停掉进程，对话保留，rh ls 默认不再列出它",
    who: "both",
    confirm: true,
  },
  {
    name: "unarchive",
    usage: "<工作区/槽位>",
    summary: "恢复归档的槽位。给已归档的槽位发消息也会自动恢复它",
    who: "both",
  },
  {
    name: "rm",
    usage: "<工作区/槽位>",
    summary: "删除已归档、进程停着的槽位，回不来：Rhodium 忘掉它的记录，agent 自己的对话文件不动，要接着用就 rh import",
    who: "you",
  },
  {
    name: "rename",
    usage: "<工作区/槽位> <新名字>",
    summary:
      "给槽位改名，只能在同一个工作区里改。绑定、对话和正在跑的进程都不受影响；配置文件里 Bot 的 target 是这个槽位的，先备份配置文件，再把那一行引号里的名字改成新名字",
    who: "both",
    confirm: true,
  },
  {
    name: "agent",
    usage: `<工作区/槽位> ${KINDS} [!]`,
    summary:
      "换 agent：槽位从这种 agent 的一段新对话开始，不带之前的上下文。默认等当前回合结束再换；加 ! 先打断当前回合。" +
      "旧对话留在槽位的时间线上，IM 里发 /resume 能回去",
    who: "both",
    confirm: true,
  },
  {
    name: "tui",
    usage: "<工作区/槽位> [!]",
    summary:
      "切到 TUI 模式：停掉无头进程，在 Herdr 里这个工作区的 workspace 开一个 tab，接着同一段对话。默认等当前回合结束再切；加 ! 先打断当前回合。" +
      "TUI 模式期间，从 IM 发给它的消息不交给它",
    who: "both",
    confirm: true,
  },
  {
    name: "release",
    usage: "<工作区/槽位>",
    summary:
      "强制切回无头：结束终端里的 agent，关掉它的 tab，槽位接着用终端里最后那段对话。会结束终端里的进程，所以 agent 调用和 IM 里发的 /rh_release 都先在 IM 里请用户确认，只有用户本人从自己的终端调用时不用确认",
    who: "both",
    confirm: "always",
  },
  {
    name: "import",
    usage: "[<对话 ID 或它的开头> | <pane ID>] [--name <名字>] [--dir <目录>]",
    summary:
      "把不是 Rhodium 开的对话接管成槽位。给对话 ID：从磁盘上的对话记录导入，槽位落到默认目录为对话所在目录的工作区（没有就新建），无头，下一条消息接着这段对话。" +
      "给 pane ID（例如 w1:p1）：导入 Rhodium 用的 Herdr 会话里这个 pane 里正在用的 agent，槽位直接处于 TUI 模式，你在 pane 里退出 agent 后切回无头。" +
      "别的进程或 pane 正在用这段对话时不导入。槽位名默认取对话 ID 的前 8 位。" +
      "都不给就列出可以导入的：Herdr 会话里报告了对话的 agent，和目录里槽位没用过的对话（pane 里正在用的只列一次，作为 pane）；目录默认是当前目录，IM 里是这个聊天窗口的槽位的目录",
    who: "both",
    options: { name: { type: "string" }, dir: { type: "string" } },
    readOnly: "bare",
  },
  {
    name: "send",
    usage: "me [--file <路径>]... [<文字>] | <工作区/槽位> <文字>",
    summary:
      "给用户发消息，发到现在指着你的聊天窗口，有几个时取用户最近用的那个；没有窗口指着你时，子槽位用指着根槽位的窗口，再没有就发主窗口。" +
      "发到哪个由 Rhodium 定，你选不了，不要向用户承诺发到某个平台。" +
      "只用来发文件、图片，以及内部回合（汇报、rh send 等没有人在等回复的回合）里要告诉用户的话；用户从 IM 开始的回合，或者用户从 IM 发的消息并进来的回合，进度直接写在回复里。文字原样发出，以 - 开头也行；那个窗口的目标不是你时，开头加一行〔工作区/槽位〕标明是你发的。--file 要紧跟在 me 后面，可以给几个：" +
      ".png .jpg .jpeg .gif .webp 按图片发，其他按文件发，每个一条消息，跟在文字后面；超过平台的大小上限就报错，什么都不发。" +
      "在一个回合里用它发到了这个回合的窗口，Rhodium 就不再代发这个回合的最终回复；之后用户又发来消息、并进这个回合，或者在 IM 里回答了你的提问的，照常代发。" +
      "给槽位发：它在跑回合就并进当前回合，空闲就开始新回合，未运行就唤醒它（同时运行的槽位已到上限时唤醒不了，调用报错）；它有提问在等用户回答时先排队，答完再投。要给它文件，在文字里写路径",
    who: "both",
  },
  {
    name: "read",
    usage: "<工作区/槽位>",
    summary: "看槽位的状态和最近的对话，例如核对子槽位做得对不对",
    who: "both",
    readOnly: true,
  },
  {
    name: "set",
    usage: "<工作区/槽位> <设置>=<值> ...",
    summary: (oneoff) =>
      "改按槽位的设置，立即生效。设置：" +
      Object.entries(SETTINGS)
        .map(([k, s]) => `${k}（${s.label}${"note" in s ? `：${s.note}` : ""}）`)
        .join("、") +
      "、lifetime（生命周期）。开关取 on/off，时长写成 30s、10m、1h、7d，0 或 off 表示从不；default 回到全局默认。" +
      `lifetime 取 longterm（长期，一直保留）或 oneoff（一次性：${oneoff}）`,
    who: "you",
  },
  {
    name: "doctor",
    usage: "",
    summary:
      "自检：Claude 升级后核对 Rhodium 和它的通信还对不对得上，再查 --bare、托管进程、磁盘、out.log、备份和 pi 的版本。" +
      "只报告错误和告警，不拒绝启动槽位。Rhodium 每天自己也跑一次",
    // deploy/upgrade.sh judges a new version by it, and the dev agent runs that (product §10).
    who: "both",
    readOnly: true,
  },
  {
    name: "trace",
    usage: "<消息 ID>",
    summary:
      "追查一条 IM 消息的去向：投给了哪个槽位、为什么、投递给 agent 和发送回复的结果，以及它引起的事件。" +
      "消息 ID 写平台的消息 ID 或 Rhodium 的追踪 ID 都行",
    who: "you",
  },
  // A slot name no other slot has may stand alone: /rh_use shop on a phone (product §5.2).
  {
    name: "use",
    usage: "<Bot>/<窗口 ID> <工作区/槽位> | <Bot>/<窗口 ID> -",
    summary:
      "让聊天窗口的消息交给这个槽位处理，同一 Bot 的其他窗口不受影响；槽位名不重名时可以只写槽位名。写 - 回到 Bot 的默认目标。" +
      "agent 调用时，改的是用户正在和它说话的窗口（它的联系窗口，也就是 rh send me 发到的那个），或者是主 Bot 的窗口，要用户确认；别的直接执行",
    who: "both",
    confirm: "some",
  },
  {
    name: "bind",
    usage: "<Bot> <工作区/槽位>",
    summary:
      "改 Bot 的默认目标：单独指过目标的聊天窗口不变，其余窗口的消息都交给这个槽位。" +
      "agent 调用时，改的是主 Bot，或者它的联系窗口没有单独指过目标、跟着这个默认走，要用户确认；别的直接执行",
    who: "both",
    confirm: "some",
  },
  {
    name: "bot",
    usage: `<名字> ${Object.keys(MADE).join("|")} [<工作区/槽位>] [--paste] [--api-root <地址>]`,
    summary:
      "建 Bot，写进配置文件，绑定到这个槽位（不写就用主 Bot 的默认目标），当场生效，不重启 rhodium。" +
      (Object.keys(MADE) as Made[]).map((p) => `${amid(PLATFORMS[p].label).trimStart()}${MADE[p].how}。`).join("") +
      "之后照提示配对。" +
      `--api-root 指向${series(Object.values(MADE).flatMap((b) => b.apiRoot ?? []), "或")}，只用于测试`,
    who: "you",
    options: { "api-root": { type: "string" }, paste: { type: "boolean" } },
  },
  {
    name: "pair",
    usage: "<Bot> [--add | --rm <账号> | --list]",
    summary:
      "给出一个一次性的配对码，限时有效。用你自己的账号在 IM 里私聊这个 Bot，发这个码：发码的账号就是你，从此只有它能触发 agent。" +
      "Bot 已经配对过的，原来配对的主人都换成新发码的账号；配置里写了 owner 的，以配置为准，不能这样配对。不带参数的这种只有用户本人能用。" +
      "--add 把发码的账号再加为一个主人，原来的不变，例如你的 QQ 小号；不是用户本人从终端调用的，码由 Rhodium 发到用户的 IM，不写在输出里。" +
      "--rm 去掉一个配对来的主人，agent 调用要用户确认；--list 列出主人，和每个主人的私聊现在交给哪个槽位。主人只能是你本人的账号",
    who: "both",
    confirm: "some",
    options: { add: { type: "boolean" }, rm: { type: "string" }, list: { type: "boolean" } },
    readOnly: "list",
  },
  {
    name: "forget",
    usage: "<Bot>/<窗口 ID>",
    summary:
      "忘掉一个聊天窗口：Rhodium 删掉它自己选的槽位、设置和收发记录，平台上的聊天不受影响；那个账号再发消息，像新窗口一样重新记下。" +
      "忘掉不等于去掉主人，要它不再触发 agent，先 rh pair --rm。私聊的窗口 ID 就是对方的账号，和 rh pair --list 列的一样。" +
      "主窗口、有回合从那里开始还在跑、有提问推到那里还没答、有从那里发来的消息还在排队的，都不忘。" +
      "agent 调用要用户确认，要忘的是它自己的联系窗口时直接拒绝",
    who: "both",
    confirm: "some",
  },
];

/** A command typed in IM (product §5.6): Rhodium's own /rh_x, or one of the ten common ones.
 *  summary: what it does in 12 characters at most, for the / menu and the board's palette (docs/im-style.md §10.1).
 *  agents: the only agents it works on; left out, every agent. list: the candidates its panel offers
 *  when it comes with no argument (docs/im-style.md §9.1). hint: how to write its arguments, said
 *  after "/rh_x " to arguments it does not take, with slot as the example's (imUsage()). */
export type ImCommandDef = {
  name: string;
  usage?: string;
  summary: string;
  agents?: AgentKind[];
  list?: (l: Lists) => Candidate[];
  hint?: (slot: string) => string;
};

/** A slot as the lists see it. urgency: where rh_ls puts it in its workspace, lower first. */
export type SlotEntry = { id: string; ref: string; workspace: string; name: string; urgency: number };

/** What the candidates are made of; the router fills in what the command needs, the board may one day.
 *  slots: those not archived. here: the slot this chat goes to; byDefault: its bot's default target,
 *  both as refs; own: the chat picked its own (rh use). agent: that of the slot this chat goes to.
 *  choices: the agent's list (models, levels, conversations). importable: what rh import found. */
export type Lists = {
  slots?: SlotEntry[];
  here?: string;
  byDefault?: string;
  own?: boolean;
  agent?: AgentKind;
  choices?: Choice[];
  importable?: Importable[];
  now?: number;
};

/** Telegram's limit on a button's data (callback_data). */
const DATA_MAX = 64;
/** cmd on the slot: by its name, or by its row id should the name take the data past DATA_MAX. */
const onSlot = (cmd: string, s: SlotEntry) => (Buffer.byteLength(`${cmd} ${s.ref}`) <= DATA_MAX ? `${cmd} ${s.ref}` : `${cmd} ${s.id}`);
/** cmd on a choice: by its id, or by its number in the list should the id take the data past DATA_MAX. */
const onChoice = (cmd: string, c: Choice, i: number) => (Buffer.byteLength(`${cmd} ${c.id}`) <= DATA_MAX ? `${cmd} ${c.id}` : `${cmd} ${i + 1}`);
const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** The slots, those of first's workspace first, then the other workspaces by name; in a workspace,
 *  by name, or by urgency first. */
export function sortSlots(slots: SlotEntry[], first?: string, urgent = false): SlotEntry[] {
  const lead = slots.find((s) => s.ref === first)?.workspace;
  return [...slots].sort(
    (a, b) =>
      Number(b.workspace === lead) - Number(a.workspace === lead) ||
      byName(a.workspace, b.workspace) ||
      (urgent ? a.urgency - b.urgency : 0) ||
      byName(a.name, b.name),
  );
}

/** A directory as you read it, under ~ when it is in your home. */
export const tilde = (dir: string) => (dir === homedir() || dir.startsWith(`${homedir()}/`) ? `~${dir.slice(homedir().length)}` : dir);

/** /rh_use: the bot's default first, 回到默认 if this chat picked its own; then every other slot. */
function useList(l: Lists): Candidate[] {
  const first = l.byDefault
    ? [{ label: l.own ? `回到默认（${l.byDefault}）` : `默认（${l.byDefault}）`, command: "/rh_use -", current: !l.own }]
    : [];
  const rest = sortSlots(l.slots ?? [], l.here).filter((s) => s.ref !== l.byDefault);
  return [...first, ...rest.map((s) => ({ label: s.ref, command: onSlot("/rh_use", s), current: l.own && s.ref === l.here }))];
}

/** Every IM command. The agent's, those not rh_, are in the order the / menu lists them (product §5.7). */
export const IM_COMMANDS: ImCommandDef[] = [
  { name: "stop", summary: "停下这一回合" },
  { name: "new", summary: "开一段新对话" },
  { name: "status", summary: "看状态" },
  { name: "rh_use", usage: "<工作区/槽位> | -", summary: "这里交给哪个槽位", list: useList, hint: (s) => `后面写槽位，例如 /rh_use ${s}；写 - 回到默认` },
  {
    name: "resume",
    usage: "[<对话>]",
    summary: "回到以前的对话",
    list: (l) => (l.choices ?? []).map((c, i) => ({ label: c.label, command: onChoice("/resume", c, i), current: c.current })),
  },
  {
    name: "model",
    usage: "[<模型>]",
    summary: "换模型",
    list: (l) => (l.choices ?? []).map((c, i) => ({ label: c.label, command: onChoice("/model", c, i), current: c.current, group: c.group })),
  },
  { name: "usage", summary: "看额度和当前对话的用量" },
  {
    name: "rh_ls",
    usage: "[<工作区/槽位>] [--all]",
    summary: "看所有槽位",
    list: (l) => sortSlots(l.slots ?? [], l.here, true).map((s) => ({ label: s.ref, command: onSlot("/rh_ls", s) })),
    hint: (s) => `后面只写一个槽位，例如 /rh_ls ${s}；不写就列出所有槽位，加 --all 连已归档的也列出`,
  },
  { name: "rh_tui", usage: "[!]", summary: "切到 TUI 接着聊", hint: (s) => `后面写槽位，例如 /rh_tui ${s}；不写就是这里的槽位，加 ! 先打断当前回合` },
  { name: "rh_help", summary: "Rhodium 的功能" },
  { name: "context", summary: "看上下文用了多少" },
  { name: "compact", summary: "压缩上下文" },
  {
    name: "effort",
    usage: "[<强度>]",
    summary: "改思考强度",
    list: (l) => (l.choices ?? []).map((c, i) => ({ label: c.label, command: onChoice("/effort", c, i), current: c.current })),
  },
  {
    name: "ultracode",
    usage: "[on|off]",
    summary: "开关 ultracode",
    agents: AGENT_KINDS.filter((a) => AGENTS[a].ultracode),
    list: (l) => (l.choices ?? []).map((c, i) => ({ label: c.label, command: onChoice("/ultracode", c, i), current: c.current })),
  },
  {
    name: "rh_agent",
    usage: `${KINDS} [!]`,
    summary: "换 agent",
    list: (l) => AGENT_KINDS.map((a) => ({ label: AGENTS[a].name, command: `/rh_agent ${a}`, current: a === l.agent })),
    hint: () => "后面写 agent，例如 /rh_agent pi；加 ! 先打断当前回合",
  },
  { name: "rh_release", summary: "从 TUI 切回无头", hint: (s) => `后面只写槽位，例如 /rh_release ${s}；不写就是这里的槽位` },
  {
    name: "rh_bind",
    usage: "<工作区/槽位>",
    summary: "改这个 Bot 的默认槽位",
    list: (l) => sortSlots(l.slots ?? [], l.byDefault).map((s) => ({ label: s.ref, command: onSlot("/rh_bind", s), current: s.ref === l.byDefault })),
    hint: (s) => `后面写槽位，例如 /rh_bind ${s}`,
  },
  {
    name: "rh_import",
    usage: "[<对话 ID 或它的开头> | <pane ID>] [--name <名字>] [--dir <目录>]",
    summary: "接管外面开的对话",
    // Herdr's panes first, as tui.ts lists them, each read as its conversation on disk is. Where the
    // list has more than one agent, what isn't the default's is marked, as in /resume's (§9.6).
    // Pressing one asks for the slot's name next.
    list: (l) => {
      const all = l.importable ?? [];
      const mixed = new Set(all.map((i) => i.agent)).size > 1;
      return all.map((i) => {
        const when = i.at === undefined ? "" : moment(i.at, l.now ?? Date.now());
        const mark = mixed && i.agent !== DEFAULT_AGENT ? `（${i.agent}）` : when && " ";
        return { label: `${i.pane ? "Herdr 里 " : ""}${tilde(i.dir)} ${when}${mark}${clip(i.said ?? "", 8, "…") || i.session.slice(0, 8)}`, command: `/rh_import ${i.pane ?? i.session} --name` };
      });
    },
    hint: () => "后面写对话 ID 或 pane ID，例如 /rh_import w1:p1 --name review；不写就列出可以导入的",
  },
  {
    name: "rh_archive",
    usage: "[<工作区/槽位>]",
    summary: "归档一个槽位",
    list: (l) => sortSlots(l.slots ?? [], l.here).map((s) => ({ label: s.ref, command: onSlot("/rh_archive", s) })),
    hint: (s) => `后面只写槽位，例如 /rh_archive ${s}；不写就列出槽位让你选`,
  },
  { name: "rh_verbose", usage: "[on|off]", summary: "工具行写详细还是简略", hint: () => "后面写 on 或 off，例如 /rh_verbose on；什么都不写就在两种之间切换" },
  {
    name: "rh_rename",
    usage: "[<工作区/槽位>] <新名字>",
    summary: "给槽位改名",
    hint: (s) => `后面写新名字，例如 /rh_rename new-name；改别的槽位，先写槽位，例如 /rh_rename ${s} new-name`,
  },
];

/** The IM command named so, rh_ls for one. */
export const imCommand = (name: string) => IM_COMMANDS.find((c) => c.name === name);

/** The agent's commands, as the / menu and the board's palette list them (product §5.7): no rh_ one,
 *  only those the agent takes; with no agent, only those every agent takes. */
export const agentCommands = (agent?: AgentKind | null) =>
  IM_COMMANDS.filter((c) => !c.name.startsWith("rh_") && (!c.agents || (!!agent && c.agents.includes(agent))));

/** The / menu (product §5.7): the agent's commands, then /rh_help. */
export const slashMenu = (agent?: AgentKind | null): MenuItem[] =>
  [...agentCommands(agent), imCommand("rh_help")!].map((c) => ({ command: `/${c.name}`, description: c.summary }));

const send = (label: string, command: string) => ({ label, command });
/** QQ's row (product §5.7, docs/im-style.md §11.6): five flat, then the folders 终端 and 更多. */
export const QQ_ROW: RowButton[] = [
  send("停止", "/stop"),
  send("槽位", "/rh_ls"),
  send("切换", "/rh_use"),
  send("换 agent", "/rh_agent"),
  send("帮助", "/rh_help"),
  { label: "终端", sub: [send("切到 TUI", "/rh_tui"), send("切回无头", "/rh_release")] },
  { label: "更多", sub: [send("改名", "/rh_rename"), send("归档", "/rh_archive"), send("导入", "/rh_import"), send("默认槽位", "/rh_bind"), send("工具行详略", "/rh_verbose")] },
];
/** QQ's row flat, should its folders show badly on a phone: 10 at most, so without the two /rh_help has. */
export const QQ_ROW_FLAT: RowButton[] = QQ_ROW.flatMap((b) => ("sub" in b ? b.sub : [b])).filter((b) => b.command !== "/rh_bind" && b.command !== "/rh_verbose");

/** Telegram's row (product §5.7, docs/im-style.md §11.6): a reply keyboard, each button the command it sends. */
export const TELEGRAM_ROW: RowButton[] = ["/rh_ls", "/rh_use", "/rh_tui", "/rh_help"].map((c) => send(c, c));

/** /rh_help's buttons (docs/im-style.md §10.1): a button for each of Rhodium's functions, by what
 *  the slot this chat goes to is in: TUI, 切回无头 for 切到 TUI; none here, neither. */
export const homeButtons = (mode?: "headless" | "tui"): Candidate[] => [
  { label: "槽位", command: "/rh_ls" },
  { label: "切换", command: "/rh_use" },
  ...(mode === "tui" ? [{ label: "切回无头", command: "/rh_release" }] : mode ? [{ label: "切到 TUI", command: "/rh_tui" }] : []),
  { label: "换 agent", command: "/rh_agent" },
  { label: "改名…", command: "/rh_rename", fill: "/rh_rename " },
  { label: "归档", command: "/rh_archive" },
  { label: "导入", command: "/rh_import" },
  { label: "默认槽位", command: "/rh_bind" },
  { label: "工具行详略", command: "/rh_verbose" },
];

/** What /rh_x says to arguments it does not take (docs/im-style.md §10.2): an example as you write it
 *  in chat, slot's, never rh's usage. */
export const imUsage = (name: string, slot: string) => `/${name} ${imCommand(name)!.hint!(slot)}。`;

const WHO_FOR_USER: Record<Who, string> = { you: "只有你", both: "你和 agent" };
const WHO_FOR_AGENT: Record<Who, string> = {
  you: "只有用户本人能用，agent 调用会被拒绝",
  both: "你可以用",
};

/** When a one-off slot is archived (product §6.1): ms, as the config sets it, or with no config to read,
 *  as rh prints its help on its own, the default. Whole hours in hours: 24 小时, not 1 天. */
function oneoff(ms?: number): string {
  const said = (t: number) => (t % 3_600_000 ? span(t) : `${t / 3_600_000} 小时`);
  return ms === undefined ? `最后一个回合结束一段时间后自动归档（默认 ${said(parseDuration(durations.oneoffArchive)!)}）` : `最后一个回合结束 ${said(ms)}后自动归档`;
}
const summary = (c: CommandDef, archive?: number) => (typeof c.summary === "string" ? c.summary : c.summary(oneoff(archive)));

/** rh --help, printed with no rhodium to ask. */
export function helpText(): string {
  const lines = COMMANDS.map((c) => `  rh ${c.name} ${c.usage}\n      ${summary(c)}。（${WHO_FOR_USER[c.who]}）`);
  return [
    "用法：rh <命令> [参数]",
    "",
    ...lines,
    "",
    SLOT_HINT,
    "rh --skill 打印给 agent 看的说明。",
    "rh dev --fake --config <配置文件> 起一个 rhodium，在终端里经假 IM 和它收发，不用真 Bot。",
    "",
  ].join("\n");
}

/** What agents read of rh: rh --skill, and in the system prompt with oneoffArchive from the config. */
export function skillText(oneoffArchive?: number): string {
  const asked =
    "rh 立刻返回“已请用户确认”，不用等；用户的决定之后作为一条消息发给你，超时没确认就不执行。用户同意时只看到“已回答：同意”，执行结果写在那条消息里，由你用 rh send me 告诉用户；用户在网页上同意的，写在你的回复里";
  const confirm = (c: CommandDef) =>
    c.confirm === "always"
      ? `。${asked}`
      : c.confirm === "some"
        ? `。要用户确认时，${asked}`
        : c.confirm
        ? `。对你自己的槽位和你的后代（你派生的子槽位，以及它们派生的）直接执行；对别的槽位要用户确认：${asked}`
        : "";
  const lines = COMMANDS.map((c) => `- \`rh ${c.name} ${c.usage}\`：${summary(c, oneoffArchive)}。${WHO_FOR_AGENT[c.who]}${confirm(c)}。`);
  return [
    "# rh：Rhodium 的命令行",
    "",
    "你运行在 Rhodium 托管的槽位里。用 `rh` 查看和管理槽位。一次调用做一件事，结果打在标准输出，出错时退出码不为 0、原因打在标准错误。",
    "",
    SLOT_HINT,
    "",
    "## 命令",
    "",
    ...lines,
    "",
  ].join("\n");
}
