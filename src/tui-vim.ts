// The file-based managed settings location for Claude Code on each native host.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

export function managedVimFile(platform = process.platform, programFiles = process.env.ProgramFiles): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return win32.join(programFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  return "/etc/claude-code/managed-settings.json";
}

export function lastSettings(argv: readonly string[]): string | undefined {
  let flag: string | undefined;
  for (const [i, a] of argv.entries()) {
    if (a === "--settings") flag = argv[i + 1];
    else if (a.startsWith("--settings=")) flag = a.slice("--settings=".length);
  }
  return flag;
}

export type VimLaunch = { settings?: string; cwd?: string };

export function rememberVimLaunch(holderDir: string, pid: number, start: number, argv: readonly string[], cwd: string) {
  let settings = lastSettings(argv);
  // Inline settings can also hold tokens. Only the resolved editorMode belongs in the receipt.
  if (settings?.trimStart().startsWith("{")) {
    try {
      const mode = JSON.parse(settings)?.editorMode;
      settings = mode === undefined ? undefined : JSON.stringify({ editorMode: mode === "vim" ? "vim" : "normal" });
    } catch { settings = undefined; }
  }
  mkdirSync(holderDir, { recursive: true, mode: 0o700 });
  const file = join(holderDir, "tui-vim.json");
  writeFileSync(file + ".tmp", JSON.stringify({ pid, start, settings, cwd }), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

type Foreground = { pid: number; argv?: string[]; cwd?: string };

/** Use the observed agent's own fields first. A receipt can fill missing fields only for that process. */
export function nativeVimLaunch(holderDir: string, pid: number, start: number | null, foreground?: Foreground[]): VimLaunch {
  const actual = foreground?.find(p => p.pid === pid);
  if (actual?.argv && actual.cwd) return { settings: lastSettings(actual.argv), cwd: actual.cwd };
  let saved: VimLaunch | undefined;
  try {
    const row = JSON.parse(readFileSync(join(holderDir, "tui-vim.json"), "utf8"));
    if (start !== null && row.pid === pid && row.start === start) saved = row;
  } catch {} // No receipt for an older pane, as with missing process info on Linux.
  return { settings: actual?.argv ? lastSettings(actual.argv) : saved?.settings, cwd: actual?.cwd || saved?.cwd };
}
