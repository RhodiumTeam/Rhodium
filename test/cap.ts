// Loaded by bunfig.toml before every bun test process runs a test: it moves the process into a systemd
// scope of its own, rhodium-test-capped-<pid>.scope, its memory capped with no swap (#277). One that
// runs away is killed there alone, not the unit it was started from (Herdr's, an agent's holder), and
// what it starts is in the scope with it, Chromium's renderers included; Chromium's main process moves
// itself to a scope of its own, out of the cap but out of Herdr's and the holder's units too.
// test/cap.test.ts checks it.
import { readFileSync } from "node:fs";

// 8G: a whole test file with Chromium peaks near 3G. RHODIUM_TEST_MEMORY_MAX (bytes) is for test/cap.test.ts.
const max = process.env.RHODIUM_TEST_MEMORY_MAX ?? String(8 * 2 ** 30);
const unit = `rhodium-test-capped-${process.pid}.scope`;
const inScope = () => readFileSync("/proc/self/cgroup", "utf8").trim().endsWith(`/${unit}`);

// A worker of bun test --parallel loads this again for each file it runs, by then in its scope.
if (!inScope()) {
  // What systemd-run --scope does for itself, done for this process, which is already running.
  const call = Bun.spawn(["busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
    "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail",
    "4", "PIDs", "au", "1", String(process.pid), "MemoryMax", "t", max, "MemorySwapMax", "t", "0", "CollectMode", "s", "inactive-or-failed",
    "0"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if ((await call.exited) !== 0) throw new Error(`test/cap.ts: no memory cap for this test run: ${(await new Response(call.stderr).text()).trim()}`);
  // The call returns with the job queued; the process is moved once it runs.
  for (const end = Date.now() + 5_000; !inScope(); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error(`test/cap.ts: not moved into ${unit} after 5 s`);
  }
}
