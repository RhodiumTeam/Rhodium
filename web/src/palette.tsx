// The command palette (spec web-write "命令面板"): / at the start of where you type lists the slot's
// commands over it, fewer as you type on; and what to pick from, in the info card: a command's panel,
// as IM shows it, and the bar's agent and model sheets. Only the chat's code has this.
import { Slider } from "@base-ui/react/slider";
import { cn } from "cn";
import { Bot, Box, Brain, ChartPie, Check, ChevronRight, FoldVertical, Gauge, History, Info, LoaderCircle, Search, Slash, Square, SquarePen, Workflow, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { AGENT_KINDS } from "../../src/agents";
import type { AgentKind } from "../../src/contracts";
import type { Candidate } from "../../src/panels";
import type { RhReply } from "../../src/router";
import { AgentLogo, agentName, ModelName } from "./common";
import { CardFrame } from "./card";
import { buttonVariants } from "./components/ui/button";
import type { Command } from "./data";
import { toast } from "./toast";
import { useEdges } from "./write";

/** The commands for what you typed after the /: those whose name starts with it first, then those
 *  whose name has it, then those whose summary does (story 296), each in the order given. */
export function matching(commands: Command[], typed: string): Command[] {
  const q = typed.toLowerCase();
  const rank = (c: Command) => (c.name.startsWith(q) ? 0 : c.name.includes(q) ? 1 : c.summary.toLowerCase().includes(q) ? 2 : 3);
  return commands
    .map((c) => [rank(c), c] as const)
    .filter(([r]) => r < 3)
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
}

const ICON: Record<string, LucideIcon> = {
  stop: Square,
  new: SquarePen,
  status: Info,
  resume: History,
  model: Box,
  usage: Gauge,
  context: ChartPie,
  compact: FoldVertical,
  effort: Brain,
  ultracode: Workflow,
};

/** The commands, over where you type and as wide (story 294): a row each, its icon, name, arguments and
 *  what it does, cut to one line (story 295). at: the one ↑↓ are on, and the mouse once it moves onto
 *  one (point), as the jump box has it. Tapped, a command is picked; where you type keeps the keyboard.
 *  Past its height the rows scroll inside its box, faded where cut (#577). ↑↓ scroll theirs clear of the
 *  fade; the mouse's stays where it is, as scrolled it would bring the next one under the mouse. */
export function Palette({ list, at, pick, point }: { list: Command[]; at: number; pick: (c: Command) => void; point: (at: number) => void }) {
  const scroller = useEdges<HTMLDivElement>();
  const pointed = useRef(-1);
  return (
    <div role="listbox" aria-label="命令" className="absolute -inset-x-px bottom-full z-10 mb-2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-md">
      <div {...scroller} className="card-scroll edge-fade-y max-h-72 scroll-py-8 overflow-y-auto">
        <div className="p-1">
          {list.map((c, i) => {
            const Icon = ICON[c.name] ?? Slash;
            return (
              <button
                key={c.name}
                role="option"
                aria-selected={i === at}
                ref={(el) => void (el && i === at && i !== pointed.current && ((pointed.current = -1), el.scrollIntoView({ block: "nearest" })))}
                onPointerDown={(e) => e.preventDefault()}
                onPointerMove={() => i === at || ((pointed.current = i), point(i))}
                onClick={() => pick(c)}
                className={cn("flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left", i === at && "bg-accent")}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">/{c.name}</span>
                {c.usage && <span className="max-w-[33%] min-w-0 shrink truncate font-mono text-xs text-muted-foreground">{c.usage}</span>}
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{c.summary}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** What a command offers to pick from (stories 299, 391), in the info card: its question on top, the
 *  rest of what it says, and the candidates, the one now ticked. name: the command's, for its icon.
 *  Picked, one spins till its answer comes, or the card closes or shows another. */
export function Answer({ r, name, close, pick }: { r: Extract<RhReply, { ok: true }>; name: string; close: () => void; pick: (c: Candidate) => Promise<void> }) {
  const [pressed, setPressed] = useState<Candidate | null>(null);
  // Another, the card takes picks again, even while the one picked before waits for its answer.
  const [shown, setShown] = useState(r);
  if (r !== shown) (setShown(r), setPressed(null));
  const [title = "", ...rest] = r.panel?.head ?? r.text.split("\n");
  return (
    <CardFrame icon={ICON[name] ?? Slash} title={title} close={close}>
      {rest.length > 0 && <p className="px-4 pb-1 text-sm whitespace-pre-wrap wrap-anywhere text-muted-foreground">{rest.join("\n")}</p>}
      <div className="grid px-2 pb-2">
        {r.panel?.candidates.map((c) => (
          <button
            key={c.command}
            disabled={pressed !== null}
            onClick={async () => {
              setPressed(c);
              await pick(c);
              setPressed((p) => (p === c ? null : p));
            }}
            className={ROW}
          >
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            {pressed === c ? <Spinning /> : c.current && <Now />}
          </button>
        ))}
      </div>
    </CardFrame>
  );
}

/** Says a command to the slot as typed, and resolves to rhodium's answer. */
type Send = (text: string) => Promise<RhReply>;

const ROW = "flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-base outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-60";
const Spinning = () => <LoaderCircle className="size-4 shrink-0 animate-spin" />;
const Now = () => <Check aria-label="现在" className="size-4 shrink-0 text-running" />;


/** The agent sheet (story 303), /rh_agent's panel on the board: Claude and pi, the one now ticked. The
 *  other picked switches to it, a new conversation; while a turn runs it asks first: once the turn is
 *  over, or cutting it short. */
export function AgentSheet({ open, close, agent, turn, send }: { open: boolean; close: () => void; agent: AgentKind; turn: boolean; send: Send }) {
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  if (!open && (picked || pressed)) (setPicked(null), setPressed(null));
  const go = async (to: AgentKind, how: string, cut = false) => {
    setPressed(how);
    const r = await send(`/rh_agent ${to}${cut ? " !" : ""}`);
    setPressed(null);
    if (!r.ok) return toast(r.error, true);
    close();
    toast(r.text);
  };
  if (!open) return null;
  return (
    <CardFrame icon={Bot} title="Agent" close={close}>
      <div className="grid px-2 pb-2">
        {AGENT_KINDS.map((a) => (
          <button key={a} disabled={pressed !== null} onClick={() => (a === agent ? close() : turn ? setPicked(a) : void go(a, a))} className={cn(ROW, picked === a && "bg-accent")}>
            <AgentLogo agent={a} className="size-5" />
            <span className="min-w-0 flex-1 truncate">{agentName(a)}</span>
            {pressed === a ? <Spinning /> : a === agent && <Now />}
          </button>
        ))}
      </div>
      {picked && (
        <div className="grid grid-cols-2 gap-2 border-t p-3">
          <button disabled={pressed !== null} onClick={() => void go(picked, "after")} className={buttonVariants({ variant: "outline", size: "lg" })}>
            {pressed === "after" ? <Spinning /> : "跑完再换"}
          </button>
          <button disabled={pressed !== null} onClick={() => void go(picked, "cut", true)} className={buttonVariants({ size: "lg" })}>
            {pressed === "cut" ? <Spinning /> : "打断，马上换"}
          </button>
        </div>
      )}
    </CardFrame>
  );
}

/** More models than this, IM's page of them, and the sheet has a search box (story 528). */
const MANY = 8;
/** The groups folded with nothing searched: with more than MANY models, all but the current one's (story 529). */
function resting(all: Candidate[]) {
  const open = all.find((c) => c.current)?.group;
  return new Set(all.length > MANY ? all.map((c) => c.group).filter((g) => g !== open) : []);
}

/** The model sheet (story 304): /model's and /effort's panels in one, the models on top and the
 *  thinking levels of the one in use under them, as IM offers them, the one now ticked (story 299).
 *  A model picked is in use at once, the levels under it becoming its own, or, with none, the sheet
 *  closes. Each part a row of its own: under the levels' slider ultracode's switch, where the agent can
 *  take it, asked again for a model picked; flipped, the sheet stays open (#276). The levels and the
 *  switch are the card's foot, in sight however long the list (story 520). Over MANY models, a search
 *  box on top finds them by name or group, the keyboard taken at once only with a mouse (story 528).
 *  Models of more than one group, pi's providers, under a header each that folds them (story 529). */
export function ModelSheet({ open, close, send }: { open: boolean; close: () => void; send: Send }) {
  const [models, setModels] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Set<string | undefined>>(new Set());
  const [levels, setLevels] = useState<Candidate[] | null>(null);
  const [pressed, setPressed] = useState<Candidate | null>(null);
  // null: not known, or not to be had (pi, a model without it).
  const [ultra, setUltra] = useState<boolean | null>(null);
  const [flipping, setFlipping] = useState(false);
  // Each opening's own: what comes for one before stays out of the next.
  const opening = useRef(0);
  useEffect(() => {
    if (!open) return;
    const at = ++opening.current;
    setModels(null);
    setQuery("");
    setLevels(null);
    setPressed(null);
    setUltra(null);
    // A flip still on its way when the last opening closed is that opening's.
    setFlipping(false);
    void send("/model").then((r) => {
      if (opening.current !== at) return;
      if (r.ok && r.panel) return setModels(r.panel.candidates), setFolded(resting(r.panel.candidates));
      close();
      toast(r.ok ? r.text : r.error, !r.ok);
    });
    // A model with no levels has none to show; neither has one the agent could not say.
    void send("/effort").then((r) => opening.current === at && setLevels((r.ok && r.panel?.candidates) || []));
    askUltra(at);
    return () => void opening.current++;
  }, [open]);
  const askUltra = (at: number) =>
    void send("/ultracode").then((r) => opening.current === at && setUltra(r.ok && r.panel ? r.panel.candidates.some((c) => c.current && c.command === "/ultracode on") : null));
  const flip = async () => {
    const at = opening.current;
    setFlipping(true);
    const r = await send(`/ultracode ${ultra ? "off" : "on"}`);
    if (opening.current !== at) return;
    setFlipping(false);
    if (!r.ok) return toast(r.error, true);
    setUltra(!ultra);
  };
  const pick = async (c: Candidate) => {
    const at = opening.current;
    setPressed(c);
    const r = await send(c.command);
    if (opening.current !== at) return;
    setPressed(null);
    if (!r.ok) return toast(r.error, true);
    askUltra(at);
    if (r.panel?.candidates.length) {
      setModels((all) => all && all.map((m) => ({ ...m, current: m === c })));
      return setLevels(r.panel.candidates);
    }
    close();
    toast(r.text);
  };
  const busy = pressed !== null;
  if (!open) return null;
  const q = query.trim().toLowerCase();
  const found = models?.filter((c) => !q || [c.label, c.group].some((s) => s?.toLowerCase().includes(q)));
  const groups = [...new Set(models?.map((c) => c.group))];
  const row = (c: Candidate) => (
    <button key={c.command} disabled={busy} onClick={() => void pick(c)} className={ROW}>
      <span className="min-w-0 flex-1 truncate">
        <ModelName name={c.label} />
      </span>
      {pressed === c ? <Spinning /> : c.current && <Now />}
    </button>
  );
  return (
    <CardFrame
      icon={Box}
      title="模型"
      close={close}
      top={
        models &&
        models.length > MANY && (
          <label className="mx-3 mb-2 flex h-10 items-center gap-2 rounded-lg border bg-background px-3 transition-colors focus-within:border-ring">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="搜索模型"
              autoFocus={matchMedia("(pointer: fine)").matches}
              value={query}
              // Searching opens every group it finds in; cleared, they fold as they did at first.
              onChange={(e) => (setQuery(e.target.value), setFolded(e.target.value.trim() ? new Set() : resting(models)))}
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none"
            />
          </label>
        )
      }
      foot={
        <>
          {/* A model's own levels in place of the last one's, drawn anew (story 527). */}
          {levels && levels.length > 1 && <Effort key={levels.map((c) => c.command).join("\n")} levels={levels} send={send} />}
          {ultra !== null && (
            <button role="switch" aria-checked={ultra} aria-label="ultracode" disabled={busy || flipping} onClick={() => void flip()} className={cn(ROW, "mb-2 w-full rounded-none border-t")}>
              <Workflow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">ultracode</span>
              {flipping ? (
                <Spinning />
              ) : (
                <span className={cn("flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors", ultra ? "justify-end bg-primary" : "bg-input dark:bg-input/80")}>
                  <span className={cn("size-5 rounded-full shadow-sm", ultra ? "bg-background dark:bg-primary-foreground" : "bg-background dark:bg-foreground")} />
                </span>
              )}
            </button>
          )}
        </>
      }
    >
      <div role="group" aria-label="模型" className="grid px-2 pb-2">
        {models === null ? (
          <span className="grid h-11 place-items-center text-muted-foreground">
            <Spinning />
          </span>
        ) : groups.length < 2 ? (
          found!.map(row)
        ) : (
          groups.map((g) => {
            const hits = found!.filter((c) => c.group === g);
            const shut = folded.has(g);
            return (
              hits.length > 0 && (
                <Fragment key={g ?? ""}>
                  <button aria-expanded={!shut} onClick={() => setFolded((f) => new Set(shut ? [...f].filter((x) => x !== g) : [...f, g]))} className="flex h-9 items-center gap-1.5 px-3 text-left text-sm text-muted-foreground hover:text-foreground">
                    <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", !shut && "rotate-90")} />
                    <span className="min-w-0 truncate">{g}</span>
                  </button>
                  {!shut && hits.map(row)}
                </Fragment>
              )
            );
          })
        )}
      </div>
    </CardFrame>
  );
}

/** Where a thinking level stands, whichever agent lists it (story 525): its heat. -1: a name not here. */
const RANK = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const rank = (level: string) => RANK.indexOf(level === "none" ? "off" : level);

/** The thinking levels as a slider (stories 524-527), as the agent lists them, low to high, at the one the
 *  slot has, if known. Let go on another, or stepped to with an arrow key, it is said as typed, and the
 *  sheet stays open. One picked while another is on its way waits, and only the last is said once that
 *  one's answer comes: never disabled, which would drop the focus and the arrow keys with it. One not set
 *  springs back, the toast saying why. As Codex draws it: a thick bar, the knob in it, filled blue to violet
 *  the higher, motes drifting at max and ultra. */
function Effort({ levels, send }: { levels: Candidate[]; send: Send }) {
  const [at, setAt] = useState(() => levels.findIndex((c) => c.current));
  const has = useRef(at); // the slot's
  const next = useRef<number | null>(null);
  const going = useRef(false);
  // Gone, as for a model with its own levels: what waits is not said.
  useEffect(() => () => void (next.current = null), []);
  const commit = async (i: number) => {
    next.current = i;
    if (going.current) return;
    going.current = true;
    for (let pick: number | null = i; pick !== null; pick = next.current) {
      next.current = null;
      if (pick === has.current) continue;
      const r = await send(levels[pick]!.command);
      if (r.ok) has.current = pick;
      else {
        toast(r.error, true);
        if (next.current === null) setAt(has.current);
      }
    }
    going.current = false;
  };
  const label = levels[at]?.label;
  const r = label === undefined ? -1 : rank(label);
  // Grey-blue at off to violet at ultra, the fill blue at its left; a name not ranked, grey, which the
  // white knob shows on in either theme.
  const heat = { "--heat": r < 0 ? "var(--muted-foreground)" : `oklch(${0.66 - r * 0.015} ${0.06 + r * 0.022} ${250 + r * 7})`, "--cool": r < 0 ? "var(--muted-foreground)" : "oklch(0.66 0.1 252)" } as CSSProperties;
  // About 28rem at most on a wide screen. The knob as high as the bar, its rim see-through, so the fill
  // shows round it; Base UI keeps it inside the bar at either end, where its stops are too.
  const stop = (f: number) => `calc(0.875rem + (100% - 1.75rem) * ${f})`;
  return (
    <div className="border-t px-4">
      <Slider.Root aria-label="思考强度" value={Math.max(at, 0)} max={levels.length - 1} thumbAlignment="edge" onValueChange={(v) => setAt(v as number)} onValueCommitted={(v) => void commit(v as number)} style={heat} className="flex max-w-md items-center gap-3">
        <Brain aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Slider.Control className="flex min-h-11 flex-1 touch-none items-center select-none">
          <Slider.Track className="relative h-7 w-full rounded-full bg-muted">
            {levels.slice(1, -1).map((c, i) => (
              <span key={c.command} className="absolute top-1/2 size-1 -translate-1/2 rounded-full bg-muted-foreground/40" style={{ left: stop((i + 1) / (levels.length - 1)) }} />
            ))}
            <Slider.Indicator className={cn("relative w-[calc(var(--start-position)+0.875rem)]! overflow-hidden rounded-full bg-linear-to-r from-(--cool) to-(--heat)", at < 0 && "hidden")}>
              {r >= 6 && <span className="stardust absolute inset-0 motion-safe:animate-drift" />}
            </Slider.Indicator>
            <Slider.Thumb
              aria-label="思考强度"
              getAriaValueText={() => label ?? ""}
              className={cn("size-7 rounded-full border-3 border-transparent bg-white bg-clip-padding drop-shadow-sm has-focus-visible:outline-3", at < 0 && "opacity-0")}
            />
          </Slider.Track>
        </Slider.Control>
        <span className="w-14 shrink-0 text-sm font-medium text-(--heat)">{label}</span>
      </Slider.Root>
    </div>
  );
}
