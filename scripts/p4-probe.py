#!/usr/bin/env python3
"""P4 real curl: structured requirements/capabilities, immutable priced quotes."""
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module

http = import_module("p2-probe")  # shared real curl transcript + read-only SQL
serve = import_module("server-lifecycle").serve
saved = {}
endpoints = [("/dev/interfacer/designs", "GET"),
             ("/dev/interfacer/services", "GET"), ("/dev/interfacer/match", "POST")]


def checks():
    no_purchase_counts = 'SELECT (SELECT count(*) FROM "order") || \'|\' || (SELECT count(*) FROM payment) || \'|\' || (SELECT count(*) FROM interfacer_rea_receipt)'
    baseline = http.sql(no_purchase_counts)
    designs = http.curl("/dev/interfacer/designs")[0]["designs"]
    services = http.curl("/dev/interfacer/services")[0]["services"]
    assert len(designs) >= 2 and len(services) >= 3
    by_id = {d["id"]: d for d in designs}
    for path, method in endpoints:
        http.curl(path, "-X", method, "-H", "Origin: https://example.org", expected=403)
        for origin in ["http://localhost:3104", "http://localhost:3000"]:
            headers, _ = http.curl(path, "-i", "-X", "OPTIONS", "-H", "Origin: " + origin,
                                   "-H", "Access-Control-Request-Method: " + method, expected=204)
            assert "access-control-allow-origin: " + origin in headers.lower()
            assert "cache-control: no-store" in headers.lower()
    count = http.sql("SELECT count(*) FROM interfacer_build_quote")
    for body in [{}, {"designId": ""}, {"designId": 1},
                 {"designId": "ifdes_p4_organizer", "priceEUR": 0.01},
                 {"designId": "ifdes_p4_organizer", "quantity": 999}]:
        http.post("/dev/interfacer/match", body, expected=400)
    http.post("/dev/interfacer/match", {"designId": "missing-p4-design"}, expected=404)
    assert http.sql("SELECT count(*) FROM interfacer_build_quote") == count

    def match(_):
        return http.post("/dev/interfacer/match", {"designId": "ifdes_p4_organizer"})
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(match, range(4)))
    result = results[0]
    assert all(r == result for r in results)
    assert [m["service"]["id"] for m in result["matches"]] == ["ifsvc_p4_standard", "ifsvc_p4_large"]
    assert [m["quote"]["total_price_cents"] for m in result["matches"]] == [1900, 3600]
    reasons = {r["service"]["id"]: r["reason"] for r in result["rejected"]}
    for service_id, prefix in [("laser", "wrong_process:"), ("small", "too_big:"),
                               ("coarse", "tolerance:"), ("abs", "missing_material:")]:
        assert reasons["ifsvc_p4_" + service_id].startswith(prefix), reasons
    panel = http.post("/dev/interfacer/match", {"designId": "ifdes_p4_panel"})
    assert [m["service"]["id"] for m in panel["matches"]] == ["ifsvc_p4_large"]
    assert panel["matches"][0]["quote"]["total_price_cents"] == 2800
    assert len(panel["rejected"]) >= 1
    for response in [result, panel]:
        for match in response["matches"]:
            service, quote = match["service"], match["quote"]
            snapshot = quote["snapshot"]
            design = by_id[quote["design_id"]]
            assert quote["service_id"] == service["id"]
            assert quote["provider_person_id"] == service["provider_person_id"]
            assert quote["origin_dpp_id"] == design["origin_dpp_id"]
            assert snapshot["design"] == design and snapshot["service"] == service
            assert quote["currency_code"] == snapshot["currency_code"] == "eur"
            assert snapshot["quantity"] == quote["quantity"] == design["requirements"]["quantity"]
            total = round(service["base_price_eur"] * 100) + round(service["per_unit_price_eur"] * 100) * quote["quantity"]
            assert total == quote["total_price_cents"] == snapshot["total_price_cents"]
            assert snapshot["amount_eur"] == total / 100
            canonical = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            # JSON numbers 10.0 vs 10 affect hash; fixtures intentionally integer
            # or non-integer decimal JSON values, same JS/Python encoding here.
            assert hashlib.sha256(canonical.encode()).hexdigest() == quote["quote_hash"]
            assert http.sql("SELECT count(*) FROM interfacer_build_quote WHERE quote_hash='" + quote["quote_hash"] + "'") == "1"
    assert baseline == http.sql(no_purchase_counts)
    saved.update(result=result)
    http.note("PASS MATCH organizer: standard EUR 19.00, large EUR 36.00; laser wrong_process, small too_big, coarse tolerance, ABS missing_material.")
    http.note("PASS MATCH panel: large EUR 28.00 only; standard rejected for dimensions + tolerance.")
    http.note("PASS four concurrent matches: same quote IDs/hashes, one row per terms hash; no order/payment/receipt created.")


def restarted():
    assert http.post("/dev/interfacer/match", {"designId": "ifdes_p4_organizer"}) == saved["result"]
    http.note("PASS RESTART: stored immutable quote IDs, snapshots and hashes unchanged.")


def disabled():
    for path, method in endpoints:
        for verb in [method, "OPTIONS"]:
            assert http.curl(path, "-X", verb, expected=403)[0] == {"reason": "local_fixture_mode_required"}
    http.note("PASS disabled fixture mode: designs/services/match and preflights refused.")


try:
    command = ["./node_modules/.bin/medusa", "develop", "--host", "127.0.0.1", "--port", "9000", "--no-types"]
    serve(command, os.environ.copy(), "p4-server.log", checks, cwd=http.root / "medusa")
    serve(command, os.environ.copy(), "p4-server-restarted.log", restarted, cwd=http.root / "medusa")
    serve(command, {**os.environ, "INTERFACER_AUTH_MODE": "disabled"},
          "p4-server-disabled.log", disabled, cwd=http.root / "medusa")
    http.note("ALL P4 HTTP CHECKS PASSED; all server sessions stopped via per-PID signals.")
finally:
    (http.root / ".tmp/p4-transcript.md").write_text("\n".join(http.transcript))
