#!/usr/bin/env python3
"""Stop only processes in the session we create, using per-PID signals (no killpg)."""
import os
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)


def members(group):
    rows = subprocess.check_output(["ps", "-axo", "pid=,pgid="], text=True)
    return [int(pid) for pid, pgid in (line.split() for line in rows.splitlines())
            if int(pgid) == group]


def stop(proc):
    # start_new_session=True gives us a unique process group. Discover only its
    # members; os.kill per PID works where sandbox policy rejects os.killpg.
    owned = set(members(proc.pid))
    for pid in sorted(owned, reverse=True):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 10
    while members(proc.pid) and time.monotonic() < deadline:
        proc.poll()  # reap our direct child
        time.sleep(0.1)
    for pid in members(proc.pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait(timeout=10)
    assert not members(proc.pid), "Owned Medusa processes survived cleanup"


def serve(command, env, log_name, work, port=9000, cwd=None):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
    with (root / ".tmp" / log_name).open("w") as log:
        proc = subprocess.Popen(command, cwd=cwd or root, env=env, stdout=log, stderr=log,
                                start_new_session=True)
        try:
            for _ in range(90):
                if proc.poll() is not None:
                    raise RuntimeError(f"Medusa exited; see .tmp/{log_name}")
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as res:
                        assert res.status == 200
                        break
                except (OSError, TimeoutError):
                    time.sleep(1)
            else:
                raise RuntimeError(f"Medusa health timeout; see .tmp/{log_name}")
            work()
        finally:
            stop(proc)
    with socket.socket() as sock:
        assert sock.connect_ex(("127.0.0.1", port)) != 0, "HTTP port still listening"
