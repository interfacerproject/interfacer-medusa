"""Shared LIVE real-actor helpers for P7/P8 probes: disposable Zenflows People
with fresh keys (scripts/zenflows-actor.cjs), Medusa wallet sessions proven by a
signed one-use challenge, and their own catalog/listing setup. No fixture keys."""
import importlib
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
c = importlib.import_module("store-client")
ZENFLOWS = os.environ.get("ZENFLOWS_DIRECT", "http://127.0.0.1:8000/api")


REQUIREMENTS = {"process": ["fdm_3d_print"], "materials": ["PETG"], "max_dimensions_mm": {"x": 120, "y": 80, "z": 60},
                "tolerance_mm": 0.3, "quantity": 2}
CAPABILITIES = {"processes": ["fdm_3d_print"], "materials": ["PETG", "PLA"], "build_volume_mm": {"x": 220, "y": 220, "z": 250},
                "min_tolerance_mm": 0.2}


def actor(*args):
    return subprocess.check_output(["node", "scripts/zenflows-actor.cjs", *args], text=True, cwd=ROOT).strip()


def sign(alias, op, params):
    return actor("sign", alias, op, json.dumps(params))


def zf(query, variables=None, as_alias="observer"):
    """A Zenflows call signed by a real Person (works with GQL_AUTH_CALLS on or off)."""
    store = ROOT / ".tmp/live-actors.json"
    if as_alias == "observer" and "observer" not in (json.loads(store.read_text()) if store.exists() else {}):
        actor("create", "observer")
    return json.loads(actor("call", as_alias, query, json.dumps(variables or {})))


def reason(path, body, signature=None, token=None, key=None, expected=400):
    return c.request(path, body, token=token, key=key, signature=signature, expected=expected).get("message") or ""


class Wallet:
    """A real Person logged into Medusa with a signed one-use challenge."""
    def __init__(self, alias, person, scene):
        self.alias, self.person, self.key = alias, person, scene["context"]["publishable_key"]
        challenge = c.request("/dev/store/session?" + urlencode({"person": person}))["challenge"]
        login = c.request("/dev/store/session", {}, signature=sign(alias, "commerce.session.create", {"challenge": challenge}))
        assert login["buyer_person_id"] == person
        self.token = login["token"]
        self.scene = scene

    def call(self, path, body=None, **kw):
        return c.request(path, body, self.token, self.key, **kw)

    def signed(self, path, body, action, expected=200):
        op = self.call("/dev/store/prepare", action)
        assert op["person"] == self.person, op
        return self.call(path, body, signature=sign(self.alias, op["op"], op["params"]), expected=expected)

    def cart(self):
        ctx = self.scene["context"]
        cart = self.call("/store/carts", {"region_id": ctx["region_id"], "sales_channel_id": ctx["sales_channel_id"],
            "email": f"{self.alias}@market.invalid", "shipping_address": {"first_name": "Live", "last_name": self.alias,
            "address_1": "Via Roma 1", "city": "Torino", "postal_code": "10121", "country_code": "de"}})["cart"]
        return self.call(f"/store/carts/{cart['id']}/customer", {})["cart"]["id"]

    def pay_and_complete(self, cid):
        pc = self.call("/store/payment-collections", {"cart_id": cid})["payment_collection"]
        self.call(f"/store/payment-collections/{pc['id']}/payment-sessions", {"provider_id": "pp_system_default"})
        result = self.signed(f"/store/carts/{cid}/complete", {}, {"action": "checkout", "cartId": cid})
        assert result["type"] == "order", result
        oid = result["order"]["id"]
        self.signed("/dev/store/capture", {"orderId": oid}, {"action": "capture", "orderId": oid})
        return oid


def events_of(resource_id):
    return zf("""query($id: ID!) { economicResource(id: $id) { id primaryAccountable { id } onhandQuantity { hasNumericalValue }
        previous { id action { id } provider { id } receiver { id } outputOf { id finished } resourceInventoriedAs { id } } } }""",
              {"id": resource_id})["economicResource"]


def marketplace(stock_units=1):
    """Designer + maker with a registered design/service, a seller with
    `stock_units` live listings of their own resources, and a buyer."""
    scene = c.request("/dev/store/config")
    assert scene.get("live") is True, "run dev:up in live mode"
    pid = {a: json.loads(actor("create", a))["id"] for a in ["designer", "maker", "seller", "buyer"]}
    design = json.loads(actor("raise", "designer", "Design", "Live lamp shade"))["resource_id"]
    service = json.loads(actor("raise", "maker", "Service", "Live Torino FDM"))["resource_id"]
    ddoc = {"resource_id": design, "document": {"schema_version": "interfacer-build-requirements-v1", "requirements": REQUIREMENTS}}
    sdoc = {"resource_id": service, "document": {"schema_version": "interfacer-fabrication-capabilities-v1",
            "capabilities": CAPABILITIES, "base_price_eur": 10, "per_unit_price_eur": 4.5,
            "location": {"country_code": "it", "city": "Torino"}}}
    c.request("/dev/interfacer/catalog/designs", ddoc, signature=sign("designer", "catalog.design.register", ddoc), expected=201)
    c.request("/dev/interfacer/catalog/services", sdoc, signature=sign("maker", "catalog.service.register", sdoc), expected=201)
    listings = []
    for i in range(stock_units):
        product = json.loads(actor("raise", "seller", "Product", f"Live recycled lamp {i + 1}"))["resource_id"]
        body = {"resource_id": product}
        listing = c.request("/dev/interfacer/listings/live", body, signature=sign("seller", "commerce.listing.live.create", body), expected=201)
        lid = listing["binding"]["id"]
        c.request(f"/dev/interfacer/listings/{lid}/publish", {"priceEUR": 24.5},
                  signature=sign("seller", "commerce.listing.publish", {"listing_id": lid, "priceEUR": 24.5}))
        c.request(f"/dev/interfacer/listings/{lid}/checkout", {}, signature=sign("seller", "commerce.listing.checkout.setup", {"listing_id": lid}))
        listings.append({"listing_id": lid, "variant_id": listing["variant_id"], "resource_id": product})
    scene = c.request("/dev/store/config")
    return {"scene": scene, "pid": pid, "design": design, "service": service, "listings": listings,
            "buyer": Wallet("buyer", pid["buyer"], scene), "maker": Wallet("maker", pid["maker"], scene),
            "seller": Wallet("seller", pid["seller"], scene)}


def build_order(m):
    quote = next(x["quote"] for x in m["buyer"].call("/dev/interfacer/match", {"designId": m["design"]})["matches"]
                 if x["service"]["id"] == m["service"])
    cid = m["buyer"].cart()
    m["buyer"].signed("/dev/interfacer/build-orders", {"cartId": cid, "quoteId": quote["id"]},
                      {"action": "build", "cartId": cid, "quoteId": quote["id"]})
    return m["buyer"].pay_and_complete(cid)


def stock_order(m, listing):
    cid = m["buyer"].cart()
    m["buyer"].call(f"/store/carts/{cid}/line-items", {"variant_id": listing["variant_id"], "quantity": 1})
    return m["buyer"].pay_and_complete(cid)


def relay(wallet, sync_id, rounds=10):
    """Enforced Zenflows authz: act as the seller's browser. Fetch Medusa's exact
    body for the next write, sign it with the seller's own key, post it back."""
    sync = None
    for _ in range(rounds):
        nxt = wallet.call(f"/dev/store/zenflows-sync/{sync_id}/next")
        sync = nxt["sync"]
        if "step" not in nxt:
            break
        signature = actor("zsign", wallet.alias, nxt["body"])
        sync = wallet.call(f"/dev/store/zenflows-sync/{sync_id}/sign",
                           {"step": nxt["step"], "body": nxt["body"], "signature": signature})["sync"]
    return sync


def awaiting(receipt):
    sync = (receipt or {}).get("zenflows_sync") or {}
    return sync.get("status") == "pending" and (sync.get("last_error") or "").startswith("awaiting_seller_signature")


def finish(wallet, receipt):
    """If the outbox waits for the seller's signature, sign every write, then re-read."""
    if awaiting(receipt):
        relay(wallet, receipt["zenflows_sync"]["id"])
        receipt = next(r for r in c.request("/dev/interfacer/receipts")["receipts"] if r["order_id"] == receipt["order_id"])
    return receipt


def milestone(m, kind, order_id, expected=201):
    if kind == "build":
        wallet, path, action = m["maker"], f"/dev/interfacer/build-orders/{order_id}/produce", "produce"
    else:
        wallet, path, action = m["seller"], f"/dev/interfacer/orders/{order_id}/deliver", "deliver"
    receipt = wallet.signed(path, {}, {"action": action, "orderId": order_id}, expected=expected)["receipt"]
    return finish(wallet, receipt)
