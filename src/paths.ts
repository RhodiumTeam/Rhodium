// Paths entered on the board belong to the daemon's host, even on a phone.
import path from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export function userHome() {
  if (process.platform !== "win32") return process.env.HOME || homedir();
  const home = process.env.USERPROFILE || homedir();
  // A scheduled task can inherit an 8.3 spelling that differs from the transcript folder.
  try { return localDrivePath(realpathSync.native(home)); } catch { return home; }
}

// Some Windows CLIs persist the extended spelling of a local drive path in session metadata.
export const localDrivePath = (dir: string) => dir.replace(/^[/\\]{2}\?[/\\]([a-z]:[/\\])/i, "$1");

export function expandHome(dir: string, home = userHome(), paths = path) {
  return dir.replace(paths.sep === "\\" ? /^~(?=[\\/]|$)/ : /^~(?=\/|$)/, () => home);
}

export function displayDirectory(dir: string, home = userHome(), paths = path) {
  if (paths.sep === "\\" && paths.isAbsolute(dir)) {
    dir = localDrivePath(dir);
    const rel = paths.relative(localDrivePath(home), dir);
    if (!rel) return "~";
    if (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\")) return "~/" + rel.replaceAll("\\", "/");
    return dir.replaceAll("\\", "/");
  }
  return dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
}

export function parentDirectory(dir: string, paths = path): string | null {
  const parent = paths.dirname(dir);
  return parent === dir ? null : parent;
}

export function sameDirectory(a: string, b: string, paths = path) {
  return paths.sep === "\\" ? paths.relative(localDrivePath(a), localDrivePath(b)) === "" : a === b;
}

// Resolving a drive-less rooted path would silently give it the slot's drive. UNC and device
// names must be rejected before even realpath, which can contact the server.
export function localCandidate(dir: string, target: string, paths = path) {
  if (paths.sep === "\\" && paths.isAbsolute(target) && !driveRoot.test(target)) return null;
  const candidate = paths.resolve(dir, target);
  return paths.sep === "\\" && !driveRoot.test(candidate) ? null : candidate;
}
export const driveRoot = /^[a-z]:[\\/]/i;

export function insideDirectory(dir: string, file: string, paths = path) {
  const windows = paths.sep === "\\";
  const rel = paths.relative(windows ? localDrivePath(dir) : dir, windows ? localDrivePath(file) : file);
  return !!rel && !paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + paths.sep);
}
