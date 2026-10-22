#!/usr/bin/env python3
"""P6b: boot the ONE run command, real curl signed journeys, then driven Chromium."""
import base64
import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "scripts"))
c = importlib.import_module("store-client")
lifecycle = importlib.import_module("server-lifecycle")


def receipts(buyer, oid):
    return [r for r in buyer.call("/dev/interfacer/receipts")["receipts"] if r["order_id"] == oid]


def checks():
    page = c.request("/dev/store", raw=True)
    assert "LOCAL DEV — fixture/dev keys, not production" in page
    assert "/dev/store/assets/app.js" in page and 'id="catalog"' in page and 'id="build"' in page
    headers = c.request("/dev/store", raw=True, extra=["-i"]).lower()
    assert "cache-control: no-store" in headers and "content-type: text/html" in headers
    assert "content-security-policy:" in headers and "frame-ancestors 'none'" in headers
    for asset in ["app.js", "style.css"]:
        assert c.request("/dev/store/assets/" + asset, raw=True)
    c.request("/dev/store/assets/unknown", expected=404, raw=True)
    c.request("/dev/store", expected=403, extra=["-H", "Origin: https://evil.test"])
    c.request("/dev/store", expected=403, extra=["-H", "Host: evil.test:9000"])
    c.request("/dev/store/sign", {"action": "capture", "orderId": "nope"}, expected=401)
    scene = c.request("/dev/store/config")
    buyer = c.Buyer(scene)
    c.request("/dev/store/sign", {"action": "checkout", "cartId": "nope"}, buyer.token, expected=403,
              extra=["-H", "Origin: http://localhost:3000"])
    product = scene["products"][0]
    catalog = buyer.call("/store/products?" + urlencode({"region_id": scene["context"]["region_id"],
        "id[]": product["product_id"], "fields": "id,title,metadata,variants.id,variants.manage_inventory,variants.inventory_quantity,variants.calculated_price.*"}))["products"]
    assert len(catalog) == 1
    assert catalog[0]["metadata"]["interfacer_dpp_id"] == product["dpp_id"]
    assert catalog[0]["variants"][0]["calculated_price"]["calculated_amount"] == 19.95
    assert catalog[0]["variants"][0]["inventory_quantity"] == 1
    cid = buyer.cart()
    buyer.call(f"/store/carts/{cid}/line-items", {"variant_id": product["variant_id"], "quantity": 1})
    buyer.call(f"/store/carts/{cid}/complete", {}, expected=400)  # no unsigned escape
    proof = buyer.call("/dev/store/sign", {"action": "checkout", "cartId": cid})
    bad = proof["auth"]
    bad["signature"] = base64.b64encode(bytes(64)).decode()
    forged = base64.urlsafe_b64encode(json.dumps(bad).encode()).decode().rstrip("=")
    buyer.call(f"/store/carts/{cid}/complete", {}, signature=forged, expected=400)
    assert not buyer.call(f"/store/carts/{cid}")["cart"]["completed_at"]
    buyer.call("/dev/store/sign", {"action": "checkout", "cartId": cid, "person_id": "arbitrary"}, expected=400)
    stock = buyer.complete(cid)
    assert stock["total"] == 19.95
    assert not receipts(buyer, stock["id"])
    buyer.call("/dev/store/capture", {"orderId": stock["id"]}, expected=400)
    buyer.call("/dev/store/capture", {"orderId": stock["id"]}, signature=forged, expected=400)
    assert not buyer.order(stock["id"])["payment_collections"][0]["payments"][0]["captured_at"]
    buyer.capture(stock)
    assert not receipts(buyer, stock["id"])
    assert buyer.order(stock["id"])["payment_collections"][0]["payments"][0]["captured_at"]
    stock_receipt = buyer.signed(f"/dev/interfacer/orders/{stock['id']}/deliver", {}, {"action": "deliver", "orderId": stock["id"]})["receipt"]
    assert stock_receipt["action"] == "transfer" and stock_receipt["resource_id"] == product["resource_id"]
    assert stock_receipt["dpp_id"] == product["dpp_id"] and stock_receipt["quantity"] == 1
    assert stock_receipt["receiver_id"] == scene["buyer_person_id"]
    proof = buyer.call("/dev/store/sign", {"action": "deliver", "orderId": stock["id"]})
    assert buyer.call(f"/dev/interfacer/orders/{stock['id']}/deliver", {}, signature=proof["header"])["receipt"] == stock_receipt
    assert len(receipts(buyer, stock["id"])) == 1
    print("P6b STOCK VF RECEIPT " + json.dumps(stock_receipt), flush=True)

    designs = buyer.call("/dev/interfacer/designs")["designs"]
    design = next(d for d in designs if d["id"] == "ifdes_p4_organizer")
    matches = buyer.call("/dev/interfacer/match", {"designId": design["id"]})
    assert [m["quote"]["total_price_cents"] for m in matches["matches"]] == [1900, 3600]
    assert matches["rejected"]
    quote = matches["matches"][0]["quote"]
    cid = buyer.cart()
    buyer.signed("/dev/interfacer/build-orders", {"cartId": cid, "quoteId": quote["id"]}, {"action": "build", "cartId": cid, "quoteId": quote["id"]})
    build = buyer.complete(cid)
    assert build["total"] == 19 and not receipts(buyer, build["id"])
    proof = buyer.call("/dev/store/sign", {"action": "produce", "orderId": build["id"]})
    buyer.call(f"/dev/interfacer/build-orders/{build['id']}/produce", {}, signature=proof["header"], expected=400)
    buyer.capture(build)
    assert not receipts(buyer, build["id"])
    build_receipt = buyer.signed(f"/dev/interfacer/build-orders/{build['id']}/produce", {}, {"action": "produce", "orderId": build["id"]})["receipt"]
    for field, value in {"action": "produce", "resource_id": design["id"], "design_id": design["id"], "service_id": quote["service_id"],
        "dpp_id": design["origin_dpp_id"], "quote_hash": quote["quote_hash"], "quantity": 2, "receiver_id": scene["buyer_person_id"]}.items():
        assert build_receipt[field] == value, (field, build_receipt)
    proof = buyer.call("/dev/store/sign", {"action": "produce", "orderId": build["id"]})
    assert buyer.call(f"/dev/interfacer/build-orders/{build['id']}/produce", {}, signature=proof["header"])["receipt"] == build_receipt
    assert len(receipts(buyer, build["id"])) == 1
    print("P6b BUILD VF RECEIPT " + json.dumps(build_receipt), flush=True)
    (ROOT / ".tmp/p6b-receipts.json").write_text(json.dumps([stock_receipt, build_receipt], indent=2) + "\n")
    print("PASS P6b HTTP: page/assets 200; real signed stock + build, native capture, no event on payment, milestones + idempotent VF receipts; unsigned/forged refused", flush=True)


def main():
    if "--live" in sys.argv:
        try:
            checks()
        finally:
            (ROOT / ".tmp/p6b-transcript.md").write_text("\n".join(c.transcript))
        return
    if (ROOT / ".tmp/dev-store-runtime.json").exists():
        raise RuntimeError("Stop the demo before test:p6b: npm run dev:down")
    env = os.environ.copy()
    env.setdefault("INTERFACER_DB_CONTAINER", "interfacer-medusa-p6b-test-db")
    env.setdefault("INTERFACER_DB_PORT", "55438")
    env.setdefault("DATABASE_URL", f"postgres://medusa:medusa_local@127.0.0.1:{env['INTERFACER_DB_PORT']}/interfacer_medusa")
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(ROOT / ".cache/ms-playwright")
    env["TMPDIR"] = str(ROOT / ".tmp")
    env["npm_config_cache"] = str(ROOT / ".cache/npm")
    production = subprocess.run(["npm", "run", "dev:up"], env={**env, "NODE_ENV": "production"}, capture_output=True, text=True)
    assert production.returncode != 0 and "Refusing LOCAL DEV storefront in production" in production.stderr
    assert not (ROOT / ".tmp/dev-store-runtime.json").exists()
    print("PASS P6b dev:up production refusal before DB/server startup", flush=True)
    if not (ROOT / "node_modules/playwright/package.json").exists():
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], env=env, check=True)
    subprocess.run(["./node_modules/.bin/playwright", "install", "chromium", "--only-shell"], env=env, check=True)

    def work():
        for _ in range(180):
            if "STOREFRONT READY:" in (ROOT / ".tmp/p6b-up.log").read_text():
                break
            time.sleep(1)
        else:
            raise RuntimeError("Storefront bootstrap timeout; see .tmp/p6b-up.log")
        checks()
        subprocess.run(["node", "scripts/p6b-browser.cjs"], env=env, check=True)
        # Exercise the documented down command, not only the test harness cleanup.
        subprocess.run(["npm", "run", "dev:down"], env=env, check=True)
        print("ALL P6b CHECKS PASSED: curl + driven Chromium desktop/mobile journeys; dev:up/dev:down + per-PID cleanup", flush=True)

    try:
        lifecycle.serve(["npm", "run", "dev:up"], env, "p6b-up.log", work)
    finally:
        (ROOT / ".tmp/p6b-transcript.md").write_text("\n".join(c.transcript))


if __name__ == "__main__":
    main()
