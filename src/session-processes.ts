// Process arguments are inspected locally for session ownership; never include them in logs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ProcessLine = { pid: number; command: string; image?: string };

function* linuxCommands(): Iterable<ProcessLine> {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      yield { pid: Number(entry), image: raw.split("\0", 1)[0], command: raw.replaceAll("\0", " ") };
    } catch {
      // The process may have exited or its command line may be private.
    }
  }
}

const cimCommands = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,Name,CommandLine | Where-Object CommandLine |
  Select-Object @{n='pid';e={$_.ProcessId}}, @{n='image';e={$_.Name}}, @{n='command';e={$_.CommandLine}})
ConvertTo-Json -InputObject $rows -Compress
`, "utf16le").toString("base64");

async function processCommands(session: string): Promise<Iterable<ProcessLine>> {
  if (process.platform === "linux") return linuxCommands();
  const windows = process.platform === "win32";
  const args = windows
    ? [join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", cimCommands]
    : ["/bin/ps", "-axww", "-o", "pid=,command="];
  const proc = Bun.spawn(args, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 8000 });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return [];
  if (windows) return JSON.parse(text) as ProcessLine[];
  const rows: ProcessLine[] = text.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line);
    return row ? [{ pid: Number(row[1]), command: row[2]! }] : [];
  });
  // Darwin's ps flattens argv, including spaces inside argv[0]. Ask for the image
  // only for possible import callers so their own arguments cannot claim a session.
  const possible = rows.filter((p) => p.command.includes(session) && importWords.test(p.command));
  if (possible.length) {
    const ps = Bun.spawn(["/bin/ps", "-ww", "-p", possible.map((p) => p.pid).join(","), "-o", "pid=,comm="], { stdout: "pipe", stderr: "ignore" });
    const images = new Map<number, string>();
    for (const line of (await new Response(ps.stdout).text()).split("\n")) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m) images.set(Number(m[1]), m[2]!);
    }
    for (const row of possible) row.image = images.get(row.pid);
  }
  return rows;
}

const importWords = /(?:^|[\\/\s"'])rh(?:\.exe)?["']?\s+["']?import\b/i;
const firstWord = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*/;
const programName = (path: string) => path.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, "").toLowerCase();

function importCaller({ command, image }: ProcessLine) {
  if (!importWords.test(command)) return false;
  const line = command.trimStart();
  const first = firstWord.exec(line);
  if (!first) return false;
  const firstName = programName(first[1] || first[2] || first[3]!);
  const name = image ? programName(image) : firstName;
  const args = line.slice(first[0].length);
  if (name === "rh" || name === "rhodium") {
    // Match the argument directly after the real CLI image (or its rh alias).
    const cliArgs = firstName === "rh" || firstName === "rhodium" ? args
      : /^["']?(?:.*?[\\/])?rh(?:odium)?(?:\.exe)?["']?\s+(.+)$/i.exec(line)?.[1];
    return !!cliArgs && /^(?:["']?rh["']?\s+)?["']?import["']?(?:\s|$)/i.test(cliArgs);
  }
  if (name === "bun") return /[\\/]main\.ts["']?\s+rh\s+import\b/i.test(args);
  if (!["sh", "bash", "zsh", "cmd", "pwsh", "powershell"].includes(name)) return false;
  const wrapped = /^(?:-[a-z]*c|-command|\/c)\s+(.+)$/i.exec(args);
  if (!wrapped) return false;
  const inner = wrapped[1]!.replace(/^(["'])(.*)\1$/, "$2").replace(/^exec\s+/, "");
  const word = firstWord.exec(inner);
  return !!word && ["rh", "rhodium"].includes(programName(word[1] || word[2] || word[3]!)) && /^(?:["']?rh["']?\s+)?["']?import["']?(?:\s|$)/i.test(inner.slice(word[0].length));
}

/** Only positive evidence counts. An unreadable command or an unrelated agent claims no session. */
export function matchingProcesses(rows: Iterable<ProcessLine>, session: string) {
  const pids: number[] = [];
  for (const row of rows) {
    if (row.pid !== process.pid && row.command.includes(session) && !importCaller(row)) pids.push(row.pid);
  }
  return pids;
}

export async function holders(session: string) {
  try { return matchingProcesses(await processCommands(session), session); }
  catch { return []; } // The Herdr snapshot is still checked when the OS cannot list processes.
}
