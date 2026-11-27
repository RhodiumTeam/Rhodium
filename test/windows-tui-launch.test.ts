import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { terminalUnset } from "../src/agents";
import type { AgentKind } from "../src/contracts";
import { nativeProcess } from "../src/tui-process";
import { windowsAgentArgv, windowsPaneCommand } from "../src/windows-tui-launch";

const shim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

test("npm Codex uses the declared JS with Node and forwards arguments verbatim; custom batch files fail preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-npm space-"));
  try {
    const cmd = join(dir, "codex.cmd");
    const node = join(dir, "node.exe");
    const pkg = join(dir, "node_modules", "@openai", "codex");
    const js = join(pkg, "bin", "codex.js");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(node, ""); writeFileSync(js, "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    writeFileSync(cmd, shim);
    const args = ['-c', 'model="a & b"\n%PATH%^! | 中文', '', 'a\\'];
    expect(windowsAgentArgv("codex", [cmd, ...args])).toEqual([node, js, ...args]);
    writeFileSync(cmd, "@echo custom override\r\n" + shim);
    expect(() => windowsAgentArgv("codex", [cmd])).toThrow("programs.codex");
    expect(() => windowsAgentArgv("codex", [join(dir, "other.bat")])).toThrow("programs.codex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Claude and both pi npm package names resolve their active command in a project with spaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-official shim "));
  try {
    const modules = join(dir, "node_modules"), bin = join(modules, ".bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "node.exe");
    writeFileSync(node, "");
    const releases: [AgentKind, string, string][] = [
      ["pi", "@earendil-works/pi-coding-agent", "dist/bundle/cli.js"], ["pi", "@mariozechner/pi-coding-agent", "dist/cli.js"],
      ["claude", "@anthropic-ai/claude-code", "cli.js"], ["claude", "@anthropic-ai/claude-code", "bin/claude.exe"],
    ];
    for (const [kind, name, binPath] of releases) {
      const entry = join(modules, name, binPath), cmd = join(bin, kind + ".cmd");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name, bin: { [kind]: binPath } }));
      const target = "%dp0%\\..\\" + (name + "/" + binPath).replaceAll("/", "\\");
      if (binPath.endsWith(".exe")) {
        writeFileSync(cmd, shim.split("IF EXIST")[0] + '"' + target + '"   %*\r\n');
        writeFileSync(entry, "echo native binary not installed");
        expect(() => windowsAgentArgv(kind, [cmd])).toThrow("programs.claude");
        writeFileSync(entry, "MZ");
        expect(windowsAgentArgv(kind, [cmd, "--version"])).toEqual([entry, "--version"]);
      } else {
        writeFileSync(entry, "#!/usr/bin/env node\n");
        writeFileSync(cmd, shim.replace("%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js", target));
        expect(windowsAgentArgv(kind, [cmd, "--version"])).toEqual([node, entry, "--version"]);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["claude", "pi", "codex"] as const) test.skipIf(process.platform !== "win32")(`${kind} launcher preserves the pane identity, filters its environment and consumes the request once`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-pane space-"));
  const file = join(dir, "request.json");
  const identity = join(dir, "identity.json");
  const output = join(dir, "started.json");
  const args = ['prompt "quoted" & %PATH% ! 中文\nnext', '', 'last\\'];
  const inherited = { Anthropic_Api_Key: "synthetic", Anthropic_Oauth_Token: "synthetic", Anthropic_Auth_Token: "synthetic",
    Anthropic_Base_Url: "synthetic", Anthropic_Seen_By_Daemon: "synthetic", Anthropic_Only_In_Herdr: "synthetic" };
  const code = `const retained = ${JSON.stringify(Object.keys(inherited))}.map(k => process.env[k] === "synthetic");require("fs").writeFileSync(process.argv[1], JSON.stringify([process.pid, process.argv.slice(2), process.env.HERDR_PANE_ID, retained])); setTimeout(()=>{}, 500);`;
  const request = { agent: kind, identity, argv: [Bun.which("node.exe")!, "-e", code, output, ...args], env: { HERDR_PANE_ID: "incorrect", PATH: process.env.PATH! },
    unset: terminalUnset(kind, { ANTHROPIC_SEEN_BY_DAEMON: "synthetic" }) };
  try {
    expect(windowsPaneCommand(file, request)).toEqual([process.execPath, "--internal-tui-agent", file]);
    const invoke = () => Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "--internal-tui-agent", file], {
      env: { ...process.env, HERDR_PANE_ID: "test-pane", ...inherited }, stdout: "ignore", stderr: "ignore",
    });
    const a = invoke(), b = invoke();
    expect((await Promise.all([a.exited, b.exited])).sort()).toEqual([0, 1]);
    const [pid, said, pane, retained] = JSON.parse(readFileSync(output, "utf8"));
    expect([said, pane]).toEqual([args, "test-pane"]);
    expect(retained).toEqual([...Array(5).fill(kind === "claude"), true]);
    const record = JSON.parse(readFileSync(identity, "utf8"));
    expect(record.pid).toBe(pid);
    expect([a.pid, b.pid]).toContain(record.launcherPid);
    expect(Number.isSafeInteger(record.launcherStart)).toBe(true);
    expect(Number.isSafeInteger(record.start)).toBe(true);
    expect(existsSync(file)).toBe(false);
    const saved = readFileSync(identity, "utf8");
    windowsPaneCommand(file, request);
    expect(await invoke().exited).toBe(1);
    expect(readFileSync(identity, "utf8")).toBe(saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "win32")("official managed pi keeps its original JS, private Node, inner identity and literal argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-managed pi "));
  const home = join(dir, "profile"), bin = join(home, "bin"), root = join(home, "install");
  const nodeDir = join(dir, "pi-node", "current"), privateNode = join(nodeDir, "node.exe");
  const entryDir = join(root, "releases", "1.5.2", "node_modules", "@earendil-works", "pi-coding-agent");
  const fixtures = join(import.meta.dir, "fixtures", "windows-managed-pi");
  const cmd = join(bin, "pi.cmd"), js = join(bin, "pi-launcher.js");
  const out = join(dir, "observed.json"), done = join(dir, "done");
  const identity = join(dir, "identity.json"), file = join(dir, "request.json");
  const args = [out, done, '"quoted" & echo should-not-run > unexpected.txt', "%PATH% ! ^| &", "中文\n下一行", "", "end\\"];
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const path of [bin, entryDir, nodeDir]) mkdirSync(path, { recursive: true });
    copyFileSync(Bun.which("node.exe")!, privateNode);
    copyFileSync(join(fixtures, "pi-standalone.cmd"), cmd);
    copyFileSync(join(fixtures, "pi-launcher.js"), js);
    writeFileSync(join(root, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1", entrypoint: { type: "script", path: cmd } }));
    writeFileSync(join(root, "current-version"), "1.5.2");
    writeFileSync(join(entryDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.js" } }));
    // The outer launcher has two direct Node children. Only the one running the declared CLI is pi.
    const preload = join(dir, "sibling.cjs"), siblingPid = join(dir, "sibling.pid");
    writeFileSync(preload, `
      if (process.argv[1] === ${JSON.stringify(js)}) {
        const sibling = require("node:child_process").spawn(process.execPath, ["-e", "process.stdin.resume()"], {stdio: ["pipe", "ignore", "ignore"]});
        require("node:fs").writeFileSync(${JSON.stringify(siblingPid)}, String(sibling.pid));
        sibling.unref(); sibling.stdin.unref();
      }
    `);
    writeFileSync(join(entryDir, "cli.js"), `
      const fs = require('node:fs');
      process.title = 'pi';
      fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, parent: process.ppid, argv: process.argv.slice(2),
        node: process.execPath, root: process.env.PI_MANAGED_INSTALL_ROOT, pane: process.env.HERDR_PANE_ID, leaked: !!process.env.Anthropic_Test }));
      setInterval(() => { if (fs.existsSync(process.argv[3])) process.exit(0) }, 50);
      setTimeout(() => process.exit(3), 14000);
    `);
    windowsPaneCommand(file, { agent: "pi", identity, argv: [cmd, ...args], env: {}, unset: terminalUnset("pi", { ANTHROPIC_TEST: "synthetic" }) });
    proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "--internal-tui-agent", file], {
      cwd: dir, env: { ...process.env, LOCALAPPDATA: dir, NODE_OPTIONS: "--require " + JSON.stringify(preload.replaceAll("\\", "/")), Anthropic_Test: "synthetic", HERDR_PANE_ID: "fixture" }, stdout: "ignore", stderr: "inherit",
    });
    for (const end = Date.now() + 12000; !existsSync(identity) && proc.exitCode === null && Date.now() < end;) await Bun.sleep(50);
    const got = JSON.parse(readFileSync(identity, "utf8")), obs = JSON.parse(readFileSync(out, "utf8"));
    expect(obs).toMatchObject({ argv: args, node: privateNode, root, pane: "fixture", leaked: false });
    expect(got).toEqual({ pid: obs.pid, start: nativeProcess(obs.pid)!.start, launcherPid: proc.pid, launcherStart: nativeProcess(proc.pid)!.start });
    const sibling = Number(readFileSync(siblingPid, "utf8"));
    expect(sibling).not.toBe(obs.pid);
    expect(nativeProcess(sibling)?.ppid).toBe(obs.parent);
    expect(nativeProcess(obs.pid)?.ppid).toBe(obs.parent);
    expect(nativeProcess(obs.parent)?.ppid).toBe(proc.pid);
    expect(existsSync(join(dir, "unexpected.txt"))).toBe(false);
    writeFileSync(done, "");
    expect(await proc.exited).toBe(0);
    copyFileSync(join(fixtures, "pi.cmd"), cmd);
    expect(windowsAgentArgv("pi", [cmd], dirname(Bun.which("node.exe")!))[1]).toBe(js);
    writeFileSync(js, "throw new Error('modified managed launcher')");
    expect(() => windowsAgentArgv("pi", [cmd])).toThrow("programs.pi");
  } finally {
    writeFileSync(done, "");
    if (proc) await proc.exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
  }
}, 25000);
