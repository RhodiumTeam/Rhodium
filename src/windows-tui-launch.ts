// A console entry point so an interactive agent inherits the Herdr pane's ConPTY.
import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { AGENT_KINDS } from "./agents";
import type { AgentKind } from "./contracts";
import { nativeProcess } from "./tui-process";

type PaneRequest = { agent: AgentKind; argv: string[]; env: Record<string, string>; unset: string[]; identity: string };

const packages: Record<AgentKind, string[]> = {
  claude: ["@anthropic-ai/claude-code"],
  pi: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
  codex: ["@openai/codex"],
};
const unsupported = (kind: AgentKind) => new Error(`请将 programs.${kind} 配置为原生 ${kind}.exe 或官方 npm 安装的 ${kind}.cmd。`);
const file = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile();

// npm's cmd-shim for a Node shebang, with its target filled from the package manifest.
// Recognize the whole shim: silently bypassing a custom wrapper would discard its behavior.
const shimHead = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0`;
const npmNodeShim = (target: string) => `${shimHead}
IF EXIST "%dp0%\\node.exe" (
SET "_prog=%dp0%\\node.exe"
) ELSE (
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${target}" %*`;
const normalized = (s: string) => s.trim().split(/\r?\n/).map(l => l.trim().replace(/[ \t]+/g, " ").toLowerCase()).filter(Boolean).join("\n");

/** The Claude npm package leaves a small text stub named .exe if native setup failed. */
function executable(path: string): boolean {
  if (!file(path)) return false;
  const fd = openSync(path, "r");
  const magic = Buffer.alloc(2);
  try { return readSync(fd, magic, 0, 2, 0) === 2 && magic.toString("ascii") === "MZ"; }
  finally { closeSync(fd); }
}

// install.ps1's Write-PiManagedLaunchers templates. Keep the original JS in charge of pi updates.
// Digests cover the full file with LF and without its final line ending; recorded copies are in test/fixtures.
const piCmdPath = "f250f143ae2476e9f88b9cab3ec8c8e88ccdf8f1c36057859639920526abd2a7";
const piCmdStandalone = "f71206558f3312b529f77d8c216f9776e1ad299850068f3b99746462c77d4cfb";
const piLauncherJs = "3d8b27bb3f5c07543303b0ee774ce215e4d6ae2b0ae43311c4acf51f517ffd13";
const digest = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n").replace(/\n$/, "")).digest("hex");

type Launch = { argv: string[]; inner?: string };
function managedPi(program: string, shim: string, args: string[], path: string, localAppData?: string): Launch | null {
  const kind = digest(shim);
  if (kind !== piCmdPath && kind !== piCmdStandalone) return null;
  const bin = dirname(program), root = join(dirname(bin), "install"), js = join(bin, "pi-launcher.js");
  try {
    const marker = JSON.parse(readFileSync(join(root, "managed-install.json"), "utf8").replace(/^\uFEFF/, ""));
    if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1" ||
        marker.entrypoint?.type !== "script" || relative(program, marker.entrypoint.path) !== "" || digest(readFileSync(js, "utf8")) !== piLauncherJs) throw unsupported("pi");
    const version = readFileSync(join(root, "current-version"), "utf8").trim();
    if (!/^[0-9a-z._+-]+$/i.test(version) || version === "." || version === "..") throw unsupported("pi");
    const name = packages.pi[0]!, pkg = join(root, "releases", version, "node_modules", name);
    const meta = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const inner = resolve(pkg, typeof meta.bin === "string" ? meta.bin : meta.bin.pi);
    const rel = relative(pkg, inner);
    if (meta.name !== name || rel.startsWith("..") || isAbsolute(rel) || !file(inner)) throw unsupported("pi");
    const bundled = localAppData && join(localAppData, "pi-node", "current", "node.exe");
    const node = kind === piCmdStandalone && bundled && file(bundled) ? bundled : Bun.which("node.exe", { PATH: path });
    if (!node) throw unsupported("pi");
    return { argv: [node, js, ...args], inner };
  } catch { throw unsupported("pi"); }
}

/** Herdr can report node.exe for an external npm pane. Only the package's declared bin is the agent. */
export function isWindowsAgentNodeEntry(kind: AgentKind, script: string | undefined): boolean {
  if (!script || !isAbsolute(script) || !file(script)) return false;
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (packages[kind].includes(manifest.name)) {
        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[kind];
        return typeof bin === "string" && relative(resolve(dir, bin), script) === "";
      }
    } catch { /* intermediate directories need not contain a manifest */ }
    if (dirname(dir) === dir) return false;
  }
}

/** Preflight before stopping the headless slot; also check the same entry point inside Herdr. */
export function windowsAgentArgv(kind: AgentKind, argv: string[], path = process.env.PATH ?? ""): string[] {
  return launchFor(kind, argv, path, process.env.LOCALAPPDATA).argv;
}

function launchFor(kind: AgentKind, argv: string[], path: string, localAppData?: string): Launch {
  const [program, ...args] = argv;
  if (!program || !isAbsolute(program) || !file(program)) throw unsupported(kind);
  if (extname(program).toLowerCase() === ".exe" && executable(program)) return { argv };
  if (basename(program).toLowerCase() !== kind + ".cmd") throw unsupported(kind);
  const text = readFileSync(program, "utf8");
  if (kind === "pi") {
    const managed = managedPi(program, text, args, path, localAppData);
    if (managed) return managed;
  }
  const shim = normalized(text);
  const dir = dirname(program);
  const modules = basename(dir).toLowerCase() === ".bin" ? dirname(dir) : join(dir, "node_modules");
  for (const name of packages[kind]) {
    const pkg = join(modules, name);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); }
    catch { continue; }
    const bin = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.[kind];
    if (manifest?.name !== name || typeof bin !== "string") continue;
    const entry = resolve(pkg, bin);
    const target = "%dp0%\\" + relative(dir, entry).replaceAll("/", "\\");
    if (extname(entry).toLowerCase() === ".exe" && shim === normalized(`${shimHead}\n"${target}" %*`) && executable(entry)) return { argv: [entry, ...args] };
    if (!/\.[cm]?js$/i.test(entry) || !file(entry) || shim !== normalized(npmNodeShim(target))) continue;
    const sibling = join(dir, "node.exe");
    const node = file(sibling) ? sibling : Bun.which("node.exe", { PATH: path });
    if (!node) throw new Error(`${kind} 的 npm 启动入口需要 node.exe，请检查 agentPath。`);
    return { argv: [node, entry, ...args] };
  }
  throw unsupported(kind);
}

export function windowsPaneCommand(file: string, request: PaneRequest): string[] {
  if (!isAbsolute(file) || !isAbsolute(request.identity)) throw new Error("终端启动文件必须使用绝对路径");
  writeFileSync(file, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  return [process.execPath, "--internal-tui-agent", file];
}

function readRequest(file: string, legacyCodex: boolean): PaneRequest {
  if (!isAbsolute(file)) throw new Error("终端启动文件必须使用绝对路径");
  let r;
  try { r = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("终端启动请求不存在或格式不正确"); }
  const strings = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === "string" && !s.includes("\0"));
  if (legacyCodex && r && typeof r === "object" && r.agent === undefined) r.agent = "codex";
  if (!r || !AGENT_KINDS.includes(r.agent) || (legacyCodex && r.agent !== "codex") || !strings(r.argv) || !r.argv.length || !strings(r.unset) || !r.env || typeof r.env !== "object" || Array.isArray(r.env) ||
      !strings(Object.values(r.env)) || typeof r.identity !== "string" || !isAbsolute(r.identity)) throw new Error("终端启动请求格式不正确");
  return r;
}

// Inspect only direct children of our known outer Node. Do not send user arguments to logs or stdout.
const childQuery = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
for ($i = 0; $i -lt 35; $i++) {
  $rows = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + [int]$env:RHODIUM_PI_LAUNCHER_PID) -Property ProcessId,ExecutablePath,CommandLine | ForEach-Object {
    if ($_.ExecutablePath -ieq $env:RHODIUM_PI_NODE -and $_.CommandLine -match '^(?:"[^"]+"|[^\\s"]+)\\s+(?:"([^"]+)"|([^\\s"]+))(?:\\s|$)') {
      $entry = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      if ($entry -ieq $env:RHODIUM_PI_ENTRY) { $_.ProcessId }
    }
  })
  if ($rows.Count -gt 1) { exit 2 }
  if ($rows.Count -eq 1) { [Console]::WriteLine($rows[0]); exit 0 }
  Start-Sleep -Milliseconds 80
}
exit 1
`, "utf16le").toString("base64");

async function managedWriter(outer: number, start: number, image: string, inner: string, env: Record<string, string>) {
  const ps = join(env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const query = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-EncodedCommand", childQuery], {
    env: { ...env, RHODIUM_PI_LAUNCHER_PID: String(outer), RHODIUM_PI_NODE: image, RHODIUM_PI_ENTRY: inner }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 7500,
  });
  const [out, code] = await Promise.all([new Response(query.stdout).text(), query.exited]);
  const pid = Number(out.trim());
  const info = !code && nativeProcess(pid);
  if (!info || info.state === "Z" || info.ppid !== outer || !info.exe || !image || relative(image, info.exe) !== "" || nativeProcess(outer)?.start !== start)
    throw new Error("无法确认受管 pi 的唯一 Node 子进程");
  return { pid, start: info.start };
}

export async function runWindowsPane(file: string, legacyCodex: boolean): Promise<number> {
  const request = readRequest(file, legacyCodex);
  unlinkSync(file); // Consume once: a repeated layout launch must not start another agent.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k.toUpperCase()] = v;
  for (const [k, v] of Object.entries(request.env)) if (!/^HERDR_/i.test(k)) env[k.toUpperCase()] = v;
  // Use the same removal list the controller passes to env -u on Unix.
  for (const k of request.unset) delete env[k.toUpperCase()];
  const { argv, inner } = launchFor(request.agent, request.argv, env.PATH ?? "", env.LOCALAPPDATA);
  const pending = request.identity + ".pending";
  const fd = openSync(pending, "wx", 0o600);
  try {
    if (existsSync(request.identity)) throw new Error("终端启动身份已经存在");
    const launcher = nativeProcess(process.pid);
    if (!launcher) throw new Error("无法确认终端启动器的进程身份");
    const agent = Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: false });
    try {
      const found = nativeProcess(agent.pid);
      if (!found || found.state === "Z" || found.ppid !== process.pid) throw new Error("无法确认终端 agent 的进程身份");
      const writer = inner
        ? await managedWriter(agent.pid, found.start, found.exe, inner, env).catch(() => ({ error: "无法确认受管 pi 的唯一进程，请将 programs.pi 配置为 pi.exe 或 npm 的 pi.cmd。" }))
        : { pid: agent.pid, start: found.start };
      writeFileSync(fd, JSON.stringify({ ...writer, launcherPid: process.pid, launcherStart: launcher.start }));
      linkSync(pending, request.identity); // Atomic publication; a late launcher cannot replace an earlier receipt.
    } catch (err) {
      // Killing only pi-launcher.js could leave the actual pi running; keep the pane intact for cleanup.
      if (!inner) agent.kill();
      await agent.exited;
      throw err;
    }
    return agent.exited; // Release the staging link immediately; keep this console process until the agent exits.
  } finally {
    closeSync(fd);
    unlinkSync(pending);
  }
}
