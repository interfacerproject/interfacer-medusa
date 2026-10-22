#!/usr/bin/env python3
"""Foreground local demo supervisor. Own PID + owned server session; no killall/killpg."""
import fcntl
import importlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "scripts"))
lifecycle = importlib.import_module("server-lifecycle")
client = importlib.import_module("store-client")
STATE = ROOT / ".tmp/dev-store-runtime.json"
LOCK = ROOT / ".tmp/dev-store.lock"


def stamp(pid):
    return subprocess.check_output(["ps", "-p", str(pid), "-o", "lstart=,command="], text=True).strip()


def down():
    if not STATE.exists():
        print("Local storefront is not running (no owned PID).")
        return
    state = json.loads(STATE.read_text())
    try:
        current = stamp(state["pid"])
    except subprocess.CalledProcessError:
        raise RuntimeError("Stale runtime file; no process was signaled. Inspect .tmp/dev-store-runtime.json")
    if current != state["stamp"] or "scripts/dev-store.py up" not in current:
        raise RuntimeError("PID identity changed; refusing to signal it")
    os.kill(state["pid"], signal.SIGTERM)
    for _ in range(600):
        if not STATE.exists():
            print("Stopped owned Medusa PIDs and demo DB (data retained).")
            return
        time.sleep(0.1)
    raise RuntimeError("Shutdown timeout; see .tmp/dev-store-server.log")


def up():
    if os.environ.get("NODE_ENV") == "production":
        raise RuntimeError("Refusing LOCAL DEV storefront in production")
    (ROOT / ".tmp").mkdir(exist_ok=True)
    with LOCK.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A storefront supervisor already owns this project; npm run dev:down first")
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", 9000))
        env = os.environ.copy()
        env.setdefault("INTERFACER_DB_CONTAINER", "interfacer-medusa-p6b-dev-db")
        env.setdefault("INTERFACER_DB_PORT", "55437")
        env.setdefault("DATABASE_URL", f"postgres://medusa:medusa_local@127.0.0.1:{env['INTERFACER_DB_PORT']}/interfacer_medusa")
        env.update(INTERFACER_AUTH_MODE="signed-envelope-local", INTERFACER_DEV_STOREFRONT="true",
                   INTERFACER_KEYRING_PATH=str(ROOT / ".tmp/auth-public-keyring.json"),
                   MEDUSA_DISABLE_TELEMETRY="true", npm_config_cache=str(ROOT / ".cache/npm"),
                   XDG_CONFIG_HOME=str(ROOT / ".cache/config"), TMPDIR=str(ROOT / ".tmp"))
        # Only this project's newly labeled containers may be reused here.
        check = subprocess.run(["docker", "inspect", "--format", '{{index .Config.Labels "interfacer.medusa.root"}}', env["INTERFACER_DB_CONTAINER"]], capture_output=True, text=True)
        if check.returncode == 0 and check.stdout.strip() != str(ROOT):
            raise RuntimeError("Refusing pre-existing container not created for this project")
        STATE.write_text(json.dumps({"pid": os.getpid(), "stamp": stamp(os.getpid()), "container": env["INTERFACER_DB_CONTAINER"]}))
        proc = None
        try:
            print("LOCAL DEV — fixture/dev keys, not production. Preparing DB + Medusa…", flush=True)
            # Use a new session even during setup so interrupted boots clean up.
            with (ROOT / ".tmp/dev-store-setup.log").open("w") as log:
                proc = subprocess.Popen(["bash", "scripts/spike.sh", "setup"], env=env, stdout=log, stderr=log, start_new_session=True)
                if proc.wait() != 0:
                    raise RuntimeError("Setup failed; see .tmp/dev-store-setup.log")
                proc = None
                subprocess.run(["node", "scripts/sign.cjs", "--seed-person", "01JTESTPERSON00000000000001"], env=env, check=True)
                proc = subprocess.Popen(["./node_modules/.bin/medusa", "exec", "./src/scripts/seed-matching.ts"], cwd=ROOT / "medusa", env=env, stdout=log, stderr=log, start_new_session=True)
                if proc.wait() != 0:
                    raise RuntimeError("Matching seed failed; see .tmp/dev-store-setup.log")
                proc = None
            with (ROOT / ".tmp/dev-store-server.log").open("w") as log:
                proc = subprocess.Popen(["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"], cwd=ROOT / "medusa", env=env, stdout=log, stderr=log, start_new_session=True)
                for _ in range(120):
                    if proc.poll() is not None:
                        raise RuntimeError("Medusa exited; see .tmp/dev-store-server.log")
                    try:
                        urllib.request.urlopen("http://127.0.0.1:9000/health", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(1)
                else:
                    raise RuntimeError("Medusa health timeout")
                # Client-side bootstrap signs merchant actions with P6a's helper.
                os.environ.update(env)
                client.bootstrap()
                print("\nSTOREFRONT READY: http://localhost:9000/dev/store\nLOCAL DEV SIGNER + manual test payment; REA sink/key resolver are local stand-ins.\nCtrl-C or npm run dev:down to stop. No sold stock is replenished.\n", flush=True)
                while proc.poll() is None:
                    time.sleep(0.5)
                raise RuntimeError("Medusa exited unexpectedly; see .tmp/dev-store-server.log")
        finally:
            try:
                if proc is not None:
                    lifecycle.stop(proc)
            finally:
                try:
                    subprocess.run(["bash", "scripts/spike.sh", "stop"], env=env, check=True)
                finally:
                    STATE.unlink(missing_ok=True)
                    (ROOT / ".tmp/dev-store-bootstrap.md").write_text("\n".join(client.transcript))


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ["up", "down"]:
        raise SystemExit("Usage: python3 scripts/dev-store.py up|down")
    try:
        up() if sys.argv[1] == "up" else down()
    except KeyboardInterrupt:
        pass
