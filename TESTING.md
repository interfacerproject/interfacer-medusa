# Test the first slice locally

## One command

From this directory, with Docker running, **Node 24.19.0 / npm 11.17.0** (tested) and Python 3 installed:

```bash
npm test
```

No git, Compose, Redis, external Interfacer service, or payment credentials required. First install needs npm registry access; Docker needs `postgres:15-alpine`. Allow ~1 GB for dependencies/cache. Ports **55432** (Postgres) and **19000** (brief health probe) must be free.

This command starts/creates only the labeled `interfacer-medusa-spike-db` container, installs the locked dependencies if needed, typechecks, migrates, executes real Medusa workflows against Postgres, and briefly boots Medusa **2.10.3**. It prints the product/variant IDs and immutable binding, then stops the server process group and its DB container, even on test failure. Data is retained in the stopped container. Do not run it concurrently with an interactive server using this DB.

Expected ending:

```text
ALL SPIKE CHECKS PASSED (fixture controller seam; not live PDP proof)
PASS live Medusa GET /health: 200 OK
PASS finished; HTTP server and spike DB stopped (data retained).
```

On a fresh DB, the test deliberately throws **after the product workflow commits but before the mapping is saved**, then recovers that product under four concurrent retries. Subsequent runs report that fresh-DB injection was skipped and verify the same IDs. No extra product is created.

## Interactive: see the running server, projection, and mapping

Terminal 1, from this directory:

```bash
npm run setup       # npm ci (as needed), typecheck, DB migration
npm start           # foreground Medusa at http://127.0.0.1:9000
```

Terminal 2, same directory:

```bash
curl --fail http://127.0.0.1:9000/health
npm run project
npm run inspect
npm run project     # same binding/product/variant IDs; "created": false
```

`project` invokes `medusa exec ./src/scripts/project.ts` in `medusa/`. It loads the app's **interfacer module** and calls the supported **createProductsWorkflow**; this is not a mock product or direct SQL core-table insertion. `inspect` queries that module plus the native Product module and prints the stored draft and its one variant. The admin UI is deliberately disabled; no admin build or admin login is needed.

A draft has no prices, channels, shipping allocation, or sellable inventory. `manage_inventory: false` is intentional for this **unpublished, non-purchasable spike**, not a claim of unlimited stock. The source quantity is never copied.

Optional read-only SQL observation (DB must be running):

```bash
docker exec interfacer-medusa-spike-db psql -U medusa -d interfacer_medusa -c \
'SELECT b.id AS binding, b.catalog_resource_id, b.source_dpp_id, p.id AS product, p.status, v.id AS variant, b.source_snapshot_hash, b.passport_snapshot_hash FROM interfacer_listing_binding b JOIN product p ON p.id = b.medusa_product_id JOIN product_variant v ON v.id = b.medusa_variant_id;'
```

When finished: **Ctrl-C** in terminal 1, then `npm run stop`. Nothing else in Docker is stopped.

## Test from the GUI / over HTTP

**Local testing only — fixture auth, not a real PDP or signed envelope. Never deploy.**

Endpoint: **http://localhost:9000/dev/interfacer/listings**. From this directory:

```bash
npm run setup
npm start
```

Root `npm start` explicitly enables `INTERFACER_AUTH_MODE=fixture-controller-stub` and binds Medusa to loopback. It refuses a production environment before launching `medusa develop`. GET, POST and OPTIONS also independently return **403** unless fixture mode is enabled and `NODE_ENV !== "production"`. Without fixture mode, even listing is denied. Stop with **Ctrl-C**, then `npm run stop`.

- **POST** body: `{ resource: <EconomicResource>, dpp: <DPP>, actingPersonId: "<controller Person ID>" }`. Returns 201 for creation or 200 for a retry/recovery: `{ created, product_id, variant_id, status, binding }`. Calls the exact CLI `projectResource` entrypoint and `fixtureControllerCheck`; no duplicate workflow.
- **GET** returns `{ listings: [{ binding, product }] }`, including `product.variants`, using the same module reads as `inspect`. Lists all stored bindings, not only the sample.
- Errors contain `reason`: controller denial 403; invalid source/DPP parent/body 400; immutable-source conflict or reconciliation required 409. Unexpected infrastructure errors remain server errors.
- CORS allows exactly **http://localhost:3104** and **http://localhost:3000** on this dev route, including JSON POST preflights. These origins are also in `projectConfig.http.storeCors` in `medusa/medusa-config.ts`. Medusa 2.10.3's automatic CORS only handles /store, /admin and /auth, so /dev handles its own CORS with the shared allowlist. Other supplied origins get 403. No cookies, bearer token or publishable API key are needed; use fetch's default credentials mode, not `credentials: "include"`.
- **Anyone able to reach this local endpoint can impersonate a fixture controller and supply fabricated source documents.** CORS is not authentication. Do not tunnel, proxy or bind this to a public interface. No authoritative remote reads, signature verification or real identity proof are claimed.

Example GUI call (using the loaded resource and DPP objects):

```js
const response = await fetch("http://localhost:9000/dev/interfacer/listings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ resource, dpp, actingPersonId }),
})
const result = await response.json() // check response.ok; show result.reason on denial
```

### Repeatable verification

`npm test` still passes and now also invokes handler-level tests for disabled/unset/incorrect fixture mode, production, both GUI preflights, disallowed origins and malformed bodies, asserting guards never reach storage.

```bash
npm run test:http
```

This runs real **curl**, boots root `npm start`, checks projection/GET/retry/denial/invalid binding/conflict/CORS, then boots a second server with fixture mode disabled to check GET/POST/OPTIONS all return 403. It always stops its server process groups and the labeled spike DB. Do not run alongside an interactive server. Port 9000 must be free. Generated bodies, raw transcript and server logs are under `.tmp/http-*`.

The captured run below used a **fresh, separate database in the existing labeled spike container**, leaving the original CLI sample intact:

```bash
npm run setup
docker exec interfacer-medusa-spike-db createdb -U medusa interfacer_medusa_http
DATABASE_URL=postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa_http npm run test:http
```

The database is retained. To repeat against it, omit `createdb`; to test a first creation again, choose a new database name. An already-projected fixture correctly returns `created:false` on the first POST too.

To generate the exact payload files for manually replaying the curls below (the probe generates these automatically):

```bash
mkdir -p .tmp
python3 - <<'PY'
import copy, json
from pathlib import Path
resource = json.loads(Path("docs/fixtures/economic-resource.json").read_text())
dpp = json.loads(Path("docs/fixtures/dpp.json").read_text())
payload = {"resource": resource, "dpp": dpp, "actingPersonId": resource["primaryAccountable"]["id"]}
wrong = {**payload, "actingPersonId": "some-other-person"}
invalid = copy.deepcopy(payload)
invalid["dpp"]["ProductID"] = "foreign-resource"
new_denied = copy.deepcopy(wrong)
new_denied["resource"]["id"] += "-denied-http"
new_denied["dpp"]["ProductID"] = new_denied["resource"]["id"]
conflict = copy.deepcopy(payload)
conflict["resource"]["name"] = "Changed over HTTP"
for name, body in [("request", payload), ("wrong-person", wrong), ("invalid-binding", invalid),
                   ("new-denied", new_denied), ("conflict", conflict)]:
    Path(f".tmp/http-{name}.json").write_text(json.dumps(body, ensure_ascii=False) + "\n")
PY
```

### Actual curl commands and responses

Captured on 2026-10-21, Medusa **2.10.3**, Node **24.19.0**, database `interfacer_medusa_http`. Commands and response bodies below are verbatim from the successful probe, including the multiline curl write-out argument. After the no-write counts, the final three curls ran against the second server with `INTERFACER_AUTH_MODE=disabled` (direct Medusa launch, bypassing root start's explicit fixture opt-in).

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -i -X OPTIONS -H 'Origin: http://localhost:3104' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' http://localhost:9000/dev/interfacer/listings
```

```text
HTTP/1.1 204 No Content
X-Powered-By: Express
Cache-Control: no-store
Vary: Origin
Access-Control-Allow-Origin: http://localhost:3104
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Date: Wed, 21 Oct 2026 20:46:51 GMT
Connection: keep-alive
Keep-Alive: timeout=5


HTTP 204
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -i -X OPTIONS -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' http://localhost:9000/dev/interfacer/listings
```

```text
HTTP/1.1 204 No Content
X-Powered-By: Express
Cache-Control: no-store
Vary: Origin
Access-Control-Allow-Origin: http://localhost:3000
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Date: Wed, 21 Oct 2026 20:46:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5


HTTP 204
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' http://localhost:9000/dev/interfacer/listings
```

```text
{"listings":[]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-request.json http://localhost:9000/dev/interfacer/listings
```

```text
{"created":true,"product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","status":"draft","binding":{"id":"iflb_01M5G3EZPMH6Y8YWYQWGS99KT5","operation_key":"5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","catalog_resource_id":"01JTESTRESOURCE000000000001","source_dpp_id":"dpp-sample-0001","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","medusa_variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","configuration_key":"default","source_snapshot_hash":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","passport_snapshot_hash":"5cc90733600d7be0e2dbd480d848639c17560a61ec0ad010b5b381a27ff49d7a","approved_revision":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-21T20:46:52.116Z","updated_at":"2026-10-21T20:46:52.116Z","deleted_at":null}}
HTTP 201
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3000' http://localhost:9000/dev/interfacer/listings
```

```text
{"listings":[{"binding":{"id":"iflb_01M5G3EZPMH6Y8YWYQWGS99KT5","operation_key":"5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","catalog_resource_id":"01JTESTRESOURCE000000000001","source_dpp_id":"dpp-sample-0001","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","medusa_variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","configuration_key":"default","source_snapshot_hash":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","passport_snapshot_hash":"5cc90733600d7be0e2dbd480d848639c17560a61ec0ad010b5b381a27ff49d7a","approved_revision":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-21T20:46:52.116Z","updated_at":"2026-10-21T20:46:52.116Z","deleted_at":null},"product":{"id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","title":"Recycled PETG desk organizer — sample","handle":"interfacer-5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","subtitle":null,"description":null,"is_giftcard":false,"status":"draft","thumbnail":null,"weight":null,"length":null,"height":null,"width":null,"origin_country":null,"hs_code":null,"mid_code":null,"material":null,"discountable":true,"external_id":null,"metadata":{"interfacer_dpp_id":"dpp-sample-0001","interfacer_intent_id":"ifpi_01M5G3EZMMMP8E0RM5QHF3ASSX","interfacer_resource_id":"01JTESTRESOURCE000000000001"},"type_id":null,"type":null,"collection_id":null,"collection":null,"created_at":"2026-10-21T20:46:52.063Z","updated_at":"2026-10-21T20:46:52.063Z","deleted_at":null,"variants":[{"id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","title":"Default","sku":null,"barcode":null,"ean":null,"upc":null,"allow_backorder":false,"manage_inventory":false,"hs_code":null,"origin_country":null,"mid_code":null,"material":null,"weight":null,"length":null,"height":null,"width":null,"metadata":null,"variant_rank":0,"product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","created_at":"2026-10-21T20:46:52.084Z","updated_at":"2026-10-21T20:46:52.084Z","deleted_at":null}]}}]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-request.json http://localhost:9000/dev/interfacer/listings
```

```text
{"created":false,"product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","status":"draft","binding":{"id":"iflb_01M5G3EZPMH6Y8YWYQWGS99KT5","operation_key":"5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","catalog_resource_id":"01JTESTRESOURCE000000000001","source_dpp_id":"dpp-sample-0001","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","medusa_variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","configuration_key":"default","source_snapshot_hash":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","passport_snapshot_hash":"5cc90733600d7be0e2dbd480d848639c17560a61ec0ad010b5b381a27ff49d7a","approved_revision":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-21T20:46:52.116Z","updated_at":"2026-10-21T20:46:52.116Z","deleted_at":null}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-wrong-person.json http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"authorization_denied"}
HTTP 403
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-new-denied.json http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"authorization_denied"}
HTTP 403
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-invalid-binding.json http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"passport_binding_mismatch"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: http://localhost:3104' -H 'Content-Type: application/json' --data-binary @.tmp/http-conflict.json http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"idempotency_conflict: immutable source changed"}
HTTP 409
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' --data '{}' http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"invalid_body: actingPersonId must be a nonempty string (max 1000)"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Origin: https://example.org' http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"dev_origin_denied"}
HTTP 403
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' http://localhost:9000/dev/interfacer/listings
```

```text
{"listings":[{"binding":{"id":"iflb_01M5G3EZPMH6Y8YWYQWGS99KT5","operation_key":"5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","catalog_resource_id":"01JTESTRESOURCE000000000001","source_dpp_id":"dpp-sample-0001","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","medusa_variant_id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","configuration_key":"default","source_snapshot_hash":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","passport_snapshot_hash":"5cc90733600d7be0e2dbd480d848639c17560a61ec0ad010b5b381a27ff49d7a","approved_revision":"14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-21T20:46:52.116Z","updated_at":"2026-10-21T20:46:52.116Z","deleted_at":null},"product":{"id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","title":"Recycled PETG desk organizer — sample","handle":"interfacer-5db4360e10ee0cb26d9f366f90d88a38dfdb1d7a7dca45f24ea4ce20dc743ce4","subtitle":null,"description":null,"is_giftcard":false,"status":"draft","thumbnail":null,"weight":null,"length":null,"height":null,"width":null,"origin_country":null,"hs_code":null,"mid_code":null,"material":null,"discountable":true,"external_id":null,"metadata":{"interfacer_dpp_id":"dpp-sample-0001","interfacer_intent_id":"ifpi_01M5G3EZMMMP8E0RM5QHF3ASSX","interfacer_resource_id":"01JTESTRESOURCE000000000001"},"type_id":null,"type":null,"collection_id":null,"collection":null,"created_at":"2026-10-21T20:46:52.063Z","updated_at":"2026-10-21T20:46:52.063Z","deleted_at":null,"variants":[{"id":"variant_01M5G3EZNMXMKMCVVXGX8XPGYJ","title":"Default","sku":null,"barcode":null,"ean":null,"upc":null,"allow_backorder":false,"manage_inventory":false,"hs_code":null,"origin_country":null,"mid_code":null,"material":null,"weight":null,"length":null,"height":null,"width":null,"metadata":null,"variant_rank":0,"product_id":"prod_01M5G3EZMY9B601DZVBMTP4C3C","created_at":"2026-10-21T20:46:52.084Z","updated_at":"2026-10-21T20:46:52.084Z","deleted_at":null}]}}]}
HTTP 200
```

PASS denial/conflict/invalid requests wrote no rows: product|variant|binding|intent before=1|1|1|1, after=1|1|1|1.

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -X GET -H 'Origin: http://localhost:3104' http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -X POST -H 'Origin: http://localhost:3104' http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -X OPTIONS -H 'Origin: http://localhost:3104' http://localhost:9000/dev/interfacer/listings
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```


The no-write check is a read-only SQL count of all products, variants, bindings and intents, before and after all denial/invalid/conflict requests. It includes a wrong-controller POST for a previously unprojected resource, not just a denied retry. GET before/after also matched exactly.

Observed test endings:

```text
PASS HTTP handlers: fixture opt-in + production guards (GET/POST/OPTIONS), CORS, body validation; no storage access
ALL SPIKE CHECKS PASSED (fixture controller seam; not live PDP proof)
PASS live Medusa GET /health: 200 OK
PASS finished; HTTP server and spike DB stopped (data retained).
PASS HTTP projection, listing, idempotency, denial, CORS and disabled-mode guards; both server groups stopped.
```

Production startup check also executed:

```bash
NODE_ENV=production npm start
```

```text
> start
> bash scripts/spike.sh start

Refusing local fixture API in production
```

Exit status **1**. Production route refusal was tested directly at the handler level (GET/POST/OPTIONS), not by booting a production build. Cleanup verified: ports **9000** and **19000** no longer accepted connections; the spike DB container state was **exited**. No long-running server remains.

## Authorization: explicit local stub, not cryptographic proof

`medusa/src/modules/interfacer/fixture-controller-check.ts` is the deliberately named **fixture controller seam**. Root `start`/`project`/`test`/`test:http` scripts explicitly enable `INTERFACER_AUTH_MODE=fixture-controller-stub`. It compares a locally asserted Person with the resource fixture's `primaryAccountable.id`. Only that controller is allowed; seller eligibility is NOT an additional gate.

This models a PDP-returned controller attestation; it does **not prove possession of a registered key**. Anyone with local shell/DB access can impersonate the fixture Person. It is not suitable for untrusted network clients or deployment. The **guarded local-dev HTTP endpoint above** exposes this same stub for GUI testing only; there is no header identity support, no IdentityLink, and no fake Zenroom signature format. Direct `medusa exec` without opt-in fails closed; fixture mode is also rejected under `NODE_ENV=production`.

Demonstrate rejection (after setup; expect nonzero exit and no new rows):

```bash
INTERFACER_FIXTURE_PERSON=some-other-person npm run project
npm run stop
```

Acceptance tests also cover forged subject/header-like claims, mismatched DPP parent, simulated PDP failure, unsupported obligations, disabled seam, production guard, changed source/DPP hashes, concurrent retries, metadata tampering, and immutable rows. These are **seam tests**, not evidence of real PDP transport, real header handling, or cryptographic compatibility.

Live Zenflows/DPP integration is **BLOCKED/deferred**: sibling worktrees/commits were not inspected under the task constraints; no compatible commerce policy or signed-envelope transport is assumed. Next production step is authoritative remote resource reads plus registered-key verification, action/audience/body binding, nonce replay protection and online fail-closed controller decisions. Never expose the local CLI/HTTP seam outside loopback testing or treat it as production authorization.

## Inputs and authority

- `docs/fixtures/economic-resource.json`: synthetic resource with name and controller.
- `docs/fixtures/dpp.json`: synthetic passport with its own `ID` and matching `ProductID`. No fixtures existed initially.
- Title is projected; product metadata contains **only resource ID, DPP ID and projection-intent ID**. No passport sections, attachments, status, raw JSON or URLs are exposed. Passport ID is the reference; hashes stay in the module.
- `interfacer_projection_intent` durably fixes the resource, passport, controller, canonical JSON SHA-256 hashes and deterministic product handle **before** creation.
- `interfacer_listing_binding` stores product + variant IDs, original references, hashes and fixture policy evidence. Both tables belong to the integration module. DB triggers reject UPDATE/DELETE (including soft-delete), not just hidden UI fields.
- Idempotency key: SHA-256 of `["interfacer-local-v1", resource.id, "default"]`. One instance and one configuration per resource only. Reordered object keys hash identically; arrays retain order. Changing fixture content is a conflict, not an implicit refresh/rebind.
- Product metadata is not the mapping authority. Editing it cannot rebind the record; a retry with a changed reference requires reconciliation.
- Postgres advisory lock serializes the projection across processes. Unique source/product/variant keys are an additional safeguard. The native in-memory event bus/workflow engine is not used as a durability promise.

## Limits and recovery

Recovery after the **completed** product workflow/lost response was tested. If a hard process kill interrupts the workflow before it has created the variant, retry detects the incomplete product and raises `reconciliation_required`; it does not create a second product to hide it. This is not a complete saga/reconciliation UI. Do not manually rename/delete an in-flight projection's deterministic product handle; discovery of that orphan relies on it. Do not enable normal admin editing or production publishing for these demo products.

No signed HTTP operation, durable message worker, IdentityLink, stock allocation, purchase, live refresh, price, publication, payment, ledger write, or DPP/Zenflows mutation is implemented. Custom link/auth/cart/payment extension points in `docs/phase0-findings.md` were source-inspected, not end-to-end checkout-tested. Admin build was intentionally not attempted. Older pinned dependencies emit deprecation warnings; this is a local spike, not a security-reviewed deployment.

## DB and troubleshooting

Default connection: `postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa`.
Container label: `interfacer.medusa.spike=true`. Credentials are local demo credentials, bound to loopback. Data lives in the container writable layer, **not** in sibling projects or a shared DB.

`DATABASE_URL` may select another database **you create in this spike container**; scripts still start/stop this container. The checked-in `medusa/.env.example` documents defaults. Root scripts use the environment URL or the documented default rather than an edited .env URL.

- Probe details: `.tmp/server-probe.log`.
- Cache/temp/config files are confined to `.cache/` and `.tmp/`, ignored with dependencies and `medusa/.env`.
- To force a dependency reinstall: remove `.tmp/dependencies.hash`, then `npm run setup`.
- Port conflict: stop your other server on 19000/9000; never stop unrelated DB containers. Existing port 5432 is not used.
- To rerun the fresh-DB recovery test without destroying the sample database:

```bash
npm run setup
docker exec interfacer-medusa-spike-db createdb -U medusa interfacer_medusa_fresh_test
DATABASE_URL=postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa_fresh_test npm test
```

Use a new DB name each time; the test never drops data. During implementation, `interfacer_medusa_acceptance` was used for the recorded cold-DB test. Normal commands use `interfacer_medusa`.

See `docs/phase0-findings.md` for exact source/API evidence and `docs/phase0-STATUS.md` for handoff status.
