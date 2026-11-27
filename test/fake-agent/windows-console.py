"""Report console visibility and membership on a Windows Runner without a desktop."""
import ctypes
import json
import os
import sys
from ctypes import wintypes

kernel = ctypes.windll.kernel32
kernel.GetConsoleWindow.restype = wintypes.HWND
visible = ctypes.windll.user32.IsWindowVisible
visible.argtypes = [wintypes.HWND]

if len(sys.argv) > 1:
    kernel.FreeConsole()
    if not kernel.AttachConsole(int(sys.argv[1])):
        raise ctypes.WinError()
pids = (wintypes.DWORD * 64)()
count = kernel.GetConsoleProcessList(pids, len(pids))
print(json.dumps({"visible": bool(visible(kernel.GetConsoleWindow())), "attached": list(pids[:count]),
                  "parent": os.getppid(), "tool": os.getpid()}))
