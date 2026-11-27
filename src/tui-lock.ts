// Match std::fs::File::try_lock in rh-hold on Windows (exclusive, nonblocking, the whole file).
import { dlopen } from "bun:ffi";
import { toNamespacedPath } from "node:path";

const load = () => dlopen("kernel32.dll", {
  CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
  LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "buffer"], returns: "i32" },
  UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "buffer"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
}).symbols;
let kernel: ReturnType<typeof load> | undefined;

export function windowsConversationLock(path: string): (() => void) | null {
  const api = kernel ??= load();
  if (path.includes("\0")) throw new Error("invalid conversation lock path");
  const wide = Buffer.from(toNamespacedPath(path) + "\0", "utf16le");
  // GENERIC_WRITE, all share modes and OPEN_ALWAYS match Rust's non-truncating OpenOptions.
  const handle = api.CreateFileW(wide, 0x40000000, 7, null, 4, 0x80, null);
  if (handle === 0xffffffffffffffffn) throw new Error(`cannot open conversation lock (Windows ${api.GetLastError()})`);
  const overlapped = new BigUint64Array(4); // 32-byte OVERLAPPED at offset zero on 64-bit Windows.
  const range = 0xffffffff;
  if (!api.LockFileEx(handle, 3, 0, range, range, overlapped)) {
    const error = api.GetLastError();
    api.CloseHandle(handle);
    if (error === 33) return null; // ERROR_LOCK_VIOLATION
    throw new Error(`cannot take conversation lock (Windows ${error})`);
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const ok = api.UnlockFileEx(handle, 0, range, range, overlapped);
    const error = ok ? 0 : api.GetLastError();
    api.CloseHandle(handle);
    if (!ok) throw new Error(`cannot release conversation lock (Windows ${error})`);
  };
}
