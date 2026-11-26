#!/usr/bin/env python3
"""Release 4ku.1/4ku.2 end-to-end probe: Stripe Connect payments, platform
commission, payouts, cancellations, returns and refunds, through a REAL Medusa
on a REAL Postgres, with Stripe replaced by the local stand-in
(scripts/stripe-stub.cjs). Standalone fixture mode: the seller and the maker are
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


def money_report(env):
    out = subprocess.check_output(["./node_modules/.bin/medusa", "exec", "./src/scripts/money-report.ts"],
                                  cwd=ROOT / "medusa", env=env, text=True, stderr=subprocess.STDOUT)
    line = next(l for l in out.splitlines() if l.startswith('{"refunds_resumed"'))
    print("  money-report " + line, flush=True)
    return json.loads(line)


class StripeBuyer(c.Buyer):
    def pay(self, cid):
        """Native payment session through Stripe, then what Stripe.js does when
        the buyer confirms the Payment Element (authorization only)."""
        pc = self.call("/store/payment-collections", {"cart_id": cid})["payment_collection"]
        pc = self.call(f"/store/payment-collections/{pc['id']}/payment-sessions", {"provider_id": "pp_stripe_stripe"})["payment_collection"]
        session = pc["payment_sessions"][0]
        assert session["provider_id"] == "pp_stripe_stripe"
        pi = session["data"]["id"]
        assert session["data"]["client_secret"].startswith(pi + "_secret_")
        assert session["data"]["capture_method"] == "manual"
        return pi

    def confirm(self, pi):
        req = urllib.request.Request(f"{STUB}/v1/payment_intents/{pi}/confirm", method="POST",
                                     data=b"payment_method=pm_card_visa",
                                     headers={"Authorization": "Bearer sk_test_stub"})
        with urllib.request.urlopen(req, timeout=10) as res:
            assert json.loads(res.read())["status"] == "requires_capture"

    def complete_signed(self, cid, expect_order=True):
        result = self.signed(f"/store/carts/{cid}/complete?" + urlencode({"fields": c.ORDER_FIELDS}), {},
                             {"action": "checkout", "cartId": cid})
        if not expect_order:
            return result
        assert result["type"] == "order", json.dumps(result.get("error"))
        return result["order"]

    def buy(self, product):
        cid = self.cart()
        self.call(f"/store/carts/{cid}/line-items", {"variant_id": product["variant_id"], "quantity": 1})
        pi = self.pay(cid)
        self.confirm(pi)
        order = self.complete_signed(cid)
        self.capture(order)
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


def run(env):
    scene = c.bootstrap()
    config = c.request("/market/store/config")
    assert config["payments"]["provider"] == "stripe", config["payments"]
    assert config["payments"]["provider_id"] == "pp_stripe_stripe"
    assert config["payments"]["publishable_key"] == "pk_test_stub"
    assert config["payments"]["terms"] == TERMS
    assert "secret" not in json.dumps(config["payments"]).lower()
    buyer = StripeBuyer(scene)
    unit1, unit2, unit3 = scene["products"]

    print("1. a seller who cannot be paid yet: refused before the buyer authorizes anything", flush=True)
    cid = buyer.cart()
    buyer.call(f"/store/carts/{cid}/line-items", {"variant_id": unit1["variant_id"], "quantity": 1})
    refused(lambda: buyer.call("/dev/store/sign", {"action": "checkout", "cartId": cid}), "seller_payouts_not_ready")
    # Medusa lets a client open a session with any registered provider; the
    # completion hook is what keeps a test (system) payment from placing an order.
    pc = buyer.call("/store/payment-collections", {"cart_id": cid})["payment_collection"]
    buyer.call(f"/store/payment-collections/{pc['id']}/payment-sessions", {"provider_id": "pp_system_default"})
    system_cart = cid

    print("2. seller onboarding: signs the commission in force, gets a Stripe link", flush=True)
    refused(lambda: signed("/market/store/payouts/onboard", {"country": "IT", **TERMS, "fee_bps": 500},
                           "commerce.payouts.onboard", SELLER), "seller_terms_outdated")
    refused(lambda: c.request("/market/store/payouts/onboard", {"country": "IT", **TERMS}, expected=200), "invalid_payout_onboarding")
    first = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert first["onboarding_url"].startswith("https://connect.stripe.test/setup/acct_"), first
    assert not first["status"]["ready"] and "external_account" in first["status"]["requirements_due"]
    again = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert again["account_id"] == first["account_id"]  # one account per person
    refused(lambda: signed("/market/store/payouts/onboard", {"country": "DE", **TERMS}, "commerce.payouts.onboard", SELLER),
            "payout_country_fixed")
    refused(lambda: buyer.call("/dev/store/sign", {"action": "checkout", "cartId": cid}), "seller_payouts_not_ready")
    stub(f"/__test/accounts/{first['account_id']}/complete", {})
    ready = signed("/market/store/payouts/onboard", {"country": "IT", **TERMS}, "commerce.payouts.onboard", SELLER)
    assert ready["status"]["ready"] and ready["onboarding_url"] is None, ready
    dash = signed("/market/store/payouts/dashboard", {}, "commerce.payouts.dashboard", SELLER)
    assert dash["url"] == f"https://connect.stripe.test/express/{first['account_id']}"
    account = first["account_id"]

    print("3. stock sale: authorize, place, capture; terms frozen on the order", flush=True)
    refused(lambda: buyer.complete_signed(system_cart), "payment_provider_not_allowed")
    pi = buyer.pay(cid)
    # Nothing confirmed with Stripe yet: refused before Medusa reserves the
    # unit (its failed-authorization path would leave the unit reserved).
    refused(lambda: buyer.complete_signed(cid), "payment_not_authorized")
    buyer.confirm(pi)
    order1 = buyer.complete_signed(cid)
    assert db_reserved(unit1) == 1  # the sold unit, nothing leaked
    assert order1["metadata"]["interfacer_settlement"] == {"seller_person_id": SELLER, "stripe_account_id": account, **TERMS}
    assert stub("/__test/state")["payment_intents"][pi]["status"] == "requires_capture"
    buyer.capture(order1)
    state = stub("/__test/state")
    assert state["payment_intents"][pi]["status"] == "succeeded" and state["payment_intents"][pi]["amount"] == 1995
    buyer.capture(order1)  # idempotent
    assert money_report(env)["payouts_created"] == 0  # paid is not delivered: nothing to pay out yet

    print("4. delivery makes the sale complete: payout of 19.95 - 8% = 18.35 to the seller", flush=True)
    buyer.signed(f"/market/orders/{order1['id']}/deliver", {}, {"action": "deliver", "orderId": order1["id"]})
    report = money_report(env)
    assert report["payouts_transferred"] == 1, report
    transfers = [t for t in stub("/__test/state")["transfers"].values() if t["transfer_group"] == order1["id"]]
    assert len(transfers) == 1 and transfers[0]["amount"] == 1835 and transfers[0]["destination"] == account
    assert transfers[0]["source_transaction"] == stub("/__test/state")["payment_intents"][pi]["latest_charge"]
    assert money_report(env)["payouts_transferred"] == 0  # never twice

    print("5. return within the window: request, accept, item back, refund; seller share reversed", flush=True)
    buyer_id = scene["buyer_person_id"]
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
    state = stub("/__test/state")
    refunds = [r for r in state["refunds"].values() if r["payment_intent"] == pi]
    assert [r["amount"] for r in refunds] == [1995], refunds
    t = state["transfers"][transfers[0]["id"]]
    assert t["amount_reversed"] == 1835 and t["reversed"], t
    view = buyer.call(f"/market/orders/{order1['id']}/aftersale")
    assert view["refunded_cents"] == 1995 and view["refunds"][0]["status"] == "done", view
    assert "reversal_cents" not in view["refunds"][0]  # the seller's books are not the buyer's business
    assert view["can"]["return"] == {"ok": False, "reason": "order_fully_refunded"}

    print("6. cancellation before delivery: the seller must answer first; accepting cancels and refunds", flush=True)
    order2, pi2 = buyer.buy(unit2)
    cancel = {"order_id": order2["id"], "kind": "cancellation", "reason": "Ordered by mistake"}
    case2 = signed(f"/market/orders/{order2['id']}/cases", cancel, "commerce.order.case.open", buyer_id, 201)["case"]
    refused(lambda: buyer.signed(f"/market/orders/{order2['id']}/deliver", {}, {"action": "deliver", "orderId": order2["id"]}),
            "aftersale_cancellation_pending")
    rejected_needs_note = {"order_id": order2["id"], "case_id": case2["id"], "decision": "reject", "note": " "}
    refused(lambda: signed(f"/market/orders/{order2['id']}/cases/{case2['id']}/respond", rejected_needs_note,
                           "commerce.order.case.respond", SELLER), "aftersale_reject_reason_required")
    accepted = signed(f"/market/orders/{order2['id']}/cases/{case2['id']}/respond",
                      {"order_id": order2["id"], "case_id": case2["id"], "decision": "accept", "note": ""},
                      "commerce.order.case.respond", SELLER)["case"]
    assert accepted["status"] == "refunded", accepted
    assert buyer.order(order2["id"])["status"] == "canceled"
    assert [r["amount"] for r in stub("/__test/state")["refunds"].values() if r["payment_intent"] == pi2] == [1995]
    assert db_reserved(unit2) == 0  # the reservation is released: the unit is for sale again
    refused(lambda: buyer.signed(f"/market/orders/{order2['id']}/deliver", {}, {"action": "deliver", "orderId": order2["id"]}),
            "demo_order_required")  # nothing to sign for a canceled order
    assert not [t for t in stub("/__test/state")["transfers"].values() if t["transfer_group"] == order2["id"]]

    print("7. a goodwill partial refund before the payout shrinks the seller's transfer", flush=True)
    order3, pi3 = buyer.buy(unit3)
    buyer.signed(f"/market/orders/{order3['id']}/deliver", {}, {"action": "deliver", "orderId": order3["id"]})
    refund = signed(f"/market/orders/{order3['id']}/refunds",
                    {"order_id": order3["id"], "amount_cents": 500, "reason": "Scratch on the side"},
                    "commerce.order.refund", SELLER, 201)["refund"]
    assert refund["status"] == "done" and refund["amount_cents"] == 500
    refused(lambda: signed(f"/market/orders/{order3['id']}/refunds",
                           {"order_id": order3["id"], "amount_cents": 500, "reason": "x"}, "commerce.order.refund", buyer_id, 201),
            "seller_order_required")
    assert money_report(env)["payouts_transferred"] == 1
    t3 = [t for t in stub("/__test/state")["transfers"].values() if t["transfer_group"] == order3["id"]]
    assert [t["amount"] for t in t3] == [1835 - 460], t3

    print("8. build: the maker onboards, the buyer pays the quote, production pays the maker", flush=True)
    design = buyer.call("/market/designs")["designs"]
    design = next(d for d in design if d["id"] == "ifdes_p4_organizer")
    quote = buyer.call("/market/match", {"designId": design["id"]})["matches"][0]["quote"]
    assert quote["provider_person_id"] == MAKER and quote["total_price_cents"] == 1900
    cid = buyer.cart()
    refused(lambda: buyer.call("/dev/store/sign", {"action": "build", "cartId": cid, "quoteId": quote["id"]}), "seller_payouts_not_ready")
    maker = signed("/market/store/payouts/onboard", {"country": "DE", **TERMS}, "commerce.payouts.onboard", MAKER)
    stub(f"/__test/accounts/{maker['account_id']}/complete", {})
    buyer.signed("/market/build-orders", {"cartId": cid, "quoteId": quote["id"]}, {"action": "build", "cartId": cid, "quoteId": quote["id"]})
    pi4 = buyer.pay(cid)
    buyer.confirm(pi4)
    build = buyer.complete_signed(cid)
    buyer.capture(build)
    receipt = buyer.signed(f"/market/build-orders/{build['id']}/produce", {}, {"action": "produce", "orderId": build["id"]})["receipt"]
    assert receipt["action"] == "produce"
    assert money_report(env)["payouts_transferred"] == 1
    t4 = [t for t in stub("/__test/state")["transfers"].values() if t["transfer_group"] == build["id"]]
    assert [(t["amount"], t["destination"]) for t in t4] == [(1900 - 152, maker["account_id"])], t4

    totals = stub("/__test/state")
    captured = sum(p["amount_received"] for p in totals["payment_intents"].values())
    refunded = sum(r["amount"] for r in totals["refunds"].values())
    paid_out = sum(t["amount"] - t["amount_reversed"] for t in totals["transfers"].values())
    print(f"  platform: captured {captured}, refunded {refunded}, paid to sellers {paid_out}, kept {captured - refunded - paid_out} (cents)")
    # Kept = commission on what was not refunded: order3 160 - 40 + build 152.
    assert captured - refunded - paid_out == (160 - 40) + 152
    print("PASS payments: Stripe Connect onboarding + signed terms, authorize/capture, payouts net of commission after the "
          "milestone, return/cancellation/partial refunds with proportional reversal; refusals hold", flush=True)


if __name__ == "__main__":
    main()
