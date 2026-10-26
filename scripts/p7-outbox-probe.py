#!/usr/bin/env python3
"""P7: live outbox fault verification against a REAL local Zenflows.

Requires `npm run dev:up` in LIVE mode with INTERFACER_ZENFLOWS_URL pointing at
scripts/zenflows-fault-proxy.cjs (default http://127.0.0.1:8100/api), which
fronts Zenflows on :8000. Real People (no fixture keys) register a design and a
service and list stock; each scenario drives a real milestone signed by the
seller/maker, injects one failure, recovers, then counts what Zenflows actually
holds for the marker.

  python3 scripts/p7-outbox-probe.py faults            # inline faults + recovery
  python3 scripts/p7-outbox-probe.py restart-prepare   # leaves a pending sync
  python3 scripts/p7-outbox-probe.py restart-verify    # after a restart: job drains it
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "scripts"))
from live_actors import build_order, c, marketplace, milestone, stock_order  # noqa: E402
PROXY = os.environ.get("FAULT_PROXY", "http://127.0.0.1:8100")
ZENFLOWS = os.environ.get("ZENFLOWS_DIRECT", "http://127.0.0.1:8000/api")
STATE = ROOT / ".tmp/p7-restart.json"


def http(url, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def fault(mode, match, times=1, delay_ms=3000):
    http(PROXY + "/__fault", {"mode": mode, "match": match, "times": times, "delay_ms": delay_ms})


def clear():
    http(PROXY + "/__fault", method="DELETE")


def writes_sent():
    return [e for e in http(PROXY + "/__fault")["log"] if e["kind"] != "read"]


def zf(query, variables=None):
    out = http(ZENFLOWS, {"query": query, "variables": variables or {}})
    assert not out.get("errors"), out
    return out["data"]


def sync_for(buyer, order_id):
    return next(s for s in buyer.call("/dev/interfacer/zenflows-sync")["syncs"] if s["order_id"] == order_id)


def receipt_for(buyer, order_id):
    return next(r for r in buyer.call("/dev/interfacer/receipts")["receipts"] if r["order_id"] == order_id)


def retry(buyer, sync_id):
    return buyer.call(f"/dev/interfacer/zenflows-sync/{sync_id}/retry", {})["sync"]


def remote(marker):
    """What Zenflows holds for this marker: resources, events by action, Processes."""
    tag = "interfacer-sync=" + marker
    nodes = [e["node"] for e in zf("""query($m: String!) { economicResources(first: 50, filter: {note: $m}) { edges { node {
        id primaryAccountable { id } previous { id note action { id } receiver { id } outputOf { id } } } } } }""",
        {"m": tag})["economicResources"]["edges"]]
    events = {}
    for n in nodes:
        for e in n["previous"]:
            if tag in (e["note"] or ""):
                events[e["id"]] = e
    by_action = {}
    for e in events.values():
        by_action.setdefault(e["action"]["id"], []).append(e)
    procs = [e["node"] for e in zf("{ processes(last: 100) { edges { node { id note finished } } } }")["processes"]["edges"]
             if tag in (e["node"]["note"] or "")]
    return nodes, by_action, procs


def assert_exactly_once(buyer, order_id, kind):
    sync = sync_for(buyer, order_id)
    assert sync["status"] == "done", sync
    nodes, events, procs = remote(sync["marker"])
    # Build: our produced resource + its transfer destination carry the marker.
    # Live stock: only the destination (the seller's own resource keeps its note).
    assert len(nodes) == (2 if kind == "build" else 1), nodes
    assert len(events.get("produce", [])) == (1 if kind == "build" else 0) and not events.get("raise"), events
    assert len(events.get("transfer", [])) == 1, events
    assert len(procs) == (1 if kind == "build" else 0), procs
    if kind == "build":
        assert events["produce"][0]["outputOf"]["id"] == procs[0]["id"] == sync["process_id"] and procs[0]["finished"]
    transfer = events["transfer"][0]
    receipt = receipt_for(buyer, order_id)
    assert receipt["zenflows_event_id"] == sync["transfer_event_id"] == transfer["id"], (receipt, sync, transfer)
    assert receipt["zenflows_sync"]["status"] == "done"
    return sync, transfer


def scenario(m, name, kind, mode, match, delay_ms=3000):
    clear()
    buyer = m["buyer"]
    order_id = build_order(m) if kind == "build" else stock_order(m, m["listings"].pop())
    fault(mode, match, delay_ms=delay_ms)
    receipt = milestone(m, kind, order_id)
    first = receipt["zenflows_sync"]
    assert first["status"] == "pending" and not receipt["zenflows_event_id"], receipt
    before = len(writes_sent())
    if mode == "down":
        again = retry(buyer, first["id"])
        assert again["status"] == "pending" and again["inflight_step"], again
        assert len(writes_sent()) == before, "inside the settle window nothing is re-sent"
        time.sleep(62)
    if mode == "late":
        again = retry(buyer, first["id"])
        assert again["status"] == "pending", again
        time.sleep(delay_ms / 1000 + 2)
    retry(buyer, first["id"])
    sync, transfer = assert_exactly_once(buyer, order_id, kind)
    print(f"PASS P7 {name}: order={order_id} first={first['inflight_step'] or '-'}/{first['last_error']} "
          f"-> done after {sync['attempts']} failed attempt(s); exactly one of each remote object; "
          f"handover {transfer['id']}", flush=True)


def faults(only=None):
    m = marketplace(stock_units=2)
    try:
        if only == "stock":
            return scenario(m, "LOST RESPONSE transfer (live stock)", "stock", "lose-response", "transfer")
        scenario(m, "LOST RESPONSE createProcess", "build", "lose-response", "createProcess")
        scenario(m, "LOST RESPONSE produce", "build", "lose-response", "produce")
        scenario(m, "LOST RESPONSE transfer", "build", "lose-response", "transfer")
        scenario(m, "REJECTED transfer", "build", "reject", "transfer")
        scenario(m, "LATE COMMIT produce", "build", "late", "produce")
        scenario(m, "ZENFLOWS DOWN produce (settle window)", "build", "down", "produce")
        scenario(m, "LOST RESPONSE transfer (live stock)", "stock", "lose-response", "transfer")
        scenario(m, "REJECTED transfer (live stock)", "stock", "reject", "transfer")
    finally:
        clear()


def restart_prepare():
    m = marketplace(stock_units=0)
    clear()
    order_id = build_order(m)
    fault("down", "*", times=1000)
    receipt = milestone(m, "build", order_id)
    assert receipt["zenflows_sync"]["status"] == "pending", receipt
    STATE.write_text(json.dumps({"order_id": order_id}))
    print(f"PREPARED P7 RESTART: order={order_id} sync pending with Zenflows down; now restart Medusa, then clear faults", flush=True)


class Operator:
    """Reads the local operator views (no login needed, loopback only)."""
    @staticmethod
    def call(path, body=None):
        return c.request(path, body)


def restart_verify():
    order_id = json.loads(STATE.read_text())["order_id"]
    buyer = Operator()
    clear()
    deadline = time.time() + 240
    while time.time() < deadline and sync_for(buyer, order_id)["status"] == "pending":
        time.sleep(5)
    sync, transfer = assert_exactly_once(buyer, order_id, "build")
    print(f"PASS P7 RESTART: order={order_id} drained by the scheduled job after a Medusa restart "
          f"({sync['attempts']} failed attempt(s)); exactly one Process/produce/transfer; handover {transfer['id']}", flush=True)


if __name__ == "__main__":
    {"faults": faults, "restart-prepare": restart_prepare, "restart-verify": restart_verify}[sys.argv[1]](*sys.argv[2:])
