// The config file (docs/spec/v1.md "配置"): TOML, mode 0600 because it holds bot tokens.
// Read once at startup; changes need a restart, but for a bot rh bot adds.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { version } from "../package.json";
import { AGENTS } from "./agents";
import type { AgentKind, Platform } from "./contracts";
import type { Bot } from "./store";
import { PLATFORMS } from "./platforms";

/** The commit this rhodium was built from, which scripts/build.sh bakes in; run from source (rh dev,
 *  tests), the environment's, if it has one. BUILD: 1.0.0-4a9cf6e, or 1.0.0 with no commit, as
 *  rhodium --version prints it. */
export const COMMIT = process.env.RHODIUM_BUILD_COMMIT || null;
export const BUILD = COMMIT ? `${version}-${COMMIT}` : version;

// Every duration Rhodium waits on, as the config file leaves it. Tests set them to seconds.
export const durations = {
  idleReap: "1h", // product §4.4
  askTimeout: "30m", // product §5.8; 0s = never
  crashWindow: "10m", // product §4.5, circuit breaker window
  oneoffArchive: "24h", // product §6.1
  quotaStagger: "60s", // architecture §7.6, spread of auto-continue restarts
  quotaNotice: "30s", // product §4.6, how long the notice that Claude's quota ran out waits for the other slots running out with it
  sentAtAfter: "5m", // architecture §6.1, how long after you sent it your message reaches the agent saying when you sent it
  qqPassiveWindow: "60m", // product §5.5, how long a QQ passive reply stays usable
  qqActiveWindow: "24h", // product §5.5, the period qqActive counts over: a day, per QQ's docs, never probed
  holdStartTimeout: "10s", // architecture §4.2, holder waits this long for start
  holderGone: "10s", // architecture §4.2, how long a holder unit gets to go before it counts as stuck
  programWait: "30s", // architecture §4.2, how long a start waits for an agent program not there, as while it updates itself
  stopGrace: "5s", // architecture §6.2, each step of eof -> TERM -> KILL
  releaseGrace: "10s", // architecture §10.1, /rh_release before SIGTERM
  herdrRestartWait: "5m", // architecture §10.2
  menuRetry: "1m", // architecture §8.4, before a menu push that failed is tried again
  feishuEdit: "3s", // architecture §8.2, the least time between two edits of a turn's Feishu card
  // The longest each is kept; limits.stateMaxMB may see them go sooner (architecture §7.8).
  holdDirKeep: "7d", // architecture §4.3
  inboundKeep: "90d", // architecture §7.1, inbound and outbound records with their quoted text (§8.3), and the media dir (§7.8)
  eventKeep: "180d", // architecture §7.2
  backupEvery: "24h", // architecture §7.8, also the retention cleanup; never 0
  doctorEvery: "24h", // architecture §12, the daily rh doctor; never 0
  pairCode: "10m", // architecture §8.5, how long a code from rh pair works
  boardIdle: "10s", // architecture §11, how long the board keeps a quiet request open (Bun's idleTimeout, whole seconds)
};

const limits = {
  maxRunning: 8, // product §6.1
  maxChildren: 4,
  maxDepth: 3,
  rhPerMinute: 120,
  crashCount: 3, // product §4.5, crashes within crashWindow that trip the breaker
  quoteMaxChars: 1000, // architecture §8.3
  // product §5.5, passive replies to each inbound QQ message: at least 20 in the 2026-10-21 probe, where
  // QQ's docs say 4
  qqPassiveReplies: 20,
  qqActive: 1000, // product §5.5, active messages per QQ bot each qqActiveWindow, per QQ's docs, never probed
  botFailures: 5, // architecture §8.6, failed tries in a row to reach its platform that mark a bot faulted; 0 = never
  minFreeMB: 2048, // architecture §7.8, free disk below which no slot is made or started
  stateMaxMB: 5120, // architecture §7.8, records and ended hold dirs past which the oldest go
  outRestartMB: 64, // product §4.4, output of a headless agent process past which it goes between turns; 0 = never
};

// Global defaults for the per-slot settings that `rh set` overrides.
const defaults = { approval: false, crashResume: true, autoContinue: true };

// The agents' executables and Herdr's CLI: an absolute path, or a bare name looked up on PATH.
// Tests point them at the fake agent and the fake Herdr.
const programs = { ...(Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, a.program])) as Record<AgentKind, string>), herdr: "herdr" };

/** Where a [programs] entry is, looked up afresh each time so an update reaches the next process:
 *  an absolute path as is, a bare name on PATH (the agents'); null if it is not there. */
export const locate = (program: string, PATH: string): string | null => (isAbsolute(program) ? program : Bun.which(program, { PATH }));

/** Whether Herdr is installed: herdr is where switching to the terminal looks for it (product §4.2).
 *  Whether it runs is not asked. */
export function hasHerdr(cfg: Config): boolean {
  const herdr = locate(cfg.programs.herdr, cfg.agentPath);
  return herdr !== null && existsSync(herdr);
}

// The Herdr session TUI panes open in (architecture §10): yours. Tests use one of their own.
const herdr = { session: "default" };

// The board (architecture §11, ADR-0013) listens on bind:port, port 0 any free one. Who gets in, by
// auth: tailscale, requests whose Tailscale-User-Login is login, as tailscale serve says it; empty,
// nobody. none: whoever reaches the port, the proxy in front of it checking who. Either way by this
// machine's name, and the tailnet's (tailscale) or hosts, the names that proxy reaches it by (none).
const board = { port: 7800, login: "", bind: "127.0.0.1", auth: "tailscale" as "tailscale" | "none", hosts: [] as string[] };
/** A name as a browser sends it in Host: lowercase, no scheme, no port. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535;

/** What is wrong with [board], laid over its defaults, as the closed board and rh doctor say it; null: nothing. */
function boardWrong(w: Record<string, unknown>): string | null {
  const said = (v: unknown) => `写的是 ${JSON.stringify(v)}`;
  const { port, login, bind, auth, hosts } = w;
  const unknown = Object.keys(w).find((k) => !Object.hasOwn(board, k));
  if (unknown !== undefined) return `没有 board.${unknown} 这一项，只有 ${Object.keys(board).join("、")}`;
  if (!isPort(port)) return `board.port ${said(port)}，要写 0 到 65535 的端口号`;
  if (typeof login !== "string") return `board.login ${said(login)}，要写成字符串，例如 "you@example.com"`;
  if (typeof bind !== "string" || !isIP(bind)) return `board.bind ${said(bind)}，要写 IP 地址，例如 "127.0.0.1"`;
  if (auth !== "tailscale" && auth !== "none") return `board.auth ${said(auth)}，只能是 "tailscale" 或 "none"`;
  if (!Array.isArray(hosts)) return `board.hosts ${said(hosts)}，要写成主机名的列表，例如 ["board.example.com"]`;
  const bad = hosts.find((h) => typeof h !== "string" || !HOSTNAME.test(h));
  if (bad !== undefined) return `board.hosts 里的 ${JSON.stringify(bad)} 不是主机名：要小写，不带协议和端口，例如 "board.example.com"`;
  // In tailscale mode anyone a proxy brings in could write your Tailscale-User-Login.
  if (auth === "tailscale" && hosts.length) return 'board.hosts 只在 auth = "none" 时用：tailscale 模式只认 tailnet 和本机的地址';
  return null;
}

const platforms = Object.keys(PLATFORMS) as Platform[];
/** A [bots.<name>] table: the platform plus its credentials (token, appId, secret...). owner, your
 *  user id under the bot, may be a list in the file; it is kept here one id a line (owners()). */
export type BotConfig = { platform: Platform; [credential: string]: string };

/** Your user ids under the bot, its owners (product §5.11): the config's, then those pairing added. */
export function owners(bot: Pick<Bot, "name" | "owners">, config: Pick<Config, "bots">): string[] {
  return [...new Set([...fixedOwners(config.bots[bot.name]), ...paired(bot)])];
}

/** The owners the bot's config table names: none, one, or a list. */
export const fixedOwners = (bot: BotConfig | undefined): string[] => bot?.owner?.split("\n") ?? [];

/** The bot's owners pairing added (rh pair). */
export const paired = (bot: Pick<Bot, "owners">): string[] => (bot.owners ? JSON.parse(bot.owners) : []);

export type Config = {
  stateDir: string; // rh.db and hold/<conversation>/
  socketDir: string; // rh socket and hold/<conversation>.sock
  lockDir: string; // conversation locks
  unitPrefix: string; // holder units are <unitPrefix>hold-<conversation>
  // The systemd user service rhodium runs as (product §10), whose journal the board shows. The daemon
  // empties it when it finds itself running outside it (rh dev, tests).
  unit: string;
  // PATH for agents and their holder units. systemd user services get a PATH without nvm,
  // and claude, pi and their MCP servers and hooks need node, so deploy sets this (#52).
  agentPath: string;
  memoryHigh: string; // MemoryHigh= of holder units (architecture §4.2)
  // The rh-hold binary. Empty: the one installed next to rhodium's own binary (architecture §4.7).
  holdBin: string;
  // The main chat (product §5.9), written "<bot>/<the platform's chat id>", the bot one of [bots]. null: none.
  mainChat: { bot: string; chat: string } | null;
  durations: Record<keyof typeof durations, number>; // milliseconds
  limits: typeof limits;
  defaults: typeof defaults;
  bots: Record<string, BotConfig>;
  programs: typeof programs;
  // closed: what is wrong in [board], which closes the board alone; it then listens on 127.0.0.1, on
  // the port given, or the default if that is what is wrong.
  board: typeof board & { closed: string | null };
  herdr: typeof herdr;
};

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s", "10m", "1h", "7d" (or ms) to milliseconds; null if it doesn't look like that. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(v);
  return m ? Math.round(Number(m[1]) * UNIT_MS[m[2]!]!) : null;
}

/** Milliseconds back to the largest unit that divides them evenly, e.g. 5400000 -> "90m". */
export function formatDuration(ms: number): string {
  const [unit, size] = Object.entries(UNIT_MS).findLast(([, size]) => ms % size === 0) ?? ["ms", 1];
  return `${ms / size}${unit}`;
}

/** Bytes in GB to one decimal, e.g. 2147483648 -> "2.0GB": free disk against limits.minFreeMB. */
export const formatGB = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(1)}GB`;
export const formatMB = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(1)}MB`;

function toMs(key: string, v: string): number {
  const ms = parseDuration(v);
  if (ms === null) throw new Error(`config: durations.${key} must look like "30s", "10m", "1h" or "7d"`);
  return ms;
}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Overlay a TOML table onto defaults, refusing unknown keys and values of the wrong type. */
function overlay<T extends Record<string, unknown>>(where: string, base: T, given: unknown): T {
  if (given === undefined) return { ...base };
  if (!isTable(given)) throw new Error(`config: ${where} must be a table`);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(given)) {
    if (!Object.hasOwn(base, k)) throw new Error(`config: unknown key ${where}${k}`);
    if (typeof v !== typeof base[k]) throw new Error(`config: ${where}${k} must be a ${typeof base[k]}`);
    out[k] = v;
  }
  return out as T;
}

/** Where the socket directory is when the config does not say; `rh` looks there too. */
export function defaultSocketDir(env: Record<string, string | undefined>): string {
  return `${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/rhodium`;
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Config {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`config: ${path} has mode 0${mode.toString(8)}; it holds bot tokens, chmod it to 0600`);
  }
  const { durations: d, limits: l, defaults: t, bots: b, programs: p, board: w, herdr: h, ...top } = Bun.TOML.parse(
    readFileSync(path, "utf8"),
  ) as Record<string, unknown>;

  const paths = overlay(
    "",
    { stateDir: "", socketDir: "", lockDir: "", unitPrefix: "rh-", unit: "rhodium", agentPath: "", memoryHigh: "3G", holdBin: "", mainChat: "" },
    top,
  );
  if (!paths.stateDir && !env.HOME) throw new Error("config: HOME is not set, so stateDir must be given");
  const stateDir = paths.stateDir || `${env.HOME}/.local/state/rhodium`;
  for (const k of ["unitPrefix", "unit"] as const) {
    if (!/^[A-Za-z0-9:_.-]+$/.test(paths[k])) throw new Error(`config: ${k} may only use letters, digits and : _ . - (systemd unit names)`);
  }
  const dirs = {
    stateDir,
    socketDir: paths.socketDir || defaultSocketDir(env),
    lockDir: paths.lockDir || `${stateDir}/lock`,
  };
  for (const [k, v] of Object.entries({ ...dirs, ...(paths.holdBin && { holdBin: paths.holdBin }) })) {
    if (!isAbsolute(v)) throw new Error(`config: ${k} must be an absolute path`);
  }

  if (b !== undefined && !isTable(b)) throw new Error("config: bots must be a table");
  for (const [name, bot] of Object.entries(b ?? {})) {
    if (!isTable(bot)) throw new Error(`config: bots.${name} must be a table`);
    // rh send me and rh send web are to you, by the default and on the board (product §5.9).
    if (name === "me" || name === "web") throw new Error(`config: bots.${name}: a bot may not be named me or web, which rh send takes for you; rename it`);
    if (!platforms.includes((bot as BotConfig).platform)) {
      throw new Error(`config: bots.${name}.platform must be one of ${platforms.join(", ")}`);
    }
    const { owner } = bot as Record<string, unknown>;
    if (Array.isArray(owner)) {
      if (!owner.length || !owner.every((o) => typeof o === "string" && o && !o.includes("\n"))) throw new Error(`config: bots.${name}.owner must be a user id or a list of them`);
      bot.owner = owner.join("\n");
    }
    for (const [k, v] of Object.entries(bot)) {
      if (typeof v !== "string") throw new Error(`config: bots.${name}.${k} must be a string`);
    }
  }
  // fromEntries defines keys, so a bot named __proto__ stays a bot instead of a prototype.
  const bots = Object.fromEntries(Object.entries(b ?? {})) as Record<string, BotConfig>;
  const slash = paths.mainChat.indexOf("/");
  const mainChat = paths.mainChat ? { bot: paths.mainChat.slice(0, slash), chat: paths.mainChat.slice(slash + 1) } : null;
  if (mainChat && (slash < 0 || !Object.hasOwn(bots, mainChat.bot) || !mainChat.chat)) {
    throw new Error("config: mainChat must be <bot>/<chat id>, with the bot one of [bots]");
  }

  const progs = overlay("programs.", programs, p);
  for (const [k, v] of Object.entries(progs)) {
    if (!isAbsolute(v) && (!v || v.includes("/"))) throw new Error(`config: programs.${k} must be an absolute path or a bare name`);
  }

  const lim = overlay("limits.", limits, l);
  for (const [k, v] of Object.entries(lim)) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`config: limits.${k} must be a whole number, 0 or more`);
  }

  const web: Record<string, unknown> = { ...board, ...(isTable(w) ? w : {}) };
  const closed = w === undefined || isTable(w) ? boardWrong(web) : `board 写的是 ${JSON.stringify(w)}，要写成 [board] 表`;

  const tui = overlay("herdr.", herdr, h);
  if (!tui.session) throw new Error("config: herdr.session must name a Herdr session");

  const durs = Object.fromEntries(
    Object.entries(overlay("durations.", durations, d)).map(([k, v]) => [k, toMs(k, v)]),
  ) as Config["durations"];
  // A timer set to 0 would go off again at once, forever.
  for (const k of ["doctorEvery", "backupEvery"] as const) if (!durs[k]) throw new Error(`config: durations.${k} must be more than 0s`);

  return {
    ...dirs,
    unitPrefix: paths.unitPrefix,
    unit: paths.unit,
    agentPath: paths.agentPath || env.PATH || "/usr/local/bin:/usr/bin:/bin",
    memoryHigh: paths.memoryHigh,
    holdBin: paths.holdBin,
    mainChat,
    durations: durs,
    limits: lim,
    defaults: overlay("defaults.", defaults, t),
    bots,
    programs: progs,
    board: closed ? { ...board, port: isPort(web.port) ? web.port : board.port, closed } : { ...(web as typeof board), closed },
    herdr: tui,
  };
}

/** Appends a [bots.<name>] table to the config file (rh bot), leaving the rest as you wrote it. name
 *  must be a bare TOML key. The new file is written beside the old one, mode 0600, and takes its
 *  place only once it loads as a config. Returns the bot as the new file has it. */
export function addBot(path: string, name: string, table: Record<string, string>): BotConfig {
  const text = readFileSync(path, "utf8");
  // JSON's string escapes are TOML's too.
  const lines = [`[bots.${name}]`, ...Object.entries(table).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)];
  const next = `${path}.new`;
  rmSync(next, { force: true }); // left by a write that failed, maybe with another mode
  try {
    writeFileSync(next, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${lines.join("\n")}\n`, { mode: 0o600 });
    const bot = loadConfig(next).bots[name]!;
    renameSync(next, path);
    return bot;
  } catch (err) {
    rmSync(next, { force: true });
    throw err;
  }
}

/** Points each bot whose target is the slot from at to instead (rh rename): the config file is
 *  copied beside itself first, then only the name in the quotes of each such `target = "..."` line
 *  changes, comments and all else left as you wrote them. The new file takes the old one's place only
 *  once it loads with just those targets changed. null: no bot's target is from, and nothing is written. */
export function renameTarget(path: string, from: string, to: string): { bots: string[]; backup: string } | null {
  const text = readFileSync(path, "utf8");
  const was = loadConfig(path).bots;
  const bots = Object.keys(was).filter((b) => was[b]!.target === from);
  if (!bots.length) return null;
  const quoted = new RegExp(`^([ \\t]*(?:[\\w.-]+\\.)?target[ \\t]*=[ \\t]*)(["'])${from.replace(/[.-]/g, "\\$&")}\\2`, "gm");
  const next = `${path}.new`;
  rmSync(next, { force: true }); // left by a write that failed, maybe with another mode
  try {
    writeFileSync(next, text.replace(quoted, `$1$2${to}$2`), { mode: 0o600 });
    const now = loadConfig(next).bots;
    const want = (b: string) => JSON.stringify({ ...was[b], ...(bots.includes(b) && { target: to }) });
    const left = Object.keys({ ...was, ...now }).filter((b) => want(b) !== JSON.stringify(now[b]));
    if (left.length) throw new Error(`Bot ${left.join("、")} 的 target 不是单独一行 target = "${from}" 的写法，没法只改引号里的名字`);
    const backup = `${path}.${new Date().toISOString().replace(/:/g, "-")}.bak`;
    writeFileSync(backup, text, { mode: 0o600, flag: "wx" });
    renameSync(next, path);
    return { bots, backup };
  } catch (err) {
    rmSync(next, { force: true });
    throw err;
  }
}
