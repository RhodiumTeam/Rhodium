// The memory cap on every bun test process (test/cap.ts, docs/agents/testing.md): one that runs away
// is killed alone, not the unit it was started from.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exec, until } from "./instance";

/** The cgroup this process is in, as a path under /sys/fs/cgroup. */
const cgroup = () => readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]!;

test("this test process runs in a systemd scope of its own, its memory capped at 8G with no swap", () => {
  const dir = join("/sys/fs/cgroup", cgroup());
  expect(dir).toEndWith(`/rhodium-test-capped-${process.pid}.scope`);
  expect([readFileSync(join(dir, "memory.max"), "utf8").trim(), readFileSync(join(dir, "memory.swap.max"), "utf8").trim()]).toEqual([String(8 * 2 ** 30), "0"]);
});

test("a bun test that runs over its cap is killed by the kernel, and only it: this process goes on", async () => {
  const hog = Bun.spawn([process.execPath, "test", "./test/fixtures/cap/hog.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, RHODIUM_TEST_MEMORY_MAX: String(256 * 2 ** 20) },
    stdout: "ignore",
    stderr: "ignore",
  });
  await hog.exited;
  expect(hog.signalCode).toBe("SIGKILL");
  // The kernel did it, in the hog's own scope.
  const unit = `rhodium-test-capped-${hog.pid}.scope`;
  await until(async () => (await exec(["journalctl", "--user", "--no-pager", "-o", "cat", "-u", unit])).out.includes("killed by the OOM killer"), 5_000);
}, 30_000);
