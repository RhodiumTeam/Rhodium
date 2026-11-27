// Native equivalents of /proc/<pid>/stat and /proc/<pid>/exe for the TUI bridge.
import { dlopen } from "bun:ffi";

type ProcessInfo = { state: string; ppid: number; start: number; exe: string };

const openMac = () => dlopen("/usr/lib/libproc.dylib", {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
});
let mac: ReturnType<typeof openMac>;

function macProcess(pid: number): ProcessInfo | null {
  const { proc_pidinfo, proc_pidpath } = (mac ??= openMac()).symbols;
  // Darwin <sys/proc_info.h>: PROC_PIDTBSDINFO, struct proc_bsdinfo (64-bit).
  const info = Buffer.alloc(136);
  if (proc_pidinfo(pid, 3, 0, info, info.length) !== info.length) return null;
  const state = ["?", "I", "R", "S", "T", "Z"][info.readUInt32LE(4)] ?? "?";
  const start = Number(info.readBigUInt64LE(120)) * 1_000_000 + Number(info.readBigUInt64LE(128));
  const path = Buffer.alloc(4096); // PROC_PIDPATHINFO_MAXSIZE
  const size = proc_pidpath(pid, path, path.length);
  return { state, ppid: info.readUInt32LE(16), start, exe: size > 0 ? path.toString("utf8", 0, size) : "" };
}

const openKernel = () => dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
  TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
});
const openNt = () => dlopen("ntdll.dll", {
  NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
});
let kernel: ReturnType<typeof openKernel>;
let nt: ReturnType<typeof openNt>;

function windowsProcess(pid: number): ProcessInfo | null {
  const api = (kernel ??= openKernel()).symbols;
  const { NtQueryInformationProcess } = (nt ??= openNt()).symbols;
  const handle = api.OpenProcess(0x00101000, 0, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
  if (!handle) return null;
  try {
    // All lookups use this same process object, even if Windows reuses its PID.
    const basic = Buffer.alloc(48); // PROCESS_BASIC_INFORMATION on 64-bit Windows
    if (NtQueryInformationProcess(handle, 0, basic, basic.length, null) !== 0) return null;
    const times = Buffer.alloc(32);
    if (!api.GetProcessTimes(handle, times, times.subarray(8), times.subarray(16), times.subarray(24))) return null;
    const start = Number(times.readBigUInt64LE() / 10n - 11644473600000000n); // FILETIME to Unix microseconds
    const size = new Uint32Array([32768]);
    const path = Buffer.alloc(size[0]! * 2);
    const exe = api.QueryFullProcessImageNameW(handle, 0, path, size) ? path.toString("utf16le", 0, size[0]! * 2) : "";
    const wait = api.WaitForSingleObject(handle, 0);
    if (wait !== 0 && wait !== 258) return null; // signaled or WAIT_TIMEOUT
    return { state: wait === 0 ? "Z" : "R", ppid: basic.readUInt32LE(40), start, exe };
  } finally {
    api.CloseHandle(handle);
  }
}

/** Start is Unix microseconds. An unreadable executable path does not erase a live process's identity. */
export function nativeProcess(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return null;
  try {
    if (process.platform === "darwin") return macProcess(pid);
    if (process.platform === "win32") return windowsProcess(pid);
  } catch {
    // Match the Linux TUI's behavior for inaccessible process information.
  }
  return null;
}

// A verified detached holder owns the only handle to its Job. Check the same kernel handle we end.
export function terminateWindowsHolder(pid: number, start: number) {
  const api = (kernel ??= openKernel()).symbols;
  const handle = api.OpenProcess(0x101001, 0, pid);
  if (!handle) throw new Error("无法确认失联托管进程");
  try {
    const times = Buffer.alloc(32);
    if (!api.GetProcessTimes(handle, times, times.subarray(8), times.subarray(16), times.subarray(24))) throw new Error("无法核实托管进程创建时间");
    if (Number(times.readBigUInt64LE() / 10n - 11644473600000000n) !== start || api.WaitForSingleObject(handle, 0) === 0) return;
    if (!api.TerminateProcess(handle, 1)) throw new Error("无法结束失联托管进程");
  } finally { api.CloseHandle(handle); }
}
