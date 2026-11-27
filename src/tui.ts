// Switching a slot to the terminal and back, Herdr's side (architecture §10). Once the router has seen
// the headless agent exit, this takes the conversation lock, makes sure nothing else has the
// conversation, and opens it in a tab of the workspace's Herdr workspace; what came of it goes back to
// the main loop as a tui input. Then it watches the agent there, and Herdr itself: once the agent is
// gone it closes its pane and says so with a tui_back input; Herdr going away and coming back are herdr
// inputs. It also tells rhodium which TUI agent an rh with no token runs under. rh import looks here
// too: for a conversation on disk or the agent in a Herdr pane, with the same check that no one else
// uses it; an imported pane is watched as one switched to.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { localDrivePath, sameDirectory } from "./paths";
import { holders } from "./session-processes";
import { piPaneHasCredentials } from "./pi-pane-credentials";
import { windows } from "./windows";
import { detached } from "./detached";
import { nativeProcess } from "./tui-process";
import { lastSettings, managedVimFile, nativeVimLaunch, rememberVimLaunch, type VimLaunch } from "./tui-vim";
import { windowsConversationLock } from "./tui-lock";
import { isWindowsAgentNodeEntry, windowsPaneCommand } from "./windows-tui-launch";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AGENTS, AGENT_KINDS, terminalUnset, TYPING } from "./agents";
import { claudeFlags } from "./claude";
import { locate, type Config } from "./config";
import type { AgentKind, Capabilities, Importable, ImportFound, Input, TuiPane, Used } from "./contracts";
import { saveMedia } from "./media";
import { lock, log, type Loop } from "./daemon";
import { call, request, sessionSocket, subscribe } from "./herdr";
import { holderPaths } from "./holder";
import { start as fresh } from "./render";
import { BOARD, IN_TUI, type Effect } from "./router";
import { agentBaseEnv, childEnv, slotToken, writePrompt } from "./runner";
import { splitSource } from "./prompt";
import { namesOf, type AgentInput, type Conversation as Conv, type Slot, type Store, type Tx } from "./store";
import { codexCall, findConversations, hasTranscript, listConversations, piSettings, readPage, sessionsDir, settingsIn as ranOn, startedIn, transcriptFile, type Conversation } from "./transcript";

/** A process's state, parent and start time (/proc/<pid>/stat); null once it is gone. */
function procStat(pid: number): { state: string; ppid: number; start: number } | null {
  if (detached) return nativeProcess(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Its name may hold spaces and parentheses: the fields go on after the last ")".
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: f[0]!, ppid: Number(f[1]), start: Number(f[19]) };
  } catch {
    return null;
  }
}

/** Whether the process that started at `start` still runs under this pid: a pid alone may be reused. */
function running(pid: number, start: number | null): boolean {
  const s = procStat(pid);
  return s !== null && s.start === start && s.state !== "Z";
}

/** Waits up to ms for the process to be gone; whether it is. */
async function gone(pid: number, start: number | null, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; running(pid, start) && Date.now() < end; ) await Bun.sleep(100);
  return !running(pid, start);
}

/** How often the Herdr bridge tries Herdr again while it is away (architecture §10.2), and looks at
 *  the agents in the terminal while it is there (§10.1). */
const RETRY = 200;
const LOOK = 1000;
/** The look before Enter (architecture §10.5): how long it may take, and how often it reads. */
const BEFORE_ENTER = 2000;
const LOOK_STEP = 100;
/** Characters past the source line over which a message goes in a file, its path typed (§10.5). */
const LONG = 2000;
/** How long a switch waits for the new pane's agent to report its session (architecture §10.3). */
const SCREEN_WAIT = 3000;

/** The process and the ones up its parent chain, each "<pid>:<start time>" (RhCaller.ancestors). */
export function ancestors(pid: number): string[] {
  const out: string[] = [];
  for (let p = pid, s = procStat(p); s && p > 1 && out.length < 64; p = s.ppid, s = procStat(p)) out.push(`${p}:${s.start}`);
  return out;
}

/** Whether rh import takes a Herdr pane that reports an agent by this name: one of ours with paneImport. */
const importsPane = (name: string | undefined): boolean => Object.hasOwn(AGENTS, name ?? "") && AGENTS[name as AgentKind].paneImport;

/** The names of the login shells (/etc/shells): what a pane of yours, or one Herdr restored, runs. */
const shells = () => new Set(readFileSync("/etc/shells", "utf8").split("\n").filter((l) => l.startsWith("/")).map((l) => basename(l.trim())));

/** The session a Herdr pane reports. pi's Herdr extension reports its session's file when it has
 *  one, named "<start time>_<id>.jsonl" (architecture §6.3); Claude's hook, the id. */
export function paneSession(pane: any): string | undefined {
  const v: string | undefined = pane?.agent_session?.value;
  return v?.endsWith(".jsonl") ? basename(v, ".jsonl").split("_").at(-1) : v;
}

/** A restored tab in our own workspace may be discarded once it contains only a shell. */
export function restoredShell(pane: { agent?: string; agent_session?: unknown }, pid: number | undefined, needsReceipt = windows) {
  return pid === undefined && (!needsReceipt || (!pane.agent && !pane.agent_session));
}

type ForegroundAgent = { pid: number; name: string; argv?: string[]; cwd?: string };

/** Match the pane's reported agent to its foreground process before adopting its session. */
export async function inspectPaneAgent(kind: AgentKind, pane: string, session: string, foreground: ForegroundAgent[], checkPi = piPaneHasCredentials) {
  const named = (name: string | undefined, expected: string) => name === expected || (windows && !!name && basename(name).toLowerCase().replace(/\.exe$/, "") === expected);
  const agent = foreground.find(f => named(f.name, kind) || named(f.argv?.[0], kind)) ?? (windows && foreground.find(
    f => (named(f.name, "node") || named(f.argv?.[0], "node")) && isWindowsAgentNodeEntry(kind, f.argv?.[1]),
  ));
  if (!agent) throw new Error(`pane ${pane} 里的 ${kind} 已经退出了`);
  const start = procStat(agent.pid)?.start ?? fail(`pane ${pane} 里的 ${kind} 已经退出了`);
  if (kind === "pi") {
    const has = await checkPi(agent.pid);
    if (has !== false) fail(`${has ? `pane ${pane} 里的 pi 带着 Anthropic 的凭据` : `读不到 pane ${pane} 里 pi 的环境，不知道它带没带 Anthropic 的凭据`}，Rhodium 不能接管。在 pane 里退出它，再从磁盘导入：rh import ${session.slice(0, 8)}`);
  }
  if (kind === "pi" && !running(agent.pid, start)) fail(`pane ${pane} 里的 pi 已经退出了`);
  if (!agent.cwd) throw new Error(`读不到 pane ${pane} 里的 ${kind} 的工作目录`);
  return { pid: agent.pid, start, dir: windows ? localDrivePath(agent.cwd) : agent.cwd };
}

/** capabilities: as createRunner's, for the system prompt the terminal is started with. */
export function createTui(o: { cfg: Config; store: Store; loop: Loop; capabilities: (bot: string) => Capabilities | undefined }, checkPi = piPaneHasCredentials) {
  const { cfg, store, loop } = o;
  const program = (p: string) => locate(p, cfg.agentPath) ?? fail(`${p} 不在 PATH 上（${cfg.agentPath}）`);

  /**
   * How each agent's terminal runs on the session (architecture §10.3). args: what follows the
   * program on its launch line, on the session, or with none a new one of its own. presets: it starts
   * a new session under an id given it, which Rhodium then knows at once. ownSettings: on a session
   * with lines written down, it restores its settings from its file, not the slot's (pi, §6.3). hidden: its process title wipes its command line, which then
   * names no session (holders). named: its pane is up once Herdr names the agent in it, not once
   * it reports its session, which it does only at its first turn (Codex, §6.4). prompt: the slot's
   * terminal system prompt, its file and what it says (§6.1).
   */
  const TERMINAL: Record<AgentKind, { args: (slot: Slot, session: string | null, models: Record<string, string>, prompt: { file: string; text: string }) => Promise<string[]>; presets: boolean; ownSettings: boolean; hidden: boolean; named: boolean }> = {
    claude: {
      // By the slot's /model, /effort, /ultracode and approval mode, as its headless agent goes, but
      // for a model the last handshake no longer offered: the conversation's own then. Approval on is
      // Claude's own default mode, with no flag. It resumes only a conversation it wrote down, else
      // starts it under that id (§6.2). The prompt as headless: read again on --resume (§6.2).
      args: async (slot, session, models, prompt) => [
        ...claudeFlags(slot.model !== null && Object.hasOwn(models, slot.model) ? slot.model : null, slot.effort, slot.ultracode === null ? null : slot.ultracode === 1),
        ...(slot.approval ?? cfg.defaults.approval ? [] : ["--permission-mode", "bypassPermissions"]),
        (await hasTranscript("claude", session!)) ? "--resume" : "--session-id",
        session!,
        "--append-system-prompt-file",
        prompt.file,
        "--system-prompt-snapshot",
        "off",
      ],
      presets: true,
      ownSettings: false,
      hidden: false,
      named: false,
    },
    // A session with nothing written down yet starts by the slot's /model and /effort, as pi has no
    // file to restore them from (stories 58, 544).
    pi: {
      args: async (slot, session, _, prompt) => [
        ...((await hasTranscript("pi", session!)) ? [] : [...(slot.model !== null ? ["--model", slot.model] : []), ...(slot.effort !== null ? ["--thinking", slot.effort] : [])]),
        "--session-id",
        session!,
        "--append-system-prompt",
        prompt.file,
      ],
      presets: true,
      ownSettings: true,
      hidden: true,
      named: false,
    },
    // On its own app-server, not your shared one (--no-daemon), so the thread is free once it exits;
    // by the slot's model, level and approval mode, approval on as Codex judges it, as its terminal
    // has no "ask for each"; without the update and folder-trust prompts, for this launch alone. The
    // trust is a whole table: a dotted key would keep the quotes around the directory (2026-10-27).
    // With no thread, a new one. The prompt as the developer instructions headless gets, which codex
    // takes for a new thread alone, its text on the command line as a TOML string, which JSON's
    // escapes are (2026-11-15).
    codex: {
      args: async (slot, session, _, prompt) => [
        ...(session !== null ? ["resume", session] : []),
        "--no-daemon",
        ...(slot.model !== null ? ["-m", slot.model] : []),
        ...(slot.effort !== null ? ["-c", `model_reasoning_effort=${slot.effort}`] : []),
        ...(slot.approval ?? cfg.defaults.approval ? ["-a", "on-request", "-s", "danger-full-access"] : ["--dangerously-bypass-approvals-and-sandbox"]),
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        `projects={${JSON.stringify(slot.dir)}={trust_level="trusted"}}`,
        "-c",
        `developer_instructions=${JSON.stringify(prompt.text)}`,
      ],
      presets: false,
      ownSettings: false,
      hidden: false,
      named: true,
    },
  };

  // Through TUI mode rhodium holds the conversation lock, as the holder does while headless
  // (architecture §10.1): by conversation, the lock's fd. Slots in TUI mode before this rhodium
  // started get theirs again.
  const locks = new Map<string, () => void>();
  function conversationLock(path: string) {
    if (windows) return windowsConversationLock(path);
    const fd = lock(path);
    return fd === null ? null : () => closeSync(fd);
  }
  for (const s of store.tx((tx) => tx.find("slot", { mode: "tui" }))) {
    if (!s.herdrPane || !s.conversation) continue;
    const fd = conversationLock(holderPaths(cfg, s.conversation).lock);
    if (fd === null) log("cannot take a TUI slot's conversation lock again", { slot: s.id });
    else locks.set(s.conversation, fd);
  }

  /** The pid of the agent the pane runs: the pane's own process, once it runs neither a shell nor env
   *  (the launch command's, or a script's #!/usr/bin/env node). Not by name or command line: pi sets
   *  its process title, which leaves /proc only "pi". */
  async function agentPid(socket: string, pane: string, identity?: string): Promise<number> {
    const sh = windows ? null : shells();
    const pid = await poll(async () => {
      const pid: number = (await request(socket, "pane.process_info", { pane_id: pane })).process_info.shell_pid;
      if (windows) {
        if (!identity) return;
        let agent;
        try { agent = JSON.parse(readFileSync(identity, "utf8")); }
        catch { return; } // the launcher publishes the actual child after it starts
        if (!agent) return;
        if (agent.launcherPid !== undefined) {
          if (agent.launcherPid !== pid || !running(pid, agent.launcherStart)) return;
          if (typeof agent.error === "string") throw new Error(agent.error);
        }
        const proc = nativeProcess(agent.pid);
        if (!proc || proc.start !== agent.start || proc.state === "Z") return;
        // Older Codex receipts predate launcher identity and name a direct child.
        return agent.launcherPid !== undefined || proc.ppid === pid ? agent.pid : undefined;
      }
      let exe = "env";
      try {
        exe = basename(detached ? nativeProcess(pid)?.exe || "env" : readlinkSync(`/proc/${pid}/exe`));
      } catch {} // gone, or not yet
      return exe !== "env" && !sh!.has(exe) ? pid : undefined;
    });
    return pid ?? fail(`pane ${pane} 里的 agent 没有起来`);
  }

  /** The session the pane's agent reports, once it does; undefined if it has not within ms, or the pane is gone. */
  const reportedBy = (socket: string, pane: string, ms?: number) =>
    poll(async () => paneSession((await request(socket, "pane.get", { pane_id: pane })).pane), ms).catch(() => undefined);

  /** What f finds, tried every 0.1 s; undefined if nothing within ms. */
  async function poll<T>(f: () => Promise<T | undefined>, ms = cfg.durations.holdStartTimeout): Promise<T | undefined> {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
      const found = await f();
      if (found !== undefined) return found;
    }
  }

  async function open(slotId: string): Promise<void> {
    const { slot, conv, ws, models } = store.tx((tx) => {
      const slot = tx.get("slot", slotId)!;
      const models = namesOf(tx, "claude");
      return { slot, conv: tx.get("conversation", slot.conversation!)!, ws: tx.get("workspace", slot.workspace)!, models };
    });
    let fd: (() => void) | null = null;
    // What this switch made, to close again should it fail: a new workspace's own tab, and the slot's.
    let root: string | undefined;
    let tab: string | undefined;
    let opened: Extract<Input, { kind: "tui" }>["opened"];
    try {
      const terminal = TERMINAL[conv.agent];
      // No conversation yet: a new one, under an id of Rhodium's if the agent takes one (stories 544,
      // 545). A Codex thread with no record, which codex resume cannot open, is as none (§10.3).
      let session = conv.sessionId;
      if (session !== null && !terminal.presets && !(await hasTranscript(conv.agent, session))) session = null;
      if (session === null && terminal.presets) {
        // On record before the agent starts: a rhodium that dies before it hears back then takes the
        // pane over on restart, known by this id (architecture §10.1).
        session = randomUUID();
        const id = session;
        store.tx((tx) => tx.update("conversation", { id: conv.id }, { sessionId: id }));
      }
      // The slot's name for rh and its token, and its terminal prompt, a child's or the other (§6.1).
      const who = slotToken(store, slot.id);
      const args = await terminal.args(slot, session, models, writePrompt(o, slot.id, who.child, true));
      // The holder lets go of the lock as it exits, a moment after it reported the agent's exit.
      const path = holderPaths(cfg, conv.id).lock;
      for (const end = Date.now() + cfg.durations.stopGrace; (fd = conversationLock(path)) === null && Date.now() < end; ) await Bun.sleep(50);
      if (fd === null) fail("对话锁还被别的进程拿着");
      // Kept for the watch: Herdr gone right after the switch is then tried every RETRY, not every LOOK.
      socket = await sessionSocket(program(cfg.programs.herdr), cfg.herdr.session);
      let { snapshot } = await request(socket, "session.snapshot");
      const agent = program(cfg.programs[conv.agent]);
      // The slot's tab may be there already: a rhodium that died after starting the agent, before it
      // heard back, left it, and this is recovery trying again. Its agent, once up, is taken over
      // if it has the conversation (architecture §10.1).
      const ours = snapshot.workspaces.filter((w: any) => w.workspace_id === ws.herdrWorkspace || w.label === ws.name).map((w: any) => w.workspace_id);
      const left = snapshot.tabs.find((t: any) => t.label === slot.name && ours.includes(t.workspace_id));
      const previousPane = left && snapshot.panes.find((p: any) => p.tab_id === left.tab_id);
      const leftPane: string | undefined = previousPane?.pane_id;
      // One with only a shell in it, say Herdr restored it without its agent, is as none: a new tab
      // opens. One in the Herdr workspace Rhodium made goes first, so the next switch need not wait for
      // it again; one Rhodium only found by its name may be yours, and stays.
      const holderDir = holderPaths(cfg, conv.id).dir;
      const current = join(holderDir, "tui-current");
      let identity = windows && existsSync(current) ? join(holderDir, readFileSync(current, "utf8") + ".pid") : undefined;
      const leftPid = leftPane ? await agentPid(socket, leftPane, identity).catch(() => undefined) : undefined;
      if (leftPane && left.workspace_id === ws.herdrWorkspace && restoredShell(previousPane, leftPid)) {
        await request(socket, "tab.close", { tab_id: left.tab_id });
        ({ snapshot } = await request(socket, "session.snapshot"));
      }
      // Only "no such process" counts, never a stored pid.
      const found = session === null ? [] : await holders(session);
      let adopt = leftPid !== undefined && found.includes(leftPid);
      if (leftPid !== undefined && !adopt) {
        // pi's command line names no session (holders): the session its pane reports, once it is up, does.
        const said = await reportedBy(socket, leftPane!);
        adopt = said === session;
        // A pi that reports none may have the conversation: its tab goes before another opens.
        if (said === undefined && terminal.hidden) {
          const start = procStat(leftPid)?.start ?? null;
          await request(socket, "tab.close", { tab_id: left.tab_id });
          if (!(await gone(leftPid, start, cfg.durations.stopGrace))) fail(`${slot.name} 标签页里的 ${conv.agent} 没有报告会话，关掉标签页后也没有退出`);
          ({ snapshot } = await request(socket, "session.snapshot"));
        }
      }
      const others = found.filter((p) => p !== leftPid);
      if (others.length) fail("另一个进程正在用这段对话");
      const busy = session !== null && snapshot.panes.find((p: any) => paneSession(p) === session && !(adopt && p.pane_id === leftPane));
      if (busy) fail("Herdr 里另一个 pane 正在用这段对话");
      let at: Omit<TuiPane, "start">;
      if (adopt) at = { workspace: left.workspace_id, tab: left.tab_id, pane: leftPane!, pid: leftPid! };
      else {
        // The workspace's Herdr workspace, made at its first switch, and again once it closed with its last tab.
        let workspace: string | null = snapshot.workspaces.some((w: any) => w.workspace_id === ws.herdrWorkspace) ? ws.herdrWorkspace : null;
        if (!workspace) {
          const made = await request(socket, "workspace.create", { cwd: ws.dir, label: ws.name });
          workspace = made.workspace.workspace_id as string;
          root = made.tab.tab_id; // a tab it comes with, which goes once the slot's is there
        }
        // rh's variables and the empty Telegram state dir, as a headless agent gets them (architecture
        // §6.2). The token goes in the pane's env, not in the command, which Herdr's answer echoes and
        // its restore record keeps.
        const { ref, token, child } = who;
        const { TELEGRAM_STATE_DIR } = agentBaseEnv(cfg);
        const env = { RHODIUM_SOCKET: join(cfg.socketDir, "rh.sock"), RHODIUM_SLOT: ref, RHODIUM_TOKEN: token, TELEGRAM_STATE_DIR, ...childEnv(child) };
        // Each agent's own terminal on the session, in the slot's directory; any but Claude without the
        // keys that would put it on your Claude subscription, as headless (agents.ts, architecture §6.3).
        const unset = terminalUnset(conv.agent, process.env);
        // The tab runs the agent itself: no shell, so nothing typed shows on its screen, and the pane
        // ends with the agent (#372, architecture §10.3).
        let command: string[];
        if (windows) {
          mkdirSync(holderDir, { recursive: true });
          const id = randomUUID();
          identity = join(holderDir, id + ".pid");
          command = windowsPaneCommand(join(holderDir, id + ".request"), { agent: conv.agent, argv: [agent, ...args], env: { PATH: cfg.agentPath }, unset, identity });
          const previous = existsSync(current) && readFileSync(current, "utf8");
          writeFileSync(current + ".tmp", id);
          renameSync(current + ".tmp", current);
          if (previous && /^[0-9a-f-]{36}$/.test(previous)) {
            rmSync(join(holderDir, previous + ".pid"), { force: true });
            rmSync(join(holderDir, previous + ".request"), { force: true });
          }
        } else {
          command = ["/usr/bin/env", ...unset.flatMap(k => ["-u", k]), `PATH=${cfg.agentPath}`, agent, ...args];
        }
        const { layout } = await request(socket, "layout.apply", { workspace_id: workspace, tab_label: slot.name, root: { type: "pane", cwd: slot.dir, env, command } });
        tab = layout.tab_id as string;
        const pane: string = layout.root.pane_id;
        if (root) await request(socket, "tab.close", { tab_id: root });
        root = undefined;
        at = { workspace, tab, pane, pid: await agentPid(socket, pane, identity) };
        // Its screen is up about when it reports its session: only then is the switch told, and the
        // pane handed to the slot's web page. Claude in a directory it has not trusted reports none
        // till you answer its question, which its screen shows: so no more than SCREEN_WAIT (§10.3).
        // Codex reports its thread only at its first turn: Herdr naming it is as near as it gets.
        const herdrAt = socket;
        if (terminal.named) await poll(async () => ((await request(herdrAt, "pane.get", { pane_id: pane })).pane?.agent === conv.agent) || undefined, SCREEN_WAIT).catch(() => undefined);
        else await reportedBy(socket, pane, SCREEN_WAIT);
      }
      opened = { ...at, session, start: procStat(at.pid)?.start ?? fail("pane 里的 agent 起来就退出了") };
      if (detached && !adopt && conv.agent === "claude") rememberVimLaunch(holderDir, at.pid, opened.start, args, slot.dir);
      locks.set(conv.id, fd!);
      // /rh_tui from IM: your Herdr shows the pane when you get to it. Not done, the switch stands all the same.
      if (slot.tuiFocus) {
        const focus = [["workspace.focus", { workspace_id: at.workspace }], ["tab.focus", { tab_id: at.tab }], ["pane.focus", { pane_id: at.pane }]] as const;
        for (const [method, params] of focus) await request(socket, method, params).catch((err) => log("cannot focus the pane", { slot: slotId, method, error: String(err) }));
      }
    } catch (err) {
      log("cannot switch to the terminal", { slot: slotId, error: String(err) });
      if (fd !== null) fd();
      for (const t of [tab, root]) if (socket && t) await request(socket, "tab.close", { tab_id: t }).catch(() => {});
      opened = { error: (err as Error).message };
    }
    loop.enqueue({ kind: "tui", slot: slotId, opened });
    void watch();
  }

  // ---- Watching the slots in the terminal, and switching them back (architecture §10.1, §10.2). ----

  // ponytail: these live in memory. An agent that exits while rhodium is down goes back to the session
  // the slot had; a pane left for Herdr's return is forgotten across a restart, which rh doctor's
  // resume_agents_on_restore warning covers.
  /** By slot: the session id its pane last reported, which the slot goes on with once back. */
  const reported = new Map<string, string>();
  /** Slots whose pane last reported another directory's pi session (take). */
  const elsewhere = new Set<string>();
  /** Panes of slots switched back while Herdr was away: closed first thing once it is back. */
  const orphans = new Set<string>();
  /** Slots being switched back. */
  const backing = new Set<string>();
  let socket: string | undefined; // Herdr's, once known
  let sub: ReturnType<typeof subscribe> | undefined; // open while Herdr is there and something is watched
  let watching = false;

  /** Slots in the terminal with an agent of theirs to watch. */
  const watched = () => store.tx((tx) => tx.find("slot", { mode: "tui" })).filter((s) => s.herdrPane !== null && s.tuiPid !== null);
  /** Herdr's socket, once Herdr has listed it; undefined till then. */
  async function herdrSocket(): Promise<string | undefined> {
    try {
      socket ??= await sessionSocket(program(cfg.programs.herdr), cfg.herdr.session);
    } catch {} // away: tried again next time
    return socket;
  }
  /** The session the slot's pane last reported, else the one the slot had; null for none yet. */
  const sessionOf = (s: Slot) => reported.get(s.id) ?? store.tx((tx) => tx.get("conversation", s.conversation!))!.sessionId;

  /** Takes in the session ids panes reported in events since the last look: quitting with Ctrl-C sends
   *  the last one just before the pane exits (architecture §10.1). */
  function absorb(): void {
    const slots = new Map(watched().map((s) => [s.herdrPane, s]));
    for (const e of sub?.events.splice(0) ?? []) {
      const slot = slots.get(e.data?.pane?.pane_id);
      if (e.event === "pane_updated" && slot) take(slot, e.data.pane);
    }
  }

  /** Takes in the session the slot's pane reports, if any. A pi session file outside the slot
   *  directory's folder is another directory's conversation, which pi's --session-id cannot open in
   *  the slot's (architecture §6.3): the slot keeps the one it had, and says so once back. */
  function take(s: Slot, pane: any): void {
    const session = paneSession(pane);
    if (!session) return;
    const v: string = pane.agent_session.value;
    if (v.endsWith(".jsonl") && !sameDirectory(dirname(v), sessionsDir(s.dir, store.tx((tx) => tx.get("conversation", s.conversation!))!.agent))) {
      reported.delete(s.id);
      elsewhere.add(s.id);
    } else {
      reported.set(s.id, session);
      elsewhere.delete(s.id);
    }
  }

  /** Runs while a slot is in the terminal, or a pane waits for Herdr to come back. While Herdr is there
   *  it holds a subscription, whose end says Herdr went away, and looks at each slot's agent every
   *  second; while Herdr is away it tries it again every 200 ms, or every second while it has not
   *  learnt Herdr's socket, as each try then runs `herdr session list`. */
  async function watch(): Promise<void> {
    if (watching) return;
    watching = true;
    let up: boolean | undefined; // what the router was last told
    try {
      while (watched().length || orphans.size) {
        const s = await connect();
        if (!s) {
          if (up !== false) loop.enqueue({ kind: "herdr", up: (up = false) });
          // What was typed is still told by the transcript (§10.5).
          for (const w of watched()) await confirm(w).catch((err) => log("cannot look for what was typed", { slot: w.id, error: String(err) }));
          await Bun.sleep(socket ? RETRY : LOOK);
          continue;
        }
        sub = s;
        let closed = false;
        void s.closed.then(() => (closed = true));
        // First, before Herdr resumes any agent by itself, some 2.5 s after it starts (architecture §10.2).
        for (const pane of orphans) await closePane(pane);
        const resumed = await reconcile();
        loop.enqueue({ kind: "herdr", up: (up = true), resumed });
        while (!closed && watched().length) {
          await look();
          await Promise.race([Bun.sleep(LOOK), s.closed]);
        }
        // Herdr went away: said at once, so a Herdr back by the next try still counts as restarted.
        if (closed) loop.enqueue({ kind: "herdr", up: (up = false) });
        s.close();
        sub = undefined;
      }
    } catch (err) {
      log("the Herdr bridge stopped watching", { error: String(err) });
    } finally {
      watching = false;
    }
  }

  /** A subscription to Herdr's events, once Herdr answers; undefined while it is away. */
  async function connect(): Promise<ReturnType<typeof subscribe> | undefined> {
    const at = await herdrSocket();
    if (!at) return undefined;
    const s = subscribe(at, ["pane.updated"]);
    if (await Promise.race([s.started.then(() => true), s.closed.then(() => false)])) return s;
    s.close();
    return undefined;
  }

  /** Takes in the session the slot's pane reports now, and what Herdr says its agent is at: kept on
   *  the slot when it changed, with an event the board's page refreshes on. Not on a slot that left
   *  this pane while Herdr was asked. Returns what Herdr said of the pane, if it said. */
  async function readSession(s: Slot): Promise<any> {
    const a = await call(socket!, "pane.get", { pane_id: s.herdrPane }).catch(() => undefined);
    const pane = a?.result?.pane;
    take(s, pane);
    const status: unknown = pane?.agent_status;
    if (typeof status !== "string") return pane;
    if (status === s.tuiStatus) return pane;
    store.tx((tx) => {
      const now = tx.get("slot", s.id);
      if (now?.mode !== "tui" || now.herdrPane !== s.herdrPane || now.tuiStatus === status) return;
      // A turn in the terminal never reaches the router: its start and end are told by what Herdr says,
      // so the board shows it ended as for a headless one (product §4). Only working or blocked to idle or
      // done is a turn's end: a new agent, or one Herdr restored, says unknown for a few seconds first.
      const at = Date.now();
      const ended = (status === "idle" || status === "done") && (now.tuiStatus === "working" || now.tuiStatus === "blocked");
      const turn = ended ? { turnEndedAt: at, activeAt: at } : status === "working" && now.tuiStatus !== null ? { activeAt: at } : {};
      tx.update("slot", { id: s.id }, { tuiStatus: status, ...turn });
      // Not among the slot's own events, which 详情 lists: it would fill with every turn in the terminal.
      tx.append({ source: "herdr", type: "tui_status", data: { slot: s.id, status } });
    });
    return pane;
  }

  /** What the slot's terminal is at for typing: from what Herdr said, and for an agent with a screen
   *  rule the bottom of its pane's screen with its styles (architecture §10.3, §10.5). Kept on the slot
   *  when it changed, with an event the board's page refreshes on, as for tui_status. Returns it, and
   *  the screen read. */
  async function readInput(s: Slot, status: string | undefined): Promise<{ input: TuiInput; screen?: string }> {
    const agent = agentOf(s);
    const text: unknown = status !== undefined ? (await call(socket!, "pane.read", screenOf(s)).catch(() => undefined))?.result?.read?.text : undefined;
    const screen = typeof text === "string" ? text : undefined;
    let input = inputState(agent, status, screen);
    // Claude in vim mode takes text only in INSERT, which alone shows a mark: read as typing needs it (§10.5).
    if (input === "ready" && agent === "claude") {
      let native: VimLaunch | undefined;
      if (detached && s.conversation) {
        const info = await call(socket!, "pane.process_info", { pane_id: s.herdrPane }).catch(() => undefined);
        native = nativeVimLaunch(holderPaths(cfg, s.conversation).dir, s.tuiPid!, s.tuiStart, info?.result?.process_info?.foreground_processes);
      }
      if (vim(s.dir, s.tuiPid!, homedir(), native)) input = inputState(agent, status, screen, true);
    }
    if (input !== s.tuiInput)
      store.tx((tx) => {
        const now = tx.get("slot", s.id);
        if (now?.mode !== "tui" || now.herdrPane !== s.herdrPane || now.tuiInput === input) return;
        tx.update("slot", { id: s.id }, { tuiInput: input });
        tx.append({ source: "herdr", type: "tui_input", data: { slot: s.id, input } });
      });
    return { input, screen };
  }

  /** Each slot's agent: there, the session its pane reports now, what its terminal is at, what was
   *  typed there and got in, and the next to type; gone while Herdr is there, the slot goes back to
   *  headless. Only "no such process" counts (architecture §10.1, §10.5). */
  async function look(): Promise<void> {
    absorb();
    for (const s of watched()) {
      if (backing.has(s.id)) continue;
      if (running(s.tuiPid!, s.tuiStart)) {
        const pane = await readSession(s);
        const status = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
        const seen = await readInput(s, status);
        // Neither stops the watch should it throw.
        await confirm(s, seen.input).catch((err) => log("cannot look for what was typed", { slot: s.id, error: String(err) }));
        await follow(s, status, seen.input).catch((err) => log("cannot follow the turn in the terminal", { slot: s.id, error: String(err) }));
        await type(s, { ...seen, status, rows: pane?.scroll?.viewport_rows }).catch((err) => log("cannot type into the terminal", { slot: s.id, error: String(err) }));
      } else if (await call(socket!, "ping").catch(() => undefined)) await back(s.id);
      // Herdr away: it took the agent with it, and the subscription's end says so (watch).
    }
  }

  /** Herdr answers again, or for the first time since rhodium started: a slot whose agent is gone has it
   *  back, resumed by Herdr itself in its pane, or goes back to headless, its pane closed first
   *  (architecture §10.2). Returns those Herdr resumed, with their agents. */
  async function reconcile(): Promise<Resumed> {
    const resumed: Resumed = {};
    for (const s of watched()) {
      if (backing.has(s.id) || running(s.tuiPid!, s.tuiStart)) continue;
      // A restored pane reports its session before its agent is up: after a restart of rhodium, the
      // one you may have moved to in the terminal, which Herdr resumes.
      await readSession(s);
      const info = await request(socket!, "pane.process_info", { pane_id: s.herdrPane }).catch(() => undefined);
      const inPane: number[] = (info?.process_info.foreground_processes ?? []).map((p: { pid: number }) => p.pid);
      const session = sessionOf(s);
      const pid = session === null ? undefined : (await holders(session)).find((p) => inPane.includes(p));
      const start = pid === undefined ? undefined : procStat(pid)?.start;
      if (start !== undefined) resumed[s.id] = { pid: pid!, start };
      // Herdr gone again since it answered: it took the agent with it, and the subscription's end says so.
      // A pane whose shell started after the agent is one Herdr restored: it restarted while rhodium was
      // away, and took the agent with it. One you quit is gone, or left with the shell it ran under.
      else if (await call(socket!, "ping").catch(() => undefined)) await back(s.id, false, (procStat(info?.process_info.shell_pid)?.start ?? 0) > s.tuiStart!);
    }
    return resumed;
  }

  /** Closes the slot's pane, if it is still there; with Herdr away, once it is back. Only the pane:
   *  panes of yours split off it in its tab stay (an imported pane's may have some), and its tab goes
   *  with its last pane (architecture §10.3). */
  async function closePane(pane: string): Promise<void> {
    const at = await herdrSocket();
    const closed = at && (await call(at, "pane.close", { pane_id: pane }).catch(() => undefined)); // pane_not_found counts
    if (closed) orphans.delete(pane);
    else orphans.add(pane);
  }

  /** Ends the slot's agent in the terminal (/rh_release): Claude's exit keys, two Ctrl-C some 0.4 s
   *  apart (probe 18), which end pi too; still there after durations.releaseGrace, SIGTERM
   *  (architecture §10.1). The log says how it ended, and why a key did not go: a pi once outlived
   *  its keys, 1 time in 23, for no reason found. */
  async function end(s: Slot): Promise<void> {
    const at = await herdrSocket();
    for (const wait of [0, 400]) {
      await Bun.sleep(wait);
      // Herdr away: SIGTERM does it.
      if (at) await request(at, "pane.send_keys", { pane_id: s.herdrPane, keys: ["ctrl+c"] }).catch((err) => log("cannot send the exit keys", { slot: s.id, error: String(err) }));
    }
    let by = "exit keys";
    if (!(await gone(s.tuiPid!, s.tuiStart, cfg.durations.releaseGrace))) {
      // Checked against its start time first, so no other process given its pid is hit.
      try {
        if (running(s.tuiPid!, s.tuiStart)) process.kill(s.tuiPid!, "SIGTERM");
      } catch {} // gone meanwhile
      by = (await gone(s.tuiPid!, s.tuiStart, cfg.durations.stopGrace)) ? "SIGTERM" : "still running";
    }
    log("ended the agent in the terminal", { slot: s.id, by });
  }

  /**
   * Switches the slot back to headless once its agent in the terminal is gone (architecture §10.1,
   * §10.2): closes its pane, makes sure no one else has the conversation, lets go of the conversation
   * lock for the holder, and says what came of it with a tui_back input. force: ends that agent first;
   * restarted: Herdr restarted while rhodium was away, and took the agent with it.
   */
  async function back(slotId: string, force = false, restarted = false): Promise<void> {
    if (backing.has(slotId)) return;
    backing.add(slotId);
    try {
      const s = store.tx((tx) => tx.get("slot", slotId));
      if (!s?.conversation || s.mode !== "tui" || s.herdrPane === null) return;
      let result: Extract<Input, { kind: "tui_back" }>["back"];
      try {
        if (force && s.tuiPid !== null) await end(s);
        if (s.tuiPid !== null && running(s.tuiPid, s.tuiStart)) fail("TUI 里的 agent 没有退出");
        // Closing it also takes the agent off Herdr's restore record (architecture §10.2).
        await closePane(s.herdrPane);
        absorb();
        const session = sessionOf(s);
        if (session !== null) await nobodyHas(session);
        // What was typed and is not known taken: a last look in the transcript (§10.5).
        await confirm(s).catch((err) => log("cannot look for what was typed", { slot: slotId, error: String(err) }));
        const settings = await settingsIn(s, session).catch((err) => (log("cannot read what the terminal ran on", { slot: slotId, error: String(err) }), {}));
        result = { session, ...settings, ...(elsewhere.has(slotId) && { elsewhere: true as const }), ...(restarted && { restarted: true as const }) };
        const fd = locks.get(s.conversation);
        fd?.();
        locks.delete(s.conversation);
        reported.delete(slotId);
        elsewhere.delete(slotId);
        readyOnce.delete(slotId); // the next pane's screen is read twice afresh
        turns.delete(slotId); // the switch back ends the turn (router's tuiBack)
      } catch (err) {
        log("cannot switch back to headless", { slot: slotId, error: String(err) });
        result = { error: (err as Error).message, ...(s.tuiPid !== null && running(s.tuiPid, s.tuiStart) && { running: true as const }) };
      }
      loop.enqueue({ kind: "tui_back", slot: slotId, back: result });
    } finally {
      backing.delete(slotId);
    }
    void watch(); // a pane left for Herdr's return
  }

  /** What the agent Rhodium launched in the terminal by the slot's settings last ran on, from the
   *  session its pane last reported; and what it started on: for pi, the lines of that same session
   *  before it, or with none, the first lines pi wrote there on the slot's settings; for Claude and Codex, while the slot leaves the model or the level to your default, what the
   *  slot's conversation ran on before it (architecture §6.3, §10.1). Nothing for an agent launched
   *  otherwise, whose settings are not known. */
  async function settingsIn(s: Slot, session: string | null): Promise<{ used?: Used; before?: Used }> {
    const conv = store.tx((tx) => tx.get("conversation", s.conversation!))!;
    if (!s.tuiLaunched || s.tuiStart === null) return {};
    // The agent's start: tuiStart counts clock ticks after boot, 100 a second on Linux.
    const since = detached ? s.tuiStart / 1000 : Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000 + s.tuiStart * 10;
    const read = async (id: string | null, side: "after" | "before" | "first") => {
      const file = id === null ? undefined : (await findConversations(id)).find((c) => c.agent === conv.agent && c.id === id)?.file;
      return !file ? {} : side === "first" ? await piSettings(file, since, side) : await ranOn(conv.agent, file, since, side);
    };
    const used = await read(session, "after");
    // pi's terminal: each session there (the slot's, one you /resume or /new) starts on what its file
    // says before it, whatever the slot has; one started there, on your defaults. The slot's own with
    // nothing written down yet started by the slot's settings, as pi narrowed them: its first lines there.
    if (TERMINAL[conv.agent].ownSettings) {
      const before = await read(session, "before");
      if (before.model !== undefined || session !== conv.sessionId || s.model === null) return { used, before };
      return { used, before: await read(session, "first") };
    }
    return s.model !== null && s.effort !== null ? { used } : { used, before: await read(conv.sessionId, "before") };
  }

  /** Throws unless no one else uses the session: no other process names it on its command line, and
   *  no other Herdr pane reports it (architecture §10.1). With Herdr away there are no panes to look at. */
  async function nobodyHas(session: string, except?: { pid: number; pane: string }): Promise<void> {
    const others = (await holders(session)).filter((p) => p !== except?.pid);
    if (others.length) fail("另一个进程正在用这段对话");
    const at = await herdrSocket();
    const snap = at && (await request(at, "session.snapshot").catch(() => undefined));
    const pane = snap?.snapshot?.panes?.find((p: any) => paneSession(p) === session && p.pane_id !== except?.pane);
    if (pane) fail("Herdr 里另一个 pane 正在用这段对话");
  }

  // ---- Typing internal messages into the terminal (architecture §10.5, #712). ----

  /** Slots whose terminal read ready at the last look: typing waits for two in a row. */
  const readyOnce = new Set<string>();
  /** Inputs with no source line, never typed: logged once. */
  const untypable = new Set<string>();
  /** By transcript file, the byte offset it was read up to for traces: only what is appended after it is
   *  read, as Claude writes lines out of time order (an assistant line stamped at its stream's start). */
  const readTo = new Map<string, number>();

  /** The transcript file of the session the slot's pane reports, if there is one yet. */
  const fileOf = async (s: Slot) => {
    const session = sessionOf(s);
    return session === null ? null : await transcriptFile(s.dir, agentOf(s), session).catch(() => null);
  };
  const agentOf = (s: Slot) => store.tx((tx) => tx.get("conversation", s.conversation!))!.agent;
  /** pane.read's params for the bottom of the slot's screen, with its styles (§10.3). */
  const screenOf = (s: Slot) => ({ pane_id: s.herdrPane, source: "recent", format: "ansi", strip_ansi: false });
  /** What was typed into the slot's terminal and is not known taken: being typed, typed, unknown, or
   *  sent again from the board and not typed again yet. */
  const typedIn = (s: Slot) =>
    store.tx((tx) => tx.find("agentInput", { conversation: s.conversation!, queueReason: IN_TUI })).filter((i) => i.typedAt !== null && i.typed !== null && i.status !== "taken" && (i.status !== "queued" || i.resentAt !== null));

  /** Looks in the transcript of the slot's pane for what was typed there and is not known taken
   *  (architecture §10.5), in what was appended since the last look: found, it is taken, and yours is
   *  you writing to the slot where you sent it (product §5.9); still not, 30 s on, unknown, which the
   *  router tells you of. For an agent whose trace comes late (pi), its box read empty (input, read at
   *  this look) within 30 s of Enter takes it too. */
  async function confirm(s: Slot, input?: TuiInput): Promise<void> {
    const rows = typedIn(s);
    if (!rows.length) return;
    const agent = agentOf(s);
    const late = RULES[agent].late === true;
    const file = await fileOf(s);
    let lines: string[] = [];
    if (file) {
      // Not read since Rhodium started, or it shrank: back from the end to well before the oldest was typed.
      let from = readTo.get(file);
      if (from === undefined || from > (statSync(file, { throwIfNoEntry: false })?.size ?? 0)) from = await lineBefore(file, Math.min(...rows.map((i) => i.typedAt!)) - RESTART_MARGIN).catch(() => 0);
      const got = await appended(file, from).catch(() => ({ lines: [], ends: [], end: from }));
      readTo.set(file, got.end);
      lines = got.lines;
    }
    const now = Date.now();
    const unknown: string[] = [];
    store.tx((tx) => {
      let changed = false;
      for (const i of rows) {
        const was = tx.get("agentInput", i.id);
        if (was?.typed !== i.typed || was.status !== i.status) continue; // moved on meanwhile
        if (traced(agent, i.typed!, i.typedAt!, lines) || (late && i.status === "written" && input === "ready" && now - i.typedAt! < cfg.durations.tuiConfirm)) {
          // Yours keeps what was typed till its turn's start is found (follow).
          tx.update("agentInput", { id: i.id }, { status: "taken", body: null, images: null, typed: i.source === "human" ? i.typed : null, resentAt: null });
          if (i.source === "human" && i.trace) wrote(tx, s.id, i.trace, now);
        } else if ((i.status === "writing" || i.status === "written") && now - i.typedAt! >= cfg.durations.tuiConfirm) {
          tx.update("agentInput", { id: i.id }, { status: "unknown" });
          rehome(tx, s.id);
          unknown.push(i.id);
        } else continue;
        changed = true;
      }
      if (changed) tx.append({ source: "herdr", type: "board_queue" });
    });
    for (const id of unknown) loop.enqueue({ kind: "clock", timer: "tui_unconfirmed", key: id });
  }

  /** Your message the agent got, from the chat or the board request trace: you wrote to the slot there
   *  (product §5.9), as with one the headless agent takes (router's contacted, webAt). */
  function wrote(tx: Tx, slot: string, trace: string, at: number): void {
    const chat = tx.get("inbound", trace)?.chat;
    if (chat) tx.update("chat", { id: chat }, { contactedAt: at });
    tx.update("slot", { id: slot }, chat ? { imAt: at } : { webAt: at });
  }

  /** Types the next internal message into the slot's terminal, if it takes typing (architecture
   *  §10.5): ready at this look and the last, nothing typed before it still unconfirmed under 30 s, the
   *  pane's foreground the slot's agent. Text first, then a look, then Enter, only while the box holds
   *  just that text. */
  async function type(s: Slot, seen: { input: TuiInput; screen?: string; status?: string; rows?: number }): Promise<void> {
    const before = readyOnce.has(s.id);
    if (seen.input === "ready") readyOnce.add(s.id);
    else readyOnce.delete(s.id);
    const agent = agentOf(s);
    const how = TYPING[agent];
    if (!how || !before || seen.input !== "ready" || seen.screen === undefined || s.herdrLostAt !== null) return;
    if (seen.status === "working" && !how.busy) return;
    const [ins, turnChat] = store.tx((tx) => [tx.find("agentInput", { conversation: s.conversation!, queueReason: IN_TUI }), tx.get("slot", s.id)?.turnChat ?? null] as const);
    if (ins.some((i) => (i.status === "writing" || i.status === "written") && Date.now() - i.typedAt! < cfg.durations.tuiConfirm)) return;
    const next = ins
      .filter((i) => i.status === "queued" && (i.typedAt === null || i.resentAt !== null))
      // While a turn goes back to you, internal messages wait for its end, yours past them (§10.5).
      .filter((i) => i.source === "human" || turnChat === null)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find((i) => {
        if (typedFrom(i.body ?? "", i.source === "human") !== null) return true;
        if (!untypable.has(i.id)) log("not typing an input with no source line into the terminal", { slot: s.id, input: i.id });
        untypable.add(i.id);
        return false;
      });
    if (!next) return;
    const info = await request(socket!, "pane.process_info", { pane_id: s.herdrPane }).catch(() => undefined);
    if (!(info?.process_info.foreground_processes ?? []).some((p: { pid: number }) => p.pid === s.tuiPid)) return;
    // Its trace comes after this: with nothing else to look for, the transcript is read from where it ends now.
    const file = typedIn(s).length ? null : await fileOf(s);
    if (file) readTo.set(file, statSync(file, { throwIfNoEntry: false })?.size ?? 0);
    let typed = typedFrom(next.body!, next.source === "human")!.replace(RULES[agent].drop ?? /(?!)/, "");
    // A long one, or one the agent's box could not show whole, goes in the media dir: its source line and path are typed.
    // A command typed bare has no source line and stays whole: one the box cannot show is left unsent there.
    const [line] = typed.split("\n", 1) as [string];
    const rest = typed.slice(line.length + 1);
    if (!COMMAND.test(typed) && ([...rest].length > LONG || !fitsBox(agent, typed, seen.screen, seen.rows ?? seen.screen.split("\n").length))) {
      const path = saveMedia(join(cfg.stateDir, "media"), Buffer.from(rest));
      typed = `${line}\n这条消息有 ${[...rest].length} 字，全文在 ${path}，先读它。`;
    }
    const at = Date.now();
    const begun = store.tx((tx) => {
      const [i, now] = [tx.get("agentInput", next.id), tx.get("slot", s.id)];
      if (i?.status !== "queued" || now?.mode !== "tui" || now.herdrPane !== s.herdrPane || now.herdrLostAt !== null) return false;
      if (i.source !== "human" && now.turnChat !== null) return false;
      tx.update("agentInput", { id: next.id }, { status: "writing", typedAt: at, typed, resentAt: null, noticedAt: null });
      // Yours from a chat, or the board, is where the turn it begins replies to; one going already keeps its own (§10.6).
      if (i.source === "human" && now.turnChat === null) tx.update("slot", { id: s.id }, { turnChat: chatOf(tx, i), turnInbound: i.trace });
      tx.append({ source: "herdr", type: "board_queue" });
      return true;
    });
    if (!begun) return;
    readyOnce.delete(s.id);
    loop.enqueue({ kind: "clock", timer: "tui_unconfirmed", key: next.id });
    const mark = (from: AgentInput["status"], patch: Partial<AgentInput>) =>
      store.tx((tx) => {
        if (!tx.update("agentInput", { id: next.id, status: from, typedAt: at }, patch)) return;
        tx.append({ source: "herdr", type: "board_queue" });
        rehome(tx, s.id);
      });
    // Herdr wraps it in bracketed paste and presses nothing (§10.3).
    const wrote = await call(socket!, "pane.send_input", { pane_id: s.herdrPane, text: typed, keys: [] }).catch(() => undefined);
    if (wrote?.error?.code === "pane_not_found") return mark("writing", { status: "queued", typedAt: null, typed: null });
    if (!wrote || wrote.error) return log("cannot tell whether the text went into the terminal", { slot: s.id, input: next.id, error: wrote?.error?.code ?? "no answer" });
    // The look before Enter: by the wall clock, a read that hangs not waited for past it.
    const end = Date.now() + BEFORE_ENTER;
    let fine = false;
    while (!fine && Date.now() < end) {
      await Bun.sleep(LOOK_STEP);
      const left = end - Date.now();
      if (left <= 0) break;
      const [p, r] = await Promise.all([call(socket!, "pane.get", { pane_id: s.herdrPane }, left), call(socket!, "pane.read", screenOf(s), left)]).catch(() => []);
      const status = p?.result?.pane?.agent_status;
      fine = typeof status === "string" && status !== "blocked" && status !== "unknown" && typeof r?.result?.read?.text === "string" && inBox(agent, r.result.read.text, typed);
    }
    if (!fine) {
      log("left what was typed in the terminal without Enter", { slot: s.id, input: next.id });
      mark("writing", { status: "unknown" });
      return loop.enqueue({ kind: "clock", timer: "tui_unconfirmed", key: next.id });
    }
    const entered = await call(socket!, "pane.send_keys", { pane_id: s.herdrPane, keys: ["enter"] }).catch(() => undefined);
    if (entered && !entered.error) mark("writing", { status: "written" });
    else log("cannot tell whether Enter went into the terminal", { slot: s.id, input: next.id, error: entered?.error?.code ?? "no answer" });
  }

  // ---- A turn in the terminal going back to where your message came from (architecture §10.6, #723). ----

  /** By slot: the transcript file read for its turn and how far, Herdr's idle reads in a row since a
   *  line was last added, what the turn has said since its start, and the pane's session and agent's
   *  PID at the last look. In memory: after a restart it is read again from the turn's start, which its
   *  conversation's progress keeps. */
  const turns = new Map<string, { file: string; at: number; idle: number; heard: Heard; session: string | null; pid: number; calls: Map<string, TurnCall> }>();

  /** Follows the turn in the slot's terminal in the lines added to its transcript since the last look
   *  (§10.6): finds where yours typed there was taken in, its turn's start; ends that turn at the
   *  agent's own mark, or once Herdr says idle twice in a row after its last line and it has said or
   *  done something; cuts it short at an interrupt, or when the pane's session or agent changed. */
  async function follow(s: Slot, status: string | undefined, input?: TuiInput): Promise<void> {
    const agent = agentOf(s);
    const [conv, rows] = store.tx((tx) => [tx.get("conversation", s.conversation!)!, ahead(tx, s.conversation!, true)] as const);
    let turn = turnOf(conv);
    const session = sessionOf(s);
    let m = turns.get(s.id);
    // Before a turn's start is found too: yours taken and not started wait for it no more (第 7 条).
    const last = turn ?? m;
    if (last && (session !== last.session || s.tuiPid !== last.pid)) {
      if (turn) over(s, conv.id, turn, undefined, true);
      else drop(s, conv.id);
      turn = undefined;
    }
    if (m) [m.session, m.pid] = [session, s.tuiPid!];
    const file = await fileOf(s);
    if (!file || session === null) return;
    if (!m || m.file !== file) {
      // From the turn's start; else from well before yours typed and not started, should a restart have
      // missed its line; else from now, as anything of yours typed later is written later.
      const typed = rows.map((i) => i.typedAt!);
      const at = turn ? turn.from : typed.length ? await lineBefore(file, Math.min(...typed) - RESTART_MARGIN).catch(() => 0) : (statSync(file, { throwIfNoEntry: false })?.size ?? 0);
      turns.set(s.id, (m = { file, at, idle: 0, heard: { spoke: !!turn?.quiet }, session, pid: s.tuiPid!, calls: new Map() }));
    }
    const got = await appended(file, m.at);
    m.at = got.end;
    let waiting = rows.filter((i) => i.status === "taken");
    for (const [n, raw] of got.lines.entries()) {
      let v: any;
      try {
        v = JSON.parse(raw);
      } catch {
        continue;
      }
      // A line may hold several of yours, run as one: the first starts the turn, the rest join it. Each
      // time it holds the words counts for one of yours with them, oldest first.
      const used = new Map<string, number>();
      const mine = waiting.filter((i) => {
        const n = (used.get(i.typed!) ?? 0) + 1;
        if (reads(agent, i.typed!, i.typedAt!, v) < n) return false;
        used.set(i.typed!, n);
        return true;
      });
      for (const i of mine) {
        // Older ones not found by now never will be (begin).
        waiting = waiting.filter((w) => w.id > i.id);
        // One the agent runs with no model (a built-in command, pi's !) has done its part: idle ends it.
        const began = begin(s, conv.id, i, { file, from: got.ends[n]!, pid: s.tuiPid!, session, ...(noReply(agent, v) && { quiet: true as const }) });
        if (began) [turn, m.heard] = [began, { spoke: !!began.quiet }];
      }
      if (mine.length) continue;
      const k = turn && turnLine(agent, v);
      if (!k) continue;
      // Read again after a restart from the turn's start, what it showed then is not shown twice; its
      // calls still running are known again.
      step(s, conv.id, got.ends[n]!, k, m.calls, got.ends[n]! > (turn!.at ?? 0));
      m.heard = heard(m.heard, k);
      if (!k.cut && !k.end) continue;
      over(s, conv.id, turn!, k.cut ? undefined : m.heard.reply, k.cut);
      [turn, m.heard] = [undefined, { spoke: false }];
    }
    m.idle = got.lines.length ? 0 : status === "idle" || status === "done" ? m.idle + 1 : 0;
    if (turn && m.heard.spoke && m.idle >= IDLE_READS) {
      over(s, conv.id, turn, m.heard.reply);
      m.heard = { spoke: false };
    }
    if (turn && input === "dialog" && !turn.told) blocked(s, conv.id, turn);
  }

  /** A dialog opened in the terminal while your chat waits on the turn (§10.6 弹框): told there once a
   *  turn, marked in its progress, which goes with the turn. Not for the board's turn. */
  function blocked(s: Slot, convId: string, turn: Turn): void {
    let to: { chat: string; inbound: string | null } | undefined;
    store.tx((tx) => {
      const [now, conv] = [tx.get("slot", s.id), tx.get("conversation", convId)];
      const was = conv && turnOf(conv);
      if (!now?.turnChat || now.turnChat === BOARD || !was || was.told || was.session !== turn.session || was.from !== turn.from) return;
      const progress = JSON.parse(conv.progress!);
      tx.update("conversation", { id: convId }, { progress: JSON.stringify({ ...progress, tui: { ...was, told: true } }) });
      to = { chat: now.turnChat, inbound: now.turnInbound };
    });
    if (to) loop.enqueue({ kind: "tui_turn", slot: s.id, dialog: to });
  }

  /** What the line ending at byte `at` says the turn did, for its message as it goes (§10.6 第 3 条): the
   *  agent's words; a tool call started, but for one whose result is in the same line (Codex's); one
   *  done, as it was called (calls: those started and not done). In one batch, how far the transcript
   *  is read committed with it; for a line shown before (not show), only calls is kept. */
  function step(s: Slot, conv: string, at: number, k: TurnLine, calls: Map<string, TurnCall>, show: boolean): void {
    const events: Extract<Input, { step: unknown }>["step"]["event"][] = [];
    // ponytail: a Claude message of several text blocks, one line each, shows as as many parts; join lines of one message.id if that shows.
    if (k.said !== undefined) events.push({ type: "item", item: { kind: "message", text: k.said } });
    for (const c of k.calls ?? []) if (!k.results?.includes(c.id)) calls.set(c.id, c), events.push({ type: "tool_start", ...c });
    for (const id of k.results ?? []) {
      // A result whose call came before the turn's start has no tool line.
      const c = k.calls?.find((c) => c.id === id) ?? calls.get(id);
      calls.delete(id);
      if (c) events.push({ type: "item", item: { kind: "tool", ...c } });
    }
    if (show && events.length) loop.batch(events.map((event) => ({ kind: "tui_turn", slot: s.id, step: { conv, at, event } })), []);
  }

  /** Your message's turn starts past the line where the agent took it in, at `at` (§10.6 第 2 条): the
   *  first found this turn starts it, its chat the turn's; a later one joins it,
   *  told so if from another chat, and lifts an rh send me's hold on it. Returns the new turn's start,
   *  if it began one. */
  function begin(s: Slot, convId: string, mine: AgentInput, at: Turn): Turn | undefined {
    let joined: { chat: string; inbound: string; into: string } | undefined;
    let began: Turn | undefined;
    let lifts = false;
    store.tx((tx) => {
      const [now, conv] = [tx.get("slot", s.id), tx.get("conversation", convId)];
      if (now?.mode !== "tui" || now.herdrPane !== s.herdrPane || !conv) return;
      tx.update("agentInput", { id: mine.id }, { typed: null });
      // The agent takes yours in the order typed: one before this, taken and not started, never will
      // be (gone from the box, say), and no longer holds the turn's chat.
      for (const i of ahead(tx, convId)) if (i.status === "taken" && i.id < mine.id) tx.update("agentInput", { id: i.id }, { typed: null });
      const chat = chatOf(tx, mine);
      const patch: Partial<Slot> = {};
      const starts = !turnOf(conv);
      if (starts) {
        began = at;
        tx.update("conversation", { id: convId }, { progress: JSON.stringify({ ...(conv.progress ? JSON.parse(conv.progress) : fresh()), tui: began }) });
        // rh send me's mark on the turn goes by it (router's unsaid).
        patch.turnStartedAt = Date.now();
      }
      // A turn yours starts is its chat's; as headless, yours from IM takes over a turn the board began (product §7).
      if (starts || now.turnChat === null || (now.turnChat === BOARD && chat !== BOARD)) Object.assign(patch, { turnChat: chat, turnInbound: mine.trace });
      else if (now.turnChat !== chat && chat !== BOARD && mine.trace) joined = { chat, inbound: mine.trace, into: now.turnChat };
      // What it said under the hold stays unshown: the router lifts it, as headless.
      lifts = !!now.turnSentMe;
      tx.update("slot", { id: s.id }, patch);
    });
    if (lifts) loop.enqueue({ kind: "tui_turn", slot: s.id, lift: true });
    if (joined) loop.enqueue({ kind: "tui_turn", slot: s.id, joined });
    return began;
  }

  /** The slot's turn is over (§10.6 第 5、6 条), with its final reply or none, or cut short. Its fields
   *  go on to the next of yours typed and not started, or go; cut short, yours taken and not started
   *  are let go too. The router sends what is due. Not a turn that moved on meanwhile. */
  function over(s: Slot, convId: string, turn: Turn, reply: string | undefined, cut = false): void {
    let end: Extract<Input, { kind: "tui_turn"; end: unknown }>["end"] | undefined;
    store.tx((tx) => {
      const [now, conv] = [tx.get("slot", s.id), tx.get("conversation", convId)];
      const was = conv && turnOf(conv);
      if (!now || !was || was.session !== turn.session || was.from !== turn.from) return;
      if (cut) for (const i of ahead(tx, convId)) if (i.status === "taken") tx.update("agentInput", { id: i.id }, { typed: null });
      const next = ahead(tx, convId)[0];
      end = { conv: convId, chat: now.turnChat, inbound: now.turnInbound, sentMe: now.turnSentMe, progress: conv.progress, ...(cut ? { cut: true as const } : reply !== undefined && { reply }) };
      tx.update("slot", { id: s.id }, { turnChat: next ? chatOf(tx, next) : null, turnInbound: next?.trace ?? null, turnSentMe: null, turnStartedAt: null });
      tx.update("conversation", { id: convId }, { progress: null });
    });
    if (end) loop.enqueue({ kind: "tui_turn", slot: s.id, end });
  }

  /** The pane's session or agent changed with no turn going (§10.6 第 6、7 条): yours taken and not
   *  started never will be, and the turn's chat goes on to the next of yours on its way, or goes. */
  function drop(s: Slot, convId: string): void {
    store.tx((tx) => {
      const now = tx.get("slot", s.id);
      if (now?.mode !== "tui" || now.herdrPane !== s.herdrPane) return;
      const taken = ahead(tx, convId).filter((i) => i.status === "taken");
      for (const i of taken) tx.update("agentInput", { id: i.id }, { typed: null });
      rehome(tx, s.id);
      if (taken.length) tx.append({ source: "herdr", type: "board_queue" });
    });
  }

  /** Yours typed into the conversation's terminal whose turn has not started: typed and not known
   *  taken, or taken and its start not found, oldest first; unknown: those not known taken too. */
  const ahead = (tx: Tx, conv: string, unknown = false) =>
    (["writing", "written", "taken", ...(unknown ? (["unknown"] as const) : [])] as const)
      .flatMap((status) => tx.find("agentInput", { conversation: conv, status, queueReason: IN_TUI }))
      .filter((i) => i.source === "human" && i.typed !== null)
      .sort((a, b) => (a.id < b.id ? -1 : 1));

  /** One of yours typed in turned unknown before its turn started: the turn's chat is the next of
   *  yours on its way, or none, and internal messages go in again (§10.6 第 6 条). */
  function rehome(tx: Tx, slotId: string): void {
    const now = tx.get("slot", slotId);
    if (!now?.turnChat || !now.conversation || turnOf(tx.get("conversation", now.conversation)!)) return;
    const next = ahead(tx, now.conversation)[0];
    if (next?.trace !== now.turnInbound) tx.update("slot", { id: slotId }, { turnChat: next ? chatOf(tx, next) : null, turnInbound: next?.trace ?? null });
  }

  /** Whether the slot's box holds just what was typed for the input, for the notice that it is not
   *  known to have got there (architecture §10.5): said with a tui_peeked input. */
  async function peek(slotId: string, inputId: string): Promise<void> {
    const [s, i] = store.tx((tx) => [tx.get("slot", slotId), tx.get("agentInput", inputId)] as const);
    const at = await herdrSocket();
    const r = s?.herdrPane && at && i?.typed ? await call(at, "pane.read", screenOf(s), 2_000).catch(() => undefined) : undefined;
    const text = r?.result?.read?.text;
    loop.enqueue({ kind: "tui_peeked", input: inputId, inBox: typeof text === "string" && inBox(agentOf(s!), text, i!.typed!) });
  }

  // ---- rh import (product §4.3): only what it is told to take, never another agent. ----

  /** The one conversation on disk whose id starts with prefix, and the directory it was started in. */
  async function fromDisk(prefix: string): Promise<ImportFound> {
    const hits = await findConversations(prefix);
    if (!hits.length) fail(`磁盘上没有对话 ${prefix}`);
    if (hits.length > 1) fail(`以 ${prefix} 开头的对话有 ${hits.length} 段，写长一点：${hits.slice(0, 5).map((h) => h.id).join("、")}${hits.length > 5 ? " 等" : ""}`);
    const { agent, id: session, file } = hits[0]!;
    const cwd = (await startedIn(file)) ?? fail(`对话 ${session} 的记录里没有它的目录`);
    const dir = windows ? localDrivePath(cwd) : cwd;
    if (!existsSync(dir)) fail(`对话 ${session} 的目录 ${dir} 已经不在了`);
    await nobodyHas(session);
    return { agent, session, dir };
  }

  /** The agent in the pane of Rhodium's Herdr session: the session it reports, its directory, and
   *  where it runs, which the slot watches from now on as if it had switched there (architecture §10.1). */
  async function fromPane(pane: string): Promise<ImportFound> {
    const at = await sessionSocket(program(cfg.programs.herdr), cfg.herdr.session);
    const p = (await call(at, "pane.get", { pane_id: pane })).result?.pane ?? fail(`Herdr 会话 ${cfg.herdr.session} 里没有 pane ${pane}`);
    // Your codex in a pane runs on your shared app-server, which knows of no slot (spec codex.md 不做的事).
    if ((p.agent_session?.agent ?? p.agent) === "codex") fail("Codex 只能从磁盘导入：rh import <线程 ID>");
    const reported = p.agent_session ?? fail(`pane ${pane} 里没有报告了对话的 agent`);
    const kind: AgentKind = reported.agent;
    if (!importsPane(kind)) fail(`pane ${pane} 里的 agent 是 ${kind}，暂时只能导入 ${AGENT_KINDS.filter(importsPane).join("、")} 的 pane`);
    const session = paneSession(p)!;
    const { process_info } = await request(at, "pane.process_info", { pane_id: pane });
    const target = await inspectPaneAgent(kind, pane, session, process_info.foreground_processes, checkPi);
    await nobodyHas(session, { pid: target.pid, pane });
    return { agent: kind, session, dir: target.dir, pane: { workspace: p.workspace_id, tab: p.tab_id, pane, pid: target.pid, start: target.start } };
  }

  /** What there is to import: the agents the panes of Rhodium's Herdr session report (none
   *  while Herdr is away), with what their conversation on disk last said, if it has said anything;
   *  and the conversations on disk started in dir but for those, once each. */
  async function importable(dir: string): Promise<{ dir: string; list: Importable[] }> {
    const at = await herdrSocket();
    const snap = at && (await request(at, "session.snapshot").catch(() => undefined));
    const listed = new Map<string, Promise<Conversation[]>>();
    const inDir = (d: string) => listed.get(d) ?? listed.set(d, listConversations(d)).get(d)!;
    const panes: Importable[] = await Promise.all(
      (snap?.snapshot.panes ?? [])
        .filter((p: any) => importsPane(p.agent_session?.agent))
        .map(async (p: any) => {
          const [session, cwd] = [paneSession(p)!, p.foreground_cwd ?? p.cwd];
          const c = (await inDir(cwd)).find((c) => c.id === session);
          return { agent: p.agent_session.agent, session, dir: cwd, pane: p.pane_id, ...(c && { at: c.modifiedAt.getTime(), said: c.title }) };
        }),
    );
    const disk = (await inDir(dir))
      .filter((c) => !panes.some((p) => p.session === c.id))
      .map((c) => ({ agent: c.agent, session: c.id, dir, at: c.modifiedAt.getTime(), said: c.title }));
    return { dir, list: [...panes, ...disk] };
  }

  /** Looks up what rh import names, and says what came of it with an import input. A pane's slot is
   *  in the terminal from then on: rhodium holds its conversation lock and watches its agent. */
  async function importFrom(e: Extract<Effect, { kind: "import" }>): Promise<void> {
    let found: Extract<Input, { kind: "import" }>["found"];
    try {
      found = "dir" in e.what ? await importable(e.what.dir) : "session" in e.what ? await fromDisk(e.what.session) : await fromPane(e.what.pane);
    } catch (err) {
      found = { error: (err as Error).message };
    }
    // The slot this import makes, if it makes one: one with the pane already refuses it (imported()).
    const pane = "pane" in found ? found.pane?.pane : undefined;
    const slots = () => (pane ? store.tx((tx) => tx.find("slot", { herdrPane: pane })) : []);
    const had = slots().length;
    const { what: _, ...rest } = e;
    loop.enqueue({ ...rest, found });
    const [s] = had ? [] : slots();
    if (!s?.conversation) return; // refused
    const fd = conversationLock(holderPaths(cfg, s.conversation).lock);
    if (fd === null) log("cannot take an imported slot's conversation lock", { slot: s.id });
    else locks.set(s.conversation, fd);
    void watch();
  }

  void watch(); // slots in the terminal before this rhodium started

  // One at a time: two slots of a workspace switching at once would each make it a Herdr workspace.
  let opening = Promise.resolve();
  const next = (slot: string) => open(slot).catch((err) => log("cannot switch to the terminal", { slot, error: String(err) }));
  return {
    open: (slot: string) => void (opening = opening.then(() => next(slot))),
    back: (slot: string, force: boolean) => void back(slot, force).catch((err) => log("cannot switch back to headless", { slot, error: String(err) })),
    /** Gives the slot's tab its name (rh rename), if Rhodium opened it: one imported is yours, and
     *  keeps the name you gave it. One Herdr does not take keeps the old one. */
    label: (slot: string) =>
      void (async () => {
        const [s, ws] = store.tx((tx) => {
          const s = tx.get("slot", slot);
          return [s, s && tx.get("workspace", s.workspace)] as const;
        });
        const at = await herdrSocket();
        if (!s?.herdrTab || !ws?.herdrWorkspace || !at) return;
        const { snapshot } = await request(at, "session.snapshot");
        const ours = snapshot.tabs.some((t: any) => t.tab_id === s.herdrTab && t.workspace_id === ws.herdrWorkspace);
        if (ours) await request(at, "tab.rename", { tab_id: s.herdrTab, label: s.name });
      })().catch((err) => log("cannot rename the tab", { slot, error: String(err) })),
    import: (e: Extract<Effect, { kind: "import" }>) => void importFrom(e),
    peek: (slot: string, input: string) => void peek(slot, input).catch((err) => log("cannot read the terminal", { slot, error: String(err) })),
    /** Why someone else uses the session, or null: checked before a headless start resumes it. */
    inUse: (session: string) => nobodyHas(session).then(() => null, (err: Error) => err.message),
  };
}

type Resumed = Extract<Input, { kind: "herdr"; up: true }>["resumed"];

// ---- Whether a slot's terminal takes typing now (architecture §10.5, #665). ----

/** What the terminal of a slot is at for typing: unknown, a dialog open, text in the input box, or ready. */
export type TuiInput = NonNullable<Slot["tuiInput"]>;

/** A screen line's text: its styles gone, and with dim: false the dim runs too, Claude's grey hints. */
function textOf(line: string, dim = true): string {
  let out = "";
  let faint = false;
  for (const [i, part] of line.split(/\x1b\[([0-9;:]*)m/).entries()) {
    if (i % 2 === 0) {
      if (dim || !faint) out += part;
      continue;
    }
    const ps = part === "" ? [0] : part.split(/[;:]/).map(Number);
    for (let j = 0; j < ps.length; j++) {
      const p = ps[j];
      if (p === 0) faint = false;
      else if (p === 2) faint = true;
      else if (p === 22) faint = false;
      // A colour's own numbers: 38;5;n, 38;2;r;g;b, and 48 and 58 alike.
      else if (p === 38 || p === 48 || p === 58) j += ps[j + 1] === 5 ? 2 : 4;
    }
  }
  return out.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\r$/, "");
}

/** What an agent's screen shows for typing: a dialog's footer; the input box's lines without its
 *  prompt mark and with the dim grey hint gone, null for none; the lines under it; and the box's width. */
type Box = { dialog: boolean; box: string[] | null; under: string[]; cols: number; shell?: true; picked?: string };

/** A dialog's footer, as whole words in any case: "center to" is none. */
const FOOTER = /\b(?:esc to cancel|esc to close|esc close|enter to )/i;

/** Claude's screen (Claude Code 2.1.325, Herdr 0.9.5, test/fixtures/herdr/claude-screens.jsonl,
 *  claude-typed-screens.jsonl): a dialog's footer among the last lines below the last plain rule (or the
 *  last lines, /status having no rule); else the input box between the bottom two rules, its first line
 *  ❯, the hint a suggestion or "Press up to edit queued messages". The top rule may hold the session's
 *  name (/rename). In shell mode (a ! typed first) its mark is ! instead, kept as the box's first
 *  character. A / command typed shows the commands it may be in a list right above the box, the one
 *  Enter takes marked ❯ (picked). */
function claudeBox(screen: string): Box {
  const lines = screen.split("\n");
  const plain = lines.map((l) => textOf(l));
  const rules = plain.flatMap((l, i) => (/^─{8,}$/.test(l.trim()) ? [i] : []));
  const below = plain.slice((rules.at(-1) ?? -1) + 1).filter((l) => l.trim());
  const dialog = below.slice(-3).some((l) => FOOTER.test(l));
  const edges = plain.flatMap((l, i) => (/^─{8,}(?:.*─)?$/.test(l.trim()) ? [i] : []));
  const none = { dialog, box: null, under: [], cols: 0 };
  if (edges.length < 2) return none;
  const [top, bottom] = edges.slice(-2) as [number, number];
  const box = lines.slice(top + 1, bottom).map((l) => textOf(l, false));
  const mark = box[0]?.trimStart()[0];
  if (mark !== "❯" && mark !== "!") return none;
  box[0] = (mark === "!" ? "!" : "") + box[0]!.trimStart().slice(1);
  // The list: the lines right above the box, each indented, up to the first blank one.
  const above = plain.slice(0, top);
  const list = above.slice(above.findLastIndex((l) => !l.trim()) + 1).filter((l) => /^\s{2}/.test(l));
  const picked = list.map((l) => /^\s+❯ (\/\S+)/.exec(l)?.[1]).find(Boolean);
  return { dialog, box, under: plain.slice(bottom + 1), cols: plain[bottom]!.trim().length, ...(mark === "!" && { shell: true as const }), ...(picked && { picked }) };
}

/** Codex's screen (codex-cli 0.166.0, test/fixtures/herdr/codex-screens.jsonl): no rules. The box runs
 *  from the last line starting › (» at ultra effort; your messages in the history above start › too) to the last blank
 *  line, the status lines under it (a blank line in your text is one in the box too); its hint "Ask
 *  Codex to do anything". A dialog: a footer among the lines under the box (the approval dialog's
 *  "Press enter to confirm or esc to cancel"), or a popup's hint as the line just above it (a trailing
 *  @word's file popup, "enter/tab insert · esc close", a $word's skills popup, "enter insert · esc
 *  close", where Enter takes the item; only its start, as a narrow pane cuts it with …). With no blank
 *  line under the box it runs to the end, and a footer among the last three lines is a dialog; with its
 *  last two rows (status and hint) both blank it runs to the end with no footer. Its width: the widest line, its status line cut to
 *  the pane's. */
function codexBox(screen: string): Box {
  const lines = screen.split("\n");
  const plain = lines.map((l) => textOf(l));
  const top = plain.findLastIndex((l) => /^[›»]/.test(l));
  if (top < 0) return { dialog: plain.filter((l) => l.trim()).slice(-3).some((l) => FOOTER.test(l)), box: null, under: [], cols: 0 };
  // The read's last two rows are its status row and hint row; both blank (a status line with no value,
  // a draft hiding the hint) is no footer, and a blank line above them is the draft's own.
  const footer = plain.slice(-2).some((l) => l.trim());
  const last = plain.findLastIndex((l) => l.trim());
  const end = footer ? plain.findLastIndex((l, i) => i > top && i < last && !l.trim()) : -1;
  // Both rows blank, there is no footer: the box's own words are not searched for one.
  const under = end >= 0 ? plain.slice(end) : footer ? plain.slice(top).filter((l) => l.trim()).slice(-3) : [];
  const above = plain.slice(0, top).findLast((l) => l.trim());
  const dialog = under.some((l) => FOOTER.test(l)) || /^enter(?:\/tab)? insert\b/.test(above?.trim() ?? "");
  const box = lines.slice(top, end < 0 ? undefined : end).map((l) => textOf(l, false));
  box[0] = box[0]!.slice(1);
  return { dialog, box, under: end < 0 ? [] : under, cols: Math.max(...plain.map((l) => Bun.stringWidth(l))) };
}

/** pi's screen (pi 1.5.0, test/fixtures/herdr/pi-screens.jsonl): the box between the last two rules,
 *  which start at the line's first column (the box's own lines are indented); the top one may hold
 *  "⠹ Working" or "↑ 5 more". No hint, no dialog footer seen: Herdr's blocked tells a dialog. */
function piBox(screen: string): Box {
  const lines = screen.split("\n");
  const plain = lines.map((l) => textOf(l));
  const below = (from: number) => plain.slice(from).filter((l) => l.trim());
  const edges = plain.flatMap((l, i) => (/^─.*─$/.test(l.trimEnd()) ? [i] : []));
  if (edges.length < 2) return { dialog: below(0).slice(-3).some((l) => FOOTER.test(l)), box: null, under: [], cols: 0 };
  const [top, bottom] = edges.slice(-2) as [number, number];
  return {
    dialog: below(bottom + 1).slice(-3).some((l) => FOOTER.test(l)),
    box: lines.slice(top + 1, bottom).map((l) => textOf(l, false)),
    under: plain.slice(bottom + 1),
    cols: plain[bottom]!.trimEnd().length,
  };
}

/**
 * By agent, how its terminal reads (architecture §10.5): box, its screen; pasted, its one placeholder
 * for a paste, as squeezed; folds, whether it shows a paste of that many lines and characters as that
 * placeholder; margin, the columns its box takes from a line; height, the most lines its box shows in a
 * pane of that many rows, less one spare; drop, what is left out of the text typed for it; said, the
 * text of a transcript line that is your message, as raw content; late, its trace of a message typed
 * while it works is written only once it reaches it, so its box emptying after Enter takes it.
 * ponytail: height counts a box's lines as if wrapped at characters, where the agents wrap at words: a
 * line short, so one is left spare. Wrap at words here too if a box of long words ever overflows it.
 */
const RULES: Record<AgentKind, { box: (screen: string) => Box; pasted: RegExp; folds: (lines: number, chars: number) => boolean; margin: number; height: (rows: number) => number; drop?: RegExp; said: (v: any) => unknown; command?: (text: string) => string; late?: true }> = {
  // Its box at most half the pane's rows less 5 (2026-11-15, rows 24 to 40).
  claude: {
    box: claudeBox,
    pasted: /^\[Pastedtext#\d+(?:\+\d+lines?)?\]$/,
    folds: (lines, chars) => lines > 3 || chars > 800,
    margin: 2,
    height: (rows) => Math.floor(rows / 2) - 6,
    // A user line, or an enqueue line: written at Enter while it works; or a built-in command's line.
    said: (v) => (v.type === "user" ? v.message?.content : v.type === "queue-operation" && v.operation === "enqueue" ? v.content : localCommand(v) ? v.content : undefined),
    command: claudeCommand,
  },
  // Its box at 16, 24, 30, 40 and 50 rows: 6, 12, 16, 22 and 29 lines; a wide character never in its
  // last two columns. A steered message (Enter while it works) is in the rollout at once. An emoji with
  // a variation selector it draws a column narrower than Herdr does, which garbles the line on screen
  // (2026-11-15): typed without them, which the comparisons leave aside anyway.
  codex: {
    box: codexBox,
    pasted: /^\[PastedContent\d+chars\]$/,
    folds: (_, chars) => chars > 1000,
    margin: 4,
    height: (rows) => Math.floor(rows / 2) - 3,
    drop: /[︎️]/g,
    said: (v) => (v.type === "response_item" && v.payload?.type === "message" && v.payload.role === "user" ? v.payload.content : undefined),
  },
  // Its box at most max(5, 30% of the rows) lines (16 to 40 rows). A message steered while it works is
  // written only when it reaches it, after the running tool: late.
  pi: {
    box: piBox,
    pasted: /^\[paste#\d+(?:\+\d+lines|\d+chars)\]$/,
    folds: (lines, chars) => lines > 10 || chars > 1000,
    margin: 2,
    height: (rows) => Math.max(5, Math.floor(rows * 0.3)) - 1,
    said: (v) => (v.type !== "message" ? undefined : v.message?.role === "user" ? v.message.content : v.message?.role === "bashExecution" ? `!${v.message.command}` : undefined),
    command: piCommand,
    late: true,
  },
};

/** What the slot's terminal is at for typing, from what Herdr says of its agent and the bottom of its
 *  screen with its styles (pane.read, recent, ansi), in architecture §10.5's order. vim: Claude's
 *  editorMode is vim, where only the INSERT mark under the box says it takes text; NORMAL shows none. */
export function inputState(agent: AgentKind, status: string | undefined, screen: string | undefined, vim = false): TuiInput {
  if (status === undefined || screen === undefined) return "unknown";
  const { dialog, box, under } = RULES[agent].box(screen);
  if (status === "blocked" || dialog) return "dialog";
  if (status === "unknown" || !box) return "unknown";
  if (vim && !under.some((l) => l.trim().startsWith("-- INSERT --"))) return "draft";
  return box.join("").trim() ? "draft" : "ready";
}

// ---- Typing internal messages into the terminal (architecture §10.5, #712). ----

/** What Claude drops from a prompt on Enter (2026-11-15, 2.1.325): zero-width and format characters,
 *  bidi controls (with which it then waits for a second Enter), tag characters, fillers. Joiners stay,
 *  and variation selectors: an emoji keeps them. */
const INVISIBLE = /[­͏؜ᅟᅠ᠎​‎‏‪-‮⁠-⁤⁦-⁩ㅤ﻿￹-￻\u{e0000}-\u{e007f}]/gu;

/** A / or ! command of yours from the board, typed bare (architecture §10.5, #737). */
const COMMAND = /^[/!]/;

/** What is typed for an internal message's body (architecture §10.5): without control characters but
 *  tab and newline, CR and CRLF as newlines, escape sequences gone whole, and what Claude drops on
 *  Enter gone; a space after a last backslash, which with Enter Claude takes for a newline. null unless
 *  its first line is a source line: so it never starts with / or !; but with bare, one of yours from
 *  the board, a / or ! command, typed as it is. */
export function typedFrom(body: string, bare = false): string | null {
  const typed = body
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(INVISIBLE, "")
    .replace(/\\$/, "\\ ");
  return splitSource(typed).source !== null || (bare && COMMAND.test(typed)) ? typed : null;
}

/** Text as compared on screen and in the transcript: no whitespace (Claude shows a tab as spaces), no
 *  joiners or variation selectors (a standalone joiner Claude drops), no paste tags. */
const squeezed = (t: string) => t.replace(/<\/?pasted_content\b[^>]*>/g, "").replace(/[\s‌‍︎️]/g, "");

/** Whether the agent's box holds just what was typed, before Enter (architecture §10.5): no dialog, and
 *  the box's text is it, or the agent's one placeholder for a paste, alone. */
export function inBox(agent: AgentKind, screen: string, typed: string): boolean {
  const { dialog, box, shell, picked } = RULES[agent].box(screen);
  if (dialog || !box) return false;
  // Enter takes the command picked in Claude's list, which must be the one typed.
  if (typed.startsWith("/") && picked !== undefined && picked !== typed.split(/\s/, 1)[0]) return false;
  const [shown, want] = [squeezed(box.join("\n")), squeezed(typed)];
  // In Claude's shell mode the rest of a command in its history it suggests looks typed, and Enter
  // leaves it out (#737 probe): the typed command with more after it.
  // ponytail: text you begin to type there at that moment passes too; tell the suggestion apart if its style ever shows.
  if (shell && typed.startsWith("!") && shown.startsWith(want)) return true;
  return shown === want || RULES[agent].pasted.test(shown);
}

/** Whether the agent's box can show the typed text whole, so the look before Enter can see it: one it
 *  folds into a placeholder always can; else by the box's width on this screen and its height in a pane
 *  of rows. */
export function fitsBox(agent: AgentKind, typed: string, screen: string, rows: number): boolean {
  const rule = RULES[agent];
  const lines = typed.split("\n");
  if (rule.folds(lines.length, [...typed].length)) return true;
  const width = rule.box(screen).cols - rule.margin;
  if (width <= 0) return true; // no box seen: the look before Enter tells
  const need = lines.reduce((n, l) => n + Math.max(1, Math.ceil(Bun.stringWidth(l) / width)), 0);
  return need <= rule.height(rows);
}

/** Whether the agent's transcript lines (raw JSONL) hold the trace of what was typed at `at`
 *  (architecture §10.5): a line of your message (RULES' said), of a second before it or later, whose
 *  text holds all of it, paste tags and whitespace aside. */
export function traced(agent: AgentKind, typed: string, at: number, lines: string[]): boolean {
  const want = squeezed(typed);
  return lines.some((raw) => {
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!(Date.parse(v?.timestamp) >= at - 1000)) return false;
    const text = textIn(agent, RULES[agent].said(v));
    // Claude's enqueue line for a ! command typed while it works leaves the ! out (#737 probe).
    return text !== "" && (text.includes(want) || (want.startsWith("!") && v.type === "queue-operation" && text === want.slice(1)));
  });
}

// ---- A turn in the terminal, read off the transcript (architecture §10.6, #723). ----

/** How many times the transcript line (parsed) is where the agent took in what was typed at `at`: your
 *  message's line holding it, as traced() compares, but for Claude only the user line or the
 *  queued_command attachment it runs a queued one as, not the enqueue line written at Enter. 0 for none. */
export function reads(agent: AgentKind, typed: string, at: number, v: any): number {
  if (!(Date.parse(v?.timestamp) >= at - 1000)) return 0;
  const content =
    agent === "claude" ? (v.type === "user" ? v.message?.content : v.type === "attachment" && v.attachment?.type === "queued_command" ? v.attachment.prompt : localCommand(v) ? v.content : undefined) : RULES[agent].said(v);
  return textIn(agent, content).split(squeezed(typed)).length - 1;
}

/** A transcript line's text, as compared: a string, or a content array's text blocks; a command as it
 *  was typed (RULES' command). */
function textIn(agent: AgentKind, content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
  return squeezed(RULES[agent].command?.(text) ?? text);
}

/** Claude's line for a built-in command (#737 probe, 2.1.325): a system line with the command's name,
 *  not one with its output. */
const localCommand = (v: any) => v?.type === "system" && v.subtype === "local_command" && typeof v.content === "string" && v.content.includes("<command-name>");

/** A command as typed, from Claude's line for it (#737 probe, 2.1.325): a skill's or a built-in's tags
 *  (name, then arguments), or the shell input of a ! command. */
function claudeCommand(text: string): string {
  // Only a line that opens with the tags is a command's: tags written in a message are its words.
  const name = text.trimStart().startsWith("<command-") ? /<command-name>(\/[^<]*)<\/command-name>/.exec(text)?.[1] : undefined;
  if (name) return `${name} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ""}`;
  const shell = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text.trim())?.[1];
  return shell === undefined ? text : `!${shell}`;
}

/** A /skill: command as typed, from pi's user message for it (#737 probe, 1.5.0): the skill in its tag,
 *  then the arguments. */
function piCommand(text: string): string {
  const m = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/.exec(text);
  return m ? `/skill:${m[1]} ${m[2]}` : text;
}

/** Whether a turn's start line is one the agent runs with no model, so no words of its own follow
 *  (#737 probes): Claude's built-in command, pi's ! command. */
export const noReply = (agent: AgentKind, v: any): boolean => (agent === "claude" ? localCommand(v) : agent === "pi" && v?.type === "message" && v.message?.role === "bashExecution");

/** What a transcript line past a turn's start says of it (architecture §10.6): the agent's words (id:
 *  its message's, whose lines Claude writes one block each; final: Codex's final_answer), a tool
 *  call, the turn cut short (Esc, or a permission dialog's No), or its end as the agent marks it.
 *  calls: the tool calls it made, whole, as the headless drivers give them; results: the ids of those
 *  whose result came (Codex writes a call with its result, in one line). null for any other line: your
 *  words, its thoughts, a Claude subagent's lines. */
export type TurnCall = { id: string; name: string; input: unknown };
export type TurnLine = { said?: string; id?: string; final?: true; acted?: true; cut?: true; end?: true; calls?: TurnCall[]; results?: string[] };
export function turnLine(agent: AgentKind, v: any): TurnLine | null {
  if (!v || typeof v !== "object") return null;
  const texts = (content: unknown) => (Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("") : "");
  if (agent === "claude") {
    if (v.isSidechain) return null;
    // Turn's end (probe 2): the line with how long the turn took.
    if (v.type === "system") return v.subtype === "turn_duration" ? { end: true } : null;
    const content = v.message?.content;
    if (v.type === "user") {
      const all = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text) : [];
      const results = list(content).flatMap((b: any) => (b?.type === "tool_result" ? [String(b.tool_use_id)] : []));
      const cut = all.length === 1 && /^\[Request interrupted by user( for tool use)?\]$/.test(all[0]);
      // A ! command's output: done, should no words of the model's follow.
      if (all.some((t: string) => t.startsWith("<bash-stdout>"))) return { acted: true };
      return cut || results.length ? { ...(cut && { cut: true as const }), ...(results.length && { results }) } : null;
    }
    if (v.type !== "assistant") return null;
    const said = texts(content);
    const calls = list(content).flatMap((b: any) => (b?.type === "tool_use" ? [{ id: String(b.id), name: String(b.name), input: b.input }] : []));
    return said || calls.length ? { ...(said && { said, ...(v.message?.id && { id: v.message.id }) }), ...(calls.length && { acted: true as const, calls }) } : null;
  }
  if (agent === "codex") {
    const p = v.type === "event_msg" ? v.payload : undefined;
    if (p?.type === "turn_aborted") return { cut: true };
    if (p?.type === "task_complete") return { end: true };
    const item = p?.type === "item_completed" ? p.item : undefined;
    if (item?.type === "AgentMessage") {
      const said = list(item.content).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
      return said ? { said, ...(item.phase === "final_answer" && { final: true as const }) } : null;
    }
    if (!item || !["CommandExecution", "FileChange", "McpToolCall", "ImageView", "Extension", "SubAgentActivity"].includes(item.type)) return null;
    const call = codexCall(item);
    const id = String(item.id);
    return { acted: true, ...(call && { calls: [{ id, name: call.name, input: call.arguments }], results: [id] }) };
  }
  // pi: Esc writes an assistant message stopped as aborted, or by an error saying so mid-tool (probe 5).
  const m = v.type === "message" ? v.message : undefined;
  if (m?.role === "toolResult") return { results: [String(m.toolCallId)] };
  if (m?.role !== "assistant") return null;
  if (m.stopReason === "aborted" || (m.stopReason === "error" && /\baborted\b/i.test(String(m.errorMessage ?? "")))) return { cut: true };
  const said = texts(m.content);
  const calls = list(m.content).flatMap((b: any) => (b?.type === "toolCall" ? [{ id: String(b.id), name: String(b.name), input: b.arguments }] : []));
  return said || calls.length ? { ...(said && { said }), ...(calls.length && { acted: true as const, calls }) } : null;
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** What a turn has said so far: whether the agent spoke or called a tool, and its final reply as the
 *  headless drivers take it (§6.2–§6.4): the last message's text, a Claude message's blocks joined,
 *  Codex's final_answer first. */
export type Heard = { spoke: boolean; reply?: string; id?: string; final?: true };
export function heard(h: Heard, k: TurnLine): Heard {
  if (k.said === undefined) return k.acted ? { ...h, spoke: true } : h;
  if (k.id !== undefined && k.id === h.id) return { ...h, spoke: true, reply: (h.reply ?? "") + k.said };
  if (h.final && !k.final) return { ...h, spoke: true };
  return { spoke: true, reply: k.said, ...(k.id !== undefined && { id: k.id }), ...(k.final && { final: true as const }) };
}

/** Whether Claude's editorMode is vim for the slot's terminal: the first source that sets it, by Claude's
 *  order: managed, the --settings flag of its process (pid), the slot directory's local and project
 *  settings, yours, then the legacy key in ~/.claude.json (architecture §10.5). Read only, never written. */
export function vim(dir: string, pid: number, home = homedir(), native?: VimLaunch, managed = managedVimFile()): boolean {
  let flag = native?.settings;
  if (!detached && !native) {
    try { flag = lastSettings(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")); }
    catch {} // gone: the files alone
  }
  const sources = [
    () => readFileSync(managed, "utf8"),
    () => {
      if (flag === undefined || flag.trimStart().startsWith("{")) return flag ?? "";
      if (native && isAbsolute(flag)) return readFileSync(flag, "utf8");
      const cwd = native ? native.cwd : readlinkSync(`/proc/${pid}/cwd`);
      return cwd ? readFileSync(resolve(cwd, flag), "utf8") : "";
    },
    ...[join(dir, ".claude/settings.local.json"), join(dir, ".claude/settings.json"), join(home, ".claude/settings.json"), join(home, ".claude.json")].map((f) => () => readFileSync(f, "utf8")),
  ];
  for (const read of sources) {
    try {
      const mode = JSON.parse(read())?.editorMode;
      if (mode !== undefined) return mode === "vim";
    } catch {} // none there, or not JSON: as Claude, the next
  }
  return false;
}

/** How far before the oldest typed a first read after a restart starts. ponytail: a line written over an
 *  hour after its stamp, after the trace, would still hide it; read the whole file if that ever shows. */
const RESTART_MARGIN = 3_600_000;

/** Herdr's idle reads in a row, after the transcript's last line, that end a turn (architecture §10.6):
 *  probe 1 saw Herdr say working before the agent's first line in every run, never a second after. */
const IDLE_READS = 2;

/** Where a turn in the terminal starts (architecture §10.6), kept in its conversation's progress: the
 *  transcript file, the byte its lines start at past your message, and the agent's pid and the pane's
 *  session then, either changed cutting it short; at, how far its transcript is read (§10.6 第 3 条);
 *  told, a dialog in it told to your chat; quiet, its start one the agent runs with no model (noReply),
 *  which idle ends, kept for a restart that reads past that line. */
type Turn = { file: string; from: number; pid: number; session: string; at?: number; told?: true; quiet?: true };
const turnOf = (conv: Conv): Turn | undefined => (conv.progress ? JSON.parse(conv.progress).tui : undefined);

/** The chat your typed input came from; the board's, for none. */
const chatOf = (tx: Tx, i: AgentInput): string => (i.trace && tx.get("inbound", i.trace)?.chat) || BOARD;

/** Where the transcript's last line stamped before `from` starts, read back from its end; 0 for none. */
async function lineBefore(file: string, from: number): Promise<number> {
  for (let at = Infinity; ; ) {
    const page = await readPage(file, at, 100, "backward");
    for (const e of page.entries.toReversed()) if (Date.parse(/"timestamp":"([^"]+)"/.exec(e.raw)?.[1] ?? "") < from) return e.offset;
    if (page.start === 0 || !page.entries.length) return 0;
    at = page.start;
  }
}

/** The transcript's whole lines, raw, from byte `from` on, where each ends, and where the last of them ends. */
async function appended(file: string, from: number): Promise<{ lines: string[]; ends: number[]; end: number }> {
  const buf = Buffer.from(await Bun.file(file).slice(from).arrayBuffer());
  const end = buf.lastIndexOf(10) + 1;
  const lines: string[] = [];
  const ends: number[] = [];
  for (let at = 0; at < end; ) {
    const nl = buf.indexOf(10, at);
    if (nl > at) lines.push(buf.subarray(at, nl).toString("utf8")), ends.push(from + nl + 1);
    at = nl + 1;
  }
  return { lines, ends, end: from + end };
}

function fail(message: string): never {
  throw new Error(message);
}
