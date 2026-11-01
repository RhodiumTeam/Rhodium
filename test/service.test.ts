// rhodium as a systemd user service (product §10), installed under a test prefix.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec, mainPid, newInstance, systemctl, until, type Instance } from "./instance";

const script = join(import.meta.dir, "../scripts/rhodium-service.sh");
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user");

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

const answers = async () => (await rhodium.rh(["ls"])).code === 0;

test("story 148: the service is enabled at boot and comes back after kill -9", async () => {
  rhodium = newInstance();
  const unit = await rhodium.installService();
  expect(unit).toBe(`${rhodium.unitPrefix}rhodium`);
  expect(await systemctl("is-enabled", unit)).toBe("enabled");
  await until(answers);

  const pid = await mainPid(unit);
  expect(pid).toBeGreaterThan(0);
  process.kill(pid, "SIGKILL"); // only the PID systemd gave for our own unit
  await until(async () => ![0, pid].includes(await mainPid(unit)), 8_000);
  await until(answers);

  await rhodium.cleanup();
  expect(await rhodium.units()).toEqual([]);
  expect(existsSync(join(unitDir, `${unit}.service`))).toBe(false);
}, 20_000);

test("the unit runs rhodium by absolute paths with an explicit PATH", async () => {
  rhodium = newInstance();
  const unit = await rhodium.installService();
  const text = readFileSync(join(unitDir, `${unit}.service`), "utf8");
  expect(text).toContain(`ExecStart="${process.execPath}" `);
  expect(text).toMatch(/^Environment="PATH=\/[^"]*"$/m);
  expect(text).toContain("Restart=on-failure");
});

const install = (unit: string, path = "/usr/bin:/bin") =>
  exec([script, "install", unit, "--config", "/x/config.toml", "--path", path, "--", process.execPath]);

test("install refuses a PATH entry that is not absolute", async () => {
  rhodium = newInstance();
  const r = await install(`${rhodium.unitPrefix}rhodium`, "/usr/bin:bin");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("bin");
  expect(existsSync(join(unitDir, `${rhodium.unitPrefix}rhodium.service`))).toBe(false);
});

test("install and uninstall leave alone a unit file the script did not write", async () => {
  rhodium = newInstance();
  const unit = `${rhodium.unitPrefix}theirs`;
  const file = join(unitDir, `${unit}.service`);
  writeFileSync(file, "[Service]\nExecStart=/bin/true\n");
  try {
    expect((await install(unit)).code).not.toBe(0);
    expect((await exec([script, "uninstall", unit])).code).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  } finally {
    rmSync(file, { force: true });
  }
});

/** The alert's environment file, mode 0600, pointing at a Telegram Bot API at api. */
function alertEnv(api: string, mode = 0o600): string {
  const file = join(rhodium.dir, "alert.env");
  writeFileSync(file, `TELEGRAM_TOKEN=123:abc\nTELEGRAM_CHAT_ID=42\nTELEGRAM_API=${api}\n`, { mode });
  return file;
}

test("story 134: with the config broken so rhodium cannot start, the alert unit still sends you a Telegram alert", async () => {
  const got: { path: string; form: URLSearchParams }[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, form: new URLSearchParams(await req.text()) });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  try {
    rhodium = newInstance();
    const unit = await rhodium.installService(["--alert-env", alertEnv(`http://127.0.0.1:${api.port}`)]);
    await until(answers);
    // A crash it comes back from alerts no one.
    const pid = await mainPid(unit);
    process.kill(pid, "SIGKILL");
    await until(async () => ![0, pid].includes(await mainPid(unit)), 8_000);
    await until(answers);
    expect(got).toEqual([]);

    writeFileSync(rhodium.config, "this is not [toml\n");
    process.kill(await mainPid(unit), "SIGKILL");
    // It restarts and fails each time, till systemd gives up on it.
    await until(() => got.length > 0, 20_000);
    expect(await systemctl("show", "--property=ActiveState", "--value", unit)).toBe("failed");
    expect(got.map((g) => g.path)).toEqual(["/bot123:abc/sendMessage"]);
    expect(got[0]!.form.get("chat_id")).toBe("42");
    expect(got[0]!.form.get("text")).toContain(unit);

    await rhodium.cleanup();
    expect(existsSync(join(unitDir, `${unit}-alert.service`))).toBe(false);
  } finally {
    api.stop(true);
  }
}, 30_000);

test("the alert retries a failed send, and installing again without --alert-env takes the alert unit away", async () => {
  rhodium = newInstance();
  const unit = await rhodium.installService(["--alert-env", alertEnv("http://127.0.0.1:1")]);
  const alert = join(unitDir, `${unit}-alert.service`);
  expect(readFileSync(alert, "utf8")).toMatch(/^ExecStart=\/usr\/bin\/curl .*--retry 3 --retry-all-errors /m);

  await rhodium.installService();
  expect(existsSync(alert)).toBe(false);
  expect(readFileSync(join(unitDir, `${unit}.service`), "utf8")).not.toContain("OnFailure=");
}, 30_000); // two daemon-reloads, which wait on every other test's under load

test("install refuses an alert environment file others can read: it holds a bot token", async () => {
  rhodium = newInstance();
  const unit = `${rhodium.unitPrefix}rhodium`;
  const r = await exec([script, "install", unit, "--config", "/x/config.toml", "--path", "/usr/bin:/bin", "--alert-env", alertEnv("http://127.0.0.1:1", 0o644), "--", process.execPath]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("0600");
  expect(existsSync(join(unitDir, `${unit}.service`))).toBe(false);
});
