"""Real curl client shared by demo bootstrap and P6b HTTP checks. No SQL writes."""
import base64
import json
import os
import shlex
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:9000"
transcript = []


def request(path, body=None, token=None, key=None, signature=None, expected=200, raw=False, extra=()):
    cmd = ["curl", "--silent", "--show-error", "--max-time", "60", "--write-out", "\nHTTP %{http_code}\n"]
    if key:
        cmd += ["-H", "x-publishable-api-key: " + key]
    if token:
        cmd += ["-H", "Authorization: Bearer " + token]
    if signature:
        cmd += ["-H", "X-Interfacer-Auth: " + signature]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "--data", json.dumps(body)]
    cmd += list(extra) + [BASE + path]
    output = subprocess.check_output(cmd, text=True, cwd=ROOT)
    payload, code = output.rsplit("\nHTTP ", 1)
    code = int(code.strip())
    transcript.append("```bash\n" + shlex.join(cmd) + "\n```\n```text\n" + output + "```\n")
    print(f"curl {'POST' if body is not None else 'GET'} {path} -> {code}", flush=True)
    assert code == expected, output
    return payload if raw else json.loads(payload)


def sign(op, params, person):
    auth = json.loads(subprocess.check_output(["node", "scripts/sign.cjs", op, person, json.dumps(params)], cwd=ROOT, text=True))
    return base64.urlsafe_b64encode(json.dumps(auth).encode()).decode().rstrip("=")


def bootstrap():
    run = uuid.uuid4().hex[:12]
    scene = {"label": "LOCAL DEV — fixture/dev keys, not production", "run": run,
             "email": f"store-{run}@example.test", "password": "LOCAL-only-demo-password-123!",
             "buyer_person_id": "p6b-demo-buyer-" + run, "products": []}
    subprocess.run(["node", "scripts/sign.cjs", "--seed-person", scene["buyer_person_id"]], cwd=ROOT, check=True)
    context = request("/dev/interfacer/commerce", {})
    scene["context"] = context
    key = context["publishable_key"]
    creds = {"email": scene["email"], "password": scene["password"]}
    token = request("/auth/customer/emailpass/register", creds)["token"]
    customer = request("/store/customers", {"email": scene["email"], "first_name": "Local demo buyer"}, token, key)["customer"]
    scene["customer_id"] = customer["id"]
    request("/dev/interfacer/identity", {"customerId": customer["id"], "personId": scene["buyer_person_id"]})
    for index in range(1, 4):
        resource = json.loads((ROOT / "docs/fixtures/economic-resource.json").read_text())
        dpp = json.loads((ROOT / "docs/fixtures/dpp.json").read_text())
        resource["id"] += f"-p6b-{run}-{index}"
        resource["name"] = f"Recycled PETG desk organizer — demo unit {index}"
        dpp["ID"] += f"-p6b-{run}-{index}"
        dpp["ProductID"] = resource["id"]
        seller = resource["primaryAccountable"]["id"]
        listing = request("/dev/interfacer/listings", {"resource": resource, "dpp": dpp},
                          signature=sign("commerce.listing.create", {"resource": resource, "dpp": dpp}, seller), expected=201)
        lid = listing["binding"]["id"]
        request(f"/dev/interfacer/listings/{lid}/publish", {"priceEUR": 19.95},
                signature=sign("commerce.listing.publish", {"listing_id": lid, "priceEUR": 19.95}, seller))
        request(f"/dev/interfacer/listings/{lid}/checkout", {},
                signature=sign("commerce.listing.checkout.setup", {"listing_id": lid}, seller))
        scene["products"].append({"listing_id": lid, "product_id": listing["product_id"],
                                  "variant_id": listing["variant_id"], "resource_id": resource["id"], "dpp_id": dpp["ID"]})
    (ROOT / ".tmp/storefront-demo.json").write_text(json.dumps(scene, indent=2) + "\n")
    return scene


ORDER_FIELDS = "+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*,+fulfillments.*,+items.detail.*"


class Buyer:
    def __init__(self, scene):
        self.scene = scene
        self.key = scene["context"]["publishable_key"]
        self.token = request("/auth/customer/emailpass", {"email": scene["email"], "password": scene["password"]})["token"]

    def call(self, path, body=None, **kw):
        return request(path, body, self.token, self.key, **kw)

    def signed(self, path, body, action):
        signed = self.call("/dev/store/sign", action)
        assert "LOCAL DEV SIGNER" in signed["label"]
        return self.call(path, body, signature=signed["header"], expected=201 if action["action"] in ["deliver", "produce"] else 200)

    def cart(self):
        ctx = self.scene["context"]
        cart = self.call("/store/carts", {"region_id": ctx["region_id"], "sales_channel_id": ctx["sales_channel_id"],
            "email": self.scene["email"], "shipping_address": {"first_name": "Local", "last_name": "Demo", "address_1": "Teststrasse 1",
            "city": "Berlin", "postal_code": "10115", "country_code": "de"}})["cart"]
        return self.call(f"/store/carts/{cart['id']}/customer", {})["cart"]["id"]

    def complete(self, cid):
        pc = self.call("/store/payment-collections", {"cart_id": cid})["payment_collection"]
        self.call(f"/store/payment-collections/{pc['id']}/payment-sessions", {"provider_id": "pp_system_default"})
        result = self.signed(f"/store/carts/{cid}/complete?" + urlencode({"fields": ORDER_FIELDS}), {}, {"action": "checkout", "cartId": cid})
        assert result["type"] == "order", result
        return result["order"]

    def capture(self, order):
        return self.signed("/dev/store/capture", {"orderId": order["id"]}, {"action": "capture", "orderId": order["id"]})

    def order(self, oid):
        return self.call(f"/store/orders/{oid}?" + urlencode({"fields": ORDER_FIELDS}))["order"]
