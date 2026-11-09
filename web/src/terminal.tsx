// A slot's pane in the terminal (spec web-terminal): the board passes Herdr's frames of it over a
// WebSocket, and ghostty-web draws them as Herdr's own Ghostty does (ADR-0012). The chat loads this,
// and ghostty-web with it, only for a slot in the terminal.
import { FitAddon, init, Terminal } from "ghostty-web";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Connecting, Key } from "./write";
import { loginHolds, refresh } from "./data";
// ⏴–⏺, Claude's ⏵⏵ of its mode line and ⏸ of plan mode, which no Android font has as text: Noto Sans
// Symbols 2 v2.008's (SIL OFL 1.1; its notice is in the font and the licence in full in NOTICE.md), cut to them: python3 -m fontTools.subset
// NotoSansSymbols2-Regular.ttf --unicodes=U+23F4-23FA --flavor=woff2 --no-hinting --name-IDs=0,1,2,3,4,5,6,13,14
import glyphs from "./terminal-glyphs.woff2?inline";

/** The system's monospace, which has the CJK fallbacks; after it, ours for what no font has (spec
 *  web-terminal "尺寸和字号"). */
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace, "Rhodium Glyphs"';
// Dark, as the agents draw for: the page's own dark background.
const THEME = { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#e5e5e5", selectionBackground: "#404040" };

/** text cut into what goes in {"t":"in","d":…} frames of 64KB at most as sent, the most the board
 *  takes (spec web-terminal "页面发来的消息"), in order, no character cut in two. */
export function cut(text: string): string[] {
  const parts: string[] = [];
  const room = 64 * 1024 - '{"t":"in","d":""}'.length;
  let part = "";
  let size = 0;
  for (const ch of text) {
    // As JSON writes it: an escape, so many bytes; else its UTF-8.
    const escaped = JSON.stringify(ch).length - 2;
    const cp = ch.codePointAt(0)!;
    const n = escaped > ch.length ? escaped : cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (size + n > room) (parts.push(part), (part = ""), (size = 0));
    part += ch;
    size += n;
  }
  if (part) parts.push(part);
  return parts;
}

/** Words as one paste, which Claude and pi both take, its lines no Enter each: Herdr's frames carry
 *  not the pane's modes (measured 2026-10-26), so the page cannot tell. The cursor keys go as plain,
 *  not application, ones for the same reason. */
const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;

/** The keys over a phone's box (story 348), each pressed as on a keyboard: ghostty-web encodes it. */
const KEYS: { label: string; face: ReactNode; key: KeyboardEventInit }[] = [
  { label: "Esc", face: "Esc", key: { key: "Escape", code: "Escape" } },
  { label: "Tab", face: "Tab", key: { key: "Tab", code: "Tab" } },
  { label: "Shift+Tab", face: "⇧Tab", key: { key: "Tab", code: "Tab", shiftKey: true } },
  { label: "Ctrl+C", face: "^C", key: { key: "c", code: "KeyC", ctrlKey: true } },
  { label: "上", face: <ArrowUp className="size-4" />, key: { key: "ArrowUp", code: "ArrowUp" } },
  { label: "下", face: <ArrowDown className="size-4" />, key: { key: "ArrowDown", code: "ArrowDown" } },
  { label: "左", face: <ArrowLeft className="size-4" />, key: { key: "ArrowLeft", code: "ArrowLeft" } },
  { label: "右", face: <ArrowRight className="size-4" />, key: { key: "ArrowRight", code: "ArrowRight" } },
  { label: "回车", face: <CornerDownLeft className="size-4" />, key: { key: "Enter", code: "Enter" } },
];

let loading: Promise<void> | undefined;
/** ghostty-web's WebAssembly and our glyphs, before the terminal draws, loaded once; a load that failed
 *  is tried again next time. */
const loaded = () =>
  (loading ??= Promise.all([init(), new FontFace("Rhodium Glyphs", `url(${glyphs})`).load().then((f) => void document.fonts.add(f))]).then(
    () => undefined,
    (err) => ((loading = undefined), Promise.reject(err)),
  ));

/** ghostty-web 0.4.0 draws every animation frame, idle or not. Its loop stopped, the terminal is drawn
 *  once for each frame that comes, a scroll or a selection, as herdr-web does (suspendGhosttyIdleRenderLoop);
 *  never while hidden, what came meanwhile drawn as it shows again. */
function drawnOnDemand(term: Terminal, hidden: () => boolean): () => void {
  const t = term as unknown as { animationFrameId?: number; viewportY: number; selectionManager?: { requestRender(): void } };
  if (t.animationFrameId !== undefined) cancelAnimationFrame(t.animationFrameId);
  t.animationFrameId = undefined;
  let asked: number | null = null;
  const draw = () =>
    void (asked ??= requestAnimationFrame(() => {
      asked = null;
      if (hidden() || !term.renderer || !term.wasmTerm) return;
      term.renderer.render(term.wasmTerm, false, t.viewportY, term, 0);
      atCursor(term);
    }));
  if (t.selectionManager) t.selectionManager.requestRender = draw;
  term.onScroll(draw);
  return draw;
}

/** Puts term's box you type in at the pane's cursor, where an input method opens its window, and in
 *  front: ghostty-web leaves it fixed at the page's top-left, behind the terminal, after a right click.
 *  The words being made, wider than the room right of the cursor, grow it leftwards: past the
 *  terminal's right edge they scrolled the terminal sideways. */
function atCursor(term: Terminal) {
  const area = term.textarea!;
  const { width, height } = term.renderer!.getMetrics();
  const canvas = term.renderer!.getCanvas();
  const end = canvas.offsetLeft + canvas.offsetWidth;
  const left = Math.max(canvas.offsetLeft, Math.min(canvas.offsetLeft + term.buffer.active.cursorX * width, end - area.scrollWidth));
  Object.assign(area.style, { position: "absolute", zIndex: "", left: `${left}px`, top: `${canvas.offsetTop + term.buffer.active.cursorY * height}px`, maxWidth: `${end - left}px` });
}

/** The terminal's canvas, a pixel of it for each device pixel it covers (spec web-terminal "尺寸和字号").
 *  ghostty-web 0.4.0 reads devicePixelRatio once, as it opens, and gives its canvas floor(CSS px × it)
 *  pixels: at a fractional ratio (a 150% screen, a zoom) the browser stretches those over the device
 *  pixels the canvas covers, and the text blurs; after a zoom or a move to another screen, at the ratio
 *  it opened at. Here the canvas has a whole number of device pixels at the ratio as it is now, and its
 *  CSS size is those over the ratio, so the browser shows them one to one; a new ratio sizes it again. */
function sharp(term: Terminal, draw: () => void, signal: AbortSignal) {
  const r = term.renderer as unknown as {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    devicePixelRatio: number;
    metrics: { width: number; height: number };
    theme: { background: string };
    resize(cols: number, rows: number): void;
  };
  r.resize = (cols, rows) => {
    const { canvas, ctx } = r;
    const ratio = (r.devicePixelRatio = devicePixelRatio);
    const [w, h] = [cols * r.metrics.width, rows * r.metrics.height];
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
    ctx.scale(ratio, ratio);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = r.theme.background;
    ctx.fillRect(0, 0, w, h);
  };
  // A new ratio: at none till the next draw, which then sizes the canvas again and draws it whole. Sized
  // here instead, at a ratio its cells fit whole, as 2, ghostty-web would take it as drawn and draw only
  // what changed since.
  const watch = () =>
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => ((r.devicePixelRatio = 0), draw(), watch()), { once: true, signal });
  watch();
  r.resize(term.cols, term.rows);
}

/** The address of slot's terminal on the page's own host, wss: from an https: page; page, this page's;
 *  resume, not taking it over from another page open on it (spec web-terminal "一处在操作"). */
function address(slot: string, cols: number, rows: number, page: string, resume: boolean): string {
  const u = new URL(`api/terminal?slot=${encodeURIComponent(slot)}&cols=${cols}&rows=${rows}&page=${page}${resume ? "&resume=1" : ""}`, location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** What the page does as its terminal closes with code (spec web-terminal "关闭代码"): the slot left the
 *  terminal, as 4000 says, so it asks for the slot afresh and connects again if it is still there; open
 *  elsewhere (4001), it says so and waits; with why (4002), it says why and connects again; else it
 *  just connects again. */
export const afterClose = (code: number) => (code === 4000 ? "slot" : code === 4001 ? "elsewhere" : code === 4002 ? "why" : "again");

/** How long the page waits to connect again after tries since its last frame: none the first time, as
 *  after the board dropped a page that read too slowly; then 1 s, twice as long each time, 30 s at
 *  most, so a herdr that cannot reach its server is not asked on and on. */
export const retryIn = (tries: number) => (tries ? Math.min(500 * 2 ** tries, 30_000) : 0);

/** The pane of slot, filling the chat's 终端 under its top bar, at its size: its columns and rows go in
 *  the address, and again each time a turn of the phone, a wider window, the keyboard or the font size
 *  (font, px) changes them, 100 ms after. Not shown, behind the chat, it stays attached, neither
 *  measured nor drawn. A spinner till Herdr's first frame. Opening in front takes the pane over; open
 *  elsewhere after, it says so, and 在这里继续 takes it back. In the background it lets go, and back in
 *  front connects again, as it does after a close that is not 4001, but then leaves the pane to a page
 *  elsewhere (story 351). What you type in it, paste or press goes to the pane (story 346); a wheel or a
 *  swipe on it scrolls the pane (story 343), and a mouse's clicks go to it (story 357). A phone has a row of
 *  keys and a box under it (stories 347, 348). */
export default function TerminalView({ slot, font, shown }: { slot: string; font: number; shown: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const takeBack = useRef<() => void>(undefined);
  // The open terminal's, for a new font size and for showing again; the props as they are now.
  const open = useRef<{ term: Terminal; measure: () => void; draw: () => void }>(undefined);
  const now = useRef({ font, shown });
  const [live, setLive] = useState(false);
  const [text, setText] = useState("");
  const press = (key: KeyboardEventInit) => box.current?.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
  // The box's words as one paste, then Enter on its own: Claude's box tells a paste by its timing, and
  // takes an Enter right after it as a line of it, not as sending.
  const send = () => {
    open.current?.term.input(pasted(text), true);
    setTimeout(() => press({ key: "Enter", code: "Enter" }), 35);
    setText("");
  };
  useEffect(() => {
    let over = false;
    let ws: WebSocket | undefined;
    let term: Terminal | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    let elsewhere = false;
    // Which page it is, to the board: one resuming takes over its own connection the board has not seen drop.
    const page = Math.random().toString(36).slice(2);
    const stop = new AbortController();
    void loaded().then(() => {
      if (over) return;
      const t = (term = new Terminal({ fontSize: now.current.font, fontFamily: FONT, cursorBlink: false, theme: THEME, smoothScrollDuration: 0 }));
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(box.current!);
      // What you type goes into ghostty-web's hidden box, as a tap's always did, not into the terminal
      // made editable: that showed the browser's caret at its top-left, and the words an input method
      // was making at its bottom. Drawn, the box goes to the pane's cursor.
      box.current!.removeAttribute("contenteditable");
      box.current!.removeAttribute("tabindex");
      const area = t.textarea!;
      area.style.caretColor = "transparent";
      // A click on it beside the drawn lines too.
      box.current!.addEventListener("mousedown", (e) => (e.preventDefault(), area.focus()), { signal: stop.signal });
      // While an input method makes words, the box shows them over the cursor, as a terminal does.
      const making = (on: boolean) => {
        const cell = `${t.renderer!.getMetrics().height}px`;
        Object.assign(area.style, on ? { opacity: "1", clipPath: "none", width: "auto", height: cell, font: `${t.options.fontSize}px ${FONT}`, lineHeight: cell, color: THEME.foreground, background: THEME.background, outline: "none" } : { opacity: "0", clipPath: "inset(50%)", width: "1px", height: "1px" });
        if (!on) area.value = "";
      };
      area.style.setProperty("field-sizing", "content");
      area.addEventListener("compositionstart", () => making(true), { signal: stop.signal });
      // At each letter of the words being made, before the input method's window opens or moves to it.
      area.addEventListener("input", () => atCursor(t), { signal: stop.signal });
      area.addEventListener("compositionend", () => making(false), { signal: stop.signal });
      // Not the phone's keyboard as it opens: open() focuses it, now and once more right after.
      setTimeout(() => t.blur());
      const sent = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
      t.onData((d) => cut(d).forEach((part) => sent({ t: "in", d: part })));
      // Each paste, Ctrl+V's or the menu's, where the caret is in it or not: ghostty-web's own goes bare.
      box.current!.addEventListener(
        "paste",
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const text = e.clipboardData?.getData("text/plain");
          if (text) t.input(pasted(text), true);
        },
        { capture: true, signal: stop.signal },
      );
      // ⌘ keys are the page's, ⌘K its jump box (spec web-maximize), and the browser's, as ⌘C, ⌘V, ⌘R, ⌘F
      // and ⌘+. ghostty-web never sees them: it prevents the default of each key it takes.
      const input = (t as unknown as { inputHandler: { keydownListener(e: KeyboardEvent): void; isPrintableCharacter(e: KeyboardEvent): boolean } }).inputHandler;
      box.current!.removeEventListener("keydown", input.keydownListener);
      // A key that types goes on to the text it types, as the input method made it: a Mac's Chinese one
      // types ， with the key of ,.
      box.current!.addEventListener("keydown", (e) => e.metaKey || input.isPrintableCharacter(e) || input.keydownListener(e), { signal: stop.signal });
      // ghostty-web cancels each text typed and sends none: what Windows' Chinese one types with no
      // composition, as ，, after a key of 229, went nowhere.
      box.current!.addEventListener("beforeinput", (e) => e.inputType === "insertText" && !e.isComposing && e.data && t.input(e.data, true), { signal: stop.signal });
      // ghostty-web 0.4.0 sends Shift+Tab as Tab; a terminal's is ESC [ Z, Claude's switch of mode.
      t.attachCustomKeyEventHandler((e) => e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && (t.input("\x1b[Z", true), true));
      // The cell under a point of the page, from the top left at 0, kept in the terminal.
      const under = (x: number, y: number) => {
        const r = t.renderer!.getCanvas().getBoundingClientRect();
        const k = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v * n)));
        return { c: k((x - r.left) / r.width, t.cols), r: k((y - r.top) / r.height, t.rows) };
      };
      // A mouse's left button, pressed, dragged across cells and let go, goes to the pane, which takes it
      // if its program asked for the mouse, as Claude and pi do full screen (story 357). Not a finger:
      // a tap types. Its default left, the click still focuses and selects.
      let held: string | undefined;
      const click = (a: "down" | "drag" | "up", e: PointerEvent) => {
        const at = under(e.clientX, e.clientY);
        if (a === "drag" && held === `${at.c},${at.r}`) return;
        held = a === "up" ? undefined : `${at.c},${at.r}`;
        sent({ t: "mouse", a, ...at });
      };
      box.current!.addEventListener("pointerdown", (e) => e.pointerType === "mouse" && e.button === 0 && click("down", e), { signal: stop.signal });
      // The left let go while another button is still down comes as a move, not an up.
      document.addEventListener("pointermove", (e) => held !== undefined && click(e.buttons & 1 ? "drag" : "up", e), { signal: stop.signal });
      document.addEventListener("pointerup", (e) => held !== undefined && e.button === 0 && click("up", e), { signal: stop.signal });
      // Herdr scrolls the pane, a line for each cell's height of wheel or swipe, at the cell under it:
      // to the program if it asked for the mouse, else Herdr's own lines. The page keeps none.
      const cell = () => t.renderer?.getMetrics().height || 16;
      let rest = 0;
      const scroll = (px: number, at: { c: number; r: number }) => {
        rest += px / cell();
        const n = Math.trunc(rest);
        rest -= n;
        return n !== 0 && (sent({ t: "scroll", up: n < 0, n: Math.abs(n), ...at }), true);
      };
      t.attachCustomWheelEventHandler((e) => (scroll(e.deltaY * [1, cell(), cell() * t.rows][e.deltaMode]!, under(e.clientX, e.clientY)), true));
      let y = 0;
      let from = { c: 0, r: 0 };
      let swiped = false;
      const on = (type: string, f: (e: TouchEvent) => void, capture = false) => box.current!.addEventListener(type, f as EventListener, { signal: stop.signal, passive: true, capture });
      on("touchstart", (e) => ((y = e.touches[0]!.clientY), (from = under(e.touches[0]!.clientX, y)), (swiped = false)));
      on("touchmove", (e) => ((swiped = scroll(y - e.touches[0]!.clientY, from) || swiped), (y = e.touches[0]!.clientY)));
      // A swipe brings up no keyboard; a tap does, to type into the terminal itself.
      on("touchend", (e) => swiped && e.stopPropagation(), true);
      const draw = drawnOnDemand(t, () => !now.current.shown);
      sharp(t, draw, stop.signal);
      fit.fit();
      // ghostty-web 0.4.0 grows a terminal, as it fits, into the memory of the one freed before it,
      // uncleared: the slot before's text, in plain colours, till the first frame. Cleared once fitted,
      // not before, and drawn so.
      t.write("\x1b[2J\x1b[3J\x1b[H");
      draw();
      t.onResize(({ cols, rows }) => sent({ t: "size", c: cols, r: rows }));
      // Not while hidden, which measures nothing.
      let resizing: ReturnType<typeof setTimeout> | undefined;
      const measure = () => (clearTimeout(resizing), (resizing = setTimeout(() => box.current?.clientWidth && fit.fit(), 100)));
      const seen = new ResizeObserver(measure);
      seen.observe(box.current!);
      visualViewport?.addEventListener("resize", measure, { signal: stop.signal });
      stop.signal.addEventListener("abort", () => (seen.disconnect(), clearTimeout(resizing), (open.current = undefined)));
      open.current = { term: t, measure, draw };
      const connect = (takeOver: boolean) => {
        clearTimeout(timer);
        setDrawn(false);
        const sock = (ws = new WebSocket(address(slot, t.cols, t.rows, page, !takeOver)));
        sock.binaryType = "arraybuffer";
        sock.onopen = () => ws === sock && setLive(true);
        sock.onmessage = (e) => {
          if (typeof e.data === "string") return;
          t.write(new Uint8Array(e.data as ArrayBuffer));
          draw();
          tries = 0;
          setDrawn(true);
          setNote(null);
        };
        sock.onclose = (e) => {
          if (over || ws !== sock) return;
          ws = undefined;
          setLive(false);
          const then = afterClose(e.code);
          if (then === "elsewhere") return ((elsewhere = true), setAway(true));
          if (then === "slot") void refresh();
          if (then === "why") setNote(e.reason);
          // Not the board's: maybe a login proxy in front refused the handshake.
          if (then === "again") loginHolds();
          timer = setTimeout(() => connect(false), retryIn(tries++));
        };
      };
      document.addEventListener(
        "visibilitychange",
        () => {
          if (!document.hidden) return void (!ws && !elsewhere && connect(false));
          clearTimeout(timer);
          const sock = ws;
          ws = undefined;
          setLive(false);
          sock?.close();
        },
        { signal: stop.signal },
      );
      takeBack.current = () => ((elsewhere = false), setAway(false), connect(true));
      // Opened in the background, it leaves the pane to the page in front: coming to front connects.
      if (!document.hidden) connect(true);
    }, (err) => over || setNote(String(err)));
    return () => {
      over = true;
      clearTimeout(timer);
      stop.abort();
      ws?.close();
      term?.dispose();
    };
  }, [slot]);
  useEffect(() => {
    now.current.font = font;
    const o = open.current;
    if (!o) return;
    o.term.options.fontSize = font;
    o.measure();
  }, [font]);
  useEffect(() => {
    now.current.shown = shown;
    if (shown) open.current?.draw();
  }, [shown]);
  return (
    <>
      <section aria-label="终端" className={cn("relative min-h-0 flex-1 bg-[#0a0a0a]", !shown && "hidden")}>
        <div ref={box} className="absolute inset-0 touch-none overflow-hidden px-1 pt-1" />
        {!drawn && !away && <Connecting />}
        {note && <p className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-3 py-1 text-xs text-neutral-300">{note}</p>}
        {away && (
          <div className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-[#0a0a0a] text-sm text-neutral-300">
            <p>已在别处打开</p>
            <button type="button" onClick={() => takeBack.current?.()} className="h-11 rounded-lg border border-neutral-700 px-4 text-neutral-100 hover:bg-neutral-800">
              在这里继续
            </button>
          </div>
        )}
      </section>
      {/* A phone's: on a computer you type into the terminal itself. Under the chat shown in its place, the box alone (story 355). */}
      <div className="hidden shrink-0 bg-background px-3 pb-2 pointer-coarse:block">
        {/* Each keeps the keyboard as it was, up or down. */}
        <div role="toolbar" aria-label="特殊键" onMouseDown={(e) => e.preventDefault()} className={cn("mx-auto grid max-w-3xl grid-cols-9 text-sm text-muted-foreground", !shown && "hidden")}>
          {KEYS.map((k) => (
            <button key={k.label} aria-label={k.label} disabled={!live} onClick={() => press(k.key)} className="grid h-11 place-items-center rounded-lg transition-colors enabled:hover:bg-foreground/5 enabled:hover:text-foreground disabled:opacity-50">
              {k.face}
            </button>
          ))}
        </div>
        <div className="mx-auto flex max-w-3xl items-end rounded-3xl border bg-card shadow-xs">
          <textarea
            aria-label="发给终端"
            placeholder="发给终端"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="block max-h-[30dvh] min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-4 text-base outline-none [field-sizing:content] placeholder:text-muted-foreground"
          />
          <Key mode="send" busy={false} idle={!live || !text.trim()} onClick={send} />
        </div>
      </div>
    </>
  );
}
