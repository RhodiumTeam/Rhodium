"""Run the compiled preview and the JS bundle of test/fake-agent/windows-cli.ts in an isolated Mac home."""
import json
import os
from pathlib import Path
import shutil
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


def wait_for(check, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for " + check.__name__)


def run(pkg, fixture, tmp):
    tmp.chmod(0o700)
    fake = tmp / "rhodium-test-claude"
    fake.write_text("#!/bin/sh\nexport BUN_BE_BUN=1\nexec " + shlex.quote(str(pkg / "rhodium")) + " " + shlex.quote(str(fixture)) + ' "$@"\n')
    fake.chmod(0o700)
    env = {"HOME": str(tmp), "PATH": "/usr/bin:/bin", "TMPDIR": str(tmp),
           "XDG_RUNTIME_DIR": str(tmp / "run"), "RHODIUM_SOCKET": str(tmp / "run/rh.sock"),
           "CODEX_HOME": str(tmp / "codex"), "CLAUDE_CONFIG_DIR": str(tmp / "claude")}
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", 0))
        port = port_probe.getsockname()[1]
    base = "http://127.0.0.1:" + str(port)
    cfg = tmp / "config.toml"
    cfg.write_text(f'stateDir = "{tmp}/state"\nsocketDir = "{tmp}/run"\nunitPrefix = "rhodium-test-mac-"\n'
                   f'[board]\nbind = "127.0.0.1"\nauth = "none"\nport = {port}\n'
                   f'[programs]\nclaude = "{fake}"\ncodex = "{tmp}/missing"\npi = "{tmp}/missing"\nherdr = "{tmp}/missing-herdr"\n')
    cfg.chmod(0o600)
    log = (tmp / "daemon.log").open("ab")
    proc = None
    agent_pid = None
    probe = tmp / "probe-test"
    probe.mkdir()
    marker_file = probe / "agent.started"
    current_boot = subprocess.check_output(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], text=True).strip()
    for token, keep in [(current_boot, True), ("unknown", True), (str(uuid.uuid4()), False)]:
        marker_file.write_text(token)
        result = subprocess.check_output([str(pkg / "rh-hold"), "probe", str(probe / "live.lock")], text=True)
        assert result.strip() == "gone" and marker_file.exists() == keep
    print("PASS same-boot orphan guard, unknown boot, and previous-boot recovery")

    def cli(*args):
        return subprocess.run([str(pkg / "rhodium"), "rh", *args], cwd=tmp, env=env, capture_output=True, timeout=3)

    def ready():
        if proc.poll() is not None:
            raise RuntimeError("daemon exited: " + (tmp / "daemon.log").read_text()[-900:])
        return cli("ls").returncode == 0

    def launch():
        return subprocess.Popen([str(pkg / "rhodium"), "--config", str(cfg)], cwd=tmp, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)

    def act(body):
        req = urllib.request.Request(base + "/api/act", data=json.dumps({"id": str(uuid.uuid4()), "act": body}).encode(),
                                     headers={"Content-Type": "application/json", "sec-fetch-site": "same-origin"})
        reply = json.load(urllib.request.urlopen(req, timeout=10))
        if not reply.get("ok"):
            raise RuntimeError(str(reply.get("error", "board request failed")))
        return reply

    try:
        proc = launch()
        wait_for(ready)
        assert cli("stop", "--all").returncode != 0
        html = urllib.request.urlopen(base + "/", timeout=3).read()
        assert b'<meta name="viewport"' in html
        act({"kind": "rh", "argv": ["ws", "test", str(tmp)]})
        session = str(uuid.uuid4())
        folder = Path(env["CODEX_HOME"]) / "sessions/2026/11/19"
        folder.mkdir(parents=True)
        transcript = folder / ("rollout-2026-11-19T20-00-00-" + session + ".jsonl")
        transcript.write_text(json.dumps({"type": "session_meta", "timestamp": "2026-11-19T20:00:00Z",
                                          "payload": {"id": session, "cwd": str(tmp)}}) + "\n")
        bin_dir = tmp / "fake-bin"
        bin_dir.mkdir()
        codex = bin_dir / "codex"
        codex.write_text("#!/usr/bin/python3\nimport sys\nsys.stdin.buffer.read()\n")
        codex.chmod(0o700)
        def external(*args):
            return subprocess.Popen([str(codex), *args], cwd=tmp, env=env, stdin=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def close_external(child):
            child.stdin.close()
            child.wait(timeout=4)
        unrelated = external("app-server")
        try:
            busy = external("resume", session)
            try:
                try:
                    act({"kind": "rh", "argv": ["import", session, "--name", "busy"]})
                except RuntimeError as error:
                    assert "另一个进程正在用这段对话" in str(error), error
                else:
                    raise AssertionError("imported a session named by a running process")
                print("PASS matching Codex command line prevents import")
            finally:
                close_external(busy)
            imported = act({"kind": "rh", "argv": ["import", session, "--name", "imported"]})["slot"]
            assert unrelated.poll() is None
            with sqlite3.connect(tmp / "state/rh.db") as db:
                assert db.execute("SELECT agent, sessionId FROM conversation WHERE slot=?", (imported,)).fetchone() == ("codex", session)
            print("PASS unrelated running Codex allows disk import")
        finally:
            close_external(unrelated)
        slot = act({"kind": "rh", "argv": ["new", "test/one"]})["slot"]
        marker = tmp / "waiting-for-agent"
        marker.touch()
        act({"kind": "say", "slot": slot, "text": "first"})
        wait_for(lambda: not marker.exists())
        pids = tmp / "fake-agent-pids"
        agent_pid = int(pids.read_text().strip())
        proc.kill()
        proc.wait(timeout=3)
        time.sleep(2.5)
        os.kill(agent_pid, 0)
        proc = launch()
        wait_for(ready)
        with sqlite3.connect(tmp / "state/rh.db") as db:
            def idle():
                return db.execute("SELECT state FROM slot WHERE id=?", (slot,)).fetchone() == ("idle",)
            wait_for(idle)
            marker.touch()
            act({"kind": "say", "slot": slot, "text": "second"})
            wait_for(lambda: not marker.exists())
            wait_for(idle)
        assert pids.read_text().splitlines() == [str(agent_pid)]
        dirs = list((tmp / "state/hold").iterdir())
        assert len(dirs) == 1 and b"Windows smoke reply" in (dirs[0] / "out.log").read_bytes()
        act({"kind": "rh", "argv": ["stop", "test/one"], "sure": True})
        wait_for(lambda: (dirs[0] / "exit").exists())
        print("PASS packaged board, Unix CLI, owner-only denial, mid-turn daemon kill, same agent after recovery, second turn and stop")
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
        def remaining():
            rows = subprocess.check_output(["/bin/ps", "-axww", "-o", "pid=,command="], text=True).splitlines()
            holders, agents = [], []
            for row in rows:
                fields = row.strip().split(None, 1)
                if len(fields) != 2:
                    continue
                pid, command = int(fields[0]), fields[1]
                if command.startswith(str(pkg / "rh-hold") + " run " + str(tmp / "state/hold") + "/"):
                    holders.append(pid)
                if str(fixture) in command or command.startswith(str(fake) + " "):
                    cwd = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                                         capture_output=True, text=True)
                    if "n" + str(tmp) in cwd.stdout.splitlines():
                        agents.append(pid)
            return holders, agents

        for sig in (signal.SIGTERM, signal.SIGKILL):
            holders, agents = remaining()
            for pid in agents + holders:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            if holders or agents:
                time.sleep(0.4)
        assert remaining() == ([], []), "test processes remain; keep the test directory"
        log.close()


if __name__ == "__main__":
    assert sys.platform == "darwin" and os.getuid() != 0
    tmp = Path(tempfile.mkdtemp(prefix="rhodium-test-", dir="/private/tmp"))
    try:
        run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), tmp)
    except BaseException:
        print("failed; isolated diagnostics at", tmp, file=sys.stderr)
        raise
    else:
        shutil.rmtree(tmp)
