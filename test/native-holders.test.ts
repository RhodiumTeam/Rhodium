import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config";
import { holderLive, unconfirmedMacExit } from "../src/detached";
import { connectHolder, holderPaths, type HolderLink } from "../src/holder";
import { nativeHolders, stopUnreachableHolder } from "../src/native-holders";
import { nativeProcess } from "../src/tui-process";
import { makePipe, windows } from "../src/windows";

const bin = process.env.RHODIUM_TEST_HOLD;
test.skipIf(!bin || !["darwin", "win32"].includes(process.platform))("scope native run holders to this instance, identify an old version, stop only the original process tree", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "rhodium-test-h-")));
  const cfg = { stateDir: join(tmp, "s p"), socketDir: join(tmp, "s"), lockDir: join(tmp, "l"), holdBin: bin } as Config;
  const old = join(tmp, basename(bin!));
  copyFileSync(bin!, old);
  const p = holderPaths(cfg, "a");
  mkdirSync(p.dir, { recursive: true });
  const pipe = windows ? makePipe(join(tmp, "pipe")) : undefined;
  const child = Bun.spawn([old, "run", p.dir, pipe?.name ?? p.sock, p.lock, "60000"], {
    detached: true, env: { ...process.env, RHODIUM_PIPE_PROOF: pipe?.proof }, stdout: "ignore", stderr: "ignore",
  });
  let link: HolderLink | undefined;
  try {
    for (let i = 0; i < 100 && !link; i++) {
      link = await connectHolder(pipe ? join(tmp, "pipe") : p.sock, { boot: 1, offset: 0 }, { out() {}, exit() {} }).catch(() => undefined);
      if (!link) await Bun.sleep(50);
    }
    if (!link) throw new Error("test holder did not open");
    const agent = await link.start({ argv: [process.execPath, "-e", "setInterval(()=>{},500)"], env: { PATH: process.env.PATH!, ...(windows && { SystemRoot: process.env.SystemRoot! }) }, cwd: tmp });
    const start = nativeProcess(agent)!.start;
    const rows = await nativeHolders(cfg);
    expect(rows).toHaveLength(1);
    const target = rows[0]!;
    expect(target).toMatchObject({ conversation: "a", pid: child.pid, exe: old });
    expect(await nativeHolders({ ...cfg, stateDir: join(tmp, "another") })).toEqual([]);
    await expect(stopUnreachableHolder(cfg, "a", { ...target, start: target.start - 1 })).rejects.toThrow();
    expect(nativeProcess(agent)?.start).toBe(start);
    if (!windows) {
      const marker = readFileSync(join(p.dir, "agent.started"));
      expect(marker.toString("ascii", 0, 4)).toBe("PID1");
      expect(marker.readInt32LE(4)).toBe(agent);
      expect(Number(marker.readBigUInt64LE(8))).toBe(start);
      writeFileSync(join(p.dir, "agent.started"), "unknown"); // Upgrade a live legacy holder during the stop.
    }
    await stopUnreachableHolder(cfg, "a", target);
    await child.exited;
    for (let i = 0; i < 100 && nativeProcess(agent)?.state === "R"; i++) await Bun.sleep(30);
    const after = nativeProcess(agent);
    expect(!after || after.start !== start || after.state === "Z").toBe(true);
    if (!windows) {
      expect(await unconfirmedMacExit(p.dir, bin!)).toBe(false);
      // Manufacture a holder-lost marker after a normal exit, or leave the one the group kill left.
      const marker = Buffer.alloc(16);
      marker.write("PID1"); marker.writeInt32LE(process.pid, 4);
      marker.writeBigUInt64LE(BigInt(nativeProcess(process.pid)!.start), 8);
      rmSync(join(p.dir, "exit"), { force: true });
      writeFileSync(join(p.dir, "agent.started"), marker);
      expect(await unconfirmedMacExit(p.dir, bin!)).toBe(true);
      marker.writeBigUInt64LE(BigInt(start), 8);
      marker.writeInt32LE(agent, 4);
      writeFileSync(join(p.dir, "agent.started"), marker);
      expect(await unconfirmedMacExit(p.dir, bin!)).toBe(false);
      expect(existsSync(join(p.dir, "agent.started"))).toBe(false);
      writeFileSync(join(p.dir, "agent.started"), "unknown");
      expect(await unconfirmedMacExit(p.dir, bin!)).toBe(true);
    }
    expect(await holderLive(bin!, p.dir)).toBe(false);
  } finally {
    link?.close();
    child.kill();
    await child.exited;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 6 });
  }
}, 45_000);
