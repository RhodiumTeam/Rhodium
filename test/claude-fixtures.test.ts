// Checks the committed seam-3 fixtures: every scenario is there and each follows the recording
// format. fixture-hygiene.test.ts checks they carry no private data.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "fixtures/claude");
const SCENARIOS = [
  "basic-turn", "approval-allow-deny", "question", "plan-confirm", "mid-turn-message",
  "interrupt-pending-approval", "background-wake", "reinitialize-pending-approval", "rate-limit-rejected", "unknown-messages",
  "background-agent",
  "cmd-new", "cmd-stop", "cmd-status", "cmd-model", "cmd-compact", "cmd-usage", "cmd-context", "cmd-resume", "cmd-effort", "cmd-ultracode",
];
const dirs = existsSync(ROOT) ? readdirSync(ROOT).sort() : [];
const read = (d: string, f: string) => readFileSync(join(ROOT, d, f), "utf8");

test("every seam-3 scenario has a fixture", () => {
  expect(SCENARIOS.filter((s) => !dirs.includes(s))).toEqual([]);
});

describe.each(dirs)("%s", (dir) => {
  test("meta is one JSON line naming agent, version, scenario and whether it was edited by hand", () => {
    const text = read(dir, "meta");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    const meta = JSON.parse(text);
    expect(meta).toMatchObject({ agent: "claude", scenario: dir });
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof meta.edited).toBe("boolean");
    if (meta.edited) expect(meta.note).toBeString();
  });

  test("out.log is whole JSON lines; in.log lines are '<out.log bytes> <line>' with offsets in order", () => {
    const out = read(dir, "out.log");
    expect(out.endsWith("\n")).toBe(true);
    // Only a hand-edited fixture may carry a non-JSON line on purpose.
    if (!JSON.parse(read(dir, "meta")).edited) for (const l of out.slice(0, -1).split("\n")) expect(() => JSON.parse(l)).not.toThrow();
    const size = Buffer.byteLength(out);
    let last = 0;
    for (const l of read(dir, "in.log").split("\n").filter(Boolean)) {
      const m = l.match(/^(\d+) (.+)$/);
      expect(m).not.toBeNull();
      const off = Number(m![1]);
      expect(off).toBeGreaterThanOrEqual(last);
      expect(off).toBeLessThanOrEqual(size);
      last = off;
    }
  });
});
