// What the slot's agent last said of its context and quota, by where you type (spec web-import-composer
// "上下文和额度"): the context ring, a wide screen's quota strips, and the popover both open, which
// /usage and /context typed open too. The numbers are those Rhodium last heard (architecture §7.11).
import { cn } from "cn";
import { ChartPie, FoldVertical } from "lucide-react";
import { useEffect, useReducer, type ReactNode, type RefObject } from "react";
import type { AgentKind, QuotaWindow } from "../../src/contracts";
import { tokens } from "../../src/panels";
import { Context, Grey, PopFrame, QuotaPart, resetsIn, Section, SessionPart, tone, windowTitle } from "./card";
import { buttonVariants } from "./components/ui/button";
import { request, type SlotData } from "./data";

type Meter = SlotData["meter"];

/** How long a quota stays as heard: older, it is grey, even with the agent running (story 657). */
const FRESH = 10 * 60_000;

/** What is grey (story 657): the context and the conversation's use with the agent not running; the
 *  quota then too, or heard over 10 minutes ago, as it may be another slot's. */
export const greyOf = (live: boolean, quotaAt: number | null, now: number) => ({ numbers: !live, quota: !live || (quotaAt !== null && now - quotaAt > FRESH) });

/** greyOf now, drawn anew as the quota turns grey with the page left open. */
export function useGrey(live: boolean, quotaAt: number | null) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const left = quotaAt === null ? -1 : quotaAt + FRESH - Date.now();
    if (!live || left < 0) return;
    const t = setTimeout(redraw, left + 1);
    return () => clearTimeout(t);
  }, [live, quotaAt]);
  return greyOf(live, quotaAt, Date.now());
}

const STROKE = { "": "stroke-foreground", warn: "stroke-needs", bad: "stroke-destructive", grey: "stroke-muted-foreground/60" };
const TEXT = { "": "", warn: "text-needs", bad: "text-destructive", grey: "text-muted-foreground/70" };
const FILL = { "": "bg-foreground", warn: "bg-needs", bad: "bg-destructive", grey: "bg-muted-foreground/45" };

/** The context ring (stories 652-654): how full, drawn and beside it in per cent, in a bar's tone; with
 *  no limit known, an empty circle and the tokens; with nothing heard, an empty circle alone. */
export function Ring({ context, grey, open, toggle, ref, className }: { context: Meter["context"]; grey: boolean; open: boolean; toggle: () => void; ref?: RefObject<HTMLButtonElement | null>; className?: string }) {
  const p = context?.maxTokens ? (context.usedTokens * 100) / context.maxTokens : null;
  const t = grey ? "grey" : tone(p ?? 0);
  const C = 2 * Math.PI * 7;
  return (
    <button ref={ref} data-pop aria-label="上下文和额度" aria-expanded={open} onClick={toggle} className={cn("flex h-11 shrink-0 items-center gap-1 rounded-full px-2 text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground", className)}>
      <svg viewBox="0 0 18 18" aria-hidden className="size-4.5 -rotate-90">
        <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2.5" className="stroke-foreground/15" />
        {p !== null && <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(C * Math.min(p, 100)) / 100} ${C}`} className={STROKE[t]} />}
      </svg>
      {context && <span data-drop="figure" className={TEXT[t]}>{p !== null ? `${Math.round(p)}%` : tokens(context.usedTokens)}</span>}
    </button>
  );
}

/** A wide screen's quota strips (story 652): one a window, in /usage's order and tone; the mouse over
 *  them, a table of each window's name, how full and when it resets. None with no window. */
export function Strips({ limits, grey, open, toggle, className }: { limits: QuotaWindow[]; grey: boolean; open: boolean; toggle: () => void; className?: string }) {
  if (!limits.length) return null;
  const now = Date.now();
  return (
    <div className={cn("group/strips relative items-center", className)}>
      <button data-pop aria-label="额度" aria-expanded={open} onClick={toggle} className="flex h-11 items-center gap-1 px-1.5">
        {limits.map((l, i) => (
          <span key={i} className="block h-1.5 w-7 overflow-hidden rounded-full bg-foreground/15">
            <span className={cn("block h-full rounded-full", FILL[grey ? "grey" : tone(l.usedPercent)])} style={{ width: `${Math.min(l.usedPercent, 100)}%` }} />
          </span>
        ))}
      </button>
      {!open && (
        <div role="tooltip" className="pointer-events-none absolute right-0 bottom-full mb-1 hidden rounded-xl border bg-popover py-1 text-sm whitespace-nowrap text-popover-foreground shadow-lg tabular-nums group-hover/strips:block">
          <table>
            <tbody>
            {limits.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pl-3">{windowTitle(l)}</td>
                <td className={cn("py-1 pl-4 text-right font-semibold", TEXT[grey ? "grey" : tone(l.usedPercent)])}>{Math.round(l.usedPercent)}%</td>
                <td className="py-1 pr-3 pl-4 text-right text-muted-foreground">{l.resetsAt !== null && resetsIn(l.resetsAt, now)}</td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** What the popover shows (story 654): the context, with 压缩 where compact is given; the quota; this
 *  conversation's use; each where heard, grey as greyOf says. With none, one line saying so. */
export function MeterBody({ meter, live, agent, compact, now = Date.now() }: { meter: Meter; live: boolean; agent: AgentKind | null; compact?: () => void; now?: number }) {
  const { context, session, quota } = meter;
  const grey = greyOf(live, quota?.at ?? null, now);
  if (!context && !session && !quota) return <p className="px-4 py-3 text-sm text-muted-foreground">还没有数字，agent 跑完一个回合后再看</p>;
  // Grey, its words and numbers in grey, its bars too (Grey).
  const part = (g: boolean, children: ReactNode) => (
    <Grey value={g}>
      <div className={cn(g && "text-muted-foreground")}>{children}</div>
    </Grey>
  );
  return (
    <div className="pt-1 pb-1">
      {context &&
        part(
          grey.numbers,
          <Section icon={<ChartPie className="size-3.5" />} title="上下文">
            <div className="-mx-4">
              <Context c={context} />
            </div>
            {compact && (
              <button onClick={compact} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-2")}>
                <FoldVertical className="size-4" />
                压缩
              </button>
            )}
          </Section>,
        )}
      {quota && agent && part(grey.quota, <QuotaPart agent={agent} q={quota} />)}
      {session && agent && part(grey.numbers, <SessionPart agent={agent} s={session} />)}
    </div>
  );
}

/** The popover over the ring (stories 654, 655): opened, it asks Rhodium to ask the running agent, if
 *  any, whose answer comes as the stream's meter event; none is started. */
export function MeterPop({ slot, open, anchor, close, meter, live, agent, compact }: { slot: string; open: boolean; anchor: RefObject<HTMLElement | null>; close: () => void; meter: Meter; live: boolean; agent: AgentKind | null; compact?: () => void }) {
  useEffect(() => void (open && request("api/meter", { method: "POST", body: new URLSearchParams({ slot }) }).catch(() => {})), [open, slot]);
  return (
    <PopFrame open={open} anchor={anchor} close={close} label="上下文和额度" align="end" className="w-[min(22rem,calc(100vw-2rem))]">
      <MeterBody meter={meter} live={live} agent={agent} compact={compact} />
    </PopFrame>
  );
}
