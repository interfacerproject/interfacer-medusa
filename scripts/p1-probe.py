#!/usr/bin/env python3
"""Real curl P1 acceptance. Retains DB data; cleans server + DB even on failure."""
import json
import os
import shlex
import subprocess
from importlib import import_module
from pathlib import Path
from urllib.parse import urlencode, urlparse
from concurrent.futures import ThreadPoolExecutor

root = Path(__file__).resolve().parent.parent
base = "http://127.0.0.1:9000"
transcript = []


def note(message):
    transcript.append(message + "\n")
    print(message, flush=True)


def curl(path, *args, expected=200):
    command = ["curl", "--silent", "--show-error", "--max-time", "30",
               "--write-out", "\nHTTP %{http_code}\n", *args, base + path]
    output = subprocess.check_output(command, cwd=root, text=True)
    block = "```bash\n" + shlex.join(command) + "\n```\n\n```text\n" + output + "```\n"
    transcript.append(block)
    print(block, flush=True)
    body, status = output.rsplit("\nHTTP ", 1)
    assert int(status.strip()) == expected, output
    return json.loads(body) if body and not body.startswith("HTTP/") else body


def post(path, body=None, expected=200):
    return curl(path, "-H", "Content-Type: application/json", "-X", "POST",
                "--data", json.dumps(body or {}), expected=expected)


def snapshot():
    # Read-only observations; all commerce writes use supported Medusa workflows.
    tables = ["region", "sales_channel", "stock_location", "api_key", "store_currency",
              "product", "product_variant", "interfacer_listing_binding",
              "price", "price_set", "product_variant_price_set", "product_sales_channel",
              "publishable_api_key_sales_channel", "sales_channel_stock_location"]
    sql = "SELECT " + ", ".join(f"(SELECT count(*) FROM {table})" for table in tables)
    database = urlparse(os.environ["DATABASE_URL"]).path.lstrip("/")
    counts = subprocess.check_output([
        "docker", "exec", "interfacer-medusa-spike-db", "psql", "-U", "medusa",
        "-d", database, "-Atc", sql,
    ], text=True).strip().split("|")
    return dict(zip(tables, map(int, counts)))


def enabled_checks():
    context = post("/dev/interfacer/commerce")
    seeded = snapshot()
    assert post("/dev/interfacer/commerce") == context
    assert snapshot() == seeded
    (root / ".tmp/p1-commerce-context.json").write_text(json.dumps(context, indent=2) + "\n")
    note("PASS re-seed: identical context/key, no new commerce rows or links.")

    resource = json.loads((root / "docs/fixtures/economic-resource.json").read_text())
    dpp = json.loads((root / "docs/fixtures/dpp.json").read_text())
    # Own resource keeps Phase-0's draft acceptance independent of publication.
    resource["id"] += "-p1"
    dpp["ProductID"] = resource["id"]
    dpp["ID"] += "-p1"
    payload = {"resource": resource, "dpp": dpp, "actingPersonId": resource["primaryAccountable"]["id"]}
    (root / ".tmp/p1-request.json").write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    listings = curl("/dev/interfacer/listings")["listings"]
    existing = any(row["binding"]["catalog_resource_id"] == resource["id"] for row in listings)
    listing = curl("/dev/interfacer/listings", "-H", "Content-Type: application/json",
                   "--data-binary", "@.tmp/p1-request.json", expected=200 if existing else 201)
    listing_id = listing["binding"]["id"]
    publish_path = f"/dev/interfacer/listings/{listing_id}/publish"
    query = urlencode({
        "region_id": context["region_id"], "sales_channel_id": context["sales_channel_id"],
        "fields": "id,title,status,metadata,variants.id,variants.calculated_price.*",
    })
    catalog_path = "/store/products?" + query

    def catalog():
        return curl(catalog_path, "-H", "x-publishable-api-key: " + context["publishable_key"])

    curl(catalog_path, expected=400)  # no publishable key: never an accidental open catalog
    if listing["status"] == "draft":
        assert not any(p["id"] == listing["product_id"] for p in catalog()["products"])
        note("PASS Store API hides the DRAFT resource-backed product.")

    for origin in ["http://localhost:3104", "http://localhost:3000"]:
        headers = curl(publish_path, "-i", "-X", "OPTIONS", "-H", f"Origin: {origin}", expected=204)
        assert f"access-control-allow-origin: {origin}" in headers.lower()

    before_bad = snapshot()
    for bad in [None, "19.95", 0, -1, 1.001, 1000001]:
        assert post(publish_path, {"priceEUR": bad}, expected=400)["reason"].startswith("invalid_price")
    post("/dev/interfacer/listings/missing/publish", {"priceEUR": 19.95}, expected=404)
    curl(publish_path, "-X", "POST", "-H", "Origin: https://example.org", expected=403)
    assert snapshot() == before_bad
    note("PASS invalid prices, unknown binding and disallowed origin: no rows written.")

    published = post(publish_path, {"priceEUR": 19.95})
    assert published["status"] == "published"
    assert published["dpp_id"] == dpp["ID"]
    assert published["price"] == {"currency_code": "eur", "amount": 19.95}
    counts = snapshot()
    # Concurrent retries must serialize and preserve the existing price ID.
    with ThreadPoolExecutor(max_workers=3) as pool:
        retries = list(pool.map(lambda _: post(publish_path, {"priceEUR": 19.95}), range(3)))
    assert all(p == {**published, "changed": False} for p in retries)
    assert snapshot() == counts
    post("/dev/interfacer/commerce")
    assert snapshot() == counts
    note("PASS concurrent re-publish + re-seed: no duplicate rows, including price/link tables. " + json.dumps(counts))

    # Re-pricing updates the same price ID rather than appending prices.
    post(publish_path, {"priceEUR": 20})
    assert snapshot() == counts
    post(publish_path, {"priceEUR": 19.95})
    assert snapshot() == counts
    result = catalog()
    rows = [p for p in result["products"] if p["id"] == listing["product_id"]]
    assert len(rows) == 1
    product = rows[0]
    assert product["status"] == "published"
    assert product["metadata"]["interfacer_dpp_id"] == dpp["ID"]
    assert product["metadata"]["interfacer_resource_id"] == resource["id"]
    assert len(product["variants"]) == 1
    assert product["variants"][0]["id"] == listing["variant_id"]
    price = product["variants"][0]["calculated_price"]
    assert price["currency_code"] == "eur"
    assert price["calculated_amount"] == 19.95
    retry = curl("/dev/interfacer/listings", "-H", "Content-Type: application/json",
                 "--data-binary", "@.tmp/p1-request.json")
    assert not retry["created"] and retry["status"] == "published"
    assert retry["binding"] == listing["binding"]  # immutable creation evidence stays draft
    assert snapshot() == counts
    note("PASS real GET /store/products: published product, EUR 19.95 calculated price, resource + DPP references; immutable binding unchanged.")


def disabled_checks():
    for path in ["/dev/interfacer/commerce", "/dev/interfacer/listings/unknown/publish"]:
        for method in ["POST", "OPTIONS"]:
            assert curl(path, "-X", method, expected=403) == {"reason": "local_fixture_mode_required"}
    note("PASS disabled fixture mode: seed/publish/preflight refused.")


try:
    serve = import_module("server-lifecycle").serve
    command = ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"]
    serve(command, os.environ.copy(), "p1-server.log", enabled_checks, cwd=root / "medusa")
    env = {**os.environ, "INTERFACER_AUTH_MODE": "disabled"}
    serve(command, env, "p1-server-disabled.log", disabled_checks, cwd=root / "medusa")
    note("ALL P1 CHECKS PASSED; both server sessions stopped via per-PID signals.")
finally:
    (root / ".tmp/p1-transcript.md").write_text("\n".join(transcript))
