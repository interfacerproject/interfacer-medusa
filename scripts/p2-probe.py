#!/usr/bin/env python3
"""Real curl checkout acceptance; isolated fixtures per run, no stock resets."""
import json
import os
import shlex
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from pathlib import Path
from urllib.parse import urlencode, urlparse

root = Path(__file__).resolve().parent.parent
base = "http://127.0.0.1:9000"
transcript = []
run = str(time.time_ns())
key = []
state = {}


def note(message):
    transcript.append(message + "\n")
    print(message, flush=True)


def curl(path, *args, expected=200):
    command = ["curl", "--silent", "--show-error", "--max-time", "45",
               "--write-out", "\nHTTP %{http_code}\n", *args, base + path]
    output = subprocess.check_output(command, cwd=root, text=True)
    block = "```bash\n" + shlex.join(command) + "\n```\n\n```text\n" + output + "```\n"
    transcript.append(block)
    print(block, flush=True)
    body, status = output.rsplit("\nHTTP ", 1)
    status = int(status.strip())
    if expected is not None:
        assert status == expected, output
    return json.loads(body) if body and not body.startswith("HTTP/") else body, status


def post(path, body=None, auth=(), expected=200):
    return curl(path, *key, *auth, "-H", "Content-Type: application/json", "-X", "POST",
                "--data", json.dumps(body or {}), expected=expected)[0]


def sql(statement):
    database = urlparse(os.environ["DATABASE_URL"]).path.lstrip("/")
    return subprocess.check_output(["docker", "exec", "interfacer-medusa-spike-db", "psql", "-U", "medusa",
                                    "-d", database, "-Atc", statement], text=True).strip()


def register(name):
    email = f"p2-{name}-{run}@example.test"
    creds = {"email": email, "password": "P2-local-test-password-123!"}
    token = post("/auth/customer/emailpass/register", creds)["token"]
    customer = post("/store/customers", {"email": email, "first_name": name},
                    auth=["-H", "Authorization: Bearer " + token])["customer"]
    token = post("/auth/customer/emailpass", creds)["token"]
    jar = ".tmp/p2-" + name + ".cookies"
    session = post("/auth/session", auth=["-H", "Authorization: Bearer " + token, "-c", jar])
    assert session["user"]["actor_id"] == customer["id"]
    auth = ["-b", jar]
    me, _ = curl("/store/customers/me?fields=id,email", *key, *auth)
    assert me["customer"]["id"] == customer["id"]
    return customer, auth


def checks():
    global key
    context = post("/dev/interfacer/commerce")
    key = ["-H", "x-publishable-api-key: " + context["publishable_key"]]
    resource = json.loads((root / "docs/fixtures/economic-resource.json").read_text())
    dpp = json.loads((root / "docs/fixtures/dpp.json").read_text())
    resource["id"] += "-p2-" + run
    dpp["ProductID"] = resource["id"]
    dpp["ID"] += "-p2-" + run
    listing = post("/dev/interfacer/listings", {"resource": resource, "dpp": dpp,
                   "actingPersonId": resource["primaryAccountable"]["id"]}, expected=201)
    listing_id, variant = listing["binding"]["id"], listing["variant_id"]
    published = post(f"/dev/interfacer/listings/{listing_id}/publish", {"priceEUR": 19.95})
    setup_path = f"/dev/interfacer/listings/{listing_id}/checkout"
    checkout = post(setup_path)
    assert post(setup_path) == checkout
    provider = checkout["payment_provider_id"]
    providers, _ = curl("/store/payment-providers?region_id=" + context["region_id"], *key)
    assert provider in [p["id"] for p in providers["payment_providers"]]
    buyer, buyer_auth = register("bound")
    other, other_auth = register("unbound")
    identity = post("/dev/interfacer/identity", {"customerId": buyer["id"], "personId": "p2-person-" + run})
    assert post("/dev/interfacer/identity", {"customerId": buyer["id"], "personId": "p2-person-" + run}) == identity
    post("/dev/interfacer/identity", {"customerId": buyer["id"], "personId": "different-person"}, expected=400)
    post("/dev/interfacer/identity", {"customerId": other["id"], "personId": "p2-person-" + run}, expected=400)
    for path in ["/dev/interfacer/identity", "/dev/interfacer/listings/unknown/checkout"]:
        curl(path, "-X", "POST", "-H", "Origin: https://example.org", expected=403)
        for origin in ["http://localhost:3104", "http://localhost:3000"]:
            response, _ = curl(path, "-i", "-X", "OPTIONS", "-H", "Origin: " + origin, expected=204)
            assert "access-control-allow-origin: " + origin in response.lower()
    note("PASS real customer registration, emailpass login, session cookie, immutable one-to-one IdentityLink and dev CORS guards.")

    fields = "id,customer_id,currency_code,total,items.id,items.variant_id,items.unit_price,items.metadata"
    def cart_for(customer, auth):
        cart = post("/store/carts?" + urlencode({"fields": fields}), {
            "region_id": context["region_id"], "sales_channel_id": context["sales_channel_id"],
            "email": customer["email"], "shipping_address": {"first_name": "Local", "last_name": "Test",
            "address_1": "Teststrasse 1", "city": "Berlin", "postal_code": "10115", "country_code": "de"},
        }, auth=auth)["cart"]
        cid = cart["id"]
        # Verified authenticated transfer route, not a client-supplied customer_id.
        cart = post(f"/store/carts/{cid}/customer?" + urlencode({"fields": fields}), auth=auth)["cart"]
        assert cart["customer_id"] == customer["id"]
        # Runtime validator rejects unknown prices; retry without a client price.
        rejected = post(f"/store/carts/{cid}/line-items", {
            "variant_id": variant, "quantity": 1, "unit_price": 0.01,
        }, auth=auth, expected=400)
        assert "unit_price" in rejected["message"]
        cart = post(f"/store/carts/{cid}/line-items?" + urlencode({"fields": fields}), {
            "variant_id": variant, "quantity": 1,
            "metadata": {"interfacer_dpp_id": "forged-passport"},
        }, auth=auth)["cart"]
        assert cart["items"][0]["unit_price"] == 19.95
        collection = post("/store/payment-collections", {"cart_id": cid}, auth=auth)["payment_collection"]
        session = post(f"/store/payment-collections/{collection['id']}/payment-sessions", {"provider_id": provider}, auth=auth)
        assert session["payment_collection"]["payment_sessions"][0]["status"] == "pending"
        if customer["id"] == other["id"]:
            state["unbound_collection"] = collection["id"]
        return cid

    unbound_cart = cart_for(other, other_auth)
    state.update(unbound_cart=unbound_cart, identity_id=identity["identity_link"]["id"])
    (root / ".tmp/p2-state.json").write_text(json.dumps(state))
    before = sql('SELECT count(*) FROM "order" WHERE deleted_at IS NULL')
    error = post(f"/store/carts/{unbound_cart}/complete", auth=other_auth, expected=400)
    assert error["message"] == "interfacer_bound_customer_required"
    assert sql('SELECT count(*) FROM "order" WHERE deleted_at IS NULL') == before
    assert sql(f"SELECT count(*) FROM reservation_item WHERE inventory_item_id='{checkout['inventory_item_id']}' AND deleted_at IS NULL") == "0"
    note("PASS UNBOUND customer refused before order/payment authorization/reservation; no order or stock writes.")

    # Both carts see available stock before completion; concurrent completion must
    # reserve just one unit. This catches stale-cart/double-sale, not just add denial.
    carts = [cart_for(buyer, buyer_auth), cart_for(buyer, buyer_auth)]
    post(f"/store/carts/{carts[0]}/complete", expected=401)
    wrong_auth = post(f"/store/carts/{carts[0]}/complete", auth=other_auth, expected=400)
    assert wrong_auth["message"] == "interfacer_cart_customer_mismatch"
    complete_fields = "+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*"
    def complete(cid):
        return curl(f"/store/carts/{cid}/complete?" + urlencode({"fields": complete_fields}), *key, *buyer_auth,
                    "-X", "POST", expected=None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(complete, carts))
    wins = [(i, body) for i, (body, code) in enumerate(outcomes) if code == 200 and body.get("type") == "order"]
    assert len(wins) == 1, outcomes
    assert sorted(code for _, code in outcomes) == [200, 400], outcomes
    loser = next(body for body, code in outcomes if code == 400)
    assert "inventory" in loser["message"].lower() or "stock" in loser["message"].lower(), loser
    index, result = wins[0]
    order = result["order"]
    assert order["customer_id"] == buyer["id"] and order["currency_code"] == "eur"
    assert order["total"] == 19.95
    assert len(order["items"]) == 1
    line = order["items"][0]
    assert line["unit_price"] == 19.95 and line["quantity"] == 1
    assert line["metadata"]["interfacer_dpp_id"] == dpp["ID"]
    assert line["metadata"]["interfacer_resource_id"] == resource["id"]
    assert line["metadata"]["interfacer_listing_id"] == listing_id
    assert order["metadata"]["interfacer_purchase"]["buyer_person_id"] == "p2-person-" + run
    payments = order["payment_collections"][0]["payments"]
    assert len(payments) == 1 and payments[0]["provider_id"] == provider
    payment_session = order["payment_collections"][0]["payment_sessions"][0]
    assert payment_session["status"] == "authorized" and payment_session["authorized_at"]
    assert payments[0]["amount"] == 19.95 and not payments[0]["captured_at"]
    fetched, _ = curl(f"/store/orders/{order['id']}?" + urlencode({"fields": complete_fields}), *key, *buyer_auth)
    assert fetched["order"]["items"][0]["metadata"] == line["metadata"]
    assert complete(carts[index])[0]["order"]["id"] == order["id"]
    assert int(sql('SELECT count(*) FROM "order" WHERE deleted_at IS NULL')) == int(before) + 1
    assert sql(f"SELECT stocked_quantity || '|' || reserved_quantity FROM inventory_level WHERE inventory_item_id='{checkout['inventory_item_id']}' AND deleted_at IS NULL") == "1|1"
    assert sql(f"SELECT count(*) FROM reservation_item WHERE inventory_item_id='{checkout['inventory_item_id']}' AND deleted_at IS NULL") == "1"
    assert post(setup_path) == checkout
    post(f"/store/carts/{unbound_cart}/line-items", {"variant_id": variant, "quantity": 1}, auth=other_auth, expected=400)
    note(f"PASS PURCHASE order={order['id']}: EUR 19.95 server price (client 0.01 rejected), canonical DPP/resource line metadata, manual payment authorized (not captured).")
    note("PASS NO DOUBLE SELL: two ready carts completed concurrently => one order, one inventory refusal; exactly one reservation, stocked=1 reserved=1; repeat complete returns same order; re-seed does not restock.")


def disabled_checks():
    for path in ["/dev/interfacer/identity", "/dev/interfacer/listings/unknown/checkout"]:
        for method in ["POST", "OPTIONS"]:
            assert curl(path, "-X", method, expected=403)[0] == {"reason": "local_fixture_mode_required"}
    note("PASS disabled fixture mode: identity/checkout seed/preflight refused.")


try:
    serve = import_module("server-lifecycle").serve
    command = ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"]
    serve(command, os.environ.copy(), "p2-server.log", checks, cwd=root / "medusa")
    serve(command, {**os.environ, "INTERFACER_AUTH_MODE": "disabled"}, "p2-server-disabled.log", disabled_checks, cwd=root / "medusa")
    # Server sessions are stopped before loading another Medusa process (memory).
    env = {**os.environ, "INTERFACER_AUTH_MODE": "disabled"}
    subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/verify-p2.ts"],
                   cwd=root / "medusa", env=env, check=True)
    note("ALL P2 CHECKS PASSED; both server sessions stopped via per-PID signals.")
finally:
    (root / ".tmp/p2-transcript.md").write_text("\n".join(transcript))
