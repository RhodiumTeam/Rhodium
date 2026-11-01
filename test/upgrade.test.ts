// deploy/upgrade.sh (story 149, architecture §12): upgrading an instance in one command. The test
// instance runs as a systemd user service from <opt>/current. upgrade.sh runs from a clone of a
// throwaway repository, as you run it from yours; each commit there carries a stand-in for
// scripts/build.sh that makes its "version" a rhodium running this checkout with bun.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { updateClaude } from "./claude-update";
import { exec, mainPid, newInstance, run, systemctl, until, type Instance } from "./instance";

const script = join(import.meta.dir, "../deploy/upgrade.sh");
const main = join(import.meta.dir, "../src/main.ts");

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

const opt = () => join(rhodium.dir, "opt");
const current = () => readlinkSync(join(opt(), "current"));
const answers = async () => (await rhodium.rh(["ls"])).code === 0;
/** Where upgrade.sh makes its temporary checkout (TMPDIR). */
const tmp = () => join(rhodium.dir, "tmp");
/** origin: a bare repository, as GitHub is. upstream: where PRs get merged and pushed to origin.
 *  checkout: your clone, which upgrade.sh runs from; it learns of new commits only by fetching. */
const origin = () => join(rhodium.dir, "origin.git");
const upstream = () => join(rhodium.dir, "upstream");
const checkout = () => join(rhodium.dir, "checkout");

/** git, with the sandbox HOME, so none of your git config applies. */
const git = (cwd: string, ...args: string[]) =>
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, env: rhodium.env });

/** A scripts/build.sh whose rhodium runs this checkout. broken: one whose daemon exits at once, as a
 *  release that cannot start would. migrating: one whose daemon moves the database to schema 1000
 *  and then exits, as a release that migrates the database and then crashes would. unbuildable: a
 *  build that fails. */
type Kind = "good" | "broken" | "migrating" | "unbuildable";
function buildScript(kind: Kind): string {
  if (kind === "unbuildable") return "#!/bin/sh\necho 'cannot build' >&2\nexit 1\n";
  const migrate = join(rhodium.dir, "migrate.ts");
  writeFileSync(migrate, `new (require("bun:sqlite").Database)(${JSON.stringify(join(rhodium.dir, "state/rh.db"))}).run("PRAGMA user_version = 1000");\n`);
  const daemon = { good: "", broken: "exit 1", migrating: `${process.execPath} ${migrate}; exit 1` }[kind];
  const rhodiumScript =
    `[ "\${0##*/}" = rh ] && set -- rh "$@"\n` +
    (daemon && `case $1 in rh|--version|--schema) ;; *) ${daemon} ;; esac\n`) +
    `exec ${process.execPath} ${main} "$@"\n`;
  // Where scripts/build.sh bakes in the commit and upgrade.sh's note, this rhodium sets them for the source it runs.
  const bake = `printf "export RHODIUM_BUILD_COMMIT='%s' RHODIUM_BUILD_NOTE='%s'\\n" "$(git -C "$(dirname "$0")/.." describe --always)" "$RHODIUM_BUILD_NOTE"`;
  return `#!/bin/sh\n{ echo '#!/bin/sh'; ${bake}; cat <<'EOF'\n${rhodiumScript}EOF\n} >"$1/rhodium"\nchmod +x "$1/rhodium"\n`;
}

/** Merges a commit whose scripts/build.sh builds that kind of rhodium into origin's main, as merging
 *  a PR on GitHub does. Returns its short hash. */
async function merge(kind: Kind): Promise<string> {
  writeFileSync(join(upstream(), "scripts/build.sh"), buildScript(kind), { mode: 0o755 });
  await git(upstream(), "add", "-A");
  await git(upstream(), "commit", "--quiet", "--allow-empty", "-m", kind);
  await git(upstream(), "push", "--quiet", "origin", "HEAD:main");
  return (await git(upstream(), "rev-parse", "--short", "HEAD")).trim();
}

/** The three repositories, origin's main holding a good build and the upgrade.sh under test. */
async function repositories(): Promise<void> {
  mkdirSync(tmp());
  await git(rhodium.dir, "init", "--quiet", "--bare", origin());
  await git(rhodium.dir, "clone", "--quiet", origin(), upstream());
  mkdirSync(join(upstream(), "deploy"));
  mkdirSync(join(upstream(), "scripts"));
  copyFileSync(script, join(upstream(), "deploy/upgrade.sh"));
  await merge("good");
  await git(rhodium.dir, "clone", "--quiet", origin(), checkout());
}

/** Runs your clone's upgrade.sh for the instance, with no terminal, as the dev agent runs it once a
 *  PR is merged (deploy/README.md). */
async function upgrade(ref?: string, note?: string) {
  // RHODIUM_SOCKET as your shell may have it, for another instance: upgrade.sh must not use it.
  const env = {
    ...rhodium.env,
    RHODIUM_SOCKET: join(rhodium.dir, "another-instance.sock"),
    RHODIUM_OPT: opt(),
    RHODIUM_UPGRADE_SOCKET: rhodium.socket,
    TMPDIR: tmp(),
  };
  const argv = [...(note === undefined ? [] : ["-m", note]), `${rhodium.unitPrefix}rhodium`, ...(ref === undefined ? [] : [ref])];
  return exec([join(checkout(), "deploy/upgrade.sh"), ...argv], { env, timeoutMs: 120_000 });
}

/** upgrade.sh's stderr but for systemd's warning that the unit changed on disk. Nothing of this
 *  instance changed: tests share the user manager, and another test's `systemctl enable` or `disable`
 *  (rhodium-service.sh) marks every unit of it as needing a daemon-reload, till the reload systemctl
 *  does a moment later (systemd 255's unit_file_state_outdated). A restart in between warns. */
const stderr = (r: { err: string }) =>
  r.err.replace(/^Warning: The unit file, source configuration file or drop-ins of \S+ changed on disk\. Run 'systemctl --user daemon-reload' to reload units\.\n/gm, "");

/** No temporary checkout is left: neither its directory nor git's record of it. */
async function noCheckoutLeft(): Promise<void> {
  expect(readdirSync(tmp())).toEqual([]);
  expect((await git(checkout(), "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
}

/** The first version, installed before the service is, and the service running it. */
async function firstInstall(): Promise<{ unit: string; first: string }> {
  await repositories();
  const r = await upgrade();
  expect(r).toMatchObject({ code: 0 });
  const first = current();
  expect(first).toStartWith(`versions/${version}-`);
  const unit = await rhodium.installService([], [join(opt(), "current/rhodium")]);
  await until(answers);
  return { unit, first };
}

test("story 149: upgrade.sh installs origin/main as it is after a fetch, switches the service to it once rh doctor finds no error, and keeps the one before", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  const { unit, first } = await firstInstall();
  const pid = await mainPid(unit);
  const merged = await merge("good"); // your clone has not fetched it

  const r = await upgrade();
  expect(stderr(r)).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`Claude 2.1.304`); // rh doctor's report
  expect(current()).toStartWith(`versions/${version}-${merged}-`);
  expect(readlinkSync(join(opt(), "previous"))).toBe(first);
  expect(existsSync(join(opt(), current(), "rh"))).toBe(true);
  expect(await mainPid(unit)).not.toBe(pid);
  expect(await answers()).toBe(true);
  await noCheckoutLeft();
}, 30_000);

test("once upgraded, rhodium says its version and commit in the main chat, with upgrade.sh -m's note if given, and not again on a restart (2026-10-23)", async () => {
  const ME = "you-openid";
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME } }, toml: `mainChat = "q/${ME}"` });
  updateClaude(rhodium, "2.1.304");
  const said = async (n: number) => {
    await until(async () => (await rhodium.im.log("q", ME)).length >= n, 15_000);
    return (await rhodium.im.log("q", ME)).map((p) => p.text);
  };
  const { unit, first } = await firstInstall();
  const installed = first.slice(`versions/${version}-`.length).split("-")[0];
  expect(await said(1)).toEqual([`升级到 ${version}（${installed}）。`]);

  const merged = await merge("good");
  expect((await upgrade(undefined, "每回合第一行带发送时间")).code).toBe(0);
  expect(await said(2)).toEqual([`升级到 ${version}（${installed}）。`, `升级到 ${version}（${merged}）：每回合第一行带发送时间`]);
  expect(current().split("-")).toHaveLength(3); // <version>-<commit>-<random>: the commit rhodium --version says, once

  await systemctl("restart", unit);
  await until(answers);
  await Bun.sleep(500);
  expect(await rhodium.im.log("q", ME)).toHaveLength(2);
}, 60_000);

test("story 149: upgrade.sh <instance> <git ref> installs that commit, built by its own scripts/build.sh", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  await firstInstall();
  const good = await merge("good");
  await merge("unbuildable"); // origin/main, which upgrade.sh does not build

  const r = await upgrade(good);
  expect(r.code).toBe(0);
  expect(current()).toStartWith(`versions/${version}-${good}-`);
  await noCheckoutLeft();
}, 30_000);

test("story 149: when the build fails, upgrade.sh changes nothing, leaves no temporary checkout, and fails", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  const { first } = await firstInstall();
  await merge("unbuildable");

  const r = await upgrade();
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot build");
  expect(current()).toBe(first);
  expect(readdirSync(join(opt(), "versions"))).toEqual([first.slice("versions/".length)]);
  expect(await answers()).toBe(true);
  await noCheckoutLeft();
}, 30_000);

test("story 149: upgrade.sh fails on a git ref there is no commit for, changing nothing", async () => {
  rhodium = newInstance();
  const { first } = await firstInstall();

  const r = await upgrade("no-such-ref");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no-such-ref");
  expect(current()).toBe(first);
  await noCheckoutLeft();
}, 30_000);

test("story 149: when rh doctor reports an error after the upgrade, upgrade.sh goes back to the version before and fails", async () => {
  rhodium = newInstance(); // its fake claude is not one rh doctor can check: an error
  const { unit, first } = await firstInstall();
  const pid = await mainPid(unit);
  await merge("good");

  const r = await upgrade();
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/^错误：/m);
  expect(r.err).toContain(`going back to ${first.slice("versions/".length)}`);
  expect(current()).toBe(first);
  expect(existsSync(join(opt(), "previous"))).toBe(false);
  expect(await mainPid(unit)).not.toBe(pid);
  expect(await answers()).toBe(true);
}, 30_000);

test("ADR-0013: when rh doctor's only errors are of the board, which going back fixes none of, upgrade.sh keeps the new version", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace("[board]\n", '[board]\nauth = "cloudflare"\n'));
  await firstInstall();
  const merged = await merge("good");

  const r = await upgrade();
  expect(r.out).toMatch(/^错误：看板关着/m);
  expect(r.code).toBe(0);
  expect(current()).toStartWith(`versions/${version}-${merged}-`);
}, 30_000);

test("#435: when rh doctor's only errors are of your codex, which going back fixes none of, upgrade.sh keeps the new version", async () => {
  rhodium = newInstance({ codex: { script: "codex-no-untrusted" } });
  updateClaude(rhodium, "2.1.304");
  await firstInstall();
  const merged = await merge("good");

  const r = await upgrade();
  expect(r.out).toMatch(/^错误：Codex /m);
  expect(r.code).toBe(0);
  expect(current()).toStartWith(`versions/${version}-${merged}-`);
}, 30_000);

test("story 149: when the new rhodium cannot start, upgrade.sh goes back to the version before, even once systemd has given up on it", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  const { first } = await firstInstall();
  await merge("broken");

  const r = await upgrade();
  expect(r.code).toBe(1);
  expect(r.err).toContain("does not work");
  expect(current()).toBe(first);
  expect(await answers()).toBe(true);
}, 40_000);

test("story 149: when the new rhodium has migrated the database and then fails, upgrade.sh keeps it, since the version before cannot open that database, and fails", async () => {
  rhodium = newInstance();
  updateClaude(rhodium, "2.1.304");
  const { first } = await firstInstall();
  await merge("migrating");

  const r = await upgrade();
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/schema \d+ to 1000/);
  expect(r.err).not.toContain("going back");
  expect(current()).not.toBe(first);
}, 40_000);
