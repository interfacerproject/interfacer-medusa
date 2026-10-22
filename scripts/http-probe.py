#!/usr/bin/env python3
"""Real curl acceptance for the local API; always stop our entire server group."""
import copy
import json
import os
import shlex
import signal
import subprocess
from pathlib import Path
from urllib.parse import urlparse

root = Path(__file__).resolve().parent.parent
url = "http://localhost:9000/dev/interfacer/listings"
transcript = []


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)


def curl(*args, expected=200):
    command = ["curl", "--silent", "--show-error", "--max-time", "30",
               "--write-out", "\nHTTP %{http_code}\n", *args, url]
    output = subprocess.check_output(command, cwd=root, text=True)
    block = "```bash\n" + shlex.join(command) + "\n```\n\n```text\n" + output + "```\n"
    transcript.append(block)
    print(block, flush=True)
    body, status = output.rsplit("\nHTTP ", 1)
    assert int(status.strip()) == expected, output
    return json.loads(body) if body and not body.startswith("HTTP/") else body


def counts():
    database = urlparse(os.environ["DATABASE_URL"]).path.lstrip("/")
    return subprocess.check_output([
        "docker", "exec", os.environ.get("INTERFACER_DB_CONTAINER", "interfacer-medusa-spike-db"), "psql", "-U", "medusa",
        "-d", database, "-Atc",
        "SELECT (SELECT count(*) FROM product), (SELECT count(*) FROM product_variant), "
        "(SELECT count(*) FROM interfacer_listing_binding), "
        "(SELECT count(*) FROM interfacer_projection_intent);",
    ], text=True).strip()


# Shared per-PID cleanup; sandbox does not permit killpg.
from importlib import import_module
serve = import_module("server-lifecycle").serve

resource = json.loads((root / "docs/fixtures/economic-resource.json").read_text())
dpp = json.loads((root / "docs/fixtures/dpp.json").read_text())
payload = {"resource": resource, "dpp": dpp, "actingPersonId": resource["primaryAccountable"]["id"]}
wrong = {**payload, "actingPersonId": "some-other-person"}
invalid = copy.deepcopy(payload)
invalid["dpp"]["ProductID"] = "foreign-resource"
new_denied = copy.deepcopy(wrong)
new_denied["resource"]["id"] += "-denied-http"
new_denied["dpp"]["ProductID"] = new_denied["resource"]["id"]
conflict = copy.deepcopy(payload)
conflict["resource"]["name"] = "Changed over HTTP"
for name, body in [("request", payload), ("wrong-person", wrong), ("invalid-binding", invalid),
                   ("new-denied", new_denied), ("conflict", conflict)]:
    (root / f".tmp/http-{name}.json").write_text(json.dumps(body, ensure_ascii=False) + "\n")


def post(name, expected):
    return curl("-H", "Origin: http://localhost:3104", "-H", "Content-Type: application/json",
                "--data-binary", f"@.tmp/http-{name}.json", expected=expected)


def enabled_checks():
    for origin in ["http://localhost:3104", "http://localhost:3000"]:
        headers = curl("-i", "-X", "OPTIONS", "-H", f"Origin: {origin}",
                       "-H", "Access-Control-Request-Method: POST",
                       "-H", "Access-Control-Request-Headers: content-type", expected=204)
        assert f"Access-Control-Allow-Origin: {origin}".lower() in headers.lower()
        assert "access-control-allow-headers: content-type" in headers.lower()
    before = curl()
    existing = any(row["binding"]["catalog_resource_id"] == resource["id"] for row in before["listings"])
    first = post("request", 200 if existing else 201)
    assert first["created"] is (not existing)
    assert first["status"] in (["draft", "published"] if existing else ["draft"])
    listed = curl("-H", "Origin: http://localhost:3000")
    rows = [row for row in listed["listings"] if row["binding"]["id"] == first["binding"]["id"]]
    assert len(rows) == 1
    assert rows[0]["product"]["id"] == first["product_id"]
    assert rows[0]["product"]["variants"][0]["id"] == first["variant_id"]
    again = post("request", 200)
    assert again == {**first, "created": False}
    snapshot = counts()
    assert post("wrong-person", 403) == {"reason": "authorization_denied"}
    # A denial on a resource with no existing intent must not mint anything either.
    assert post("new-denied", 403) == {"reason": "authorization_denied"}
    assert post("invalid-binding", 400) == {"reason": "passport_binding_mismatch"}
    assert post("conflict", 409) == {"reason": "idempotency_conflict: immutable source changed"}
    assert curl("-H", "Content-Type: application/json", "--data", "{}", expected=400)["reason"].startswith("invalid_body")
    assert curl("-H", "Origin: https://example.org", expected=403) == {"reason": "dev_origin_denied"}
    assert curl() == listed
    after = counts()
    assert after == snapshot, (snapshot, after)
    note = f"PASS denial/conflict/invalid requests wrote no rows: product|variant|binding|intent before={snapshot}, after={after}."
    transcript.append(note + "\n")
    print(note, flush=True)


def disabled_checks():
    snapshot = counts()
    for method in ["GET", "POST", "OPTIONS"]:
        assert curl("-X", method, "-H", "Origin: http://localhost:3104", expected=403) == {
            "reason": "local_fixture_mode_required"}
    assert counts() == snapshot


try:
    serve(["npm", "start"], os.environ.copy(), "http-server.log", enabled_checks)
    # Bypass the explicit opt-in in npm start to prove the route fails closed.
    disabled_env = os.environ.copy()
    disabled_env["INTERFACER_AUTH_MODE"] = "disabled"
    serve(["bash", "-c", "cd medusa && exec ./node_modules/.bin/medusa develop --host 127.0.0.1 --port 9000 --no-types"],
          disabled_env, "http-server-disabled.log", disabled_checks)
    print("PASS HTTP projection, listing, idempotency, denial, CORS and disabled-mode guards; both server groups stopped.", flush=True)
finally:
    (root / ".tmp/http-transcript.md").write_text("\n".join(transcript))
