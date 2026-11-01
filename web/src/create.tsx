// New slots and imports from the board (spec web-write "新建和导入", stories 320, 321): a sheet each,
// new slots from the home's + or a workspace's details on the topology, imports from the home's +, both
// in a folder picked in the directory picker (stories 538-542). What is made opens its chat. Loaded only
// once the + shows: the board's first screen stays light.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowUp, Check, ChevronRight, CircleDot, Folder, GitBranch, House, Import, LoaderCircle, Search, SquarePlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { AGENT_KINDS, DEFAULT_AGENT } from "../../src/agents";
import type { DirsData } from "../../src/board";
import type { AgentKind } from "../../src/contracts";
import type { Candidate } from "../../src/panels";
import type { RhReply } from "../../src/router";
import { AgentLogo } from "./common";
import { buttonVariants } from "./components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { json, type BoardData } from "./data";
import { act, Pick } from "./write";

/** The workspaces, with their directories, as the board has them, once it answers; asked only while the
 *  sheet is open, as a refresh asks again for every query in use. */
const useWorkspaces = (open: boolean) => useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), enabled: open }).data?.workspaces;

/** Where a sheet's picker starts (story 540): ws's directory, ~ for none; undefined while the workspaces
 *  are not yet known. */
const startIn = (workspaces: BoardData["workspaces"] | undefined, ws?: string) => (!ws ? "~" : workspaces && (workspaces.find((w) => w.name === ws)?.dir ?? "~"));

/** A sheet from the bottom with a form: its title, its fields, and why the last try failed. */
function Form({ open, close, title, error, submit, children }: { open: boolean; close: () => void; title: string; error: string | null; submit: () => void; children: ReactNode }) {
  const go = (e: FormEvent) => (e.preventDefault(), submit());
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent side="bottom" showCloseButton={false} className="mx-auto max-h-[85dvh] max-w-xl gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <form onSubmit={go} className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto px-4 pb-4">
          {children}
          {error && <p className="text-sm whitespace-pre-wrap wrap-anywhere text-destructive">{error}</p>}
        </form>
      </SheetContent>
    </Sheet>
  );
}

const FIELD = "h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-base outline-none transition-colors hover:border-ring/50 focus:border-ring";

function Submit({ busy, disabled, children }: { busy: boolean; disabled: boolean; children: ReactNode }) {
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

const slash = (p: string) => (p.endsWith("/") ? p : `${p}/`);

/** The directory picker (spec web-write "目录选择器"), for a sheet open, starting in start. Its path as
 *  typed: up to its last /, the folder it stands in, listed; past that, what you are typing, which
 *  picks from its folders. extra: a button more beside the path, for the folder at. paneIn: the folder
 *  a Herdr pane is picked in, whose slot lands by the pane's own directory: there no workspace shows.
 *  at: that folder, once listed, with nothing typed past it: where the sheet makes its slot. wsName:
 *  the name of the workspace it makes there, where none is, as you edit it. */
function useDirPicker(open: boolean, start: string | undefined, workspaces: BoardData["workspaces"] = [], extra?: (at: DirsData | undefined) => ReactNode, paneIn?: string) {
  const [typed, setTyped] = useState<string | null>(null);
  const [named, setNamed] = useState<{ path: string; name: string } | null>(null);
  useFresh(open, () => (setTyped(null), setNamed(null)));
  const text = typed ?? (start === undefined ? undefined : slash(start));
  const cut = text?.lastIndexOf("/") ?? -1;
  const folder = text === undefined ? undefined : text.slice(0, cut + 1) || text;
  const tail = text?.slice(cut + 1) ?? "";
  // The last folder's, stale, till this one's comes: the sheet stays put as you go.
  const { data: listed, isPlaceholderData: stale } = useQuery({ queryKey: ["dirs", folder], queryFn: () => json<DirsData>(`api/dirs?path=${encodeURIComponent(folder!)}`), enabled: open && folder !== undefined, placeholderData: keepPreviousData });
  // Gone into by a link, or by a workspace's directory: the path is the folder's real one, ~/… under ~.
  useEffect(() => {
    if (listed && !stale && !tail && folder?.endsWith("/") && slash(listed.path) !== folder) setTyped(slash(listed.path));
  }, [listed, stale, folder, tail]);
  // Unfocused, a field shows its start: the folder you are in is at its end.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const f = field.current;
    if (f && f !== document.activeElement) f.scrollLeft = f.scrollWidth;
  }, [text]);
  const go = (path: string) => setTyped(slash(path));
  // Hidden ones once you type a dot, as a shell completes.
  const shown = listed?.dirs.filter((n) => (tail.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(tail.toLowerCase())) ?? [];
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (tail) go(text!);
    }
    // To one folder, into it; to several, as far as they start alike; with no more to add, out.
    if (e.key === "Tab" && !e.shiftKey && tail && shown.length && !stale) {
      const alike = shown.reduce((a, n) => {
        let i = 0;
        while (i < a.length && a[i]!.toLowerCase() === n[i]?.toLowerCase()) i++;
        return a.slice(0, i);
      });
      const to = shown.length === 1 ? slash(folder + shown[0]!) : alike.length > tail.length ? folder + alike : undefined;
      if (to) (e.preventDefault(), setTyped(to));
    }
  };
  const wsName = listed && (named?.path === listed.path ? named.name : listed.workspace);
  const at = listed && !stale && !listed.error && !tail ? listed : undefined;
  const picker = (
    <div className="grid min-w-0 gap-2">
      <div className="flex gap-2">
        <button type="button" aria-label="家目录" onClick={() => go("~")} className={buttonVariants({ variant: "outline", size: "icon", className: "size-11 shrink-0" })}>
          <House className="size-4" />
        </button>
        <input ref={field} aria-label="路径" value={text ?? ""} onChange={(e) => setTyped(e.target.value)} onKeyDown={key} enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(FIELD, "font-mono text-sm")} />
        <button type="button" aria-label="上一级" disabled={!listed?.up} onClick={() => go(listed!.up!)} className={buttonVariants({ variant: "outline", size: "icon", className: "size-11 shrink-0" })}>
          <ArrowUp className="size-4" />
        </button>
        {extra?.(at)}
      </div>
      <div role="group" aria-label="工作区" className="flex gap-2 overflow-x-auto">
        {workspaces.map((w) => {
          const here = !!listed && !listed.fresh && listed.workspace === w.name;
          return (
            <button key={w.name} type="button" aria-pressed={here} onClick={() => go(w.dir)} className={cn("h-9 shrink-0 rounded-full border px-3 text-sm transition-colors", here ? "bg-secondary" : "hover:bg-muted")}>
              {w.name}
            </button>
          );
        })}
      </div>
      {listed && !listed.error && (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {listed.branch && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <GitBranch className="size-4 shrink-0" />
                <span className="truncate">{listed.branch}</span>
              </span>
            )}
            {listed.path !== paneIn && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Folder className="size-4 shrink-0" />
                {listed.fresh ? (
                  <input aria-label="工作区名" value={wsName} onChange={(e) => setNamed({ path: listed.path, name: e.target.value })} autoCapitalize="off" spellCheck={false} className="h-9 w-44 min-w-0 rounded-md border bg-background px-2 text-base text-foreground outline-none focus:border-ring" />
                ) : (
                  <span className="truncate text-foreground">{listed.workspace}</span>
                )}
              </span>
            )}
            {listed.slots > 0 && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <CircleDot className="size-4" />
                {listed.slots}
              </span>
            )}
          </div>
          {listed.files.length > 0 && (
            <p className="flex min-w-0 gap-2 font-mono text-xs text-muted-foreground">
              <span className="truncate">{listed.files.join("  ")}</span>
              {listed.moreFiles > 0 && <span>+{listed.moreFiles}</span>}
            </p>
          )}
        </>
      )}
      {/* One height for the list or why there is none: the sheet stays put as you go. A style, not a
          class: the first screen's styles are at their size limit (architecture §2). */}
      <div style={{ height: "min(35dvh, 20rem)" }} inert={stale} className="overflow-y-auto">
        {listed?.error ? (
          <p className="text-sm text-destructive">{listed.error}</p>
        ) : (
          <ul aria-label="文件夹">
            {shown.map((n) => (
              <li key={n}>
                <button type="button" onClick={() => go(slash(listed!.path) + n)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left hover:bg-accent">
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{n}</span>
                </button>
              </li>
            ))}
            {listed && !tail && (shown.length ? listed.more > 0 && <li className="px-3 py-2 text-sm text-muted-foreground">+{listed.more}</li> : <li className="px-3 py-2 text-sm text-muted-foreground">空</li>)}
          </ul>
        )}
      </div>
    </div>
  );
  return { at, wsName: wsName?.trim() ?? "", picker };
}

/** The new slot's sheet (story 320): its folder, picked, which decides its workspace (story 539); its
 *  name; its agent, by logo. Long-term, in its workspace's directory, as rh new makes it. ws: the
 *  workspace whose directory the picker starts in, ~ for none. done: told the slot made. */
export function NewSlot({ open, close, ws, done }: { open: boolean; close: () => void; ws?: string; done: (slot: string) => void }) {
  const workspaces = useWorkspaces(open);
  const { at, wsName, picker } = useDirPicker(open, startIn(workspaces, ws), workspaces);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<AgentKind>(DEFAULT_AGENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFresh(open, () => (setName(""), setAgent(DEFAULT_AGENT), setError(null)));
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
    <Form open={open} close={close} title="新建槽位" error={error} submit={() => void submit()}>
      {picker}
      <div className="flex gap-2">
        <input aria-label="槽位名" placeholder="槽位名" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" spellCheck={false} className={FIELD} />
        <div role="radiogroup" aria-label="agent" className="flex shrink-0 overflow-hidden rounded-lg border">
          {AGENT_KINDS.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={agent === a} onClick={() => setAgent(a)} className={cn("focus-child grid size-11 place-items-center transition focus-visible:opacity-100", agent === a ? "bg-secondary" : "opacity-40 grayscale hover:opacity-70")}>
              <span className="grid size-9 place-items-center rounded-md">
                <AgentLogo agent={a} className="size-5" />
              </span>
            </button>
          ))}
        </div>
      </div>
      <Submit busy={busy} disabled={!at || !name.trim() || (at.fresh && !wsName)}>
        新建
      </Submit>
    </Form>
  );
}

/** rh import's argv for what IM's /rh_import panel lists, "/rh_import <id> --name", named so; with no
 *  name, by its default one. */
export const importArgv = (command: string, name: string) => ["import", command.split(" ")[1]!, ...(name.trim() ? ["--name", name.trim()] : [])];

/** The import sheet (story 321): its folder, picked, then what there is to import there, the agents in
 *  Herdr's panes and the conversations in the folder, as IM's /rh_import lists them, looked for once you
 *  list them (story 542); one picked, its slot's name, empty for the default. ws: the workspace whose
 *  directory the picker starts in, ~ for none. done: told the slot made. */
function ImportSheet({ open, close, ws, done }: { open: boolean; close: () => void; ws?: string; done: (slot: string) => void }) {
  const workspaces = useWorkspaces(open);
  const [found, setFound] = useState<{ dir: string; reply: RhReply | null } | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFresh(open, () => (setFound(null), setPicked(null), setName(""), setError(null)));
  // Each listing is an act, which logs an event and refreshes the page: on 列出 alone, not as you go.
  const list = (dir: string) => {
    setFound({ dir, reply: null });
    setPicked(null);
    void act({ kind: "rh", argv: ["import", "--dir", dir] }).then((reply) => setFound((f) => (f?.dir === dir ? { dir, reply } : f)));
  };
  const lister = (at: DirsData | undefined) => (
    <button type="button" aria-label="列出" disabled={!at} onClick={() => list(at!.path)} className={buttonVariants({ variant: "outline", size: "icon", className: "size-11 shrink-0" })}>
      <Search className="size-4" />
    </button>
  );
  // A pane's slot lands by the pane's own directory: its candidates read "Herdr 里" (src/commands.ts
  // rh_import). No workspace is made, or shown, for the folder.
  const paneIn = picked?.label.startsWith("Herdr ") ? found?.dir : undefined;
  const { at, wsName, picker } = useDirPicker(open, startIn(workspaces, ws), workspaces, lister, paneIn);
  // What was found here, not in a folder you have left.
  const here = found && found.dir === at?.path ? found : null;
  const chosen = here?.reply && picked;
  const submit = async () => {
    if (!at || !chosen) return;
    setBusy(true);
    setError(null);
    // A conversation in a folder no workspace has lands in one the import makes for it, by the name
    // suggested (src/router.ts workspaceFor): made first only when you renamed it.
    let r: RhReply = at.fresh && !paneIn && wsName !== at.workspace ? await act({ kind: "rh", argv: ["ws", wsName, at.path] }) : { ok: true, text: "" };
    if (r.ok) r = await act({ kind: "rh", argv: importArgv(chosen.command, name) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    close();
    if (r.slot) done(r.slot);
  };
  const candidates = here?.reply?.ok ? here.reply.panel?.candidates : undefined;
  return (
    <Form open={open} close={close} title="导入" error={error ?? (here?.reply && !here.reply.ok ? here.reply.error : null)} submit={() => void submit()}>
      {picker}
      {!here ? null : !here.reply ? (
        <LoaderCircle aria-label="正在找" className="mx-auto my-3 size-5 animate-spin text-muted-foreground" />
      ) : candidates ? (
        <div role="radiogroup" aria-label="导入哪一个" className="grid grid-cols-1">
          {candidates.map((c) => (
            <button key={c.command} type="button" role="radio" aria-checked={picked === c} onClick={() => setPicked(c)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-left hover:bg-accent">
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {picked === c && <Check className="size-4 shrink-0 text-running" />}
            </button>
          ))}
        </div>
      ) : (
        here.reply.ok && <p className="text-sm text-muted-foreground">{here.reply.text}</p>
      )}
      {chosen && (
        <>
          <input aria-label="槽位名" placeholder="槽位名" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" spellCheck={false} className={FIELD} />
          <Submit busy={busy} disabled={at?.fresh === true && !wsName && !paneIn}>
            导入
          </Submit>
        </>
      )}
    </Form>
  );
}

/** The home's + (spec web-write "页面"): 新建槽位 or 导入, each in its sheet; what is made opens its chat,
 *  from the home with the way back there, as the list's row (up). */
export function CreateMenu({ className, children }: { className?: string; children: ReactNode }) {
  const [at, setLocation] = useLocation();
  const [open, setOpen] = useState<"new" | "import" | null>(null);
  const done = (slot: string) => setLocation(`/slot/${encodeURIComponent(slot)}`, { state: at === "/" ? { up: "list" } : null });
  const choices = [
    { icon: SquarePlus, label: "新建槽位", run: () => setOpen("new") },
    { icon: Import, label: "导入", run: () => setOpen("import") },
  ];
  return (
    <>
      <Pick label="新建" choices={choices} className={className}>
        {children}
      </Pick>
      <NewSlot open={open === "new"} close={() => setOpen(null)} done={done} />
      <ImportSheet open={open === "import"} close={() => setOpen(null)} done={done} />
    </>
  );
}

/** Maximize mode's sidebar's 新建槽位 and 导入 (open: which), starting in workspace ws's directory
 *  (story 424); done: told the slot made. */
export function SideSheets({ open, close, ws, done }: { open: "new" | "import"; close: () => void; ws?: string; done: (slot: string) => void }) {
  return (
    <>
      <NewSlot open={open === "new"} close={close} ws={ws} done={done} />
      <ImportSheet open={open === "import"} close={close} ws={ws} done={done} />
    </>
  );
}
