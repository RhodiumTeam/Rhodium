// What scrolls as a chat does, the chat's own and 详情's events (spec web-chat, web-topology): it opens
// at the newest and stays there as more comes; scrolled up, it brings the pages before without moving
// what you read, and what comes below shows 新消息.
import { cn } from "cn";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button } from "./components/ui/button";
import { useEdges } from "./write";

const NEAR = 400; // px from the top where the page before is brought
const END = 40; // px from the bottom that count as at the newest

/** Where a Stick was as it went: scrolled to top, null at the newest; fresh, 新消息 showed; tail, what
 *  came last as it was drawn last, so what came while it was gone shows 新消息 (#294); reset, what it
 *  showed: another now, as a conversation brought while it was gone (#386), and it opens at the newest. */
export type Place = { top: number | null; fresh: boolean; tail?: unknown; reset?: unknown };

/** label: what screen readers call it. reset: changed, it starts over at the newest, as for another
 *  conversation. tail: changed, something new came below. older: brings the page before, and says
 *  whether there may be more. place: where it was scrolled to as it went, null at the newest, and
 *  whether 新消息 showed; it opens so. fade: its cut ends fade. children: what it shows, drawn again
 *  as pages come. */
export function Stick({ label, reset, tail, older, place, fade, className, children }: { label: string; reset: unknown; tail: unknown; older: () => Promise<boolean>; place?: Place; fade?: boolean; className?: string; children: () => ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const edged = useEdges(list);
  const atEnd = useRef(true);
  const drawn = useRef<{ reset: unknown; tail: unknown }>(undefined);
  const paging = useRef(false);
  const left = place?.reset === reset ? place : undefined;
  const [fresh, setFresh] = useState(() => !!left?.fresh); // something came below while you read above
  const freshNow = useRef(fresh);
  freshNow.current = fresh;
  const [, redraw] = useState(0);

  // The pages before come in above what you read: scroll down past them, so it stays put. The browser's
  // own scroll anchoring is off, as it does not work at the very top.
  const back = async () => {
    const el = list.current;
    if (!el || paging.current) return;
    paging.current = true;
    try {
      // Not once it has gone: its scrollTop is 0 for good.
      while (el.isConnected && el.scrollTop < NEAR && (await older())) {
        const height = el.scrollHeight;
        flushSync(() => redraw((n) => n + 1));
        el.scrollTop += el.scrollHeight - height;
      }
    } finally {
      paging.current = false;
    }
  };

  useLayoutEffect(() => {
    const el = list.current!;
    const was = drawn.current;
    drawn.current = { reset, tail };
    if (!was && left?.top != null) {
      el.scrollTop = left.top;
      atEnd.current = false;
      if (left.tail !== tail) setFresh(true);
    } else if (!was || was.reset !== reset || atEnd.current) el.scrollTop = el.scrollHeight;
    else if (was.tail !== tail) setFresh(true);
    // A first page shorter than the screen.
    void back().catch(() => {});
  });

  // Shorter as what is under it grows, as where you type does with your words: at the newest, it stays there.
  useLayoutEffect(() => {
    const el = list.current!;
    const sized = new ResizeObserver(() => void (atEnd.current && (el.scrollTop = el.scrollHeight)));
    sized.observe(el);
    return () => sized.disconnect();
  }, []);

  // Where it is as it goes: read then, as a scroll just made is told only on the next frame.
  useLayoutEffect(() => {
    const el = list.current!;
    return () => {
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < END;
      if (place) Object.assign(place, { top: end ? null : el.scrollTop, fresh: !end && freshNow.current, tail: drawn.current?.tail, reset: drawn.current?.reset });
    };
  }, []);

  const scrolled = () => {
    const el = list.current!;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < END;
    if (atEnd.current) setFresh(false);
    void back().catch(() => {});
  };

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      {/* A call opened at the bottom grows it with no scroll: React passes up its details' toggle. */}
      <div ref={fade ? edged.ref : list} role="log" aria-label={label} onScroll={(e) => (fade && edged.onScroll(e), scrolled())} onToggle={scrolled} className={cn("absolute inset-0 overflow-y-auto [overflow-anchor:none]", fade && "edge-fade-y")}>
        {children()}
      </div>
      {fresh && (
        <Button size="sm" className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 shadow-md" onClick={() => list.current!.scrollTo({ top: list.current!.scrollHeight })}>
          新消息
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}
