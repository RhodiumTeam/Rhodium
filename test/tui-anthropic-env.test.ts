// The credential check before importing a pi from its pane (issue #811): which environments count as
// holding Anthropic credentials, and that one that can't be read is reported as such, not as clean.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { piPaneHasCredentials } from "../src/pi-pane-credentials";

/** A sleeping process with exactly this environment, once it has exec'd. */
async function withEnv(env: Record<string, string>, f: (pid: number) => Promise<void>) {
  const p = Bun.spawn(["sleep", "30"], { env });
  try {
    while (!readFileSync(`/proc/${p.pid}/cmdline`, "utf8").startsWith("sleep")) await Bun.sleep(5);
    await f(p.pid);
  } finally {
    p.kill();
  }
}

test.skipIf(process.platform !== "linux")("a set Anthropic variable counts, an empty one does not", async () => {
  await withEnv({ PATH: process.env.PATH!, ANTHROPIC_API_KEY: "k" }, async (pid) => { expect(await piPaneHasCredentials(pid)).toBe(true); });
  await withEnv({ PATH: process.env.PATH!, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "" }, async (pid) => { expect(await piPaneHasCredentials(pid)).toBe(false); });
  await withEnv({ PATH: process.env.PATH!, ANTHROPIC_MODEL: "x" }, async (pid) => { expect(await piPaneHasCredentials(pid)).toBe(false); });
});

test("a process whose environment can't be read gives null", async () => {
  expect(await piPaneHasCredentials(2 ** 31 - 1)).toBeNull();
});
