import { restoredShell } from "../src/tui";
// Read only the test's own child. No agent, pane or user session is needed.
import { expect, test } from "bun:test";
import { basename } from "node:path";
import { nativeProcess } from "../src/tui-process";

test.skipIf(!["darwin", "win32"].includes(process.platform))("TUI process identity lasts from child launch until exit", async () => {
  const before = Date.now();
  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  try {
    const found = nativeProcess(child.pid);
    expect(found).not.toBeNull();
    expect(found!.ppid).toBe(process.pid);
    expect(found!.state).not.toBe("Z");
    expect(basename(found!.exe).toLowerCase()).toBe(basename(process.execPath).toLowerCase());
    expect(Number.isSafeInteger(found!.start)).toBe(true);
    expect(found!.start / 1000).toBeGreaterThanOrEqual(before - 1000);
    expect(found!.start / 1000).toBeLessThanOrEqual(Date.now() + 1000);
    expect(nativeProcess(child.pid)?.start).toBe(found!.start);
  } finally {
    child.stdin.end();
    await child.exited;
  }
  const after = nativeProcess(child.pid);
  expect(after === null || after.state === "Z").toBe(true);
});

test("a restored Windows tab without a PID receipt closes only when Herdr reports no agent", () => {
  expect(restoredShell({}, undefined, true)).toBe(true);
  expect(restoredShell({ agent: "claude" }, undefined, true)).toBe(false);
  expect(restoredShell({ agent_session: { agent: "pi" } }, undefined, true)).toBe(false);
  expect(restoredShell({}, 42, true)).toBe(false);
});
