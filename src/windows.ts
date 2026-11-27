// On Windows the name is public. The OS checks pipe clients' access and the
// private descriptor lets clients verify the listening server before sending credentials.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export const windows = process.platform === "win32";

export const windowsRoot = (env: Record<string, string | undefined>) => {
  if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
  return join(env.LOCALAPPDATA, "Rhodium");
};

export function makePipe(file: string, reuse = false): { name: string; proof: string } {
  if (reuse && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const endpoint = { name: "\\\\.\\pipe\\rhodium-" + randomUUID(), proof: randomUUID() };
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(endpoint));
  renameSync(tmp, file);
  return endpoint;
}

export function dialWindows(file: string, deadline?: number): Promise<Socket> {
  const { name, proof } = JSON.parse(readFileSync(file, "utf8"));
  return new Promise((resolve, reject) => {
    const socket = connect(name);
    const expected = Buffer.from(proof + "\n");
    let pos = 0;
    const timeout = setTimeout(() => socket.destroy(new Error("Windows pipe handshake timed out")), deadline === undefined ? 5000 : Math.max(1, Math.min(5000, deadline - Date.now())));
    const closed = () => { clearTimeout(timeout); reject(new Error("Windows pipe closed during authentication")); };
    function read(data: Buffer) {
      if (!data.equals(expected.subarray(pos, pos + data.length))) {
        socket.destroy(new Error("unrecognized Windows pipe server"));
        return;
      }
      pos += data.length;
      if (pos === expected.length) {
        clearTimeout(timeout);
        socket.off("data", read);
        socket.off("close", closed);
        resolve(socket);
      }
    }
    socket.once("error", reject);
    socket.once("close", closed);
    socket.on("data", read);
  });
}

/** The Rust listener enforces the current user's pipe ACL and rejects remote clients. */
export async function serveWindowsCli(bin: string, file: string, request: (line: string, reply: (json: string) => void) => void) {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { name, proof } = makePipe(file);
  const child = spawn(bin, ["cli", name], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, RHODIUM_PIPE_PROOF: proof } });
  const ready = Promise.withResolvers<void>();
  child.once("error", ready.reject);
  child.stdin.on("error", () => {}); // child exit below restarts the task
  child.once("exit", () => { console.error("Windows CLI listener exited"); process.exit(1); });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (line === "ready") return ready.resolve();
    const space = line.indexOf(" ");
    const id = line.slice(0, space);
    if (!/^\d+$/.test(id)) return;
    request(line.slice(space + 1), (json) => child.stdin.write(id + " " + json + "\n"));
  });
  return ready.promise;
}

// Windows PowerShell 5.1 accepts an encoded UTF-16 script independently of the
// quoting of paths or multiline command arguments. Use the .NET ACL API directly.
const aclCheck = Buffer.from(`
$ErrorActionPreference = 'Stop'
try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4')
  foreach ($path in ($env:RHODIUM_ACL_PATHS -split [char]10)) {
    if ([IO.Directory]::Exists($path)) { $acl = [IO.Directory]::GetAccessControl($path) }
    else { $acl = [IO.File]::GetAccessControl($path) }
    $sidType = [Security.Principal.SecurityIdentifier]
    $owner = $acl.GetOwner($sidType)
    if ($trusted -notcontains $owner.Value) { exit 2 }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
      if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { exit 3 }
    }
    # A null DACL grants access to everybody even though GetAccessRules returns no entries.
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { exit 4 }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.GetType().Name)
  exit 5
}
`, "utf16le").toString("base64");

export function checkWindowsPermissions(paths: string[]) {
  const system = process.env.SystemRoot;
  if (!system) throw new Error("SystemRoot is not set");
  if (paths.some((p) => /[\r\n]/.test(p))) throw new Error("invalid Windows instance path");
  const proc = Bun.spawnSync([join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", aclCheck],
    { windowsHide: true, env: { ...process.env, RHODIUM_ACL_PATHS: paths.join("\n") }, stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode === 0) return;
  const reason = ({ 2: "目录或文件的所有者不属于本人、系统或管理员", 3: "其他账号有访问权", 4: "缺少 DACL" } as Record<number, string>)[proc.exitCode];
  const exception = proc.stderr.toString().match(/\b[A-Za-z]+Exception\b/)?.[0];
  // Never include account names or SIDs from the security descriptor in diagnostic output.
  throw new Error(`Windows 权限检查未通过：${reason ?? `读取 ACL 失败（退出码 ${proc.exitCode}${exception ? "，" + exception : ""}）`}`);
}

// Create the object with its DACL, before writing any private data. Existing directories keep their ACL.
export function createPrivateWindows(paths: string[], contents?: string) {
  const file = contents !== undefined;
  const script = `
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.${file ? "FileSecurity" : "DirectorySecurity"}]::new()
$acl.SetOwner($me)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', '${file ? "None" : "ContainerInherit,ObjectInherit"}', 'None', 'Allow'))
foreach ($p in (ConvertFrom-Json $env:RHODIUM_CREATE_PATHS)) {
  ${file ? `$stream = [IO.FileStream]::new($p, 'CreateNew', [Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $acl)
  try { [Console]::OpenStandardInput().CopyTo($stream) } finally { $stream.Dispose() }` : "[IO.Directory]::CreateDirectory($p, $acl) | Out-Null"}
}`;
  const result = Bun.spawnSync([join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, env: { ...process.env, RHODIUM_CREATE_PATHS: JSON.stringify(paths) },
    stdin: file ? Buffer.from(contents!) : "ignore", stdout: "ignore", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`创建私有${file ? "配置文件" : "目录"}失败（退出码 ${result.exitCode}）`);
}
