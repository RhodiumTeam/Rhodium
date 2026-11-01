// Self-test of the seam one tool (test/instance.ts): every capability it offers works.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, newInstance, until, type Instance } from "./instance";

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

const connected = (...bots: string[]) => async () =>
  (await Promise.all(bots.map((b) => rhodium.im.connected(b)))).every(Boolean);

test("one run through the whole tool: start, fake IM, rh, kill -9 and restart, no units left", async () => {
  rhodium = newInstance({ bots: { q: "qq", t: "telegram" } });
  await rhodium.start();
  await until(connected("q", "t"));
  expect((await rhodium.rh(["ws", "w", rhodium.dir])).code).toBe(0);

  await rhodium.kill9();
  await until(async () => !(await rhodium.im.connected("q")) && !(await rhodium.im.connected("t")));
  expect((await rhodium.rh(["ws"])).code).toBe(1); // nobody on the socket

  await rhodium.start();
  await until(connected("q", "t"));
  expect((await rhodium.rh(["ws"])).out).toMatch(new RegExp(`^w +${rhodium.dir}$`, "m"));

  // A holder unit as rhodium launches one, still running when the test ends.
  const unit = `${rhodium.unitPrefix}hold-x`;
  expect((await exec(["systemd-run", "--user", "--quiet", `--unit=${unit}`, "sleep", "300"])).code).toBe(0);
  expect(await rhodium.units()).toEqual([`${unit}.service`]);

  await rhodium.cleanup();
  expect(await rhodium.units()).toEqual([]);
});

test("rhodium's claude, pi, codex and herdr are the instance's fakes, the agents playing the script the test gave", async () => {
  rhodium = newInstance({ claude: { script: { steps: [{ emit: ["hi from fake claude"] }] } } });
  const d = await rhodium.start();
  const herdr = join(dirname(rhodium.claude.path), "herdr");
  expect(d.logs.find((l) => l.msg === "ready")?.programs).toEqual({ claude: rhodium.claude.path, pi: rhodium.pi.path, codex: rhodium.codex.path, herdr });
  expect((await exec([rhodium.claude.path])).out).toBe("hi from fake claude\n");
});

test("story 156: rhodium's HOME is a sandbox holding ~/.claude settings and a Herdr config", async () => {
  rhodium = newInstance();
  const d = await rhodium.start();
  expect(readFileSync(`/proc/${d.proc.pid}/environ`, "utf8").split("\0")).toContain(`HOME=${rhodium.home}`);
  for (const f of [".claude/settings.json", ".config/herdr/config.toml"]) {
    expect(readFileSync(join(rhodium.home, f), "utf8")).not.toBe("");
  }
});

test("story 156: rhodium sees nothing of the Herdr pane or Claude session the tests run in", async () => {
  const leak = { HERDR_SOCKET_PATH: "/x/herdr.sock", HERDR_PANE_ID: "p1", CLAUDE_CONFIG_DIR: "/x/.claude", CLAUDECODE: "1" };
  const saved = Object.fromEntries(Object.keys(leak).map((k) => [k, process.env[k]]));
  Object.assign(process.env, leak);
  try {
    rhodium = newInstance();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const d = await rhodium.start();
  const names = readFileSync(`/proc/${d.proc.pid}/environ`, "utf8").split("\0").map((kv) => kv.split("=")[0]);
  expect(names.filter((n) => /^(HERDR_|CLAUDE)/.test(n!))).toEqual([]);
});

test.each([".claude/settings.json", ".config/herdr/config.toml"])(
  "story 156: cleanup fails when the sandbox's %s was changed",
  async (file) => {
    rhodium = newInstance();
    await rhodium.start();
    appendFileSync(join(rhodium.home, file), "\n");
    await expect(rhodium.cleanup()).rejects.toThrow(file);
    expect(existsSync(rhodium.dir)).toBe(false); // it still cleaned up
  },
);
