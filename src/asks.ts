// Asks as you see them in IM (product §5.8, docs/im-style.md §4, §5): the text Rhodium sends, numbered where
// buttons do not fit, how your reply becomes the agent's answer and what you are told it was, and the
// careful answer a timeout gives. Pure functions.
import { homedir } from "node:os";
import type { AskAnswer } from "./contracts";
import { clip } from "./render";

/** confirm: Rhodium's own, for an rh command that needs your say-so (product §6.2); the rest are the agent's. */
export type AskKind = "question" | "plan" | "permission" | "confirm";
/** What the ask table's prompt column holds. A confirm request's tool is "rh", its input a ConfirmInput. */
export type AskPrompt = { tool: string; input: any };
/** argv and cwd: the rh call, run as yours once you agree. caller: the slot told of your decision,
 *  null for a caller rh could not recognize, or you. from: who asks, as you see it; "" for you.
 *  said: how a call naming a chat or an account shows, which takes the state to word (the router's
 *  confirm()): cmd, with them as …; want and then in the chat the request went to, web on the board. */
export type ConfirmInput = { argv: string[]; cwd: string; caller: string | null; from: string; said?: Said };
export type Said = { cmd: string; want: string; then?: string; web: { want: string; then?: string } };
/** Your answer: the agent's, or your decision on a confirm request, which no agent is handed as such. */
export type Answer = AskAnswer | { kind: "confirm"; approve: boolean; message?: string };

type Question = { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

const questions = (p: AskPrompt): Question[] => (Array.isArray(p.input?.questions) ? p.input.questions : []);

export const TIMEOUT = "用户暂时无法回答，请按你的最佳判断继续";
const PLAN_TIMEOUT = "用户暂时无法回答，没有批准这个计划。请用 rh send me 把计划摘要发给用户，然后停下来，等用户回复再继续。";

/** A path as you read it: your home as ~, and past 40 characters its middle as …, keeping its last two parts. */
export function shortPath(path: string): string {
  const home = homedir();
  const p = home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  const parts = p.split("/");
  return [...p].length <= 40 || parts.length <= 4 ? p : [...parts.slice(0, 2), "…", ...parts.slice(-2)].join("/");
}

/** Yours: a confirm request you made yourself, from IM (docs/im-style.md §5.2). */
const own = (kind: AskKind, p: AskPrompt) => kind === "confirm" && !(p.input as ConfirmInput).from;

/** An approval's tool call: what it would do, as in "要运行这条命令", and what to show of it. Codex's
 *  by its own tool names (architecture §6.4). */
function toolCall(p: AskPrompt): { what: string; body: string; short: string } {
  const i = p.input ?? {};
  const path = shortPath(String(i.file_path ?? i.path ?? i.notebook_path ?? ""));
  switch (p.tool.toLowerCase()) {
    case "bash":
    case "exec_command": {
      const cmd = String(i.command ?? "");
      return { what: "运行这条命令", body: cmd, short: `要运行：${clip(cmd.replace(/\s+/g, " "), 40, "…")}` };
    }
    case "edit":
    case "multiedit":
    case "notebookedit":
      return { what: `改 ${path}`, body: String(i.new_string ?? i.newText ?? i.new_source ?? ""), short: `要改 ${path}` };
    case "write":
      return { what: `写 ${path}`, body: String(i.content ?? ""), short: `要写 ${path}` };
    case "webfetch":
      return { what: "打开这个网页", body: String(i.url ?? ""), short: `要打开 ${String(i.url ?? "").replace(/^https:\/\//, "")}` };
    case "apply_patch": {
      // Each file's diff; for a new file, its content.
      const changes: { path: string; diff?: string }[] = Array.isArray(i.changes) ? i.changes : [];
      const one = changes.length === 1 ? changes[0]! : undefined;
      const what = one ? `改 ${shortPath(one.path)}` : `改 ${changes.length} 个文件`;
      return { what, body: one ? String(one.diff ?? "") : changes.map((c) => `${shortPath(c.path)}\n${(c.diff ?? "").replace(/\n$/, "")}`).join("\n"), short: `要${what}` };
    }
    case "request_permissions": {
      // Codex's more permissions, a line each: the network, and the paths to read or write.
      const fs = i.fileSystem ?? {};
      const entries = (fs.entries ?? []).filter((e: any) => e.access !== "deny").map((e: any) => [e.access, e.path?.path ?? e.path?.pattern ?? e.path?.value]);
      const paths: [string, string][] = [...(fs.read ?? []).map((p: string) => ["read", p]), ...(fs.write ?? []).map((p: string) => ["write", p]), ...entries];
      const lines = [...(i.network?.enabled ? ["联网"] : []), ...paths.map(([access, p]) => `${access === "write" ? "写" : "读"} ${shortPath(String(p))}`)];
      return { what: "多给它这些权限", body: lines.join("\n"), short: "要多给它权限" };
    }
  }
  // Up to three of its arguments, a line each: never its JSON.
  const args = Object.entries(i)
    .slice(0, 3)
    .map(([k, v]) => `${k}：${clip(typeof v === "string" ? v : JSON.stringify(v), 40, "…")}`);
  return { what: `用 ${p.tool}`, body: args.join("\n"), short: `要用 ${p.tool}` };
}

/** What an approval shows of the call: its first 15 lines and 1000 characters at most. */
function excerpt(body: string): string {
  const lines = body.replace(/\n+$/, "").split("\n");
  if (lines.length <= 15 && body.length <= 1000) return lines.join("\n");
  return `${clip(lines.slice(0, 15).join("\n"), 1000, "…")}\n（共 ${lines.length} 行）`;
}

/** What a confirm request's rh call does (docs/im-style.md §5.3): "停掉 w/b", what follows from it,
 *  and the button that does it when you asked for it yourself. */
function action(argv: string[]): { want: string; then?: string; yes: string } {
  const [cmd, ref] = argv;
  switch (cmd) {
    case "release":
      return { want: `把 ${ref} 切回无头`, then: "这会结束 TUI 里的 agent，对话留着接着用。", yes: "切回无头" };
    case "tui":
      return { want: `把 ${ref} 切到 TUI`, yes: "切到 TUI" };
    case "stop":
      if (argv.includes("--all")) return { want: "停掉所有槽位", then: "所有正在跑的回合都会中断，对话留着。", yes: "全部停掉" };
      return { want: `停掉 ${ref}`, then: "正在跑的回合会中断，对话留着。", yes: "停掉" };
    case "archive":
      return { want: `归档 ${ref}`, then: "对话留着，发消息就恢复。", yes: "归档" };
    case "rename":
      return { want: `把 ${ref} 改名为 ${argv[2]}`, yes: "改名" };
    case "agent":
      return { want: `把 ${ref} 换成 ${argv[2]}`, then: "会从一段新对话开始，旧对话发 /resume 能回去。", yes: `换成 ${argv[2]}` };
    case "send":
      return { want: `给 ${ref} 发消息：“${clip(argv.slice(2).join(" ").replace(/\s+/g, " "), 60, "…")}”`, yes: "发送" };
  }
  return { want: "执行一条 rh 命令", yes: "执行" };
}

/** The rh call as a confirm request shows it: no chat's id nor account in it (docs/im-style.md §5.3). */
const command = (c: ConfirmInput) => c.said?.cmd ?? `rh ${c.argv.join(" ")}`;

/** Yes and no: an approval's, a plan's, a confirm request's; one you made yourself does what it says, or is cancelled. */
function yesNo(kind: Exclude<AskKind, "question">, p: AskPrompt): [string, string] {
  if (kind === "permission") return ["允许", "拒绝"];
  if (kind === "plan") return ["批准", "不批准"];
  const c = p.input as ConfirmInput;
  return c.from ? ["同意", "拒绝"] : [action(c.argv).yes, "取消"];
}

/** The message that asks you. from: the slot it comes from, "" for the slot this chat goes to, which
 *  needs no name; a confirm request names its caller itself. buttons: it comes with askButtons'. */
export function askText(kind: AskKind, p: AskPrompt, from: string, buttons = false): string {
  const who = from ? `${from} ` : "";
  if (kind === "question") {
    const qs = questions(p);
    const numbered = (q: Question) => (q.options ?? []).map((o, j) => `${j + 1}. ${o.label}${o.description ? `：${o.description}` : ""}`).join("\n");
    const head = (q: Question) => q.question + (q.multiSelect ? "（可以多选，编号用空格隔开）" : "");
    const asks = from ? `${from} 问你：\n\n` : "";
    if (qs.length !== 1) {
      const blocks = qs.map((q, i) => [`问题 ${i + 1}：${head(q)}`, numbered(q)].filter(Boolean).join("\n"));
      return asks + [`有 ${qs.length} 个问题，每行答一个：`, ...blocks, "可以回编号，也可以直接写。"].join("\n\n");
    }
    const q = qs[0]!;
    // Options only on the buttons, unless they need saying more than their names do.
    const list = !buttons || q.options?.some((o) => o.description) ? numbered(q) : "";
    const hint = buttons ? (list ? "也可以回编号，或直接写你的回答。" : "也可以直接写你的回答。") : list ? "回编号，或直接写你的回答。" : "直接写你的回答。";
    return asks + [head(q), list, hint].filter(Boolean).join("\n\n");
  }
  const [yes, no] = yesNo(kind, p);
  const say = buttons ? "" : `回“${yes}”或“${no}”。`;
  if (kind === "plan") return [`${who}写好了计划，批准后才动手：`, String(p.input?.plan ?? ""), `${say}回别的话算不批准，并转告它。`].join("\n\n");
  if (kind === "permission") {
    const c = toolCall(p);
    return [`${who}要${c.what}，允许吗？`, excerpt(c.body), `${say}回别的话算拒绝，并转告它。`].filter(Boolean).join("\n\n");
  }
  const c = p.input as ConfirmInput;
  const a = c.said ?? action(c.argv);
  const then = a.then ? `\n${a.then}` : "";
  // Yours: what it does is on its button.
  if (!c.from) return `${a.want}吗？${then}` + (say && `\n\n${say}`);
  // A caller rh could not recognize hears nothing back.
  const told = c.caller === null ? "回别的话算拒绝。" : `回别的话算拒绝，并转告 ${c.from}。`;
  return `${c.caller === null ? "有个认不出的程序" : `${c.from} `}想${a.want}。${then}\n\n命令：${command(c)}\n${say}${told}`;
}

/** An ask as the board's card shows it (spec web-write "提问"): a question's questions, each with its
 *  options and whether it takes several; else what is asked, what it is about (an approval's excerpt,
 *  the rh call; a plan in full, as Markdown), and its yes and no. told: words with a no reach whoever
 *  asks. No hint how to reply: the card's buttons and fields say it. */
export type AskCard =
  | { questions: { question: string; options: { label: string; description?: string }[]; multi: boolean }[] }
  | { head: string; body: string; markdown?: true; yes: string; no: string; told: boolean };

export function askCard(kind: AskKind, p: AskPrompt): AskCard {
  if (kind === "question") return { questions: questions(p).map((q) => ({ question: q.question, options: q.options ?? [], multi: !!q.multiSelect })) };
  const [yes, no] = yesNo(kind, p);
  if (kind === "plan") return { head: "", body: String(p.input?.plan ?? ""), markdown: true, yes, no, told: true };
  if (kind === "permission") {
    const c = toolCall(p);
    return { head: `要${c.what}`, body: excerpt(c.body), yes, no, told: true };
  }
  const c = p.input as ConfirmInput;
  const a = c.said?.web ?? action(c.argv);
  const then = a.then ? `\n${a.then}` : "";
  if (!c.from) return { head: `${a.want}吗？${then}`, body: "", yes, no, told: false };
  return { head: `${c.caller === null ? "有个认不出的程序" : c.from} 想${a.want}。${then}`, body: command(c), yes, no, told: c.caller !== null };
}

/** A button's data that answers the ask (its id) with option n, as typing n would. Telegram keeps up to 64 bytes. */
export const askData = (ask: string, n: number) => `ask:${ask}:${n}`;

/** The buttons that answer the ask where the platform has them: yes and no for a plan, an approval or
 *  a confirm request, one for each option of a question. None for several questions or a multiple
 *  choice: those take words. */
export function askButtons(kind: AskKind, p: AskPrompt, ask: string): { label: string; data: string }[] | undefined {
  if (kind !== "question") return yesNo(kind, p).map((label, i) => ({ label, data: askData(ask, i + 1), ...(i === 1 && own(kind, p) && { muted: true as const }) }));
  const qs = questions(p);
  if (qs.length !== 1 || qs[0]!.multiSelect || !qs[0]!.options?.length) return undefined;
  return qs[0]!.options.map((o, i) => ({ label: o.label, data: askData(ask, i + 1) }));
}

/** One line for a list of asks to pick from, as "要运行：make". */
export function askLine(kind: AskKind, p: AskPrompt): string {
  if (kind === "question") return clip(questions(p)[0]?.question ?? "", 60, "…");
  if (kind === "plan") return "写好了计划，等你批准";
  if (kind === "permission") return toolCall(p).short;
  const c = p.input as ConfirmInput;
  const want = (c.said ?? action(c.argv)).want;
  return c.from ? `想${want}` : `${want}？`;
}

/** One question's answer from your words: option numbers become their labels, else the words as they are. */
function pick(q: Question, text: string): string {
  const nums = text.split(/[\s,，、]+/).map(Number);
  const labels = (q.options ?? []).map((o) => o.label);
  const ok = /^\d+([\s,，、]+\d+)*$/.test(text) && nums.every((n) => n >= 1 && n <= labels.length) && (q.multiSelect || nums.length === 1);
  return ok ? nums.map((n) => labels[n - 1]).join(", ") : text;
}

/**
 * Your reply as the agent's answer: with what it said, as "允许" or "拒绝，并转告：“…”", and the receipt
 * telling you so; null if it can't be one (a question of several, answered on another number of lines).
 * A plan or approval takes 1 or its word for yes, 2 or its word for no, and anything else as no, with
 * your words passed on. A confirm request you made yourself has no receipt for yes: what it did is.
 */
export function parseAnswer(kind: AskKind, p: AskPrompt, reply: string): { answer: Answer; said: string; receipt: string } | null {
  const text = reply.trim();
  if (!text) return null;
  if (kind === "question") {
    const qs = questions(p);
    let parts = qs.length > 1 ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [text];
    // Several questions answered with one number each on a single line.
    if (parts.length === 1 && qs.length > 1 && /^\d+(\s+\d+)+$/.test(text)) parts = text.split(/\s+/);
    if (parts.length !== qs.length) return null;
    const answers = Object.fromEntries(qs.map((q, i) => [q.question, pick(q, parts[i]!)]));
    const said = Object.values(answers).join("；");
    // Words of your own are not echoed back: they may be long.
    const own = qs.length === 1 && pick(qs[0]!, text) === text && !qs[0]!.options?.some((o) => o.label === text);
    return { answer: { kind, answers }, said, receipt: own ? "已把这句当作回答交给它。" : `已回答：${said}。` };
  }
  const [yes, no] = yesNo(kind, p);
  const ok = text === "1" || text === yes;
  // "2 <why>" and "拒绝 <why>" are a no with a reason, as is anything that isn't a yes.
  const why = ok || text === "2" || text === no ? undefined : text.replace(new RegExp(`^(2|${no})[\\s:：,，]+`), "");
  // A caller rh could not recognize, or you, hear nothing back, so your words are passed on to no one.
  const c = kind === "confirm" ? (p.input as ConfirmInput) : undefined;
  const told = !c || c.caller !== null;
  const passed = why && told ? `，并转告：“${why}”` : "";
  const said = ok ? yes : `${no}${passed}`;
  const answer: Answer = kind === "permission" ? { kind, allow: ok, ...(why && { message: why }) } : { kind, approve: ok, ...(why && { message: why }) };
  let receipt: string;
  if (kind === "permission") receipt = ok ? `已允许${toolCall(p).what}。` : passed ? `已拒绝${passed}` : "已拒绝。";
  else if (kind === "plan") receipt = `已回答：${said}${passed ? "" : "。"}`;
  else if (!c!.from) receipt = ok ? "" : `已取消${c!.argv[1] && !c!.argv[1].startsWith("-") ? `，${c!.argv[1]} 没动` : ""}。`;
  else receipt = ok ? "已回答：同意。" : passed ? `已拒绝${passed}` : "已拒绝。";
  return { answer, said, receipt };
}

/** What a timeout answers for you (product §5.8). */
export function timeoutAnswer(kind: AskKind, p: AskPrompt): Answer {
  if (kind === "question") return { kind, answers: Object.fromEntries(questions(p).map((q) => [q.question, TIMEOUT])) };
  if (kind === "confirm") return { kind, approve: false };
  return kind === "plan" ? { kind, approve: false, message: PLAN_TIMEOUT } : { kind, allow: false, message: TIMEOUT };
}
