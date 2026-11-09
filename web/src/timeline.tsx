// A slot's timeline (spec web-topology "时间线和预览"), in the topology's details and the chat's 详情:
// its conversations, each a tap from its preview and, but the one it holds now, from going back to it.
import { cn } from "cn";
import { ChevronDown, History } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentLogo } from "./common";
import type { Episode } from "./data";
import { Spin, useAct } from "./write";

// What the chat page shows a conversation with, which comes with the chat's code, once the first preview opens.
const Preview = lazy(() => import("./slot").then((m) => ({ default: m.Preview })));

/** Whether a turn is under way in the slot, an ask waiting on you in it too (spec web-write "在跑");
 *  not the terminal's. */
export const inTurn = (s: { mode: string; phase: string }) => s.mode === "headless" && (s.phase === "starting" || s.phase === "running" || s.phase === "waiting");

/** The box el scrolls in: its nearest ancestor that scrolls, else the page. */
const scroller = (el: Element) => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return document.documentElement;
};

const when = (at: number) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** A slot's conversations, newest first, each by its title; the one it holds now has a bar. Tapping
 *  one opens its preview under it; its 回到这段 goes back to it, as /resume does, by its id (story 306),
 *  not while a turn runs. The newest five, and the rest on request. onPreview: told the slot while its
 *  current conversation is previewed, for the page's stream to follow it, and null after. */
export function Timeline({ slot, list, turn, onPreview }: { slot: string; list: Episode[]; turn: boolean; onPreview?: (slot: string | null) => void }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, run] = useAct();
  const [going, setGoing] = useState<string | null>(null);
  const current = list.find((c) => c.id === open)?.current;
  // A preview opened low in a short sheet is scrolled up into it, down to its newest lines, its row with
  // it (#637): while the preview fits the details at its full height, its gap below too, it is made no
  // taller than they show under its row, clear of their fades, and follows them as they change size,
  // scrolled back in should it grow out of them or they shrink from under it, unless scrolled away from
  // by hand. One that does not fit has its row go to the top instead, the preview under it (#611).
  const preview = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const p = preview.current;
    if (!p) return;
    const box = p.parentElement!;
    const s = scroller(p);
    const { scrollMarginTop, scrollMarginBottom } = getComputedStyle(box);
    const [top, bottom] = [parseFloat(scrollMarginTop), parseFloat(scrollMarginBottom)];
    // Measured at its full height: a scroller as tall as what it holds would show no more room. Shortened
    // by no more than they cannot hold, so not at all in details that grow to hold it. Whether it fits.
    const fit = () => {
      p.style.maxHeight = "";
      const fits = p.offsetHeight + bottom <= s.clientHeight;
      const held = p.offsetHeight - (s.scrollHeight - s.clientHeight);
      if (fits) p.style.maxHeight = `${Math.max(s.clientHeight - top - bottom - (box.offsetHeight - p.offsetHeight), held)}px`;
      return fits;
    };
    let fits = fit();
    box.scrollIntoView({ block: fits ? "nearest" : "start" });
    // Followed only while what was put in view stays clear of their fades, each as deep as it is drawn:
    // scrolled out of them by hand, it is left there. A scroll as they change size is theirs, not yours.
    let [shown, h] = [true, s.clientHeight];
    const seen = () => {
      if (s.clientHeight !== h) return;
      const [b, r, v] = [box.getBoundingClientRect(), p.getBoundingClientRect(), s.getBoundingClientRect()];
      shown = b.top - Math.min(top, s.scrollTop) >= v.top - 1 && (fits ? r.bottom : r.top) + Math.min(bottom, s.scrollHeight - s.clientHeight - s.scrollTop) <= v.bottom + 1;
    };
    s.addEventListener("scroll", seen);
    // Grown, or left in their bottom fade or under it: all of it where it fits, else its row.
    const sized = new ResizeObserver(() => {
      h = s.clientHeight;
      const was = p.offsetHeight;
      fits = fit();
      const r = p.getBoundingClientRect();
      if (shown && (p.offsetHeight > was || (fits ? r.bottom : r.top) + bottom > s.getBoundingClientRect().bottom)) box.scrollIntoView({ block: "nearest" });
    });
    sized.observe(s);
    return () => (sized.disconnect(), s.removeEventListener("scroll", seen));
  }, [open]);
  useEffect(() => {
    if (!current || !onPreview) return;
    onPreview(slot);
    return () => onPreview(null);
  }, [current, slot]);
  const shown = all ? list : list.slice(0, 5);
  if (!list.length) return null;
  const bar = (c: Episode) => c.current && "before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r before:bg-foreground";
  const back = async (c: Episode) => {
    setGoing(c.id);
    await run({ kind: "say", slot, text: `/resume ${c.id}` });
    setGoing(null);
  };
  return (
    <section className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-1.5">
      {shown.map((c) =>
        // A conversation with no title: one short muted line, its id, when the agent has given it one, and time.
        c.title === null ? (
          <div key={c.id} className={cn("relative flex h-7 items-center gap-2 pr-2 pl-3 text-[11px] text-muted-foreground", bar(c))}>
            <AgentLogo agent={c.agent} className="text-xs opacity-60" />
            {c.short && <span className="font-mono">{c.short}</span>}
            <span className="ml-auto whitespace-nowrap">{when(c.lastWrite ?? c.startedAt)}</span>
          </div>
        ) : (
          // Open, the row and its preview are one box.
          <div key={c.id} className="scroll-my-8 rounded-lg border bg-background">
            <div className={cn("relative flex min-h-11 min-w-0 items-stretch rounded-lg", open === c.id && "rounded-b-none bg-muted", bar(c))}>
              <button onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id} className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-2 pl-3 text-left transition-colors hover:bg-foreground/5 active:bg-muted", open === c.id && "rounded-b-none", !c.current && c.short && "rounded-r-none")}>
                <AgentLogo agent={c.agent} className="text-sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.title}</span>
                  <span className="flex gap-2 text-[11px] leading-4 text-muted-foreground">
                    <span className="font-mono">{c.short}</span>
                    <span className="ml-auto whitespace-nowrap">{when(c.lastWrite ?? c.startedAt)}</span>
                  </span>
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open === c.id && "rotate-180")} />
              </button>
              {!c.current && c.short && (
                <button aria-label="回到这段" disabled={turn || busy} onClick={() => void back(c)} className={cn("grid w-11 shrink-0 place-items-center rounded-r-lg border-l text-muted-foreground transition-colors enabled:hover:bg-foreground/5 enabled:hover:text-foreground active:bg-muted disabled:opacity-40", open === c.id && "rounded-br-none")}>
                  {going === c.id ? <Spin /> : <History className="size-4" />}
                </button>
              )}
            </div>
            {open === c.id && (
              <div ref={preview} className="flex h-60 flex-col overflow-hidden rounded-b-lg border-t lg:h-80">
                <Suspense>
                  <Preview slot={slot} conversation={c.id} live={c.current} />
                </Suspense>
              </div>
            )}
          </div>
        ),
      )}
      {shown.length < list.length && (
        <button onClick={() => setAll(true)} className="h-11 rounded-lg border border-dashed text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted">
          还有 {list.length - shown.length} 段
        </button>
      )}
    </section>
  );
}
