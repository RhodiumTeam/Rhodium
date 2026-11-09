// What the board's pages share: the board's header, times as they show them, the agents' logos, the
// way back, a slot's top bar, headings and text boxes, a file's row.
import { cn } from "cn";
import { Activity, ChevronLeft, FileText, Plus, Settings } from "lucide-react";
import { createContext, lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { AgentKind } from "../../src/contracts";
import { request, settled } from "./data";

const rel = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

/** How long ago at was: "3分钟前"; within a minute, "刚刚". */
export function ago(at: number): string {
  const s = (at - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(s) >= size) return rel.format(Math.round(s / size), unit);
  }
  return "刚刚";
}

/** at's time of day: 21:05:03. */
export const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });

// The agents' own marks, unaltered, in their own colours, which read on light and dark: Claude's spark
// (simple-icons 16.35.0, CC0; the mark is Anthropic's; to a thousandth, which no screen shows, for the
// first screen's room) and pi's logo (pi.dev/logo.svg, MIT), cropped to the mark. OpenAI's, for Codex,
// is one colour, the text's, so it reads on dark too: its shape masks it (web/public/openai.svg,
// opencode's packages/ui provider icon, MIT, cropped; the mark is OpenAI's). They say which agent a
// slot runs, never what Rhodium is.
type Logo = { name: string } & ({ viewBox: string; paths: [fill: string, d: string][] } | { mask: string });
const LOGO: Record<AgentKind, Logo> = {
  claude: {
    name: "Claude",
    viewBox: "0 0 24 24",
    paths: [["#D97757", "m4.714 15.956 4.717-2.647.079-.231-.079-.128h-.231l-.789-.049-2.696-.073-2.337-.097-2.265-.121-.571-.121-.534-.704.055-.352.48-.322.686.061 1.518.103 2.277.158 1.651.097 2.447.255h.389l.055-.158-.134-.097-.103-.097L6.973 9.836l-2.55-1.688-1.336-.971-.723-.492-.364-.461-.158-1.008.656-.723.88.061.225.061.892.686 1.906 1.475 2.489 1.834.364.303.146-.103.018-.073-.164-.273-1.354-2.447-1.445-2.489-.643-1.032-.17-.619c-.061-.255-.103-.467-.103-.729L6.287.134 6.7 0l.996.134.419.364.619 1.415 1.002 2.228 1.554 3.03.455.898.243.832.091.255h.158v-.146l.128-1.706.237-2.095.231-2.696.079-.759.376-.911.747-.492.583.279.48.686-.067.443-.285 1.852-.559 2.902-.364 1.943h.212l.243-.243.984-1.305 1.651-2.064.729-.82.85-.905.546-.431h1.032l.759 1.129-.34 1.166-1.062 1.348-.88 1.141-1.263 1.7-.789 1.36.073.109.188-.018 2.853-.607 1.542-.279 1.84-.316.832.389.091.395-.328.807-1.967.486-2.307.461-3.436.814-.043.03.049.061 1.548.146.662.036h1.621l3.018.225.789.522.474.638-.079.486-1.214.619-1.639-.389-3.825-.911-1.311-.328h-.182v.109l1.093 1.069 2.003 1.809 2.507 2.331.128.577-.322.455-.34-.049-2.204-1.657-.85-.747-1.925-1.621h-.128v.17l.443.65 2.344 3.521.121 1.081-.17.352-.607.212-.668-.121-1.372-1.925L14.38 17.959l-1.141-1.943-.14.079-.674 7.255-.316.37-.729.279-.607-.461-.322-.747.322-1.475.389-1.925.316-1.53.285-1.9.17-.631-.012-.043-.14.018-1.433 1.967-2.18 2.945-1.724 1.846-.413.164-.716-.37.067-.662.401-.589 2.386-3.036 1.439-1.882.929-1.087-.006-.158h-.055l-6.338 4.116-1.129.146-.486-.455.061-.747.231-.243 1.906-1.311Z"]],
  },
  pi: {
    name: "pi",
    viewBox: "165.29 165.29 469.43 469.43",
    paths: [
      ["#F09082", "M165.29 165.29H517.36V400H400V282.65H165.29Z"],
      ["#4D9ABF", "M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"],
      ["#F1BE58", "M517.36 400H634.72V634.72H517.36Z"],
    ],
  },
  // A file of its own, apart from the first screen, which has no room for it (architecture §2).
  codex: { name: "Codex CLI", mask: "/openai.svg" },
};

/** The agent's name, as its logo is named: agents.ts's, kept here too so the first screen does not load
 *  that table, which would put it over its 200KB (architecture §2). */
export const agentName = (agent: AgentKind) => LOGO[agent].name;

/** A model by its name, the default's 默认 with the model it uses beside it in grey (story 407). */
export function ModelName({ name }: { name: string }) {
  const [, uses] = /^默认（(.+)）$/.exec(name) ?? [];
  return uses ? (
    <>
      默认<span className="ml-1.5 text-muted-foreground/70">{uses}</span>
    </>
  ) : (
    name
  );
}

/** The agent's logo, as tall as the text around it, named for screen readers. */
export function AgentLogo({ agent, className }: { agent: AgentKind; className?: string }) {
  const logo = LOGO[agent];
  const size = cn("inline-block size-[1em] shrink-0 align-[-0.125em]", className);
  if ("mask" in logo) return <span role="img" aria-label={logo.name} className={cn(size, "bg-current")} style={{ mask: `url(${logo.mask}) center / contain no-repeat` }} />;
  return (
    <svg role="img" aria-label={logo.name} viewBox={logo.viewBox} className={size}>
      {logo.paths.map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  );
}

/** Which of the home's views this device opens at /: the list, or the topology (story 244). Storage
 *  that cannot be used, as in some private windows, keeps none. */
export const HOME = {
  get: (): "list" | "topology" => {
    try {
      return localStorage.getItem("home") === "topology" ? "topology" : "list";
    } catch {
      return "list";
    }
  },
  set: (view: "list" | "topology") => {
    try {
      localStorage.setItem("home", view);
    } catch {}
  },
};

/** A screen wide enough for the board and a slot's chat side by side: Tailwind's lg:. */
export const WIDE = "(min-width: 64rem)";
/** A screen with room for maximize mode: a wide one, or a medium one, 600 to 1023px wide and 480px tall
 *  or more (spec web-maximize "中屏"), whose slot's chat is always in it, with no split. */
export const ROOM = `${WIDE}, (min-width: 37.5rem) and (min-height: 30rem)`;
const resized = (f: () => void) => (addEventListener("resize", f), () => removeEventListener("resize", f));
/** Whether the screen is as query says, as the window's size changes. */
export const useMedia = (query: string) => useSyncExternalStore(resized, () => matchMedia(query).matches);

/** A wide or medium screen's split beside a slot's chat: where the chat was opened from, the list or
 *  the topology, and whether it is in maximize mode (full, spec web-maximize), as a medium screen's
 *  always is; there, whether its sidebar is collapsed, and what collapses or expands it. null on a
 *  phone, which has no split. */
export const Max = createContext<{ from: "list" | "topology"; full: boolean; collapsed: boolean; toggle: () => void } | null>(null);

/** Goes to hash, a step of its own or in place of this one, with state. Not wouter's navigate, which
 *  would put a query in location.search. */
export function goHash(hash: string, replace = false, state: unknown = null) {
  history[replace ? "replaceState" : "pushState"](state, "", hash);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Whether keys go by ⌘, as on a Mac, rather than Ctrl. */
export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** A key pressed, as boardKey reads it. */
export type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
/** The board's own keys (spec web-maximize): the jump box, the slot above or below, the sidebar. */
export type BoardKey = "jump" | "up" | "down" | "side";

/** Which of the board's keys e is, where you type too, told in this one place (spec web-maximize
 *  "快捷键什么时候不接"): ⌘K, Ctrl+K off a Mac, whose Ctrl+K cuts to a text box's line end, the jump box's;
 *  ⌘B, Ctrl+B off a Mac, the sidebar's; Alt+↑↓, Option on a Mac, the slot above or below. None while an
 *  input method composes: its keys pick a word, and Safari tells them by keyCode 229 alone. */
// The web terminal keeps Ctrl+B, Ctrl+K and Alt+↑↓, tmux's and its shell's: ghostty-web stops them there.
export function boardKey(e: KeyLike, mac = MAC): BoardKey | null {
  if (e.isComposing || e.keyCode === 229 || e.shiftKey) return null;
  if (e.altKey) return e.metaKey || e.ctrlKey ? null : e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
  if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null;
  const k = e.key.toLowerCase();
  return k === "k" ? "jump" : k === "b" ? "side" : null;
}

/** The slot whose chat is open at address at, beside the list or the topology, maximized or not; ""
 *  for none. A phone shows the topology alone at a chat's address. wide: the screen has room (ROOM). */
export const chatAt = (at: string, wide: boolean) =>
  decodeURIComponent((/^\/slot\/([^/?]+)/.exec(at) ?? (wide ? /^\/topology\/slot\/([^/?]+)\?(?:.*&)?chat(?:&|$)/.exec(at) : null))?.[1] ?? "");

/** Where slot id opens from address at, the page staying as it is (spec web-maximize "跳转框"): an open
 *  chat gives way to id's, maximized or not, beside the list or the topology; the home opens it beside
 *  the list, the whole topology beside the topology; a phone, its chat. wide: the screen has room (ROOM). */
export function slotHash(id: string, at: string, wide: boolean): string {
  const e = encodeURIComponent(id);
  const query = at.split("?")[1];
  if (at.startsWith("/slot/")) return `#/slot/${e}${query ? `?${query}` : ""}`;
  if (wide && at.startsWith("/topology")) return `#/topology/slot/${e}?${chatAt(at, wide) ? query : "chat"}`;
  return `#/slot/${e}`;
}

/** Opens slot id's chat from address at as slotHash has it on this screen, a step of its own; from the
 *  home, "" or "/", with the way back there, as the list's row (up): a medium screen's 缩小 right after it is back. */
export const openFrom = (id: string, at: string) => goHash(slotHash(id, at, matchMedia(ROOM).matches), false, at[1] ? null : { up: "list" });

/** The slots whose chats were opened in this tab, the latest first (the jump box's, story 441): kept
 *  for the tab, as its sessionStorage is; storage that cannot be used keeps none. */
export const recent = {
  get: (): string[] => {
    try {
      return JSON.parse(sessionStorage.getItem("recent") ?? "[]");
    } catch {
      return [];
    }
  },
  add: (id: string) => {
    try {
      sessionStorage.setItem("recent", JSON.stringify([id, ...recent.get().filter((r) => r !== id)]));
    } catch {}
  },
};

/** run on the board's key name, the browser's own way with it kept from it, while run is given; while
 *  not, or while a sheet is open over the page, the key is the browser's as ever: the sheet, closing,
 *  gives the focus back to what opened it, which the key might have hidden. */
export function useBoardKey(name: BoardKey, run: (() => void) | undefined) {
  const now = useRef(run);
  now.current = run;
  const on = !!run;
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => boardKey(e) === name && !document.querySelector('[role="dialog"][data-open]') && (e.preventDefault(), now.current?.());
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [name, on]);
}

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The theme chosen on this device, set on the page's root as data-theme, which index.css reads;
 *  跟随系统 sets none. public/theme.js sets it as the page loads, before it is drawn. Storage that
 *  cannot be used keeps none. */
export const THEME = {
  get: (): Theme => {
    try {
      const t = localStorage.getItem("theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  },
  set: (t: Theme) => {
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch {}
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    themed.forEach((f) => f());
  },
};
const themed = new Set<() => void>();

/** The theme chosen on this device, as it changes: the topology's canvas follows it too. */
export const useTheme = () => useSyncExternalStore((f) => (themed.add(f), () => void themed.delete(f)), THEME.get);

/** Above this round trip, in ms, the header's dot is amber. */
const SLOW = 300;

/** The header's dot: grey till the event stream opens or while it reopens; green, or amber when the
 *  round trip is slow. */
export const dotOf = (live: boolean | null, ms: number | null) => (!live ? "bg-idle" : ms !== null && ms > SLOW ? "bg-needs" : "bg-done");

/** The round trip to rhodium in ms, timed on GET api/ping while the stream is open: at once, every
 *  30 s and when the page is seen again, never while it is not. null till timed, or when it fails. */
function useLatency(live: boolean | null): number | null {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!live) return setMs(null);
    const time = async () => {
      if (document.hidden) return;
      const start = performance.now();
      const ok = await request("api/ping", { cache: "no-store" }).then((r) => r.ok, () => false);
      setMs(ok ? Math.round(performance.now() - start) : null);
    };
    void time();
    const every = setInterval(time, 30_000);
    document.addEventListener("visibilitychange", time);
    return () => (clearInterval(every), document.removeEventListener("visibilitychange", time));
  }, [live]);
  return ms;
}

// The + and its sheets write, so they come apart from the first screen (spec web-write), once the page
// is idle: not to slow the list down (#356).
const CreateMenu = lazy(() => settled().then(() => import("./create")).then((m) => ({ default: m.CreateMenu })));
const PLUS = "hover-round -my-2 ml-auto grid size-11 shrink-0 place-items-center text-running";
// The settings' gear (spec web-maximize "设置"), its card loaded as the + is, where the theme's button was, as wide.
const SettingsMenu = lazy(() => settled().then(() => import("./settings")).then((m) => ({ default: m.SettingsMenu })));
const GEAR = "hover-round -mx-1 -my-2 grid size-9 shrink-0 place-items-center text-muted-foreground hover:text-foreground";

/** hash, as #/topology/slot/<id>?chat&full, with flag in its query or not. */
export function flagged(hash: string, flag: string, on: boolean): string {
  const [path, query = ""] = hash.split("?");
  const q = [...query.split("&").filter((f) => f && f !== flag), ...(on ? [flag] : [])];
  return q.length ? `${path}?${q.join("&")}` : path!;
}

/** The board's header: its name; whether the event stream is live and the round trip, the way to
 *  Rhodium's page, with an icon on a wide screen where there is room; the home's two views, the + that makes or imports a slot, and the settings' gear. Switching views takes the place of the step
 *  in history; on a wide screen a slot's chat beside one stays open beside the other (#285). */
export function BoardHeader({ live }: { live: boolean | null }) {
  const [location] = useLocation();
  const ms = useLatency(live);
  // A wide screen has the list beside a slot's chat.
  const on = location.startsWith("/topology") ? "topology" : location === "/" || location.startsWith("/slot/") ? "list" : null;
  const go = (view: "list" | "topology") => {
    const chat = matchMedia(WIDE).matches && encodeURIComponent(chatAt(location, true));
    goHash(view === "list" ? (chat ? `#/slot/${chat}` : "#/") : chat ? `#/topology/slot/${chat}?chat` : "#/topology", true);
  };
  const tab = (view: "list" | "topology", label: string) => (
    <button
      aria-pressed={on === view}
      onClick={() => (HOME.set(view), on !== view && go(view))}
      // Its focus ring inside it, as the control's border and round corners clip what is outside.
      className={cn("h-8 px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring first:rounded-l-[calc(var(--radius-lg)-1px)] last:rounded-r-[calc(var(--radius-lg)-1px)] @min-[380px]:px-3", on === view ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}
    >
      {label}
    </button>
  );
  return (
    // Laid out by its own width, not the screen's: as narrow beside a chat as on a phone (story 422). The
    // roomier layout from 380px, where it fits a three-digit round trip, as on a 412px phone (#635).
    <div className="@container">
      {/* On a wide screen as tall as a chat's top bar beside it, its middle level with the bar's (#617). */}
      <header className="flex items-center gap-1 pt-4 pb-1 whitespace-nowrap @min-[380px]:gap-2.5 lg:h-14 lg:py-0">
        <h1 className="text-lg font-semibold @min-[380px]:text-xl">
          <Link href="/" className="transition-opacity hover:opacity-70">
            Rhodium
          </Link>
        </h1>
        {/* The way to Rhodium's page: the connection, which it says more of. */}
        <Link href="/rhodium" aria-label="状态" className="-my-2 flex h-11 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <span className={cn("size-2 rounded-full", dotOf(live, ms))} />
          {live === null ? "连接中" : !live ? "重连中" : ms !== null && <span className="tabular-nums">{`${ms}ms`}</span>}
          {/* A wide screen shows it goes somewhere, if the header has room for it at three digits; a phone does not. */}
          <Activity className="ml-0.5 hidden size-3.5 lg:@min-[26rem]:block" />
        </Link>
        <div className="inline-flex shrink-0 overflow-hidden rounded-lg border">
          {tab("list", "列表")}
          {tab("topology", "拓扑图")}
        </div>
        <Suspense
          fallback={
            <span aria-hidden className={PLUS}>
              <Plus className="size-5" />
            </span>
          }
        >
          <CreateMenu className={PLUS}>
            <Plus className="size-5" />
          </CreateMenu>
        </Suspense>
        <Suspense
          fallback={
            <span aria-hidden className={GEAR}>
              <Settings className="size-4.5" />
            </span>
          }
        >
          <SettingsMenu side="bottom" className={GEAR}>
            <Settings className="size-4.5" />
          </SettingsMenu>
        </Suspense>
      </header>
    </div>
  );
}

export function Back() {
  return (
    <Link href="/" className="mt-3 inline-flex items-center text-sm text-running hover:underline">
      <ChevronLeft className="size-4" />
      全部槽位
    </Link>
  );
}

const TAP = "hover-round -my-0.5 -ml-2 grid size-11 shrink-0 place-items-center text-running";

/** A slot's top bar: the way back, or lead in its place, the slot's name and the line under it, which
 *  says 已断开 while the event stream is down, and what is at its right. With no slot, it is drawn while
 *  the chat comes. */
export function TopBar({ title, sub, live, back, lead, children }: { title?: ReactNode; sub?: string; live: boolean | null; back?: () => void; lead?: ReactNode; children?: ReactNode }) {
  return (
    // Over the chat's info card's tap catcher (card.tsx). Its right edge, 详情's, is the chat's: px-4.
    <header className="relative z-10 flex items-center gap-1 border-b bg-background pr-4 pl-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
      {/* back: where the chat was opened from, the topology, rather than the list. A 44px target, the
          arrow where it would be with none, the bar no taller. */}
      {lead ?? (back ? (
        <button onClick={back} aria-label="返回" className={TAP}>
          <ChevronLeft className="size-5" />
        </button>
      ) : (
        <Link href="/" aria-label="全部槽位" className={TAP}>
          <ChevronLeft className="size-5" />
        </Link>
      ))}
      {/* As tall with no slot as with one. */}
      <div className="min-h-10 min-w-0 flex-1">
        {title && <h2 className="truncate font-semibold">{title}</h2>}
        <div className="truncate text-xs text-muted-foreground">
          {live === false && <span className="text-destructive">已断开{sub && "。"}</span>}
          {sub}
        </div>
      </div>
      {children}
    </header>
  );
}

/** A page's title, and the lines under it. */
export function Title({ children, sub }: { children: ReactNode; sub: string }) {
  return (
    <>
      <h2 className="mt-2 text-lg font-semibold break-all">{children}</h2>
      <div className="text-xs break-all whitespace-pre-line text-muted-foreground">{sub}</div>
    </>
  );
}

export const Heading = ({ children }: { children: ReactNode }) => <h3 className="mt-5 mb-1.5 text-sm font-semibold text-muted-foreground">{children}</h3>;

/** Text as written, such as a log, in a box that scrolls. */
export const Box = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cn("card-scroll max-h-[60vh] overflow-auto rounded-lg border bg-card px-2.5 py-2 font-mono text-xs/relaxed whitespace-pre-wrap wrap-anywhere", className)}>{children}</pre>
);

/** Your words, each run of 24 or more ASCII characters with no space (a path, a hash, a URL) set to
 *  break anywhere: else it breaks only at its few hyphens, leaving a line of a few characters (#512).
 *  24 is longer than an English word, which stays whole, and shorter than a phone's line. */
export const breakLong = (text: string) => text.split(/([!-~]{24,})/).map((s, i) => (i % 2 ? <span key={i} className="break-all">{s}</span> : s));

/** A file's row: its icon and name; with href, a link that downloads it under that name. */
export function FileRow({ name, href, className }: { name: string; href?: string; className?: string | false }) {
  const look = cn("flex min-h-11 max-w-full items-center gap-2 rounded-xl border bg-muted px-3 text-sm", className);
  const inner = (
    <>
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </>
  );
  return href ? (
    <a href={href} download={name} className={cn(look, "transition-colors hover:bg-foreground/5")}>
      {inner}
    </a>
  ) : (
    <div className={look}>{inner}</div>
  );
}
