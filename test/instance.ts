// The seam one tool (docs/spec/v1.md "接缝一"): a Rhodium instance kept apart from the one in use
// ("和正在用的 Rhodium 隔开"): its own temp dir, SQLite, config, socket and lock directories, unit
// prefix rhodium-test-<random>-, and a sandbox HOME. Its bots are fake bots on a fake IM platform
// that runs in the test process, and its claude and pi are fake agents. rhodium runs as a child
// (start, kill9) or as a systemd user service (installService). Tests drive it through `rh` and
// the fake IM, and read its log.
import { dlopen } from "bun:ffi";
import { expect } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { FakeIm, FakeImClient, fakeCapabilities, type PlatformBotOptions } from "../src/fake-im";
import { installFakeAgent, type Config as FakeAgentConfig } from "./fake-agent/fake-agent";
import { installFakeHerdr, socketPath, startFakeHerdr, type FakeHerdrConfig } from "./fake-herdr/fake-herdr";

type FakeAgent = ReturnType<typeof installFakeAgent>;

/** Your Tailscale login, as tailscale serve puts it in the board's requests (architecture §11). */
export const BOARD_LOGIN = "you@example.com";

/** A write to the board at base (http://host:port) as its own page sends one (spec web-write): POST
 *  /api/act, same-origin. headers: more, or in place of these. */
export function boardAct(base: string, act: unknown, id: string = crypto.randomUUID(), headers: Record<string, string> = {}): Promise<Response> {
  const own = { "Tailscale-User-Login": BOARD_LOGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" };
  return fetch(`${base}/api/act`, { method: "POST", headers: { ...own, ...headers }, body: JSON.stringify({ id, act }) });
}

const main = join(import.meta.dir, "../src/main.ts");
const service = join(import.meta.dir, "../scripts/rhodium-service.sh");

/** logs: rhodium's log lines (JSON, one per line on stderr), parsed. */
export type Daemon = { proc: Subprocess; logs: Record<string, unknown>[] };
/** screen: what showed on rh's terminal, when the test typed into it (echo, say). */
export type RhResult = { code: number; out: string; err: string; screen?: string };
/** How a test runs rh. tty: false runs it as a caller rhodium cannot recognize. type: text typed
 *  into rh's terminal once rh has asked for it on stderr; several, each at the next time it writes
 *  there. preload: a module bun loads before rh, to swap out a package that talks to the outside world. */
export type RhOptions = { cwd?: string; tty?: boolean; type?: string | string[]; preload?: string };

export type Instance = {
  dir: string;
  /** rhodium's config.toml. */
  config: string;
  /** The environment rhodium and rh run with: the sandbox HOME, and RHODIUM_SOCKET pointing here. */
  env: Record<string, string | undefined>;
  socket: string;
  unitPrefix: string;
  /** rhodium's HOME: a sandbox with ~/.claude settings and a Herdr config that cleanup checks are unchanged. */
  home: string;
  /** The fake IM platform's test side: you, plus control over the platform. */
  im: FakeImClient;
  /** The fake agents rhodium runs as claude, pi and codex; runs() reads what each run was given. */
  claude: FakeAgent;
  pi: FakeAgent;
  codex: FakeAgent;
  /** The fake Herdr session rhodium opens TUI panes in, under the sandbox HOME. Its server runs
   *  from the first start() on, when the instance was made with the herdr option; stop() and start()
   *  restart it, as a Herdr restart does. Its auto-resume finds the fake claude on its PATH. */
  herdr: { session: string; socket: string; stop(): Promise<void>; start(): Promise<void> };
  /** Starts a rhodium on this instance; resolves once it is ready, rejects with its log if it exits first.
   *  command: the rhodium it runs, this checkout's by default. */
  start(command?: string[]): Promise<Daemon>;
  /** Stops every rhodium this instance started. */
  stop(): Promise<void>;
  /** kill -9 every rhodium this instance started, by the PIDs it recorded, and waits for them to die. */
  kill9(): Promise<void>;
  /** Runs rh as you would from ssh: its stdin is a terminal, so rhodium takes the call for yours. */
  rh(args: string[], opts?: RhOptions): Promise<RhResult>;
  /** Runs rh from your terminal and expects it to succeed; returns its stdout. */
  ok(...args: string[]): Promise<string>;
  /** The slot's state as rh ls shows it, say "空闲". */
  state(ref: string): Promise<string | undefined>;
  /** A workspace w, with <dir>/w as its default dir, holding the slots w/<name>. */
  slots(...names: string[]): Promise<void>;
  /** Installs, enables and starts rhodium as the systemd user service <prefix>rhodium, with scripts/rhodium-service.sh.
   *  Its rhodium has the same config and HOME as start()'s. options: more of the script's options,
   *  such as --alert-env. command: the rhodium it runs, this checkout's by default. Resolves to the unit name. */
  installService(options?: string[], command?: string[]): Promise<string>;
  /** The systemd user units under this instance's prefix that systemd still has loaded. */
  units(): Promise<string[]>;
  /** Stops every rhodium and every unit under the prefix, closes the fake IM, removes the temp dir. */
  cleanup(): Promise<void>;
};

/** What a command did: its exit code, stdout and stderr. */
export type Exec = { code: number; out: string; err: string };
export type ExecOptions = { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number };

/** work, or a throw once timeoutMs is up, which kills proc. */
async function within<T>(proc: Subprocess, argv: string[], timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: Timer | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${argv.join(" ")} still running after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a command to the end; past timeoutMs it kills the command and throws. Tests run outside
 *  programs this way, never with Bun.spawnSync: that blocks the test process, so when the call
 *  never returns, the test's own timeout cannot fire and the whole run hangs (docs/agents/testing.md). */
export async function exec(argv: string[], { timeoutMs = 30_000, ...opts }: ExecOptions = {}): Promise<Exec> {
  const proc = Bun.spawn(argv, { ...opts, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await within(
    proc,
    argv,
    timeoutMs,
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  return { code, out, err };
}

/** Runs a command to the end; throws with its stderr unless it exits 0. */
export async function run(argv: string[], opts?: ExecOptions): Promise<string> {
  const r = await exec(argv, opts);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} exited with ${r.code}: ${r.err}`);
  return r.out;
}

/** systemctl --user's stdout, trimmed, whatever its exit code. */
export const systemctl = async (...args: string[]) => (await exec(["systemctl", "--user", ...args])).out.trim();
/** The main PID systemd has for the unit, 0 when it has none. */
export const mainPid = async (unit: string) => Number(await systemctl("show", "--property=MainPID", "--value", unit));

function parseLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line);
  } catch {
    return { msg: line };
  }
}

/** A user frame's text without the line saying where it came from, which Rhodium starts your
 *  messages from IM with (architecture §6.1; test/agent-prompt.test.ts checks that line). */
export { withoutSource } from "../src/prompt";

/** Polls check every 20 ms until it holds; fails after timeoutMs (under bun test's 5 s default). */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`still not true after ${timeoutMs} ms: ${check}`);
    await Bun.sleep(20);
  }
}

/** A pseudo-terminal: slave is the terminal a program reads and writes; writing to master types
 *  into it, and reading master (it does not block) gives what showed on it. */
function pty(): { master: number; slave: number } {
  const { symbols: c } = dlopen("libc.so.6", {
    posix_openpt: { args: ["i32"], returns: "i32" },
    grantpt: { args: ["i32"], returns: "i32" },
    unlockpt: { args: ["i32"], returns: "i32" },
    ptsname: { args: ["i32"], returns: "cstring" },
  });
  const flags = constants.O_RDWR | constants.O_NOCTTY;
  const master = c.posix_openpt(flags | constants.O_NONBLOCK);
  if (master < 0 || c.grantpt(master) || c.unlockpt(master)) throw new Error("cannot open a pseudo-terminal");
  return { master, slave: openSync(String(c.ptsname(master)), flags) };
}

/** A terminal for rh's stdin, opened once per test process; nothing is ever typed into it. Its master
 *  stays open: closing it would hang the terminal up. */
let tty: number | undefined;
export const terminal = (): number => (tty ??= pty().slave);

/** What has shown on the terminal whose master this is and not been read yet. */
function screen(master: number): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(4096);
  for (;;) {
    try {
      const n = readSync(master, buf);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch {
      break; // EAGAIN: nothing more to read; EIO: no one has the terminal open any more
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Files in the sandbox HOME that Rhodium must never change: your Claude settings and Herdr config. */
const SANDBOX = {
  ".claude/settings.json": JSON.stringify({ model: "sonnet", permissions: { allow: ["Bash(ls:*)"] } }, null, 2) + "\n",
  ".config/herdr/config.toml": "# Herdr's config: Rhodium only reads it\n",
};

/** A fake bot: the capability table it copies, plus keys for its [bots.<name>] table (owner, target);
 *  owner may be a list.
 *  A Telegram-like one sends five requests a chat a second unless perChatPerSecond says otherwise. */
export type FakeBotSpec = "qq" | "telegram" | "feishu" | ({ like: "qq" | "telegram" | "feishu" } & Record<string, string | string[]>);

export type InstanceOptions = {
  /** Extra lines for config.toml. */
  toml?: string;
  /** Fake bots to enable, by name. */
  bots?: Record<string, FakeBotSpec>;
  /** What the fake claude, pi and codex play: a script or a recording. Defaults to the "turn" script,
   *  to "pi-turn" for pi and to "codex-turn" for codex. */
  claude?: FakeAgentConfig;
  pi?: FakeAgentConfig;
  codex?: FakeAgentConfig;
  /** Another instance's socket directory, to share it. Defaults to the instance's own. */
  socketDir?: string;
  /** How the fake platform treats every bot, apart from its capability table: its own QQ quota, say. */
  platform?: Omit<PlatformBotOptions, "name" | "capabilities">;
  /** Seconds each holder unit's ExecStopPost takes before it does anything, as on a busy machine. */
  stopPostDelay?: number;
  /** Runs a fake Herdr server for the instance's Herdr session (true: Herdr's defaults). */
  herdr?: boolean | FakeHerdrConfig;
  /** The Herdr session's name; the temp dir's by default. "default", the one you use, is the fake's
   *  too: its socket is under the sandbox HOME. */
  herdrSession?: string;
  /** More variables for rhodium's and the fake Herdr server's environment. */
  env?: Record<string, string>;
};

/** rh-hold, built once per version of holder/'s source and shared by every test run of it, so
 *  runs neither rebuild it nor leave a copy each. bun test fires no exit hook to clean up after.
 *  bin is where it is, known at once; built settles once it is there. */
let holder: { bin: string; built: Promise<void> } | undefined;
export function rhHold(): { bin: string; built: Promise<void> } {
  if (holder) return holder;
  const src = join(import.meta.dir, "../holder");
  const files = ["Cargo.toml", "Cargo.lock", ...readdirSync(join(src, "src"), { recursive: true }).map((f) => `src/${f}`)].sort();
  const hash = Bun.hash(files.map((f) => `${f}\0${readFileSync(join(src, f), "latin1")}`).join("\0")).toString(36);
  const bin = join(tmpdir(), `rhodium-test-rh-hold-${hash}`, "rh-hold");
  const built = existsSync(bin) ? Promise.resolve() : buildHolder(src, bin);
  built.catch(() => {}); // reported to whoever awaits it, not as unhandled when no test does
  return (holder = { bin, built });
}

async function buildHolder(src: string, bin: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "rhodium-test-rh-hold-build-"));
  try {
    const PATH = `${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
    const target = join(work, "target");
    const build = await exec(["cargo", "build", "--release", "--quiet", "--manifest-path", join(src, "Cargo.toml"), "--target-dir", target], {
      env: { ...process.env, PATH },
      timeoutMs: 300_000,
    });
    if (build.code !== 0) throw new Error(`cargo build of rh-hold failed:\n${build.err}`);
    mkdirSync(dirname(bin), { recursive: true });
    copyFileSync(join(target, "release/rh-hold"), join(work, "rh-hold"));
    renameSync(join(work, "rh-hold"), bin); // whole or not at all, for a run building it alongside
  } finally {
    rmSync(work, { recursive: true, force: true }); // Rust build caches are large
  }
}

export function newInstance(opts: InstanceOptions = {}): Instance {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-"));
  const unitPrefix = `${basename(dir)}-`;
  const socketDir = opts.socketDir ?? join(dir, "run");
  const config = join(dir, "config.toml");
  const imSocket = join(dir, "fake-im.sock");
  const fakeIm = new FakeIm(imSocket);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const holderBuild = rhHold();
  let hold = holderBuild.bin;
  if (opts.stopPostDelay) {
    const slow = join(bin, "rh-hold-slow-stop-post");
    writeFileSync(slow, `#!/bin/sh\n[ "$1" = stop-post ] && sleep ${opts.stopPostDelay}\nexec ${hold} "$@"\n`, { mode: 0o755 });
    hold = slow;
  }
  const claude = installFakeAgent(bin, opts.claude ?? {}, "claude");
  const pi = installFakeAgent(bin, { script: "pi-turn", ...opts.pi }, "pi");
  const codex = installFakeAgent(bin, { script: "codex-turn", ...opts.codex }, "codex");
  // Every instance gets a fake herdr, so none ever reaches yours; its server runs only with opts.herdr.
  const herdrBin = installFakeHerdr(bin, typeof opts.herdr === "object" ? opts.herdr : {});
  const herdrSession = opts.herdrSession ?? basename(dir);
  const toml = [
    `stateDir = "${join(dir, "state")}"`,
    `socketDir = "${socketDir}"`,
    `lockDir = "${join(dir, "lock")}"`,
    `unitPrefix = "${unitPrefix}"`,
    `unit = "${unitPrefix}rhodium"`, // the service installService() runs it as
    `holdBin = "${hold}"`,
    opts.toml ?? "",
    "[programs]",
    `claude = "${claude.path}"`,
    `pi = "${pi.path}"`,
    `codex = "${codex.path}"`,
    `herdr = "${herdrBin}"`,
    // Port 0: any free one, as tests run side by side; the ready log line says which.
    "[board]",
    "port = 0",
    `login = "${BOARD_LOGIN}"`,
    "[herdr]",
    `session = "${herdrSession}"`,
  ];
  for (const [name, spec] of Object.entries(opts.bots ?? {})) {
    const { like, ...given } = typeof spec === "string" ? { like: spec } : spec;
    const keys = like === "telegram" ? { perChatPerSecond: "5", ...given } : given;
    fakeIm.bot({ name, capabilities: fakeCapabilities({ platform: "fake", like, ...(given as Record<string, string>) }), ...opts.platform });
    toml.push(`[bots.${name}]`, `platform = "fake"`, `like = "${like}"`, `socket = "${imSocket}"`);
    toml.push(...Object.entries(keys).map(([k, v]) => `${k} = ${JSON.stringify(v)}`));
  }
  writeFileSync(config, toml.join("\n"));
  chmodSync(config, 0o600);

  // HOME is a sandbox with your settings as Rhodium must leave them (story 156).
  const home = join(dir, "home");
  for (const [file, text] of Object.entries(SANDBOX)) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), text);
  }
  const socket = join(socketDir, "rh.sock");
  // Everything else under HOME comes from the sandbox too. XDG_RUNTIME_DIR stays: systemd-run needs it.
  // The tests may run in your Herdr pane or Claude or Codex session; rhodium must not see any of them.
  const leaks = /^(XDG_(CONFIG|DATA|STATE|CACHE)_HOME|RHODIUM_|HERDR_|CLAUDE|CODEX_)/;
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !leaks.test(k)),
  );
  Object.assign(env, opts.env, { HOME: home, CODEX_HOME: join(home, ".codex"), RHODIUM_SOCKET: socket });
  const daemons: Daemon[] = [];
  const serviceUnit = `${unitPrefix}rhodium`;
  let cleaned = false;
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;

  async function startHerdr(): Promise<void> {
    // Without rhodium's socket: a pane's rh finds it only if rhodium hands it over.
    const serverEnv = Object.entries(env).filter((kv): kv is [string, string] => kv[0] !== "RHODIUM_SOCKET" && kv[1] !== undefined);
    herdr = await startFakeHerdr(herdrBin, herdrSession, { ...Object.fromEntries(serverEnv), PATH: `${bin}:${env.PATH}` });
  }

  async function start(command = [process.execPath, main]): Promise<Daemon> {
    await holderBuild.built;
    if (opts.herdr && !herdr) await startHerdr();
    const proc = Bun.spawn([...command, "--config", config], { env, stdout: "ignore", stderr: "pipe" });
    const d: Daemon = { proc, logs: [] };
    daemons.push(d);
    let onReady!: () => void;
    const ready = new Promise<void>((r) => (onReady = r));
    const reading = (async () => {
      let buf = "";
      for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
        const lines = (buf + chunk).split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          const entry = parseLine(line);
          d.logs.push(entry);
          if (entry.msg === "ready") onReady();
        }
      }
    })();
    const exited = proc.exited.then(async (code) => {
      await reading;
      throw new Error(`rhodium exited with ${code} before it was ready:\n${d.logs.map((l) => JSON.stringify(l)).join("\n")}`);
    });
    await Promise.race([ready, exited]);
    exited.catch(() => {}); // it exits later, on stop
    return d;
  }

  async function stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    for (const d of daemons.splice(0)) {
      d.proc.kill(signal);
      await d.proc.exited;
    }
  }

  const instance: Instance = {
    dir,
    config,
    env,
    socket,
    unitPrefix,
    home,
    im: new FakeImClient(imSocket),
    claude,
    pi,
    codex,
    herdr: {
      session: herdrSession,
      socket: socketPath(home, herdrSession),
      async stop() {
        await herdr?.stop();
        herdr = undefined;
      },
      start: startHerdr,
    },
    start,
    stop: () => stop(),
    kill9: () => stop("SIGKILL"),
    async ok(...args) {
      const r = await instance.rh(args);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      return r.out;
    },
    async state(ref) {
      // From the slot's details, as a state may have a space in it: TUI 模式.
      const r = await instance.rh(["ls", ref]);
      return r.code === 0 ? r.out.match(/^状态: (.+)$/m)?.[1] : undefined;
    },
    async slots(...names) {
      const ws = join(dir, "w");
      mkdirSync(ws);
      await instance.ok("ws", "w", ws);
      for (const n of names) await instance.ok("new", `w/${n}`);
    },
    async rh(args, opts = {}) {
      const own = opts.type === undefined ? undefined : pty();
      const proc = Bun.spawn([process.execPath, ...(opts.preload ? ["--preload", opts.preload] : []), main, "rh", ...args], {
        env,
        cwd: opts.cwd ?? dir,
        stdin: opts.tty === false ? "ignore" : (own?.slave ?? terminal()),
        stdout: "pipe",
        stderr: "pipe",
      });
      const typing = [opts.type ?? []].flat();
      const err = (async () => {
        let text = "";
        for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
          text += chunk;
          const typed = typing.shift();
          if (own && typed !== undefined) writeSync(own.master, typed);
        }
        return text;
      })();
      const [out, errText, code] = await within(proc, ["rh", ...args], 30_000, Promise.all([new Response(proc.stdout).text(), err, proc.exited]));
      if (!own) return { code, out, err: errText };
      const shown = screen(own.master);
      closeSync(own.slave);
      closeSync(own.master);
      return { code, out, err: errText, screen: shown };
    },
    async installService(options = [], command = [process.execPath, main]) {
      const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
      await holderBuild.built;
      await run([service, "install", serviceUnit, "--config", config, "--path", path, "--env", `HOME=${home}`, ...options, "--", ...command]);
      return serviceUnit;
    },
    async units() {
      const out = await run(["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "--full", `${unitPrefix}*`]);
      return out.split("\n").filter(Boolean).map((l) => l.split(" ")[0]!);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      let changed: string[] = [];
      try {
        await stop();
        await herdr?.stop();
        // Only this instance's prefix: other tests and the Rhodium in use share the user manager.
        // A holder unit on its way out can match the pattern and be gone by the time it is stopped.
        await run(["systemctl", "--user", "stop", `${unitPrefix}*`]).catch((e: Error) => {
          if (!/not loaded/.test(e.message)) throw e;
        });
        await run(["systemctl", "--user", "reset-failed", `${unitPrefix}*`]);
        await run([service, "uninstall", serviceUnit]); // a no-op unless installService() ran
        changed = Object.entries(SANDBOX)
          .filter(([file, text]) => !existsSync(join(home, file)) || readFileSync(join(home, file), "utf8") !== text)
          .map(([file]) => file);
      } finally {
        // Even when a step above fails, so no temp dir or fake IM socket is left behind.
        fakeIm.close();
        rmSync(dir, { recursive: true, force: true });
      }
      if (changed.length) throw new Error(`rhodium changed the sandbox's ${changed.join(" and ")} (story 156)`);
    },
  };
  return instance;
}
