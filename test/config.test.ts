import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, owners, renameTarget } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "rhodium-test-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000" };

let n = 0;
function configFile(toml: string, mode = 0o600): string {
  const path = join(dir, `config-${n++}.toml`);
  writeFileSync(path, toml);
  chmodSync(path, mode);
  return path;
}

test("refuses to start when the config file is not 0600", () => {
  for (const mode of [0o644, 0o640, 0o700, 0o400]) {
    expect(() => loadConfig(configFile("", mode), env)).toThrow(/0600/);
  }
});

test("refuses to start when the config file is missing", () => {
  expect(() => loadConfig(join(dir, "nope.toml"), env)).toThrow();
});

test("an empty config uses the documented defaults", () => {
  const c = loadConfig(configFile(""), env);
  expect(c.durations.idleReap).toBe(60 * 60_000);
  expect(c.durations.askTimeout).toBe(30 * 60_000);
  expect(c.durations.crashWindow).toBe(10 * 60_000);
  expect(c.limits.crashCount).toBe(3);
  expect(c.limits.maxRunning).toBe(8);
  // QQ's quotas (product §5.5): passive replies as probe 12 met them, active messages as QQ's docs say.
  expect(c.limits.qqPassiveReplies).toBe(20);
  expect(c.durations.qqPassiveWindow).toBe(60 * 60_000);
  expect(c.limits.qqActive).toBe(1000);
  expect(c.durations.qqActiveWindow).toBe(24 * 3_600_000);
  expect(c.durations.feishuEdit).toBe(3000); // a Feishu card's edits, at most one every 3 s (story 456)
  expect(c.unitPrefix).toBe("rh-");
  expect(c.stateDir).toBe("/home/u/.local/state/rhodium");
  expect(c.socketDir).toBe("/run/user/1000/rhodium");
  expect(c.lockDir).toBe("/home/u/.local/state/rhodium/lock");
});

test("every duration can be set in seconds", () => {
  const keys = Object.keys(loadConfig(configFile(""), env).durations);
  expect(keys.length).toBeGreaterThan(5);
  const toml = "[durations]\n" + keys.map((k) => `${k} = "2s"`).join("\n");
  const c = loadConfig(configFile(toml), env);
  for (const k of keys) expect(c.durations[k as keyof typeof c.durations]).toBe(2000);
});

test("durations take ms, s, m, h and d units, and 0s turns a timeout off", () => {
  const c = loadConfig(
    configFile('[durations]\naskTimeout = "0s"\nidleReap = "90m"\noneoffArchive = "1d"\nstopGrace = "250ms"'),
    env,
  );
  expect(c.durations.askTimeout).toBe(0);
  expect(c.durations.idleReap).toBe(90 * 60_000);
  expect(c.durations.oneoffArchive).toBe(24 * 3600_000);
  expect(c.durations.stopGrace).toBe(250);
});

test("the daily rh doctor and the daily backup cannot be every 0s", () => {
  expect(() => loadConfig(configFile('[durations]\ndoctorEvery = "0s"'), env)).toThrow(/doctorEvery/);
  expect(() => loadConfig(configFile('[durations]\nbackupEvery = "0s"'), env)).toThrow(/backupEvery/);
});

test("unit prefix, socket directory and lock directory are configurable", () => {
  const c = loadConfig(
    configFile('unitPrefix = "rhodium-test-ab12-"\nsocketDir = "/tmp/s"\nlockDir = "/tmp/l"\nstateDir = "/tmp/st"'),
    env,
  );
  expect([c.unitPrefix, c.socketDir, c.lockDir, c.stateDir]).toEqual([
    "rhodium-test-ab12-",
    "/tmp/s",
    "/tmp/l",
    "/tmp/st",
  ]);
});

test("the agents' PATH and the holder unit's MemoryHigh are configurable", () => {
  const c = loadConfig(configFile('agentPath = "/opt/node/bin:/usr/bin"\nmemoryHigh = "1G"'), env);
  expect([c.agentPath, c.memoryHigh]).toEqual(["/opt/node/bin:/usr/bin", "1G"]);
});

test("without agentPath agents get rhodium's own PATH, and MemoryHigh defaults to 3G", () => {
  const c = loadConfig(configFile(""), { ...env, PATH: "/a/bin:/usr/bin" });
  expect([c.agentPath, c.memoryHigh]).toEqual(["/a/bin:/usr/bin", "3G"]);
  expect(loadConfig(configFile(""), env).agentPath).toBe("/usr/local/bin:/usr/bin:/bin");
});

test("the unit prefix takes only characters systemd allows in a unit name", () => {
  for (const v of ["a b/c", "", "rh@", "ré-"]) {
    expect(() => loadConfig(configFile(`unitPrefix = "${v}"`), env)).toThrow(/unitPrefix/);
  }
  expect(loadConfig(configFile('unitPrefix = "rh_test:1.a-"'), env).unitPrefix).toBe("rh_test:1.a-");
});

test("an empty XDG_RUNTIME_DIR falls back like a missing one", () => {
  const c = loadConfig(configFile(""), { ...env, XDG_RUNTIME_DIR: "" });
  expect(c.socketDir).toBe(`/run/user/${process.getuid!()}/rhodium`);
});

test("bots carry their credentials from the config file", () => {
  const c = loadConfig(configFile('[bots.main]\nplatform = "qq"\nappId = "1"\nsecret = "s"'), env);
  expect(c.bots.main).toEqual({ platform: "qq", appId: "1", secret: "s" });
});

test("mainChat names a chat of one of the bots, as <bot>/<chat id>", () => {
  const bot = '\n[bots.main]\nplatform = "qq"';
  expect(loadConfig(configFile(`mainChat = "main/openid-1"${bot}`), env).mainChat).toEqual({ bot: "main", chat: "openid-1" });
  expect(loadConfig(configFile(`mainChat = "main/a/b"${bot}`), env).mainChat).toEqual({ bot: "main", chat: "a/b" });
  expect(loadConfig(configFile(""), env).mainChat).toBeNull();
  for (const bad of ["main", "main/", "other/openid-1"]) {
    expect(() => loadConfig(configFile(`mainChat = "${bad}"${bot}`), env)).toThrow(/mainChat/);
  }
});

test("rejects unknown keys, bad durations and wrong types", () => {
  expect(() => loadConfig(configFile("idleReap = 5"), env)).toThrow(/idleReap/);
  expect(() => loadConfig(configFile('[durations]\nidleReap = "5 minutes"'), env)).toThrow(/idleReap/);
  expect(() => loadConfig(configFile("[durations]\nidleReap = 5"), env)).toThrow(/idleReap/);
  expect(() => loadConfig(configFile('[limits]\nmaxRunning = "8"'), env)).toThrow(/maxRunning/);
  expect(() => loadConfig(configFile('[bots.x]\nplatform = "irc"'), env)).toThrow(/platform/);
  expect(() => loadConfig(configFile("not toml ="), env)).toThrow();
});

test("names inherited by every object are unknown keys, not a way around the checks", () => {
  for (const toml of [
    "[durations]\n__proto__ = {x=1}",
    '[defaults]\n__proto__ = {approval="yes"}',
    'constructor = "1s"',
    '[limits]\ntoString = 1',
  ]) {
    expect(() => loadConfig(configFile(toml), env)).toThrow(/unknown key/);
  }
  const c = loadConfig(configFile('[bots.__proto__]\nplatform = "qq"'), env);
  expect(Object.keys(c.bots)).toEqual(["__proto__"]);
  expect(c.defaults.approval).toBe(false);
});

test("limits take only whole numbers of zero or more", () => {
  for (const v of ["-3", "1.5"]) {
    expect(() => loadConfig(configFile(`[limits]\nmaxRunning = ${v}`), env)).toThrow(/maxRunning/);
  }
  expect(loadConfig(configFile("[limits]\nmaxRunning = 0"), env).limits.maxRunning).toBe(0);
});

test("without HOME the state directory must be given", () => {
  const noHome = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(() => loadConfig(configFile(""), noHome)).toThrow(/HOME/);
  expect(loadConfig(configFile('stateDir = "/srv/rh"'), noHome).lockDir).toBe("/srv/rh/lock");
});

test("directories must be absolute paths", () => {
  for (const key of ["stateDir", "socketDir", "lockDir"]) {
    expect(() => loadConfig(configFile(`${key} = "rel/dir"`), env)).toThrow(new RegExp(key));
  }
});

test("bots must be a table of tables", () => {
  for (const toml of ["bots = 5", 'bots = "main"', "bots = []"]) {
    expect(() => loadConfig(configFile(toml), env)).toThrow(/bots/);
  }
});

test("claude, pi, codex and herdr are looked up on PATH unless [programs] gives their absolute paths", () => {
  expect(loadConfig(configFile(""), env).programs).toEqual({ claude: "claude", pi: "pi", codex: "codex", herdr: "herdr" });
  const c = loadConfig(configFile('[programs]\nclaude = "/opt/fake/claude"\npi = "/opt/fake/pi"\ncodex = "/opt/fake/codex"\nherdr = "/opt/fake/herdr"'), env);
  expect(c.programs).toEqual({ claude: "/opt/fake/claude", pi: "/opt/fake/pi", codex: "/opt/fake/codex", herdr: "/opt/fake/herdr" });
  expect(() => loadConfig(configFile('[programs]\nclaude = "bin/claude"'), env)).toThrow(/programs.claude/);
  expect(() => loadConfig(configFile('[programs]\ngemini = "/x"'), env)).toThrow(/programs.gemini/);
});

test("TUI panes open in your default Herdr session unless [herdr] names another", () => {
  expect(loadConfig(configFile(""), env).herdr).toEqual({ session: "default" });
  expect(loadConfig(configFile('[herdr]\nsession = "rhodium-test-1"'), env).herdr).toEqual({ session: "rhodium-test-1" });
  expect(() => loadConfig(configFile('[herdr]\nsession = ""'), env)).toThrow(/herdr.session/);
});

test("the board listens on 127.0.0.1:7800 and lets nobody in until [board] names your Tailscale login; a config of port and login alone is as it was", () => {
  const as = { bind: "127.0.0.1", auth: "tailscale" as const, hosts: [], closed: null };
  expect(loadConfig(configFile(""), env).board).toEqual({ port: 7800, login: "", ...as });
  const c = loadConfig(configFile('[board]\nport = 0\nlogin = "you@example.com"'), env);
  expect(c.board).toEqual({ port: 0, login: "you@example.com", ...as });
});

test("ADR-0013: [board] may listen elsewhere and leave who gets in to a proxy in front, reached by the hosts named, exact lowercase names", () => {
  const c = loadConfig(configFile('[board]\nbind = "0.0.0.0"\nauth = "none"\nhosts = ["board.example.com", "b-2.example.com"]'), env);
  expect(c.board).toEqual({ port: 7800, login: "", bind: "0.0.0.0", auth: "none", hosts: ["board.example.com", "b-2.example.com"], closed: null });
  expect(loadConfig(configFile('[board]\nbind = "::1"\nauth = "none"'), env).board).toMatchObject({ bind: "::1", auth: "none", hosts: [], closed: null });
});

test("ADR-0013: a [board] written wrong does not stop rhodium: it closes the board alone, saying what is wrong, listening on 127.0.0.1", () => {
  const wrong: [string, RegExp][] = [
    ['auth = "cloudflare"', /board\.auth.*"cloudflare"/],
    ["auth = 1", /board\.auth/],
    ['bind = "my-host"', /board\.bind.*"my-host"/],
    ['bind = ""', /board\.bind/],
    ['auth = "none"\nhosts = "board.example.com"', /board\.hosts/],
    ...["https://board.example.com", "board.example.com:443", "Board.example.com", "*.example.com", "board..example.com", "-b.example.com", "board.example.com/", ""].map(
      (h): [string, RegExp] => [`auth = "none"\nhosts = ["ok.example.com", ${JSON.stringify(h)}]`, new RegExp(`board\\.hosts.*${JSON.stringify(h).replace(/[.*/]/g, "\\$&")}`)],
    ),
    ['auth = "none"\nhosts = [1]', /board\.hosts/],
    // A proxy brings the internet to tailscale mode's port, whose Tailscale-User-Login anyone can write there.
    ['hosts = ["board.example.com"]', /board\.hosts.*auth = "none"/],
    // A key misspelt or of the wrong type closes the board alone too, the IM going on.
    ['atuh = "none"', /board\.atuh/],
    ['host = "0.0.0.0"', /board\.host\b/],
    ["login = 1", /board\.login.*1/],
  ];
  for (const [toml, why] of wrong) {
    // Listening on all addresses as given, but for what is wrong.
    const b = loadConfig(configFile(`[board]\n${toml.includes("bind") ? "" : 'bind = "0.0.0.0"\n'}port = 0\n${toml}`), env).board;
    expect([toml, b.closed]).toEqual([toml, expect.stringMatching(why)]);
    expect([toml, b]).toEqual([toml, { port: 0, login: "", bind: "127.0.0.1", auth: "tailscale", hosts: [], closed: b.closed }]);
  }
  // A port written wrong: closed on the default one.
  for (const port of ["-1", "65536", "1.5", '"7800"']) {
    const b = loadConfig(configFile(`[board]\nport = ${port}`), env).board;
    expect([port, b]).toEqual([port, { port: 7800, login: "", bind: "127.0.0.1", auth: "tailscale", hosts: [], closed: expect.stringMatching(/board\.port/) }]);
  }
  expect(loadConfig(configFile("board = 1"), env).board).toMatchObject({ port: 7800, closed: expect.stringMatching(/board.*1/) });
});

test("a [bots.<name>] table may be a Feishu bot, its App ID and secret as strings", () => {
  const c = loadConfig(configFile('[bots.fs]\nplatform = "feishu"\nappId = "cli_0123456789abcdef"\nsecret = "s"\nowner = "ou_1"'), env);
  expect(c.bots.fs).toEqual({ platform: "feishu", appId: "cli_0123456789abcdef", secret: "s", owner: "ou_1" });
  expect(() => loadConfig(configFile('[bots.l]\nplatform = "lark"'), env)).toThrow(/feishu/);
});

test("#449: a bot's owner may be one id or a list of them; with the paired ones on top, each counts once", () => {
  const c = loadConfig(configFile('[bots.one]\nplatform = "qq"\nowner = "a"\n[bots.two]\nplatform = "qq"\nowner = ["a", "b"]\n[bots.none]\nplatform = "qq"'), env);
  expect(owners({ name: "one", owners: null }, c)).toEqual(["a"]);
  expect(owners({ name: "two", owners: '["b", "c"]' }, c)).toEqual(["a", "b", "c"]);
  expect(owners({ name: "none", owners: null }, c)).toEqual([]);
  for (const bad of ["[]", "[1]", '[""]']) expect(() => loadConfig(configFile(`[bots.q]\nplatform = "qq"\nowner = ${bad}`), env)).toThrow(/owner must be a user id or a list/);
});

test("rh rename backs the config up, then changes only the name in the quotes of each bot's target line naming the slot", () => {
  const toml = [
    "# my bots",
    "[bots.q]",
    'platform = "qq"',
    'appId = "1"',
    "target = \"w/a\"   # the dispatcher",
    "",
    "[bots.t]",
    'platform = "telegram"',
    "  target = 'w/a'",
    "[bots.u]",
    'platform = "telegram"',
    'target = "w/ab" # not it',
    "",
  ].join("\n");
  const path = configFile(toml);
  const done = renameTarget(path, "w/a", "w/x.y")!;
  expect(done.bots).toEqual(["q", "t"]);
  expect(readFileSync(path, "utf8")).toBe(toml.replace('"w/a"', '"w/x.y"').replace("'w/a'", "'w/x.y'"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(done.backup, "utf8")).toBe(toml);
  expect(statSync(done.backup).mode & 0o777).toBe(0o600);
  expect(done.backup.startsWith(`${path}.`)).toBe(true);
  // No bot's target names it: nothing is written, nor backed up.
  const files = readdirSync(dir).length;
  expect(renameTarget(path, "w/zz", "w/b")).toBeNull();
  expect(readdirSync(dir).length).toBe(files);
});

test("rh rename leaves the config as it is when a bot's target naming the slot is not on a line of its own", () => {
  const toml = 'bots.q = { platform = "qq", target = "w/a" }\n';
  const path = configFile(toml);
  const files = readdirSync(dir).length;
  expect(() => renameTarget(path, "w/a", "w/b")).toThrow(/Bot q/);
  expect(readFileSync(path, "utf8")).toBe(toml);
  expect(readdirSync(dir).length).toBe(files);
});
