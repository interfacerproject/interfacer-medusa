#!/usr/bin/env python3
"""P8: live real-actor marketplace against a REAL local Zenflows (no fixture keys).

Requires `npm run dev:up` with INTERFACER_ZENFLOWS_URL set (live mode). Creates
disposable Zenflows People with fresh keys (scripts/zenflows-actor.cjs): a
designer, a maker, a seller, a buyer and an outsider, plus their own resources.

  1. The owners register the design and the service.
  2. The seller lists the product.
  3. The buyer buys stock and a build.
  4. Each seller signs their own milestone.
  5. Zenflows is queried for who did what.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "scripts"))
from live_actors import CAPABILITIES, REQUIREMENTS, Wallet, actor, c, events_of, reason, sign, zf  # noqa: E402


def main():
    scene = c.request("/dev/store/config")
    assert scene.get("live") is True and "password" not in scene and "email" not in scene, "live scene must disclose no login"
    people = {a: json.loads(actor("create", a)) for a in ["designer", "maker", "seller", "buyer", "outsider"]}
    pid = {a: p["id"] for a, p in people.items()}
    design = json.loads(actor("raise", "designer", "Design", "Live lamp shade"))["resource_id"]
    service = json.loads(actor("raise", "maker", "Service", "Live Torino FDM"))["resource_id"]
    product = json.loads(actor("raise", "seller", "Product", "Live recycled lamp", "2"))["resource_id"]

    # Catalog: only the accountable owner, only the right spec, strict versioned docs.
    ddoc = {"resource_id": design, "document": {"schema_version": "interfacer-build-requirements-v1", "requirements": REQUIREMENTS}}
    sdoc = {"resource_id": service, "document": {"schema_version": "interfacer-fabrication-capabilities-v1",
            "capabilities": CAPABILITIES, "base_price_eur": 10, "per_unit_price_eur": 4.5,
            "location": {"country_code": "it", "city": "Torino"}}}
    assert "catalog_owner_required" in reason("/dev/interfacer/catalog/designs", ddoc, sign("outsider", "catalog.design.register", ddoc))
    assert "catalog_spec_mismatch" in reason("/dev/interfacer/catalog/designs", {**ddoc, "resource_id": service},
        sign("maker", "catalog.design.register", {**ddoc, "resource_id": service}))
    bad = {**ddoc, "document": {**ddoc["document"], "tags": ["3d"]}}
    assert "invalid_catalog_document" in reason("/dev/interfacer/catalog/designs", bad, sign("designer", "catalog.design.register", bad))
    assert "authorization_denied" in reason("/dev/interfacer/catalog/designs", ddoc, sign("designer", "catalog.design.register", {**ddoc, "resource_id": product}))
    assert c.request("/dev/interfacer/catalog/designs", ddoc, signature=sign("designer", "catalog.design.register", ddoc), expected=201)["created"]
    assert not c.request("/dev/interfacer/catalog/designs", ddoc, signature=sign("designer", "catalog.design.register", ddoc))["created"]
    c.request("/dev/interfacer/catalog/services", sdoc, signature=sign("maker", "catalog.service.register", sdoc), expected=201)
    print("PASS P8 CATALOG: owner-only, spec-checked, strict versioned registration; idempotent re-registration", flush=True)

    # Live listing of the seller's REAL resource; fixture/dev signer surfaces are gone.
    body = {"resource_id": product}
    assert "catalog_owner_required" in reason("/dev/interfacer/listings/live", body, sign("outsider", "commerce.listing.live.create", body))
    listing = c.request("/dev/interfacer/listings/live", body, signature=sign("seller", "commerce.listing.live.create", body), expected=201)
    lid = listing["binding"]["id"]
    assert listing["binding"]["seller_agent_id"] == pid["seller"]
    assert listing["binding"]["source_dpp_id"] == "zenflows:traceDpp:" + product
    pub = {"listing_id": lid, "priceEUR": 24.5}
    c.request(f"/dev/interfacer/listings/{lid}/publish", {"priceEUR": 24.5}, signature=sign("seller", "commerce.listing.publish", pub))
    c.request(f"/dev/interfacer/listings/{lid}/checkout", {}, signature=sign("seller", "commerce.listing.checkout.setup", {"listing_id": lid}))
    scene = c.request("/dev/store/config")
    assert any(p["listing_id"] == lid for p in scene["products"])
    print(f"PASS P8 LISTING: seller listed their own Zenflows resource {product} (DPP derived, not asserted)", flush=True)

    buyer = Wallet("buyer", pid["buyer"], scene)
    assert c.request("/dev/store/sign", {"action": "capture", "orderId": "x"}, buyer.token, expected=403)["reason"] == "dev_signer_disabled_live"
    seller = Wallet("seller", pid["seller"], scene)
    cid = seller.cart()
    seller.call(f"/store/carts/{cid}/line-items", {"variant_id": listing["variant_id"], "quantity": 1})
    assert "self_purchase_forbidden" in reason("/dev/store/prepare", {"action": "checkout", "cartId": cid}, token=seller.token, key=seller.key)

    # Stock: buyer buys, the SELLER signs delivery; one unit of the real resource moves.
    cid = buyer.cart()
    buyer.call(f"/store/carts/{cid}/line-items", {"variant_id": listing["variant_id"], "quantity": 1})
    stock_order = buyer.pay_and_complete(cid)
    assert "seller_order_required" in reason("/dev/store/prepare", {"action": "deliver", "orderId": stock_order}, token=buyer.token, key=buyer.key)
    maker = Wallet("maker", pid["maker"], scene)
    assert "seller_order_required" in reason("/dev/store/prepare", {"action": "deliver", "orderId": stock_order}, token=maker.token, key=maker.key)
    receipt = seller.signed(f"/dev/interfacer/orders/{stock_order}/deliver", {}, {"action": "deliver", "orderId": stock_order}, expected=201)["receipt"]
    assert receipt["zenflows_sync"]["status"] == "done" and receipt["zenflows_event_id"], receipt
    src = events_of(product)
    assert float(src["onhandQuantity"]["hasNumericalValue"]) == 1 and src["primaryAccountable"]["id"] == pid["seller"]
    transfer = zf("query($id: ID!) { economicEvent(id: $id) { action { id } provider { id } receiver { id } resourceInventoriedAs { id } toResourceInventoriedAs { id primaryAccountable { id } } } }",
                  {"id": receipt["zenflows_event_id"]})["economicEvent"]
    assert transfer["action"]["id"] == "transfer" and transfer["provider"]["id"] == pid["seller"] and transfer["receiver"]["id"] == pid["buyer"]
    assert transfer["resourceInventoriedAs"]["id"] == product and transfer["toResourceInventoriedAs"]["primaryAccountable"]["id"] == pid["buyer"]
    assert not any(e["action"]["id"] == "raise" and e["provider"]["id"] != pid["seller"] for e in src["previous"])
    print(f"PASS P8 STOCK: seller-signed delivery transferred 1 of the seller's real resource to the buyer (event {transfer and receipt['zenflows_event_id']}); no stand-in raise", flush=True)

    # Build: registered design x registered service, provider = the maker, who signs production.
    matches = buyer.call("/dev/interfacer/match", {"designId": design})
    quote = next(m["quote"] for m in matches["matches"] if m["service"]["id"] == service)
    assert quote["provider_person_id"] == pid["maker"] and quote["total_price_cents"] == 1900
    cid = buyer.cart()
    buyer.signed("/dev/interfacer/build-orders", {"cartId": cid, "quoteId": quote["id"]}, {"action": "build", "cartId": cid, "quoteId": quote["id"]})
    build_order = buyer.pay_and_complete(cid)
    assert "seller_order_required" in reason("/dev/store/prepare", {"action": "produce", "orderId": build_order}, token=seller.token, key=seller.key)
    receipt = maker.signed(f"/dev/interfacer/build-orders/{build_order}/produce", {}, {"action": "produce", "orderId": build_order}, expected=201)["receipt"]
    assert receipt["provider_id"] == pid["maker"] and receipt["zenflows_sync"]["status"] == "done", receipt
    sync = receipt["zenflows_sync"]
    produced = events_of(sync["resource_id"])
    produce = next(e for e in produced["previous"] if e["action"]["id"] == "produce")
    assert produce["provider"]["id"] == pid["maker"] and produce["outputOf"]["id"] == sync["process_id"] and produce["outputOf"]["finished"]
    handover = zf("query($id: ID!) { economicEvent(id: $id) { provider { id } receiver { id } } }", {"id": receipt["zenflows_event_id"]})["economicEvent"]
    assert handover["provider"]["id"] == pid["maker"] and handover["receiver"]["id"] == pid["buyer"]
    dash = maker.call("/dev/store/seller")
    assert any(o["id"] == build_order and o["receipt"]["zenflows_event_id"] for o in dash["orders"])
    print(f"PASS P8 BUILD: maker-signed production, Process {sync['process_id']} -> produce -> transfer to buyer; seller console lists it", flush=True)

    # Ownership changes are revalidated at match time: the service is excluded, not quoted.
    unit = zf("{ instanceVariables { units { unitOne { id } } } }")["instanceVariables"]["units"]["unitOne"]["id"]
    zf("""mutation($e: EconomicEventCreateParams!) { createEconomicEvent(event: $e) { economicEvent { id } } }""",
       {"e": {"action": "transfer", "provider": pid["maker"], "receiver": pid["outsider"], "resourceInventoriedAs": service,
              "resourceQuantity": {"hasNumericalValue": 1, "hasUnit": unit}, "hasPointInTime": "2026-10-26T18:00:00.000Z"}})
    rematch = buyer.call("/dev/interfacer/match", {"designId": design})
    assert not any(m["service"]["id"] == service for m in rematch["matches"])
    assert any(r["service"]["id"] == service and r["reason"] == "catalog_owner_changed" for r in rematch["rejected"]), rematch["rejected"]
    print("PASS P8 REVALIDATION: a service transferred away is excluded with catalog_owner_changed", flush=True)


if __name__ == "__main__":
    main()
