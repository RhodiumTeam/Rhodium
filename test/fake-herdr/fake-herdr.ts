// Fake Herdr: the subset of Herdr's socket API and CLI that the Herdr bridge uses, in the
// shapes probe 18 recorded (docs/architecture.md §10.3). Not Herdr's private binary protocol.
//
// `installFakeHerdr` writes a `herdr` executable; `startFakeHerdr` runs its server for one session.
// The server's env must set HOME to a temp dir (the socket lives under it) and a PATH that finds a
// fake `claude` and `pi` (Herdr's auto-resume types `claude --resume` or `pi --session`). A pane of
// workspace.create, tab.create or a restart runs `sh`, which runs what is typed into it; one of
// layout.apply runs its command, as the bridge starts a slot's agent (#372). Tests trigger:
// - the pane's process exiting: kill the pid from pane.process_info, or let the agent's script exit;
// - a new session id (/clear, /resume, pi's /new): call pane.report_agent_session, as Claude's hook
//   and pi's Herdr extension do;
// - a Herdr restart: stop() and start again; `resumeAgents` and `resumeDelay` set the auto-resume;
// - Herdr gone just as the bridge has subscribed: `stopOnSubscribe`.
// `herdr terminal session control` (architecture §10.4) attaches to a pane as its one operator, in the
// shapes scripts/probes/herdr/probe-terminal.ts recorded; its screen is the fake's own, not the shell's.
// Herdr lets it in 250 ms on, or as soon as any request comes, as Herdr does while idle (#380).
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { call } from "../../src/herdr.ts";
import { realHome } from "../fake-agent/fake-agent.ts";

// The bridge's own client: tests talk to the fake as the bridge talks to Herdr.
export { call, subscribe } from "../../src/herdr.ts";

export type FakeHerdrConfig = {
  /** Herdr's `resume_agents_on_restore`; on by default in 0.9.1. */
  resumeAgents?: boolean;
  /** Milliseconds from server start to typing `claude --resume`; about 2.5 s measured. */
  resumeDelay?: number;
  /** The protocol ping answers with; 22 as 0.9.1's. */
  protocol?: number;
  /** Stops as SIGTERM does on a subscription, and acknowledges it last: by then the panes' processes
   *  and the socket are gone. A Herdr going away just as the bridge starts to watch it. */
  stopOnSubscribe?: boolean;
};

/** Where Herdr puts a session's socket: `default` directly under ~/.config/herdr. */
export function sessionDir(home: string, session: string) {
  const root = join(home, ".config/herdr");
  return session === "default" ? root : join(root, "sessions", session);
}
export const socketPath = (home: string, session: string) => join(sessionDir(home, session), "herdr.sock");

/** Writes an executable `<dir>/herdr` that runs the fake Herdr with `config`. */
export function installFakeHerdr(dir: string, config: FakeHerdrConfig = {}) {
  const path = join(dir, "herdr");
  writeFileSync(
    path,
    `#!${process.execPath} --no-env-file\n` +
      `import { main } from ${JSON.stringify(import.meta.path)};\n` +
      `await main(process.argv.slice(2), ${JSON.stringify(config)});\n`,
    { mode: 0o755 },
  );
  return path;
}


/** Starts `herdr --session <session> server` with `env` and waits until its socket answers. */
export async function startFakeHerdr(bin: string, session: string, env: Record<string, string>) {
  const proc = Bun.spawn([bin, "--session", session, "server"], { env, stdout: "inherit", stderr: "inherit" });
  const socket = socketPath(env.HOME!, session);
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`fake herdr exited with ${proc.exitCode}`);
    if (await call(socket, "ping").catch(() => undefined)) break;
    await Bun.sleep(10);
  }
  return {
    proc,
    socket,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

export async function main(argv: string[], config: FakeHerdrConfig) {
  const at = argv.indexOf("--session");
  const session = at >= 0 ? argv[at + 1]! : "default";
  const rest = at >= 0 ? argv.toSpliced(at, 2) : argv;
  // A test that forgot to point HOME at a temp dir must not touch the user's own Herdr: not even list
  // its sessions, since the bridge takes the socket path from that list.
  const real = realHome();
  const home = process.env.HOME ?? real!;
  const root = sessionDir(home, "default");
  if (real && resolve(root).startsWith(join(real, ".config/herdr"))) {
    console.error(`fake herdr: refusing to run under ${root}; set HOME`);
    process.exit(2);
  }
  if (rest[0] === "server") return serve(home, session, config);
  if (rest.slice(0, 3).join(" ") === "terminal session control") return control(socketPath(home, session), rest.slice(3));
  if (rest.join(" ") === "session list --json") {
    let names: string[] = [];
    try {
      names = readdirSync(join(home, ".config/herdr/sessions"));
    } catch {}
    if (existsSync(socketPath(home, "default"))) names.unshift("default");
    const sessions = await Promise.all(
      names.map(async (name) => ({
        default: name === "default",
        name,
        running: !!(await call(socketPath(home, name), "ping").catch(() => undefined)),
        session_dir: sessionDir(home, name),
        socket_path: socketPath(home, name),
      })),
    );
    console.log(JSON.stringify({ sessions }));
    return;
  }
  // The one socket command probe 18 also ran from the CLI; the bridge itself uses the socket.
  if (rest[0] === "tab" && rest[1] === "create") {
    const cwd = flag(rest, "--cwd");
    const params = { workspace_id: flag(rest, "--workspace"), label: flag(rest, "--label"), ...(cwd && { cwd }) };
    const answer = await call(socketPath(home, session), "tab.create", params);
    console.log(JSON.stringify({ ...answer, id: "cli:tab:create" }));
    return;
  }
  console.error(`fake herdr: unsupported command: ${rest.join(" ")}`);
  process.exit(2);
}

/** `terminal session control <pane> [--takeover] [--cols N] [--rows N]`: hands the server the pane's
 *  stream, then passes stdin's lines to it and its lines to stdout, until it says the terminal closed.
 *  stdin ending lets go, as Herdr's does. */
function control(socket: string, args: string[]) {
  const valued = ["--cols", "--rows"];
  const pane = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]!));
  const size = (name: string) => (flag(args, name) === undefined ? undefined : Number(flag(args, name)));
  const s = connect(socket);
  let buf = "";
  let attached = false;
  s.on("connect", () => {
    attached = true;
    s.write(JSON.stringify({ id: "cli:terminal", method: "terminal.control", params: { pane_id: pane, takeover: args.includes("--takeover"), cols: size("--cols"), rows: size("--rows") } }) + "\n");
    void (async () => {
      let line = "";
      for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
        line += chunk;
        for (let i; (i = line.indexOf("\n")) >= 0; line = line.slice(i + 1)) s.write(line.slice(0, i + 1));
      }
      if (!s.destroyed) s.write('{"type":"fake.eof"}\n');
    })();
  });
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i + 1);
      if (JSON.parse(line).type !== "terminal.closed") process.stdout.write(line);
      else process.stdout.write(line, () => process.exit(0));
    }
  });
  s.on("error", (e: NodeJS.ErrnoException) => {
    if (attached) return;
    // As Herdr 0.9.1 says it.
    const why = e.code === "ENOENT" ? "No such file or directory (os error 2)" : e.message;
    console.error(`herdr: failed to connect to server: ${why}\nIs herdr server running? Start it with \`herdr server\`.\nSocket path: ${socket}`);
    process.exit(1);
  });
  s.on("close", () => {
    if (!attached) return;
    console.error("herdr: lost the connection to the server");
    process.exit(1);
  });
}

const PONG = {
  type: "pong",
  version: "0.9.1",
  protocol: 22,
  capabilities: { live_handoff: true, detached_server_daemon: true, endpoint_protocol_generation: 1, surface_interest: true, health_check: true },
};

type AgentSession = { source: string; agent: string; kind: "id" | "path"; value: string };
type Workspace = { id: string; label: string; cwd: string; tabs: number; panes: number };
/** A pane: its tab's first, or split off another of its tab (pane.split), as you may do yourself. */
type Pane = {
  id: string;
  tab: string;
  ws: string;
  label: string;
  cwd: string;
  terminal: string;
  revision: number;
  agent?: string;
  session?: AgentSession;
  proc?: Bun.Subprocess<"pipe", "ignore", "inherit">;
  /** The agent process the session was last read from. */
  agentPid?: number;
  /** Ctrl-C presses so far: Claude's TUI quits on the second. */
  ctrlC: number;
  /** Its terminal session control, attached. */
  operator?: Operator;
};
/** An attached terminal session control: what it is sent, and closing it with Herdr's reason. */
type Operator = { send(msg: object): void; close(reason: string): void };
class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The pane's foreground processes: what its shell runs, or the shell itself; or what it exec'd, with
 *  that one's children, say an agent's rh call, as they share its process group. */
// ponytail: a child's children are left out; walk the process group if a test needs them.
function foreground(shell: number) {
  let pids = [shell];
  try {
    const kids = readFileSync(`/proc/${shell}/task/${shell}/children`, "utf8").split(" ").filter(Boolean).map(Number);
    if (kids.length) pids = readFileSync(`/proc/${shell}/comm`, "utf8").trim() === "sh" ? kids : [shell, ...kids];
  } catch {}
  return pids.flatMap((pid) => {
    try {
      // Mid-exec, a process has its new name a moment before its new command line, which reads empty
      // meanwhile: the name goes first, and such a process is left for the next look.
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
      if (!argv.length) return [];
      return [{ pid, name, argv, cmdline: argv.join(" "), cwd: readlinkSync(`/proc/${pid}/cwd`) }];
    } catch {
      return [];
    }
  });
}

/** Signals each process that is still there. */
function signal(pids: number[], sig: NodeJS.Signals) {
  for (const pid of new Set(pids))
    try {
      process.kill(pid, sig);
    } catch {}
}

function flag(args: string[], name: string): string | undefined {
  for (const [i, a] of args.entries()) {
    if (a === name) return args[i + 1];
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
}

function serve(home: string, session: string, config: FakeHerdrConfig) {
  const dir = sessionDir(home, session);
  mkdirSync(dir, { recursive: true });
  const sock = join(dir, "herdr.sock");
  rmSync(sock, { force: true });

  let nextWs = 1;
  let stopping = false;
  const workspaces = new Map<string, Workspace>();
  const panes = new Map<string, Pane>();

  const subscribers = new Map<object, { types: Set<string>; write: (line: string) => void }>();
  /** Sends `event` to each subscription that asked for it (`pane_exited` as `pane.exited`). */
  const emit = (event: string, data: object) => {
    const line = JSON.stringify({ event, data: { type: event, ...data } }) + "\n";
    for (const s of subscribers.values()) if (s.types.has(event.replace("_", "."))) s.write(line);
  };

  const find = (id: string) => {
    const p = panes.get(id);
    if (!p) throw new HerdrError("pane_not_found", `pane ${id} not found`);
    return p;
  };
  const panesOf = (tab: string) => [...panes.values()].filter((p) => p.tab === tab);
  /** The workspace's tabs, each as its first pane. */
  const tabsOf = (w: Workspace) => [...panes.values()].filter((p) => p.ws === w.id && panesOf(p.tab)[0] === p);
  const allTabs = () => [...workspaces.values()].flatMap(tabsOf);
  // What workspace.focus, tab.focus and pane.focus last focused. Short of that, the newest workspace
  // has focus, and in it the first tab, and in that its first pane.
  // ponytail: one focused tab for the session, where Herdr keeps an active tab per workspace.
  const focus = { ws: "", tab: "", pane: "" };
  const focusedWs = () => workspaces.get(focus.ws) ?? [...workspaces.values()].at(-1);
  /** The workspace's focused tab, as its first pane. */
  const activeTab = (w: Workspace) => tabsOf(w).find((t) => t.tab === focus.tab) ?? tabsOf(w)[0];
  const activePane = (tab: string) => panesOf(tab).find((p) => p.id === focus.pane) ?? panesOf(tab)[0]!;
  const tabFocused = (p: Pane) => focusedWs()?.id === p.ws && activeTab(workspaces.get(p.ws)!)?.tab === p.tab;
  const focused = (p: Pane) => tabFocused(p) && activePane(p.tab) === p;
  /** Every request but subscriptions, oldest first: fake.calls answers with them. */
  const calls: { method: string; params: object }[] = [];
  const status = (ps: Pane[]) => (ps.some((p) => p.agent) ? "idle" : "unknown");

  const paneJson = (p: Pane) => ({
    pane_id: p.id,
    terminal_id: p.terminal,
    workspace_id: p.ws,
    tab_id: p.tab,
    focused: focused(p),
    cwd: p.cwd,
    foreground_cwd: p.cwd,
    ...(p.agent && { agent: p.agent }),
    agent_status: status([p]),
    ...(p.session && { agent_session: p.session }),
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 },
    revision: p.revision,
  });
  const tabJson = (p: Pane) => {
    const tabs = tabsOf(workspaces.get(p.ws)!);
    return {
      tab_id: p.tab,
      workspace_id: p.ws,
      number: tabs.indexOf(p) + 1,
      label: p.label,
      focused: tabFocused(p),
      pane_count: panesOf(p.tab).length,
      agent_status: status(panesOf(p.tab)),
    };
  };
  const wsJson = (w: Workspace) => {
    const tabs = tabsOf(w);
    return {
      workspace_id: w.id,
      number: [...workspaces.keys()].indexOf(w.id) + 1,
      label: w.label,
      focused: focusedWs() === w,
      pane_count: tabs.flatMap((t) => panesOf(t.tab)).length,
      tab_count: tabs.length,
      active_tab_id: activeTab(w)?.tab,
      agent_status: status(tabs),
    };
  };

  /** Starts the pane's process: a shell, which runs what is typed into it, or a command of layout.apply's. */
  function start(p: Pane, env: Record<string, string> = {}, command = ["sh"]) {
    p.terminal = `term_${randomBytes(7).toString("hex")}`;
    const proc = (p.proc = Bun.spawn(command, {
      cwd: p.cwd,
      env: { ...process.env, ...env, HERDR_ENV: "1", HERDR_SOCKET_PATH: sock, HERDR_PANE_ID: p.id },
      stdin: "pipe",
      stdout: "ignore", // the screen
      stderr: "inherit",
    }));
    proc.exited.then(() => {
      if (stopping || panes.get(p.id)?.proc !== proc) return; // its tab was closed
      remove(p, false);
      emit("pane_exited", { pane_id: p.id, workspace_id: p.ws });
      if (p.agent)
        emit("pane_agent_detected", { agent: p.agent, final_status: "idle", pane_id: p.id, released: true, workspace_id: p.ws });
    });
  }

  /** Drops a pane, and its workspace once empty: neither sends an event of its own. Its terminal
   *  session control is told its terminal exited, or, closed, that it is not found. */
  function remove(p: Pane, closed = true) {
    p.operator?.close(closed ? `terminal attach ended: terminal ${p.terminal} not found` : `terminal ${p.terminal} exited`);
    panes.delete(p.id);
    if (!tabsOf(workspaces.get(p.ws)!).length) workspaces.delete(p.ws);
  }
  /** What closing the terminal does: SIGHUP to the shell and what runs in it. */
  const hangUp = (p: Pane) => signal([p.proc!.pid, ...foreground(p.proc!.pid).map((f) => f.pid)], "SIGHUP");

  function addTab(w: Workspace, label: string | undefined, cwd: string | undefined, env?: Record<string, string>, command?: string[]) {
    const n = ++w.tabs;
    const p: Pane = {
      id: `${w.id}:p${++w.panes}`,
      tab: `${w.id}:t${n}`,
      ws: w.id,
      label: label ?? String(n),
      cwd: cwd ?? w.cwd,
      terminal: "",
      revision: 0,
      ctrlC: 0,
    };
    panes.set(p.id, p);
    start(p, env, command);
    if (n === 1) emit("workspace_created", { workspace: wsJson(w) }); // announced with its root tab
    emit("tab_created", { tab: tabJson(p) });
    emit("pane_created", { pane: paneJson(p) });
    return p;
  }

  function type(p: Pane, text: string) {
    p.proc!.stdin.write(text);
    p.proc!.stdin.flush();
  }
  function keys(p: Pane, keys: string[]) {
    for (const k of keys) {
      if (k === "enter") type(p, "\n");
      else if (k === "ctrl+c") {
        // ponytail: any two presses quit Claude, however far apart; Claude's own window is unmeasured.
        if (++p.ctrlC < 2 && p.agent) continue;
        // Claude reports its session as it quits: Herdr sends it ~0.06 s after the second press,
        // ~0.6 s before pane_exited (probe 18), so it comes before the agent is gone. pi doesn't.
        if (p.ctrlC === 2 && p.session && p.agent === "claude") {
          p.revision++;
          emit("pane_updated", { pane: paneJson(p) });
        }
        signal(foreground(p.proc!.pid).map((f) => f.pid), "SIGINT");
      } else throw new HerdrError("invalid_params", `unsupported key ${k}`);
    }
  }

  // Herdr learns the session id from Claude's SessionStart hook. The fake reads it off the
  // agent's command line instead (`--resume`, `--session-id`), or makes one up like Claude.
  // The fake pi reports itself, as your pi's Herdr extension does (test/fake-agent). Codex Herdr
  // names at once, with no session: your Codex hook reports its thread at its first turn, as the
  // fake codex does (architecture §6.4).
  setInterval(() => {
    for (const p of panes.values()) {
      const codex = p.proc && foreground(p.proc.pid).find((f) => f.name === "codex");
      if (codex && codex.pid !== p.agentPid && codex.argv.some((a) => basename(a) === "codex")) {
        p.agentPid = codex.pid;
        p.agent = "codex";
        p.revision++;
        emit("pane_agent_detected", { agent: "codex", pane_id: p.id, workspace_id: p.ws });
        emit("pane_updated", { pane: paneJson(p) });
      }
      const claude = p.proc && foreground(p.proc.pid).find((f) => f.name === "claude");
      // Read mid-exec, its name can say claude while its command line is still the shell's, or
      // empty: it is read again on the next tick.
      if (!claude || claude.pid === p.agentPid || !claude.argv.some((a) => basename(a) === "claude")) continue;
      p.agentPid = claude.pid;
      p.agent = "claude";
      const value = flag(claude.argv, "--resume") ?? flag(claude.argv, "--session-id") ?? randomUUID();
      p.session = { source: "herdr:claude", agent: "claude", kind: "id", value };
      p.revision++;
      emit("pane_agent_detected", { agent: "claude", pane_id: p.id, workspace_id: p.ws });
      emit("pane_updated", { pane: paneJson(p) });
    }
  }, 20);

  const AREA = { x: 0, y: 0, width: 120, height: 40 };

  const methods: Record<string, (params: any) => object> = {
    ping: () => ({ ...PONG, protocol: config.protocol ?? PONG.protocol }),
    "workspace.create": ({ cwd, label, env }) => {
      const w: Workspace = { id: `w${nextWs++}`, label, cwd, tabs: 0, panes: 0 };
      workspaces.set(w.id, w);
      const p = addTab(w, undefined, cwd, env);
      return { type: "workspace_created", workspace: wsJson(w), tab: tabJson(p), root_pane: paneJson(p) };
    },
    "tab.create": ({ workspace_id, cwd, label, env }) => {
      const w = workspaces.get(workspace_id);
      if (!w) throw new HerdrError("workspace_not_found", `workspace ${workspace_id} not found`);
      const p = addTab(w, label, cwd, env);
      return { type: "tab_created", tab: tabJson(p), root_pane: paneJson(p) };
    },
    // A tab whose one pane runs the command, with no shell, in the shape
    // scripts/probes/herdr/probe-layout-apply.ts recorded. ponytail: one pane node, the bridge's; no splits.
    "layout.apply": ({ workspace_id, tab_label, root }) => {
      const w = workspaces.get(workspace_id);
      if (!w) throw new HerdrError("workspace_not_found", `workspace ${workspace_id} not found`);
      if (root?.type !== "pane" || !root.command?.length) throw new HerdrError("invalid_params", "the fake lays out one pane with a command");
      const p = addTab(w, tab_label, root.cwd, root.env, root.command);
      return { type: "layout_apply", layout: { workspace_id: w.id, tab_id: p.tab, zoomed: false, focused_pane_id: p.id, root: { type: "pane", pane_id: p.id, cwd: p.cwd, command: root.command } } };
    },
    "pane.send_input": ({ pane_id, text, keys: k = [] }) => {
      const p = find(pane_id);
      type(p, text);
      keys(p, k);
      return { type: "ok" };
    },
    "pane.send_keys": ({ pane_id, keys: k }) => {
      keys(find(pane_id), k);
      return { type: "ok" };
    },
    "pane.send_text": ({ pane_id, text }) => {
      type(find(pane_id), text);
      return { type: "ok" };
    },
    // Measured to change nothing that matters: the restore record and auto-resume stay (architecture §10.2).
    "pane.release_agent": ({ pane_id }) => (find(pane_id), { type: "ok" }),
    "pane.clear_agent_authority": ({ pane_id }) => (find(pane_id), { type: "ok" }),
    "tab.close": ({ tab_id }) => {
      const all = panesOf(tab_id);
      if (!all.length) throw new HerdrError("tab_not_found", `tab ${tab_id} not found`);
      for (const p of all) {
        remove(p);
        hangUp(p);
      }
      emit("tab_closed", { tab_id, workspace_id: all[0]!.ws });
      return { type: "ok" };
    },
    "tab.rename": ({ tab_id, label }) => {
      const all = panesOf(tab_id);
      if (!all.length) throw new HerdrError("tab_not_found", `tab ${tab_id} not found`);
      for (const p of all) p.label = label;
      return { type: "tab_info", tab: tabJson(all[0]!) };
    },
    // The new pane shares the target's tab. A tab's last pane closing takes the tab with it.
    "pane.split": ({ target_pane_id, cwd, env }) => {
      const t = find(target_pane_id);
      const w = workspaces.get(t.ws)!;
      const p: Pane = { id: `${w.id}:p${++w.panes}`, tab: t.tab, ws: t.ws, label: t.label, cwd: cwd ?? t.cwd, terminal: "", revision: 0, ctrlC: 0 };
      panes.set(p.id, p);
      start(p, env);
      emit("pane_created", { pane: paneJson(p) });
      return { type: "pane_info", pane: paneJson(p) };
    },
    "pane.close": ({ pane_id }) => {
      const p = find(pane_id);
      remove(p);
      hangUp(p);
      emit("pane_closed", { pane_id, workspace_id: p.ws });
      return { type: "ok" };
    },
    "pane.get": ({ pane_id }) => ({ type: "pane_info", pane: paneJson(find(pane_id)) }),
    // What the Herdr bridge calls once /rh_tui has opened the slot's pane (architecture §10.1).
    "workspace.focus": ({ workspace_id }) => {
      if (!workspaces.has(workspace_id)) throw new HerdrError("workspace_not_found", `workspace ${workspace_id} not found`);
      focus.ws = workspace_id;
      return { type: "ok" };
    },
    "tab.focus": ({ tab_id }) => {
      const [p] = panesOf(tab_id);
      if (!p) throw new HerdrError("tab_not_found", `tab ${tab_id} not found`);
      Object.assign(focus, { ws: p.ws, tab: tab_id });
      return { type: "ok" };
    },
    "pane.focus": ({ pane_id }) => {
      const p = find(pane_id);
      Object.assign(focus, { ws: p.ws, tab: p.tab, pane: p.id });
      return { type: "ok" };
    },
    // The fake's own, for tests: the requests made so far.
    "fake.calls": () => ({ type: "fake_calls", calls }),
    // Claude's SessionStart hook calls this, and pi's Herdr extension, which sends the session's file
    // when it has one; tests call it to act out /clear, /resume and pi's /new. No event, like Herdr.
    // A path report is kept as kind "path", the file's absolute path its value (architecture §10.3).
    "pane.report_agent_session": ({ pane_id, source, agent, agent_session_id, agent_session_path }) => {
      const p = find(pane_id);
      p.agent = agent;
      p.session = agent_session_path
        ? { source, agent, kind: "path", value: agent_session_path }
        : { source, agent, kind: "id", value: agent_session_id };
      return { type: "ok" };
    },
    "session.snapshot": () => {
      const w = focusedWs();
      const first = w && activeTab(w)!;
      const tabs = allTabs();
      return {
        type: "session_snapshot",
        snapshot: {
          version: PONG.version,
          protocol: PONG.protocol,
          ...(first && { focused_workspace_id: w.id, focused_tab_id: first.tab, focused_pane_id: activePane(first.tab).id }),
          workspaces: [...workspaces.values()].map(wsJson),
          tabs: tabs.map(tabJson),
          panes: tabs.flatMap((t) => panesOf(t.tab)).map(paneJson),
          // ponytail: a split tab's panes each get the whole area, with no split nodes; nothing reads them yet.
          layouts: tabs.map((p) => ({
            workspace_id: p.ws,
            tab_id: p.tab,
            zoomed: false,
            area: AREA,
            focused_pane_id: activePane(p.tab).id,
            panes: panesOf(p.tab).map((q) => ({ pane_id: q.id, focused: q === activePane(p.tab), rect: AREA })),
            splits: [],
          })),
          agents: tabs
            .flatMap((t) => panesOf(t.tab))
            .filter((p) => p.agent)
            .map((p) => {
              const { terminal_id, agent, agent_status, agent_session, workspace_id, tab_id, pane_id, focused, cwd, revision } =
                paneJson(p);
              return { terminal_id, agent, agent_status, agent_session, workspace_id, tab_id, pane_id, focused, state_change_seq: 0, cwd, revision };
            }),
        },
      };
    },
    "pane.process_info": ({ pane_id }) => {
      const p = find(pane_id);
      const fg = foreground(p.proc!.pid);
      return {
        type: "pane_process_info",
        process_info: {
          pane_id,
          shell_pid: p.proc!.pid,
          foreground_process_group_id: fg[0]?.pid ?? p.proc!.pid,
          foreground_processes: fg,
        },
      };
    },
  };

  type Conn = { buf: string; term?: (msg: any) => void; detach?: () => void; waiting?: boolean; gone?: boolean };
  /** Terminal session controls Herdr has not let in yet: it looks for new clients every 250 ms while
   *  idle, and at once when a request comes on its socket (#380). */
  const waiting: (() => void)[] = [];
  const letIn = () => waiting.splice(0).forEach((f) => f());
  /** Makes the connection the pane's terminal session control (`terminal.control`, from the CLI): its
   *  one operator, refused while another is attached unless it takes over. Each line it sends after
   *  goes in fake.calls by its type; the screen answers input, a resize and a scroll with a frame. */
  function attach(s: Bun.Socket<Conn>, { pane_id, takeover = false, cols = 80, rows = 24 }: { pane_id: string; takeover?: boolean; cols?: number; rows?: number }) {
    calls.push({ method: "terminal.session.control", params: { pane_id, takeover, cols, rows } });
    const send = (msg: object) => void s.write(JSON.stringify(msg) + "\n");
    let done = false;
    const closed = (reason: string) => void (done || ((done = true), send({ type: "terminal.closed", reason }), s.end()));
    const p = panes.get(pane_id);
    if (!p) return closed(`terminal session control failed: terminal target ${pane_id} not found`);
    if (p.operator && !takeover) return closed(`terminal attach failed: terminal ${p.terminal} already has an attached client; retry with --takeover`);
    p.operator?.close("terminal attach taken over");
    let seq = 0;
    const size = { cols, rows };
    const screen = (ansi: string, full: boolean) =>
      send({ type: "terminal.frame", seq: ++seq, encoding: "ansi", width: size.cols, height: size.rows, full, bytes: Buffer.from(ansi).toString("base64") });
    const whole = () => screen(`\x1b[2J\x1b[1;1Hfake herdr ${p.id} ${size.cols}x${size.rows}`, true);
    const op: Operator = { send, close: (reason) => (p.operator === op && (p.operator = undefined), closed(reason)) };
    p.operator = op;
    s.data.detach = () => p.operator === op && (p.operator = undefined);
    s.data.term = (msg) => {
      if (msg.type === "fake.eof") return op.close("detached");
      const { type, ...params } = msg;
      calls.push({ method: type, params });
      if (p.operator !== op) return;
      if (type === "terminal.input") screen(`\x1b[2;1H${msg.text ?? Buffer.from(msg.bytes ?? "", "base64").toString()}`, false);
      else if (type === "terminal.resize" && msg.cols > 0 && msg.rows > 0) (Object.assign(size, { cols: msg.cols, rows: msg.rows }), whole());
      else if (type === "terminal.scroll") screen(`\x1b[3;1Hscrolled ${msg.direction} ${msg.lines}`, false);
      else if (type === "terminal.release") op.close("detached");
    };
    whole();
  }

  /** Serves the connection's whole lines; one Herdr has not let in yet keeps them till it does. */
  function lines(s: Bun.Socket<Conn>) {
    for (let i; !s.data.waiting && (i = s.data.buf.indexOf("\n")) >= 0; ) {
      const line = s.data.buf.slice(0, i);
      s.data.buf = s.data.buf.slice(i + 1);
      if (s.data.term) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        s.data.term(msg);
        continue;
      }
      let req: any;
      let answer: object;
      try {
        req = JSON.parse(line);
        if (req.method === "terminal.control") {
          const params = req.params ?? {};
          s.data.waiting = true;
          waiting.push(() => {
            s.data.waiting = false;
            if (!s.data.gone) (attach(s, params), lines(s));
          });
          setTimeout(letIn, 250);
          continue;
        }
        letIn();
        if (req.method === "events.subscribe" && config.stopOnSubscribe) {
          const started = JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n";
          void stop(() => s.write(started));
          return;
        }
        if (req.method === "events.subscribe") {
          const types = new Set<string>(req.params.subscriptions.map((t: { type: string }) => t.type));
          subscribers.set(s, { types, write: (line) => s.write(line) });
          answer = { id: req.id, result: { type: "subscription_started" } };
        } else {
          const method = methods[req.method];
          if (req.method !== "fake.calls") calls.push({ method: req.method, params: req.params ?? {} });
          if (!method) throw new HerdrError("unknown_method", `unknown method ${req.method}`);
          answer = { id: req.id, result: method(req.params ?? {}) };
        }
      } catch (e) {
        // ponytail: any other throw is a bad request (bad JSON, a missing param); Herdr's own wording is unrecorded.
        const { code, message } = e instanceof HerdrError ? e : { code: "invalid_params", message: String(e) };
        answer = { id: req?.id, error: { code, message } };
      }
      s.write(JSON.stringify(answer) + "\n");
    }
  }

  Bun.listen<Conn>({
    unix: sock,
    socket: {
      open(s) {
        s.data = { buf: "" };
      },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        lines(s);
      },
      close(s) {
        s.data.gone = true;
        subscribers.delete(s);
        s.data.detach?.();
      },
    },
  });
  // Restart: the restore record keeps the layout and each pane's session id, not the env given at create.
  const record = join(dir, "session.json");
  if (existsSync(record)) {
    const saved = JSON.parse(readFileSync(record, "utf8"));
    nextWs = saved.nextWs;
    for (const w of saved.workspaces) workspaces.set(w.id, w);
    for (const { session, ...rest } of saved.panes) {
      const p: Pane = { ...rest, terminal: "", revision: 0, ctrlC: 0 };
      panes.set(p.id, p);
      start(p);
      if (!session || config.resumeAgents === false) continue;
      // Herdr reports the old session at once, and types the resume line once the shell is up: pi's
      // by its session file, Codex's by its thread, as measured (architecture §10.2).
      p.agent = session.agent;
      p.session = session;
      const line = { pi: `pi --session ${session.value}`, codex: `codex resume ${session.value}` }[session.agent as string] ?? `claude --resume ${session.value}`;
      setTimeout(() => panes.get(p.id) === p && type(p, `${line}\n`), config.resumeDelay ?? 2500);
    }
  }

  /** Saves the restore record, hangs up the panes and exits. `last`: once the panes' processes are
   *  gone, just before exiting. */
  async function stop(last?: () => void) {
    stopping = true;
    const saved = [...panes.values()].map(({ id, tab, ws, label, cwd, session }) => ({ id, tab, ws, label, cwd, session }));
    writeFileSync(record, JSON.stringify({ nextWs, workspaces: [...workspaces.values()], panes: saved }));
    for (const p of panes.values()) p.operator?.close("server is shutting down");
    for (const p of panes.values()) hangUp(p);
    rmSync(sock, { force: true });
    if (last) {
      await Promise.all([...panes.values()].map((p) => p.proc!.exited));
      last();
    }
    // Exiting drops every connection: subscriptions see EOF and no event.
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop());
}
