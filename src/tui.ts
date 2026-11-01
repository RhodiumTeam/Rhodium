// Switching a slot to the terminal and back, Herdr's side (architecture §10). Once the router has seen
// the headless agent exit, this takes the conversation lock, makes sure nothing else has the
// conversation, and opens it in a tab of the workspace's Herdr workspace; what came of it goes back to
// the main loop as a tui input. Then it watches the agent there, and Herdr itself: once the agent is
// gone it closes its pane and says so with a tui_back input; Herdr going away and coming back are herdr
// inputs. It also tells rhodium which TUI agent an rh with no token runs under. rh import looks here
// too: for a conversation on disk or the agent in a Herdr pane, with the same check that no one else
// uses it; an imported pane is watched as one switched to.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENTS, AGENT_KINDS, terminalUnset } from "./agents";
import { claudeFlags } from "./claude";
import { locate, type Config } from "./config";
import type { AgentKind, Importable, ImportFound, Input, TuiPane, Used } from "./contracts";
import { lock, log, type Loop } from "./daemon";
import { call, request, sessionSocket, subscribe } from "./herdr";
import { holderPaths } from "./holder";
import type { Effect } from "./router";
import { agentBaseEnv, slotToken } from "./runner";
import { namesOf, type Slot, type Store } from "./store";
import { findConversations, hasTranscript, listConversations, piSettings, sessionsDir, settingsIn as ranOn, startedIn, type Conversation } from "./transcript";

/** A process's state, parent and start time (/proc/<pid>/stat); null once it is gone. */
function procStat(pid: number): { state: string; ppid: number; start: number } | null {
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
/** How long a switch waits for the new pane's agent to report its session (architecture §10.3). */
const SCREEN_WAIT = 3000;

/** The process and the ones up its parent chain, each "<pid>:<start time>" (RhCaller.ancestors). */
export function ancestors(pid: number): string[] {
  const out: string[] = [];
  for (let p = pid, s = procStat(p); s && p > 1 && out.length < 64; p = s.ppid, s = procStat(p)) out.push(`${p}:${s.start}`);
  return out;
}

/** Every other process whose command line names the session: it has the conversation open. Not an
 *  rh import of it, nor the shell running that, which name it only to ask for it.
 *  ponytail: blind to pi, whose process title wipes its command line; rhodium's own pis hold the
 *  conversation lock, and Herdr's panes report pi's session. One you start by hand elsewhere goes unseen. */
// ponytail: matched by the words "rh import" in the command line; by the rh call's parent chain if that misfires.
function holders(session: string): number[] {
  return readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid)
    .filter((d) => {
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replaceAll("\0", " ");
        return cmd.includes(session) && !/\brh import\b/.test(cmd);
      } catch {
        return false; // gone meanwhile
      }
    })
    .map(Number);
}

/** Whether rh import takes a Herdr pane that reports an agent by this name: one of ours with paneImport. */
const importsPane = (name: string | undefined): boolean => Object.hasOwn(AGENTS, name ?? "") && AGENTS[name as AgentKind].paneImport;

/** The names of the login shells (/etc/shells): what a pane of yours, or one Herdr restored, runs. */
const shells = () => new Set(readFileSync("/etc/shells", "utf8").split("\n").filter((l) => l.startsWith("/")).map((l) => basename(l.trim())));

/** The session a Herdr pane reports. pi's Herdr extension reports its session's file when it has
 *  one, named "<start time>_<id>.jsonl" (architecture §6.3); Claude's hook, the id. */
function paneSession(pane: any): string | undefined {
  const v: string | undefined = pane?.agent_session?.value;
  return v?.endsWith(".jsonl") ? basename(v, ".jsonl").split("_").at(-1) : v;
}

export function createTui(o: { cfg: Config; store: Store; loop: Loop }) {
  const { cfg, store, loop } = o;
  const program = (p: string) => locate(p, cfg.agentPath) ?? fail(`${p} 不在 PATH 上（${cfg.agentPath}）`);

  /**
   * How each agent's terminal runs on the session (architecture §10.3). args: what follows the
   * program on its launch line, on the session, or with none a new one of its own. presets: it starts
   * a new session under an id given it, which Rhodium then knows at once. ownSettings: on a session
   * with lines written down, it restores its settings from its file, not the slot's (pi, §6.3). hidden: its process title wipes its command line, which then
   * names no session (holders). named: its pane is up once Herdr names the agent in it, not once
   * it reports its session, which it does only at its first turn (Codex, §6.4).
   */
  const TERMINAL: Record<AgentKind, { args: (slot: Slot, session: string | null, models: Record<string, string>) => Promise<string[]>; presets: boolean; ownSettings: boolean; hidden: boolean; named: boolean }> = {
    claude: {
      // By the slot's /model, /effort, /ultracode and approval mode, as its headless agent goes, but
      // for a model the last handshake no longer offered: the conversation's own then. Approval on is
      // Claude's own default mode, with no flag. It resumes only a conversation it wrote down, else
      // starts it under that id (§6.2).
      args: async (slot, session, models) => [
        ...claudeFlags(slot.model !== null && Object.hasOwn(models, slot.model) ? slot.model : null, slot.effort, slot.ultracode === null ? null : slot.ultracode === 1),
        ...(slot.approval ?? cfg.defaults.approval ? [] : ["--permission-mode", "bypassPermissions"]),
        (await hasTranscript("claude", session!)) ? "--resume" : "--session-id",
        session!,
      ],
      presets: true,
      ownSettings: false,
      hidden: false,
      named: false,
    },
    // A session with nothing written down yet starts by the slot's /model and /effort, as pi has no
    // file to restore them from (stories 58, 544).
    pi: {
      args: async (slot, session) => [
        ...((await hasTranscript("pi", session!)) ? [] : [...(slot.model !== null ? ["--model", slot.model] : []), ...(slot.effort !== null ? ["--thinking", slot.effort] : [])]),
        "--session-id",
        session!,
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
    // With no thread, a new one.
    codex: {
      args: async (slot, session) => [
        ...(session !== null ? ["resume", session] : []),
        "--no-daemon",
        ...(slot.model !== null ? ["-m", slot.model] : []),
        ...(slot.effort !== null ? ["-c", `model_reasoning_effort=${slot.effort}`] : []),
        ...(slot.approval ?? cfg.defaults.approval ? ["-a", "on-request", "-s", "danger-full-access"] : ["--dangerously-bypass-approvals-and-sandbox"]),
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        `projects={${JSON.stringify(slot.dir)}={trust_level="trusted"}}`,
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
  const locks = new Map<string, number>();
  for (const s of store.tx((tx) => tx.find("slot", { mode: "tui" }))) {
    if (!s.herdrPane || !s.conversation) continue;
    const fd = lock(holderPaths(cfg, s.conversation).lock);
    if (fd === null) log("cannot take a TUI slot's conversation lock again", { slot: s.id });
    else locks.set(s.conversation, fd);
  }

  /** The pid of the agent the pane runs: the pane's own process, once it runs neither a shell nor env
   *  (the launch command's, or a script's #!/usr/bin/env node). Not by name or command line: pi sets
   *  its process title, which leaves /proc only "pi". */
  async function agentPid(socket: string, pane: string): Promise<number> {
    const sh = shells();
    const pid = await poll(async () => {
      const pid: number = (await request(socket, "pane.process_info", { pane_id: pane })).process_info.shell_pid;
      let exe = "env";
      try {
        exe = basename(readlinkSync(`/proc/${pid}/exe`));
      } catch {} // gone, or not yet
      return exe !== "env" && !sh.has(exe) ? pid : undefined;
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
    let fd: number | null = null;
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
      const args = await terminal.args(slot, session, models);
      // The holder lets go of the lock as it exits, a moment after it reported the agent's exit.
      const path = holderPaths(cfg, conv.id).lock;
      for (const end = Date.now() + cfg.durations.stopGrace; (fd = lock(path)) === null && Date.now() < end; ) await Bun.sleep(50);
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
      const leftPane: string | undefined = left && snapshot.panes.find((p: any) => p.tab_id === left.tab_id)?.pane_id;
      // One with only a shell in it, say Herdr restored it without its agent, is as none: a new tab
      // opens. One in the Herdr workspace Rhodium made goes first, so the next switch need not wait for
      // it again; one Rhodium only found by its name may be yours, and stays.
      const leftPid = leftPane ? await agentPid(socket, leftPane).catch(() => undefined) : undefined;
      if (leftPane && leftPid === undefined && left.workspace_id === ws.herdrWorkspace) {
        await request(socket, "tab.close", { tab_id: left.tab_id });
        ({ snapshot } = await request(socket, "session.snapshot"));
      }
      // Only "no such process" counts, never a stored pid.
      const found = session === null ? [] : holders(session);
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
        const { ref, token } = slotToken(store, slot.id);
        const { TELEGRAM_STATE_DIR } = agentBaseEnv(cfg);
        const env = { RHODIUM_SOCKET: join(cfg.socketDir, "rh.sock"), RHODIUM_SLOT: ref, RHODIUM_TOKEN: token, TELEGRAM_STATE_DIR };
        // Each agent's own terminal on the session, in the slot's directory; any but Claude without the
        // keys that would put it on your Claude subscription, as headless (agents.ts, architecture §6.3).
        const unset = terminalUnset(conv.agent, process.env).flatMap((k) => ["-u", k]);
        // The tab runs the agent itself: no shell, so nothing typed shows on its screen, and the pane
        // ends with the agent (#372, architecture §10.3).
        const command = ["/usr/bin/env", ...unset, `PATH=${cfg.agentPath}`, agent, ...args];
        const { layout } = await request(socket, "layout.apply", { workspace_id: workspace, tab_label: slot.name, root: { type: "pane", cwd: slot.dir, env, command } });
        tab = layout.tab_id as string;
        const pane: string = layout.root.pane_id;
        if (root) await request(socket, "tab.close", { tab_id: root });
        root = undefined;
        at = { workspace, tab, pane, pid: await agentPid(socket, pane) };
        // Its screen is up about when it reports its session: only then is the switch told, and the
        // pane handed to the slot's web page. Claude in a directory it has not trusted reports none
        // till you answer its question, which its screen shows: so no more than SCREEN_WAIT (§10.3).
        // Codex reports its thread only at its first turn: Herdr naming it is as near as it gets.
        const herdrAt = socket;
        if (terminal.named) await poll(async () => ((await request(herdrAt, "pane.get", { pane_id: pane })).pane?.agent === conv.agent) || undefined, SCREEN_WAIT).catch(() => undefined);
        else await reportedBy(socket, pane, SCREEN_WAIT);
      }
      opened = { ...at, session, start: procStat(at.pid)?.start ?? fail("pane 里的 agent 起来就退出了") };
      locks.set(conv.id, fd!);
      // /rh_tui from IM: your Herdr shows the pane when you get to it. Not done, the switch stands all the same.
      if (slot.tuiFocus) {
        const focus = [["workspace.focus", { workspace_id: at.workspace }], ["tab.focus", { tab_id: at.tab }], ["pane.focus", { pane_id: at.pane }]] as const;
        for (const [method, params] of focus) await request(socket, method, params).catch((err) => log("cannot focus the pane", { slot: slotId, method, error: String(err) }));
      }
    } catch (err) {
      log("cannot switch to the terminal", { slot: slotId, error: String(err) });
      if (fd !== null) closeSync(fd);
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
    if (v.endsWith(".jsonl") && dirname(v) !== sessionsDir(s.dir, store.tx((tx) => tx.get("conversation", s.conversation!))!.agent)) {
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

  /** Takes in the session the slot's pane reports now. */
  async function readSession(s: Slot): Promise<void> {
    const a = await call(socket!, "pane.get", { pane_id: s.herdrPane }).catch(() => undefined);
    take(s, a?.result?.pane);
  }

  /** Each slot's agent: there, the session its pane reports now; gone while Herdr is there, the slot
   *  goes back to headless. Only "no such process" counts (architecture §10.1). */
  async function look(): Promise<void> {
    absorb();
    for (const s of watched()) {
      if (backing.has(s.id)) continue;
      if (running(s.tuiPid!, s.tuiStart)) await readSession(s);
      else if (await call(socket!, "ping").catch(() => undefined)) await back(s.id);
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
      const pid = session === null ? undefined : holders(session).find((p) => inPane.includes(p));
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
        const settings = await settingsIn(s, session).catch((err) => (log("cannot read what the terminal ran on", { slot: slotId, error: String(err) }), {}));
        result = { session, ...settings, ...(elsewhere.has(slotId) && { elsewhere: true as const }), ...(restarted && { restarted: true as const }) };
        const fd = locks.get(s.conversation);
        if (fd !== undefined) closeSync(fd);
        locks.delete(s.conversation);
        reported.delete(slotId);
        elsewhere.delete(slotId);
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
    const since = Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000 + s.tuiStart * 10;
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
    const others = holders(session).filter((p) => p !== except?.pid);
    if (others.length) fail("另一个进程正在用这段对话");
    const at = await herdrSocket();
    const snap = at && (await request(at, "session.snapshot").catch(() => undefined));
    const pane = snap?.snapshot.panes.find((p: any) => paneSession(p) === session && p.pane_id !== except?.pane);
    if (pane) fail("Herdr 里另一个 pane 正在用这段对话");
  }

  // ---- rh import (product §4.3): only what it is told to take, never another agent. ----

  /** The one conversation on disk whose id starts with prefix, and the directory it was started in. */
  async function fromDisk(prefix: string): Promise<ImportFound> {
    const hits = await findConversations(prefix);
    if (!hits.length) fail(`磁盘上没有对话 ${prefix}`);
    if (hits.length > 1) fail(`以 ${prefix} 开头的对话有 ${hits.length} 段，写长一点：${hits.slice(0, 5).map((h) => h.id).join("、")}${hits.length > 5 ? " 等" : ""}`);
    const { agent, id: session, file } = hits[0]!;
    const dir = (await startedIn(file)) ?? fail(`对话 ${session} 的记录里没有它的目录`);
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
    // ponytail: Claude only, as for rh tui; pi's pane reports come with #43.
    const kind: AgentKind = reported.agent;
    if (!importsPane(kind)) fail(`pane ${pane} 里的 agent 是 ${kind}，暂时只能导入 ${AGENT_KINDS.filter(importsPane).join("、")} 的 pane`);
    const { process_info } = await request(at, "pane.process_info", { pane_id: pane });
    const agent = (process_info.foreground_processes as { pid: number; name: string; cwd: string }[]).find((f) => f.name === kind);
    const start = (agent && procStat(agent.pid)?.start) ?? fail(`pane ${pane} 里的 ${kind} 已经退出了`);
    await nobodyHas(reported.value, { pid: agent!.pid, pane });
    return { agent: kind, session: reported.value, dir: agent!.cwd, pane: { workspace: p.workspace_id, tab: p.tab_id, pane, pid: agent!.pid, start } };
  }

  /** What there is to import: the claude agents the panes of Rhodium's Herdr session report (none
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
          const [session, cwd] = [p.agent_session.value, p.foreground_cwd ?? p.cwd];
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
    const fd = lock(holderPaths(cfg, s.conversation).lock);
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
    /** Why someone else uses the session, or null: checked before a headless start resumes it. */
    inUse: (session: string) => nobodyHas(session).then(() => null, (err: Error) => err.message),
  };
}

type Resumed = Extract<Input, { kind: "herdr"; up: true }>["resumed"];

function fail(message: string): never {
  throw new Error(message);
}
