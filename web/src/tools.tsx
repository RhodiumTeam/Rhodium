// The tool calls and thoughts in a slot's chat (spec web-chat, stories 196–199): those between two
// things said fold into one line, written as QQ's tool line is (im-style §3.1); the call still running
// is on its own at the end. Each call is drawn with its kind's icon (#206), as T3 Code and Orca do.
import { cjk } from "@streamdown/cjk";
import { cn } from "cn";
import { Bot, Brain, Check, ChevronRight, CircleX, Copy, FilePen, FileText, Globe, ListChecks, MessageCircleQuestionMark, Plug, Search, Terminal, TextWrap, Wrench, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type UIEvent } from "react";
import { defaultComponents, Streamdown, type ExtraProps, type StreamdownProps } from "streamdown";
import type { FullData } from "../../src/board";
import type { AgentKind } from "../../src/contracts";
import { span } from "../../src/panels";
import { named, NOT_TOOLS, shortParts, type ShortParts } from "../../src/tool-line";
import { Box } from "./common";
import { Button } from "./components/ui/button";
import { json, type Block } from "./data";
import { toast } from "./toast";
import { keep, kept } from "./write";

type Tool = Extract<Block, { kind: "tool" }>;
type Step = Tool | Extract<Block, { kind: "thinking" }>;
/** What the chat shows: what you and the agent said and system lines as they come, the calls and
 *  thoughts between them as a fold, and the calls still running. */
export type Shown =
  | Extract<Block, { kind: "user" | "assistant" | "system" }>
  | { kind: "fold"; at: string; line: ShortParts; kinds: Kind[]; steps: Step[] }
  | { kind: "running"; at: string; tool: Tool };

const THOUGHT = { name: "思考", arg: null, code: false };

// Quiet, as in IM: a table in one box with no buttons (#502), a code block only its own two
// (CodeBlock), no line numbers, links open with no warning. On a page that writes, what an agent wrote
// is never more than words (spec web-write): raw HTML shows as written, with no rehype-raw to make it
// elements, and a link goes only to http or https, any other its words alone. One object each, so the
// agent's messages are not drawn again for each piece of a draft (Streamdown's memo). min-w-0: in a
// grid or flex it is no wider than its column, so a long code line or a wide table scrolls in its own
// box, not the chat (#488).
export const MARKDOWN: Partial<StreamdownProps> = {
  plugins: { cjk },
  controls: false,
  components: {
    code: (p) => ("data-block" in p ? <CodeBlock {...p} /> : <defaultComponents.code {...p} />),
    table: Table,
    td: Cell,
  },
  lineNumbers: false,
  linkSafety: { enabled: false },
  className: "min-w-0 wrap-anywhere",
  rehypePlugins: [],
  allowElement: (e) => e.tagName !== "a" || /^https?:/i.test(String(e.properties.href ?? "")),
  unwrapDisallowed: true,
};

// Whether code blocks wrap long lines (#498): yes unless switched off on one, which every block on the
// page follows; kept on this device, where storage can be used.
const WRAP = "code-wrap";
let wraps = kept(() => localStorage, WRAP) !== "off";
const wrapping = new Set<() => void>();
const useWraps = () => useSyncExternalStore((f) => (wrapping.add(f), () => void wrapping.delete(f)), () => wraps, () => wraps);
const wrap = (on: boolean) => ((wraps = on), keep(() => localStorage, WRAP, on ? null : "off"), wrapping.forEach((f) => f()));

const KEY = "hover-round -my-2 grid size-11 [--round-inset:--spacing(2.5)] shrink-0 place-items-center hover:text-foreground";
// Tailwind's preflight's tab-size, which a code block keeps.
const TAB = 4;
/** Writes how far a scroller can still go left and right, for its edge-fade (index.css). */
const edges = (el: HTMLElement) => {
  el.style.setProperty("--os", `${el.scrollLeft}px`);
  el.style.setProperty("--oe", `${el.scrollWidth - el.clientWidth - el.scrollLeft}px`);
};
/** A scroller's ref and onScroll that keep its edge-fade up to date: on a scroll, and as the scroller or
 *  what it holds changes size, a line or a row still being written included. */
function useEdges<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current!;
    const sized = new ResizeObserver(() => edges(el));
    sized.observe(el);
    sized.observe(el.firstElementChild!);
    return () => sized.disconnect();
  }, []);
  return { ref, onScroll: (e: UIEvent<T>) => edges(e.currentTarget) };
}
/** A table in one box, as a code block's (#502): Streamdown's put a second around it. No height limit
 *  either. Wide, it scrolls inside, its edges faded as an unwrapped code block's are. A cell's words
 *  keep whole, a link's too (Streamdown's wrap-anywhere on it), a long one widening the table (#559):
 *  the chat's wrap-anywhere let it squeeze a column to one letter instead. --share: 3/4 of a column's
 *  share of the box, which Cell keeps for its words; the rest goes to the cells with the most words. */
function Table({ node, ...p }: ComponentProps<"table"> & ExtraProps) {
  const scroller = useEdges<HTMLDivElement>();
  const cols = (node as Hast | undefined)?.children?.find((c) => c.tagName === "thead")?.children?.find((c) => c.tagName === "tr")?.children?.filter((c) => c.tagName === "th").length || 1;
  // overflow-hidden: the header's ground keeps inside the round corners.
  return (
    <div className="my-4 overflow-hidden rounded-lg border bg-card">
      <div {...scroller} className="@container card-scroll edge-fade overflow-x-auto">
        <table {...p} style={{ "--share": `${75 / cols}cqw` } as CSSProperties} className="table-head w-full divide-y wrap-break-word [&_a]:wrap-break-word [&_td]:px-3 [&_th]:px-3" />
      </div>
    </div>
  );
}
type Hast = { tagName?: string; value?: string; children?: Hast[] };
const text = (n: Hast): string => n.value ?? n.children?.map(text).join("") ?? "";
/** A table cell no narrower than its words on one line, up to 12em of them and --share of the box
 *  (#559): else a long path widening the table left the other columns only their longest word or
 *  their header, two Chinese characters a line. Its words' width guessed, a Chinese character 1em, any
 *  other a bit over half; 1.5rem its padding. */
function Cell({ node, ...p }: ComponentProps<"td"> & ExtraProps) {
  const em = [...text((node as Hast | undefined) ?? {}).trim()].reduce((w, c) => w + (c >= "\u2e80" ? 1 : 0.55), 0);
  return <defaultComponents.td {...p} style={{ ...p.style, minWidth: `min(${Math.min(em, 12)}em + 1.5rem, var(--share))` }} />;
}
/** A fenced code block in one box (#498): over it, the fence's language, text if it has none (#507),
 *  and keys to wrap long lines and to copy the code as written. Plain text, as Streamdown's was with
 *  no highlighter. */
function CodeBlock({ className, children }: ComponentProps<"code"> & ExtraProps) {
  const on = useWraps();
  const [copied, setCopied] = useState(false);
  // Unwrapped, the edges fade as T3 Code's do (#507).
  const scroller = useEdges<HTMLPreElement>();
  // The fence's text ends in the newline before its closing fence, which is not the code's.
  const code = String(children ?? "").replace(/\n$/, "");
  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 2000)),
      () => toast("没能复制。", true),
    );
  return (
    <div className="my-4 rounded-lg border bg-card">
      <div className="flex h-7 items-center pl-3 text-xs text-muted-foreground">
        <span className="font-mono">{/language-(\S+)/.exec(className ?? "")?.[1] ?? "text"}</span>
        <button aria-label="自动换行" aria-pressed={on} onClick={() => wrap(!on)} className={cn(KEY, "ml-auto aria-pressed:text-foreground")}>
          <TextWrap className="size-3.5" />
        </button>
        <button aria-label="复制" onClick={copy} className={KEY}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre {...scroller} className={cn("card-scroll overflow-x-auto pb-2.5 font-mono text-sm", on ? "@container whitespace-pre-wrap wrap-anywhere" : "edge-fade whitespace-pre")}>
        {/* The padding on the code, not the scroller: scrolled to its end, a long line keeps it. */}
        <code className={cn("block px-3", !on && "w-max min-w-full")}>{on ? code.split("\n").map(hanging) : code}</code>
      </pre>
    </div>
  );
}

/** A code line wrapped as Expressive Code's preserveIndent does (#507): what it wraps onto starts under
 *  its indent, not at the line's start, but never past a third of the box, so a deep one on a phone
 *  still has room. The indent itself is drawn as deep as written, cut only at the box's edge, in a box
 *  of its own so its tabs reach the same stops as unwrapped; a tab further on, after an indent deeper
 *  than a third or no multiple of TAB, lands off its stop. */
function hanging(line: string, i: number, lines: string[]) {
  const end = i < lines.length - 1 ? "\n" : "";
  const lead = /^[ \t]*/.exec(line)![0];
  if (!lead) return line + end;
  const columns = [...lead].reduce((n, c) => (c === "\t" ? n + TAB - (n % TAB) : n + 1), 0);
  return (
    <span key={i} style={{ "--indent": `min(${columns}ch, 33cqi)` } as CSSProperties} className="block ps-(--indent) -indent-(--indent)">
      <span className="inline-block max-w-[calc(100%+var(--indent))] overflow-hidden indent-0 whitespace-pre align-top">{lead}</span>
      {line.slice(lead.length) + end}
    </span>
  );
}

const QUIET = "text-muted-foreground";
/** What a call does, or a thought: its icon, and its colours (index.css's --tool-*). Only the kinds
 *  worth telling apart at a glance have a colour of their own, reading, searching and the web
 *  sharing one, as all three look; the rest are quiet, so the chat is not a rainbow. */
const KINDS = {
  read: [FileText, "text-tool-look"],
  search: [Search, "text-tool-look"],
  web: [Globe, "text-tool-look"],
  edit: [FilePen, "text-tool-edit"],
  command: [Terminal, "text-tool-command"],
  agent: [Bot, "text-tool-agent"],
  todo: [ListChecks, QUIET],
  ask: [MessageCircleQuestionMark, QUIET],
  mcp: [Plug, QUIET],
  other: [Wrench, QUIET],
  thinking: [Brain, QUIET],
} satisfies Record<string, [LucideIcon, string]>;
export type Kind = keyof typeof KINDS;

// Each agent's tool names, lower-cased, as its transcript has them. pi's read, edit, write, bash and
// grep are Claude's names too; an agent whose transcript format maps its tools to Claude's has none.
const NAMES: Record<AgentKind, Record<string, Kind>> = {
  claude: {
    ...{ read: "read", notebookread: "read" },
    ...{ edit: "edit", multiedit: "edit", write: "edit", notebookedit: "edit" },
    ...{ bash: "command", bashoutput: "command", killshell: "command", killbash: "command", taskoutput: "command", taskstop: "command", monitor: "command" },
    ...{ grep: "search", glob: "search" },
    ...{ webfetch: "web", websearch: "web", agent: "agent", task: "agent", workflow: "agent", sendmessage: "agent", todowrite: "todo", askuserquestion: "ask", exitplanmode: "ask" },
  },
  pi: { find: "search", ls: "search" },
  // Codex's, as architecture §6.4 names its items (spec codex.md's icon table).
  codex: {
    ...{ exec_command: "command", apply_patch: "edit", web_search: "web", view_image: "read", update_plan: "todo" },
    ...{ spawn_agent: "agent", send_input: "agent", resume_agent: "agent", wait: "agent", close_agent: "agent", send_message: "agent", followup_task: "agent", interrupt_agent: "agent", list_agents: "agent" },
  },
};
const BY_NAME = new Map<string, Kind>(Object.values(NAMES).flatMap((n) => Object.entries(n)));

/** A tool call's kind, by its name as the transcript has it, Claude's or pi's; an MCP server's tools are mcp. */
export const kindOf = (name: string): Kind => (name.startsWith("mcp__") ? "mcp" : (BY_NAME.get(name.toLowerCase()) ?? "other"));

const kindOfStep = (s: Step): Kind => (s.kind === "thinking" ? "thinking" : kindOf(s.name));

/** The blocks as the chat shows them. Running: the calls with no result after the last block that is not one. */
export function folded(blocks: Block[]): Shown[] {
  // A result whose call was on another page goes with it by id; one whose call is not here yet shows with it once it is.
  const results = new Map(blocks.flatMap((b) => (b.kind === "result" ? [[b.id, b] as const] : [])));
  const all = blocks.flatMap((b): Exclude<Block, { kind: "result" }>[] => {
    if (b.kind === "result") return [];
    const r = b.kind === "tool" && !b.result && results.get(b.id);
    if (!r) return [b];
    const { kind, id, ...result } = r;
    return [{ ...(b as Tool), result }];
  });
  let end = all.length;
  while (all[end - 1]?.kind === "tool") end--;
  const running = all.slice(end).filter((b): b is Tool => b.kind === "tool" && !b.result);

  const shown: Shown[] = [];
  for (const b of all) {
    if (b.kind !== "tool" && b.kind !== "thinking") shown.push(b);
    else if (!running.includes(b as Tool)) {
      const last = shown.at(-1);
      if (last?.kind === "fold") last.steps.push(b);
      else shown.push({ kind: "fold", at: b.at, line: shortParts([]), kinds: [], steps: [b] });
    }
  }
  for (const f of shown) {
    if (f.kind !== "fold") continue;
    // Its line and icons name the calls that are tool work; with none, what there is.
    const work = f.steps.filter((s) => s.kind === "tool" && !NOT_TOOLS.has(s.shown.name));
    const listed = work.length ? work : f.steps;
    f.line = shortParts(listed.map((s) => (s.kind === "tool" ? { ...s.shown, failed: failed(s) } : THOUGHT)));
    f.kinds = [...new Set(listed.map(kindOfStep))];
  }
  return [...shown, ...running.map((tool) => ({ kind: "running" as const, at: tool.at, tool }))];
}

/** A kind's icon on a tint of its colour; red, for a call that failed. */
function Icon({ kind, failed, className }: { kind: Kind; failed?: boolean; className?: string }) {
  const [Glyph, tone] = KINDS[kind];
  return (
    <span className={cn("tint flex size-5 shrink-0 items-center justify-center rounded-md", failed ? "text-destructive" : tone, className)}>
      <Glyph className="size-3.5" aria-hidden />
    </span>
  );
}

// A row that opens: no marker of the browser's own, a chevron that turns as its group opens.
const ROW = "flex min-h-8 lg:min-h-7 cursor-pointer list-none items-center gap-2 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden";
const CHEVRON = "size-3.5 shrink-0 opacity-50 transition-transform";
const failed = (s: Step) => s.kind === "tool" && !!s.result?.error;

/** A red ⓧ for calls that failed, as big as the chevron; n: how many, after it (#495). */
function Failed({ n }: { n?: number }) {
  const said = n === undefined ? "出错" : `出错 ${n} 次`;
  return (
    <span role="img" aria-label={said} title={said} className="shrink-0 text-xs text-destructive tabular-nums">
      <CircleX className="inline size-3.5 align-[-0.15em]" aria-hidden />
      {n !== undefined && <span className="ml-0.5">{n}</span>}
    </span>
  );
}

/** A run, or the calls after the runs, as the fold's line has them: what it is, and if one of its
 *  calls failed a red mark, with how many of more than one. The name may wrap anywhere, so one too
 *  long for a line wraps inside it and the chat never scrolls sideways (#501); only the name, so a line
 *  never starts with 、. Kept on a line: its ×N with the space before it, so a ×N that wraps starts its
 *  line; the mark with that, or else with the name's last short part (after a . _ or - or from a
 *  capital), so a name that fits a line but not with the mark breaks there, or else with its last
 *  letter. whole: all of it, failed or not, as 另外 N 次 is short. */
function part(text: string, n: number, bad: number, whole = false) {
  const times = text.search(/ ×\d+$/);
  const last = text.search(/(?<=[._-]|[a-z\d](?=[A-Z]))[^._-]{1,20}$/);
  const at = whole ? 0 : times >= 0 ? times : !bad ? text.length : last > 0 ? last : text.length - 1;
  return (
    <>
      {at > 0 && <span className="wrap-anywhere">{text.slice(0, at)}</span>}
      {at < text.length && (
        <span className="whitespace-nowrap">
          {text.slice(at)}
          {bad > 0 && <> <Failed n={n > 1 ? bad : undefined} /></>}
        </span>
      )}
    </>
  );
}

/** A fold: the icons of the kinds of call in it (three at most) and its line, each red where a call
 *  failed, open to a line a step, each open to its arguments and result, or the thought. */
export function Fold({ f, conversation }: { f: Extract<Shown, { kind: "fold" }>; conversation: string }) {
  const bad = new Set(f.steps.filter(failed).map(kindOfStep));
  return (
    <details className="group/fold text-sm text-muted-foreground">
      {/* Its icons and chevron at the top, by the first line of a line that wraps; with the padding, a row of one
          line is as high as before, its icons and line where they were. */}
      <summary className={cn(ROW, "items-start py-1.5 lg:py-1")}>
        <span className="flex shrink-0 -space-x-1">
          {f.kinds.slice(0, 3).map((k) => (
            <Icon key={k} kind={k} failed={bad.has(k)} className="ring-2 ring-background" />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          {f.line.runs.map((r, i) => (
            <Fragment key={i}>
              {i > 0 && "、"}
              {part(named(r), r.n, r.failed)}
            </Fragment>
          ))}
          {f.line.more.n > 0 && (
            <>
              ，{part(`另外 ${f.line.more.n} 次`, f.line.more.n, f.line.more.failed, true)}
            </>
          )}
        </span>
        <ChevronRight className={cn(CHEVRON, "mt-[3px] group-open/fold:rotate-90")} />
      </summary>
      <ul className="mt-0.5 ml-2.5 border-l pl-3">
        {f.steps.map((s) => (
            <li key={s.at}>
              <details className="group/step">
                <summary className={ROW}>
                  <Icon kind={kindOfStep(s)} failed={failed(s)} />
                  <span className="min-w-0 flex-1 truncate">
                    <Name s={s} strong />
                  </span>
                  {failed(s) && <Failed />}
                  <ChevronRight className={cn(CHEVRON, "group-open/step:rotate-90")} />
                </summary>
                <div className="mb-2 ml-7 grid grid-cols-1 gap-1.5">
                  {s.kind === "thinking" ? (
                    <Clipped {...s} conversation={conversation} thought />
                  ) : (
                    <>
                      <Clipped text={s.input} length={s.length} at={s.at} conversation={conversation} />
                      {s.result ? <Clipped {...s.result} conversation={conversation} /> : <span>没有结果。</span>}
                    </>
                  )}
                </div>
              </details>
            </li>
        ))}
      </ul>
    </details>
  );
}

/** A step as its line in a fold: a call's name and argument, strong: its name darker; or 思考 and how
 *  the thought begins. */
function Name({ s, strong }: { s: Step; strong?: boolean }) {
  if (s.kind === "thinking")
    return (
      <>
        思考<span className="ml-1.5">{s.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ")}</span>
      </>
    );
  return (
    <>
      <span className={cn(strong && "text-foreground/80")}>{s.shown.name}</span>
      {s.shown.arg && <span className={s.shown.code ? "ml-1.5 font-mono text-xs" : "ml-1.5"}>{s.shown.arg}</span>}
    </>
  );
}

/** Text a page may give only the start of (length: the whole's), with 看全文 to bring the whole: as
 *  written, red if it is an error; a thought, as prose. */
function Clipped({ text, length, at, conversation, error, thought }: { text: string; length?: number; at: string; conversation: string; error?: boolean; thought?: boolean }) {
  const [whole, setWhole] = useState<string>();
  const [failed, setFailed] = useState(false);
  const more = () =>
    json<FullData>(`api/full?conversation=${encodeURIComponent(conversation)}&at=${at}`).then(
      (d) => (setWhole(d.text), setFailed(false)),
      () => setFailed(true),
    );
  return (
    <>
      {thought ? (
        <Streamdown mode="static" {...MARKDOWN}>
          {whole ?? text}
        </Streamdown>
      ) : (
        <Box className={error ? "text-destructive" : "text-foreground/80"}>{whole ?? text}</Box>
      )}
      {length && whole === undefined && (
        <Button variant="link" size="sm" className="h-auto justify-self-start p-0" onClick={more}>
          看全文（共 {length} 字）
        </Button>
      )}
      {failed && <span className="text-destructive">取不到全文。</span>}
    </>
  );
}

/** A call still running, a light sweeping across it, with how long since it was made, each second. */
export function Running({ tool }: { tool: Tool }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <div className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground">
      <Icon kind={kindOf(tool.name)} />
      <span className="live-shine min-w-0 truncate">
        正在跑 <Name s={tool} />
      </span>
      {tool.time !== null && <span className="ml-auto shrink-0 text-xs tabular-nums">{span(Math.max(0, now - tool.time))}</span>}
    </div>
  );
}
