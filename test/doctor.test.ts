// rh doctor (architecture §12), seen from seam one: a fake claude install dir, with package.json one
// level above bin/claude and a "binary" holding the protocol names, and a fake agent that answers
// the handshake.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL } from "../src/doctor";
import { updateClaude as update, type UpdateOptions } from "./claude-update";
import { installFakeAgent, type Config as FakeAgentConfig, type Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
const NAMES = Object.keys(PROTOCOL);
const j = JSON.stringify;

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** Puts claude <version> in place in this test's instance (see test/claude-update.ts). */
const updateClaude = (version: string, o?: UpdateOptions) => update(rhodium, version, o);

test("story 150: after Claude updates, rh doctor reports the new version and what a missing protocol name degrades", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  const first = await rhodium.ok("doctor");
  expect(first).toContain("Claude 2.1.304（第一次核对）");
  expect(first).not.toContain("错误");
  // The handshake leaves no empty session in ~/.claude/projects.
  expect(rhodium.claude.runs()[0]!.argv).toContain("--no-session-persistence");

  updateClaude("2.1.305", { names: NAMES.filter((n) => n !== "interrupt_receipt_v1") });
  const second = await rhodium.ok("doctor");
  expect(second).toContain("Claude 2.1.305（上次核对的是 2.1.304）");
  expect(second).toMatch(/^错误：.*interrupt_receipt_v1.*打断/m);
  // The handshake waits for every name to be there: only the first run started claude.
  expect(rhodium.claude.runs()).toHaveLength(1);

  // 2.1.305 was never handshaken, so the next version's answers are compared with 2.1.304's.
  updateClaude("2.1.306", { without: ["models"] });
  expect(await rhodium.ok("doctor")).toContain("错误：握手应答比 2.1.304 少了字段");
});

test("a claude without command_lifecycle is an error: without it the driver takes a turn Claude began by itself for yours", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.306", { names: NAMES.filter((n) => n !== "command_lifecycle") });
  expect(await rhodium.ok("doctor")).toMatch(/^错误：claude 里找不到协议名字 command_lifecycle，这项功能会降级：.*内部回合/m);
});

test("a handshake answer with fields the last verified version did not have, or without ones it had, is reported", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  await rhodium.ok("doctor");

  updateClaude("2.1.305", { without: ["models"], extra: { fast_mode_state: "off" } });
  const out = await rhodium.ok("doctor");
  // What was inside models went with it, and is not listed again.
  expect(out).toMatch(/^错误：握手应答比 2\.1\.304 少了字段：initialize\.response\.models$/m);
  expect(out).toContain("告警：握手应答比 2.1.304 多了字段：initialize.response.fast_mode_state");
  // Compared with the version checked last, so the next run has nothing new to say.
  expect(await rhodium.ok("doctor")).not.toContain("握手应答");
});

test("on an update day, fields gone from inside an array, as when you removed an MCP server, are a warning, not an error", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  await rhodium.ok("doctor");

  updateClaude("2.1.305", { context: { mcpTools: [] } });
  const out = await rhodium.ok("doctor");
  expect(out).toContain(
    "告警：握手应答比 2.1.304 少了数组里的字段，可能只是你的配置变了：get_context_usage.response.mcpTools[].name、get_context_usage.response.mcpTools[].serverName",
  );
  expect(out).not.toContain("错误");
});

test("switching claude's login, which changes account's fields, is no handshake change, even with a new version", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  await rhodium.ok("doctor");

  // You logged in with a token in a terminal, and claude updated itself on the way.
  updateClaude("2.1.305", { extra: { account: { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" } } });
  expect(await rhodium.ok("doctor")).not.toContain("握手应答");
});

test("a handshake that fails on the run that sees a new version is compared on the next run that succeeds", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  await rhodium.ok("doctor");

  updateClaude("2.1.305", { fail: true });
  expect(await rhodium.ok("doctor")).toMatch(/^错误：和 claude 握手失败：initialize 应答出错：busy$/m);

  updateClaude("2.1.305", { without: ["models"] });
  const out = await rhodium.ok("doctor");
  expect(out).not.toContain("上次核对的是");
  expect(out).toContain("错误：握手应答比 2.1.304 少了字段：initialize.response.models");
  expect(await rhodium.ok("doctor")).not.toContain("握手应答");
});

test("story 151: --bare slipped into claude's launch, here by a wrapper, is an error", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304", { bare: true });
  expect(await rhodium.ok("doctor")).toMatch(/^错误：.*--bare/m);
});

test("rh doctor names how claude is logged in: a subscription, an API token or key, which is no error, or none, which is", async () => {
  rhodium = newInstance();
  await rhodium.start();
  const doctor = (account: object) => {
    updateClaude("2.1.311", { extra: { account } });
    return rhodium.ok("doctor");
  };
  // As initialize answers in 2.1.311 for each login.
  const subscription = await doctor({ email: "user@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" });
  expect(subscription).toMatch(/^Claude 登录：订阅（Claude Max）$/m);
  expect(subscription).not.toContain("错误");
  // claude setup-token's long-lived token is a subscription's too.
  expect(await doctor({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })).toMatch(/^Claude 登录：订阅（CLAUDE_CODE_OAUTH_TOKEN）$/m);

  const token = await doctor({ tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" });
  expect(token).toMatch(/^Claude 登录：API（ANTHROPIC_AUTH_TOKEN），按用量计费$/m);
  expect(token).not.toMatch(/错误|告警：.*登录/);
  const key = await doctor({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" });
  expect(key).toMatch(/^Claude 登录：API（ANTHROPIC_API_KEY），按用量计费$/m);
  expect(key).not.toMatch(/错误|告警：.*登录/);
  // An API key beside a subscription token is the one requests carry (claude's /status rule).
  const mixed = await doctor({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" });
  expect(mixed).toMatch(/^Claude 登录：API（ANTHROPIC_API_KEY），按用量计费$/m);
  // A third-party backend's login is its own, outside claude: no other field.
  expect(await doctor({ apiProvider: "bedrock" })).toMatch(/^Claude 登录：API（bedrock），按用量计费$/m);

  const none = await doctor({ tokenSource: "none", apiProvider: "firstParty" });
  // How to log in: a subscription, or a URL and token in claude's settings, which the service sees.
  const error = none.match(/^错误：claude 没有登录。.*$/m)?.[0];
  for (const how of ["订阅", "~/.claude/settings.json", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) expect(error).toContain(how);
  expect(none).not.toContain("Claude 登录：");
});

test("the daily checks report free disk space, database backups and pi's version", async () => {
  rhodium = newInstance();
  await rhodium.start();
  updateClaude("2.1.304");
  // Laid out as npm installs pi: bin/pi links to a file deep in the package.
  const pkg = join(rhodium.dir, "pi-coding-agent");
  mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), j({ name: "@earendil-works/pi-coding-agent", version: "0.62.0" }));
  renameSync(rhodium.pi.path, join(pkg, "dist/bundle/cli.js"));
  symlinkSync(join(pkg, "dist/bundle/cli.js"), rhodium.pi.path);

  const out = await rhodium.ok("doctor");
  expect(out).toContain("pi 0.62.0");
  expect(out).toMatch(/^磁盘剩余 \d+\.\dGB$/m);
  expect(out).toMatch(/^告警：还没有数据库备份/m);

  const backups = join(rhodium.dir, "state/backup");
  mkdirSync(backups);
  writeFileSync(join(backups, "rh.db"), "");
  const later = await rhodium.ok("doctor");
  expect(later).toMatch(/^最近的数据库备份：0 小时前$/m);
  expect(later).not.toMatch(/^告警：.*备份/m);
});

test("a Claude process reporting a new version runs the checks, which tell you in the main chat; the slot answers all the same", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: `mainChat = "q/${ME}"` });
  await rhodium.start();
  await rhodium.slots("a");
  updateClaude("2.1.304");
  await rhodium.ok("doctor");

  updateClaude("2.1.305", { names: NAMES.filter((n) => n !== "rate_limit_event") });
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "ping" });
  const texts = async () => (await rhodium.im.log("q", ME)).map((p) => p.text);
  await until(async () => (await texts()).length >= 2, 15_000);
  const [notice] = (await texts()).filter((t) => t.startsWith("rh doctor"));
  expect(notice).toContain("Claude 2.1.305（上次核对的是 2.1.304）");
  expect(notice).toMatch(/^错误：.*rate_limit_event/m);
  expect(await texts()).toContain("pong");
});

test("a restart keeps the daily rh doctor's day: one that came due while rhodium was down runs at startup", async () => {
  rhodium = newInstance({ toml: '[durations]\ndoctorEvery = "2s"' });
  updateClaude("2.1.304");
  await rhodium.start();
  await rhodium.ok("doctor");
  await rhodium.kill9();
  await Bun.sleep(2200);
  await rhodium.start();
  // Counted from the last run, not from startup, which would make it 2s.
  await until(() => rhodium.claude.runs().length === 2, 1500);
}, 15_000);

test("holders still running an older rh-hold, and holders the store has and systemd does not, are listed", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  updateClaude("2.1.304");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "ping" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  // Rhodium upgraded, its rh-hold now in another place; w/a's holder runs on from the old one.
  await rhodium.kill9();
  const toml = readFileSync(rhodium.config, "utf8");
  const old = toml.match(/^holdBin = "(.*)"$/m)![1]!;
  const fresh = join(rhodium.dir, "bin/rh-hold");
  writeFileSync(fresh, `#!/bin/sh\nexec ${old} "$@"\n`, { mode: 0o755 });
  writeFileSync(rhodium.config, toml.replace(old, fresh));
  await rhodium.start();
  const upgraded = await rhodium.ok("doctor");
  expect(upgraded).toContain(`告警：还在跑旧版的托管进程：w/a（${old}）`);
  expect(upgraded).toMatch(/^out\.log 共 \d+\.\dMB，最大的是 w\/a 的 \d+\.\dMB$/m);
  expect(upgraded).not.toContain("错误");

  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.units()).length === 0, 15_000);
  expect(await rhodium.ok("doctor")).not.toContain("托管进程");

  // As if its end had never been recorded.
  const db = new Database(join(rhodium.dir, "state/rh.db"));
  db.run("UPDATE holder SET exited = 0");
  db.close();
  expect(await rhodium.ok("doctor")).toMatch(new RegExp(`^错误：库里有、systemd 里没有的托管进程：w/a（${rhodium.unitPrefix}hold-\\w+）$`, "m"));
});

test("a holder whose exit an older rhodium left off the record, its unit gone, is settled at startup before rh doctor can run (2026-10-22)", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "ping" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  // The slot moves on, stopping the agent; an older rhodium did not record that agent's exit.
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/new" });
  await until(async () => (await rhodium.units()).length === 0, 15_000);
  await rhodium.kill9();
  let db = new Database(join(rhodium.dir, "state/rh.db"));
  const [left] = db.query<{ conversation: string }, []>("SELECT conversation FROM holder").all();
  db.run("UPDATE holder SET exited = 0");
  db.close();

  await rhodium.start();
  expect((await rhodium.ok("doctor")).split("\n").filter((l) => l.includes("托管进程"))).toEqual([]);
  db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT exited FROM holder").all()).toEqual([{ exited: 1 }]);
  expect(db.query("SELECT source, json_extract(data, '$.conversation') AS conversation FROM event WHERE type = 'holder_gone'").all()).toEqual([
    { source: "recovery", conversation: left!.conversation },
  ]);
  db.close();
});

test("at startup, a holder whose unit still runs stays on record as running, even on a slot recover does not take over (2026-10-22)", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "ping" });
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  // The agent runs on through the restart; its slot is off, so recover does not take it over.
  await rhodium.kill9();
  let db = new Database(join(rhodium.dir, "state/rh.db"));
  db.run("UPDATE slot SET state = 'off'");
  db.close();

  await rhodium.start();
  expect(await rhodium.units()).toHaveLength(1);
  expect((await rhodium.ok("doctor")).split("\n").filter((l) => l.includes("托管进程"))).toEqual([]);
  db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  expect(db.query("SELECT exited FROM holder").all()).toEqual([{ exited: 0 }]);
  expect(db.query("SELECT type FROM event WHERE type = 'holder_gone'").all()).toEqual([]);
  db.close();
});

test("story 152: Herdr's resume_agents_on_restore, on as by default, can resume a conversation beside Rhodium's: rh doctor asks you to turn it off", async () => {
  rhodium = newInstance({ herdr: true });
  await rhodium.start();
  updateClaude("2.1.304");
  const out = await rhodium.ok("doctor");
  expect(out).toMatch(/^Herdr 0\.9\.1（protocol 22）$/m);
  expect(out).toMatch(/^告警：Herdr 的 resume_agents_on_restore 开着.*\[session\] resume_agents_on_restore = false/m);

  // Turned off in your Herdr config, which Rhodium only reads. Put back as it was for cleanup's check.
  const file = join(rhodium.home, ".config/herdr/config.toml");
  const was = readFileSync(file, "utf8");
  writeFileSync(file, `${was}[session]\nresume_agents_on_restore = false\n`);
  try {
    expect(await rhodium.ok("doctor")).not.toContain("resume_agents_on_restore");
  } finally {
    writeFileSync(file, was);
  }
});

test("rh doctor warns of a Herdr whose protocol is not the one the Herdr bridge was written for, or that is not running", async () => {
  rhodium = newInstance({ herdr: { protocol: 23 } });
  await rhodium.start();
  updateClaude("2.1.304");
  expect(await rhodium.ok("doctor")).toMatch(/^告警：Herdr 的协议版本是 23，Herdr 桥是照 22 写的/m);

  await rhodium.herdr.stop();
  expect(await rhodium.ok("doctor")).toMatch(/^告警：连不上 Herdr，没核对它的协议版本：Herdr 会话 \S+ 没在运行$/m);
});

test("story 587: without Herdr installed, rh doctor checks no Herdr: neither that it cannot reach it nor its auto-resume", async () => {
  rhodium = newInstance();
  rmSync(join(rhodium.dir, "bin/herdr"));
  await rhodium.start();
  expect(await rhodium.ok("doctor")).not.toContain("Herdr");
});

test("anyone may run rh doctor, as it changes nothing: a caller rh cannot recognize, as an agent running deploy/upgrade.sh is, and a slot's agent", async () => {
  const script: Script = { on, steps: [...startTurn, { rh: ["doctor"] }, ...endTurn("done")] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script } });
  await rhodium.start();
  await rhodium.slots("a");

  // No token, no terminal.
  const unknown = await rhodium.rh(["doctor"], { tty: false });
  expect({ code: unknown.code, err: unknown.err }).toEqual({ code: 0, err: "" });
  expect(unknown.out).toMatch(/^磁盘剩余 /m);

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "check" });
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text === "done"), 15_000);
  const [call] = rhodium.claude.runs()[0]!.rh;
  expect({ args: call!.args, code: call!.code, err: call!.err }).toEqual({ args: ["doctor"], code: 0, err: "" });
  expect(call!.out).toMatch(/^磁盘剩余 /m);
}, 30_000);

// ---- Codex (architecture §12, spec codex.md story 510) ----

/** A recording of rh doctor's checks on real codex 0.162.1 (scripts/probes/codex/probe.ts doctor*). */
const recorded = (name: string): FakeAgentConfig => ({ replay: join(import.meta.dir, "fixtures/codex", name) });
/** Makes the fake codex replay or play this from its next run on. */
const codexAs = (config: FakeAgentConfig) => installFakeAgent(join(rhodium.dir, "bin"), config, "codex");
/** What rh doctor says, after the checks of a healthy claude. */
async function doctor(opts: Parameters<typeof newInstance>[0] = {}) {
  rhodium = newInstance(opts);
  await rhodium.start();
  updateClaude("2.1.304");
  return rhodium.ok("doctor");
}

test("story 510: rh doctor writes codex's version and ChatGPT login, keeps its models, and finds untrusted still taken, calling no model", async () => {
  const out = await doctor({ codex: recorded("doctor"), env: { ANTHROPIC_API_KEY: "sk-ant" } });
  expect(out).toMatch(/^Codex 0\.162\.1（第一次核对）$/m);
  expect(out).toMatch(/^Codex 登录：ChatGPT（plus）$/m);
  expect(out).not.toContain("错误");
  // No turn, and a thread that is never written down; Codex as a slot's runs, without Claude's keys.
  const [run, ...more] = rhodium.codex.runs();
  expect(more).toEqual([]);
  const sent = run!.stdin.map((l) => JSON.parse(l));
  expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "account/read", "model/list", "thread/start"]);
  expect(sent.at(-1).params).toMatchObject({ ephemeral: true, approvalPolicy: "untrusted", sandbox: "danger-full-access" });
  expect(Object.keys(run!.env).filter((k) => /^(ANTHROPIC|CLAUDE)/.test(k))).toEqual([]);
  // The models' names, for naming a remembered one while Codex is not running.
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE id = 'codexModels'").get();
  db.close();
  expect(JSON.parse(row!.value)).toMatchObject({ "gpt-6.1-sol": "GPT-6.1-Sol", "gpt-6-luna": "GPT-6-Luna", default: "默认（GPT-6.1-Sol）" });
});

test("story 510: an API key login is no error; no login at all is, saying how to log in", async () => {
  const key = await doctor({ codex: recorded("doctor-api-key") });
  expect(key).toMatch(/^Codex 登录：API key，按用量计费$/m);
  expect(key).not.toContain("错误");

  codexAs(recorded("doctor-logged-out"));
  const none = await rhodium.ok("doctor");
  expect(none).toMatch(/^错误：Codex 没有登录，也没有配自定义服务商。在终端里运行 codex login/m);
  expect(none).not.toContain("Codex 登录：");
});

test("#435: a provider of your own in codex's config is a login, by its name and host; the variable its key comes from must be in the service's environment", async () => {
  const unset = await doctor({ codex: recorded("doctor-provider") });
  expect(unset).toMatch(/^Codex 登录：自定义服务商（acme，llm\.acme\.invalid），按服务商计费$/m);
  // By name only; the service never sees what your shell exports.
  const error = unset.match(/^错误：.*ACME_API_KEY.*$/m)?.[0];
  for (const said of ["服务", ".zshrc", "auth"]) expect(error).toContain(said);

  await rhodium.stop();
  rhodium.env.ACME_API_KEY = "sk-acme-secret";
  await rhodium.start();
  codexAs(recorded("doctor-provider"));
  const set = await rhodium.ok("doctor");
  expect(set).toMatch(/^Codex 登录：自定义服务商（acme，llm\.acme\.invalid），按服务商计费$/m);
  expect(set).not.toContain("错误");
  expect(set).not.toContain("sk-acme-secret");
});

test("stories 498, 510: a codex that no longer takes untrusted is an error: Codex slots with approval on cannot start", async () => {
  const out = await doctor({ codex: { script: "codex-no-untrusted" } });
  expect(out).toMatch(/^错误：Codex 这一版不再接受“每条都问”的审批设置.*unknown variant `untrusted`.*审批开的 Codex 槽位起不来/m);
});

test("story 510: a codex of another version than the last check's is a warning, once; with no codex installed there is no Codex section", async () => {
  expect(await doctor()).toMatch(/^Codex 0\.162\.1（第一次核对）$/m);

  codexAs({ script: "codex-turn", version: "0.163.0" });
  const changed = await rhodium.ok("doctor");
  expect(changed).toMatch(/^Codex 0\.163\.0（上次核对的是 0\.162\.1）$/m);
  expect(changed).toMatch(/^告警：Codex 从 0\.162\.1 换成了 0\.163\.0.*scripts\/probes\/codex\//m);
  const again = await rhodium.ok("doctor");
  expect(again).toMatch(/^Codex 0\.163\.0$/m);
  expect(again).not.toContain("告警：Codex");

  rmSync(rhodium.codex.path);
  expect(await rhodium.ok("doctor")).not.toMatch(/codex/i);
});
