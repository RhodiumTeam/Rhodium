// Direct holders have no unit manager. Only a "run" under this instance's hold directory belongs to it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { sameDirectory } from "./paths";
import { nativeProcess, terminateWindowsHolder } from "./tui-process";
import type { Config } from "./config";

type HolderProcess = { pid: number; start: number; exe: string; conversation: string };

async function output(argv: string[]) {
  const p = Bun.spawn(argv, { windowsHide: true, stdout: "pipe", stderr: "ignore", timeout: 8000 });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code) throw new Error("无法核实托管进程");
  return text;
}

export async function nativeHolders(cfg: Config): Promise<HolderProcess[]> {
  const windows = process.platform === "win32";
  const root = join(cfg.stateDir, "hold");
  const name = windows ? "rh-hold.exe" : "rh-hold";
  const names = [name, basename(cfg.holdBin || name)];
  const named = (exe: string) => names.some(n => windows ? n.toLowerCase() === basename(exe).toLowerCase() : n === basename(exe));
  let rows: { pid: number; command: string }[];
  if (windows) {
    const filter = [...names].map(n => "Name='" + n.replaceAll("'", "''") + "'").join(" OR ");
    const ps = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter $env:RHODIUM_HOLDER_FILTER -Property ProcessId,CommandLine | Select-Object @{n='pid';e={$_.ProcessId}},@{n='command';e={$_.CommandLine}})`;
    const query = Bun.spawn([join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps,"utf16le").toString("base64")], {
      windowsHide: true, env: { ...process.env, RHODIUM_HOLDER_FILTER: filter }, stdout: "pipe", stderr: "ignore", timeout: 8000,
    });
    const [text, code] = await Promise.all([new Response(query.stdout).text(), query.exited]);
    if (code) throw new Error("无法核实托管进程");
    rows = JSON.parse(text);
  } else {
    const procs = await output(["/bin/ps", "-axww", "-o", "pid=,comm="]);
    rows = [];
    for (const line of procs.split("\n")) {
      const row = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!row || !named(row[2]!)) continue;
      const pid = Number(row[1]);
      const command = await output(["/bin/ps", "-ww", "-p", String(pid), "-o", "command="]).catch(() => "");
      rows.push({ pid, command: command.trimStart().trimEnd() });
    }
  }
  const found: HolderProcess[] = [];
  for (const { pid, command } of rows) {
    if (!command) continue;
    const info = nativeProcess(pid);
    if (!info || info.state === "Z" || !named(info.exe)) continue;
    let dir: string;
    if (windows) {
      const args = /^(?:"[^"]+"|\S+)\s+"?run"?\s+(?:"([^"]+)"|(\S+))\s/.exec(command);
      if (!args) continue;
      dir = (args[1] || args[2])!;
    } else {
      // ps prints argv without quoting. The following socket and lock arguments disambiguate spaces.
      const i = command.indexOf(" run " + root + "/");
      if (i < 0 || !named(command.slice(0, i))) continue;
      const remaining = command.slice(i + 5);
      const socket = remaining.indexOf(" " + join(cfg.socketDir, "hold") + "/");
      if (socket < 0) continue;
      dir = remaining.slice(0, socket);
      const id = basename(dir);
      if (!remaining.startsWith(dir + " " + join(cfg.socketDir, "hold", id + ".sock") + " " + join(cfg.lockDir, id) + " ")) continue;
    }
    if (sameDirectory(dirname(dir), root)) found.push({ pid, start: info.start, exe: info.exe, conversation: basename(dir) });
  }
  return found;
}

export async function stopUnreachableHolder(cfg: Config, conversation: string, expected: HolderProcess) {
  const current = (await nativeHolders(cfg)).find(h => h.conversation === conversation && h.pid === expected.pid && h.start === expected.start);
  if (!current) throw new Error("无法核实失联托管进程的身份");
  if (process.platform === "darwin") {
    // Each agent leads its own group, separate from its detached holder's group.
    const children = await output(["/bin/ps", "-ax", "-o", "pid=,ppid=,pgid="]);
    for (const row of children.trim().split("\n")) {
      const [pid, parent, group] = row.trim().split(/\s+/).map(Number);
      if (parent !== current.pid || group !== pid || !pid) continue;
      const child = nativeProcess(pid);
      if (child?.ppid !== parent || nativeProcess(current.pid)?.start !== current.start) continue;
      if (nativeProcess(pid)?.start !== child.start) continue;
      // Upgrade a boot-only receipt while the original holder and its agent group can still be identified.
      const marker = join(cfg.stateDir, "hold", conversation, "agent.started");
      let legacy: string | undefined;
      try { legacy = readFileSync(marker, "utf8"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      if (legacy && (legacy === "unknown" || /^[a-f0-9-]{36}$/i.test(legacy))) {
        const record = Buffer.alloc(16);
        record.write("PID1"); record.writeInt32LE(pid, 4); record.writeBigUInt64LE(BigInt(child.start), 8);
        const tmp = marker + "." + randomUUID();
        writeFileSync(tmp, record, { flag: "wx", mode: 0o600 });
        renameSync(tmp, marker);
      }
      if (nativeProcess(current.pid)?.start === current.start && nativeProcess(pid)?.start === child.start) signalGroup(pid);
    }
    if (nativeProcess(current.pid)?.start === current.start) signalGroup(current.pid);
  } else {
    // The holder owns the only handle to its kill-on-close Job.
    terminateWindowsHolder(current.pid, current.start);
  }
}

function signalGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
}
