// The board on several entries (ADR-0014, #769): [board] the first, each [[board.extra]] one more, each
// its own port with its own host allow-list, auth and same-origin check; one written wrong closes the
// whole board; one that cannot listen leaves the others; rh doctor checks each.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard } from "../src/board";
import { loadConfig, type Config } from "../src/config";
import { boardFindings } from "../src/doctor";
import { openStore } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-entries-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** The config of these lines, after a state dir and a test Herdr session. */
function config(toml: string): Config {
  const file = join(dir, `config-${n++}.toml`);
  writeFileSync(file, `stateDir = "${dir}/state"\n[herdr]\nsession = "rhodium-test-none"\n${toml}\n`, { mode: 0o600 });
  return loadConfig(file);
}

test("ADR-0014: [[board.extra]] adds an entry with the items of [board], port required, the rest at their defaults; a config of [board] alone has none", () => {
  const b = config('[board]\nport = 0\nlogin = "you@example.com"\n[[board.extra]]\nport = 7802\nauth = "none"\nhosts = ["board.example.com"]\n[[board.extra]]\nport = 0').board;
  expect(b).toEqual({
    port: 0,
    login: "you@example.com",
    bind: "127.0.0.1",
    auth: "tailscale",
    hosts: [],
    closed: null,
    extra: [
      { port: 7802, login: "", bind: "127.0.0.1", auth: "none", hosts: ["board.example.com"] },
      { port: 0, login: "", bind: "127.0.0.1", auth: "tailscale", hosts: [] },
    ],
  });
  expect(config("[board]\nport = 0").board.extra).toEqual([]);
});

test("ADR-0014: an entry written wrong closes the whole board, saying which entry, on [board]'s port alone", () => {
  const wrong: [string, RegExp][] = [
    ['[[board.extra]]\nport = 7802\nauth = "cloudflare"', /board\.extra 第 1 张.*auth.*"cloudflare"/],
    ['[[board.extra]]\nauth = "none"', /board\.extra 第 1 张.*port/],
    ['[[board.extra]]\nport = 7802\n[[board.extra]]\nport = 7803\nhosts = ["board.example.com"]', /board\.extra 第 2 张.*hosts/],
    // Two entries on one address.
    ['[[board.extra]]\nport = 7801\nauth = "none"', /7801/],
    ['[[board.extra]]\nport = 7802\n[[board.extra]]\nport = 7802\nbind = "127.0.0.1"', /board\.extra 第 2 张.*127\.0\.0\.1:7802/],
    // Not a list of tables.
    ["extra = 1", /board\.extra/],
    ["extra = [1]", /board\.extra/],
    ["[board.extra]\nport = 7802", /board\.extra/],
    // One in an extra.
    ["[[board.extra]]\nport = 7802\n[[board.extra.extra]]\nport = 7803", /board\.extra 第 1 张.*extra/],
  ];
  for (const [toml, why] of wrong) {
    const b = config(`[board]\nport = 7801\n${toml}`).board;
    expect([toml, b.closed]).toEqual([toml, expect.stringMatching(why)]);
    expect([toml, b]).toMatchObject([toml, { port: 7801, bind: "127.0.0.1", extra: [] }]);
  }
  // Port 0 is any free one: two never clash.
  expect(config('[board]\nport = 0\n[[board.extra]]\nport = 0\nauth = "none"').board.closed).toBeNull();
});

/** A board of two entries on an empty store: by default a tailscale one for tailscale serve, a none one for a proxy at board.example.com; toml: other ones. */
async function withTwo(fn: (ts: string, none: string) => Promise<void>, toml = '[board]\nport = 0\nlogin = "you@example.com"\n[[board.extra]]\nport = 0\nauth = "none"\nhosts = ["board.example.com"]') {
  const store = openStore(join(dir, `rh-${n++}.db`));
  const cfg = config(toml);
  const { servers, deaf } = serveBoard(store, cfg);
  try {
    expect([servers.length, deaf]).toEqual([2, new Map()]);
    await fn(...(servers.map((s) => `http://${s.hostname}:${s.port}`) as [string, string]));
  } finally {
    for (const s of servers) s.stop(true);
    store.close();
  }
}

const status = async (at: string, path: string, headers: Record<string, string> = {}) => (await fetch(at + path, { headers })).status;

test("ADR-0014: each entry lets in by its own auth: the tailscale one wants your Tailscale-User-Login, the none one does not look at it", async () => {
  await withTwo(async (ts, none) => {
    expect(await status(ts, "/api/board", { "Tailscale-User-Login": "you@example.com" })).toBe(200);
    expect(await status(ts, "/api/board")).toBe(403);
    expect(await status(ts, "/api/board", { "Tailscale-User-Login": "someone@example.com" })).toBe(403);
    expect(await status(none, "/api/board")).toBe(200);
    expect(await status(none, "/api/board", { "Tailscale-User-Login": "someone@example.com" })).toBe(200);
  });
});

test("ADR-0014: each entry answers to its own names: the none one's domain at the tailscale one is 403, your login or not; a tailnet name at the none one, 403", async () => {
  await withTwo(async (ts, none) => {
    expect(await status(none, "/api/board", { host: "board.example.com" })).toBe(200);
    expect(await status(ts, "/api/board", { host: "myhost.tail1234.ts.net", "Tailscale-User-Login": "you@example.com" })).toBe(200);
    expect(await status(ts, "/api/board", { host: "board.example.com", "Tailscale-User-Login": "you@example.com" })).toBe(403);
    expect(await status(none, "/api/board", { host: "myhost.tail1234.ts.net", "Tailscale-User-Login": "you@example.com" })).toBe(403);
  });
});

test("ADR-0014: a 403 for a host or login names the entry whose item to change, never [board]'s for an extra one", async () => {
  const text = async (at: string, headers: Record<string, string>) => (await fetch(at + "/api/board", { headers })).text();
  await withTwo(async (ts, none) => {
    expect(await text(none, { host: "evil.example" })).toContain("board.extra 第 1 张的 hosts");
    expect(await text(ts, {})).toContain("board.login");
  });
  await withTwo(async (none, ts) => {
    expect(await text(none, { host: "evil.example" })).toContain("board.hosts");
    expect(await text(ts, {})).toContain("board.extra 第 1 张的 login");
  }, '[board]\nport = 0\nauth = "none"\nhosts = ["board.example.com"]\n[[board.extra]]\nport = 0\nlogin = "you@example.com"');
});

test("ADR-0014: the same-origin check and the terminal's handshake go by the entry they came in: a page of one entry is another origin to the other", async () => {
  await withTwo(async (ts, none) => {
    const me = { "Tailscale-User-Login": "you@example.com" };
    const at = (base: string, path: string, headers: Record<string, string>) => status(base, path, { ...me, ...headers });
    for (const path of ["/api/dirs?path=/", "/api/terminal?slot=s1"]) {
      const ok = path.startsWith("/api/dirs") ? 200 : 400;
      expect([path, await at(ts, path, { origin: ts })]).toEqual([path, ok]);
      expect([path, await at(none, path, { origin: none })]).toEqual([path, ok]);
      expect([path, await at(ts, path, { origin: none })]).toEqual([path, 403]);
      expect([path, await at(none, path, { origin: ts })]).toEqual([path, 403]);
      // The handshake at the tailscale one still wants your login, at the none one only the board's own page.
      expect([path, await status(ts, path, { origin: ts })]).toEqual([path, 403]);
      expect([path, await status(none, path, { "sec-fetch-site": "cross-site" })]).toEqual([path, 403]);
    }
  });
});

test("ADR-0014: an entry whose port is taken is logged and left out; the others answer as ever", async () => {
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("someone else") });
  const store = openStore(join(dir, `rh-${n++}.db`));
  const { servers, deaf } = serveBoard(store, config(`[board]\nport = ${taken.port}\nauth = "none"\n[[board.extra]]\nport = 0\nauth = "none"`));
  try {
    expect(servers.length).toBe(1);
    expect([...deaf.keys()]).toEqual(["board"]);
    expect(await status(`http://127.0.0.1:${servers[0]!.port}`, "/api/ping")).toBe(204);
  } finally {
    for (const s of servers) s.stop(true);
    taken.stop(true);
    store.close();
  }
});

const fine: Config["board"] = { port: 7800, login: "you@example.com", bind: "127.0.0.1", auth: "tailscale", hosts: [], closed: null, extra: [] };
const never = async (url: string): Promise<Response> => {
  throw new Error(`asked ${url}`);
};

test("ADR-0014: rh doctor checks each entry, naming it, and errs on one that cannot listen; every error begins 看板", async () => {
  const extra = [{ port: 7802, login: "", bind: "0.0.0.0", auth: "none" as const, hosts: [] }, { port: 7803, login: "", bind: "127.0.0.1", auth: "none" as const, hosts: ["open.example.com"] }];
  const open = async () => new Response(null, { status: 204 });
  expect(await boardFindings({ ...fine, bind: "192.168.1.5", extra }, open, new Map([["board.extra 第 1 张", "EADDRINUSE"]]))).toEqual([
    { level: "错误", text: expect.stringMatching(/^看板（board）.*192\.168\.1\.5/) },
    { level: "错误", text: expect.stringMatching(/^看板（board\.extra 第 1 张）.*0\.0\.0\.0/) },
    { level: "错误", text: expect.stringMatching(/^看板（board\.extra 第 1 张）听不到 0\.0\.0\.0:7802.*EADDRINUSE/) },
    { level: "错误", text: expect.stringMatching(/^看板（board\.extra 第 2 张）.*open\.example\.com/) },
  ]);
  expect(await boardFindings({ ...fine, extra: [{ ...extra[1]!, hosts: [] }] }, never)).toEqual([]);
  // One entry alone says it as ever, with no name.
  expect(await boardFindings(fine, never, new Map([["board", "EADDRINUSE"]]))).toEqual([{ level: "错误", text: expect.stringMatching(/^看板听不到 127\.0\.0\.1:7800.*EADDRINUSE/) }]);
});
