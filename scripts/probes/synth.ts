// Turns recordings into committable fixtures: anything that came from the recording machine or
// account becomes synthetic data, and environment lists keep only what the agents ship built in.
// Deterministic and idempotent: an id becomes one derived from a hash of it, so the same value
// gets the same synthetic one in every file, and a synthetic fixture comes back unchanged
// (test/fixture-hygiene.test.ts holds every fixture to that). Absolute times move as one: the
// earliest in a recording lands on FAKE.timeBase and the rest keep their gaps to it. in.log offsets
// move with the lines.
// Every recorder runs it as its last step. By hand: bun scripts/probes/synth.ts [fixtures-dir]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** What Claude Code, Codex and pi ship built in. Anything else in an environment list is yours. */
export const BUILTIN = {
  // Claude Code 2.1.304-2.1.310 slash commands and bundled skills, as the recordings list them;
  // every one is in the claude binary.
  claudeCommands: new Set([
    "__remote-workflow", "advisor", "agents", "auto-mode-setup", "autocompact", "batch", "claude-api", "clear", "code-review",
    "color", "compact", "config", "context", "dataviz", "debug", "design", "design-consent", "design-revoke", "design-sync",
    "doctor", "effort", "extra-usage", "fast", "fewer-permission-prompts", "focus", "goal", "heapdump", "import", "init",
    "insights", "list-agents", "loop", "mcp", "model", "output-style", "plugin-authoring", "recap", "reload-plugins",
    "reload-skills", "rename", "run", "run-skill-generator", "schedule", "security-review", "simplify", "skill-doctor",
    "team-onboarding", "ultrareview", "update-config", "usage", "usage-credits", "verify", "workflow-authoring",
    "workflow-launch-exec",
  ]),
  claudeAgents: new Set(["claude", "Explore", "general-purpose", "Plan", "statusline-setup"]),
  claudeStyles: new Set(["default", "Proactive", "Concise", "Explanatory", "Learning"]),
  claudePlugins: new Set(["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"]),
  // Codex's own apps server, and the probe's (scripts/probes/codex/mcp-server.ts).
  mcpServers: new Set(["codex_apps", "rhprobe"]),
  // Codex's system skills live here; skills from any other root are yours.
  codexSkillRoot: "/.codex/skills/.system",
};

/** Fixed stand-ins: signatures and encrypted content, and account values. */
export const FAKE = {
  signature: "c3ludGhldGljLXNpZ25hdHVyZQ==",
  encrypted: "c3ludGhldGljLWVuY3J5cHRlZC1jb250ZW50",
  email: "user@example.com",
  org: "Example Org",
  claudePlan: "Claude Pro",
  claudePlanId: "pro",
  overageReason: "overage_not_provisioned",
  codexPlan: "plus",
  credits: "1000.0000000000",
  host: "myhost",
  timezone: "Etc/GMT-9",
  // Absolute times: a recording's earliest one moves to timeBase, and all of them lie in
  // [timeBase, timeBase + timeWindow). utcOffset is the clock of `timezone`, where file names and dates are written.
  timeBase: Date.parse("2026-01-01T00:00:00.000Z"),
  timeWindow: 30 * 86_400_000,
  utcOffset: 9 * 3_600_000,
};

// ---- ids

const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
export const SYNTHETIC_UUID = /^00000000-0000-[0-9a-f]000-8000-[0-9a-f]{12}$/;
// Anthropic's (msg_01…, toolu_01…, req_011…), OpenAI's (msg_, rs_, resp_, call_ + hex), pi's
// call_00_…, Herdr's term_ and Feishu's cli_. The tail has a digit; a synthetic one is 0000 and digits.
const PREFIXED = /(?<![\w-])(msg|toolu|srvtoolu|req|rs|resp|ctc|cmp|call|term|cli)_(?=[0-9A-Za-z_]*\d)([0-9A-Za-z_]{14,})(?![\w-])/g;
export const SYNTHETIC_TAIL = /^0000\d*$/;
// ponytail: local random values stay as recorded: Claude's background task ids, Codex's process ids,
// content hashes (requestDigest and the like). None names the account; add them here if a test or
// the publish scan ever needs them synthetic.
// pi's entry ids: eight hex digits, synthetic ones 00 and six digits.
const PI_ENTRY_KEYS = new Set(["id", "parentId", "firstKeptEntryId", "leafId", "targetId", "fromId"]);
export const SYNTHETIC_PI_ENTRY = /^00\d{6}$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const digits = (s: string, n: number) => {
  let out = "";
  for (let i = 0; out.length < n; i++) out += BigInt(`0x${sha(`${i}:${s}`)}`).toString();
  return out.slice(0, n);
};
export const synthUuid = (u: string) => {
  const l = u.toLowerCase();
  return SYNTHETIC_UUID.test(l) ? l : `00000000-0000-${/[1-8]/.test(l[14]!) ? l[14] : "4"}000-8000-${sha(l).slice(0, 12)}`;
};
const synthTail = (prefix: string, tail: string) => (SYNTHETIC_TAIL.test(tail) ? tail : `0000${digits(`${prefix}_${tail}`, tail.length - 4)}`);
const synthIds = (s: string) => s.replace(UUID, synthUuid).replace(PREFIXED, (_, p: string, t: string) => `${p}_${synthTail(p, t)}`);

// ---- absolute times

// All in seconds. A time inside [LO, HI) is synthetic already and stays; the others move by one whole
// number of seconds, so every gap, fraction and field type survives.
const LO = FAKE.timeBase / 1000, HI = LO + FAKE.timeWindow / 1000, OFF = FAKE.utcOffset / 1000, DAY = 86_400;
const synthetic = (s: number) => s >= LO && s < HI;
const clock = (s: number) => new Date(s * 1000).toISOString(); // 2026-01-01T00:00:00.000Z
// ISO times as the recordings write them: 2026-03-05T14:07:09.123Z, 2026-03-09T11:20:00.416777+00:00, pi's file
// names 2026-03-05T14-07-09-123Z and, with no zone, Codex's on the local clock: rollout-2026-03-05T23-07-09-<id>.
const ISO = /(?<!\d)(\d{4}-\d\d-\d\d)T(\d\d)([:-])(\d\d)\3(\d\d)(\.\d+|-\d{3}(?=Z))?(Z|[+-]\d\d:\d\d)?/g;
const zone = (z: string) => (z === "" ? OFF : z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 3600 + +z.slice(4) * 60));
const isoAt = (date: string, h: string, mi: string, s: string, z = "") => Date.parse(`${date}T${h}:${mi}:${s}Z`) / 1000 - zone(z);
// Epoch seconds, milliseconds and microseconds, as numbers and inside text (Feishu's "create_time":"1772719629",
// and a card press's in microseconds).
const EPOCH = /(?<![\w.-])(1[5-9]\d{8}|1[5-9]\d{11}|1[5-9]\d{14})(?!\w)/g;
const PER_SECOND: Record<number, number> = { 10: 1, 13: 1000, 16: 1e6 };
// Feishu's ids (command_id) are 19 digits with their creation second in the top 32 bits.
const FEISHU_ID = /(?<![\w.-])(\d{19})(?!\w)/g;
const idSeconds = (id: string) => Number(BigInt(id) >> 32n);
const unit = (n: number) => (n >= 1.5e9 && n < 2e9 ? 1 : n >= 1.5e12 && n < 2e12 ? 1000 : n >= 1.5e15 && n < 2e15 ? 1e6 : 0); // per second
// Dates and clock times written out on the local clock (Codex's current_date, a usage limit's "try again at ...")
// or in UTC (Claude's "resets 11:20 (UTC)"). A date after "-" is a name ("oauth-2025-04-20"), not a day.
const DATE = /(?<![\w-])(\d{4})-(\d\d)-(\d\d)(?![\w-])/g;
const ROLLOUT_DIR = /(\d{4})\/(\d\d)\/(\d\d)\/rollout-(\d{4})-(\d\d)-(\d\d)T/g;
const RESETS = /\bresets (\d{1,2}):(\d\d) \(UTC\)/g;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const US_TIME = new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2})(?:st|nd|rd|th), (\\d{4}) (\\d{1,2}):(\\d\\d) (AM|PM)\\b`, "g");

/** How the times in `values` move: by the gap from their earliest real one to the base, none if all are synthetic. */
function timeShift(values: unknown[]) {
  let first = Infinity;
  const seen = (s: number) => {
    if (!synthetic(Math.floor(s)) && s < first) first = Math.floor(s);
  };
  const found = (s: string) => {
    for (const m of s.matchAll(ISO)) seen(isoAt(m[1]!, m[2]!, m[4]!, m[5]!, m[7]));
    for (const m of s.matchAll(EPOCH)) seen(+m[1]! / PER_SECOND[m[1]!.length]!);
    for (const m of s.matchAll(FEISHU_ID)) if (unit(idSeconds(m[1]!)) === 1) seen(idSeconds(m[1]!));
  };
  const visit = (v: unknown) => {
    if (typeof v === "string") found(v);
    else if (typeof v === "number") unit(v) && seen(v / unit(v));
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  values.forEach(visit);
  const delta = first === Infinity ? 0 : LO - first;
  const days = Math.floor((LO + OFF) / DAY) - Math.floor((first + OFF) / DAY); // whole days between the local dates
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const str = (s: string) => delta === 0 ? s : s
    .replace(ISO, (all, date, h, sep, mi, sec, frac = "", z = "") => {
      const at = isoAt(date, h, mi, sec, z);
      if (synthetic(at)) return all;
      const t = clock(at + delta + zone(z));
      return `${t.slice(0, 10)}T${[t.slice(11, 13), t.slice(14, 16), t.slice(17, 19)].join(sep)}${frac}${z}`;
    })
    .replace(EPOCH, (all, n: string) => {
      const per = PER_SECOND[n.length]!;
      return synthetic(+n / per) ? all : String(+n + delta * per);
    })
    .replace(FEISHU_ID, (all, id: string) => (unit(idSeconds(id)) !== 1 || synthetic(idSeconds(id)) ? all : String(BigInt(id) + (BigInt(delta) << 32n))))
    .replace(DATE, (_, y, mo, d) => clock(Date.UTC(+y, +mo - 1, +d) / 1000 + days * DAY).slice(0, 10))
    .replace(ROLLOUT_DIR, (_, _y, _m, _d, y, m, d) => `${y}/${m}/${d}/rollout-${y}-${m}-${d}T`) // the directory is the file's own date
    .replace(RESETS, (_, h: string, mi: string) => {
      const t = (((+h * 3600 + +mi * 60 + delta) % DAY) + DAY) % DAY;
      return `resets ${pad(Math.floor(t / 3600), h.length)}:${pad(Math.floor((t % 3600) / 60))} (UTC)`;
    })
    .replace(US_TIME, (_, mon, d, y, h, mi, ap) => {
      const local = Date.UTC(+y, MONTHS.indexOf(mon), +d, (+h % 12) + (ap === "PM" ? 12 : 0), +mi) / 1000 + delta;
      const t = clock(local), day = +t.slice(8, 10), hour = +t.slice(11, 13);
      const ord = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
      return `${MONTHS[+t.slice(5, 7) - 1]} ${day}${ord}, ${t.slice(0, 4)} ${hour % 12 || 12}:${t.slice(14, 16)} ${hour < 12 ? "AM" : "PM"}`;
    });
  const num = (n: number) => {
    const u = delta && unit(n);
    return u && !synthetic(n / u) ? n + delta * u : n;
  };
  return { str, num };
}

// ---- paths, emails and other values from your machine

export const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
const PROBE_DIR = /rh-probe-[A-Za-z0-9]{6}/g; // mkdtemp suffix of the Claude probe's work dir
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const machine = (home: string) => (s: string) => {
  if (home !== "/home/user") s = s.replaceAll(home, "/home/user").replaceAll(`${home.replace(/\//g, "-")}-`, "-home-user-");
  return s
    .replace(/\/home\/(?!user(?![\w.-]))[\w.-]+/g, "/home/user")
    .replace(/-home-(?!user-)[\w.]+-/g, "-home-user-")
    .replace(PROBE_DIR, "rh-probe")
    // The pi probe ran in a Claude session's scratchpad.
    .replace(/\/tmp\/claude-\d+\/[^/"\s]+\/[0-9a-f-]{36}\/scratchpad\//g, "/tmp/scratchpad/")
    .replace(/\/run\/user\/\d+\/rhodium-dev\//g, "/run/user/1000/rhodium/")
    // Claude's socket for each process is named by its pid; a synthetic one starts with 0, as no pid does.
    .replace(/(\/cc-socks\/)(\d+)(\.sock)/g, (_, a: string, pid: string, b: string) => `${a}${pid.startsWith("0") ? pid : `0${digits(pid, pid.length - 1)}`}${b}`)
    .replace(EMAIL, (e) => (/@example\.com$/i.test(e) ? e : FAKE.email))
    // Your timezone in the text Codex shows the model, as in the JSON field.
    .replace(/<timezone>[^<]*<\/timezone>/g, `<timezone>${FAKE.timezone}</timezone>`)
    // A file you sent: its name says what you were working on; its extension is all a test needs.
    .replace(/("file_name":")(?:[^"\\]|\\.)*?(\.[A-Za-z0-9]{1,5})?"/g, (_, key: string, ext = "") => `${key}file${ext}"`)
    .replace(JWT, "redacted-jwt");
};

// ---- environment lists

type Names = { skills: string[]; plugins: string[]; servers: string[] };
const PLACEHOLDER = /^(skill|plugin|mcp)-\d+$/;
// Public marketplaces: their names stay readable. Codex's curated ones come with your ChatGPT login.
const PUBLIC_MARKETPLACE = new Set(["claude-plugins-official", "builtin", "openai-curated", "openai-curated-remote"]);
const mcpServer = (tool: string) => /^mcp__(.+?)__/.exec(tool)?.[1];
const keepServer = (name?: string) => !!name && BUILTIN.mcpServers.has(name);
const keepTool = (t: string) => !t.startsWith("mcp__") || keepServer(mcpServer(t));
const keepCommand = (n: string) => BUILTIN.claudeCommands.has(n);
const keepAgent = (n: string) => BUILTIN.claudeAgents.has(n);
const codexRootKept = (path: string) => path.endsWith(BUILTIN.codexSkillRoot) || path.includes(`${BUILTIN.codexSkillRoot}/`);
// Codex's skill list: "- `r1` = `<dir>`" roots, then "- <name>: <what it does> (file: r1/<name>/SKILL.md)".
const CODEX_ROOT = /^- `(r\d+)` = `([^`]+)`$/;
const CODEX_SKILL = /^- (\S+?): .*\(file: ([^)]+)\)\s*$/;
const CODEX_LIST = "### Available skills";

/** Your skill, plugin and MCP server names, from every list the recording has of them. */
export function collect(values: unknown[], extra: string[]): Names {
  const n: Names = { skills: [], plugins: [], servers: [] };
  const add = (list: string[], v?: unknown) => {
    if (typeof v === "string" && v && !PLACEHOLDER.test(v) && !list.includes(v)) list.push(v);
  };
  // A Claude command "<plugin>:<skill>" names its plugin; Codex's list names plugins by their roots.
  const skill = (name: string, namespaced = true) => {
    if (keepCommand(name) || keepAgent(name)) return;
    add(n.skills, name);
    if (namespaced && name.includes(":")) add(n.plugins, name.split(":")[0]);
  };
  const plugin = (name?: string, source?: string) => {
    if (!name || BUILTIN.claudePlugins.has(name)) return;
    add(n.plugins, name);
    const market = String(source ?? "").split("@")[1];
    if (market && !PUBLIC_MARKETPLACE.has(market)) add(n.plugins, market);
  };
  const server = (name?: string) => !keepServer(name) && add(n.servers, name);
  const text = (s: string) => {
    if (!s.includes(CODEX_LIST)) return;
    const roots = new Map<string, string>();
    for (const line of s.split("\n")) {
      const root = CODEX_ROOT.exec(line);
      if (root) {
        roots.set(root[1]!, root[2]!);
        const p = /\/plugins\/cache\/([^/]+)\/([^/]+)\//.exec(root[2]!);
        if (p && !PUBLIC_MARKETPLACE.has(p[1]!)) plugin(p[2], `x@${p[1]}`);
      }
      const entry = CODEX_SKILL.exec(line);
      if (entry && !codexRootKept(roots.get(entry[2]!.split("/")[0]!) ?? entry[2]!)) skill(entry[1]!, false);
    }
  };
  const visit = (v: any) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    for (const c of Array.isArray(v.commands) ? v.commands : []) if (typeof c?.name === "string" && "argumentHint" in c) skill(c.name);
    for (const s of v.skills?.skillFrontmatter ?? []) { skill(s.name); if (s.pluginName) plugin(s.pluginName, s.pluginId); }
    if (v.type === "system" && v.subtype === "init") {
      for (const c of [...(v.slash_commands ?? []), ...(v.skills ?? []), ...(v.agents ?? [])]) skill(c);
      for (const p of v.plugins ?? []) if (p.path !== "builtin") plugin(p.name, p.source);
      for (const m of v.mcp_servers ?? []) server(m.name);
      for (const t of v.tools ?? []) server(mcpServer(t));
    }
    if (Array.isArray(v.agents)) for (const a of v.agents) if (typeof a?.name === "string") skill(a.name);
    const a = v.type === "attachment" ? v.attachment : undefined;
    if (a?.type === "skill_listing") for (const s of a.names ?? []) skill(s);
    if (a?.type === "agent_listing_delta") for (const s of a.addedTypes ?? []) skill(s);
    if (a?.type === "deferred_tools_delta") {
      for (const t of a.addedNames ?? []) server(mcpServer(t));
      for (const s of [...(a.pendingMcpServers ?? []), ...(a.needsAuthMcpServers ?? [])]) server(s);
      for (const f of a.failedMcpServers ?? []) server(f?.name);
    }
    if (a?.type === "mcp_instructions_delta") (a.addedNames ?? []).forEach(server);
    Object.values(v).forEach(visit);
  };
  values.forEach(visit);
  for (const s of extra) skill(s);
  return n;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name counts only as a whole word; letters, digits and "-" around it make it part of another word.
const word = (name: string, flags = "g") => new RegExp(`(?<![A-Za-z0-9-])${esc(name)}(?![A-Za-z0-9-])`, flags);
// A plain word ("docs", "research") is only swapped as a whole value; inside text it would hit prose, URLs and file names.
const distinctive = (name: string) => /[-:]/.test(name);
const mcpPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;

/** The string cleaner for one recording: ids, machine values, then your names as placeholders. */
function cleaner(n: Names, text: string, home: string, values: unknown[]) {
  const time = timeShift(values);
  // Placeholders take numbers the recording does not use yet, so a synthetic one keeps its own.
  const used = { skill: new Set<number>(), plugin: new Set<number>(), mcp: new Set<number>() };
  for (const m of text.matchAll(/\b(skill|plugin|mcp)-(\d+)\b/g)) used[m[1] as keyof typeof used].add(Number(m[2]));
  const next = (kind: keyof typeof used) => {
    let i = 1;
    while (used[kind].has(i)) i++;
    used[kind].add(i);
    return `${kind}-${i}`;
  };
  // [name, placeholder, regex for it inside text or null]. Plugin and server names always get one:
  // they sit in paths and ids, and plugins show up in prose in any case ("Tidy mode" for plugin "tidy").
  type Name = [string, string, RegExp | null];
  const servers = n.servers.map((s): Name => [s, next("mcp"), word(s)]);
  const names: Name[] = [
    ...servers,
    ...n.skills.map((s): Name => [s, next("skill"), distinctive(s) ? word(s) : null]),
    ...n.plugins.map((s): Name => [s, next("plugin"), word(s, "gi")]),
  ].sort((a, b) => b[0].length - a[0].length);
  const tools = new Map<string, number>();
  const local = machine(home);
  const key = (k: string) => local(synthIds(k));
  const clean = (s: string): string => {
    s = time.str(local(synthIds(s)));
    for (const [srv, to] of servers) {
      const pre = mcpPrefix(srv);
      if (s.startsWith(pre)) {
        const t = s.slice(pre.length);
        if (!tools.has(t)) tools.set(t, tools.size + 1);
        s = `mcp__${to}__tool-${tools.get(t)}`;
      }
    }
    for (const [from, to, re] of names) s = s === from ? to : re ? s.replace(re, to) : s;
    return s;
  };
  return { clean, key, num: time.num };
}
type Cleaner = ReturnType<typeof cleaner>;

/** Keeps the built-in entries of a list, and the items of any parallel lists at the same places. */
function keep(o: any, key: string, test: (v: any) => boolean, ...parallel: string[]) {
  if (!Array.isArray(o?.[key])) return;
  const at = o[key].map(test);
  for (const k of [key, ...parallel]) if (Array.isArray(o[k])) o[k] = o[k].filter((_: unknown, i: number) => at[i]);
}

/** Environment lists cut to what is built in, and account and machine values made synthetic. */
function structural(v: any, family: string) {
  if (Array.isArray(v)) return v.forEach((x) => structural(x, family));
  if (!v || typeof v !== "object") return;
  // Claude
  if (typeof v.account === "object" && v.account && "organization" in v.account) Object.assign(v.account, { email: FAKE.email, organization: FAKE.org, subscriptionType: FAKE.claudePlan });
  if (Array.isArray(v.commands) && v.commands.some((c: any) => c && "argumentHint" in c)) keep(v, "commands", (c) => keepCommand(c?.name));
  if (Array.isArray(v.agents) && v.agents.some((a: any) => typeof a?.name === "string")) keep(v, "agents", (a) => keepAgent(a?.name));
  if (Array.isArray(v.agents) && v.agents.some((a: any) => typeof a?.agentType === "string")) keep(v, "agents", (a) => keepAgent(a?.agentType));
  keep(v, "available_output_styles", (s) => BUILTIN.claudeStyles.has(s));
  if (v.effective && Array.isArray(v.sources)) Object.assign(v, { effective: {}, sources: [] }); // get_settings: only `applied` is kept
  if (typeof v.subscription_type === "string") v.subscription_type = FAKE.claudePlanId;
  if (typeof v.overageDisabledReason === "string") v.overageDisabledReason = FAKE.overageReason;
  if (v.skills?.skillFrontmatter) {
    keep(v.skills, "skillFrontmatter", (s) => keepCommand(s?.name) && s.source !== "plugin");
    Object.assign(v.skills, { totalSkills: v.skills.skillFrontmatter.length, includedSkills: v.skills.skillFrontmatter.length });
  }
  keep(v, "mcpTools", (t) => keepServer(t?.serverName ?? mcpServer(String(t?.name))));
  if (v.type === "system" && v.subtype === "init") {
    keep(v, "tools", keepTool);
    keep(v, "mcp_servers", (m) => keepServer(m?.name));
    for (const k of ["slash_commands", "skills", "terminal_slash_commands"]) keep(v, k, keepCommand);
    keep(v, "agents", keepAgent);
    keep(v, "plugins", (p) => p?.path === "builtin");
    if (v.output_style && !BUILTIN.claudeStyles.has(v.output_style)) v.output_style = "default";
  }
  if (v.type === "system" && v.subtype === "hook_response") for (const k of ["output", "stdout"]) if (v[k]) v[k] = "Placeholder hook output.";
  const a = v.type === "attachment" ? v.attachment : undefined;
  if (a?.type === "skill_listing") {
    keep(a, "names", keepCommand, "digests");
    Object.assign(a, { skillCount: a.names?.length ?? 0, content: "[redacted]" });
  }
  if (a?.type === "agent_listing_delta") keep(a, "addedTypes", keepAgent, "addedLines");
  if (a?.type === "deferred_tools_delta") {
    keep(a, "addedNames", keepTool, "addedLines");
    keep(a, "surfacedNames", keepTool);
    keep(a, "surfacedDefinitions", (d) => keepTool(String(d?.name)));
    for (const k of ["pendingMcpServers", "needsAuthMcpServers"]) keep(a, k, keepServer);
    keep(a, "failedMcpServers", (f) => keepServer(f?.name));
  }
  if (a?.type === "mcp_instructions_delta") keep(a, "addedNames", keepServer, "addedBlocks");
  if (a?.type === "hook_success") Object.assign(a, { content: "[redacted]", stdout: "[redacted]", command: "Placeholder hook command." });
  if (a?.type === "instructions") for (const f of a.files ?? []) Object.assign(f, { path: "[redacted]", content: "[redacted]" });
  if (v.type === "redacted_thinking" && typeof v.data === "string") v.data = FAKE.encrypted;
  // Tool definitions sent to the model (Claude's api-request lines): your MCP servers' go.
  for (const [k, x] of Object.entries(v)) {
    if (!Array.isArray(x)) continue;
    const name = (i: any) => i?.tool?.definition?.name ?? i?.definition?.name ?? (k === "tools" ? i?.name : undefined);
    if (x.some((i) => typeof name(i) === "string" && !keepTool(name(i)))) v[k] = x.filter((i) => typeof name(i) !== "string" || keepTool(name(i)));
  }
  // Codex
  if (v.method === "remoteControl/status/changed" && v.params?.serverName) v.params.serverName = FAKE.host;
  for (const k of ["planType", "plan_type"]) if (typeof v[k] === "string") v[k] = FAKE.codexPlan;
  if (v.credits && typeof v.credits.balance === "string") v.credits.balance = FAKE.credits;
  if (typeof v.timezone === "string") v.timezone = FAKE.timezone;
  // Feishu: the probe's lag for a card press took milliseconds from microseconds, so it carried the press's real time.
  // The real gap can't be had back from it, and no test reads it: it goes.
  if (family === "feishu" && v.ev === "press" && typeof v.lag === "number" && Math.abs(v.lag) >= 1e9) delete v.lag;
  // pi
  if (family === "pi") for (const k of PI_ENTRY_KEYS) if (typeof v[k] === "string" && /^[0-9a-f]{8}$/.test(v[k]) && !SYNTHETIC_PI_ENTRY.test(v[k])) v[k] = `00${digits(v[k], 6)}`;
  Object.values(v).forEach((x) => structural(x, family));
}

/** Codex's skill list without your skills and their roots. */
function codexSkills(s: string): string {
  if (!s.includes(CODEX_LIST)) return s;
  const roots = new Map<string, string>();
  return s.split("\n").filter((line) => {
    const root = CODEX_ROOT.exec(line);
    if (root) return roots.set(root[1]!, root[2]!) && codexRootKept(root[2]!);
    const entry = CODEX_SKILL.exec(line);
    return !entry || codexRootKept(roots.get(entry[2]!.split("/")[0]!) ?? entry[2]!);
  }).join("\n");
}

const OPAQUE: Record<string, string> = { signature: FAKE.signature, encrypted_content: FAKE.encrypted };

function walker(c: Cleaner) {
  const walk = (v: any, key = ""): any => {
    if (typeof v === "string") return key in OPAQUE && v ? OPAQUE[key] : c.clean(codexSkills(v));
    if (typeof v === "number") return c.num(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [c.key(k), walk(x, k)]));
    return v;
  };
  return walk;
}

const parse = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export type Rec = { inLog: string; outLog: string };
export type Options = { home?: string; names?: string[] };

/** One recording (meta, in.log, out.log) of `agent`, synthetic; `leaks` lists your names still in it. */
export function synthRecording(rec: Rec, agent: string, opts: Options = {}): Rec & { leaks: string[] } {
  const raws = rec.outLog.split("\n");
  const objs = raws.map(parse);
  const ins = rec.inLog.split("\n").map((l) => parse(l.slice(l.indexOf(" ") + 1)));
  const home = opts.home ?? homedir();
  const n = collect([...objs, ...ins], opts.names ?? []);
  const c = cleaner(n, rec.outLog + rec.inLog, home, [...objs, ...ins]);
  const walk = walker(c);
  const line = (raw: string, o: any) => {
    if (o === undefined || typeof o !== "object") return raw;
    const before = JSON.stringify(o);
    const copy = structuredClone(o);
    structural(copy, agent);
    const after = JSON.stringify(walk(copy));
    return after === before ? raw : after;
  };
  const outNew = raws.map((raw, i) => (isDelta(objs[i]) ? raw : line(raw, objs[i])));
  resplitDeltas(objs, outNew, c);
  const res = rewriteOut(rec, (raw, i) => [outNew[i] ?? raw], (raw) => line(raw, parse(raw)));
  return { ...res, leaks: leaks(res.outLog + "\n" + res.inLog, n, home) };
}

/** Your names and home still in the text: stricter than the swap, any trace of a plugin counts. */
function leaks(text: string, n: Names, home: string): string[] {
  const found: string[] = [];
  if (home !== "/home/user" && text.includes(home)) found.push(home);
  const lower = text.toLowerCase();
  for (const s of n.plugins) if (lower.includes(s.toLowerCase())) found.push(s);
  for (const s of n.servers) if (word(s).test(text)) found.push(s);
  for (const s of n.skills) if (distinctive(s) ? word(s).test(text) : text.includes(JSON.stringify(s))) found.push(s);
  return [...new Set(found)];
}

/** One JSON-lines file of `family` (a transcript, or Herdr's or Feishu's recorded traffic), synthetic. */
export function synthLines(text: string, family: string, opts: Options = {}): string {
  const lines = text.split("\n");
  const objs = lines.map(parse);
  const walk = walker(cleaner(collect(objs, opts.names ?? []), text, opts.home ?? homedir(), objs));
  return lines.map((raw, i) => {
    const o = objs[i];
    if (o === undefined || typeof o !== "object") return raw;
    const before = JSON.stringify(o);
    const copy = structuredClone(o);
    structural(copy, family);
    const after = JSON.stringify(walk(copy));
    return after === before ? raw : after;
  }).join("\n");
}

/** A file's name with its ids synthetic and its start time moved as the times inside the file (`text`) move. */
export function synthName(name: string, text: string): string {
  return timeShift(text.split("\n").map(parse)).str(synthIds(name));
}

/**
 * Replace each out.log line with zero or more lines and move every in.log
 * offset so it still points at the same place in the conversation.
 */
export function rewriteOut(rec: Rec, mapOut: (raw: string, i: number) => string[], mapIn: (raw: string) => string = (r) => r): Rec {
  const enc = (s: string) => Buffer.byteLength(s);
  const raws = rec.outLog.split("\n"); // a trailing newline leaves a final "" that maps to itself
  let os = 0, ns = 0;
  const spans = raws.map((raw, i) => {
    const lines = i === raws.length - 1 && raw === "" ? [""] : mapOut(raw, i);
    const bytes = lines.reduce((a, l) => a + enc(l) + 1, 0);
    const span = { lines, old: os, neu: ns, bytes };
    os += enc(raw) + 1; ns += bytes;
    return span;
  });
  const mapOffset = (o: number) => {
    const s = spans.findLast((s) => s.old <= o) ?? spans[0]!;
    return s.neu + Math.min(o - s.old, s.bytes);
  };
  const inLog = rec.inLog.split("\n").map((line) => {
    if (!line) return line;
    const sp = line.indexOf(" ");
    return `${mapOffset(Number(line.slice(0, sp)))} ${mapIn(line.slice(sp + 1))}`;
  }).join("\n");
  return { outLog: spans.flatMap((s) => s.lines).join("\n"), inLog };
}

const isDelta = (o: any) => o?.type === "stream_event" && o.event?.type === "content_block_delta";
const DELTA_FIELDS = ["text", "partial_json", "thinking"];

/** Join each content block's deltas, clean the joined text, and hand it back out in the same number of pieces. */
function resplitDeltas(objs: any[], outNew: string[], c: Cleaner) {
  const walk = walker(c);
  const groups = new Map<string, number[]>();
  let msg = "";
  objs.forEach((o, i) => {
    if (o?.type === "stream_event" && o.event?.type === "message_start") msg = o.event.message?.id ?? String(i);
    if (!isDelta(o)) return;
    const field = DELTA_FIELDS.find((f) => typeof o.event.delta?.[f] === "string");
    if (!field) {
      // signature deltas and the like: no text to join
      const after = JSON.stringify(walk(o));
      if (after !== JSON.stringify(o)) outNew[i] = after;
      return;
    }
    const key = `${o.parent_tool_use_id ?? ""}|${msg}|${o.event.index}|${field}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const [key, idx] of groups) {
    const field = key.split("|").pop()!;
    const parts = idx.map((i) => objs[i].event.delta[field] as string);
    const joined = parts.join(""), cleaned = c.clean(joined);
    let pos = 0, acc = 0;
    const sep = /[\s"'`,;()[\]{}]/;
    idx.forEach((i, n) => {
      acc += parts[n]!.length;
      let end = n === idx.length - 1 ? cleaned.length : Math.max(pos, Math.round((acc / joined.length) * cleaned.length));
      // Never cut inside a word or path, so no piece shows half a placeholder.
      while (end > pos && end < cleaned.length && !sep.test(cleaned.charAt(end - 1)) && !sep.test(cleaned.charAt(end))) end++;
      const o = structuredClone(objs[i]);
      if (cleaned !== joined) o.event.delta[field] = cleaned.slice(pos, end);
      pos = end;
      // the rest of the line (session and message ids) is cleaned as any other
      const done = walk({ ...o, event: { ...o.event, delta: { ...o.event.delta, [field]: "" } } });
      done.event.delta[field] = o.event.delta[field];
      const text = JSON.stringify(done);
      if (text !== JSON.stringify(objs[i])) outNew[i] = text;
    });
  }
}

/** Names that can show up in output but are not in the recording's own lists: your skills and agents. */
export function localNames(home = homedir()): string[] {
  const out: string[] = [];
  const ls = (d: string) => (existsSync(d) ? readdirSync(d) : []);
  for (const d of ls(join(home, ".claude/skills"))) if (d !== "synced") out.push(d);
  for (const f of ls(join(home, ".claude/agents"))) out.push(basename(f, ".md"));
  return out;
}

const FAMILIES = ["claude", "codex", "pi", "herdr", "feishu"];

/** Every fixture under root made synthetic in place, files named by an id renamed. Returns the files it changed. */
export function synthFixtures(root: string, opts: Options = {}): string[] {
  const changed: string[] = [];
  const write = (file: string, before: string, after: string) => {
    if (after !== before) (writeFileSync(file, after), changed.push(file));
  };
  const visit = (dir: string, family?: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const fam = FAMILIES.includes(name) ? name : family;
      if (statSync(path).isDirectory()) {
        if (existsSync(join(path, "meta")) && existsSync(join(path, "out.log"))) {
          const agent = JSON.parse(readFileSync(join(path, "meta"), "utf8")).agent;
          const rec = { inLog: readFileSync(join(path, "in.log"), "utf8"), outLog: readFileSync(join(path, "out.log"), "utf8") };
          const res = synthRecording(rec, agent, opts);
          write(join(path, "out.log"), rec.outLog, res.outLog);
          write(join(path, "in.log"), rec.inLog, res.inLog);
        } else visit(path, fam);
        continue;
      }
      if (!name.endsWith(".jsonl") || !fam) continue;
      const text = readFileSync(path, "utf8");
      write(path, text, synthLines(text, fam, opts));
      const renamed = synthName(name, text);
      if (renamed !== name) (renameSync(path, join(dir, renamed)), changed.push(join(dir, renamed)));
    }
  };
  visit(root);
  return changed;
}

/** A single recording directory or JSON-lines file, as a recorder writes it. */
export function synthPath(path: string, family: string, opts: Options = {}): string {
  if (statSync(path).isDirectory()) {
    const read = (f: string) => readFileSync(join(path, f), "utf8");
    const res = synthRecording({ inLog: read("in.log"), outLog: read("out.log") }, family, opts);
    writeFileSync(join(path, "out.log"), res.outLog);
    writeFileSync(join(path, "in.log"), res.inLog);
    return path;
  }
  const text = readFileSync(path, "utf8");
  writeFileSync(path, synthLines(text, family, opts));
  const renamed = join(dirname(path), synthName(basename(path), text));
  if (renamed !== path) renameSync(path, renamed);
  return renamed;
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dir, "../../test/fixtures");
  const changed = synthFixtures(root, { names: localNames() });
  console.log(changed.length ? changed.join("\n") : "no change");
}
