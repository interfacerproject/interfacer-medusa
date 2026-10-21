#!/usr/bin/env python3
"""Brief real Medusa HTTP probe; always terminate the full dev process group."""
import os
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
port = 19000
# Do not accidentally report success from someone else's running process.
with socket.socket() as sock:
    sock.bind(("127.0.0.1", port))

def interrupted(signum, _frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
with (root / ".tmp/server-probe.log").open("w") as log:
    proc = subprocess.Popen(
        ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1",
         "--port", str(port), "--no-types"],
        cwd=root / "medusa", stdout=log, stderr=log, start_new_session=True,
    )
    try:
        for _ in range(90):
            if proc.poll() is not None:
                raise RuntimeError("Medusa exited; see .tmp/server-probe.log")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as res:
                    assert res.status == 200
                    print(f"PASS live Medusa GET /health: {res.status} {res.read().decode()}", flush=True)
                    break
            except (OSError, TimeoutError):
                time.sleep(1)
        else:
            raise RuntimeError("Medusa health timeout; see .tmp/server-probe.log")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        except ProcessLookupError:
            pass
