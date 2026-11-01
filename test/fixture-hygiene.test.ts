// Every fixture is synthetic (scripts/probes/synth.ts): its ids are of the synthetic forms, its
// environment lists hold only what Claude Code, Codex and pi ship built in, every absolute time lies
// in the synthetic window, and nothing names your home, email or account. A recording committed
// without the synthesis step fails here.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN, EMAIL, FAKE, SYNTHETIC_PI_ENTRY, SYNTHETIC_TAIL, SYNTHETIC_UUID, synthFixtures } from "../scripts/probes/synth";

const ROOT = join(import.meta.dir, "fixtures");
const files = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(ROOT, f)).isFile()).sort();
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const values = (text: string) => text.split("\n").flatMap((l) => {
  try {
    return [JSON.parse(l.replace(/^\d+ /, ""))];
  } catch {
    return [];
  }
});

/** Every name an environment list in v holds, with what it is. */
function listed(v: any, out: [string, string][] = []): [string, string][] {
  if (Array.isArray(v)) v.forEach((x) => listed(x, out));
  if (!v || typeof v !== "object") return out;
  const add = (kind: string, xs: unknown) => Array.isArray(xs) && xs.forEach((x) => out.push([kind, typeof x === "string" ? x : String((x as any)?.name ?? (x as any)?.agentType)]));
  if (v.type === "system" && v.subtype === "init") {
    for (const k of ["slash_commands", "skills", "terminal_slash_commands"]) add("command", v[k]);
    add("agent", v.agents);
    add("mcp", v.mcp_servers);
    add("plugin", (v.plugins ?? []).filter((p: any) => p.path !== "builtin"));
  }
  if (Array.isArray(v.commands) && v.commands.some((c: any) => c && "argumentHint" in c)) add("command", v.commands);
  if (Array.isArray(v.agents) && v.agents.some((a: any) => a?.name || a?.agentType)) add("agent", v.agents);
  add("command", v.skills?.skillFrontmatter);
  const a = v.type === "attachment" ? v.attachment : undefined;
  if (a?.type === "skill_listing") add("command", a.names);
  if (a?.type === "agent_listing_delta") add("agent", a.addedTypes);
  for (const k of ["pendingMcpServers", "needsAuthMcpServers", "failedMcpServers"]) add("mcp", a?.[k]);
  if (a?.type === "mcp_instructions_delta") add("mcp", a.addedNames);
  Object.values(v).forEach((x) => listed(x, out));
  return out;
}
const builtin: Record<string, Set<string>> = { command: BUILTIN.claudeCommands, agent: BUILTIN.claudeAgents, mcp: BUILTIN.mcpServers, plugin: new Set() };

/** What each file breaks a rule with, as "file: value". */
const offending = (find: (text: string, file: string) => unknown[]) => files.flatMap((f) => find(read(f), f).map((v) => `${f}: ${v}`));
const all = (text: string, re: RegExp, group = 0) => [...text.matchAll(re)].map((m) => m[group]!);

test("ids are synthetic", () => {
  const uuid = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
  expect(offending((t, f) => all(f + t, uuid).filter((u) => !SYNTHETIC_UUID.test(u)))).toEqual([]);
  const prefixed = /(?<![\w-])(?:msg|toolu|srvtoolu|req|rs|resp|ctc|cmp|call|term|cli)_(?=[0-9A-Za-z_]*\d)([0-9A-Za-z_]{14,})(?![\w-])/g;
  expect(offending((t) => [...t.matchAll(prefixed)].filter((m) => !SYNTHETIC_TAIL.test(m[1]!)).map((m) => m[0]))).toEqual([]);
  const entry = /"(?:id|parentId|firstKeptEntryId|leafId|targetId|fromId)":"([0-9a-f]{8})"/g;
  expect(offending((t, f) => (/^(transcripts\/)?pi\//.test(f) ? all(t, entry, 1).filter((e) => !SYNTHETIC_PI_ENTRY.test(e)) : []))).toEqual([]);
  const opaque = /"(?:signature|encrypted_content)":"([^"]*)"/g;
  expect(offending((t) => all(t, opaque, 1).filter((v) => ![FAKE.signature, FAKE.encrypted, ""].includes(v)))).toEqual([]);
});

test("times are synthetic: every absolute time lies in the synthetic window", () => {
  const lo = FAKE.timeBase, hi = lo + FAKE.timeWindow, off = FAKE.utcOffset, day = 86_400_000;
  const inside = (ms: number) => ms >= lo && ms < hi;
  // A date has no time of day: it is in when the local day is one the window touches.
  const dayInside = (ms: number) => ms >= Math.floor((lo + off) / day) * day && ms <= Math.floor((hi + off) / day) * day;
  // ISO times in any zone, also as file names write them (2026-03-05T14-07-09-123Z); no zone is the local clock.
  const iso = /(\d{4})-(\d\d)-(\d\d)T(\d\d)[:-](\d\d)[:-](\d\d)(?:[.-]\d+)?(Z|[+-]\d\d:\d\d)?/g;
  const at = (m: RegExpMatchArray) => {
    const z = m[7] ?? "";
    const zone = z === "" ? off : z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 3_600_000 + +z.slice(4) * 60_000);
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - zone;
  };
  expect(offending((t, f) => [...(f + "\n" + t).matchAll(iso)].filter((m) => !inside(at(m))).map((m) => m[0]))).toEqual([]);
  // epoch seconds, milliseconds or microseconds, bare or in text
  const epoch = /(?<![\w.-])(1\d{9}|1\d{12}|1\d{15})(?!\w)/g;
  expect(offending((t, f) => all(f + "\n" + t, epoch, 1).filter((n) => !inside(n.length === 10 ? +n * 1000 : n.length === 16 ? +n / 1000 : +n)))).toEqual([]);
  // Feishu's 19-digit ids hold their creation second in the top 32 bits
  expect(offending((t) => all(t, /(?<![\w.-])\d{19}(?!\w)/g).filter((id) => !inside(Number(BigInt(id) >> 32n) * 1000)))).toEqual([]);
  // dates: "2026-03-05", and the directories Codex files rollouts in, "2026/03/05"; "oauth-2025-04-20" is a name
  const date = /(?<![\w-])(\d{4})[-/](\d\d)[-/](\d\d)(?![\w-])/g;
  expect(offending((t, f) => [...(f + "\n" + t).matchAll(date)].filter((m) => !dayInside(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))).map((m) => m[0]))).toEqual([]);
  // times in prose: the two forms synth.ts moves ("resets 02:41 (UTC)", "Jan 7th, 2026 7:11 AM"), and no other clock time after "resets" or "try again at"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const usTime = new RegExp(`\\b(${months.join("|")}) (\\d{1,2})(?:st|nd|rd|th), (\\d{4}) \\d{1,2}:\\d\\d (?:AM|PM)\\b`, "g");
  expect(offending((t) => [...t.matchAll(usTime)].filter((m) => !dayInside(Date.UTC(+m[3]!, months.indexOf(m[1]!), +m[2]!))).map((m) => m[0]))).toEqual([]);
  const moved = new RegExp(`${usTime.source}|\\bresets \\d{1,2}:\\d\\d \\(UTC\\)`, "g");
  expect(offending((t) => all(t.replace(moved, ""), /\b(?:resets|again at)\b[^"\\]{0,30}\d{1,2}:\d\d/gi))).toEqual([]);
});

test("environment lists hold only what the agents ship built in", () => {
  expect(offending((t) => values(t).flatMap((v) => listed(v)).filter(([kind, name]) => !builtin[kind]!.has(name)))).toEqual([]);
  // tool names, as values: built-in text shows `mcp__server__tool` as an example
  expect(offending((t) => all(t, /"mcp__([A-Za-z0-9_-]+?)__/g, 1).filter((s) => !BUILTIN.mcpServers.has(s)))).toEqual([]);
  expect(offending((t) => all(t, /- `r\d+` = `([^`]+)`/g, 1).filter((root) => !root.endsWith(BUILTIN.codexSkillRoot)))).toEqual([]);
});

test("nothing names your home, email or account", () => {
  expect(offending((t) => all(t, /\/home\/(?!user(?![\w.-]))[\w.-]+/g))).toEqual([]);
  expect(offending((t) => all(t, /-home-(?!user-)[\w.]+-/g))).toEqual([]);
  expect(offending((t) => all(t, EMAIL).filter((e) => !/@example\.com$/i.test(e)))).toEqual([]);
  expect(offending((t) => all(t, /rh-probe-[A-Za-z0-9]{6}/g))).toEqual([]);
  // the pid in a Claude socket's name: a synthetic one starts with 0
  expect(offending((t) => all(t, /\/cc-socks\/([1-9]\d*)\.sock/g, 1))).toEqual([]);
  const tokens = /sk-ant-[\w-]{10,}|\bgh[pousr]_\w{20,}|\b\d{8,10}:AA[\w-]{30,}|\beyJ[\w-]{10,}\.[\w-]{10,}|Bearer\s+[\w.-]{20,}/gi;
  expect(offending((t) => all(t, tokens))).toEqual([]);
  // A placeholder in a fixture means a private name was retold in prose, as a summary does: drop
  // that line from the recording (make-fixtures.ts edits), don't keep it as a placeholder.
  expect(offending((t) => all(t, /(?<![A-Za-z0-9])(?:skill|plugin|mcp)-\d+(?!\d)/g))).toEqual([]);
});

const copy = mkdtempSync(join(tmpdir(), "rhodium-test-fixture-hygiene-"));
afterAll(() => rmSync(copy, { recursive: true, force: true }));

test("synthesizing the fixtures again changes nothing", () => {
  cpSync(ROOT, copy, { recursive: true });
  expect(synthFixtures(copy, { home: "/home/user" })).toEqual([]);
});

test("the tests' own fakes build Feishu ids on the synthetic base, not on an id from a recording", () => {
  // A Feishu id's top 32 bits are its creation second, so an id copied from a recording carries its real time.
  const lo = FAKE.timeBase / 1000, hi = lo + FAKE.timeWindow / 1000;
  const here = join(import.meta.dir);
  const code = (readdirSync(here, { recursive: true, encoding: "utf8" }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.startsWith("fixtures/"));
  const ids = code.flatMap((f) => [...readFileSync(join(here, f), "utf8").matchAll(/(?<![\d.])(\d{19})n?(?!\d)/g)].map((m) => [f, m[1]!] as const));
  const real = ids.filter(([, id]) => {
    const s = Number(BigInt(id) >> 32n);
    return s >= 1.5e9 && s < 2e9 && (s < lo || s >= hi);
  });
  expect(real.map(([f]) => f)).toEqual([]);
});
