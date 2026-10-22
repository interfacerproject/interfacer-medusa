#!/usr/bin/env python3
"""Real P4 quote -> P2 customer/cart/manual payment -> explicit production."""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from urllib.parse import urlencode

p2 = import_module("p2-probe")
serve = import_module("server-lifecycle").serve
saved = {}
command = ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"]
fields = "+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*"


def rows(oid):
    assert int(p2.sql(f"SELECT count(*) FROM interfacer_rea_receipt WHERE order_id='{oid}'")) in [0, 1]
    return json.loads(p2.sql(f"SELECT coalesce(json_agg(r), '[]') FROM interfacer_rea_receipt r WHERE order_id='{oid}'"))


def checks():
    context = p2.post("/dev/interfacer/commerce")
    p2.key = ["-H", "x-publishable-api-key: " + context["publishable_key"]]
    matches = p2.post("/dev/interfacer/match", {"designId": "ifdes_p4_organizer"})["matches"]
    quote, other_quote = [m["quote"] for m in matches]
    assert quote["total_price_cents"] == 1900 and quote["quantity"] == 2
    assert quote["provider_person_id"] != other_quote["provider_person_id"]
    buyer, auth = p2.register("p5-bound")
    unbound, unauth = p2.register("p5-unbound")
    person = "p5-buyer-" + p2.run
    p2.post("/dev/interfacer/identity", {"customerId": buyer["id"], "personId": person})

    def newcart(customer=buyer, customer_auth=auth):
        cart = p2.post("/store/carts", {"region_id": context["region_id"],
            "sales_channel_id": context["sales_channel_id"], "email": customer["email"]}, auth=customer_auth)["cart"]
        p2.post(f"/store/carts/{cart['id']}/customer", auth=customer_auth)
        return cart["id"]

    def accept(cid, q=quote, customer_auth=auth, expected=200, **extra):
        return p2.post("/dev/interfacer/build-orders", {"cartId": cid, "quoteId": q["id"], **extra}, auth=customer_auth, expected=expected)

    unbound_cart = newcart(unbound, unauth)
    assert accept(unbound_cart, customer_auth=unauth, expected=400)["message"] == "interfacer_bound_customer_required"
    before_orders = p2.sql('SELECT count(*) FROM "order"')
    cid = newcart()
    p2.post("/dev/interfacer/build-orders", {"cartId": cid, "quoteId": quote["id"]}, expected=401)
    assert accept(cid, customer_auth=unauth, expected=400)["message"] == "interfacer_cart_customer_mismatch"
    accept(cid, expected=400, serviceId=other_quote["service_id"])
    accept(cid, expected=400, priceEUR=0.01)
    accepted = accept(cid)
    assert accept(cid) == accepted
    assert accept(cid, other_quote, expected=400)["message"] == "build_quote_swap_forbidden"
    assert accepted["build"] == {"design_id": quote["design_id"], "service_id": quote["service_id"],
        "service_provider_person_id": quote["provider_person_id"], "quote_id": quote["id"],
        "quote_hash": quote["quote_hash"], "origin_dpp_id": quote["origin_dpp_id"], "quantity": quote["quantity"]}
    offer = accepted["offer"]
    bypass_cart = newcart()
    p2.post(f"/store/carts/{bypass_cart}/line-items", {"variant_id": offer["medusa_variant_id"], "quantity": 1}, auth=auth)
    assert p2.post(f"/store/carts/{bypass_cart}/complete", auth=auth, expected=400)["message"] == "build_quote_acceptance_required"
    other_cart = newcart()
    other_offer = accept(other_cart, other_quote)["offer"]
    direct_collection = p2.post("/store/payment-collections", {"cart_id": other_cart}, auth=auth)["payment_collection"]
    p2.post(f"/store/payment-collections/{direct_collection['id']}/payment-sessions", {"provider_id": "pp_system_default"}, auth=auth)
    # A real second supplier line is permitted by the generic add API, but must
    # never become an order. We test the always-on completion boundary.
    p2.post(f"/store/carts/{cid}/line-items", {"variant_id": other_offer["medusa_variant_id"], "quantity": 1}, auth=auth)
    assert p2.post(f"/store/carts/{cid}/complete", auth=auth, expected=400)["message"] == "build_one_supplier_one_quote_required"
    cart = p2.curl(f"/store/carts/{cid}", *p2.key, *auth)[0]["cart"]
    original = next(i for i in cart["items"] if i["variant_id"] == offer["medusa_variant_id"])
    mixed = next(i for i in cart["items"] if i["variant_id"] == other_offer["medusa_variant_id"])
    p2.curl(f"/store/carts/{cid}/line-items/{original['id']}", *p2.key, *auth, "-X", "DELETE")
    assert p2.post(f"/store/carts/{cid}/complete", auth=auth, expected=400)["message"] == "build_quote_swap_forbidden"
    p2.curl(f"/store/carts/{cid}/line-items/{mixed['id']}", *p2.key, *auth, "-X", "DELETE")
    p2.post(f"/store/carts/{cid}/line-items", {"variant_id": offer["medusa_variant_id"], "quantity": 1, "unit_price": 0.01}, auth=auth, expected=400)
    p2.post(f"/store/carts/{cid}/line-items", {"variant_id": offer["medusa_variant_id"], "quantity": 1,
        "metadata": {"interfacer_build": {"service_id": other_quote["service_id"]}}}, auth=auth)
    assert p2.post(f"/store/carts/{cid}/complete", auth=auth, expected=400)["message"] == "build_quote_swap_forbidden"
    line = p2.curl(f"/store/carts/{cid}", *p2.key, *auth)[0]["cart"]["items"][0]
    p2.post(f"/store/carts/{cid}/line-items/{line['id']}", {"metadata": {"interfacer_build": accepted["build"]}, "quantity": 2}, auth=auth)
    assert p2.post(f"/store/carts/{cid}/complete", auth=auth, expected=400)["message"] == "build_one_quoted_lot_required"
    p2.post(f"/store/carts/{cid}/line-items/{line['id']}", {"quantity": 1}, auth=auth)
    assert p2.sql('SELECT count(*) FROM "order"') == before_orders
    p2.note("PASS ONE SUPPLIER: actual mixed-supplier cart, replacement service variant, forged service metadata and changed accepted quote refused; client price and quantity overrides refused.")

    def buy(cart_id):
        collection = p2.post("/store/payment-collections", {"cart_id": cart_id}, auth=auth)["payment_collection"]
        assert collection["amount"] == 19
        p2.post(f"/store/payment-collections/{collection['id']}/payment-sessions", {"provider_id": "pp_system_default"}, auth=auth)
        result = p2.post(f"/store/carts/{cart_id}/complete?" + urlencode({"fields": fields}), auth=auth)
        assert result["type"] == "order", result
        order = result["order"]
        assert order["total"] == 19 and order["items"][0]["quantity"] == 1
        assert order["items"][0]["metadata"]["interfacer_build"] == accepted["build"]
        assert order["metadata"]["interfacer_purchase"]["buyer_person_id"] == person
        assert order["metadata"]["interfacer_purchase"]["build"] == accepted["build"]
        assert order["payment_collections"][0]["payment_sessions"][0]["status"] == "authorized"
        assert not order["payment_collections"][0]["payments"][0]["captured_at"]
        assert rows(order["id"]) == []
        return order

    order = buy(cid)
    assert p2.post(f"/store/carts/{cid}/complete?" + urlencode({"fields": fields}), auth=auth)["order"]["id"] == order["id"]
    # Independent paid-but-never-produced order remains receipt-free at the end.
    payment_only_cart = newcart()
    accept(payment_only_cart)
    payment_only = buy(payment_only_cart)
    oid = order["id"]
    path = f"/dev/interfacer/build-orders/{oid}/produce"
    assert p2.post(path, expected=400)["message"] == "build_upfront_payment_required"
    saved.update(order=order, payment_only=payment_only, path=path, quote=quote, person=person,
                 accepted=accepted, auth=auth, direct_cart=other_cart)
    (p2.root / ".tmp/p5-state.json").write_text(json.dumps(saved))
    p2.note(f"PASS BUILD PURCHASE order={oid}: EUR 19 fixed quote, bound buyer, persisted design/service/provider/quote/hash/origin DPP; manual payment authorized; zero events before milestone.")


def produce_checks():
    oid, path = saved["order"]["id"], saved["path"]
    assert rows(oid) == [] and rows(saved["payment_only"]["id"]) == []
    for endpoint in ["/dev/interfacer/build-orders", path]:
        p2.curl(endpoint, "-X", "POST", "-H", "Origin: https://example.org", expected=403)
        for origin in ["http://localhost:3000", "http://localhost:3104"]:
            response, _ = p2.curl(endpoint, "-i", "-X", "OPTIONS", "-H", "Origin: " + origin,
                "-H", "Access-Control-Request-Headers: content-type,authorization", expected=204)
            assert "access-control-allow-headers: content-type, authorization" in response.lower()
    p2.post(path, {"service_id": "forged"}, expected=400)
    p2.post("/dev/interfacer/build-orders/order_missing/produce", expected=404)
    def produce(_):
        return p2.curl(path, "-X", "POST", "-H", "Content-Type: application/json", "--data", "{}", expected=None)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(produce, range(4)))
    assert sorted(code for _, code in results) == [200, 200, 200, 201], results
    receipt = next(body["receipt"] for body, code in results if code == 201)
    q = saved["quote"]
    expected = {"action": "produce", "provider_id": q["provider_person_id"], "receiver_id": saved["person"],
        "resource_id": q["design_id"], "design_id": q["design_id"], "service_id": q["service_id"],
        "origin_dpp_id": q["origin_dpp_id"], "dpp_id": q["origin_dpp_id"], "quote_id": q["id"],
        "quote_hash": q["quote_hash"], "order_id": oid, "quantity": q["quantity"]}
    assert {k: receipt[k] for k in expected} == expected
    assert all(body["receipt"] == receipt for body, _ in results)
    assert len(rows(oid)) == 1
    assert p2.post(path) == {"created": False, "receipt": receipt}
    fetched = p2.curl(f"/store/orders/{oid}?" + urlencode({"fields": fields}), *p2.key, *saved["auth"])[0]["order"]
    assert fetched["metadata"]["interfacer_purchase"]["build"] == saved["accepted"]["build"]
    saved["receipt"] = receipt
    p2.note("PASS PRODUCTION: exactly one produce event; correct provider/receiver/design/service/origin-DPP/quote/hash, quantity=2; four concurrent milestones => one 201 + three 200; retry unchanged.")


def restarted():
    assert p2.post(saved["path"]) == {"created": False, "receipt": saved["receipt"]}
    assert len(rows(saved["order"]["id"])) == 1
    assert rows(saved["payment_only"]["id"]) == []
    p2.note("PASS RESTART + PAYMENT WITHOUT MILESTONE: same receipt ID/time after restart; separate captured build without production still has zero events.")


def disabled():
    for endpoint in ["/dev/interfacer/build-orders", saved["path"]]:
        for method in ["POST", "OPTIONS"]:
            p2.curl(endpoint, "-X", method, expected=403)
    p2.note("PASS disabled fixture mode: acceptance/production/preflights refused.")


def main():
    try:
        serve(command, os.environ.copy(), "p5-server.log", checks, cwd=p2.root / "medusa")
        subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/verify-p5.ts", "capture"],
            cwd=p2.root / "medusa", env=os.environ.copy(), check=True)
        serve(command, os.environ.copy(), "p5-produce-server.log", produce_checks, cwd=p2.root / "medusa")
        serve(command, os.environ.copy(), "p5-restarted-server.log", restarted, cwd=p2.root / "medusa")
        serve(command, {**os.environ, "INTERFACER_AUTH_MODE": "disabled"}, "p5-disabled-server.log", disabled, cwd=p2.root / "medusa")
        subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/verify-p5.ts"],
            cwd=p2.root / "medusa", env={**os.environ, "INTERFACER_AUTH_MODE": "disabled"}, check=True)
        p2.note("ALL P5 CHECKS PASSED; all server sessions stopped via per-PID signals.")
    finally:
        (p2.root / ".tmp/p5-transcript.md").write_text("\n".join(p2.transcript))


if __name__ == "__main__":
    main()
