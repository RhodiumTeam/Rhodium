// The jump box (spec web-maximize "跳转框"): ⌘K, Ctrl+K off a Mac, or the sidebar's 跳转 opens it over
// the chat, or over the page with none, to go to a slot by name. The page loads this only once it first opens.
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Search } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { COLOR, Name, order, word, type Row } from "./board";
import { AgentLogo, chatAt, openFrom, recent, ROOM } from "./common";
import { json, type BoardData } from "./data";
import { useEdges } from "./write";

/** The slots the jump box lists for what was typed (story 441). Nothing: those opened lately in this tab
 *  (recent, the latest first) but the open one (current), then the rest as the list has them; no
 *  archived. Else, in any case, those whose name starts with it, then those whose full name has it,
 *  then those whose last line has it, each as the list has them; then the archived so. */
export function jumpList(data: BoardData, typed: string, current: string, recent: string[]): Row[] {
  const q = typed.trim().toLowerCase();
  const { live, archived } = order(data);
  if (!q) {
    const rest = live.filter((r) => r.c.id !== current);
    const seen = recent.flatMap((id) => rest.filter((r) => r.c.id === id));
    return [...seen, ...rest.filter((r) => !seen.includes(r))];
  }
  const rank = (r: Row) => [r.c.name, r.c.ref, r.c.last?.text ?? ""].findIndex((s, i) => (i ? s.toLowerCase().includes(q) : s.toLowerCase().startsWith(q)));
  const ranked = (rows: Row[]) => [0, 1, 2].flatMap((k) => rows.filter((r) => rank(r) === k));
  return [...ranked(live), ...ranked(archived)];
}

/** The jump box: a box to type in, the slots it lists under it, the first picked. ↑↓ pick, round at
 *  the ends, as the pointer does; Enter or a click opens the slot picked with the page as it is, a
 *  step of its own. Esc or a tap off it closes it, as ⌘K again does. close(picked): it closes, with a
 *  slot picked or not. */
export function Jump({ close }: { close: (picked?: boolean) => void }) {
  const [at] = useLocation();
  const { data } = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board") });
  const [typed, setTyped] = useState("");
  const [pick, setPick] = useState(0);
  // Over the chat's column, where there is one; drawn once, as it opens.
  const [chat] = useState(() => (typeof document === "undefined" ? undefined : document.querySelector("[data-chat]")?.getBoundingClientRect()));
  const wide = typeof matchMedia !== "undefined" && matchMedia(ROOM).matches; // none: drawn on a server, as in tests
  const current = chatAt(at, wide);
  const list = data ? jumpList(data, typed, current, recent.get()) : [];
  const sel = Math.min(pick, list.length - 1);
  const go = (id: string) => (id === current ? close() : (openFrom(id, at), close(true)));
  const scroller = useEdges<HTMLDivElement>();
  return (
    // A tap off it closes it, leaving the keyboard where it was.
    <div className="fixed inset-0 z-[80] bg-black/10 dark:bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), close())}>
      <div
        role="dialog"
        aria-label="跳转"
        // A click in it but on its input leaves the caret there: Esc still closes the box.
        onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}
        style={chat ? { marginLeft: chat.left + Math.max(16, (chat.width - 576) / 2), width: Math.min(576, chat.width - 32) } : undefined}
        className={cn("mt-[12vh] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg", !chat && "mx-auto w-[min(36rem,calc(100%-2rem))]")}
      >
        <label className="flex items-center gap-2 border-b px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-label="槽位"
            aria-expanded
            aria-controls="jump-list"
            aria-activedescendant={list[sel] && `jump-${list[sel].c.id}`}
            placeholder="槽位"
            value={typed}
            onChange={(e) => (setTyped(e.target.value), setPick(0))}
            onKeyDown={(e) => {
              // An input method's Enter takes its word, its Esc ends the composing.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              const by = { ArrowDown: 1, ArrowUp: -1 }[e.key];
              if (by && list.length) setPick((sel + by + list.length) % list.length);
              else if (e.key === "Enter" && list[sel]) go(list[sel].c.id);
              // Only the box closes: not the info card, nor the turn.
              else if (e.key === "Escape") (e.stopPropagation(), close());
              // Tab stays: the caret leaves the box only as it closes.
              else if (e.key !== "Tab") return;
              e.preventDefault();
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        {/* Faded where cut, ↑↓'s row scrolled clear of the fade, as the palette is (#579). */}
        <div {...scroller} id="jump-list" role="listbox" aria-label="槽位" className="card-scroll edge-fade-y max-h-[22rem] scroll-py-8 overflow-y-auto">
          <div className="p-1">
            {list.map((r, i) => (
              <JumpRow key={r.c.id} r={r} picked={i === sel} onPick={() => setPick(i)} onOpen={() => go(r.c.id)} />
            ))}
            {!list.length && typed.trim() && <p className="px-3 py-2.5 text-sm text-muted-foreground">没有这个槽位。</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A slot in the jump box: its logo with its state's dot, its full name and its state; archived, faded. */
function JumpRow({ r: { c, kind, ws }, picked, onPick, onOpen }: { r: Row; picked: boolean; onPick: () => void; onOpen: () => void }) {
  const archived = kind === "archived";
  return (
    <button
      role="option"
      aria-selected={picked}
      id={`jump-${c.id}`}
      tabIndex={-1}
      ref={(e) => void (picked && e?.scrollIntoView({ block: "nearest" }))}
      onPointerMove={() => picked || onPick()}
      onClick={onOpen}
      className={cn("flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left [--c:var(--muted-foreground)]", picked && "bg-accent", archived && "opacity-55", COLOR[kind])}
    >
      <span className={cn("relative grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground", archived && "grayscale")}>
        {c.agent ? <AgentLogo agent={c.agent} className="size-[60%]" /> : <span aria-hidden>{c.name[0]?.toUpperCase()}</span>}
        {kind !== "idle" && !archived && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-[1.5px] border-popover bg-(--c)" />}
      </span>
      <Name ws={ws} name={c.name} bots={[]} className="flex min-w-0 flex-1 text-[14.5px] font-medium whitespace-nowrap" />
      <span
        className={cn("shrink-0 text-xs whitespace-nowrap text-(--c) tabular-nums", kind === "needs" && "rounded-full bg-[color-mix(in_oklab,var(--c)_15%,var(--popover))] px-2 py-0.5 font-semibold")}
      >
        {word(c, kind)}
      </span>
    </button>
  );
}
