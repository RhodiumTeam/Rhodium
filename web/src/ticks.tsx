// The chat's tick strip indexes your messages loaded in the transcript (spec web-exchanges).
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import { cn } from "cn";
import { useLayoutEffect, useRef, useState } from "react";
import { clock } from "./common";
import type { Block } from "./data";
import { Face } from "./faces";
import type { Shown } from "./tools";

type Tick = { at: string; text: string; time: number | null; reply?: string; from?: Extract<Block, { kind: "user" }>["from"] };

export const isYourTick = (b: Extract<Block, { kind: "user" }>): boolean =>
  !b.source || (!/^槽位 .+，经 rh send/.test(b.source) && !b.source.startsWith("Rhodium："));

export function ticksOf(blocks: Shown[]): Tick[] {
  const ticks: Tick[] = [];
  let asking: Tick | undefined;
  for (const b of blocks) {
    if (b.kind === "user") {
      asking = undefined;
      if (isYourTick(b)) {
        asking = { at: b.at, text: b.text, time: b.time, from: b.from };
        ticks.push(asking);
      }
    } else if (asking && b.kind === "assistant") {
      asking.reply = b.text;
      asking = undefined;
    }
  }
  return ticks;
}

/** Vertical space per tick, then the window around the current tick when even the minimum won't fit. */
export function visibleTicks(total: number, current: number, height: number, compact: boolean) {
  const room = height * 0.7;
  const step = Math.min(compact ? 5 : 9, Math.max(3, room / total));
  const count = Math.min(total, Math.max(1, Math.floor((room + 0.001) / step)));
  const first = Math.max(0, Math.min(total - count, current - Math.floor(count / 2)));
  return { first, count, step };
}

function centerSelected(el: HTMLDivElement | null) {
  const selected = el?.querySelector<HTMLElement>("[aria-current]");
  if (el && selected) el.scrollTop = selected.offsetTop - (el.clientHeight - selected.offsetHeight) / 2;
}

export function TickStrip({ ticks }: { ticks: Tick[] }) {
  return ticks.length >= 2 ? <Strip ticks={ticks} /> : null;
}

function Strip({ ticks }: { ticks: Tick[] }) {
  const rail = useRef<HTMLDivElement>(null);
  const nodes = useRef<HTMLElement[]>([]);
  const picked = useRef<string | null>(null);
  const manual = useRef(false);
  const [current, setCurrent] = useState(0);
  const [compact, setCompact] = useState(true);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = rail.current!;
    const log = el.closest<HTMLElement>("[role=log]")!;
    const column = el.nextElementSibling!;
    const mouse = matchMedia("(hover: hover) and (pointer: fine)");
    nodes.current = Array.from(column.querySelectorAll<HTMLElement>("[data-tick-at]"));
    let frame = 0;
    const look = () => {
      frame = 0;
      const bottom = log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
      const view = log.getBoundingClientRect();
      const chosen = picked.current && nodes.current.find((node) => node.dataset.tickAt === picked.current);
      if (chosen) {
        const box = chosen.getBoundingClientRect();
        if (box.bottom > view.top && box.top < view.bottom) {
          setCurrent(nodes.current.indexOf(chosen));
          return;
        }
      }
      const top = view.top + 100;
      let lo = 0, hi = nodes.current.length;
      while (!bottom && lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (nodes.current[mid]!.getBoundingClientRect().top <= top) lo = mid + 1;
        else hi = mid;
      }
      setCurrent(bottom ? ticks.length - 1 : Math.max(0, lo - 1));
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(look); };
    const resize = () => {
      setHeight(log.clientHeight);
      const small = !mouse.matches || column.clientWidth < 40 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      setCompact(small);
      if (!small) setOpen(false);
      scroll();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(log);
    observer.observe(column);
    // A wheel, touch, scroll key or scrollbar drag can interrupt the smooth jump.
    const interacting = () => { manual.current = true; };
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.target instanceof HTMLElement) || e.target.isContentEditable || e.target.closest("input, textarea, select")) return;
      if ((e.target === document.body || log.contains(e.target)) && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) interacting();
    };
    const pointer = (e: PointerEvent) => { if (e.target === log || e.button === 1) interacting(); };
    const scrolled = () => {
      if (manual.current) picked.current = null;
      scroll();
    };
    log.addEventListener("wheel", interacting, { passive: true });
    log.addEventListener("touchmove", interacting, { passive: true });
    log.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    log.addEventListener("scroll", scrolled, { passive: true });
    mouse.addEventListener("change", resize);
    resize();
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", key);
      log.removeEventListener("pointerdown", pointer);
      log.removeEventListener("touchmove", interacting);
      log.removeEventListener("wheel", interacting);
      log.removeEventListener("scroll", scrolled);
      mouse.removeEventListener("change", resize);
      cancelAnimationFrame(frame);
    };
  }, [ticks]);
  const go = (i: number) => {
    setOpen(false);
    picked.current = ticks[i]!.at;
    manual.current = false;
    const node = nodes.current[i];
    if (node) {
      const view = node.closest("[role=log]")!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      if (box.bottom > view.top && box.top < view.bottom) setCurrent(i);
    }
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const { first, count, step } = visibleTicks(ticks.length, current, height, compact);
  const label = (t: Tick) => "你：" + t.text.trim().split("\n", 1)[0];
  const head = (t: Tick) => <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
    {t.from && <Face url={t.from.botAvatar} p={t.from.platform} size={16} ring="ring-popover" />}
    <span className="truncate font-medium">你</span>{t.time !== null && <span className="ml-auto shrink-0 tabular-nums">{clock(t.time)}</span>}
  </span>;
  const mark = (i: number) => <span className={cn("block h-[2px] shrink-0 rounded-full", compact ? i === current ? "w-2.5" : "w-1" : i === current ? "w-5" : "w-3 group-hover:w-5 group-focus-visible:w-5",
    i === current ? "bg-foreground" : "bg-muted-foreground/45")} />;
  const part = ticks.slice(first, first + count);
  return <div ref={rail} className="pointer-events-none sticky top-1/2 z-10 h-0">
    {compact ? <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label="刻度条" className="pointer-events-auto absolute right-0 flex min-h-11 w-6 -translate-y-1/2 flex-col items-end justify-center pr-0.5">
        {part.map((t, n) => <span key={t.at} style={{ height: step }} className="flex items-center">{mark(first + n)}</span>)}
      </Popover.Trigger>
      <Popover.Portal><Popover.Positioner side="left" sideOffset={4} collisionPadding={8} className="z-[70]">
        <Popover.Popup aria-label="刻度条" initialFocus={false} ref={centerSelected} className="relative grid max-h-[min(70dvh,32rem)] w-[min(19rem,calc(100vw-3rem))] overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
          {ticks.map((t, i) => <button key={t.at} type="button" aria-label={label(t)} aria-current={i === current || undefined} onClick={() => go(i)}
            className={cn("grid w-full min-w-0 gap-1 rounded-lg px-2.5 py-2 text-left", i === current ? "bg-muted" : "hover:bg-muted/60")}>
            {head(t)}<span className="truncate text-sm">{t.text}</span>
          </button>)}
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root> : <nav aria-label="刻度条" className="pointer-events-auto absolute right-0 grid -translate-y-1/2">
      {part.map((t, n) => {
        const i = first + n;
        return <Tooltip.Root key={t.at}>
          <Tooltip.Trigger type="button" delay={100} aria-label={label(t)} aria-current={i === current || undefined} onClick={() => go(i)}
            style={{ height: step }} className="group flex w-7 items-center justify-end pr-1">{mark(i)}</Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Positioner side="left" sideOffset={5} className="z-[70]">
            <Tooltip.Popup role="tooltip" className="grid w-68 gap-1.5 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
              {head(t)}<span className="line-clamp-2 whitespace-pre-line wrap-anywhere">{t.text}</span>
              {t.reply && <span className="line-clamp-2 border-l-2 pl-2 whitespace-pre-line wrap-anywhere text-muted-foreground">{t.reply}</span>}
            </Tooltip.Popup>
          </Tooltip.Positioner></Tooltip.Portal>
        </Tooltip.Root>;
      })}
    </nav>}
  </div>;
}
