// The native credential reader is supplied separately; exercise the importer at its three-state boundary.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isWindowsAgentNodeEntry } from "../src/windows-tui-launch";
import { inspectPaneAgent } from "../src/tui";

const pane = "w2:p7";
const session = "12345678-0000-4000-a000-000000000001";
const live = { name: "node", argv: ["pi"], pid: process.pid, cwd: process.cwd() };

test("the live pi selected by Herdr is admitted only on an explicit clean result", async () => {
  for (const result of [true, false, null]) {
    const checked: number[] = [];
    const target = inspectPaneAgent("pi", pane, session, [live], async pid => { checked.push(pid); return result; });
    if (result === false) {
      const got = await target;
      expect(got).toMatchObject({ pid: live.pid, dir: live.cwd });
      expect(got.start).toBeGreaterThan(0);
    } else {
      await expect(target).rejects.toThrow(result === true ? "带着 Anthropic 的凭据" : "读不到 pane");
    }
    expect(checked).toEqual([live.pid]);
  }
});

test("Claude skips the pi-only check", async () => {
  const never = async () => { throw new Error("unexpected pi check"); };
  expect(await inspectPaneAgent("claude", pane, session, [{ ...live, name: "claude", argv: [] }], never)).toMatchObject({ pid: live.pid });
});

test("npm foreground matching accepts only the bin declared by the reported agent's package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-pane-npm-"));
  try {
    const entry = join(dir, "cli.js"), other = join(dir, "pi-launcher.js");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.js" } }));
    writeFileSync(entry, "");
    writeFileSync(other, "");
    expect(isWindowsAgentNodeEntry("pi", entry)).toBe(true);
    expect(isWindowsAgentNodeEntry("pi", other)).toBe(false);
    expect(isWindowsAgentNodeEntry("claude", entry)).toBe(false);
    if (process.platform === "win32") {
      const f = { ...live, name: "node.exe", argv: ["node.exe", entry] };
      expect(await inspectPaneAgent("pi", pane, session, [f], async () => false)).toMatchObject({ pid: f.pid });
      await expect(inspectPaneAgent("pi", pane, session, [{ ...f, argv: ["node.exe", other, entry] }], async () => false)).rejects.toThrow("已经退出");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
