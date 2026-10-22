"""CLIENT-SIDE test support only; never imported by the server.
Real Node Ed25519 signatures using disposable local keys. SQL is read-only to
resolve the demo's immutable cart/binding facts; no invented commerce objects.
"""
import base64
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

root = Path(__file__).resolve().parent.parent
SELLER = "01JTESTPERSON00000000000001"


def sql(statement):
    database = urlparse(os.environ["DATABASE_URL"]).path.lstrip("/")
    return subprocess.check_output(["docker", "exec", os.environ["INTERFACER_DB_CONTAINER"],
        "psql", "-U", "medusa", "-d", database, "-Atc", statement], text=True).strip()


def rows(table, field, value):
    assert re.fullmatch(r"[a-z_]+", table) and re.fullmatch(r"[a-z_]+", field)
    escaped = value.replace("'", "''")
    return json.loads(sql(f"SELECT coalesce(json_agg(r), '[]') FROM {table} r WHERE {field}='{escaped}' AND deleted_at IS NULL"))


def seed_person(person):
    # Explicit test-key enrollment in a local file, not an HTTP auth bypass.
    subprocess.run(["node", "scripts/sign.cjs", "--seed-person", person], cwd=root, check=True)


def sign(op, params, person=SELLER, key_person=None):
    command = ["node", "scripts/sign.cjs", op, person, json.dumps(params, ensure_ascii=False)]
    if key_person:
        command.append(key_person)
    return json.loads(subprocess.check_output(command, cwd=root, text=True))


def header(auth):
    data = base64.urlsafe_b64encode(json.dumps(auth, ensure_ascii=False).encode()).decode().rstrip("=")
    return ["-H", "X-Interfacer-Auth: " + data]


def references(q):
    return {"design_id": q["design_id"], "service_id": q["service_id"],
        "service_provider_person_id": q["provider_person_id"], "quote_id": q["id"],
        "quote_hash": q["quote_hash"], "origin_dpp_id": q["origin_dpp_id"], "quantity": q["quantity"]}


def checkout_params(cid):
    cart = rows("cart", "id", cid)[0]
    lines = rows("cart_line_item", "cart_id", cid)
    identities = rows("interfacer_identity_link", "customer_id", cart.get("customer_id") or "")
    if not identities:
        return {"cart_id": cid}, SELLER  # negative unbound case is rejected before signature verification
    identity = identities[0]
    purchase = {"buyer_person_id": identity["person_id"], "identity_link_id": identity["id"]}
    acceptance = rows("interfacer_build_acceptance", "cart_id", cid)
    if acceptance:
        a = acceptance[0]
        q = rows("interfacer_build_quote", "id", a["quote_id"])[0]
        purchase.update(acceptance_id=a["id"], build=references(q))
    else:
        listings = []
        for line in lines:
            for b in rows("interfacer_listing_binding", "medusa_variant_id", line["variant_id"]):
                listings.append({"interfacer_dpp_id": b["source_dpp_id"], "interfacer_listing_id": b["id"],
                    "interfacer_resource_id": b["catalog_resource_id"]})
        purchase["listings"] = listings
    items = [{"variant_id": i["variant_id"], "quantity": i["quantity"], "unit_price": i["unit_price"]} for i in lines]
    items.sort(key=lambda i: i["variant_id"])
    return {"cart_id": cid, "currency_code": cart["currency_code"], "purchase": purchase, "items": items}, identity["person_id"]


def operation(path, body):
    path = path.split("?")[0]
    if path == "/dev/interfacer/listings" and isinstance(body, dict) and body.get("resource") and body.get("dpp"):
        return "commerce.listing.create", {"resource": body["resource"], "dpp": body["dpp"]}, body.get("actingPersonId", SELLER)
    match = re.fullmatch(r"/dev/interfacer/listings/([^/]+)/(publish|checkout)", path)
    if match:
        lid, action = match.groups()
        bindings = rows("interfacer_listing_binding", "id", lid)
        person = bindings[0]["seller_agent_id"] if bindings else SELLER
        if action == "publish":
            return "commerce.listing.publish", {"listing_id": lid, "priceEUR": body.get("priceEUR")}, person
        return "commerce.listing.checkout.setup", {"listing_id": lid}, person
    if path == "/dev/interfacer/build-orders" and body.get("cartId") and body.get("quoteId"):
        cart = rows("cart", "id", body["cartId"])
        identities = rows("interfacer_identity_link", "customer_id", cart[0]["customer_id"]) if cart else []
        return "commerce.order.build.purchase", {"cart_id": body["cartId"], "quote_id": body["quoteId"]}, identities[0]["person_id"] if identities else SELLER
    match = re.fullmatch(r"/dev/interfacer/(orders|build-orders)/([^/]+)/(deliver|produce)", path)
    if match:
        _, oid, action = match.groups()
        person = SELLER if action == "deliver" else "p4-demo-provider-standard"
        return "commerce.order." + action, {"order_id": oid}, person
    match = re.fullmatch(r"/store/carts/([^/]+)/complete", path)
    if match:
        params, person = checkout_params(match.group(1))
        return "commerce.order.authorize", params, person
    return None


def curl_auth(path, args):
    # Called explicitly by the test clients, never by a server route. Every POST
    # gets fresh signature material; raw negative tests can disable this helper.
    args = list(args)
    method = args[args.index("-X") + 1] if "-X" in args else "GET"
    body = {}
    for flag in ["--data", "--data-binary"]:
        if flag in args:
            value = args[args.index(flag) + 1]
            if value.startswith("@"):
                value = (root / value[1:]).read_text()
            try:
                body = json.loads(value)
            except json.JSONDecodeError:
                body = {}
            if "-X" not in args:
                method = "POST"
    if method != "POST":
        return []
    if path == "/dev/interfacer/identity" and isinstance(body, dict) and body.get("personId"):
        seed_person(body["personId"])
    resolved = operation(path, body if isinstance(body, dict) else {})
    return header(sign(*resolved)) if resolved else []
