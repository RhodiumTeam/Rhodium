// The info card (spec info-commands "网页"): a query's answer, or what to pick from, over where you type
// and in the chat's column alone, the transcript under it as it is. Only the chat's code has this.
import { cn } from "cn";
import { Box, ChartPie, ChevronDown, ChevronRight, Copy, FoldVertical, Gauge, Info, LoaderCircle, MessageSquare, RotateCcw, Square, SquarePen, X, type LucideIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AGENTS } from "../../src/agents";
import type { AgentKind, ContextUse, ExtraUsage, QuotaWindow, SessionUse, Tokens } from "../../src/contracts";
import { moment, money, percent, span, tokens } from "../../src/panels";
import type { InfoCard as Card, StatusCard } from "../../src/router";
import { AgentLogo, ModelName, ROOM } from "./common";
import { toast } from "./toast";
import { buttonVariants } from "./components/ui/button";

/** A bar's colour by how full it is (story 394): amber from 80%, red from 95%. */
export const tone = (p: number): "" | "warn" | "bad" => (p >= 95 ? "bad" : p >= 80 ? "warn" : "");
const TONE = { "": "bg-foreground", warn: "bg-needs", bad: "bg-destructive", grey: "bg-muted-foreground/45" };
const TONE_TEXT = { "": "", warn: "text-needs", bad: "text-destructive", grey: "text-muted-foreground" };
/** Whether the numbers drawn under it are as last heard, the agent not running, or the quota old (story 657): grey. */
export const Grey = createContext(false);
/** A bar's or number's tone, grey where Grey says so. */
const useTone = (p: number) => (useContext(Grey) ? "grey" : tone(p));

/** The card, by the bottom of the chat's column: a handle, its icon and title with ✕, then what is in it
 *  (stories 387-389, 391). Up to 70% of the screen high, never over the chat's top bar; the handle, the title and top stay on top and
 *  foot at the bottom, what is between scrolling, on a screen 480px high or more (story 520), and the
 *  whole card scrolling on a lower one. With a top, as a search box, it grows but never shrinks while
 *  open, so the top stays put as what is under it filters. Tapping the transcript, Esc or ✕ closes it, and so does its
 *  handle dragged down past a third of it, which a shorter drag springs back from (story 521); where you
 *  type keeps the keyboard. Every answer, sheet and picker the chat shows is one. Scrolling whole, it
 *  clips a phone's floating bar, drawn square over its round corners, to them, its shadow too (#646). */
export function CardFrame({ icon: Icon, logo, title, sub, close, top, foot, children }: { icon: LucideIcon; logo?: ReactNode; title: string; sub?: string; close: () => void; top?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    // Esc where you type is its own: it closes this too, first.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [close]);
  // The handle held: where it was taken, and how far down it is now.
  const [drag, setDrag] = useState<{ from: number; by: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  // How high it may be, --card: 70% of the screen, but never over the chat's top bar, which would hide
  // the handle, the title and top; so no more than the room between the bar and what the card stands
  // on, where you type with the queue over it, less the 0.5rem under the card (story 520).
  const room = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = room.current!;
    const under = el.offsetParent!;
    const column = under.parentElement!;
    const bar = column.querySelector("header")!;
    const sized = new ResizeObserver(() => el.style.setProperty("--card", `min(70dvh, ${under.getBoundingClientRect().top - bar.getBoundingClientRect().bottom}px - 0.5rem)`));
    for (const e of [under, column, bar]) sized.observe(e);
    return () => sized.disconnect();
  }, []);
  // With a top, at least as high as it has been, within --card as that changes.
  const topped = !!top;
  useLayoutEffect(() => {
    if (!topped) return;
    const el = card.current!;
    let most = 0;
    const grown = new ResizeObserver(() => ((most = Math.max(most, el.offsetHeight)), el.style.setProperty("min-height", `min(var(--card), ${most}px)`)));
    grown.observe(el);
    return () => {
      grown.disconnect();
      el.style.removeProperty("min-height");
    };
  }, [topped]);
  return (
    <>
      {/* Over the transcript, unseen, to take the tap that closes it: the chat's top bar paints over it. */}
      <div aria-hidden onClick={close} className="absolute inset-x-0 bottom-full h-dvh" />
      <div ref={room} className="chat-inset pointer-events-none absolute inset-x-0 bottom-full px-3 pb-2">
        <div
          ref={card}
          role="dialog"
          aria-label={title}
          style={drag ? { transform: `translateY(${drag.by}px)` } : undefined}
          className={cn("card-scroll pointer-events-auto mx-auto flex max-h-(--card) chat-column flex-col overflow-y-auto rounded-2xl border bg-popover text-popover-foreground shadow-lg tall:overflow-hidden not-tall:[clip-path:border-box]", !drag && "transition-transform")}
        >
          <div className="shrink-0">
            {/* Held, it keeps the caret where you type, and takes no text along. A finger's reach, over the
                top of the title row, which is blank there; ✕ paints over it. */}
            <div
              aria-hidden
              onPointerDown={(e) => e.button === 0 && (e.preventDefault(), e.currentTarget.setPointerCapture(e.pointerId), setDrag({ from: e.clientY, by: 0 }))}
              onPointerMove={(e) => drag && setDrag({ ...drag, by: Math.max(0, e.clientY - drag.from) })}
              onPointerUp={() => drag && (drag.by > card.current!.offsetHeight / 3 ? close() : setDrag(null))}
              onPointerCancel={() => setDrag(null)}
              className="relative -mb-2 flex h-6 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing"
            >
              <span className="h-1 w-9 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="flex min-h-11 items-center gap-2 pl-4 font-medium">
              {logo ?? <Icon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 py-2.5 whitespace-pre-wrap wrap-anywhere">{title}</span>
              {sub && <span className="shrink-0 text-sm font-normal text-muted-foreground">{sub}</span>}
              <button aria-label="关闭" onClick={close} className="hover-round relative ml-auto grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
            {top}
          </div>
          {/* Its bar kept off the card's round corners: on a phone it lies over what scrolls, where the track's margins do nothing. */}
            <div className={cn("card-scroll tall:min-h-0 tall:flex-1 tall:overflow-y-auto", !(title || top) && "tall:mt-2", !foot && "tall:mb-2")}>{children}</div>
          {foot && <div className="shrink-0">{foot}</div>}
        </div>
      </div>
    </>
  );
}

/** How far in from its message box's edge on side align el is: 0 with no box. */
function edge(el: HTMLElement | null, align: "start" | "end") {
  const [a, box] = [el?.getBoundingClientRect(), el?.closest("[data-box]")?.getBoundingClientRect()];
  return a && box ? (align === "start" ? a.left - box.left : box.right - a.right) : 0;
}

/** A popover (story 655), by the button anchor that opened it, over it: on a phone 20rem wide at most,
 *  at the message box's edge on side align, half the screen high at most; on a wide screen lined up
 *  with the anchor, 24rem high at most (story 667). Tapping outside, Esc or a press on what opens it (marked data-pop, which
 *  toggles it itself) closes it; no handle. Never over the chat's top bar, its title and top and foot
 *  staying as what is between scrolls (story 520); with a top, as a search box, it grows but never
 *  shrinks while open, so the top stays put as what is under it filters. title: with ✕ beside it, after
 *  logo or icon, sub after it in grey. */
export function PopFrame({ open, anchor, close, label, title, icon: Icon, logo, sub, align = "start", top, foot, className, children }: { open: boolean; anchor: RefObject<HTMLElement | null>; close: () => void; label: string; title?: string; icon?: LucideIcon; logo?: ReactNode; sub?: string; align?: "start" | "end"; top?: ReactNode; foot?: ReactNode; className?: string; children: ReactNode }) {
  // Clear of the chat's top bar: the bottom of the header of the nearest column that has one.
  const [bar, setBar] = useState(8);
  useLayoutEffect(() => {
    if (!open) return;
    let el = anchor.current?.parentElement;
    while (el && !el.querySelector("header")) el = el.parentElement;
    setBar((el?.querySelector("header")?.getBoundingClientRect().bottom ?? 0) + 8);
  }, [open]);
  const card = useRef<HTMLDivElement>(null);
  const topped = open && !!top;
  useLayoutEffect(() => {
    if (!topped) return;
    const el = card.current;
    if (!el) return;
    let most = 0;
    const grown = new ResizeObserver(() => ((most = Math.max(most, el.offsetHeight)), (el.style.minHeight = `min(var(--available-height), ${most}px)`)));
    grown.observe(el);
    return () => grown.disconnect();
  }, [topped]);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o, d) => {
        // A press on a [data-pop] element (its own key, a toast over it) leaves it open. composedPath is
        // fixed at dispatch, so a toast React removed before the click still counts; focus moving to one
        // first arrives as focus-out, told by where the focus goes.
        const pop = (n: unknown) => n instanceof Element && n.closest("[data-pop]") !== null;
        if (
          o ||
          (d.reason === "outside-press" && d.event?.composedPath().some(pop)) ||
          (d.reason === "focus-out" && pop((d.event as FocusEvent | undefined)?.relatedTarget)) ||
          (d.reason === "escape-key" && d.event?.defaultPrevented)
        )
          return;
        close();
      }}
    >
      <Popover.Portal>
        {/* Over the message box the anchor is in, not over what you type in it, growing as it does, and
            lined up with the anchor's edge (#760) on a wide screen, with the box's on a phone (story 667). Never flipped below or beside it when taller than the
            room there: capped to that room, it scrolls. */}
        <Popover.Positioner anchor={() => anchor.current?.closest("[data-box]") ?? anchor.current} side="top" align={align} sideOffset={4} collisionAvoidance={{ side: "none", fallbackAxisSide: "none" }} alignOffset={() => (matchMedia(ROOM).matches ? edge(anchor.current, align) : 0)} collisionPadding={{ top: bar, right: 8, bottom: 8, left: 8 }} className="z-[70]">
          <Popover.Popup
            ref={card}
            initialFocus={false}
            finalFocus={false}
            aria-label={label}
            className={cn("card-scroll flex max-h-[min(var(--available-height),50dvh)] w-[min(20rem,calc(100vw-3rem))] flex-col overflow-y-auto rounded-2xl border bg-popover text-popover-foreground shadow-lg outline-none room:max-h-[min(var(--available-height),24rem)] room:w-88 tall:overflow-hidden not-tall:[clip-path:border-box]", className)}
          >
            {(title || top) && (
              <div className="shrink-0">
                {title && (
                  <div className="flex min-h-11 items-center gap-2 pl-4 font-medium">
                    {logo ?? (Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />)}
                    <span className="min-w-0 py-2.5 wrap-anywhere">{title}</span>
                    {sub && <span className="shrink-0 text-sm font-normal text-muted-foreground">{sub}</span>}
                    <button aria-label="关闭" onClick={close} className="hover-round relative ml-auto grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
                      <X className="size-4" />
                    </button>
                  </div>
                )}
                {top}
              </div>
            )}
            {/* Its bar kept off the card's round corners: on a phone it lies over what scrolls, where the track's margins do nothing. */}
            <div className={cn("card-scroll tall:min-h-0 tall:flex-1 tall:overflow-y-auto", !(title || top) && "tall:mt-2", !foot && "tall:mb-2")}>{children}</div>
            {foot && <div className="shrink-0">{foot}</div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A query's answer, drawn from its data. run: says a command as typed, its answer shown as any is.
 *  /status's is a popover over the message box, anchor in it (#761). */
export function InfoCard({ card, anchor, close, run }: { card: Card; anchor: RefObject<HTMLElement | null>; close: () => void; run: (command: string) => Promise<void> }) {
  if (card.command === "status")
    return (
      <PopFrame open anchor={anchor} label={card.ref} logo={<AgentLogo agent={card.agent} />} title={card.ref} sub={card.line.split("，")[0]} close={close}>
        <Status s={card} run={run} />
      </PopFrame>
    );
  if (card.command === "usage")
    return (
      <CardFrame icon={Gauge} title="用量" close={close}>
        <Usage u={card} />
      </CardFrame>
    );
  return (
    <CardFrame icon={ChartPie} title="上下文" close={close}>
      <Context c={card} />
      <div className="flex gap-2 px-4 pt-1 pb-4">
        <Action icon={FoldVertical} label="压缩" run={() => run("/compact")} />
      </div>
    </CardFrame>
  );
}

/** A bar of how full p, 0-100, is, in its tone. */
function Bar({ p, className = "mt-1.5" }: { p: number; className?: string }) {
  const t = useTone(p);
  return (
    <span className={cn("block h-2 overflow-hidden rounded-full bg-muted", className)}>
      <span className={cn("block h-full rounded-full", TONE[t])} style={{ width: `${Math.min(p, 100)}%` }} />
    </span>
  );
}

/** A row of a block that does something as you press it: its ground under the mouse reaches a little
 *  past its words, which stay where the other rows' are. */
const PRESS = "-mx-2 w-[calc(100%+1rem)] rounded-md px-2 transition-colors hover:bg-foreground/5";

/** A block of the card under its small heading. */
export const Section = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <section className="px-4 pb-3">
    <h3 className="flex h-8 items-center gap-1.5 text-sm text-muted-foreground">
      {icon}
      {title}
    </h3>
    {children}
  </section>
);

/** A quota window's name in full (story 393): 5 小时, 7 天, 7 天 Fable. */
export const windowTitle = (l: QuotaWindow) => `${l.window === "5h" ? "5 小时" : "7 天"}${l.model ? ` ${l.model}` : ""}`;

/** When a window resets (story 394): how long till then within a day, else the moment; 已重置 once past. */
export const resetsIn = (at: number, now: number) => (at <= now ? "已重置" : at - now < 86_400_000 ? span(at - now) : moment(at, now));

/** A quota line: its name, then on the right what to add and how full, a bar under it. */
function Quota({ name, side, p }: { name: string; side: ReactNode; p: number }) {
  const t = useTone(p);
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2 tabular-nums">
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">{side}</span>
        <span className={cn("w-12 text-right font-semibold", TONE_TEXT[t])}>{Math.round(p)}%</span>
      </div>
      <Bar p={p} />
    </div>
  );
}

/** A quota window's line: its full name, when it resets, how full. */
const Window = ({ l, now }: { l: QuotaWindow; now: number }) => (
  <Quota name={windowTitle(l)} p={l.usedPercent} side={l.resetsAt !== null && (
      <>
        {l.resetsAt > now && <RotateCcw aria-label="重置" className="size-3.5" />}
        {resetsIn(l.resetsAt, now)}
      </>
    )} />
);

const KINDS: [keyof Tokens, string][] = [["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读"], ["cacheWrite", "缓存写"]];

/** /usage (stories 393-397, 500): its quota, then this conversation's use. */
function Usage({ u }: { u: Extract<Card, { command: "usage" }> }) {
  return (
    <div className="pb-1">
      <QuotaPart agent={u.agent} q={u} />
      {u.session && <SessionPart agent={u.agent} s={u.session} />}
    </div>
  );
}

/** An agent's quota (stories 393-395, 500): each window a bar, the extra use, Codex's credits left; none
 *  with none of them. */
export function QuotaPart({ agent, q }: { agent: AgentKind; q: { limits: QuotaWindow[]; extra?: ExtraUsage; credits?: number } }) {
  const now = Date.now();
  if (!q.limits.length && !q.extra && q.credits === undefined) return null;
  return (
    <Section icon={<AgentLogo agent={agent} />} title={`${AGENTS[agent].name} 额度`}>
      {q.limits.map((l, i) => (
        <Window key={i} l={l} now={now} />
      ))}
      {q.extra && <Quota name="额外用量" p={q.extra.usedPercent} side={`${money(q.extra.used, q.extra.currency)}${q.extra.limit === null ? "" : ` / ${money(q.extra.limit, q.extra.currency)}`}`} />}
      {q.credits !== undefined && (
        <div className={ROW}>
          credits 余额
          <span className="ml-auto font-semibold">{q.credits.toFixed(2)}</span>
        </div>
      )}
    </Section>
  );
}

const ROW = "flex h-9 items-center gap-2 tabular-nums";

/** This conversation's cost, where the agent gives one, and tokens (stories 396, 397); the tokens
 *  tapped, their four kinds and, Claude's, the cost by model. */
export function SessionPart({ agent, s }: { agent: AgentKind; s: SessionUse }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  // Last in a popover capped in height: opened, scrolled into sight (#766).
  useEffect(() => void (open && list.current?.scrollIntoView({ block: "nearest" })), [open]);
  return (
    <Section icon={<MessageSquare className="size-3.5" />} title="当前对话">
      {s.cost !== undefined && (
        <div className={ROW}>
          费用
          <span className="ml-auto font-semibold">{money(s.cost)}</span>
          {AGENTS[agent].apiPrice && <span className="text-sm text-muted-foreground">等效 API 价格</span>}
        </div>
      )}
      <button aria-expanded={open} onClick={() => setOpen(!open)} className={cn(ROW, PRESS, "text-left")}>
        Tokens
        <span className="ml-auto font-semibold">{tokens(s.tokens.total)}</span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul ref={list} className="text-sm">
          {KINDS.map(([k, name]) => (
            <li key={k} className="flex h-8 items-center tabular-nums">
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto">{tokens(s.tokens[k])}</span>
            </li>
          ))}
          {s.models?.map((m, i) => (
            <li key={m.name} className={cn("flex h-8 items-center gap-3 tabular-nums", i === 0 && "border-t")}>
              <span className="min-w-0 truncate">{m.name}</span>
              <span className="ml-auto text-muted-foreground">{tokens(m.tokens.total)}</span>
              <span className="w-16 text-right">{money(m.cost)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** /context (story 400): a bar, the tokens out of the window and the percentage; tapped, what holds them. */
export function Context({ c }: { c: ContextUse & { categories?: { name: string; tokens: number }[] } }) {
  const [open, setOpen] = useState(false);
  const p = c.maxTokens ? (c.usedTokens * 100) / c.maxTokens : null;
  const t = useTone(p ?? 0);
  return (
    <>
      <button aria-expanded={open} aria-label="分项" disabled={!c.categories} onClick={() => setOpen(!open)} className="block w-full px-4 py-1 text-left transition-colors enabled:hover:bg-foreground/5">
        {p !== null && (
          <span className="block h-2 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full rounded-full", TONE[t])} style={{ width: `${Math.min(p, 100)}%` }} />
          </span>
        )}
        <span className="mt-1.5 flex items-center gap-2 tabular-nums">
          <span>{c.maxTokens ? `${tokens(c.usedTokens)} / ${tokens(c.maxTokens)}` : `~${tokens(c.usedTokens)}`}</span>
          {p !== null && <span className={cn("ml-auto text-lg font-semibold", TONE_TEXT[t])}>{percent(c.usedTokens, c.maxTokens!)}</span>}
          {c.categories && <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", p === null && "ml-auto", open && "rotate-180")} />}
        </span>
      </button>
      {open && c.categories && (
        <ul className="px-4 pb-1">
          {c.categories.map((x) => (
            <li key={x.name} className="flex h-8 items-center text-sm">
              <span className="min-w-0 truncate">{x.name}</span>
              <span className="ml-auto pl-3 text-muted-foreground tabular-nums">{tokens(x.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** /status's buttons, by the command each runs (story 406). */
const ACTIONS: Record<string, [LucideIcon, string]> = { "/stop": [Square, "停止"], "/model": [Box, "模型"], "/compact": [FoldVertical, "压缩"], "/new": [SquarePen, "新对话"] };

/** /status (stories 401-406): the tool running, if any; 模型设置 and 状态 as IM has them, the quota
 *  windows at 80% or more under them; the directory tapped is copied, the context tapped opens
 *  /context's card; then what can be done now. */
export function Status({ s, run }: { s: StatusCard; run: (command: string) => Promise<void> }) {
  const full = (s.limits ?? []).filter((l) => l.usedPercent >= 80);
  const now = Date.now();
  const c = s.context;
  const p = c?.maxTokens ? (c.usedTokens * 100) / c.maxTokens : null;
  // Its label never wraps, a letter a line, in a narrow popover (story 667).
  const row = "flex min-h-9 w-full items-center gap-2 text-left whitespace-nowrap tabular-nums";
  const copy = () =>
    navigator.clipboard.writeText(s.dir).then(
      () => toast("已复制目录。"),
      () => toast("没能复制。", true),
    );
  return (
    <div className="pb-1">
      {/* The state's word is by the name; what IM adds after its comma, and the tool running, under it. */}
      {(s.line.includes("，") || s.tool) && (
        <p className="-mt-1 px-4 pb-2 text-sm text-muted-foreground">
          {s.line.split("，").slice(1).join("，")}
          {s.tool && <span className="block truncate">{s.tool}</span>}
        </p>
      )}
      <Section icon={<Box className="size-3.5" />} title="模型设置">
        <div className={row}>
          Agent
          <span className="ml-auto">{AGENTS[s.agent].statusName}</span>
        </div>
        {(s.model || s.effort) && (
          <div className={row}>
            模型
            <span className="ml-auto min-w-0 truncate">
              <ModelName name={s.model ?? "默认"} />
            </span>
            {s.effort && <span className="rounded-full border px-2 text-sm">{s.effort}</span>}
          </div>
        )}
        {s.ultracode && (
          <div className={row}>
            ultracode
            <span className="ml-auto">已开启</span>
          </div>
        )}
      </Section>
      <Section icon={<Info className="size-3.5" />} title="状态">
        <button onClick={copy} className={cn(row, PRESS)}>
          目录
          <span className="ml-auto min-w-0 truncate">{s.dir}</span>
          <Copy aria-label="复制" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {c && (
          <button onClick={() => void run("/context")} className={cn(row, PRESS)}>
            上下文
            {p !== null && (
              <span className="ml-auto block h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <span className={cn("block h-full rounded-full", TONE[tone(p)])} style={{ width: `${Math.min(p, 100)}%` }} />
              </span>
            )}
            <span className={cn(p === null && "ml-auto", TONE_TEXT[tone(p ?? 0)])}>{c.maxTokens ? percent(c.usedTokens, c.maxTokens) : `~${tokens(c.usedTokens)}`}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </Section>
      {full.length > 0 && (
        <Section icon={<AgentLogo agent={s.agent} />} title="额度信息">
          {full.map((l, i) => (
            <Window key={i} l={l} now={now} />
          ))}
        </Section>
      )}
      {s.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-1 pb-3">
          {s.actions.map((a) => (
            <Action key={a} icon={ACTIONS[a]![0]} label={ACTIONS[a]![1]} run={() => run(a)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** What the card offers to do: its icon and two words; it spins till its answer comes. */
function Action({ icon: Icon, label, run }: { icon: LucideIcon; label: string; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} onClick={async () => (setBusy(true), await run(), setBusy(false))} className={buttonVariants({ variant: "outline" })}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {label}
    </button>
  );
}
