// Where the board listens and who it lets in (ADR-0013, architecture §11): with auth none, whoever
// reaches the port, by this machine's name or one of [board] hosts; a [board] written wrong closes the
// board alone; and what rh doctor says of it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBoard } from "../src/board";
import { loadConfig, type Config } from "../src/config";
import { boardFindings } from "../src/doctor";
import { openStore } from "../src/store";
import { newInstance, type Instance } from "./instance";

/** A board of its own on an empty store, its [board] table these lines, at its address. */
async function withBoard(board: string, fn: (at: string, port: number) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-access-"));
  writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[herdr]\nsession = "rhodium-test-none"\n[board]\nport = 0\n${board}\n`, { mode: 0o600 });
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, loadConfig(join(dir, "config.toml")));
  try {
    await fn(`http://${server.hostname}:${server.port}`, server.port!);
  } finally {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The status of a GET of path at at with these headers. */
const status = async (at: string, path: string, headers: Record<string, string> = {}) => (await fetch(at + path, { headers })).status;

test("ADR-0013: auth none alone lets in whoever reaches 127.0.0.1, as a browser here or through ssh -L does, at 127.0.0.1 or localhost, a Tailscale-User-Login or none; the tailnet's names it does not answer to", async () => {
  await withBoard('auth = "none"', async (at, port) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "localhost"]) {
      for (const login of [{}, { "Tailscale-User-Login": "someone@example.com" }] as Record<string, string>[]) {
        expect([host, login, await status(at, "/api/board", { host, ...login })]).toEqual([host, login, 200]);
      }
    }
    expect(await status(at, "/api/ping")).toBe(204);
    for (const host of ["myhost.tail1234.ts.net", "evil.example", `evil.example:${port}`]) expect([host, await status(at, "/api/board", { host })]).toEqual([host, 403]);
  });
});

test("ADR-0013: with hosts, auth none also answers to each by its exact name, any port; a page elsewhere whose name points here gets nothing, its name like one of them or not", async () => {
  await withBoard('auth = "none"\nhosts = ["board.example.com", "b.example.org"]', async (at, port) => {
    for (const host of ["board.example.com", "board.example.com:443", "b.example.org", `localhost:${port}`]) {
      expect([host, await status(at, "/api/board", { host })]).toEqual([host, 200]);
    }
    const elsewhere = ["evil.example", "board.example.com.evil.example", "x.board.example.com", "example.com", "evilboard.example.com", "myhost.tail1234.ts.net", "ts.net"];
    for (const path of ["/", "/api/board", "/api/events", "/api/act", "/api/terminal", "/icon-192.png"]) {
      for (const host of elsewhere) expect([path, host, await status(at, path, { host })]).toEqual([path, host, 403]);
    }
  });
});

test("ADR-0013: auth none still takes a write, or a terminal's handshake, only from the board's own page", async () => {
  await withBoard('auth = "none"\nhosts = ["board.example.com"]', async (at) => {
    const post = (headers: Record<string, string>) =>
      fetch(`${at}/api/act`, { method: "POST", headers: { host: "board.example.com", "content-type": "application/json", ...headers }, body: JSON.stringify({ id: "x1", act: { kind: "rh", argv: ["ws"] } }) });
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post({ origin: "https://board.example.com" })).status).toBe(200);
    for (const h of [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example.com" }, {}] as Record<string, string>[]) expect([h, (await post(h)).status]).toEqual([h, 403]);
    // Checked before whether it upgrades: a page elsewhere gets 403, the board's own 400 for no upgrade.
    const terminal = (headers: Record<string, string>) => status(at, "/api/terminal?slot=s1", { host: "board.example.com", ...headers });
    expect(await terminal({ "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await terminal({ origin: "https://evil.example.com" })).toBe(403);
    expect(await terminal({ "sec-fetch-site": "same-origin" })).toBe(400);
  });
});

test("ADR-0013: tailscale mode, the default, still wants your login in Tailscale-User-Login, however it is reached", async () => {
  await withBoard('login = "you@example.com"', async (at) => {
    expect(await status(at, "/api/board")).toBe(403);
    expect(await status(at, "/api/board", { "Tailscale-User-Login": "someone@example.com" })).toBe(403);
    expect(await status(at, "/api/board", { "Tailscale-User-Login": "you@example.com" })).toBe(200);
    expect(await status(at, "/api/board", { "Tailscale-User-Login": "you@example.com", host: "board.example.com" })).toBe(403);
  });
});

test("ADR-0013: the board listens on [board] bind", async () => {
  await withBoard('auth = "none"\nbind = "127.0.0.2"', async (at) => {
    expect(at).toStartWith("http://127.0.0.2:");
    expect(await status(at, "/api/ping", { host: "localhost" })).toBe(204);
  });
});

test("ADR-0013: a [board] written wrong closes the board: every path, to anyone, says what is wrong, on 127.0.0.1", async () => {
  await withBoard('bind = "0.0.0.0"\nauth = "cloudflare"\nlogin = "you@example.com"', async (at) => {
    expect(at).toStartWith("http://127.0.0.1:");
    for (const path of ["/", "/api/board", "/api/events", "/api/ping", "/api/terminal?slot=s1", "/icon-192.png"]) {
      const r = await fetch(at + path, { headers: { "Tailscale-User-Login": "you@example.com", "sec-fetch-site": "same-origin" } });
      expect([path, r.status, await r.text()]).toEqual([path, 503, expect.stringMatching(/看板关着.*board\.auth.*"cloudflare"/)]);
    }
  });
});

const fine: Config["board"] = { port: 7800, login: "you@example.com", bind: "127.0.0.1", auth: "tailscale", hosts: [], closed: null };
const never = async (url: string): Promise<Response> => {
  throw new Error(`asked ${url}`);
};

test("ADR-0013: rh doctor says nothing of a board as it was, and asks nothing of the internet", async () => {
  expect(await boardFindings(fine, never)).toEqual([]);
  expect(await boardFindings({ ...fine, auth: "none" }, never)).toEqual([]);
  expect(await boardFindings({ ...fine, bind: "127.0.0.5" }, never)).toEqual([]);
  expect(await boardFindings({ ...fine, bind: "::1" }, never)).toEqual([]);
});

// Every error of the board begins 看板, which tells upgrade.sh it is no reason to go back (deploy/README.md).
test("ADR-0013: rh doctor errs on a board listening beyond this machine: with auth none anyone there gets it, terminal and all; with tailscale anyone there writes your Tailscale-User-Login", async () => {
  for (const bind of ["0.0.0.0", "::", "192.168.1.5"]) {
    expect(await boardFindings({ ...fine, bind, auth: "none" }, never)).toEqual([{ level: "错误", text: expect.stringMatching(new RegExp(`^看板.*auth = "none".*${bind}.*终端`)) }]);
    expect(await boardFindings({ ...fine, bind }, never)).toEqual([{ level: "错误", text: expect.stringMatching(new RegExp(`^看板.*${bind}.*Tailscale-User-Login`)) }]);
  }
});

test("ADR-0013: rh doctor errs on a [board] written wrong, which closes the board", async () => {
  expect(await boardFindings({ ...fine, closed: 'board.auth 写的是 "cloudflare"' }, never)).toEqual([{ level: "错误", text: expect.stringMatching(/^看板关着.*"cloudflare"/) }]);
});

test("ADR-0013: with auth none, rh doctor asks each of hosts as a stranger would, with no login: the board itself answering is an error; one it cannot reach, a warning that it could not check", async () => {
  const asked: string[] = [];
  const probe = async (url: string): Promise<Response> => {
    asked.push(url);
    const host = new URL(url).hostname;
    if (host === "open.example.com") return new Response(null, { status: 204 });
    // Cloudflare Access, its login wanted.
    if (host === "guarded.example.com") return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/" } });
    if (host === "down.example.com") return new Response("bad gateway", { status: 502 });
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const hosts = ["open.example.com", "guarded.example.com", "down.example.com", "gone.example.com"];
  const found = await boardFindings({ ...fine, auth: "none", hosts }, probe);
  expect(asked.sort()).toEqual(hosts.map((h) => `https://${h}/api/ping`).sort());
  expect(found).toEqual([
    { level: "错误", text: expect.stringMatching(/^看板.*https:\/\/open\.example\.com\/.*不登录/) },
    { level: "告警", text: expect.stringMatching(/https:\/\/gone\.example\.com\/.*没核对.*ENOTFOUND/) },
  ]);
});

let rhodium: Instance | undefined;
afterEach(() => rhodium?.cleanup());

test("ADR-0013: rhodium with a [board] written wrong runs on, its board closed saying why, and rh doctor reports it as an error", async () => {
  rhodium = newInstance();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace("[board]\n", '[board]\nauth = "cloudflare"\n'));
  const d = await rhodium.start();
  const r = await fetch(`http://${d.logs.find((l) => l.msg === "ready")!.board}/api/board`);
  expect([r.status, await r.text()]).toEqual([503, expect.stringMatching(/board\.auth/)]);
  expect(await rhodium.ok("doctor")).toMatch(/^错误：看板关着.*board\.auth.*"cloudflare"/m);
});
