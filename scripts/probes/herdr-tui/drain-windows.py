"""Check the Windows Job drain barrier with an ordinary child that spawns after its parent exits."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
import json
import os
import subprocess
import sys
import time

role, name = sys.argv[1:3]
assert name.startswith("Local\\rhodium-test-") and Path.cwd().name == "drain"
k = c.WinDLL("kernel32", use_last_error=True)
def api(name, result, *args):
    f = getattr(k, name)
    f.restype, f.argtypes = result, list(args)
    return f

H, D, U, P = w.HANDLE, w.DWORD, c.c_size_t, c.c_void_p
create = api("CreateJobObjectW", H, P, w.LPCWSTR)
open_job = api("OpenJobObjectW", H, D, w.BOOL, w.LPCWSTR)
set_job = api("SetInformationJobObject", w.BOOL, H, c.c_int, P, D)
assign = api("AssignProcessToJobObject", w.BOOL, H, H)
terminate = api("TerminateJobObject", w.BOOL, H, w.UINT)
query = api("QueryInformationJobObject", w.BOOL, H, c.c_int, P, D, c.POINTER(D))
in_job = api("IsProcessInJob", w.BOOL, H, H, c.POINTER(w.BOOL))
self_handle = api("GetCurrentProcess", H)
open_process = api("OpenProcess", H, D, w.BOOL, D)
wait = api("WaitForSingleObject", D, H, D)
close = api("CloseHandle", w.BOOL, H)

class BasicLimits(c.Structure):
    _fields_ = [("times", c.c_int64 * 2), ("flags", D), ("minws", U), ("maxws", U),
                ("active", D), ("affinity", U), ("priority", D), ("scheduler", D)]

class ExtendedLimits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", c.c_uint64 * 6), ("memory", U * 4)]

class Accounting(c.Structure):
    _fields_ = [("times", c.c_int64 * 4), ("faults", D), ("total", D), ("active", D), ("terminated", D)]

def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value

def active(job):
    info = Accounting()
    checked(query(job, 1, c.byref(info), c.sizeof(info), None))
    return info.active

def admit_next_writer(job):
    if active(job) != 0:
        return False
    with Path("next-writer-entered").open("x") as f:
        f.write("entered after drain")
    return True

def until(f, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if f():
            return
        time.sleep(.01)
    raise TimeoutError("stage timed out: " + str(f))

def publish(file, text="1"):
    tmp = Path(file + ".tmp")
    tmp.write_text(text)
    tmp.replace(file)

def start(next_role):
    return subprocess.Popen([sys.executable, "-I", "-u", __file__, next_role, name])

def member(pid, job):
    handle = checked(open_process(0x101000, False, pid))  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    yes = w.BOOL()
    checked(in_job(handle, job, c.byref(yes)))
    assert yes.value and wait(handle, 0) == 258
    return handle

if role == "host":
    # Keep the pane around after agent exit, so Herdr's own teardown cannot cause the observed drain.
    assert start("owner").wait(25) == 0
    publish("owner-exited")
    until(Path("complete").exists, 30)
elif role == "owner":
    job = checked(create(None, name))
    assert c.get_last_error() != 183  # never use an existing Job
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE, no breakaway
    checked(set_job(job, 9, c.byref(limits), c.sizeof(limits)))
    checked(assign(job, self_handle()))
    child = start("child")
    publish("initial", json.dumps([os.getpid(), child.pid]))
    until(Path("exit-now").exists)
    # Process exit closes this owner's non-inheritable handle.
elif role == "child":
    parent = checked(open_process(0x100000, False, os.getppid()))
    publish("parent-pinned")
    assert wait(parent, 20000) == 0
    close(parent)
    late = start("grandchild")
    publish("late", str(late.pid))
    time.sleep(35)
elif role == "grandchild":
    time.sleep(35)
elif role == "reopen":
    job = checked(open_job(4, False, name))  # QUERY only
    print(active(job))
    close(job)
elif role == "observe":
    until(Path("initial").exists)
    until(Path("parent-pinned").exists)
    job = checked(open_job(4 | 8, False, name))  # QUERY | TERMINATE
    handles = []
    try:
        root, child = json.loads(Path("initial").read_text())
        handles.extend([member(root, job), member(child, job)])
        publish("exit-now")
        until(Path("owner-exited").exists)
        assert wait(handles[0], 0) == 0
        until(Path("late").exists)
        handles.append(member(int(Path("late").read_text()), job))
        count = active(job)
        assert count >= 2 and wait(handles[1], 0) == 258
        again = int(subprocess.check_output([sys.executable, "-I", __file__, "reopen", name]))
        assert again == count and not admit_next_writer(job) and not Path("next-writer-entered").exists()
        print("Root exited; pinned child and post-exit grandchild live. ActiveProcesses", count,
              "second independent open", again, "next writer denied", flush=True)
        checked(terminate(job, 77))
        until(lambda: active(job) == 0)
        assert all(wait(h, 2000) == 0 for h in handles)
        assert admit_next_writer(job)
        print("TerminateJobObject -> ActiveProcesses", active(job), "all three handles signaled; next writer admitted", flush=True)
        publish("complete")
    finally:
        terminate(job, 77)
        for h in handles:
            close(h)
        close(job)
else:
    raise ValueError(role)
