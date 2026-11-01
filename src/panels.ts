// Panels (docs/im-style.md §9, §11): a command's candidates as a message to pick from. A command
// lists them (src/commands.ts); paging, numbers, the mark on the one now and how buttons sit in rows
// are done here, the same on every platform but for that mark. Pure.
import type { Button } from "./contracts";

/** One thing to pick: what you see, the command pressing it runs as if typed, and whether it is the one now.
 *  fill: where the platform can, pressing it writes this where you type instead, sending nothing (Button's).
 *  group: Choice's, for the board alone. */
export type Candidate = { label: string; command: string; current?: boolean; fill?: string; group?: string };

/** A panel. head: the lines over the buttons, the question first; a paged panel adds its page line.
 *  text: instead of head, for a panel whose text is a list of its own (rh_ls). command: what shows
 *  it, for its page buttons. short: options of one group, up to four a row (levels, yes and no);
 *  else names, two a row. back: [返回]'s command, on a platform that edits the message in place.
 *  cancel: [取消]'s data, CANCEL unless a step before took effect (§9.1); gone: what the message
 *  reads once the panel is left, on a platform that edits, if not its text with 已取消 under it.
 *  query: text is a query reply (docs/im-style.md §8), written with render.ts's md. */
export type Panel = {
  command: string;
  candidates: Candidate[];
  head?: string[];
  text?: (p: Paging) => string;
  query?: true;
  short?: true;
  back?: string;
  cancel?: string;
  gone?: string;
};

/** A panel's text as it reads once left (§9.1): its page line gone, with 也可以回编号, whether a line
 *  of its own or, as /rh_ls has it, the end of its last line (§8.2). */
export const unpaged = (text: string) => text.replace(/\n?第 \d+ 页，共 \d+ 页。也可以回编号。|，也可以回编号。第 \d+ 页，共 \d+ 页。/, (m) => (m.startsWith("，") ? "。" : ""));

/** page of pages; again: a later page on a platform that adds a message for it (QQ). */
export type Paging = { page: number; pages: number; again: boolean };

/** What a panel shows: its text and buttons, and, for a paged one, the command of each number
 *  across its pages, for a number you reply with (§11.4). */
export type Shown = { text: string; buttons: Button[]; numbered: string[] | null };

/** [取消]'s data: every panel has it, last (§9.1). */
export const CANCEL = "cancel";

/** The most choices a page holds, in at most 4 rows (§11.2). */
export const PAGE = 8;
const ROWS = 4;
/** The widest a button may be, by how many share its row (§11.2). */
const WIDEST = [0, 36, 18, 9, 9];

// ponytail: counts every character from U+1100 up as two columns wide; good enough for CJK.
export const width = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x1100 ? 2 : 1), 0);

/** label cut to max columns, ending in … when cut. */
function fit(label: string, max: number): string {
  if (width(label) <= max) return label;
  let out = "";
  for (const ch of label) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Row numbers for labels in order, from row: names two a row, short ones up to four, each as wide
 *  as its row lets it be; a label too wide for a row with another takes a row of its own. */
function rowsOf(labels: string[], short: boolean, row = 0): number[] {
  const most = short ? 4 : 2;
  let n = 0;
  let widest = 0;
  return labels.map((label, i) => {
    const w = width(label);
    if (i > 0 && n < most && Math.max(widest, w) <= WIDEST[n + 1]!) {
      n++;
      widest = Math.max(widest, w);
      return row;
    }
    if (i > 0) row++;
    n = 1;
    widest = w;
    return row;
  });
}

/** Buttons laid out as rowsOf does, starting at row; for asks' buttons too. */
export function layout(buttons: Button[], short = false, row = 0): Button[] {
  const rows = rowsOf(buttons.map((b) => b.label), short, row);
  return buttons.map((b, i) => ({ ...b, label: fit(b.label, 36), row: rows[i]! }));
}

/** Buttons in their rows, as a platform's keyboard takes them. */
export function buttonRows(buttons: Button[]): Button[][] {
  const rows: Button[][] = [];
  buttons.forEach((b, i) => {
    if (i > 0 && b.row !== undefined && b.row === buttons[i - 1]!.row) rows.at(-1)!.push(b);
    else rows.push([b]);
  });
  return rows;
}

/** Splits labels into pages of at most PAGE, in at most ROWS rows each. */
function paginate(labels: string[], short: boolean): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  for (const label of labels) {
    const next = [...page, label];
    if (page.length && (next.length > PAGE || new Set(rowsOf(next, short)).size > ROWS)) {
      pages.push(page);
      page = [label];
    } else page = next;
  }
  return [...pages, page];
}

/** The panel at page (from 1; past the last, the last). edits: the platform edits the message in
 *  place, so a step has [返回]; it gets no page of its own message (again) either. mark: what the
 *  one now starts with, ★ where ✓ shows a button pressed (QQ, §2.1). */
export function showPanel(panel: Panel, page: number, o: { edits: boolean; mark?: "✓" | "★" }): Shown {
  const marked = (c: Candidate, label: string) => (c.current ? `${o.mark ?? "✓"} ${label}` : label);
  const short = Boolean(panel.short);
  const plain = panel.candidates.map((c) => marked(c, c.label));
  let pages = paginate(plain, short);
  const numbered = pages.length > 1;
  if (numbered) pages = paginate(panel.candidates.map((c, i) => marked(c, `${i + 1}. ${c.label}`)), short);
  const at = Math.min(Math.max(1, page), pages.length);
  const first = pages.slice(0, at - 1).reduce((n, p) => n + p.length, 0);
  const choices = pages[at - 1]!.map((label, i) => {
    const c = panel.candidates[first + i]!;
    return { label, data: c.command, ...(c.fill !== undefined && { fill: c.fill }) };
  });
  const buttons = layout(choices, short);
  const row = (buttons.at(-1)?.row ?? -1) + 1;
  // One row, so a page of 4 rows still fits QQ's 5.
  const nav: Button[] = [];
  if (at > 1) nav.push({ label: "上一页", data: `page:${at - 1}:${panel.command}`, row, muted: true });
  if (at < pages.length) nav.push({ label: "下一页", data: `page:${at + 1}:${panel.command}`, row, muted: true });
  if (o.edits && panel.back) nav.push({ label: "返回", data: panel.back, row, muted: true });
  nav.push({ label: "取消", data: panel.cancel ?? CANCEL, row, muted: true });
  const paging = { page: at, pages: pages.length, again: at > 1 && !o.edits };
  const pageLine = numbered ? [`第 ${at} 页，共 ${pages.length} 页。也可以回编号。`] : [];
  const text = panel.text ? panel.text(paging) : [...(panel.head ?? []), ...pageLine].join("\n");
  return { text, buttons: [...buttons, ...nav], numbered: numbered ? panel.candidates.map((c) => c.command) : null };
}

/** A moment as you read it (§2.4): 14:30 today, 昨天 or 明天 14:30, 10/18 14:30 this year,
 *  2025/10/18 before. Local time, as now is. */
export function moment(at: number, now: number): string {
  const [t, n] = [new Date(at), new Date(now)];
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(t) - day(n)) / 86_400_000);
  return days === 0 ? hm
    : days === -1 ? `昨天 ${hm}`
    : days === 1 ? `明天 ${hm}`
    : t.getFullYear() === n.getFullYear() ? `${t.getMonth() + 1}/${t.getDate()} ${hm}`
    : `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
}

/** A token count as you read it (§2.4): 127, 7.9k, 186k, 18.9M, 1M. */
export function tokens(v: number): string {
  const one = (x: number) => String(Math.round(x * 10) / 10);
  if (v < 1000) return String(v);
  if (Math.round(v / 1000) >= 1000) return `${one(v / 1_000_000)}M`;
  return v < 10_000 ? `${one(v / 1000)}k` : `${Math.round(v / 1000)}k`;
}

/** An amount of money (§2.4): $15.35; under a cent, <$0.01. Another currency than USD goes by its code. */
export function money(v: number, currency = "USD"): string {
  const sign = currency === "USD" ? "$" : `${currency} `;
  return v > 0 && v < 0.01 ? `<${sign}0.01` : `${sign}${v.toFixed(2)}`;
}

/** How much of max used is (§2.4): 19%; under 1%, <1%. */
export const percent = (used: number, max: number): string => (used * 100 < max ? "<1%" : `${Math.round((used * 100) / max)}%`);

/** A length of time in its two largest units (§2.4): 45 秒, 3 分钟, 2 小时 10 分. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  const [m, h, d] = [Math.floor(s / 60), Math.floor(s / 3600), Math.floor(s / 86_400)];
  if (d) return `${d} 天${h % 24 ? ` ${h % 24} 小时` : ""}`;
  if (h) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ""}`;
  return m ? `${m} 分钟` : `${s} 秒`;
}
