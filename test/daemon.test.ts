import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { newInstance, type Instance } from "./instance";

let rhodium: Instance;
afterEach(() => rhodium?.cleanup());

test("a second rhodium on the same state dir fails to start, and the first keeps serving", async () => {
  rhodium = newInstance();
  await rhodium.start();
  await expect(rhodium.start()).rejects.toThrow(/another rhodium/);
  expect((await rhodium.rh(["ls"])).code).toBe(0);
});

test("a second rhodium on another state dir but the same socket dir fails to start, and the first keeps its socket", async () => {
  rhodium = newInstance();
  await rhodium.start();
  const other = newInstance({ socketDir: dirname(rhodium.socket) });
  try {
    await expect(other.start()).rejects.toThrow(/another rhodium/);
    expect((await rhodium.rh(["ls"])).code).toBe(0);
  } finally {
    await other.cleanup();
  }
});

test("the lock goes with the process: after kill -9 a new rhodium starts", async () => {
  rhodium = newInstance();
  const first = await rhodium.start();
  first.proc.kill(9);
  await first.proc.exited;
  await rhodium.start();
  expect((await rhodium.rh(["ls"])).code).toBe(0);
});

test("the boot number goes up by one each start and survives in the store", async () => {
  rhodium = newInstance();
  const boots: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await rhodium.start();
    boots.push(d.logs.find((l) => l.msg === "ready")?.boot);
    await rhodium.stop();
  }
  expect(boots).toEqual([1, 2, 3]);
});

test("rh talks to rhodium over a unix socket only its owner can open", async () => {
  rhodium = newInstance();
  await rhodium.start();
  const st = statSync(rhodium.socket);
  expect(st.isSocket()).toBe(true);
  expect(st.mode & 0o777).toBe(0o600);
});

test("a fake bot without its platform's socket stops rhodium from starting", async () => {
  rhodium = newInstance({ toml: '[bots.x]\nplatform = "fake"\nlike = "qq"' });
  await expect(rhodium.start()).rejects.toThrow(/bots.x needs socket/);
});

test("rh without a running rhodium says it can't connect", async () => {
  rhodium = newInstance();
  const r = await rhodium.rh(["ls"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(rhodium.socket);
});

test("#741: a long log() line right before process.exit reaches a pipe whole, uncolored", async () => {
  const daemon = new URL("../src/daemon.ts", import.meta.url).pathname;
  const script = `const { log } = await import(${JSON.stringify(daemon)}); log("big", { pad: "x".repeat(1 << 20) }); process.exit(1);`;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, FORCE_COLOR: "1" }, stdout: "ignore", stderr: "pipe" });
  const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(JSON.parse(err.trim()).pad.length).toBe(1 << 20);
});
