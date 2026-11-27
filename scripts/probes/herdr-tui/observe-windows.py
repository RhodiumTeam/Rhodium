"""Pin the exact test child PIDs before pane.close. Read their kernel exit state afterwards."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import time

pins = []
root = Path.cwd()
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
k.CloseHandle.argtypes = [wintypes.HANDLE]
try:
    for pid in json.loads((root / "fixture-pids").read_text()):
        handle = k.OpenProcess(0x100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        assert k.WaitForSingleObject(handle, 0) == 258
        pins.append(handle)
    print("pinned", flush=True)
    for _ in range(300):
        if (root / "pane-closed").exists():
            break
        time.sleep(.05)
    else:
        raise RuntimeError("pane.close was not reported")
    time.sleep(.5)
    status = [k.WaitForSingleObject(h, 0) for h in pins]
    assert all(code in (0, 258) for code in status)
    print("OS after pane.close, fixture agent/child exited:", [code == 0 for code in status], flush=True)
finally:
    for h in pins:
        if k.WaitForSingleObject(h, 0) == 258:
            k.TerminateProcess(h, 1)  # Only handles this observer pinned from its unique fixture.
        k.CloseHandle(h)
if len(sys.argv) > 1 and sys.argv[1] == "job":
    assert status == [0, 0]
