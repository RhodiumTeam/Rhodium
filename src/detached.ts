// Directly launched holders keep their own lifetime lock instead of a systemd unit.
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const detached = process.platform === "win32" || process.platform === "darwin";
export const holderExecutable = (configured?: string) => configured || join(dirname(process.execPath), process.platform === "win32" ? "rh-hold.exe" : "rh-hold");

export async function holderLive(bin: string, dir: string) {
  if (!statSync(dir, { throwIfNoEntry: false })) return false;
  const probe = Bun.spawn([bin, "probe", join(dir, "live.lock")], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
  if (code || !["live", "gone"].includes(out.trim())) throw new Error("holder probe: " + err.trim());
  return out.trim() === "live";
}

// macOS has no cgroup to reap the agent when the holder itself is killed.
export async function unconfirmedMacExit(dir: string, bin: string) {
  if (process.platform !== "darwin" || !existsSync(join(dir, "agent.started")) || existsSync(join(dir, "exit"))) return false;
  // The probe reconciles a dead agent while holding live.lock (also for a slot with no database row).
  await holderLive(bin, dir);
  return existsSync(join(dir, "agent.started")) && !existsSync(join(dir, "exit"));
}
