// Commands typed in IM (product §5.6): which of the three kinds a /x is, and the one format the
// common commands' results take in IM, the same on every agent (architecture §6.1). Lists to pick
// from go as panels (src/panels.ts); the router shows them.
import { AGENTS } from "./agents";
import { tilde } from "./commands";
import type { AgentKind, Choice, CommandResult, ContextUse, QuotaWindow } from "./contracts";
import { moment, money, percent, span, tokens as k } from "./panels";
import { md, plain } from "./render";

/** The slot a command was about, as Rhodium knows it. line: /status's second line, how the slot is
 *  (docs/im-style.md §7.1); tool: the tool running in its turn, as its tool line says it. */
export type SlotInfo = { ref: string; dir: string; agent: string; state: string; line: string; tool?: string };

/** The choice arg names: its number in the list, its id, or, if only one id has it, the part
 *  after the last "/" (a model without its provider). */
export function pick(choices: Choice[], arg: string, what: string): Choice {
  const byNumber = /^\d+$/.test(arg) ? choices[Number(arg) - 1] : undefined;
  const hits = byNumber ? [byNumber] : choices.filter((c) => c.id === arg || c.id.endsWith(`/${arg}`));
  if (hits.length === 1) return hits[0]!;
  const all = choices.map((c) => c.id).join("、");
  throw new Error(hits.length ? `叫 ${arg} 的${what}不止一个，写全它：${hits.map((c) => c.id).join("、")}` : `没有${what} ${arg}。可选：${all}`);
}

/** A moment as you read it, say 2026/10/21 14:30:03. */
export const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

/** /status (docs/im-style.md §7.1): the slot by its name and how it is, then what it uses, where it
 *  works and how full its context is, and the quota windows nearly full; a line with nothing to say,
 *  and a section, are left out. */
export function statusText(r: Extract<CommandResult, { command: "status" }>, slot: SlotInfo, now: number): string {
  // Claude's default model is 默认（Opus 5.5）: no space after its bracket (§2.3). A level set with no
  // model is the default's.
  const name = r.model ?? (r.effort ? "默认" : null);
  const model = name && r.effort ? `${name}${name.endsWith("）") ? "" : " "}${r.effort}` : name;
  const settings = [md`Agent：${AGENTS[slot.agent as AgentKind]?.statusName ?? slot.agent}`, ...(model ? [md`模型：${model}`] : []), ...(r.ultracode ? ["已开启 ultracode"] : [])];
  const c = r.context && contextUse(r.context);
  const state = [md`目录：\`${tilde(slot.dir)}\``, ...(c ? [md`上下文：${c[0]} ${c[1]}`] : [])];
  const full = (r.limits ?? []).filter((l) => l.usedPercent >= 80);
  return [
    md`## ${slot.ref}\n${slot.line}${slot.tool ? `\n${slot.tool}` : ""}`,
    md`### 模型设置\n${settings.join("\n")}`,
    md`### 状态\n${state.join("\n")}`,
    ...(full.length ? [md`### 额度信息\n${full.map((l) => quotaLine(l, now)).join("\n")}`] : []),
  ].join("\n\n");
}
/** How full the context is (§2.4): the number to lead with, 19% or ~62k, and what follows it. */
const contextUse = (c: ContextUse): [string, string] =>
  c.maxTokens ? [percent(c.usedTokens, c.maxTokens), `(~${k(c.usedTokens)} / ${k(c.maxTokens)} Tokens)`] : [`~${k(c.usedTokens)}`, "Tokens"];

/** /context (docs/im-style.md §7.3): how much of the model's window is used, as a query reply. */
export function contextText(r: Extract<CommandResult, { command: "context" }>): string {
  const [n, rest] = contextUse(r);
  return r.maxTokens ? md`已使用 **${n}** 上下文 ${rest}` : md`已使用 **${n}** ${rest} 上下文`;
}

/** A quota window's name, short (§2.4): 5h, 7d, 7d Fable. */
export const windowName = (l: QuotaWindow): string => (l.model ? `${l.window} ${l.model}` : l.window);

/** When a quota window resets, short (§2.4): 1h 46m 后重置 within a day, else 10/27 06:00 重置; 已重置 once past. */
export function resetText(at: number, now: number): string {
  if (at <= now) return "已重置";
  if (at - now >= 86_400_000) return `${moment(at, now)} 重置`;
  const m = Math.max(1, Math.round((at - now) / 60_000));
  return `${m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`} 后重置`;
}

/** A quota window's line (§7.2): how full, its name, when it resets where known. */
const quotaLine = (l: QuotaWindow, now: number): string => md`**${Math.round(l.usedPercent)}%** ${windowName(l)}${l.resetsAt === null ? "" : `，${resetText(l.resetsAt, now)}`}`;

/** /usage (docs/im-style.md §7.2): the quota windows, then this conversation's cost and tokens, as a
 *  query reply; a section with nothing in it is left out, and so is a cost the agent gives none of (Codex). */
export function usageText(r: Extract<CommandResult, { command: "usage" }>, agent: AgentKind, now: number): string {
  const quota = r.limits.map((l) => quotaLine(l, now));
  const x = r.extra;
  if (x) quota.push(md`**${Math.round(x.usedPercent)}%** 额外用量，本月 ${money(x.used, x.currency)}${x.limit === null ? "" : ` / ${money(x.limit, x.currency)}`}`);
  // Two places, no commas, as an amount is (§2.4).
  if (r.credits !== undefined) quota.push(md`**${r.credits.toFixed(2)}** credits 余额`);
  const s = r.session;
  // Claude's cost is what the tokens would cost at API prices, not what you pay (story 396).
  const cost = s?.cost === undefined ? [] : [md`**${money(s.cost)}**${AGENTS[agent].apiPrice ? " 等效 API 价格" : ""}`];
  const sections = [
    ...(quota.length ? [md`## ${AGENTS[agent].name} 额度\n${quota.join("\n")}`] : []),
    ...(s ? [md`## 当前对话\n${[...cost, md`**${k(s.tokens.total)}** 总 Tokens 消耗`].join("\n")}`] : []),
  ];
  return sections.join("\n\n") || `${AGENTS[agent].name} 没有用量可查。`;
}

/** How long till a moment less than a day ahead, to follow what happens then: "（还有 2 小时 10 分）". */
export const left = (at: number, now: number): string => (at > now && at - now < 86_400_000 ? `（还有 ${span(at - now)}）` : "");

/** The reply to a common command that is no panel nor a pick from one: plain text, the same for every agent. */
export function formatCommand(r: CommandResult, slot: SlotInfo, now = Date.now()): string {
  switch (r.command) {
    case "new":
      return "已开一段新对话。";
    case "stop":
      return r.stopped ? "已停下这一回合，对话留着。" : "现在没有在跑的回合。";
    case "status":
      return plain(statusText(r, slot, now));
    case "model":
      return r.model === null ? "已切到默认模型。" : `已切到 ${r.label ?? r.model}。`;
    case "effort":
      return `思考强度改成 ${r.level}。`;
    case "ultracode":
      return r.unavailable ? "这个模型用不了 ultracode。" : `ultracode 改成${r.on ? "开" : "关"}。`;
    case "usage":
      return plain(usageText(r, slot.agent as AgentKind, now));
    case "context":
      return plain(contextText(r));
    case "compact":
      return r.beforeTokens === null || r.afterTokens === null
        ? "已压缩上下文。"
        : `已压缩上下文，从约 ${k(r.beforeTokens)} tokens 减到约 ${k(r.afterTokens)} tokens。`;
    case "resume":
      if (r.choices) return "这个槽位还没有用过的对话，这个目录里也没有。";
      return `已回到${r.name ?? "那段"}对话。`;
  }
}
