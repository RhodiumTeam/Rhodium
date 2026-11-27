// A real Windows holder keeps the same agent and its output when its controller goes away.
import { expect, test } from "bun:test";
import { holderLive } from "../src/detached";
import { windowsConversationLock } from "../src/tui-lock";
import { renameTarget } from "../src/config";
import { Database } from "bun:sqlite";
import { createPrivateWindows, checkWindowsPermissions, makePipe } from "../src/windows";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, win32 } from "node:path";
import { createServer } from "node:net";
import { connectHolder, type HolderLink } from "../src/holder";

const consoleProbe = join(import.meta.dir, "fake-agent", "windows-console.py");

test.skipIf(process.platform !== "win32")("Windows TUI and the Rust holder exclude each other on the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-tui-lock-"));
  const lock = join(dir, "live.lock");
  const bin = process.env.RHODIUM_TEST_HOLD!;
  let release: (() => void) | null = null;
  try {
    expect(() => windowsConversationLock(join(dir, "missing", "lock"))).toThrow();
    release = windowsConversationLock(lock);
    expect(release).not.toBeNull();
    expect(await holderLive(bin, dir)).toBe(true);
    expect(windowsConversationLock(lock)).toBeNull();
    release!();
    expect(await holderLive(bin, dir)).toBe(false);
    const { name, proof } = makePipe(join(dir, "endpoint"));
    const holder = Bun.spawn([bin, "run", dir, name, join(dir, "conversation"), "20000"], {
      env: { ...process.env, RHODIUM_PIPE_PROOF: proof }, stderr: "pipe",
    });
    try {
      for (let i = 0; i < 40 && !(await holderLive(bin, dir)); i++) await Bun.sleep(30);
      expect(await holderLive(bin, dir)).toBe(true);
      expect(windowsConversationLock(lock)).toBeNull();
    } finally {
      holder.kill();
      await holder.exited;
    }
    release = windowsConversationLock(lock);
    expect(release).not.toBeNull();
  } finally {
    release?.();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows holder keeps a .cmd agent and its Node tool on an invisible console across reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-hold-"));
  const pipe = join(dir, "endpoint");
  const { name, proof } = makePipe(pipe);
  const holder = Bun.spawn([process.env.RHODIUM_TEST_HOLD!, "run", dir, name, join(dir, "lock"), "10000"], { stderr: "inherit", env: { ...process.env, RHODIUM_PIPE_PROOF: proof } });
  let link: HolderLink | undefined;
  const received: string[] = [];
  const on = { out: (_: number, bytes: Uint8Array) => received.push(Buffer.from(bytes).toString()), exit() {} };
  try {
    for (let i = 0; i < 100 && !link; i++) {
      link = await connectHolder(pipe, { boot: 1, offset: 0 }, on).catch(() => undefined);
      if (!link) await Bun.sleep(40);
    }
    if (!link) throw new Error("Windows holder never opened its pipe");
    // Match an npm-style shim, Node and a console tool started without any hiding flags.
    const shim = join(dir, "rhodium-test-agent.cmd");
    writeFileSync(shim, '@echo off\r\nnode "%~dp0agent.cjs"\r\n');
    writeFileSync(join(dir, "agent.cjs"), `
      const { spawnSync } = require("node:child_process");
      const probe = spawnSync("python.exe", [process.env.CONSOLE_PROBE], {stdio: ["ignore", "inherit", "inherit"]});
      if (probe.status !== 0) process.exit(1);
      process.stdin.pipe(process.stdout);
    `);
    const pid = await link.start({ argv: [shim], cwd: dir, env: { SystemRoot: process.env.SystemRoot!, PATH: process.env.PATH!, CONSOLE_PROBE: consoleProbe } });
    await link.write("first", "one");
    link.close();
    await Bun.sleep(400);
    received.length = 0;
    link = await connectHolder(pipe, { boot: 2, offset: 0 }, on);
    expect(link.hello.pid).toBe(pid);
    expect(link.hello.written).toContain("first");
    await link.eof();
    expect((await link.exited).code).toBe(0);
    const [snapshot, echoed] = received.join("").trimEnd().split(/\r?\n/);
    const report = JSON.parse(snapshot!);
    expect(report.visible).toBe(false);
    expect(report.attached).toEqual(expect.arrayContaining([pid, report.parent, report.tool]));
    expect(echoed).toBe("one");
    expect(await holder.exited).toBe(0);
  } finally {
    link?.close();
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test.skipIf(process.platform !== "win32")("compiled daemon serves the board, enforces CLI permissions and reattaches the same active agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-daemon-"));
  const config = join(dir, "config.toml");
  const apps = join(dir, "missing.exe");
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((ok, fail) => { probe.once("listening", ok); probe.once("error", fail); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  writeFileSync(config, `[programs]\nclaude = ${JSON.stringify(process.env.RHODIUM_TEST_AGENT!)}\ncodex = ${JSON.stringify(apps)}\npi = ${JSON.stringify(apps)}\n[board]\nauth = "none"\nport = ${port}\n`);
  // Set explicit test-only ACLs on both fixtures; hosted runners can give
  // TEMP additional grants which do not belong in a private instance.
  const acl = `
    $ErrorActionPreference='Stop'
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $dir=[Security.AccessControl.DirectorySecurity]::new()
    $dir.SetOwner($sid)
    $dir.SetAccessRuleProtection($true,$false)
    $dir.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    $world=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $dir.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
    [IO.Directory]::SetAccessControl($env:RHODIUM_TEST_DIR, $dir)
    $file=[Security.AccessControl.FileSecurity]::new()
    $file.SetOwner($sid)
    $file.SetAccessRuleProtection($true,$false)
    $file.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
    [IO.File]::SetAccessControl($env:RHODIUM_TEST_CONFIG, $file)
    $other = [IO.Path]::Combine($env:RHODIUM_TEST_DIR, 'public-test.txt')
    [IO.File]::WriteAllText($other, '')
    $world=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $file.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,'Read','Allow'))
    [IO.File]::SetAccessControl($other, $file)
  `;
  const setup = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(acl, "utf16le").toString("base64")],
    { env: { ...process.env, RHODIUM_TEST_DIR: dir, RHODIUM_TEST_CONFIG: config }, stdout: "ignore", stderr: "ignore" });
  expect(setup.exitCode).toBe(0);
  expect(() => checkWindowsPermissions([join(dir, "public-test.txt")])).toThrow("其他账号有访问权");
  expect(() => checkWindowsPermissions([dir])).toThrow();
  checkWindowsPermissions([config]);
  const otherConfig = join(dir, "private.toml");
  const original = '[bots.q]\nplatform = "qq"\ntarget = "w/a"\n';
  createPrivateWindows([otherConfig], original);
  const backup = renameTarget(otherConfig, "w/a", "w/b")!.backup;
  expect(readFileSync(backup, "utf8")).toBe(original);
  expect(readFileSync(otherConfig, "utf8")).toContain('target = "w/b"');
  checkWindowsPermissions([otherConfig, backup]);
  const exe = process.env.RHODIUM_TEST_EXE!;
  const local: Record<string, string | undefined> = { ...process.env, LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: join(dir, "claude-profile"), CODEX_HOME: join(dir, "codex-profile") };
  delete local.RHODIUM_SOCKET;
  delete local.RHODIUM_TOKEN;
  // A surviving holder may inherit an OS handle; restarting the task must not wait for log EOF.
  const log = join(dir, "task.log");
  const start = () => Bun.spawn([process.env.RHODIUM_TEST_HOLD!, "task", "--config", config], { cwd: dir, env: local, stdout: "ignore", stderr: Bun.file(log) });
  const launcher = start();
  const exited = () => Promise.race([launcher.exited, Bun.sleep(6000).then(() => { throw new Error("task launcher did not exit"); })]);
  const cli = async (...args: string[]) => {
    const p = Bun.spawn([exe, "rh", ...args], { env: local, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };
  async function ready() {
    for (const end = Date.now() + 15000; Date.now() < end;) {
      if (launcher.exitCode !== null) throw new Error("isolated daemon exited with code " + launcher.exitCode);
      if ((await cli("ls")).code === 0) return;
      await Bun.sleep(100);
    }
    throw new Error("isolated daemon did not accept CLI connections");
  }
  const root = join(dir, "Rhodium");
  const state = join(root, "state");
  async function act(body: object) {
    const response = await fetch(`http://127.0.0.1:${port}/api/act`, { method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ id: crypto.randomUUID(), act: body }),
    });
    const reply = await response.json() as { ok: boolean; error?: string; slot?: string; text?: string };
    if (!reply.ok) throw new Error(reply.error ?? "board request failed");
    return reply;
  }
  try {
    await ready();
    checkWindowsPermissions([state, join(root, "run"), join(state, "lock")]);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="viewport"');
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(asset).toBeDefined();
    expect((await fetch(new URL(asset!, page.url))).status).toBe(200);
    const get = async (route: string, params: Record<string, string>) => {
      const res = await fetch(new URL(route + "?" + new URLSearchParams(params), page.url), {
        headers: { "sec-fetch-site": "same-origin" }, signal: AbortSignal.timeout(6000),
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    const controller = (await get("/api/rhodium", {})).pid as number;
    expect(controller).not.toBe(launcher.pid);
    const probe = Bun.spawnSync(["python.exe", consoleProbe, String(controller)], { stdout: "pipe", stderr: "pipe" });
    expect(probe.exitCode).toBe(0);
    expect(JSON.parse(probe.stdout.toString())).toMatchObject({ visible: false, attached: expect.arrayContaining([controller]) });
    const home = await realpath(dir);
    const project = join(home, "路径 with space");
    mkdirSync(project);
    for (const root of ["C:\\", "C:/"]) {
      const listed = await get("/api/dirs", { path: root });
      expect(listed.error).toBeUndefined();
      expect(listed.up).toBeNull();
      expect(listed.path.toUpperCase()).toBe("C:/");
    }
    expect((await get("/api/board", {})).windowsPaths).toBe(true);
    const atHome = await get("/api/dirs", { path: "~" });
    expect(atHome.path).toBe("~");
    expect(atHome.dirs).toContain("路径 with space");
    for (const path of [project, project.replaceAll("\\", "/"), "~\\路径 with space"]) {
      expect(await get("/api/dirs", { path })).toMatchObject({ path: "~/路径 with space", up: "~" });
    }
    await act({ kind: "rh", argv: ["ws", "drive", "~\\路径 with space"] });
    const created = await act({ kind: "rh", argv: ["new", "drive/local", "--dir", project] });
    expect(created.slot).toBeDefined();
    const id = crypto.randomUUID();
    const transcripts = join(local.CLAUDE_CONFIG_DIR!, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcripts, { recursive: true });
    // Claude conversation lines begin with parentUuid; lines beginning with type are its metadata.
    const fixtureDir = join(import.meta.dir, "fixtures", "transcripts", "claude");
    const fixture = readdirSync(fixtureDir).find((name) => name.endsWith(".jsonl"))!;
    const oldId = fixture.slice(-42, -6);
    const cwd = "//?/" + project.replaceAll("\\", "/");
    const history = readFileSync(join(fixtureDir, fixture), "utf8").replaceAll(oldId, id)
      .replace(/"cwd":"[^"]*"/g, () => '"cwd":' + JSON.stringify(cwd));
    writeFileSync(join(transcripts, id + ".jsonl"), history);
    const otherId = crypto.randomUUID();
    writeFileSync(join(transcripts, otherId + ".jsonl"), history.replaceAll(id, otherId));
    const resumed = await act({ kind: "say", slot: created.slot, text: "/resume " + otherId.slice(0, 12) });
    expect(resumed.text).toContain("已回到");
    // Linux disk import requires an existing cwd; the record can outlive the original directory.
    const replaced = join(project, "former-folder");
    writeFileSync(replaced, "");
    const oldFolderId = crypto.randomUUID();
    writeFileSync(join(transcripts, oldFolderId + ".jsonl"), history.replaceAll(id, oldFolderId).replaceAll(JSON.stringify(cwd), JSON.stringify(replaced)));
    expect((await act({ kind: "rh", argv: ["import", oldFolderId, "--name", "old-path"] })).slot).toBeDefined();
    const candidates = await get("/api/importable", { agent: "claude", dir: "~\\路径 with space" });
    expect(candidates.list.map((row: { session: string }) => row.session)).toContain(id);
    async function withAgent<T>(args: string[], check: () => Promise<T>) {
      const other = Bun.spawn([local.RHODIUM_TEST_AGENT!, ...args], { env: local, cwd: project, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      try {
        const result = await check();
        expect(other.exitCode).toBeNull();
        return result;
      } finally {
        other.kill();
        await other.exited;
      }
    }
    // Keep an unrelated interactive instance of the very same executable running throughout.
    const imported = await withAgent([], async () => {
      await withAgent(["--session-id", id], async () => {
        await expect(act({ kind: "rh", argv: ["import", id, "--name", "busy"] })).rejects.toThrow("另一个进程正在用这段对话");
      });
      return act({ kind: "rh", argv: ["import", id, "--name", "imported"] });
    });
    expect(imported.slot).toBeDefined();
    const stateDb = new Database(join(state, "rh.db"), { readonly: true });
    try {
      const row = stateDb.query("SELECT s.dir, s.workspace, c.sessionId FROM slot s JOIN conversation c ON c.id=s.conversation WHERE s.id=?");
      const one = row.get(created.slot!) as { dir: string; workspace: string };
      const two = row.get(imported.slot!) as { dir: string; workspace: string; sessionId: string };
      expect(win32.relative(await realpath(one.dir), project)).toBe("");
      expect(win32.relative(await realpath(two.dir), project)).toBe("");
      expect(two.workspace).toBe(one.workspace);
      expect(two.sessionId).toBe(id);
    } finally { stateDb.close(); }
    const denied = await cli("stop", "--all");
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("只有用户本人");
    await act({ kind: "rh", argv: ["ws", "test", dir] });
    const { slot } = await act({ kind: "rh", argv: ["new", "test/one"] });
    expect(slot).toBeDefined();
    const waiting = join(dir, "waiting-for-agent");
    writeFileSync(waiting, "");
    await act({ kind: "say", slot, text: "Windows native test" });
    for (let n = 0; n < 100 && existsSync(waiting); n++) await Bun.sleep(100);
    expect(existsSync(waiting)).toBe(false);
    // Mirror the tester guide and use the controller PID reported by this isolated board.
    const killed = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${controller}).Kill()`]);
    expect(killed.exitCode).toBe(0);
    // The same launcher restarts the controller. The holder keeps the in-flight reply.
    await ready();
    expect((await get("/api/rhodium", {})).pid).not.toBe(controller);
    const db = new Database(join(state, "rh.db"), { readonly: true });
    try {
      const status = () => db.query("SELECT state FROM slot WHERE id=?").get(slot!) as { state: string };
      for (let n = 0; n < 80 && status().state !== "idle"; n++) await Bun.sleep(100);
      expect(status().state).toBe("idle");
    } finally { db.close(); }
    expect(readFileSync(join(dir, "fake-agent-pids"), "utf8").trim().split(/\s+/)).toHaveLength(1);
    const holds = readdirSync(join(state, "hold"));
    expect(holds).toHaveLength(1);
    writeFileSync(join(state, "hold", holds[0]!, "err.log"), "stderr fixture\n");
    const detail = await get("/api/slot", { id: slot! });
    expect(detail.process).toEqual({ stderr: ["stderr fixture"] });
    expect(readFileSync(join(state, "hold", holds[0]!, "out.log"), "utf8")).toContain("Windows smoke reply");
    // Lose the endpoint, then restart the controller with the original holder and Job still alive.
    const endpoint = join(root, "run", "hold", holds[0]! + ".sock");
    const saved = readFileSync(endpoint);
    makePipe(endpoint);
    const restarted = (await get("/api/rhodium", {})).pid as number;
    try {
      process.kill(restarted, "SIGKILL");
      const holderDir = join(state, "hold", holds[0]!);
      for (const until = Date.now() + 35000; await holderLive(process.env.RHODIUM_TEST_HOLD!, holderDir);) {
        if (Date.now() > until) throw Error("unreachable holder still owns its Job");
        await Bun.sleep(150);
      }
      await ready();
      const check = new Database(join(state, "rh.db"), { readonly: true });
      try {
        const row = check.query("SELECT exited FROM holder WHERE conversation=?");
        for (const until = Date.now() + 5000; !(row.get(holds[0]!) as {exited: number}).exited;) {
          if (Date.now() > until) throw Error("unreachable holder was not settled");
          await Bun.sleep(50);
        }
      } finally { check.close(); }
    } finally { writeFileSync(endpoint, saved); }

  } catch (cause) {
    launcher.kill();
    await exited();
    const events = readFileSync(log, "utf8").trim().split("\n").slice(-12).map((line) => {
      try { const event = JSON.parse(line); return [event.msg, event.error].filter(Boolean).join(" "); }
      catch { return "unstructured diagnostic"; }
    });
    const hold = join(state, "hold");
    for (const id of existsSync(hold) ? readdirSync(hold) : []) {
      const err = join(hold, id, "err.log");
      if (existsSync(err)) events.push(readFileSync(err, "utf8").slice(-700));
    }
    throw new Error("isolated daemon: " + events.join(" | "), { cause });
  } finally {
    launcher.kill();
    await exited();
    const hold = join(state, "hold");
    for (const id of existsSync(hold) ? readdirSync(hold) : []) {
      const link = await connectHolder(join(root, "run", "hold", id + ".sock"), { boot: 3, offset: 0 }, { out() {}, exit() {} }).catch(() => null);
      if (link) {
        await link.signal("KILL").catch(() => {});
        link.close();
      }
      for (let i = 0; i < 30 && await holderLive(process.env.RHODIUM_TEST_HOLD!, join(hold, id)); i++) await Bun.sleep(100);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);
