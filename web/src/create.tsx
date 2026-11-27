import { pickerPath } from "./picker-path";
// New slots and imports from the board (spec web-write "新建和导入", spec web-import-composer stories
// 634-639): one sheet for each, a dialog in the middle of a wide or medium screen, from the bottom on a
// phone. From a workspace, in it with no picker; from the home's +, the sidebar's buttons on top or a
// workspace's details on the topology, in a folder picked in the directory picker (stories 538-542, 637,
// 638). What is made opens its chat. Loaded only once the + shows: the board's first screen stays light.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Autocomplete } from "@base-ui/react/autocomplete";
import type { BaseUIEvent } from "@base-ui/react/types";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, FileDiff, Folder, GitBranch, House, Import, LoaderCircle, MessageSquare, Search, SquarePlus, SquareTerminal } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { AGENT_KINDS, DEFAULT_AGENT } from "../../src/agents";
import type { DirsData, FolderData, ImportableData, ImportPreviewData, ImportRow } from "../../src/board";
import type { AgentKind } from "../../src/contracts";
import type { RhReply } from "../../src/router";
import { AgentLogo, ago, ROOM, useMedia } from "./common";
import { buttonVariants } from "./components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { json, type BoardData } from "./data";
import { act, Pick, type Choice } from "./write";

/** The workspaces, with their directories, as the board has them, once it answers; asked only while the
 *  sheet is open, as a refresh asks again for every query in use. */
const usePickerBoard = (open: boolean) => useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), enabled: open }).data;

/** Where a sheet's picker starts (story 540): ws's directory, ~ for none; undefined while the workspaces
 *  are not yet known. */
const startIn = (workspaces: BoardData["workspaces"] | undefined, ws?: string) => (!ws ? "~" : workspaces && (workspaces.find((w) => w.name === ws)?.dir ?? "~"));

/** A form in a sheet: a dialog in the middle of a wide or medium screen, at most 32rem wide, over a dim
 *  ground; from the bottom on a phone (story 635). Its title, its fields, and why the last try failed.
 *  pinned: on a wide screen its top stays put, as high as a full one's, while what is in it grows and
 *  shrinks: what was clicked stays under the mouse. fill: as high as it may be, the same on a phone,
 *  its fields in a column: one of them takes the room left and scrolls, the rest stay put (story 662);
 *  footer under why the last try failed. tall: room kept for the picker's folders dropped down. */
export function Form({ open, close, title, error, submit, pinned, fill, tall, footer, back, step, children }: { open: boolean; close: () => void; title: string; error: string | null; submit: () => void; pinned?: boolean; fill?: boolean; tall?: boolean; footer?: ReactNode; back?: () => void; step?: string; children: ReactNode }) {
  const wide = useMedia(ROOM);
  // A wizard's: the way back before the title, its step after it on the right (spec web-bots "网页").
  const before = back && (
    <button type="button" aria-label="返回" onClick={back} className="-my-2 -ml-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
      <ChevronLeft className="size-5" />
    </button>
  );
  const after = step && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{step}</span>;
  const kb = useKeyboard(open && !wide);
  const go = (e: FormEvent) => (e.preventDefault(), submit());
  const body = (
    // tall: the folders drop down over the fields under them, past a short sheet's end, but for this;
    // over a keyboard, the sheet as high as the room left there instead.
    <form onSubmit={go} style={tall && !kb ? { minHeight: "22rem" } : undefined} className={fill ? "flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4" : cn("grid min-h-0 auto-rows-max grid-cols-1 gap-3 overflow-y-auto px-4 pb-4", tall && kb && "flex-1")}>
      {children}
      {error && <p className="shrink-0 text-sm whitespace-pre-wrap wrap-anywhere text-destructive">{error}</p>}
      {footer}
    </form>
  );
  if (wide)
    return (
      <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup style={pinned ? { top: "7.5dvh", translate: "-50% 0" } : undefined} className={cn("fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] -translate-1/2 flex-col rounded-2xl border bg-popover text-sm text-popover-foreground shadow-lg transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0", fill && "h-[85dvh]")}>
            <div className="flex items-center gap-1 p-4">
              {before}
              <Dialog.Title className="text-base font-medium text-foreground">{title}</Dialog.Title>
              {after}
            </div>
            {body}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      {/* Over the keyboard, no higher than the room left there (a phone's browser leaves what is
          fixed to the bottom under it). */}
      <SheetContent side="bottom" showCloseButton={false} style={kb ? { bottom: kb.under, maxHeight: `min(85dvh, ${kb.room - 8}px)`, ...((fill || tall) && { height: `min(85dvh, ${kb.room - 8}px)` }) } : undefined} className={cn("mx-auto max-h-[85dvh] max-w-xl gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)]", fill && "data-[side=bottom]:h-[85dvh]")}>
        <SheetHeader className="flex-row items-center gap-1">
          {before}
          <SheetTitle>{title}</SheetTitle>
          {after}
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}

/** While on, how much of the screen's bottom the on-screen keyboard covers and the height over it, from
 *  the visual viewport, which a keyboard shrinks and the layout one it leaves; null with none up. A
 *  page zoomed in shrinks it too, and is not taken for one. As it comes up, the field you type in is
 *  brought into sight. */
function useKeyboard(on: boolean) {
  const [kb, setKb] = useState<{ under: number; room: number } | null>(null);
  useEffect(() => {
    const v = visualViewport;
    if (!on || !v) return;
    const measure = () => {
      const under = Math.round(innerHeight - v.height - v.offsetTop);
      // ponytail: 60px tells a keyboard from a browser's bars changing; a split or floating keyboard under that is not seen.
      const up = v.scale < 1.01 && under > 60;
      setKb((o) => (up ? (o?.under === under && o.room === v.height ? o : { under, room: v.height }) : null));
      if (up) requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }));
    };
    measure();
    v.addEventListener("resize", measure);
    v.addEventListener("scroll", measure);
    return () => (v.removeEventListener("resize", measure), v.removeEventListener("scroll", measure), setKb(null));
  }, [on]);
  return kb;
}

export const FIELD = "h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-base outline-none transition-colors hover:border-ring/50 focus:border-ring";

export function Submit({ busy, disabled, children }: { busy: boolean; disabled: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} className={buttonVariants({ size: "lg", className: "h-11 w-full text-base" })}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : children}
    </button>
  );
}

/** Each time open turns on, reset runs: a sheet opened again starts afresh. */
function useFresh(open: boolean, reset: () => void) {
  const [was, setWas] = useState(open);
  if (open !== was) {
    setWas(open);
    if (open) reset();
  }
}


/** Where a sheet makes its slot: the folder, by its path, the workspace there, and whether that is a
 *  new one, to be made. */
type At = Pick<DirsData, "path" | "workspace" | "fresh">;

/** A workspace a sheet was opened from (stories 634, 636, 639): its name and directory. */
type Fixed = { name: string; dir: string };

/** A folder's state on the picker's info line (story 638): icons and numbers, no words; its branch,
 *  files not committed, commits ahead and behind, each only where there is one; then each agent's
 *  conversations there to import, how many and when the newest changed. Sideways as it runs out of room. */
function FolderLine({ git }: { git: FolderData }) {
  const items: [typeof GitBranch, string | number | undefined, string][] = [
    [GitBranch, git.branch, "分支"],
    [FileDiff, git.changed || undefined, "没提交的文件"],
    [ArrowUp, git.ahead || undefined, "领先"],
    [ArrowDown, git.behind || undefined, "落后"],
  ];
  const shown = items.filter(([, v]) => v !== undefined);
  const sessions = AGENT_KINDS.flatMap((a) => (git.sessions?.[a] ? [[a, git.sessions[a]] as const] : []));
  if (!shown.length && !sessions.length) return null;
  return (
    <div data-quiet-scroll="" className="flex min-w-0 items-center gap-3 overflow-x-auto text-sm whitespace-nowrap text-muted-foreground">
      {shown.map(([Icon, v, label]) => (
        <span key={label} title={label} className="inline-flex shrink-0 items-center gap-1 tabular-nums">
          <Icon aria-label={label} className="size-4 shrink-0" />
          {v}
        </span>
      ))}
      {sessions.map(([a, s]) => (
        <span key={a} aria-label={`${a} 的会话`} className="inline-flex shrink-0 items-center gap-1 tabular-nums">
          <AgentLogo agent={a} className="size-4" />
          {s.count}
          <span className="ml-0.5">{ago(s.at)}</span>
        </span>
      ))}
    </div>
  );
}

/** The directory picker (spec web-write "目录选择器"), for a sheet open, starting in start. Its path as
 *  typed: up to its last /, the folder it stands in, listed; past that, what you are typing, which
 *  picks from its folders. Under it the folder's git state, asked once the picker stays on it 300 ms
 *  (story 638). paneIn: the folder a Herdr
 *  pane is picked in, whose slot lands by the pane's own directory: there no workspace's name is asked.
 *  at: that folder, once listed, with nothing typed past it: where the sheet makes its slot. wsName:
 *  the name of the workspace it makes there, where none is, as you edit it. fixed: opened from that
 *  workspace, the picker is a line naming it and its directory, where the sheet makes its slot. go:
 *  takes the picker to a folder. dropped: its folders are down, over what is under the path, from a tap in
 *  the path or on the arrow at its end, till a tap outside, Esc or focus moving away (story 664). */
function useDirPicker(open: boolean, windows: boolean, start: string | undefined, fixed?: Fixed, paneIn?: string, steady = false) {
  const [typed, setTyped] = useState<string | null>(null);
  const [dropped, setDropped] = useState(false);
  const [named, setNamed] = useState<{ path: string; name: string } | null>(null);
  // The last folder's, till this one's comes, as the list's: the sheet stays put as you go.
  const [git, setGit] = useState<FolderData | null>(null);
  useFresh(open, () => (setTyped(null), setNamed(null), setGit(null), setDropped(false)));
  const slash = (p: string) => {
    const path = pickerPath(p, windows);
    return path.endsWith("/") ? path : path + "/";
  };
  const text = fixed ? slash(fixed.dir) : typed !== null ? pickerPath(typed, windows) : start === undefined ? undefined : slash(start);
  const cut = text?.lastIndexOf("/") ?? -1;
  const folder = text === undefined ? undefined : text.slice(0, cut + 1) || text;
  const tail = text?.slice(cut + 1) ?? "";
  // The last folder's, stale, till this one's comes: the sheet stays put as you go.
  const { data: listed, isPlaceholderData: stale } = useQuery({ queryKey: ["dirs", folder], queryFn: () => json<DirsData>(`api/dirs?path=${encodeURIComponent(folder!)}`), enabled: open && folder !== undefined, placeholderData: keepPreviousData });
  // Gone into by a link, or by a workspace's directory: the path is the folder's real one, ~/… under ~.
  useEffect(() => {
    if (!fixed && listed && !stale && !tail && folder?.endsWith("/") && slash(listed.path) !== folder) setTyped(slash(listed.path));
  }, [listed, stale, folder, tail]);
  const listedAt = listed && !stale && !listed.error && !tail ? listed : undefined;
  // git runs: not as you type, nor on every event, as a query would be asked again.
  useEffect(() => {
    const path = listedAt?.path;
    if (!open || fixed || !path) return;
    const stop = new AbortController();
    const wait = setTimeout(() => void json<FolderData>(`api/folder?path=${encodeURIComponent(path)}`, { signal: stop.signal }).then(setGit, () => {}), 300);
    return () => (clearTimeout(wait), stop.abort());
  }, [open, listedAt?.path]);
  // A field shows its start unfocused, and where it was as a folder is gone into: the folder you are in
  // is at its end. Not where you edit inside it.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const f = field.current;
    if (f && (f !== document.activeElement || f.selectionStart === f.value.length)) f.scrollLeft = f.scrollWidth;
  }, [text]);
  // The folder lit by ↑↓ or the mouse, by its name: Tab goes into it.
  const lit = useRef<string | undefined>(undefined);
  // The Autocomplete keeps its lit place as its folders change, lighting a folder none picked. A
  // folder gone into hands it none for one draw, never painted, which drops that place.
  const [seen, setSeen] = useState(folder);
  useLayoutEffect(() => setSeen(folder), [folder]);
  if (fixed) {
    const header = (
      <p className="flex min-w-0 items-center gap-2">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        {/* A long name truncated, the directory keeping its room, up to most of the line. */}
        <span className="min-w-0 truncate font-medium">{fixed.name}</span>
        <span className="max-w-3/5 shrink-0 truncate font-mono text-xs text-muted-foreground">{listed?.path ?? pickerPath(fixed.dir, windows)}</span>
      </p>
    );
    return { at: { path: fixed.dir, workspace: fixed.name, fresh: false } as At, wsName: "", picker: header, go: () => {}, dropped: false };
  }
  const go = (path: string) => setTyped(slash(path));
  // Hidden ones once you type a dot, as a shell completes.
  const shown = listed?.dirs.filter((n) => (tail.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(tail.toLowerCase())) ?? [];
  // Arrows, Enter on a lit folder, Esc, a tap outside and focus moving away are the Autocomplete's own.
  // Down, with something to show: a name typed that none starts with shows nothing.
  const down = dropped && !!(listed?.error || shown.length > 0 || (listed && !tail));
  const key = (e: BaseUIEvent<KeyboardEvent<HTMLInputElement>>) => {
    // Down, with none shown yet (a folder still being listed), Esc folds them alone, as it does once shown.
    if (e.key === "Escape" && dropped && !down) (e.stopPropagation(), e.preventBaseUIHandler(), setDropped(false));
    // None lit: Enter goes into what is typed, never submits the sheet, and keeps the folders down.
    if (e.key === "Enter" && !lit.current) {
      e.preventDefault();
      e.preventBaseUIHandler();
      if (tail) go(text!);
    }
    // As a shell: to one folder, into it; to several, as far as they start alike. Else into the lit one;
    // with neither, out.
    if (e.key === "Tab" && !e.shiftKey && !stale) {
      const alike =
        tail && shown.length
          ? shown.reduce((a, n) => {
              let i = 0;
              while (i < a.length && a[i]!.toLowerCase() === n[i]?.toLowerCase()) i++;
              return a.slice(0, i);
            })
          : "";
      const to = tail && shown.length === 1 ? slash(folder + shown[0]!) : alike.length > tail.length ? folder + alike : lit.current && listed && slash(slash(listed.path) + lit.current);
      if (to) (e.preventDefault(), setTyped(to));
    }
  };
  const wsName = listed && (named?.path === listed.path ? named.name : listed.workspace);
  const at: At | undefined = listedAt;
  const picker = (
    <div className="grid min-w-0 gap-2">
      {/* The whole line is the folders' anchor, and a tap anywhere in it keeps them down. Gone into, a
          folder keeps them down (story 664); none to show, as for a name typed that none starts with,
          they are not. */}
      <Autocomplete.Root
        items={seen === folder ? shown : []}
        filter={null}
        value={text ?? ""}
        onValueChange={(v, d) => (d.reason === "item-press" ? go(slash(listed!.path) + v) : d.reason === "input-change" && setTyped(v))}
        open={down}
        onOpenChange={(o, d) => (o || d.reason !== "item-press") && setDropped(o)}
        onItemHighlighted={(v) => (lit.current = v)}
        openOnInputClick
      >
        {/* The home and up keys, clicked, leave the focus in the path: the folders stay down, the keys go on. */}
        <Autocomplete.InputGroup className="flex gap-2">
          <button type="button" aria-label="家目录" onMouseDown={(e) => e.preventDefault()} onClick={() => go("~")} className={buttonVariants({ variant: "outline", size: "icon", className: "size-11 shrink-0" })}>
            <House className="size-4" />
          </button>
          <div className="relative min-w-0 flex-1">
            <Autocomplete.Input ref={field} aria-label="路径" onKeyDown={key} enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(FIELD, "pr-10 font-mono room:text-sm")} />
            <Autocomplete.Trigger aria-label="文件夹" className="group absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground">
              <ChevronDown className="size-4 transition-transform group-data-popup-open:rotate-180" />
            </Autocomplete.Trigger>
          </div>
          <button type="button" aria-label="上一级" onMouseDown={(e) => e.preventDefault()} disabled={!listed?.up} onClick={() => go(listed!.up!)} className={buttonVariants({ variant: "outline", size: "icon", className: "size-11 shrink-0" })}>
            <ArrowUp className="size-4" />
          </button>
        </Autocomplete.InputGroup>
        <Autocomplete.Portal>
          {/* Over what is under the path, not pushing it down, as high as the room there lets it; as high
              as its folders, one 空 line for none (#758). */}
          <Autocomplete.Positioner sideOffset={4} className="z-50">
            <Autocomplete.Popup inert={stale} className="w-(--anchor-width) rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
              {/* Scrolled inside the popup's padding: a phone's bar, which card-scroll does not move, stays
                  clear of its round corners. Less the padding and border, as high as the popup may be. */}
              <div className="card-scroll max-h-[calc(min(18rem,var(--available-height))-0.625rem)] overflow-y-auto overscroll-contain">
              {/* Why the path lists nothing, or 空; Esc here folds the folders alone, as it does over them. */}
              <Autocomplete.Empty className={cn("px-3 py-2 empty:hidden", listed?.error ? "text-destructive" : "text-muted-foreground")}>{listed?.error ?? "空"}</Autocomplete.Empty>
              <Autocomplete.List aria-label="文件夹">
                {shown.map((n, i) => (
                  <Autocomplete.Item key={n} index={i} value={n} className="flex min-h-11 w-full cursor-default items-center gap-2 rounded-lg px-3 data-highlighted:bg-accent">
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{n}</span>
                  </Autocomplete.Item>
                ))}
              </Autocomplete.List>
              {listed && !tail && shown.length > 0 && listed.more > 0 && <p className="px-3 py-2 text-muted-foreground">+{listed.more}</p>}
              </div>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {/* Folded, why the path lists nothing. steady: the line's room kept, empty too, as the list under it
          would move under a tap. */}
      {!dropped && listed?.error ? <p className="text-sm text-destructive">{listed.error}</p> : steady ? <div className="h-5">{git && <FolderLine git={git} />}</div> : git && <FolderLine git={git} />}
      {listed && !listed.error && listed.fresh && listed.path !== paneIn && (
        <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Folder aria-hidden className="size-4 shrink-0" />
          <input aria-label="工作区名" value={wsName} onChange={(e) => setNamed({ path: listed.path, name: e.target.value })} autoCapitalize="off" spellCheck={false} className="h-9 w-44 min-w-0 rounded-md border bg-background px-2 text-base text-foreground outline-none focus:border-ring" />
        </label>
      )}
    </div>
  );
  return { at, wsName: wsName?.trim() ?? "", picker, go, dropped };
}

/** A new slot's default name in workspace ws (story 636): ws-n, n the least that no slot there has
 *  (taken, archived ones too); ws cut so the whole is a name of at most 64 letters. */
export function defaultName(ws: string, taken: string[]): string {
  const has = new Set(taken);
  for (let n = 1; ; n++) {
    const name = [...ws].slice(0, 64 - `-${n}`.length).join("") + `-${n}`;
    if (!has.has(name)) return name;
  }
}

/** Workspace ws as a sheet opened from it has it (in), from the board's answer; else none. */
const fixedOf = (workspaces: BoardData["workspaces"] | undefined, ws: string | undefined, inWs: boolean | undefined): Fixed | undefined => {
  const w = inWs ? workspaces?.find((x) => x.name === ws) : undefined;
  return w && { name: w.name, dir: w.dir };
};

/** Where a sheet comes from: ws, the workspace whose directory its picker starts in, ~ for none; inWs,
 *  opened from ws itself, in it with no picker. done: told the slot made. */
type From = { open: boolean; close: () => void; ws?: string; inWs?: boolean; done: (slot: string) => void };

/** The new slot's sheet (story 320): its folder, picked, which decides its workspace (story 539); its
 *  name; its agent, by logo. Long-term, in its workspace's directory, as rh new makes it. From a
 *  workspace, in it, its name filled in as the workspace's default one (story 636). */
export function NewSlot({ open, close, ws, inWs, done }: From) {
  const { workspaces, windowsPaths } = usePickerBoard(open) ?? {};
  const fixed = fixedOf(workspaces, ws, inWs);
  const { at, wsName, picker } = useDirPicker(open, !!windowsPaths, startIn(workspaces, ws), fixed);
  // A phone's sheet grows up from the bottom: its folders' room kept from the start, the path stays put.
  const wide = useMedia(ROOM);
  // null: as yet untouched, the default.
  const [typed, setName] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentKind>(DEFAULT_AGENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFresh(open, () => (setName(null), setAgent(DEFAULT_AGENT), setError(null)));
  const w = fixed && workspaces?.find((x) => x.name === fixed.name);
  const name = typed ?? (w ? defaultName(w.name, [...Object.values(w.groups).flat(), ...w.archived].map((c) => c.name)) : "");
  const submit = async () => {
    if (!at) return;
    setBusy(true);
    setError(null);
    // A new workspace first: made, the folder is its, should the slot fail and you try again.
    let r: RhReply = at.fresh ? await act({ kind: "rh", argv: ["ws", wsName, at.path] }) : { ok: true, text: "" };
    if (r.ok) r = await act({ kind: "rh", argv: ["new", `${at.fresh ? wsName : at.workspace}/${name.trim()}`, "--agent", agent] });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    close();
    if (r.slot) done(r.slot);
  };
  return (
    <Form open={open} close={close} title="新建槽位" error={error} submit={() => void submit()} pinned={!fixed} tall={!fixed && !wide}>
      {picker}
      <div className="flex gap-2">
        <input aria-label="槽位名" placeholder="槽位名" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" spellCheck={false} className={FIELD} />
        <AgentPick agent={agent} pick={setAgent} />
      </div>
      <Submit busy={busy} disabled={!at || !name.trim() || (at.fresh && !wsName)}>
        新建
      </Submit>
    </Form>
  );
}

/** The agents, by logo, one picked. */
function AgentPick({ agent, pick, className }: { agent: AgentKind; pick: (a: AgentKind) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="agent" className={cn("flex shrink-0 overflow-hidden rounded-lg border", className)}>
      {AGENT_KINDS.map((a) => (
        <button key={a} type="button" role="radio" aria-checked={agent === a} onClick={() => pick(a)} className={cn("focus-child grid size-11 place-items-center transition focus-visible:opacity-100", agent === a ? "bg-secondary" : "opacity-40 grayscale hover:opacity-70")}>
          <span className="grid size-9 place-items-center rounded-md">
            <AgentLogo agent={a} className="size-5" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** The name an import is given at first (story 646): its title, each run of what no slot's name may have
 *  a -; from its first letter or digit; its first 12; no - at its end. None left, the workspace ws's
 *  default name; one a slot there has (taken, archived ones too), -n after it, as for that. */
export function importName(title: string, ws: string, taken: string[]): string {
  const name = [...title.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/-+/g, "-").replace(/^[^\p{L}\p{N}]+/u, "")].slice(0, 12).join("").replace(/-+$/, "");
  if (!name) return defaultName(ws, taken);
  return taken.includes(name) ? defaultName(name, taken) : name;
}

/** Whether the full-text box is ticked, on this device (story 647). Storage that cannot be used keeps
 *  it unticked. */
const FULL = {
  get: () => {
    try {
      return localStorage.getItem("import-full") === "1";
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.setItem("import-full", "1");
      else localStorage.removeItem("import-full");
    } catch {}
  },
};

/** The import list's pages so far, for one listing (key); where the next starts, if any, and whether the
 *  last stopped as its time ran out; whether one is being asked for, or the last failed. */
type Listing = { key: string; rows: ImportRow[]; cursor?: string; partial?: true; busy: boolean; failed?: true };

/** The import list (story 641): agent's conversations in dir, or every folder's with words and no dir;
 *  with words, those found, in what was said too with full (stories 647-649). Asked only while on: a
 *  new listing cancels the last one's request. more: asks for the next page. Not a query: a refresh,
 *  as the board's events bring, would ask for every page again. */
function useImportable(on: boolean, agent: AgentKind, dir: string | undefined, words: string, full: boolean) {
  const key = on ? JSON.stringify([agent, dir ?? null, words, !!words && full]) : "";
  const [listing, setListing] = useState<Listing | null>(null);
  const asking = useRef<AbortController | null>(null);
  const ask = (cursor?: string) => {
    asking.current?.abort();
    const stop = (asking.current = new AbortController());
    const q = new URLSearchParams({ agent, ...(dir && { dir }), ...(words && { q: words }), ...(words && full && { full: "1" }), ...(cursor && { cursor }) });
    // Only a next page adds to the rows so far: a first one, as on reopening with the same key, starts afresh.
    setListing((l) => (cursor && l?.key === key ? { ...l, busy: true, failed: undefined } : { key, rows: [], busy: true }));
    json<ImportableData>(`api/importable?${q}`, { signal: stop.signal }).then(
      (p) => setListing((l) => (l?.key === key ? { key, rows: [...l.rows, ...p.list], cursor: p.cursor, partial: p.partial, busy: false } : l)),
      () => !stop.signal.aborted && setListing((l) => (l?.key === key ? { ...l, busy: false, failed: true } : l)),
    );
  };
  useEffect(() => {
    if (key) ask();
    return () => asking.current?.abort();
  }, [key]);
  const shown = listing?.key === key ? listing : null;
  return { key, listing: shown, more: () => shown && !shown.busy && shown.cursor && ask(shown.cursor) };
}

/** Calls seen each time it comes into view, and again as again changes while in view. */
function Seen({ seen, again, children }: { seen: () => void; again: unknown; children?: ReactNode }) {
  const at = useRef<HTMLLIElement>(null);
  const call = useRef(seen);
  call.current = seen;
  useEffect(() => {
    const o = new IntersectionObserver(([e]) => e?.isIntersecting && call.current());
    o.observe(at.current!);
    return () => o.disconnect();
  }, [again]);
  return (
    <li ref={at} className="px-3 py-2 text-sm text-muted-foreground">
      {children}
    </li>
  );
}

/** text, the first place words are in it, ASCII letters in any case, in bold; or as it is. */
function Marked({ text, words }: { text: string; words?: string }) {
  const fold = (t: string) => t.replace(/[A-Z]+/g, (c) => c.toLowerCase());
  const at = words ? fold(text).indexOf(fold(words)) : -1;
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <b className="font-semibold text-foreground">{text.slice(at, at + words!.length)}</b>
      {text.slice(at + words!.length)}
    </>
  );
}

/** A conversation on the import list (stories 642, 643, 648): its title, the words in it marked where
 *  a search found them there; open in Herdr, or when it last changed, how many things were said, its
 *  branch, and its folder where every folder's are listed (all); where a full-text search found the
 *  words in a message. Picked, ticked, with children, its preview, under it. */
function ImportItem({ row, picked, all, words, pick, children }: { row: ImportRow; picked: boolean; all: boolean; words: string; pick: () => void; children?: ReactNode }) {
  const icon = "size-3.5 shrink-0";
  return (
    <li>
      {/* Picked, not lit under the mouse: its tick and its preview say so. */}
      <button type="button" role="radio" aria-checked={picked} onClick={pick} className={cn("grid w-full min-w-0 gap-0.5 rounded-lg px-3 py-2 text-left", !picked && "hover:bg-accent")}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{row.title ? <Marked text={row.title} words={row.hit ? undefined : words} /> : row.session.slice(0, 8)}</span>
          {picked && <Check className="size-4 shrink-0 text-running" />}
        </span>
        <span className="flex min-w-0 items-center gap-3 overflow-hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {row.pane ? (
            <>
              <span className="inline-flex shrink-0 items-center gap-1">
                <SquareTerminal className={icon} />在 Herdr 里开着
              </span>
              {all && <span className="min-w-0 truncate font-mono">{row.dir}</span>}
            </>
          ) : (
            <>
              <span className="shrink-0">{ago(row.at)}</span>
              <span className="inline-flex shrink-0 items-center gap-1" aria-label="消息条数">
                <MessageSquare className={icon} />
                {row.count}
              </span>
              {row.branch && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch className={icon} />
                  <span className="truncate">{row.branch}</span>
                </span>
              )}
              {all && <span className="min-w-0 truncate font-mono">{row.dir}</span>}
            </>
          )}
        </span>
        {row.hit && (
          <span className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
            {row.hit.text.slice(0, row.hit.from)}
            <b className="font-semibold text-foreground">{row.hit.text.slice(row.hit.from, row.hit.to)}</b>
            {row.hit.text.slice(row.hit.to)}
          </span>
        )}
      </button>
      {picked && children}
    </li>
  );
}

/** The chat's code, which draws what was said, once a preview brought it. */
let chat: typeof import("./slot") | undefined;

const TOP = 4; // px from a preview's top that count as there

/** The picked conversation under its row (story 666): what you and the agent said, as the chat draws
 *  it, with no time or keys; in a box of its own, 20rem high at most on a wide screen, 45dvh on a phone,
 *  less where the list has less room under its row (on a phone, a row's worth less, a row beside it
 *  showing, and its scroll running on into the list's at its ends), opened at the newest, its row and it brought into sight. Scrolled to its top, the page before comes
 *  in above, what you read staying put. 读不到 for one that cannot be read. */
function Preview({ agent, session }: { agent: AgentKind; session: string }) {
  const [said, setSaid] = useState<ImportPreviewData | "gone" | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Before a page before comes in, how far the bottom was from where you read; null: open at the newest.
  const kept = useRef<number | null>(null);
  const paging = useRef(false);
  // The page coming in was asked for on its own, to fill the box, not by your scrolling to its top.
  const filling = useRef(false);
  const ask = (before?: number) => json<ImportPreviewData>(`api/importable/messages?${new URLSearchParams({ agent, session, ...(before !== undefined && { before: String(before) }) })}`);
  useEffect(() => {
    let on = true;
    Promise.all([ask(), import("./slot")]).then(
      ([d, m]) => on && ((chat = m), setSaid(d)),
      () => on && setSaid("gone"),
    );
    return () => void (on = false);
  }, [agent, session]);
  const earlier = (auto = false) => {
    const el = box.current;
    if (!el || paging.current || !said || said === "gone" || said.before === undefined || el.scrollTop > TOP) return;
    paging.current = true;
    filling.current = auto;
    setBusy(true);
    kept.current = el.scrollHeight - el.scrollTop;
    const done = () => ((paging.current = false), setBusy(false));
    // Failed: tried again as you next scroll to the top.
    ask(said.before).then(
      (d) => (done(), setSaid((o) => (o && o !== "gone" ? { blocks: [...d.blocks, ...o.blocks], before: d.before } : o))),
      () => (done(), (kept.current = null)),
    );
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // No higher than the list's room under its row (100cqh: the list's height).
    el.style.setProperty("--head", `${(el.closest("li")?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0}px`);
    const first = kept.current === null;
    el.scrollTop = first ? el.scrollHeight : el.scrollHeight - kept.current!;
    kept.current = null;
    // Too low on the list to see whole, as opened or as the pages brought to fill it grew it: brought up.
    if (first || filling.current) el.closest("li")?.scrollIntoView({ block: "nearest" });
    // A page shorter than the box, or one with nothing said: no scroll would bring the one before.
    earlier(true);
  }, [said]);
  if (!said) return <LoaderCircle aria-label="正在读" className="mx-auto my-2 size-5 animate-spin text-muted-foreground" />;
  if (said === "gone") return <p className="px-3 pb-2 text-sm text-muted-foreground">读不到</p>;
  const Said = chat!.Said;
  return (
    <div className="relative mx-2 mb-2">
      <div ref={box} role="log" aria-label="预览" onScroll={() => earlier()} className="card-scroll max-h-[min(45dvh,calc(100cqh-var(--head)-3.5rem))] overflow-y-auto rounded-xl border px-3 py-2.5 room:max-h-[min(20rem,calc(100cqh-var(--head)-0.5rem))] room:overscroll-contain">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
          {said.blocks.map((b) => (
            <Said key={b.at} b={{ ...b, time: null }} conversation="" />
          ))}
        </div>
      </div>
      {busy && <LoaderCircle aria-label="正在读" className="absolute top-2 left-1/2 size-5 -translate-x-1/2 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** The import sheet (stories 321, 641-649): its folder, picked, or the workspace's; an agent, by logo,
 *  then its conversations there, Herdr's panes first, more as you scroll; a search box, over titles, or
 *  what was said too once ticked; from the top, a search looks in every folder, and picking one found
 *  takes the picker to its folder. One picked, its slot's name, filled in from its title. */
function ImportSheet({ open, close, ws, inWs, done }: From) {
  const { workspaces, windowsPaths } = usePickerBoard(open) ?? {};
  const fixed = fixedOf(workspaces, ws, inWs);
  const [agent, setAgent] = useState<AgentKind>(DEFAULT_AGENT);
  const [typed, setTyped] = useState("");
  const [words, setWords] = useState("");
  const [full, setFull] = useState(FULL.get);
  const [picked, setPicked] = useState<ImportRow | null>(null);
  // null: as yet untouched, from the title.
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFresh(open, () => (setAgent(DEFAULT_AGENT), setTyped(""), setWords(""), setFull(FULL.get()), setPicked(null), setName(null), setError(null)));
  // Searched once typing rests 300 ms.
  useEffect(() => {
    const wait = setTimeout(() => setWords(typed.trim()), 300);
    return () => clearTimeout(wait);
  }, [typed]);
  // A pane's slot lands by the pane's own directory: no workspace is made, or shown, for the folder.
  const dirs = useDirPicker(open, !!windowsPaths, startIn(workspaces, ws), fixed, picked?.pane ? picked.dir : undefined, true);
  const { picker, go, dropped } = dirs;
  // While the folders are down, the list, its pick and the name stay the last folder's; folded, the new
  // one's (story 665).
  const kept = useRef(dirs);
  if (!dropped) kept.current = dirs;
  const { at, wsName } = kept.current;
  // From the top, a search looks in every folder; else the list is the folder's.
  const all = !fixed && !!words;
  const dir = fixed ? fixed.dir : all ? undefined : at?.path;
  const { key, listing, more } = useImportable(open && (all || dir !== undefined), agent, dir, words, full);
  // A new listing, a new pick, at once: none is imported from a folder left behind.
  const [listed, setListed] = useState(key);
  if (key !== listed) (setListed(key), setPicked(null), setName(null));
  // The picked one tapped again folds its preview: on a phone it may fill the list.
  const pick = (row: ImportRow) => {
    if (picked === row) return (setPicked(null), setName(null));
    setPicked(row);
    setName(null);
    if (all) go(row.dir);
  };
  const home = picked?.pane ? undefined : at && (at.fresh ? wsName : at.workspace);
  const w = home ? workspaces?.find((x) => x.name === home) : undefined;
  const taken = w ? [...Object.values(w.groups).flat(), ...w.archived].map((c) => c.name) : [];
  const shownName = name ?? (picked && home ? importName(picked.title, home, taken) : "");
  const submit = async () => {
    if (!at || !picked) return;
    setBusy(true);
    setError(null);
    // A conversation in a folder no workspace has lands in one the import makes for it, by the name
    // suggested (src/router.ts workspaceFor): made first only when you renamed it.
    let r: RhReply = at.fresh && !picked.pane && wsName !== at.workspace ? await act({ kind: "rh", argv: ["ws", wsName, at.path] }) : { ok: true, text: "" };
    if (r.ok) r = await act({ kind: "rh", argv: ["import", picked.pane ?? picked.session, ...(shownName.trim() ? ["--name", shownName.trim()] : [])] });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    close();
    if (r.slot) done(r.slot);
  };
  const rows = listing?.rows ?? [];
  return (
    <Form
      open={open}
      close={close}
      title="导入"
      error={error}
      submit={() => void submit()}
      pinned
      fill
      footer={
        <Submit busy={busy} disabled={!picked || !at || (at.fresh && !wsName && !picked.pane)}>
          导入
        </Submit>
      }
    >
      <div className="grid shrink-0 gap-3">
        {picker}
        <div className="flex gap-2">
          <input aria-label="槽位名" placeholder="槽位名" value={shownName} onChange={(e) => setName(e.target.value)} autoCapitalize="off" spellCheck={false} className={FIELD} />
          <AgentPick agent={agent} pick={setAgent} />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3.5 text-muted-foreground focus-within:text-foreground">
            <Search aria-hidden className="size-4 shrink-0" />
            {/* Text, not search: no browser's own clear button, unstyled. Enter searches at once, never submits the import. */}
            <input role="searchbox" enterKeyHint="search" aria-label="搜索" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), setWords(typed.trim()))} autoCapitalize="off" spellCheck={false} className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none" />
          </label>
          <button type="button" role="checkbox" aria-checked={full} onClick={() => (FULL.set(!full), setFull(!full))} className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <span className={cn("grid size-4 place-items-center rounded border border-muted-foreground/50 transition-colors", full && "border-running bg-running text-white")}>{full && <Check className="size-3" strokeWidth={3} />}</span>
            全文搜索
          </button>
        </div>
      </div>
      {/* The one scroll in the dialog, the room between the search and 导入 (story 662). */}
      <ul role="radiogroup" aria-label="导入哪一段" className="-mx-1 grid [container-type:size] min-h-0 min-w-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto overscroll-contain">
        {rows.map((row) => (
          <ImportItem key={row.pane ?? row.session} row={row} picked={picked === row} all={all} words={words} pick={() => pick(row)}>
            {picked === row && <Preview agent={agent} session={row.session} />}
          </ImportItem>
        ))}
        {!listing ? null : listing.cursor ? (
          // Seen anew only at a new cursor: a page that failed is asked for again once tapped or scrolled back to.
          <Seen seen={more} again={listing.cursor}>
            {listing.busy ? (
              <LoaderCircle aria-label="正在找" className="mx-auto size-5 animate-spin" />
            ) : listing.failed ? (
              <button type="button" onClick={more} className="text-destructive">
                没能列出
              </button>
            ) : listing.partial ? (
              "没搜完"
            ) : (
              <LoaderCircle className="mx-auto size-5 animate-spin" />
            )}
          </Seen>
        ) : listing.busy ? (
          <li className="py-2">
            <LoaderCircle aria-label="正在找" className="mx-auto size-5 animate-spin text-muted-foreground" />
          </li>
        ) : listing.failed ? (
          <li className="px-3 py-2 text-sm text-destructive">没能列出</li>
        ) : (
          !rows.length && <li className="px-3 py-2 text-sm text-muted-foreground">{words ? "没有找到可导入的会话" : "该路径下没有可导入的会话"}</li>
        )}
      </ul>
    </Form>
  );
}

/** The bot wizard (spec web-bots "网页"), loaded once opened. */
const BotWizard = lazy(() => import("./bot-wizard").then((m) => ({ default: m.BotWizard })));

/** 新建 Bot, greyed while there is no slot to give a bot's messages to (story 671). slots: whether
 *  there is a live one, undefined while not known. */
export const newBot = (slots: boolean | undefined, run: () => void): Choice => ({ icon: Bot, label: "新建 Bot", run, ...(slots === false && { off: "先新建一个槽位，Bot 的消息才有地方去" }) });

/** Whether there is a slot not archived, by the board's answer; undefined till it comes. */
export const hasSlots = (data: BoardData | undefined) => data && data.workspaces.some((w) => Object.values(w.groups).some((g) => g.length));

/** The home's + (spec web-write "页面", spec web-bots story 670): 新建槽位, 导入 or 新建 Bot, each in
 *  its sheet; a slot made opens its chat, from the home with the way back there, as the list's row (up). */
export function CreateMenu({ className, children }: { className?: string; children: ReactNode }) {
  const [at, setLocation] = useLocation();
  const [open, setOpen] = useState<"new" | "import" | "bot" | null>(null);
  // The list's answer as it has it: no second ask of its own as the + comes (#356).
  const slots = hasSlots(useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), refetchOnMount: false }).data);
  const done = (slot: string) => setLocation(`/slot/${encodeURIComponent(slot)}`, { state: at === "/" ? { up: "list" } : null });
  const choices = [
    { icon: SquarePlus, label: "新建槽位", run: () => setOpen("new") },
    { icon: Import, label: "导入", run: () => setOpen("import") },
    newBot(slots, () => setOpen("bot")),
  ];
  return (
    <>
      <Pick label="新建" choices={choices} className={className}>
        {children}
      </Pick>
      <Sheets open={open} close={() => setOpen(null)} done={done} />
    </>
  );
}

/** 新建槽位, 导入 or 新建 Bot (open: which; null, none), from workspace ws: in it with no picker (inWs,
 *  stories 634, 639); else with the picker starting in its directory, ~ for none, as the sidebar's
 *  buttons on top do (story 424). done: told the slot made. */
export function Sheets({ open, close, ws, inWs, done }: { open: "new" | "import" | "bot" | null; close: () => void; ws?: string; inWs?: boolean; done: (slot: string) => void }) {
  // Mounted once first opened, so it closes as a dialog does.
  const [bot, setBot] = useState(false);
  if (open === "bot" && !bot) setBot(true);
  return (
    <>
      <NewSlot open={open === "new"} close={close} ws={ws} inWs={inWs} done={done} />
      <ImportSheet open={open === "import"} close={close} ws={ws} inWs={inWs} done={done} />
      {bot && (
        <Suspense>
          <BotWizard open={open === "bot"} close={close} />
        </Suspense>
      )}
    </>
  );
}
