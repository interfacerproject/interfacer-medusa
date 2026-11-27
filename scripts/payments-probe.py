#!/usr/bin/env python3
"""Release 4ku.1/4ku.2 end-to-end probe: Stripe Connect DIRECT CHARGES (the buyer
pays the seller's own account, Interfacer's commission is an application fee),
capture at delivery, cancellations, returns, refunds and lapsed authorizations,
through a REAL Medusa on a REAL Postgres, with Stripe replaced by the local
stand-in (scripts/stripe-stub.cjs). Standalone fixture mode: the seller and the maker are
fixture identities, the dev signer signs their milestones.

DB: Docker (as the other probes) unless PAYMENTS_PROBE_DB=external, in which case
DATABASE_URL must point at an empty Postgres this probe may migrate."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util  # noqa: E402

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

c = load("store_client", "store-client.py")
lifecycle = load("server_lifecycle", "server-lifecycle.py")

STUB = "http://127.0.0.1:12111"
SELLER = "01JTESTPERSON00000000000001"
MAKER = "p4-demo-provider-standard"
TERMS = {"terms_version": "2026-11", "fee_bps": 800, "fee_fixed_cents": 0}


def stub(path, body=None):
    req = urllib.request.Request(STUB + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


def refused(fn, reason):
    try:
        fn()
    except AssertionError as error:
        assert reason in str(error), f"expected {reason}, got {str(error)[:600]}"
        print(f"  refused as expected: {reason}", flush=True)
        return
    raise AssertionError(f"expected refusal {reason}")


def money_report(env, *args):
    done = subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/money-report.ts", *args],
                          cwd=ROOT / "medusa", env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = done.stdout
    assert done.returncode == 0, out[-3000:]
    line = next(l for l in out.splitlines() if l.startswith('{"refunds_resumed"'))
    print("  money-report " + line, flush=True)
    return json.loads(line)


def stub_post(path, body, account=None):
    headers = {"Authorization": "Bearer sk_test_stub"}
    if account:
        headers["Stripe-Account"] = account
    req = urllib.request.Request(STUB + path, method="POST", data=body.encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


class StripeBuyer(c.Buyer):
    def pay(self, cid):
        """The marketplace's payment route: a PaymentIntent on the seller's account."""
        session = self.call("/market/store/payment", {"cartId": cid})
        assert session["provider_id"] == "pp_stripe_stripe" and session["stripe_account"].startswith("acct_"), session
        pi = session["client_secret"].split("_secret_")[0]
        return pi, session["stripe_account"]

    def confirm(self, pi, account):
        """What Stripe.js (initialized with the seller's account) does on confirm."""
        assert stub_post(f"/v1/payment_intents/{pi}/confirm", "payment_method=pm_card_visa", account)["status"] == "requires_capture"

    def complete_signed(self, cid):
        result = self.signed(f"/store/carts/{cid}/complete?" + urlencode({"fields": c.ORDER_FIELDS}), {},
                             {"action": "checkout", "cartId": cid})
        assert result["type"] == "order", json.dumps(result.get("error"))
        return result["order"]

    def buy(self, product):
        cid = self.cart()
        self.call(f"/store/carts/{cid}/line-items", {"variant_id": product["variant_id"], "quantity": 1})
        pi, account = self.pay(cid)
        self.confirm(pi, account)
        order = self.complete_signed(cid)
        assert self.capture(order)["captured"] is False  # stock: charged at delivery
        return order, pi


def db_reserved(product):
    """reserved_quantity of a listing's inventory level (read-only SQL)."""
    sku = "interfacer-" + product["listing_id"]
    out = subprocess.check_output(["psql", os.environ["DATABASE_URL"], "-tAc",
        "select l.reserved_quantity from inventory_level l join inventory_item i on i.id = l.inventory_item_id "
        f"where i.sku = '{sku}' and l.deleted_at is null"], text=True).strip()
    return int(out)


def signed(path, params, op, person, expected=200, token=None, key=None):
    return c.request(path, params, token, key, signature=c.sign(op, params, person), expected=expected)


def main():
    # Never talk to some other Medusa already listening on the probe's port.
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", 9000))
        except OSError:
            raise SystemExit("Port 9000 is in use: stop the other Medusa (npm run dev:down) first")
    env = os.environ.copy()
    env.update(INTERFACER_AUTH_MODE="signed-envelope-local", INTERFACER_DEV_STOREFRONT="true",
               INTERFACER_KEYRING_PATH=str(ROOT / ".tmp/auth-public-keyring.json"), MEDUSA_DISABLE_TELEMETRY="true",
               STRIPE_SECRET_KEY="sk_test_stub", STRIPE_PUBLISHABLE_KEY="pk_test_stub", STRIPE_WEBHOOK_SECRET="whsec_stub",
               STRIPE_API_BASE=STUB, INTERFACER_GUI_URL="http://localhost:3000",
               INTERFACER_PLATFORM_FEE_BPS="800", INTERFACER_PAYOUT_HOLD_DAYS="0", INTERFACER_RETURN_WINDOW_DAYS="14")
    env.pop("INTERFACER_ZENFLOWS_URL", None)
    external = env.get("PAYMENTS_PROBE_DB") == "external"
    if not external:
        env.setdefault("INTERFACER_DB_CONTAINER", "interfacer-medusa-payments-db")
        env.setdefault("INTERFACER_DB_PORT", "55438")
        env["DATABASE_URL"] = f"postgres://medusa:medusa_local@127.0.0.1:{env['INTERFACER_DB_PORT']}/interfacer_medusa"
    os.environ.update(env)
    (ROOT / ".tmp").mkdir(exist_ok=True)
    procs = []
    try:
        log = (ROOT / ".tmp/payments-probe-setup.log").open("w")
        if external:
            subprocess.run(["npm", "--prefix", "medusa", "run", "db:migrate"], cwd=ROOT, env=env, check=True, stdout=log, stderr=log)
        else:
            subprocess.run(["bash", "scripts/spike.sh", "setup"], cwd=ROOT, env=env, check=True, stdout=log, stderr=log)
        for person in [SELLER, MAKER]:
            subprocess.run(["node", "scripts/sign.cjs", "--seed-person", person], cwd=ROOT, env=env, check=True)
        subprocess.run(["./node_modules/.bin/medusa", "exec", "./src/scripts/seed-matching.ts"], cwd=ROOT / "medusa",
                       env=env, check=True, stdout=log, stderr=log)
        procs.append(subprocess.Popen(["node", "scripts/stripe-stub.cjs", "12111"], cwd=ROOT, env=env,
                                      stdout=log, stderr=log, start_new_session=True))
        server_log = (ROOT / ".tmp/payments-probe-server.log").open("w")
        procs.append(subprocess.Popen(["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"],
                                      cwd=ROOT / "medusa", env=env, stdout=server_log, stderr=server_log, start_new_session=True))
        for _ in range(180):
            try:
                urllib.request.urlopen("http://127.0.0.1:9000/health", timeout=1).close()
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("Medusa health timeout; see .tmp/payments-probe-server.log")
        run(env)
    finally:
        for proc in reversed(procs):
            lifecycle.stop(proc)
        if not external:
            subprocess.run(["bash", "scripts/spike.sh", "stop"], cwd=ROOT, env=env)


def intent(pi):
    return stub("/__test/state")["payment_intents"][pi]


def fees_on(account):
    return [f for f in stub("/__test/state")["application_fees"].values() if f["account"] == account]


def run(env):
    scene = c.bootstrap()
    config = c.request("/market/store/config")
    pay = config["payments"]
    assert pay["provider"] == "stripe" and pay["provider_id"] == "pp_stripe_stripe", pay
    assert pay["charges"] == "direct" and pay["capture"] == {"stock": "delivery", "build": "order"}
    assert pay["publishable_key"] == "pk_test_stub" and pay["terms"] == TERMS
    assert "secret" not in json.dumps(pay).lower()
    buyer = StripeBuyer(scene)
    unit1, unit2, unit3 = scene["products"]
    buyer_id = scene["buyer_person_id"]

    print("1. a seller who cannot be paid yet: refused before the buyer authorizes anything", flush=True)
    cid = buyer.cart()
    buyer.call(f"/store/carts/{cid}/line-items", {"variant_id": unit1["variant_id"], "quantity": 1})
    refused(lambda: buyer.call("/dev/store/sign", {"action": "checkout", "cartId": cid}), "seller_payouts_not_ready")
    refused(lambda: buyer.call("/market/store/payment", {"cartId": cid}), "seller_payouts_not_ready")
    # A client may not open a Stripe session itself (account and fee are the server's).
    pc = buyer.call("/store/payment-collections", {"cart_id": cid})["payment_collection"]
    refused(lambda: buyer.call(f"/store/payment-collections/{pc['id']}/payment-sessions",
                               {"provider_id": "pp_stripe_stripe", "data": {"interfacer_direct": {
                                   "stripe_account": "acct_attacker", "application_fee_amount": 0, "order_reference": cid}}}),
            "use_market_payment_route")
    # A test (system) session is possible natively, but can never place an order.
    buyer.call(f"/store/payment-collections/{pc['id']}/payment-sessions", {"provider_id": "pp_system_default"})
    system_cart = cid

    print("2. seller onboarding: signs the commission in force, gets their own Standard Stripe account", flush=True)
    refused(lambda: signed("/market/store/payouts/onboard", {"country": "IT", **TERMS, "fee_bps": 500},
                           "commerce.payouts.onboard", SELLER), "seller_terms_outdated")
    refused(lambda: c.request("/market/store/payouts/onboard", {"country": "IT", **TERMS}), "invalid_payout_onboarding")
    first = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert first["onboarding_url"].startswith("https://connect.stripe.test/setup/acct_"), first
    assert not first["status"]["ready"] and "external_account" in first["status"]["requirements_due"]
    account = first["account_id"]
    assert stub("/__test/state")["accounts"][account]["type"] == "standard"
    again = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert again["account_id"] == account  # one account per person
    refused(lambda: signed("/market/store/payouts/onboard", {"country": "DE", **TERMS}, "commerce.payouts.onboard", SELLER),
            "payout_country_fixed")
    stub(f"/__test/accounts/{account}/complete", {})
    ready = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert ready["status"]["ready"] and ready["onboarding_url"] is None, ready

    print("3. stock sale: the buyer authorizes a payment on the SELLER's account; nothing is charged yet", flush=True)
    # No Stripe payment on the cart: refused before the workflow (the completion
    # hook would refuse the system session too: payment_provider_not_allowed).
    refused(lambda: buyer.complete_signed(system_cart), "payment_not_authorized")
    pi, on = buyer.pay(cid)
    assert on == account
    assert intent(pi)["account"] == account and intent(pi)["application_fee_amount"] == 160
    assert intent(pi)["capture_method"] == "manual" and intent(pi)["amount"] == 1995
    assert buyer.pay(cid) == (pi, account)  # the same session is reused, not replaced
    refused(lambda: buyer.complete_signed(cid), "payment_not_authorized")
    assert db_reserved(unit1) == 0  # refused before Medusa reserved anything (interfacer-medusa#5)
    buyer.confirm(pi, account)
    order1 = buyer.complete_signed(cid)
    assert order1["metadata"]["interfacer_settlement"] == {"seller_person_id": SELLER, "stripe_account_id": account, **TERMS}
    assert db_reserved(unit1) == 1
    assert buyer.capture(order1)["captured"] is False
    assert intent(pi)["status"] == "requires_capture" and not fees_on(account)

    print("4. delivery charges the buyer: 19.95 to the seller's account, 1.60 commission to Interfacer", flush=True)
    buyer.signed(f"/market/orders/{order1['id']}/deliver", {}, {"action": "deliver", "orderId": order1["id"]})
    assert intent(pi)["status"] == "succeeded"
    assert [f["amount"] for f in fees_on(account)] == [160]
    assert stub("/__test/state")["accounts"][account]["balance"] == 1835

    print("5. return within the window: request, accept, item back, refund; the commission goes back too", flush=True)
    view = buyer.call(f"/market/orders/{order1['id']}/aftersale")
    assert view["role"] == "buyer" and view["can"]["return"] == {"ok": True}, view
    assert view["can"]["cancellation"] == {"ok": False, "reason": "cancellation_after_handover"}
    open_params = {"order_id": order1["id"], "kind": "return", "reason": "Too small for my desk"}
    refused(lambda: signed(f"/market/orders/{order1['id']}/cases", open_params, "commerce.order.case.open", SELLER, 201),
            "buyer_order_required")
    case = signed(f"/market/orders/{order1['id']}/cases", open_params, "commerce.order.case.open", buyer_id, 201)["case"]
    assert case["status"] == "requested" and case["seller_person_id"] == SELLER
    refused(lambda: signed(f"/market/orders/{order1['id']}/cases", {**open_params, "reason": "again"},
                           "commerce.order.case.open", buyer_id, 201), "aftersale_case_open")
    base = f"/market/orders/{order1['id']}/cases/{case['id']}"
    respond = {"order_id": order1["id"], "case_id": case["id"], "decision": "accept", "note": "Send it back please"}
    refused(lambda: signed(base + "/respond", respond, "commerce.order.case.respond", buyer_id), "seller_order_required")
    assert signed(base + "/respond", respond, "commerce.order.case.respond", SELLER)["case"]["status"] == "accepted"
    returned = {"order_id": order1["id"], "case_id": case["id"], "refund_cents": 1000, "note": ""}
    refused(lambda: signed(base + "/returned", returned, "commerce.order.case.returned", SELLER), "partial_refund_note_required")
    refused(lambda: signed(base + "/returned", {**returned, "refund_cents": 5000}, "commerce.order.case.returned", SELLER),
            "refund_exceeds_payment")
    done = signed(base + "/returned", {**returned, "refund_cents": 1995}, "commerce.order.case.returned", SELLER)["case"]
    assert done["status"] == "refunded" and done["returned_at"], done
    refunds = [r for r in stub("/__test/state")["refunds"].values() if r["payment_intent"] == pi]
    assert [(r["amount"], r["account"], r["application_fee_refunded"]) for r in refunds] == [(1995, account, 160)], refunds
    assert stub("/__test/state")["accounts"][account]["balance"] == 0
    view = buyer.call(f"/market/orders/{order1['id']}/aftersale")
    assert view["refunded_cents"] == 1995 and view["refunds"][0]["status"] == "done", view
    assert view["can"]["return"] == {"ok": False, "reason": "order_fully_refunded"}

    print("6. cancellation before delivery: the authorization is released, nothing is charged, the unit is free", flush=True)
    order2, pi2 = buyer.buy(unit2)
    cancel = {"order_id": order2["id"], "kind": "cancellation", "reason": "Ordered by mistake"}
    case2 = signed(f"/market/orders/{order2['id']}/cases", cancel, "commerce.order.case.open", buyer_id, 201)["case"]
    refused(lambda: buyer.signed(f"/market/orders/{order2['id']}/deliver", {}, {"action": "deliver", "orderId": order2["id"]}),
            "aftersale_cancellation_pending")
    assert intent(pi2)["status"] == "requires_capture"  # the refused delivery charged nothing
    refused(lambda: signed(f"/market/orders/{order2['id']}/cases/{case2['id']}/respond",
                           {"order_id": order2["id"], "case_id": case2["id"], "decision": "reject", "note": " "},
                           "commerce.order.case.respond", SELLER), "aftersale_reject_reason_required")
    accepted = signed(f"/market/orders/{order2['id']}/cases/{case2['id']}/respond",
                      {"order_id": order2["id"], "case_id": case2["id"], "decision": "accept", "note": ""},
                      "commerce.order.case.respond", SELLER)["case"]
    assert accepted["status"] == "refunded", accepted
    assert buyer.order(order2["id"])["status"] == "canceled"
    assert intent(pi2)["status"] == "canceled"
    assert not [r for r in stub("/__test/state")["refunds"].values() if r["payment_intent"] == pi2]
    assert db_reserved(unit2) == 0
    refused(lambda: buyer.signed(f"/market/orders/{order2['id']}/deliver", {}, {"action": "deliver", "orderId": order2["id"]}),
            "demo_order_required")  # nothing to sign for a canceled order

    print("7. a goodwill partial refund after delivery: 5.00 back, 0.40 of the commission with it", flush=True)
    order3, pi3 = buyer.buy(unit3)
    refused(lambda: signed(f"/market/orders/{order3['id']}/refunds",
                           {"order_id": order3["id"], "amount_cents": 500, "reason": "x"}, "commerce.order.refund", SELLER, 201),
            "captured_payment_required")  # not charged before delivery: cancel instead
    buyer.signed(f"/market/orders/{order3['id']}/deliver", {}, {"action": "deliver", "orderId": order3["id"]})
    refund = signed(f"/market/orders/{order3['id']}/refunds",
                    {"order_id": order3["id"], "amount_cents": 500, "reason": "Scratch on the side"},
                    "commerce.order.refund", SELLER, 201)["refund"]
    assert refund["status"] == "done" and refund["amount_cents"] == 500
    refused(lambda: signed(f"/market/orders/{order3['id']}/refunds",
                           {"order_id": order3["id"], "amount_cents": 500, "reason": "x"}, "commerce.order.refund", buyer_id, 201),
            "seller_order_required")
    r3 = [r for r in stub("/__test/state")["refunds"].values() if r["payment_intent"] == pi3]
    assert [(r["amount"], r["application_fee_refunded"]) for r in r3] == [(500, 40)], r3

    print("8. build: the maker onboards; the quote is charged as soon as the order exists", flush=True)
    designs = buyer.call("/market/designs")["designs"]
    design = next(d for d in designs if d["id"] == "ifdes_p4_organizer")
    quote = buyer.call("/market/match", {"designId": design["id"]})["matches"][0]["quote"]
    assert quote["provider_person_id"] == MAKER and quote["total_price_cents"] == 1900
    cid = buyer.cart()
    refused(lambda: buyer.call("/dev/store/sign", {"action": "build", "cartId": cid, "quoteId": quote["id"]}), "seller_payouts_not_ready")
    maker = signed("/market/store/payouts/onboard", {"country": "DE", **TERMS}, "commerce.payouts.onboard", MAKER)
    stub(f"/__test/accounts/{maker['account_id']}/complete", {})
    buyer.signed("/market/build-orders", {"cartId": cid, "quoteId": quote["id"]}, {"action": "build", "cartId": cid, "quoteId": quote["id"]})
    pi4, on4 = buyer.pay(cid)
    assert on4 == maker["account_id"] and intent(pi4)["application_fee_amount"] == 152
    buyer.confirm(pi4, on4)
    build = buyer.complete_signed(cid)
    assert buyer.capture(build)["captured"] is True and intent(pi4)["status"] == "succeeded"
    receipt = buyer.signed(f"/market/build-orders/{build['id']}/produce", {}, {"action": "produce", "orderId": build["id"]})["receipt"]
    assert receipt["action"] == "produce"
    assert [f["amount"] for f in fees_on(maker["account_id"])] == [152]

    print("9. an authorization that lapses before delivery cancels the order and frees the unit", flush=True)
    order5, pi5 = buyer.buy(unit2)  # unit 2 is for sale again after step 6
    stub(f"/__test/payment_intents/{pi5}/expire", {})
    assert money_report(env)["lapsed_canceled"] == 0  # too recent to look at
    assert money_report(env, "lapse-check-all")["lapsed_canceled"] == 1
    assert buyer.order(order5["id"])["status"] == "canceled" and db_reserved(unit2) == 0
    refused(lambda: buyer.signed(f"/market/orders/{order5['id']}/deliver", {}, {"action": "deliver", "orderId": order5["id"]}),
            "demo_order_required")

    state = stub("/__test/state")
    kept = sum(f["amount"] - f["amount_refunded"] for f in state["application_fees"].values())
    sellers = {a: v["balance"] for a, v in state["accounts"].items()}
    print(f"  Interfacer kept {kept} cents of commission; seller balances {sellers}")
    # Commission on what was not refunded: order3 160 - 40, build 152.
    assert kept == (160 - 40) + 152
    assert sellers == {account: 0 + (1995 - 500) - (160 - 40), maker["account_id"]: 1900 - 152}
    print("PASS payments (direct charges): Standard accounts + signed terms, payment on the seller's account with the "
          "commission as application fee, capture at delivery (stock) / at order (build), return/cancellation/partial "
          "refunds with the commission given back, lapsed authorizations; refusals hold", flush=True)


if __name__ == "__main__":
    main()
