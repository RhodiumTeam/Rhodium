// Writing from the board (spec web-write): what a button does goes to POST /api/act, and its answer
// shows in a toast at the bottom; what you type to a slot goes the same way, or to POST /api/send with
// what you attached. Only the chat's and the topology's code has this, and the archived slots' restore
// buttons, the rows' menus and the board's toasts, loaded once they show: the board's first screen stays light.
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { cn } from "cn";
import { Archive, ArchiveRestore, ArrowUp, Check, ChevronDown, CircleAlert, CornerUpRight, FileText, List, ListPlus, LoaderCircle, Paperclip, Pause, Pencil, Pin, PinOff, Play, Plus, Quote, RotateCw, Square, SquarePen, SquareTerminal, Trash2, Workflow, X, Zap, type LucideIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject, type UIEvent } from "react";
import { useLocation } from "wouter";
import { AGENTS } from "../../src/agents";
import { parseCommand, plain, quoteOf, quoting, type AgentKind, type BoardAct } from "../../src/contracts";
import type { Candidate } from "../../src/panels";
import type { RhReply } from "../../src/router";
import { cutOrNone, flash, measure } from "./board";
import { AgentLogo, breakLong, chatAt, FileRow, goHash, MAC, Max, ModelName, ROOM } from "./common";
import { buttonVariants } from "./components/ui/button";
import { posting, request, type Card, type Command, type Messages, type Sent, type SlotData } from "./data";
import { InfoCard } from "./card";
import { AgentSheet, Answer, matching, ModelSheet, Palette } from "./palette";
import { dismiss, toast, useToasts, type Toast } from "./toast";
import { useTerminalEntry } from "./settings";
import { askOnce } from "./unread";

const TRIES = 3;

/** POSTs init's body to path, and resolves to rhodium's answer; it never rejects, so a button is never
 *  left busy. One whose answer the network lost, even mid-body, or that met a 502 while rhodium
 *  restarts, goes again as it was, with the same id, which rhodium does once (story 257). */
async function post(path: string, init: RequestInit): Promise<RhReply> {
  const read = async (r: Response): Promise<RhReply | null> =>
    r.ok ? ((await r.json()) as RhReply) : r.status < 500 ? { ok: false, error: (await r.text()).trim() || `出错了（${r.status}）` } : null;
  // Out, the page does not load itself again for a new build (web/src/main.tsx).
  posting.count++;
  try {
    for (let tries = 1; ; tries++) {
      const reply = await request(path, { method: "POST", ...init })
        .then(read)
        .catch(() => null);
      if (reply) return reply;
      if (tries === TRIES) return { ok: false, error: "连不上 Rhodium。" };
      await new Promise((done) => setTimeout(done, 1000));
    }
  } finally {
    posting.count--;
  }
}

/** Sends the act under id, as post() does. */
export const act = (a: BoardAct, id: string = crypto.randomUUID()): Promise<RhReply> =>
  post("api/act", { headers: { "content-type": "application/json" }, body: JSON.stringify({ id, act: a }) });

/** Sends what you typed to the slot under the message's id, which a retry keeps: with what you
 *  attached to POST /api/send, else as an act. */
export function say(slot: string, s: Pick<Sent, "id" | "words" | "files">): Promise<RhReply> {
  if (!s.files.length) return act({ kind: "say", slot, text: s.words }, s.id);
  const form = new FormData();
  for (const [k, v] of [["id", s.id], ["slot", slot], ["text", s.words]]) form.set(k!, v!);
  for (const f of s.files) form.append("file", f);
  return post("api/send", { body: form });
}

/** What of text, with files attached, the transcript will show as yours, as Rhodium reads it (router's
 *  boardSay): the words, a ! before them gone. null for what Rhodium runs, ! alone or a /x it knows,
 *  and for a /x the agent runs, which the transcript shows as no message of yours. */
export function forAgent(text: string, files: number): string | null {
  const bang = /^[!！]\s*/.exec(text);
  const words = bang ? text.slice(bang[0].length) : text;
  if (bang && !words.trim() && !files) return null;
  return words.trimStart().startsWith("/") ? null : words;
}

/** What you typed, with files attached, under the reply you quote (story 573), as a quote from IM
 *  reaches the agent (router's im): the quote, an empty line, then your words, a ! before them still
 *  first. What is run as a command, by Rhodium or the agent, even queued, stays as typed. */
export function withQuote(reply: string, typed: string, files = 0): string {
  if (forAgent(typed, files) === null) return typed;
  const bang = /^[!！]\s*/.exec(typed)?.[0] ?? "";
  return bang + [quoting(reply) + "\n", typed.slice(bang.length)].filter(Boolean).join("\n");
}

/** What you said, in its bubble (story 573): a quote it starts with on one quiet line, cut where it
 *  does not fit, then your words. */
export function Words({ text }: { text: string }) {
  const q = quoteOf(text);
  const words = q ? q.rest : text;
  return (
    <>
      {/* Under words, 12rem asked for, so a short reply's bubble still shows how the quote starts; no
          more, so a long quote does not stretch it; then as wide as the bubble, never wider. Alone, as
          wide as it reads, down to none, so the bubble stays in the room. Cut where it ends. */}
      {q && (
        <p className={cn("grid grid-cols-[max-content_minmax(0,auto)] items-center gap-1.5 text-sm text-muted-foreground", words && "w-48 max-w-full min-w-full")}>
          <span role="img" aria-label="引用">
            <Quote className="size-3.5" />
          </span>
          <span className="truncate">{plain(q.quote)}</span>
        </p>
      )}
      {words && <p className="whitespace-pre-wrap wrap-anywhere">{breakLong(words)}</p>}
    </>
  );
}

/** What the key does now (story 282), as Rhodium will read what you typed (router's boardSay): with no
 *  turn under way, it sends; with one, it stops it with nothing typed or ! alone, sends a command
 *  Rhodium knows at once, interrupts the turn for words after a !, and queues the rest. */
export type KeyMode = "send" | "stop" | "queue" | "interrupt";
export function keyMode(turn: boolean, text: string, files: number): KeyMode {
  if (!turn) return "send";
  const bang = /^[!！]\s*/.exec(text.trim());
  const words = bang ? text.trim().slice(bang[0].length) : text.trim();
  if (!words && !files) return "stop";
  if (parseCommand(words)) return "send";
  return bang ? "interrupt" : "queue";
}

const DRAFT = (slot: string) => `draft:${slot}`;
/** What you typed to the slot and did not send, on this device (story 277); none where it cannot be read. */
export function draft(slot: string): string {
  try {
    return localStorage.getItem(DRAFT(slot)) ?? "";
  } catch {
    return "";
  }
}
/** Keeps text as the slot's draft, or, empty, lets it go; where it cannot be kept, it is not. */
export function keepDraft(slot: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT(slot), text);
    else localStorage.removeItem(DRAFT(slot));
  } catch {}
}

/** Says how the act went in a toast, with 撤销 when it can be undone. */
export const told = (r: RhReply) => (r.ok ? toast(r.text, false, r.undo) : toast(r.error, true));

/** The toasts, newest at the bottom, over what is at the bottom of the screen. Each goes when tapped. */
export function Toasts() {
  const list = useToasts();
  return (
    <div role="status" className="pointer-events-none absolute inset-x-0 bottom-full z-[60] mb-2 grid justify-items-center gap-2 px-4">
      {list.map((t) => (
        <ToastView key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastView({ t }: { t: Toast }) {
  // With 撤销, or an error, a bar along its foot shrinks smoothly as its 8 s go: one CSS animation,
  // which a toast drawn anew, on another page, starts as far along as it is (spec web-write "页面").
  const [delay] = useState(() => t.at - Date.now());
  return (
    <div className={cn("pointer-events-auto relative flex max-w-full items-center overflow-hidden rounded-lg border bg-popover text-sm text-popover-foreground shadow-md", t.error && "border-destructive/50 text-destructive")}>
      <button onClick={() => dismiss(t.id)} className="flex min-w-0 items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/5">
        {t.error ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 whitespace-pre-wrap wrap-anywhere">{t.text}</span>
      </button>
      {t.undo && (
        <button onClick={() => (dismiss(t.id), void act(t.undo!).then(told))} className="-my-px h-11 shrink-0 border-l px-3 font-medium text-running transition-colors hover:bg-foreground/5">
          撤销
        </button>
      )}
      {(t.undo || t.error) && <span aria-hidden className={cn("absolute inset-x-0 bottom-0 h-0.5 origin-left animate-undo", t.error ? "bg-destructive/60" : "bg-running/60")} style={{ animationDelay: `${delay}ms` }} />}
    </div>
  );
}

/** Sends acts as a button does (story 257): busy until the answer comes, which shows in a toast. */
export function useAct(): [busy: boolean, run: (a: BoardAct) => Promise<RhReply | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = async (a: BoardAct) => {
    if (busy) return;
    setBusy(true);
    const r = await act(a);
    setBusy(false);
    told(r);
    return r;
  };
  return [busy, run];
}

export const Spin = () => <LoaderCircle className="size-4 animate-spin" />;
/** The web terminal's spinner, over it till Herdr's first frame. */
export const Connecting = () => (
  <div aria-label="连接中" className="absolute inset-0 grid place-items-center text-neutral-400">
    <Spin />
  </div>
);

/** What storage keeps under key, or null; storage that cannot be used, as in some private windows, keeps none. */
export function kept(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}
/** Keeps value under key in storage; null, none. */
export function keep(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {}
}

/** Writes how far a scroller can still go left and right, up and down, how wide its upright bar is and
 *  how high the one under it, none where bars lie over what scrolls, for its edge-fade or edge-fade-y
 *  (index.css). */
const edges = (el: HTMLElement) => {
  el.style.setProperty("--os", `${el.scrollLeft}px`);
  el.style.setProperty("--oe", `${el.scrollWidth - el.clientWidth - el.scrollLeft}px`);
  el.style.setProperty("--ot", `${el.scrollTop}px`);
  el.style.setProperty("--ob", `${el.scrollHeight - el.clientHeight - el.scrollTop}px`);
  el.style.setProperty("--bar", `${el.offsetWidth - el.clientWidth}px`);
  el.style.setProperty("--under", `${el.offsetHeight - el.clientHeight}px`);
};
/** A scroller's ref and onScroll that keep its edge-fade up to date: on a scroll, and as the scroller or
 *  what it holds changes size, a line or a row still being written, a part swapped for another or
 *  opened included (#638); the scroller may come later than its component. A message box holds no
 *  element: it reads them again as its text changes. box: a ref that gets the scroller too. */
export function useEdges<T extends HTMLElement>(box?: RefObject<T | null>) {
  const ref = useCallback((el: T | null) => {
    if (box) box.current = el;
    if (!el) return;
    const sized = new ResizeObserver(() => edges(el));
    const watch = () => {
      sized.disconnect();
      for (const n of [el, ...el.children]) sized.observe(n);
    };
    const swapped = new MutationObserver(watch);
    swapped.observe(el, { childList: true });
    watch();
    return () => {
      sized.disconnect();
      swapped.disconnect();
      if (box) box.current = null;
    };
  }, []);
  return { ref, onScroll: (e: UIEvent<T>) => edges(e.currentTarget) };
}
/** A choice in a menu: its icon and what it says; on: the one now, ticked. */
export type Choice = { icon?: LucideIcon; label: string; on?: boolean; run: () => void };

/** The menu's choices, each a 44px row, under head. */
function Choices({ choices, head, back }: { choices: Choice[]; head?: ReactNode; back?: RefObject<HTMLElement | null> }) {
  return (
    // Not back on what opened it once closed: 改名 puts the focus in the title. back: where it goes instead.
    <Menu.Popup finalFocus={back ?? false} className="min-w-44 rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
      {head}
      {choices.map((c) => (
        <Menu.Item key={c.label} onClick={c.run} className="flex h-11 cursor-default items-center gap-2.5 rounded-lg px-3 outline-none select-none data-highlighted:bg-muted">
          {c.icon && <c.icon className="size-4 shrink-0 text-muted-foreground" />}
          {c.label}
          {c.on && <Check aria-label="现在" className="ml-auto size-4 shrink-0 text-running" />}
        </Menu.Item>
      ))}
    </Menu.Popup>
  );
}

/** A button that opens a menu of choices, over it or under it, head above them. label: the button's, for screen readers. */
export function Pick({ label, choices, head, side = "bottom", disabled, className, children }: { label: string; choices: Choice[]; head?: ReactNode; side?: "top" | "bottom"; disabled?: boolean; className?: string; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} disabled={disabled} className={className}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} align="end" sideOffset={4} collisionPadding={8} className="z-[70]">
          <Choices choices={choices} head={head} />
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The same menu where the pointer is, as a right click opens one; null: closed. back: where the focus goes once closed. */
export function MenuAt({ at, close, choices, back }: { at: { x: number; y: number } | null; close: () => void; choices: Choice[]; back?: RefObject<HTMLElement | null> }) {
  const anchor = at && { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) };
  return (
    <Menu.Root open={at !== null} onOpenChange={(open) => !open && close()}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" collisionPadding={8} className="z-[70]">
          <Choices choices={choices} back={back} />
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The terminal key (story 265): the slot goes to the terminal, Herdr's focus with it, as /rh_tui from
 *  IM. It asks first, in a dialog as 收回终端's (story 476): the slot leaves IM and the web for the
 *  terminal, a slip of the thumb away. 切换 is where 跑完再切 is while a turn runs, the same act, and
 *  cutting the turn short a row under them: a turn starting as you press puts nothing under your
 *  finger that you did not mean. slot: its id. With children, a button opens the dialog; without, open
 *  and onOpenChange do, as from a menu. */
export function ToTerminal({ slot, turn, className, children, open, onOpenChange }: { slot: string; turn: boolean; className?: string; children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [busy, run] = useAct();
  const go = (cut: boolean) => void run(toTerminal(slot, cut));
  return (
    <AlertDialog.Root {...(onOpenChange && { open, onOpenChange })}>
      {children && (
        <AlertDialog.Trigger aria-label="切到终端" disabled={busy} className={className}>
          {busy ? <Spin /> : children}
        </AlertDialog.Trigger>
      )}
      <Asks title="切到终端？">
        <AlertDialog.Close className={buttonVariants({ variant: "outline", size: "lg" })}>取消</AlertDialog.Close>
        <AlertDialog.Close onClick={() => go(false)} className={buttonVariants({ size: "lg" })}>
          {turn ? "跑完再切" : "切换"}
        </AlertDialog.Close>
        {turn && (
          <AlertDialog.Close onClick={() => go(true)} className={buttonVariants({ variant: "destructive", size: "lg", className: "col-span-2" })}>
            打断，马上切
          </AlertDialog.Close>
        )}
      </Asks>
    </AlertDialog.Root>
  );
}

/** rh tui, cut: with !, cutting the turn under way short. */
export const toTerminal = (slot: string, cut = false): BoardAct => ({ kind: "rh", argv: ["tui", slot, ...(cut ? ["!"] : [])] });

/** 收回终端 (story 266): it ends the agent in your terminal, so it asks first, the one act that does
 *  (story 263); then, sure, the slot goes back to headless. slot: its id. With children, a button opens
 *  the dialog; without, open and onOpenChange do, as from a menu. onTaken: called as you are sure, say
 *  to show the chat over the agent quitting in the terminal (#372). */
export function TakeBack({ slot, className, children, open, onOpenChange, onTaken }: { slot: string; className?: string; children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; onTaken?: () => void }) {
  const [busy, run] = useAct();
  return (
    <AlertDialog.Root {...(onOpenChange && { open, onOpenChange })}>
      {children && (
        <AlertDialog.Trigger aria-label="收回终端" disabled={busy} className={className}>
          {busy ? <Spin /> : children}
        </AlertDialog.Trigger>
      )}
      <Asks title="收回终端？">
        <AlertDialog.Close className={buttonVariants({ variant: "outline", size: "lg" })}>取消</AlertDialog.Close>
        <AlertDialog.Close onClick={() => (onTaken?.(), void run({ kind: "rh", argv: ["release", slot], sure: true }))} className={buttonVariants({ size: "lg" })}>
          收回
        </AlertDialog.Close>
      </Asks>
    </AlertDialog.Root>
  );
}

/** 删除 (story 537): the slot cannot come back, so it asks first, in a dialog as 收回终端's; sure, it
 *  is gone, and its chat, open, goes with it (spec web-write "删除"): beside the list or the topology,
 *  or maximized, the chat closes; a phone's goes back to where it came from. name: its ref.
 *  Opened by open and onOpenChange, as from a menu. */
export function Remove({ slot, name, open, onOpenChange }: { slot: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [, run] = useAct();
  // Right after it opened from there (up), back, as a medium screen's 缩小: the topology keeps 显示已归档.
  const leave = () => {
    const at = location.hash.slice(1);
    if (chatAt(at, matchMedia(ROOM).matches) !== slot) return;
    const from = at.startsWith("/topology") || history.state?.up === "topology" ? "topology" : "list";
    history.state?.up === from ? history.back() : goHash(from === "list" ? "#/" : "#/topology", true);
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <Asks title={`删除 ${name}？`}>
        <AlertDialog.Close className={buttonVariants({ variant: "outline", size: "lg" })}>取消</AlertDialog.Close>
        <AlertDialog.Close onClick={() => void run({ kind: "rh", argv: ["rm", slot] }).then((r) => r?.ok && leave())} className={buttonVariants({ variant: "destructive", size: "lg" })}>
          删除
        </AlertDialog.Close>
      </Asks>
    </AlertDialog.Root>
  );
}

/** A headless slot's row's menu on the list and the sidebar (spec web-write "列表行的菜单", stories 535,
 *  550), at where the right click was; null: closed. A live one's are what its chat's 更多 and the bar
 *  under where you type do: 停止 while its turn runs, 开新对话, 改名, the name in its row turning into a
 *  box, 切到终端, asking first, unless 终端入口 is off or there is no Herdr, and 归档, its toast with 撤销; and, after 停止, 置顶 or 取消置顶 (#506). An
 *  archived one has 恢复 and 删除. */
export function RowMenu({ c, at, close }: { c: Card; at: { x: number; y: number } | null; close: () => void }) {
  const [, run] = useAct();
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const entry = useTerminalEntry();
  // In a turn, as inTurn has it, by the state the board names.
  const turn = ["启动中", "运行中", "需要你"].includes(c.state);
  const choices: Choice[] =
    c.archivedAt === null
      ? [
          ...(turn ? [{ icon: Square, label: "停止", run: () => void run({ kind: "common", slot: c.id, name: "stop" }) }] : []),
          c.pinnedAt === null ? { icon: Pin, label: "置顶", run: () => void run({ kind: "pin", slot: c.id, on: true }) } : { icon: PinOff, label: "取消置顶", run: () => void run({ kind: "pin", slot: c.id, on: false }) },
          { icon: SquarePen, label: "开新对话", run: () => void act({ kind: "common", slot: c.id, name: "new" }).then(told) },
          { icon: Pencil, label: "改名", run: () => setRenaming(true) },
          ...(entry ? [{ icon: SquareTerminal, label: "切到终端", run: () => setSwitching(true) }] : []),
          { icon: Archive, label: "归档", run: () => void run({ kind: "rh", argv: ["archive", c.id] }) },
        ]
      : [
          { icon: ArchiveRestore, label: "恢复", run: () => void run({ kind: "rh", argv: ["unarchive", c.id] }) },
          { icon: Trash2, label: "删除", run: () => setRemoving(true) },
        ];
  return (
    <>
      <MenuAt at={at} close={close} choices={choices} />
      {renaming && (
        // The row's own ground and corners over it, within its padding, so the workspace starts where its logo does
        // and the box ends where its state does (#647); the box the only frame, no wider than a name wants; the line
        // above stays.
        <div className="absolute inset-x-0 top-px bottom-0 z-10 flex items-center rounded-[inherit] bg-(--row) pr-(--pr) pl-(--pl) text-[15px] *:max-w-96">
          <Rename d={c} done={() => setRenaming(false)} />
        </div>
      )}
      <ToTerminal slot={c.id} turn={turn} open={switching} onOpenChange={setSwitching} />
      <Remove slot={c.id} name={c.ref} open={removing} onOpenChange={setRemoving} />
    </>
  );
}

/** The title as a box for the slot's new name (story 267), or a row's name (#491): Enter, or a tap
 *  elsewhere, renames it; Esc leaves it as it was. The workspace stays: a slot is renamed within it. */
export function Rename({ d, done }: { d: { id: string; ref: string }; done: () => void }) {
  const [busy, run] = useAct();
  const over = useRef(false); // sent or given up: the box's blur as it goes is not a second word
  const ws = d.ref.slice(0, d.ref.indexOf("/") + 1);
  const name = d.ref.slice(ws.length);
  const box = useRef<HTMLSpanElement>(null);
  // The workspace takes what the box leaves past the input's basis: whole, cut to two letters and the "…" at least, or none (#633).
  useLayoutEffect(() => {
    const el = box.current!;
    const part = el.firstElementChild as HTMLElement;
    const field = el.lastElementChild as HTMLInputElement;
    const input = getComputedStyle(field);
    const t = measure(part, 2);
    const fit = () => {
      // Measured uncut: WebKit measures a text it cut with the "…" only up to the cut.
      part.style.width = "";
      const w = cutOrNone(t, el.getBoundingClientRect().width - parseFloat(input.flexBasis) - parseFloat(input.marginLeft));
      part.style.width = w === undefined ? "" : `${w}px`;
    };
    // Still all picked, as it opened, the name from its start (#644): browsers show its end, and keep the scroll a resize leaves.
    const start = () => field.selectionStart === 0 && field.selectionEnd === field.value.length && (field.scrollLeft = 0);
    fit();
    const sized = new ResizeObserver(() => (fit(), start()));
    sized.observe(el);
    sized.observe(field);
    return () => sized.disconnect();
  }, [ws]);
  const end = async (value?: string) => {
    if (over.current) return;
    over.current = true;
    const to = value?.trim();
    if (to && to !== name) await run({ kind: "rh", argv: ["rename", d.id, to] });
    done();
  };
  return (
    <span ref={box} className="flex min-w-0 flex-1 items-center">
      <span className="flex-none truncate font-normal text-muted-foreground">{ws}</span>
      <input
        autoFocus
        aria-label="槽位名"
        defaultValue={name}
        disabled={busy}
        enterKeyHint="done"
        // All picked, backward: WebKit shows the end a selection is moving, so its start; Chromium shows its far end,
        // which start above takes back (#644).
        onFocus={(e) => e.currentTarget.setSelectionRange(0, e.currentTarget.value.length, "backward")}
        onKeyDown={(e) => {
          // An input method's Enter picks its word; Safari tells it by keyCode 229 alone.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") void end(e.currentTarget.value);
          else if (e.key === "Escape") void end();
        }}
        onBlur={(e) => void end(e.currentTarget.value)}
        // Its focus ring an outline inside its border, drawn over the picked name, whose ground is taller than the
        // ring leaves inside (#644): opaque, as ring/50 looks on the box's ground, and in that colour from the start,
        // whole at once.
        className="ml-0.5 h-6 min-w-16 flex-[1_1_6rem] rounded-md border bg-background px-1.5 font-semibold outline-[color-mix(in_oklab,var(--ring)_50%,var(--background))] transition-colors hover:border-ring/50 focus:outline-2 focus:-outline-offset-3"
      />
    </span>
  );
}

/** A dialog asking title, its buttons two a row under it. Placed by its top, a two-button one in the
 *  middle: a row it grows as a turn starts goes under the rest, which stay put (story 476). */
function Asks({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <AlertDialog.Popup className="fixed top-[calc(50%-3.5rem)] left-1/2 z-50 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg transition data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
        <AlertDialog.Title className="font-semibold">{title}</AlertDialog.Title>
        <div className="mt-4 grid grid-cols-2 gap-2">{children}</div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  );
}

/** An archived slot's restore button on the board (story 269): it is back, no chat pointing at it again. */
export function Restore({ slot, className }: { slot: string; className?: string }) {
  const [busy, run] = useAct();
  return (
    <button aria-label="恢复" disabled={busy} onClick={() => void run({ kind: "rh", argv: ["unarchive", slot] })} className={className}>
      {busy ? <Spin /> : <ArchiveRestore className="size-4.5" />}
    </button>
  );
}

const KEYS: Record<KeyMode, [label: string, icon: ReactNode]> = {
  send: ["发送", <ArrowUp className="size-4.5" />],
  stop: ["停止", <Square className="size-3.5 fill-current" />],
  queue: ["排队", <ListPlus className="size-4.5" />],
  interrupt: ["打断再发", <Zap className="size-4" />],
};

/** The round key at the right of the bar (story 282): its icon says what it does now; busy, it spins
 *  and takes no press (story 257). A 44px tap. */
export function Key({ mode, busy, idle = false, onClick, onContextMenu, className }: { mode: KeyMode; busy: boolean; idle?: boolean; onClick: () => void; onContextMenu?: (e: MouseEvent) => void; className?: string }) {
  const [label, icon] = KEYS[mode];
  return (
    <button aria-label={label} disabled={busy} aria-disabled={idle || undefined} onClick={idle ? undefined : onClick} onContextMenu={onContextMenu} className={cn("group focus-child grid size-11 shrink-0 place-items-center", className)}>
      <span className={cn("grid size-9 place-items-center rounded-full transition-colors", idle ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground group-enabled:group-hover:bg-primary/80")}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      </span>
    </button>
  );
}

/** Runs a command typed into the slot's chat, as IM does (story 298); /resume with a word, its list
 *  narrowed to the conversations that have it (story 301), or, with none, as IM takes the word: the
 *  start of a conversation's id. */
async function command(slot: string, words: string): Promise<RhReply> {
  const word = /^\/resume\s+(\S.*)$/s.exec(words)?.[1]!.toLowerCase();
  if (!word) return act({ kind: "say", slot, text: words });
  const r = await act({ kind: "say", slot, text: "/resume" });
  const keep = r.ok && r.panel?.candidates.filter((c) => `${c.label} ${c.command}`.toLowerCase().includes(word));
  return keep && keep.length ? { ...r, panel: { ...r.panel!, candidates: keep } } : act({ kind: "say", slot, text: words });
}

/** Where a command's answer shows (spec info-commands "网页"): a query's, drawn from its data, and what
 *  to pick from in the info card; the rest, an action's receipt or an error, in a toast, however many
 *  lines it has (stories 387, 390, 391). */
export const frame = (r: RhReply): "card" | "toast" => (r.ok && (r.card || r.panel) ? "card" : "toast");

/** What the page does itself for a command typed or picked: /rh_agent alone opens the bar's agent
 *  sheet, /model, /effort or /ultracode alone its model sheet, as their buttons do (story 297), but
 *  /ultracode on an agent without it, as pi, goes as typed (story 413); /rh_ls takes you to the list, /rh_help
 *  brings up the commands (story 412). null: it goes as typed. */
export function byPage(words: string, agent: AgentKind | null): "agent" | "model" | "ls" | "help" | null {
  const w = words.trim();
  if (/^\/rh_ls(\s|$)/.test(w)) return "ls";
  if (/^\/rh_help(\s|$)/.test(w)) return "help";
  const name = /^\/(rh_agent|model|effort|ultracode)$/.exec(w)?.[1];
  return !name || (name === "ultracode" && agent !== null && !AGENTS[agent].ultracode) ? null : name === "rh_agent" ? "agent" : "model";
}

/** Where you type to each slot shown, told words to put after what is there. */
const boxes = new Set<(slot: string, words: string) => boolean>();
/** Where you type to each slot shown, as it takes files dropped on its chat. */
const drops = new Set<(slot: string, files: File[]) => void>();

/** Where you type to each slot shown, as it takes a reply you quote. */
const quoters = new Set<(slot: string, reply: string) => void>();

/** Files dropped on slot's chat (#286): attached where you type to it, as + attaches them. */
export const attach = (slot: string, files: File[]) => drops.forEach((f) => f(slot, files));
/** Quotes reply where you type to slot (story 573), in place of the one quoted before. */
export const quote = (slot: string, reply: string) => quoters.forEach((f) => f(slot, reply));
/** What is attached to each slot and not sent, kept as its draft is (#582): for the page's life, as a
 *  File cannot go in storage. */
const unsentFiles = new Map<string, File[]>();
/** The reply each slot quotes and has not sent (story 573), kept as what it attaches is. */
const unsentQuotes = new Map<string, string>();
/** Puts words and files back where you type to the slot, after what is there: in its box, if shown, else
 *  its draft and what it keeps attached. */
function putBack(slot: string, words: string, files: File[] = []): void {
  let shown = false;
  for (const f of boxes) shown = f(slot, words) || shown;
  if (shown) return void (files.length && attach(slot, files));
  keepDraft(slot, [draft(slot), words].filter(Boolean).join("\n"));
  if (files.length) unsentFiles.set(slot, [...(unsentFiles.get(slot) ?? []), ...files]);
}

/** One of your messages queued on the board that Rhodium gave back, say as the slot went to the
 *  terminal (story 287): its words go back where you type, and a toast says why. */
export function givenBack(slot: string, words: string, why: string): void {
  putBack(slot, words);
  toast(`${why}，排着的话放回了输入框。`);
}

/** The stop key alone (story 264), as on the top ask's card: it stops the slot's turn, the agent kept,
 *  as /stop does. */
export function StopKey({ slot, className }: { slot: string; className?: string }) {
  const [busy, run] = useAct();
  return <Key mode="stop" busy={busy} onClick={() => run({ kind: "common", slot, name: "stop" })} className={className} />;
}

/** A command's answer the info card shows, with the command said. */
type Shown = Extract<RhReply, { ok: true }> & { said: string };

/** The most a message may carry attached, as POST /api/send takes, and Telegram's bots. */
const MAX_FILES = 20 << 20;

/** Where you type to the slot, at the bottom of its chat (spec web-write "页面"): words over many lines,
 *  sent with the key, or Ctrl+Enter, or Enter as picked from the key's menu (story 511); pictures and
 *  files attached with +, each to drop before it goes.
 *  What you type is kept as the slot's draft till sent (story 277), and what you attach, till sent or
 *  dropped, for the page's life (#582). Sent, your words show at once
 *  (story 273), unless Rhodium runs them, whose answer shows as frame() has it: the info card is over
 *  where you type, which still takes words (story 389). / at the start brings up the slot's commands (story 294). With a turn under way and nothing
 *  typed, the key stops it (story 264). The bar under it has the agent's logo and the model with its
 *  thinking level (agent, model, effort), ultracode marked where on, each opening its sheet (stories 302-304), as /rh_agent and
 *  /model do, picked or typed alone, and closing it tapped again (story 519); then, switchable, the terminal key (story 265). A slot archived has
 *  none of the three, as the model sheet's /model and /effort on opening would bring it back. changed: what the chat shows has changed. */
export function Composer({ slot, turn, archived, switchable, log, changed, commands, agent, model, effort, ultracode }: { slot: string; turn: boolean; archived: boolean; switchable: boolean; log: Messages; changed: () => void; commands: Command[]; agent: AgentKind | null; model: string | null; effort: string | null; ultracode: boolean }) {
  const [text, setText] = useState(() => draft(slot));
  const [files, setFiles] = useState<File[]>(() => unsentFiles.get(slot) ?? []);
  useEffect(() => void (files.length ? unsentFiles.set(slot, files) : unsentFiles.delete(slot)), [slot, files]);
  // The reply you quote (story 573), over what you type till you send words for the agent.
  const [quoted, setQuoted] = useState<string | null>(() => unsentQuotes.get(slot) ?? null);
  useEffect(() => void (quoted === null ? unsentQuotes.delete(slot) : unsentQuotes.set(slot, quoted)), [slot, quoted]);
  const [busy, setBusy] = useState(false);
  // The palette: the command ↑↓ are on, and what was typed when Esc closed it, till you type on.
  const [at, setAt] = useState(0);
  const [shut, setShut] = useState<string | null>(null);
  // The info card open: a command's answer, with the command said, or one of the bar's sheets.
  const [shown, setShown] = useState<Shown | "agent" | "model" | null>(null);
  // Whether Enter sends, as picked on this device from the send key's menu (story 511), and where that menu is open.
  const [enterSends, setEnterSends] = useState(() => kept(() => localStorage, "send-key") === "enter");
  const [keysAt, setKeysAt] = useState<{ x: number; y: number } | null>(null);
  const sendBy = (enter: boolean) => (setEnterSends(enter), keep(() => localStorage, "send-key", enter ? "enter" : null));
  const reply = typeof shown === "object" ? shown : null;
  const [, navigate] = useLocation();
  const max = useContext(Max);
  const send = (text: string) => act({ kind: "say", slot, text });
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const edged = useEdges(box);
  const type = (t: string) => (setText(t), keepDraft(slot, t), setAt(0), setShut(null));
  const list = /^\/\S*$/.test(text) && text !== shut ? matching(commands, text.slice(1)) : [];
  const empty = !text.trim() && !files.length;
  const mode = keyMode(turn, text, files.length);
  const stop = turn && empty;
  // At its full height, text written in grows it no more and, away from the caret, scrolls it not:
  // its fade is read again as the text changes (#579).
  useLayoutEffect(() => edges(box.current!), [text]);
  // Words given back or taken from the queue to edit go after what is here.
  const current = useRef(text);
  current.current = text;
  // A slot opened on a computer, the caret is here (story 443); a phone would bring up its keyboard.
  useEffect(() => void (matchMedia("(pointer: fine)").matches && box.current?.focus({ preventScroll: true })), []);
  useEffect(() => {
    const f = (s: string, words: string) => s === slot && (type([current.current, words].filter(Boolean).join("\n")), true);
    const dropped = (s: string, more: File[]) => s === slot && setFiles((files) => [...files, ...more]);
    const quoter = (s: string, reply: string) => s === slot && (setQuoted(reply), box.current?.focus());
    boxes.add(f);
    drops.add(dropped);
    quoters.add(quoter);
    return () => (boxes.delete(f), drops.delete(dropped), void quoters.delete(quoter));
  }, [slot]);
  /** A command's answer, where frame() puts it: in the card, in place of what it had; a toast closes
   *  the card it was picked from, if that is still the one open. */
  const show = (r: RhReply, said: string, from?: Shown) => {
    if (r.ok && frame(r) === "card") return setShown({ ...r, said });
    if (from) setShown((open) => (open === from ? null : open));
    toast(r.ok ? r.text : r.error, !r.ok);
  };
  /** Opens the bar's sheet p, or, tapped on its button again, closes it (story 519). On a touch screen
   *  the keyboard goes first, which would push the sheet's top off the screen (story 522). */
  const sheet = (p: "agent" | "model", again = false) => {
    if (matchMedia("(pointer: coarse)").matches) box.current?.blur();
    setShown((s) => (again && s === p ? null : p));
  };
  /** Does what the page does itself for words (byPage), and says whether there was any. */
  const own = (words: string) => {
    const p = byPage(words, agent);
    if (p === "agent" || p === "model") sheet(p);
    else if (p === "help") (type("/"), box.current?.focus());
    // On a wide screen the list goes beside the chat; on a phone, in its place; in maximize mode the
    // sidebar is there already, expanded first if collapsed.
    else if (p === "ls") (max?.collapsed && max.toggle(), flash(slot), max?.full || navigate(matchMedia("(min-width: 64rem)").matches ? `/slot/${encodeURIComponent(slot)}` : "/"));
    return p !== null;
  };
  /** A command from the card, tapped or picked: one the page does itself it does, as /status's 换模型
   *  opens the model sheet; the rest go as typed. */
  const run = async (command: string, from: Shown) => void (own(command) || show(await send(command), command, from));
  /** Picked from the card: its command goes as run() has it; one that wants you to write the rest puts it where you type. */
  const choose = async (c: Candidate, from: Shown) => {
    if (c.fill === undefined) return run(c.command, from);
    setShown(null);
    type(c.fill);
    box.current?.focus();
  };
  /** Picked from the palette (story 297): one the page does itself it does; the rest go as typed. */
  const pick = (c: Command) => (byPage(`/${c.name}`, agent) ? (type(""), own(`/${c.name}`)) : void go(`/${c.name}`));
  const halt = async () => {
    setBusy(true);
    const r = await act({ kind: "common", slot, name: "stop" });
    setBusy(false);
    toast(r.ok ? r.text : r.error, !r.ok);
  };
  const go = async (typed = text) => {
    if (busy || (empty && !stop)) return;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_FILES) return toast("附件一次最多 20MB。", true);
    if (stop) return halt();
    // Queued, it shows in the queue rather than as a bubble (story 283).
    const queued = keyMode(turn, typed, files.length) === "queue";
    // Words for the agent go under the reply you quote, which then goes; a command leaves it.
    const words = quoted === null ? typed.trim() : withQuote(quoted, typed.trim(), files.length);
    if (words !== typed.trim()) setQuoted(null);
    const shown = queued ? null : forAgent(words, files.length);
    const s: Sent = { id: crypto.randomUUID(), text: shown ?? "", words, files, from: log.end };
    if (shown !== null) log.sent.push(s);
    type("");
    setFiles([]);
    changed();
    // A command keeps nothing busy: what the agent answers may take long, as /compact does, or never
    // come, as when the slot moves on meanwhile. Its answer shows as show() has it; turned away, it goes
    // back where you typed it, unless you typed or attached something else meanwhile.
    if (shown === null && !queued) {
      if (!files.length && own(words)) return;
      const r = await (files.length ? say(slot, s) : command(slot, words));
      show(r, words);
      // The slot's draft and attachments, not this box's: switched away and back, you type in another.
      if (!r.ok && !draft(slot).trim() && !unsentFiles.has(slot)) putBack(slot, words, files);
      return;
    }
    // A message says how it went where it shows, red to try again. Queued, the queue shows it; turned
    // away, nothing else has it: it goes back after what you typed since. The first from this device
    // asks, in its gesture, for leave to remind you as turns end.
    askOnce();
    setBusy(true);
    const r = await say(slot, s);
    setBusy(false);
    if (shown !== null) s.failed = r.ok ? undefined : r.error;
    else if (!r.ok) (toast(r.error, true), putBack(slot, words, files));
    changed();
  };
  return (
    <div className="px-3 pt-1 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      {reply?.card && <InfoCard card={reply.card} close={() => setShown(null)} run={(c) => run(c, reply)} />}
      {reply?.panel && <Answer r={reply} name={/^\/(\S+)/.exec(reply.said)?.[1] ?? ""} close={() => setShown(null)} pick={(c) => choose(c, reply)} />}
      {agent && <AgentSheet open={shown === "agent"} close={() => setShown((s) => (s === "agent" ? null : s))} agent={agent} turn={turn} send={send} />}
      {/* With a mouse its search box took the keyboard: closed, the caret is back where you type. */}
      <ModelSheet open={shown === "model"} close={() => (setShown((s) => (s === "model" ? null : s)), matchMedia("(pointer: fine)").matches && box.current?.focus())} send={send} />
      <div className="relative mx-auto max-w-3xl rounded-3xl border bg-card shadow-xs">
        {list.length > 0 && <Palette list={list} at={Math.min(at, list.length - 1)} pick={pick} point={setAt} />}
        {quoted !== null && (
          <div className="flex items-center gap-1.5 pt-1.5 pl-4 text-sm text-muted-foreground">
            <Quote className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">引用：{plain(quoted)}</span>
            <button aria-label="取消引用" onClick={() => setQuoted(null)} className="hover-round -my-1.5 grid size-11 shrink-0 place-items-center hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        )}
        {files.length > 0 && <Attached files={files} drop={(i) => setFiles(files.filter((_, j) => j !== i))} />}
        <textarea
          aria-label="消息"
          placeholder="发消息"
          rows={1}
          value={text}
          onChange={(e) => type(e.target.value)}
          // A picture or file pasted is attached (#286); words, even with a picture of them as from a
          // spreadsheet, are words.
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length || e.clipboardData.getData("text/plain")) return;
            e.preventDefault();
            setFiles((files) => [...files, ...pasted]);
          }}
          {...edged}
          onKeyDown={(e) => {
            // The palette open (story 296): ↑↓ move, Enter or Tab picks, Esc closes. Not while an input
            // method still composes what you type: its Enter takes the word, its Esc ends the composing.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            const move = list.length && { ArrowDown: 1, ArrowUp: -1 }[e.key];
            if (move) setAt((Math.min(at, list.length - 1) + move + list.length) % list.length);
            else if (list.length && !e.ctrlKey && !e.metaKey && (e.key === "Enter" || e.key === "Tab")) pick(list[Math.min(at, list.length - 1)]!);
            else if (list.length && e.key === "Escape") setShut(text);
            else if (e.key === "Escape" && shown) setShown(null);
            // With Enter to send (story 511), Ctrl or ⌘ with it makes a new line, which a browser does not do
            // itself; Shift's it does. Enter in an empty box does nothing: it would stop the turn under way.
            else if (e.key === "Enter" && enterSends && (e.ctrlKey || e.metaKey)) document.execCommand("insertText", false, "\n");
            else if (e.key === "Enter" && enterSends && !e.shiftKey && !e.altKey) void (empty || go());
            else if (e.key === "Enter" && !enterSends && (e.ctrlKey || e.metaKey)) void go();
            // On a keyboard, Esc stops the turn (story 288).
            else if (e.key === "Escape" && turn && !busy) void halt();
            else return;
            e.preventDefault();
          }}
          className="card-scroll edge-fade-y block max-h-[40dvh] scroll-py-8 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <div className="flex min-w-0 items-center px-1 pb-1">
          {agent && !archived && (
            <>
              <button aria-label="换 agent" aria-expanded={shown === "agent"} onClick={() => sheet("agent", true)} className="hover-round grid size-11 shrink-0 place-items-center">
                <AgentLogo agent={agent} className="size-5" />
              </button>
              <button aria-label="模型和思考强度" aria-expanded={shown === "model"} onClick={() => sheet("model", true)} className="flex h-11 min-w-0 items-center gap-1 rounded-full pr-2 pl-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-6 focus-visible:outline-ring">
                <span className="truncate">
                  <ModelName name={model ?? "默认"} />
                </span>
                {effort && <span className="shrink-0">{effort}</span>}
                {ultracode && <Workflow aria-label="ultracode" className="size-3.5 shrink-0" />}
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </>
          )}
          {switchable && (
            <ToTerminal slot={slot} turn={turn} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-50">
              <SquareTerminal className="size-5" />
            </ToTerminal>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setFiles([...files, ...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <button aria-label="添加图片或文件" onClick={() => picker.current?.click()} className="hover-round ml-auto grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
            <Plus className="size-5" />
          </button>
          <Key mode={mode} busy={busy} idle={empty && !stop} onClick={() => void go()} onContextMenu={(e) => (e.preventDefault(), setKeysAt({ x: e.clientX, y: e.clientY }))} />
          {/* Closed, the caret is back in the box: the right click left it on the key, where Enter would press it. */}
          <MenuAt
            at={keysAt}
            back={box}
            close={() => setKeysAt(null)}
            choices={[
              { label: MAC ? "⌘ Enter 发送" : "Ctrl+Enter 发送", on: !enterSends, run: () => sendBy(false) },
              { label: "Enter 发送", on: enterSends, run: () => sendBy(true) },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/** Why one Rhodium holds for you waits (story 286). */
const HELD: Partial<Record<SlotData["queue"][number]["reason"], string>> = { after_interrupt: "等打断生效", after_quota: "等额度", stopping: "正在停止" };

/** The queue above where you type (spec web-write "待发队列", stories 283-286): how many wait, and once a
 *  stop paused them, a pause sign and 继续. Each a line: 插话 sends it in now (发送, paused), 编辑 takes it
 *  back where you type, 删除 takes it off. One with files has no 编辑: they cannot go back. One Rhodium
 *  holds for you can only be taken off, why under it. Three lines high, then it scrolls, faded where cut
 *  (#579). Only what goes wrong is said: the queue itself shows what went right. */
export function Queue({ slot, queue }: { slot: string; queue: SlotData["queue"] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const scroller = useEdges<HTMLDivElement>();
  const run = async (key: string, a: Omit<Extract<BoardAct, { kind: "queued" }>, "kind" | "slot">, then?: () => void) => {
    if (busy) return;
    setBusy(key);
    const r = await act({ kind: "queued", slot, ...a });
    setBusy(null);
    if (r.ok) then?.();
    else toast(r.error, true);
  };
  const paused = queue.some((q) => q.reason === "web_paused");
  const button = (key: string, label: string, icon: ReactNode, press: () => void) => (
    <button key={label} aria-label={label} disabled={busy !== null} onClick={press} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
      {busy === key ? <LoaderCircle className="size-4 animate-spin" /> : icon}
    </button>
  );
  return (
    <section aria-label="待发队列" className="px-3 pt-1">
      <div className="mx-auto max-w-3xl rounded-2xl border bg-card text-sm shadow-xs">
        <div className="flex h-9 items-center gap-1.5 border-b pl-3 text-muted-foreground">
          <span role="img" aria-label={paused ? "暂停了" : "排着"}>
            {paused ? <Pause className="size-4" /> : <List className="size-4" />}
          </span>
          <span className="tabular-nums">{queue.length}</span>
          {paused && <span className="ml-auto">{button("go", "继续", <Play className="size-4" />, () => void run("go", { op: "now" }))}</span>}
        </div>
        {/* The line over it is the head's: the fade would take it. */}
        <div {...scroller} className="card-scroll edge-fade-y max-h-[8.25rem] scroll-py-8 overflow-y-auto">
          <ul>
            {queue.map((q) => {
              const held = HELD[q.reason];
              // Under a quote, your words, so two quoting the same are told apart; the quote's, with none.
              const quoted = quoteOf(q.text);
              return (
                <li key={q.id} className="flex min-h-11 items-center pl-3">
                  {q.files > 0 && (
                    <span role="img" aria-label="附件" className="mr-1.5 shrink-0 text-muted-foreground">
                      <Paperclip className="size-3.5" />
                    </span>
                  )}
                  {quoted && (
                    <span role="img" aria-label="引用" className="mr-1.5 shrink-0 text-muted-foreground">
                      <Quote className="size-3.5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1 py-1">
                    <p className="truncate">{quoted ? quoted.rest.trim() || plain(quoted.quote) : q.text}</p>
                    {held && <p className="text-xs text-muted-foreground">{held}</p>}
                  </div>
                  {!held &&
                    (q.reason === "web_paused"
                      ? button(`${q.id} now`, "发送", <ArrowUp className="size-4" />, () => void run(`${q.id} now`, { op: "now", input: q.id }))
                      : button(`${q.id} now`, "插话", <CornerUpRight className="size-4" />, () => void run(`${q.id} now`, { op: "now", input: q.id })))}
                  {/* With files, a gap where 编辑 goes keeps the buttons in their columns. */}
                  {!held &&
                    (q.files ? <span className="size-11 shrink-0" /> : button(`${q.id} edit`, "编辑", <Pencil className="size-4" />, () => void run(`${q.id} edit`, { op: "drop", input: q.id }, () => putBack(slot, q.text))))}
                  {button(`${q.id} drop`, "删除", <X className="size-4" />, () => void run(`${q.id} drop`, { op: "drop", input: q.id }))}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** What you attached, over where you type, lined up with the words (#577): past the box's edge it
 *  scrolls, its edges faded as an unwrapped code block's are, its bar's thumb lined up too (13px of
 *  track and its 3px clear border, the list's 16px). drop: the i-th let go. */
function Attached({ files, drop }: { files: File[]; drop: (i: number) => void }) {
  const scroller = useEdges<HTMLDivElement>();
  return (
    <div {...scroller} className="card-scroll edge-fade overflow-x-auto [--track-x:0.8125rem]">
      <ul aria-label="附件" className="flex w-max gap-2 px-4 pt-3">
        {files.map((f, i) => (
          <li key={`${i} ${f.name}`} className="relative shrink-0 pt-1.5 pr-1.5">
            {f.type.startsWith("image/") ? (
              <Thumb file={f} className="size-14 rounded-lg border object-cover" />
            ) : (
              <span className="flex h-14 w-32 items-center gap-1.5 rounded-lg border bg-muted px-2 text-xs">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="line-clamp-2 wrap-anywhere">{f.name}</span>
              </span>
            )}
            <button aria-label="移除" onClick={() => drop(i)} className="absolute top-0 right-0 grid size-6 place-items-center rounded-full border bg-background shadow-xs transition-colors hover:bg-muted">
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the chat shows as a picture, known by its first bytes (board's media); the rest as a file. */
const PICTURES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A picture you attached. */
function Thumb({ file, className }: { file: File; className: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return <img src={url} alt={file.name} className={className} />;
}

/** A message you sent from here that the transcript has yet to bring (story 273): yours, faint, as one
 *  typed in the terminal is (story 280). Not taken: red, why under it, with a retry under the same id,
 *  and a way to let it go, beside why. */
export function Pending({ s, slot, log, changed }: { s: Sent; slot: string; log: Messages; changed: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    const r = await say(slot, s);
    setBusy(false);
    s.failed = r.ok ? undefined : r.error;
    changed();
  };
  const red = s.failed !== undefined && "border-destructive";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] justify-items-end gap-1 pl-10">
      {/* As the chat draws it once the transcript brings it (Said, Carried), so it does not jump then:
          what it carried over its words, a picture as big as its preview will be. */}
      <div className="flex max-w-full items-start gap-2">
        <div className={cn("grid min-w-0 justify-items-end gap-1.5", s.failed === undefined && "opacity-60")}>
          {s.files.length > 0 && (
            <div className="grid grid-cols-[minmax(0,auto)] justify-items-end gap-1.5">
              {s.files.map((f, i) =>
                PICTURES.includes(f.type) ? (
                  <Thumb key={i} file={f} className={cn("block max-h-[min(60dvh,800px)] max-w-[min(100%,800px)] rounded-xl border bg-muted", red)} />
                ) : (
                  <FileRow key={i} name={f.name} className={red} />
                ),
              )}
            </div>
          )}
          {s.text && (
            <div className={cn("min-w-0 rounded-2xl rounded-tr-sm border bg-muted px-3 py-2", red)}>
              <Words text={s.text} />
            </div>
          )}
        </div>
      </div>
      {/* Under it, not beside it, so a long one keeps its width on a phone; pulled out by the
          buttons' padding, so the retry icon sits on the bubble's right edge. */}
      {s.failed !== undefined && (
        <div className="-mr-3.5 flex items-center">
          {s.failed && <p className="text-right text-xs text-destructive">{s.failed}</p>}
          <button aria-label="不发了" onClick={() => ((log.sent = log.sent.filter((x) => x !== s)), changed())} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
          <button aria-label="重试" disabled={busy} onClick={() => void retry()} className="hover-round grid size-11 shrink-0 place-items-center text-destructive">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
