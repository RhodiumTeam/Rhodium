// #811: whether a running pi carries the Anthropic keys it reads, and whether a claude rh doctor
// started runs bare, on each platform's own interface.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicSet, bareIn, doctorBare, piPaneHasCredentials, procargs, windowsEnv } from "../src/pi-pane-credentials";

test("only a nonempty one of pi's four keys counts; Windows names ignore case", () => {
  expect(anthropicSet(["PATH=/bin", "ANTHROPIC_API_KEY=x"])).toBe(true);
  expect(anthropicSet(["ANTHROPIC_API_KEY=", "ANTHROPIC_MODEL=x", "CLAUDE_CODE_OAUTH_TOKEN=x"])).toBe(false);
  expect(anthropicSet(["anthropic_auth_token=x"])).toBe(false);
  expect(anthropicSet(["anthropic_auth_token=x"], true)).toBe(true);
  expect(anthropicSet(["=C:=C:\\", "ANTHROPIC_BASE_URL=http://x"], true)).toBe(true);
});

test("a KERN_PROCARGS2 reply: argc arguments after the path and its padding, then the environment", () => {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(2);
  const body = Buffer.from("/usr/bin/pi\0\0\0\0pi\0--x\0A=1\0ANTHROPIC_API_KEY=k\0\0junk\0");
  expect(procargs(Buffer.concat([argc, body]))).toEqual({ argv: ["pi", "--x"], env: ["A=1", "ANTHROPIC_API_KEY=k"] });
  expect(procargs(Buffer.alloc(2))).toBeNull();
  argc.writeInt32LE(5);
  expect(procargs(Buffer.concat([argc, Buffer.from("/p\0a\0")]))).toBeNull();
});

test("bare: --bare before any --, or CLAUDE_CODE_SIMPLE set to something not off; Windows names ignore case", () => {
  expect(bareIn(["claude", "--bare"], [])).toBe(true);
  expect(bareIn(["claude", "--bare=1"], [])).toBe(true);
  expect(bareIn(["claude", "-p", "--", "--bare"], [])).toBe(false);
  expect(bareIn(["claude"], ["CLAUDE_CODE_SIMPLE=1"])).toBe(true);
  expect(bareIn(["claude"], ["CLAUDE_CODE_SIMPLE=0", "A=b=c"])).toBe(false);
  expect(bareIn(["claude"], ["claude_code_simple=1"])).toBe(false);
  expect(bareIn(["claude"], ["claude_code_simple=1"], true)).toBe(true);
});

test("a Windows environment block: UTF-16 strings, an empty one at the end", () => {
  expect(windowsEnv(Buffer.from("A=1\0Anthropic_Api_Key=k\0\0", "utf16le"))).toEqual(["A=1", "Anthropic_Api_Key=k"]);
});

// On this platform's own interface: a process of ours started with and without one of the keys.
test.skipIf(!["linux", "darwin", "win32"].includes(process.platform))("a live process with a key, one without, and one gone", async () => {
  const run = (extra: Record<string, string>) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ANTHROPIC_/i.test(k))) as Record<string, string>;
    return Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 20000)"], { env: { ...env, ...extra }, stdout: "ignore", stderr: "ignore" });
  };
  const keyed = run({ ANTHROPIC_OAUTH_TOKEN: "rhodium-test-not-a-token" });
  const clean = run({ ANTHROPIC_API_KEY: "" });
  try {
    await Bun.sleep(300);
    expect(await piPaneHasCredentials(keyed.pid)).toBe(true);
    expect(await piPaneHasCredentials(clean.pid)).toBe(false);
  } finally {
    keyed.kill();
    clean.kill();
  }
  await keyed.exited;
  expect(await piPaneHasCredentials(keyed.pid)).toBeNull();
});

// rh doctor's look at the claude it started: a process of ours with --bare, with CLAUDE_CODE_SIMPLE, and with neither.
test.skipIf(!["linux", "darwin", "win32"].includes(process.platform))("doctor's bare look at a live process, as it really got its arguments and environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-bare-"));
  const script = join(dir, "wait.js");
  writeFileSync(script, "setTimeout(() => {}, 20000);\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "CLAUDE_CODE_SIMPLE")) as Record<string, string>;
  const run = (args: string[], extra: Record<string, string> = {}) => Bun.spawn([process.execPath, script, ...args], { env: { ...env, ...extra }, stdout: "ignore", stderr: "ignore" });
  const flagged = run(["--bare"]);
  const simple = run([], { CLAUDE_CODE_SIMPLE: "1" });
  const plain = run(["--", "--bare"]);
  try {
    await Bun.sleep(300);
    expect([doctorBare(flagged.pid), doctorBare(simple.pid), doctorBare(plain.pid)]).toEqual([true, true, false]);
  } finally {
    for (const p of [flagged, simple, plain]) p.kill();
  }
  await flagged.exited;
  expect(doctorBare(flagged.pid)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
