#!/usr/bin/env python3
"""P3: reuse real P2 checkout, then native pickup fulfillment/delivery + local REA."""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from urllib.parse import urlencode

p2 = import_module("p2-probe")
serve = import_module("server-lifecycle").serve
saved = {}


def receipts_for(order_id):
    body, _ = p2.curl("/dev/interfacer/receipts")
    rows = [r for r in body["receipts"] if r["order_id"] == order_id]
    count = p2.sql(f"SELECT count(*) FROM interfacer_rea_receipt WHERE order_id='{order_id}'")
    assert int(count) == len(rows)
    return rows


def checks():
    baseline = p2.sql("SELECT count(*) FROM interfacer_rea_receipt")
    purchase = p2.checks()
    order_id = purchase["order"]["id"]
    path = f"/dev/interfacer/orders/{order_id}/deliver"
    assert receipts_for(order_id) == []
    assert p2.sql("SELECT count(*) FROM interfacer_rea_receipt") == baseline
    assert p2.sql(f"SELECT count(*) FROM order_fulfillment WHERE order_id='{order_id}' AND deleted_at IS NULL") == "0"
    p2.note(f"PASS NO RECEIPT ON PAYMENT: order={order_id}, manual payment authorized; zero receipts and zero fulfillments.")
    saved.update(purchase=purchase, baseline=baseline, path=path, order_id=order_id)
    (p2.root / ".tmp/p3-state.json").write_text(json.dumps({
        "order_id": order_id, "payment_id": purchase["order"]["payment_collections"][0]["payments"][0]["id"],
    }))


def delivery_checks():
    purchase, baseline, path, order_id = (saved[k] for k in ["purchase", "baseline", "path", "order_id"])
    # A real native capture ran with HTTP stopped. Capture alone is not delivery.
    assert receipts_for(order_id) == []
    assert p2.sql("SELECT count(*) FROM interfacer_rea_receipt") == baseline
    for endpoint in [path, "/dev/interfacer/receipts"]:
        method = "POST" if endpoint == path else "GET"
        p2.curl(endpoint, "-X", method, "-H", "Origin: https://example.org", expected=403)
        for origin in ["http://localhost:3104", "http://localhost:3000"]:
            response, _ = p2.curl(endpoint, "-i", "-X", "OPTIONS", "-H", "Origin: " + origin, expected=204)
            assert "access-control-allow-origin: " + origin in response.lower()
    p2.post("/dev/interfacer/orders/order_missing_p3/deliver", expected=404)
    assert p2.sql("SELECT count(*) FROM interfacer_rea_receipt") == baseline
    # The same order is delivered concurrently: one creation, all others retries.
    def deliver(_):
        return p2.curl(path, "-X", "POST", "-H", "Content-Type: application/json", "--data", "{}", expected=None)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(deliver, range(4)))
    assert sorted(code for _, code in results) == [200, 200, 200, 201], results
    assert sum(body["created"] for body, _ in results) == 1
    rows = receipts_for(order_id)
    assert len(rows) == 1
    receipt = rows[0]
    binding, identity = purchase["binding"], purchase["identity"]
    expected = {"action": "transfer", "provider_id": binding["seller_agent_id"],
                "receiver_id": identity["person_id"], "resource_id": binding["catalog_resource_id"],
                "dpp_id": binding["source_dpp_id"], "order_id": order_id, "quantity": 1}
    assert {k: receipt[k] for k in expected} == expected
    assert receipt["has_point_in_time"]
    assert all(body["receipt"] == receipt for body, _ in results)
    fields = "+fulfillments.*,+fulfillments.items.*,+items.detail.*"
    fetched, _ = p2.curl(f"/store/orders/{order_id}?" + urlencode({"fields": fields}), *p2.key, *purchase["buyer_auth"])
    order = fetched["order"]
    assert len(order["fulfillments"]) == 1
    fulfillment = order["fulfillments"][0]
    assert fulfillment["delivered_at"] == receipt["has_point_in_time"]
    assert fulfillment["packed_at"] and not fulfillment["canceled_at"]
    assert fulfillment["provider_id"] == "manual_manual" and not fulfillment["requires_shipping"]
    assert order["items"][0]["detail"]["delivered_quantity"] == 1
    item_id = purchase["checkout"]["inventory_item_id"]
    assert p2.sql(f"SELECT stocked_quantity || '|' || reserved_quantity FROM inventory_level WHERE inventory_item_id='{item_id}' AND deleted_at IS NULL") == "0|0"
    assert p2.sql(f"SELECT count(*) FROM reservation_item WHERE inventory_item_id='{item_id}' AND deleted_at IS NULL") == "0"
    assert p2.post(path) == {"created": False, "receipt": receipt}
    assert receipts_for(order_id) == [receipt]
    assert int(p2.sql("SELECT count(*) FROM interfacer_rea_receipt")) == int(baseline) + 1
    saved.update(path=path, order_id=order_id, receipt=receipt)
    p2.note("PASS DELIVERY: native packed/delivered fulfillment, delivered_quantity=1, stock consumed/reservation released; correct transfer/provider/receiver/resource/DPP/order/quantity/time.")
    p2.note("PASS IDEMPOTENT: four concurrent deliver calls => one 201 + three 200; repeat delivery => same receipt and exactly one row.")


def restarted_checks():
    assert receipts_for(saved["order_id"]) == [saved["receipt"]]
    assert p2.post(saved["path"]) == {"created": False, "receipt": saved["receipt"]}
    p2.note("PASS RESTART: receipt persisted; re-delivery after server restart still returns the same receipt.")


def disabled_checks():
    for endpoint, methods in [(saved["path"], ["POST", "OPTIONS"]), ("/dev/interfacer/receipts", ["GET", "OPTIONS"])]:
        for method in methods:
            assert p2.curl(endpoint, "-X", method, expected=403)[0] == {"reason": "local_fixture_mode_required"}
    p2.note("PASS disabled fixture mode: delivery/receipt view/preflights refused.")


try:
    command = ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"]
    serve(command, os.environ.copy(), "p3-server.log", checks, cwd=p2.root / "medusa")
    def cli(stage):
        subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/verify-p3.ts", stage],
                       cwd=p2.root / "medusa", env={**os.environ, "INTERFACER_AUTH_MODE": "disabled"}, check=True)
    # No concurrent CLI/server Medusa processes; lifecycle owns and stops each.
    cli("capture")
    serve(command, os.environ.copy(), "p3-server-delivery.log", delivery_checks, cwd=p2.root / "medusa")
    serve(command, os.environ.copy(), "p3-server-restarted.log", restarted_checks, cwd=p2.root / "medusa")
    serve(command, {**os.environ, "INTERFACER_AUTH_MODE": "disabled"}, "p3-server-disabled.log", disabled_checks, cwd=p2.root / "medusa")
    cli("constraints")
    p2.note("ALL P3 CHECKS PASSED; all server sessions stopped via per-PID signals.")
finally:
    (p2.root / ".tmp/p3-transcript.md").write_text("\n".join(p2.transcript))
