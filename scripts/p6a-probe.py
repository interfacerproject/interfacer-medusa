#!/usr/bin/env python3
"""P6a real HTTP signatures and no-state-change denials on EVERY protected op."""
import copy
import json
import os
import subprocess
from importlib import import_module

http = import_module("p2-probe")
p5 = import_module("p5-probe")
signing = import_module("signed-requests")
serve = import_module("server-lifecycle").serve
command = p5.command
verified = []


def snapshot():
    # Count AND hash all persisted fields, including soft-deleted rows: denial
    # must not update a price, cart metadata, payment, stock or milestone either.
    tables = ["product", "product_variant", "price", "cart", "cart_line_item", "order",
        "payment", "payment_session", "inventory_item", "inventory_level", "reservation_item",
        "fulfillment", "interfacer_projection_intent", "interfacer_listing_binding",
        "interfacer_build_offer", "interfacer_build_acceptance", "interfacer_rea_receipt"]
    statements = [f"SELECT '{t}', count(*), md5(coalesce(string_agg(row_to_json(r)::text, '' ORDER BY id), '')) FROM \"{t}\" r" for t in tables]
    return http.sql(";".join(statements))


def refusals(path, body=None, auth=(), extras=False):
    body = body or {}
    op, params, person = signing.operation(path, body)
    good = signing.sign(op, params, person)
    forged = copy.deepcopy(good)
    forged["signature"] = "A" * 86 + "=="
    cases = [("unsigned", None), ("forged", forged),
        ("wrong-key", signing.sign(op, params, person, "some-other-person")),
        ("non-controller", signing.sign(op, params, "some-other-person"))]
    if extras:
        for label, change in [("wrong-op", {"op": "commerce.order.deliver"}),
            ("wrong-params", {"params": {"resource": {"id": "foreign"}}}),
            ("stale", {"issued_at": "2000-01-01T00:00:00.000Z"}),
            ("bad-nonce", {"nonce": "short"}), ("unknown-field", {"version": 2})]:
            bad = copy.deepcopy(good)
            bad["envelope"].update(change)
            cases.append((label, bad))
        cases.append(("unknown-person", signing.sign(op, params, "unregistered-person", person)))
    before = snapshot()
    for label, material in cases:
        headers = signing.header(material) if material else []
        result, status = http.curl(path, *http.key, *auth, *headers, "-X", "POST", "-H", "Content-Type: application/json",
            "--data", json.dumps(body), expected=None, auto_sign=False)
        assert status == (403 if op == "commerce.listing.create" else 400), (label, status, result)
        assert result.get("reason", result.get("message")) == "authorization_denied", (label, result)
        assert snapshot() == before, f"{op} {label} changed persisted state"
        http.note(f"PASS P6a {op}: {label} refused; rows AND stored fields unchanged")
    verified.append(op)


def initial():
    r = json.loads((http.root / "docs/fixtures/economic-resource.json").read_text())
    d = json.loads((http.root / "docs/fixtures/dpp.json").read_text())
    r["id"] += "-p6a-" + http.run
    d.update(ID=d["ID"] + "-p6a-" + http.run, ProductID=r["id"])
    body = {"resource": r, "dpp": d, "actingPersonId": signing.SELLER}
    refusals("/dev/interfacer/listings", body, extras=True)
    listing = http.post("/dev/interfacer/listings", body, expected=201)
    http.note("PASS P6a signed-ok: real Ed25519 listing created")
    path = f"/dev/interfacer/listings/{listing['binding']['id']}"
    refusals(path + "/publish", {"priceEUR": 19.95})
    http.post(path + "/publish", {"priceEUR": 19.95})
    refusals(path + "/checkout")
    http.post(path + "/checkout")
    # Prior real stock race/checkout assertions, with a denial matrix on a ready
    # bound cart BEFORE its native order/payment authorization.
    purchase = http.checks(before_complete=lambda cid, auth: refusals(f"/store/carts/{cid}/complete", auth=auth))
    delivery = f"/dev/interfacer/orders/{purchase['order']['id']}/deliver"
    refusals(delivery)
    assert http.post(delivery, expected=201)["receipt"]["action"] == "transfer"
    # Prior build flow, with the same matrix before acceptance/product creation.
    p5.checks(before_accept=lambda cid, quote, auth: refusals("/dev/interfacer/build-orders",
        {"cartId": cid, "quoteId": quote["id"]}, auth=auth))


def production():
    refusals(p5.saved["path"])
    p5.produce_checks()


try:
    serve(command, os.environ.copy(), "p6a-server.log", initial, cwd=http.root / "medusa")
    subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/verify-p5.ts", "capture"],
        cwd=http.root / "medusa", env=os.environ.copy(), check=True)
    serve(command, os.environ.copy(), "p6a-production-server.log", production, cwd=http.root / "medusa")
    serve(command, os.environ.copy(), "p6a-restarted-server.log", p5.restarted, cwd=http.root / "medusa")
    assert set(verified) == {"commerce.listing.create", "commerce.listing.publish", "commerce.listing.checkout.setup",
        "commerce.order.authorize", "commerce.order.deliver", "commerce.order.build.purchase", "commerce.order.produce"}
    http.note("ALL P6a CHECKS PASSED: signed-ok + four no-state-change refusals on all 7 operations; prior stock/build flows pass signed; per-PID cleanup")
finally:
    (http.root / ".tmp/p6a-transcript.md").write_text("\n".join(http.transcript))
