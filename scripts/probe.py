#!/usr/bin/env python3
"""Brief real Medusa HTTP probe; always stop the session we created."""
import os
import urllib.request
from importlib import import_module
from pathlib import Path

root = Path(__file__).resolve().parent.parent


def check():
    with urllib.request.urlopen("http://127.0.0.1:19000/health", timeout=2) as res:
        assert res.status == 200
        print(f"PASS live Medusa GET /health: {res.status} {res.read().decode()}", flush=True)


import_module("server-lifecycle").serve(
    ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1",
     "--port", "19000", "--no-types"],
    os.environ.copy(), "server-probe.log", check, port=19000, cwd=root / "medusa",
)
