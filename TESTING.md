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

`project` invokes `medusa exec ./src/scripts/project.ts` in `medusa/`. It loads the app's **interfacer module** and calls the supported **createProductsWorkflow**; this is not a mock product or direct SQL core-table insertion. `inspect` queries that module plus the native Product module and prints the current product status and its one variant (DRAFT on creation, PUBLISHED after P1). The admin UI is deliberately disabled; no admin build or admin login is needed.

A newly projected draft has no prices, channels, shipping allocation, or sellable inventory. P1 below adds explicit local price/publication; P2's separate checkout setup enables managed, one-unit inventory. Projection/publication alone still has `manage_inventory:false` and cannot complete an Interfacer checkout. The source quantity is never copied.

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

## P1 — Storefront + publish

**Implemented and runtime-verified on Medusa 2.10.3. Local demo only, not production
merchant authorization.** No checkout, inventory reservation, payment or shipment is
claimed by P1.

### Run / browse

```bash
npm run test:p1
```

The harness typechecks/migrates, boots Medusa briefly, curls seed → projection →
publish → **real Store API**, checks re-seed, three concurrent re-publishes,
re-pricing without extra rows, DRAFT invisibility on first creation, invalid
prices, CORS, disabled mode, and post-publish projection retry. It stops both
server sessions with **per-PID `os.kill`** (not `killpg`) and the labeled DB on
success or failure. It retains data and logs at `.tmp/p1-*`. Port 9000 must be
free; don't run concurrently with another command using the DB. Phase 0 probes
now share the same per-PID cleanup.

To use the original fixture manually, from this directory:

```bash
npm run seed:commerce                  # setup + seed; records context/key; stops DB
npm run project                        # reuse Phase 0 projection
PRICE_EUR=19.95 npm run publish         # defaults to original fixture binding; stops DB
# Or: LISTING_ID=iflb_... PRICE_EUR=19.95 npm run publish
npm start                              # foreground loopback server, terminal 1
```

In terminal 2:

```bash
KEY=$(node -p 'require("./.tmp/commerce-context.json").publishable_key')
REGION=$(node -p 'require("./.tmp/commerce-context.json").region_id')
CHANNEL=$(node -p 'require("./.tmp/commerce-context.json").sales_channel_id')
curl --fail --get http://127.0.0.1:9000/store/products \
  -H "x-publishable-api-key: $KEY" \
  --data-urlencode "region_id=$REGION" \
  --data-urlencode "sales_channel_id=$CHANNEL" \
  --data-urlencode 'fields=id,title,status,metadata,variants.id,variants.calculated_price.*'
```

Stop with Ctrl-C in terminal 1, then `npm run stop`.
The CLI seed + publish were also actually executed against the original Phase 0
product `prod_01M5G01XZ8CP1GXVF9JKPG0NHT`; it is now published at EUR 19.95.
Default DB key (public, local demo, **not an Admin secret**):

```text
pk_159db31b0732e00f4fbb9f70de151283fb453569927fdb298518d9c9b3ccdf51
region_id=reg_01M5GCHJK2MN9RC6Z3QN5G9J44
sales_channel_id=sc_01M5GCHJKQNMWWMC0AM0D004DV
stock_location_id=sloc_01M5GCHJKYQRH7DBMEPDBPEG6R
```

Fresh checkouts generate different IDs/keys. Use the seed response or
`.tmp/commerce-context.json`, not hardcoded IDs. The HTTP harness records its own
context in `.tmp/p1-commerce-context.json`; that file reflects whichever DB was
last tested.

For browser/GUI browsing, fetch the **same** Store API with the publishable header
from an allowed origin (`http://localhost:3104`, `:3000`, or `:8000`).
For the default DB, this browser-console example displays the resource, price
and DPP reference without a custom catalog API:

```js
const query = new URLSearchParams({
  region_id: "reg_01M5GCHJK2MN9RC6Z3QN5G9J44",
  sales_channel_id: "sc_01M5GCHJKQNMWWMC0AM0D004DV",
  fields: "id,title,metadata,variants.calculated_price.*",
})
const response = await fetch("http://localhost:9000/store/products?" + query, {
  headers: { "x-publishable-api-key": "pk_159db31b0732e00f4fbb9f70de151283fb453569927fdb298518d9c9b3ccdf51" },
})
if (!response.ok) throw new Error(await response.text())
const { products } = await response.json()
console.table(products.map(p => ({
  title: p.title,
  EUR: p.variants[0].calculated_price?.calculated_amount,
  DPP: p.metadata.interfacer_dpp_id,
})))
```

A plain browser address-bar GET has no publishable header and returns 400.
This phase verifies HTTP with real curl; it does **not** claim a driven-browser
or storefront-page test. The integrated GUI remains P6.

### Entry points and semantics

- `npm run seed:commerce` and guarded
  `POST /dev/interfacer/commerce {}` call the same seed function. They create
  one named EUR region (`de`, automatic taxes off for the demo), one named
  enabled channel, one stock location and one publishable key, linking
  key→channel and channel→location. The existing Medusa store is reused with
  EUR as its sole/default supported currency and these default IDs.
  Medusa's automatically initialized **Default Sales Channel** is left alone;
  two total channel rows in a fresh DB are not duplicate Interfacer channels.
- `POST /dev/interfacer/listings/:id/publish {"priceEUR":19.95}` uses the
  **immutable ListingBinding ID** (`iflb_...`), not the resource/product ID.
  It validates a numeric amount > 0, ≤ 1,000,000, at most two decimal places.
  Amounts are Medusa v2 **major units: 19.95 means EUR 19.95, not 1995 cents**.
  Unknown listing → 404; invalid price/body → 400; changed references or
  unexpected tiered/multi-currency pricing → 409.
- Publish seeds/repairs the context, checks the binding's product/variant and
  metadata, then uses `updateProductsWorkflow` for prices + channel + status.
  The sole existing EUR price ID is reused; same-price retry is a no-op
  (`changed:false`). The projection lock also serializes publication.
- Both dev endpoints and OPTIONS share the original route's exact fixture-mode,
  production and CORS guards. They are **local merchant seed operations**, not
  trusted customer pricing. They do not establish resource control via a
  signature. Anyone reaching this local seam can set a demo price. No Store
  route accepts this seed price; future carts must calculate prices server-side.
- Products aren't directly attached to a region in v2: a region supplies the
  EUR pricing context; product availability comes from the key's sales channel.
  Request `metadata` and `variants.calculated_price.*` explicitly, with
  `region_id`; default Store fields alone don't show this evidence.
- The binding's immutable `status:"draft"` is **creation evidence**. It is
  never rewritten to publish. Current status comes from the native product.
  Projection retries now accept a correctly bound DRAFT or PUBLISHED product.
- `manage_inventory:false` remains from Phase 0. A channel→location link is
  **not** on-hand inventory, a reservation or shipping setup. Stock enforcement,
  bound-customer checkout and payment setup are added by P2 below; fulfillment
  remains P3. Publication alone is not checkout setup.
  Do not expose this demo as a real purchasable inventory system.

### Actual curl evidence

Captured 2026-10-21 on the fresh database
`interfacer_medusa_p1_acceptance` in the same labeled isolated container.
The harness uses the existing projection on a synthetic copy with resource/DPP
IDs suffixed `-p1`, keeping its acceptance data identifiable. To generate
`.tmp/p1-request.json` manually:

```bash
mkdir -p .tmp
python3 - <<'PY'
import json
from pathlib import Path
r = json.loads(Path("docs/fixtures/economic-resource.json").read_text())
d = json.loads(Path("docs/fixtures/dpp.json").read_text())
r["id"] += "-p1"
d["ProductID"] = r["id"]
d["ID"] += "-p1"
Path(".tmp/p1-request.json").write_text(json.dumps({
    "resource": r, "dpp": d, "actingPersonId": r["primaryAccountable"]["id"]
}, ensure_ascii=False) + "\n")
PY
```

Cold test command actually run:

```bash
npm run setup
docker exec interfacer-medusa-spike-db createdb -U medusa interfacer_medusa_p1_acceptance
DATABASE_URL=postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa_p1_acceptance npm run test:p1
```

The key below belongs to **that acceptance DB**, not the default DB.
Selected verbatim commands/responses from `.tmp/p1-transcript.md` follow.

**Seed and identical re-seed:**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/dev/interfacer/commerce
```

```text
{"currency_code":"eur","store_id":"store_01M5GCQ4EFFW7CXCMHARDYD52M","region_id":"reg_01M5GCQ4WDH10B8R83JNCJ64GZ","sales_channel_id":"sc_01M5GCQ4X5BCCBBSD5P801Y0X1","stock_location_id":"sloc_01M5GCQ4XDKZPKJZDADMBMETZ4","publishable_key_id":"apk_01M5GCQ4XN0M2RXA37JXFQ223N","publishable_key":"pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/dev/interfacer/commerce
```

```text
{"currency_code":"eur","store_id":"store_01M5GCQ4EFFW7CXCMHARDYD52M","region_id":"reg_01M5GCQ4WDH10B8R83JNCJ64GZ","sales_channel_id":"sc_01M5GCQ4X5BCCBBSD5P801Y0X1","stock_location_id":"sloc_01M5GCQ4XDKZPKJZDADMBMETZ4","publishable_key_id":"apk_01M5GCQ4XN0M2RXA37JXFQ223N","publishable_key":"pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376"}
HTTP 200
```

**Project via the unchanged Phase 0 HTTP creation path:**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' --data-binary @.tmp/p1-request.json http://127.0.0.1:9000/dev/interfacer/listings
```

```text
{"created":true,"product_id":"prod_01M5GCQ579CERXK7EQ76FNK56X","variant_id":"variant_01M5GCQ57TXE0PGFW6V8FFG8F8","status":"draft","binding":{"id":"iflb_01M5GCQ58RBME1S1Q58FTJCRBM","operation_key":"82ac7af1cc728fbfe99e00856f462101af1ee0baacf5103e9b4da164bc835420","catalog_resource_id":"01JTESTRESOURCE000000000001-p1","source_dpp_id":"dpp-sample-0001-p1","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5GCQ579CERXK7EQ76FNK56X","medusa_variant_id":"variant_01M5GCQ57TXE0PGFW6V8FFG8F8","configuration_key":"default","source_snapshot_hash":"898f89949e0a8dd786addaa832cd3d7180bf40385e98da4bd4ac48072f208ad7","passport_snapshot_hash":"286a83d3e878d883429f9a1c1bab80b249086894ff43e7cd059bd4581195d2aa","approved_revision":"898f89949e0a8dd786addaa832cd3d7180bf40385e98da4bd4ac48072f208ad7","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-21T23:28:37.144Z","updated_at":"2026-10-21T23:28:37.144Z","deleted_at":null}}
HTTP 201
```

**Store API correctly hides the draft:**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376' 'http://127.0.0.1:9000/store/products?region_id=reg_01M5GCQ4WDH10B8R83JNCJ64GZ&sales_channel_id=sc_01M5GCQ4X5BCCBBSD5P801Y0X1&fields=id%2Ctitle%2Cstatus%2Cmetadata%2Cvariants.id%2Cvariants.calculated_price.%2A'
```

```text
{"products":[],"count":0,"offset":0,"limit":50}
HTTP 200
```

**Publish, then retry (one of three concurrent retries):**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{"priceEUR": 19.95}' http://127.0.0.1:9000/dev/interfacer/listings/iflb_01M5GCQ58RBME1S1Q58FTJCRBM/publish
```

```text
{"changed":true,"listing_id":"iflb_01M5GCQ58RBME1S1Q58FTJCRBM","product_id":"prod_01M5GCQ579CERXK7EQ76FNK56X","variant_id":"variant_01M5GCQ57TXE0PGFW6V8FFG8F8","status":"published","price":{"currency_code":"eur","amount":19.95},"dpp_id":"dpp-sample-0001-p1","currency_code":"eur","store_id":"store_01M5GCQ4EFFW7CXCMHARDYD52M","region_id":"reg_01M5GCQ4WDH10B8R83JNCJ64GZ","sales_channel_id":"sc_01M5GCQ4X5BCCBBSD5P801Y0X1","stock_location_id":"sloc_01M5GCQ4XDKZPKJZDADMBMETZ4","publishable_key_id":"apk_01M5GCQ4XN0M2RXA37JXFQ223N","publishable_key":"pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{"priceEUR": 19.95}' http://127.0.0.1:9000/dev/interfacer/listings/iflb_01M5GCQ58RBME1S1Q58FTJCRBM/publish
```

```text
{"changed":false,"listing_id":"iflb_01M5GCQ58RBME1S1Q58FTJCRBM","product_id":"prod_01M5GCQ579CERXK7EQ76FNK56X","variant_id":"variant_01M5GCQ57TXE0PGFW6V8FFG8F8","status":"published","price":{"currency_code":"eur","amount":19.95},"dpp_id":"dpp-sample-0001-p1","currency_code":"eur","store_id":"store_01M5GCQ4EFFW7CXCMHARDYD52M","region_id":"reg_01M5GCQ4WDH10B8R83JNCJ64GZ","sales_channel_id":"sc_01M5GCQ4X5BCCBBSD5P801Y0X1","stock_location_id":"sloc_01M5GCQ4XDKZPKJZDADMBMETZ4","publishable_key_id":"apk_01M5GCQ4XN0M2RXA37JXFQ223N","publishable_key":"pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376"}
HTTP 200
```

**Real Store catalog with calculated EUR price and DPP metadata:**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_595d69260aa5709b2ede1a1587370a7211fc92f6eed52583aab7a4da8235d376' 'http://127.0.0.1:9000/store/products?region_id=reg_01M5GCQ4WDH10B8R83JNCJ64GZ&sales_channel_id=sc_01M5GCQ4X5BCCBBSD5P801Y0X1&fields=id%2Ctitle%2Cstatus%2Cmetadata%2Cvariants.id%2Cvariants.calculated_price.%2A'
```

```text
{"products":[{"id":"prod_01M5GCQ579CERXK7EQ76FNK56X","title":"Recycled PETG desk organizer — sample","status":"published","metadata":{"interfacer_dpp_id":"dpp-sample-0001-p1","interfacer_intent_id":"ifpi_01M5GCQ56ZNVPV9TKCCVFZ30HD","interfacer_resource_id":"01JTESTRESOURCE000000000001-p1"},"variants":[{"id":"variant_01M5GCQ57TXE0PGFW6V8FFG8F8","calculated_price":{"id":"pset_01M5GCQ58BR41YWKMQ43RD095W","is_calculated_price_price_list":false,"is_calculated_price_tax_inclusive":false,"calculated_amount":19.95,"raw_calculated_amount":{"value":"19.95","precision":20},"is_original_price_price_list":false,"is_original_price_tax_inclusive":false,"original_amount":19.95,"raw_original_amount":{"value":"19.95","precision":20},"currency_code":"eur","calculated_price":{"id":"price_01M5GCQ5MF0DSVKNX8CEFCYFTX","price_list_id":null,"price_list_type":null,"min_quantity":null,"max_quantity":null},"original_price":{"id":"price_01M5GCQ5MF0DSVKNX8CEFCYFTX","price_list_id":null,"price_list_type":null,"min_quantity":null,"max_quantity":null}}}]}],"count":1,"offset":0,"limit":50}
HTTP 200
```

**Disabled-mode write refused (second server):**

```bash
curl --silent --show-error --max-time 30 --write-out '
HTTP %{http_code}
' -X POST http://127.0.0.1:9000/dev/interfacer/listings/unknown/publish
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```

Observed P1 checks:

```text
PASS re-seed: identical context/key, no new commerce rows or links.
PASS Store API hides the DRAFT resource-backed product.
PASS invalid prices, unknown binding and disallowed origin: no rows written.
PASS concurrent re-publish + re-seed: no duplicate rows, including price/link tables. {"region": 1, "sales_channel": 2, "stock_location": 1, "api_key": 1, "store_currency": 1, "product": 1, "product_variant": 1, "interfacer_listing_binding": 1, "price": 1, "price_set": 1, "product_variant_price_set": 1, "product_sales_channel": 1, "publishable_api_key_sales_channel": 1, "sales_channel_stock_location": 1}
PASS real GET /store/products: published product, EUR 19.95 calculated price, resource + DPP references; immutable binding unchanged.
PASS disabled fixture mode: seed/publish/preflight refused.
ALL P1 CHECKS PASSED; both server sessions stopped via per-PID signals.
PASS P1 finished; HTTP server and spike DB stopped (data retained).
```

Re-pricing 19.95 → 20 → 19.95 also preserved all row counts and the same
price ID. Counts include soft-deleted rows, not just active prices. The harness
can be rerun against either DB without duplicates. Also actually executed with
exit 0 after publishing the **original** Phase 0 sample:

```text
npm test
ALL SPIKE CHECKS PASSED (fixture controller seam; not live PDP proof)
PASS live Medusa GET /health: 200 OK
PASS finished; HTTP server and spike DB stopped (data retained).

npm run test:http
PASS HTTP projection, listing, idempotency, denial, CORS and disabled-mode guards; both server groups stopped.

npm run test:p1
ALL P1 CHECKS PASSED; both server sessions stopped via per-PID signals.
PASS P1 finished; HTTP server and spike DB stopped (data retained).
```

Production guards for the new handlers are also directly tested by `npm test`,
without resolving storage. This is not a production-build test.
No P1 API is blocked on 2.10.3. See [P1 source evidence](docs/phase1-findings.md).

## P2 — Identity-bound checkout

**Implemented and verified using the real Medusa 2.10.3 HTTP API and Postgres.**
Identity binding is a local resolver stand-in, not live Zenflows authentication.
No delivery/REA event, capture, carrier shipping or driven-browser test is claimed.

### Run and semantics

```bash
npm run test:p2
```

Requires port 9000 free; do not run alongside an interactive server or other DB
test. This typechecks/migrates, reuses seed → project → publish, registers and
logs in two real customers, binds one, and races two fully prepared carts for
one unit. The bound purchase must persist an order at **EUR 19.95**, a real
manual-provider payment authorization, and canonical DPP/resource references.
The unbound customer, anonymous caller and wrong authenticated actor are refused.
A supplied `unit_price` is rejected; the valid request omits any price.

Every run uses a new synthetic resource/DPP suffix and fresh customer emails.
It retains one new demo order and its stock reservation, rather than resetting
sold inventory. The DB and two sequential server sessions stop even on HTTP test
failure. Cleanup uses **per-PID signals**, not killpg. Logs/transcript/cookie jars
are `.tmp/p2-*`; keep these local (they include disposable credentials/tokens).
After the servers stop, a real `medusa exec ./src/scripts/verify-p2.ts` checks the
workflow guard with fixture mode disabled and verifies IdentityLink immutability.

Development-only entry points (same guards/CORS as P0/P1):

- `POST /dev/interfacer/identity {"customerId":"cus_...","personId":"..."}`
  creates the module-owned, one-to-one **IdentityLink**. Identical retry returns
  it unchanged. Rebinding, duplicate Person, DB update/delete/soft-delete are
  blocked. The customer must be a registered account. The Person ID is locally
  asserted, **not verified against a live service**.
- `POST /dev/interfacer/listings/:id/checkout {}` allocates exactly **one** unit
  at the existing stock location, links the variant to its inventory item,
  enables `manage_inventory:true`, disables backorders and enables the region's
  built-in **`pp_system_default`** payment provider. `:id` is an `iflb_` listing
  ID, not a product ID. Repeating setup **never restocks an existing level**.
- Both POST/OPTIONS are 403 with fixture mode disabled or in production, and
  reject disallowed origins. Allowed GUI origins remain localhost ports
  **3104 and 3000**, now also enabled for auth CORS. This is not public auth:
  anyone reaching the local binding/merchant seam can assert demo identities,
  publish a price or allocate a synthetic unit. Never expose it publicly.

Checkout calls, in order:

1. Register `/auth/customer/emailpass/register`, create `/store/customers` with
   the returned Bearer token, then login `/auth/customer/emailpass` to get the
   actor-bound token. `/auth/session` establishes the tested cookie session;
   Bearer auth is also supported by the completion middleware.
2. Create `/store/carts` with the EUR region + channel, then authenticated
   `/store/carts/:id/customer {}`. The server takes the actor from auth, never a
   client-provided customer ID. Add `/line-items {variant_id,quantity:1}`.
3. `/store/payment-collections {cart_id}`, then
   `/store/payment-collections/:id/payment-sessions
   {provider_id:"pp_system_default"}`. Amount is calculated from the cart.
4. `/store/carts/:id/complete` performs native reservation + payment
   **authorization** and returns `{type:"order",order}`. No separate Store
   authorization route/card credentials are needed. The session is `authorized`
   with `authorized_at`; the payment has `captured_at:null`.

All Store completion requests now require session/Bearer customer auth. For an
Interfacer cart, the authenticated actor must match its customer, and that
customer must have an IdentityLink. Middleware stamps canonical references into
cart/line metadata; the **always-on native workflow validate hook** checks them
against immutable integration records, quantity and inventory configuration.
The native cart→order conversion persists them. Client DPP metadata is overwritten,
not trusted. Missing identity/mapping or integration failures fail closed; the
direct native workflow is not a guest-checkout bypass. Native `not_allowed`
errors map to **HTTP 400** in 2.10.3; missing auth is 401; dev guard denial is 403.

This fixture uses **local collection, no carrier**: inventory
`requires_shipping:false`, no product shipping profile or shipping method.
This is not proof of pickup/delivery; P3 owns fulfillment and its economic event.
Inventory is still managed/reserved normally. The default locking provider is
now Postgres (`@medusajs/medusa/locking-postgres`), not in-memory. The race test
creates two carts while stock is available, then completes both concurrently:
one order, one stock error, stocked=1/reserved=1, exactly one active reservation.
Repeat completion returns the same order; sold-out add fails.

Use additive order fields
`+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*`
to retain default `items.detail`/quantity/totals relations. Selecting only a
minimal `items.quantity` does not retain the relation needed for correct totals.
Exact installed source/API names and migration-generation Node 24 workaround:
[docs/phase2-findings.md](docs/phase2-findings.md).

### Actual curl calls and responses

The selected blocks below are **verbatim** from the successful cold-DB run
(2026-10-21 UTC), not invented examples. All registration credentials/JWTs are
disposable local test data; cookies were written by the shown `/auth/session`
calls. The script's second bound cart followed the identical cart/collection/
session sequence; both completion calls were launched concurrently. Full fresh
transcript was retained in `.tmp/p2-fresh-transcript.md`; new runs generate
`.tmp/p2-transcript.md` with their own IDs. These exact fixture IDs are already
sold after the recorded test; rerun the harness for a new unit.

Cold-DB commands actually executed:

```bash
npm run setup
docker exec interfacer-medusa-spike-db createdb -U medusa interfacer_medusa_p2_acceptance
DATABASE_URL=postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa_p2_acceptance npm run test:p2
```

The test database is retained in the stopped container. Use a new DB name for
another cold migration test (or omit `createdb` to rerun with fresh fixtures in
the same DB).

#### Reused commerce seed, projection, publish and one-unit setup

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/dev/interfacer/commerce
```

```text
{"currency_code":"eur","store_id":"store_01M5GF6F08KSJ7CA44JHXGSS66","region_id":"reg_01M5GF6FQQ27E1S608N3BBGYEX","sales_channel_id":"sc_01M5GF6FR8048MY8JK3X5SYPMY","stock_location_id":"sloc_01M5GF6FRDZ3KZJSJXDMNY7GFF","publishable_key_id":"apk_01M5GF6FRKX131WV0Q69MWHG3S","publishable_key":"pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"resource": {"id": "01JTESTRESOURCE000000000001-p2-1792627909349842000", "name": "Recycled PETG desk organizer \u2014 sample", "primaryAccountable": {"id": "01JTESTPERSON00000000000001"}, "classifiedAs": ["Product"], "trackingIdentifier": "IF-SAMPLE-001", "onhandQuantity": {"hasNumericalValue": 1, "hasUnit": "unit:piece"}}, "dpp": {"ID": "dpp-sample-0001-p2-1792627909349842000", "ProductID": "01JTESTRESOURCE000000000001-p2-1792627909349842000", "Status": "draft", "ProductOverview": {"description": "PRIVATE SAMPLE: do not project passport sections"}, "Attachments": [{"id": "private-attachment-sample"}]}, "actingPersonId": "01JTESTPERSON00000000000001"}' http://127.0.0.1:9000/dev/interfacer/listings
```

```text
{"created":true,"product_id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","status":"draft","binding":{"id":"iflb_01M5GF6FW4373310729R5ZJT44","operation_key":"5594012079a3153ca9330d4b593def8fdcc2947e5a14f92f814f3248450568fe","catalog_resource_id":"01JTESTRESOURCE000000000001-p2-1792627909349842000","source_dpp_id":"dpp-sample-0001-p2-1792627909349842000","seller_agent_id":"01JTESTPERSON00000000000001","medusa_product_id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","medusa_variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","configuration_key":"default","source_snapshot_hash":"e326c7472f2c99ae18fd1e48f02dc7f654324731f84b406fec3cec356fa8b5e7","passport_snapshot_hash":"aac6993184b29afaa492a502777ff01245cd7f35c8c087898990af3877178e0e","approved_revision":"e326c7472f2c99ae18fd1e48f02dc7f654324731f84b406fec3cec356fa8b5e7","policy_version":"fixture-controller-stub-v1","permission_epoch":"fixture-0","status":"draft","created_at":"2026-10-22T00:11:56.676Z","updated_at":"2026-10-22T00:11:56.676Z","deleted_at":null}}
HTTP 201
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"priceEUR": 19.95}' http://127.0.0.1:9000/dev/interfacer/listings/iflb_01M5GF6FW4373310729R5ZJT44/publish
```

```text
{"changed":true,"listing_id":"iflb_01M5GF6FW4373310729R5ZJT44","product_id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","status":"published","price":{"currency_code":"eur","amount":19.95},"dpp_id":"dpp-sample-0001-p2-1792627909349842000","currency_code":"eur","store_id":"store_01M5GF6F08KSJ7CA44JHXGSS66","region_id":"reg_01M5GF6FQQ27E1S608N3BBGYEX","sales_channel_id":"sc_01M5GF6FR8048MY8JK3X5SYPMY","stock_location_id":"sloc_01M5GF6FRDZ3KZJSJXDMNY7GFF","publishable_key_id":"apk_01M5GF6FRKX131WV0Q69MWHG3S","publishable_key":"pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/dev/interfacer/listings/iflb_01M5GF6FW4373310729R5ZJT44/checkout
```

```text
{"currency_code":"eur","store_id":"store_01M5GF6F08KSJ7CA44JHXGSS66","region_id":"reg_01M5GF6FQQ27E1S608N3BBGYEX","sales_channel_id":"sc_01M5GF6FR8048MY8JK3X5SYPMY","stock_location_id":"sloc_01M5GF6FRDZ3KZJSJXDMNY7GFF","publishable_key_id":"apk_01M5GF6FRKX131WV0Q69MWHG3S","publishable_key":"pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5","inventory_item_id":"iitem_01M5GF6G179WYHAC207PFACKV2","payment_provider_id":"pp_system_default"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' 'http://127.0.0.1:9000/store/payment-providers?region_id=reg_01M5GF6FQQ27E1S608N3BBGYEX'
```

```text
{"payment_providers":[{"id":"pp_system_default","is_enabled":true}],"count":1,"offset":0,"limit":20}
HTTP 200
```

#### Bound registration → customer → login → session

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"email": "p2-bound-1792627909349842000@example.test", "password": "P2-local-test-password-123!"}' http://127.0.0.1:9000/auth/customer/emailpass/register
```

```text
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6IiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkc3RTVNUUdUWVNER0pXM0JDOTAiLCJhcHBfbWV0YWRhdGEiOnt9LCJpYXQiOjE3OTI2Mjc5MTcsImV4cCI6MTc5MjcxNDMxN30.IxVWttVC6korVm8sHDYwmFT4RD3J2YDcdndVbxIOgec"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6IiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkc3RTVNUUdUWVNER0pXM0JDOTAiLCJhcHBfbWV0YWRhdGEiOnt9LCJpYXQiOjE3OTI2Mjc5MTcsImV4cCI6MTc5MjcxNDMxN30.IxVWttVC6korVm8sHDYwmFT4RD3J2YDcdndVbxIOgec' -H 'Content-Type: application/json' -X POST --data '{"email": "p2-bound-1792627909349842000@example.test", "first_name": "bound"}' http://127.0.0.1:9000/store/customers
```

```text
{"customer":{"id":"cus_01M5GF6G89336KFXTB0Z9J3P72","email":"p2-bound-1792627909349842000@example.test","company_name":null,"first_name":"bound","last_name":null,"phone":null,"metadata":null,"has_account":true,"deleted_at":null,"created_at":"2026-10-22T00:11:57.065Z","updated_at":"2026-10-22T00:11:57.065Z","addresses":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"email": "p2-bound-1792627909349842000@example.test", "password": "P2-local-test-password-123!"}' http://127.0.0.1:9000/auth/customer/emailpass
```

```text
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6ImN1c18wMU01R0Y2Rzg5MzM2S0ZYVEIwWjlKM1A3MiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkc3RTVNUUdUWVNER0pXM0JDOTAiLCJhcHBfbWV0YWRhdGEiOnsiY3VzdG9tZXJfaWQiOiJjdXNfMDFNNUdGNkc4OTMzNktGWFRCMFo5SjNQNzIifSwiaWF0IjoxNzkyNjI3OTE3LCJleHAiOjE3OTI3MTQzMTd9.NyhWNlBP80hC6aMaJEVoS6DX1dnBCZVBpmtASkTxd_s"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6ImN1c18wMU01R0Y2Rzg5MzM2S0ZYVEIwWjlKM1A3MiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkc3RTVNUUdUWVNER0pXM0JDOTAiLCJhcHBfbWV0YWRhdGEiOnsiY3VzdG9tZXJfaWQiOiJjdXNfMDFNNUdGNkc4OTMzNktGWFRCMFo5SjNQNzIifSwiaWF0IjoxNzkyNjI3OTE3LCJleHAiOjE3OTI3MTQzMTd9.NyhWNlBP80hC6aMaJEVoS6DX1dnBCZVBpmtASkTxd_s' -c .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/auth/session
```

```text
{"user":{"actor_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","actor_type":"customer","auth_identity_id":"authid_01M5GF6G7E5MQGTYSDGJW3BC90","app_metadata":{"customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72"},"iat":1792627917,"exp":1792714317}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies 'http://127.0.0.1:9000/store/customers/me?fields=id,email'
```

```text
{"customer":{"id":"cus_01M5GF6G89336KFXTB0Z9J3P72","email":"p2-bound-1792627909349842000@example.test"}}
HTTP 200
```

#### Unbound account uses the same real auth flow (registration and customer shown)

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"email": "p2-unbound-1792627909349842000@example.test", "password": "P2-local-test-password-123!"}' http://127.0.0.1:9000/auth/customer/emailpass/register
```

```text
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6IiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkdGVFcyUUpFNjkxS0tDTUhTSlgiLCJhcHBfbWV0YWRhdGEiOnt9LCJpYXQiOjE3OTI2Mjc5MTcsImV4cCI6MTc5MjcxNDMxN30._ShrCl_ytCI2I1UTYMzXzzgbRf63TY0j-hjHJXOh5b4"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6IiIsImFjdG9yX3R5cGUiOiJjdXN0b21lciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFNNUdGNkdGVFcyUUpFNjkxS0tDTUhTSlgiLCJhcHBfbWV0YWRhdGEiOnt9LCJpYXQiOjE3OTI2Mjc5MTcsImV4cCI6MTc5MjcxNDMxN30._ShrCl_ytCI2I1UTYMzXzzgbRf63TY0j-hjHJXOh5b4' -H 'Content-Type: application/json' -X POST --data '{"email": "p2-unbound-1792627909349842000@example.test", "first_name": "unbound"}' http://127.0.0.1:9000/store/customers
```

```text
{"customer":{"id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","email":"p2-unbound-1792627909349842000@example.test","company_name":null,"first_name":"unbound","last_name":null,"phone":null,"metadata":null,"has_account":true,"deleted_at":null,"created_at":"2026-10-22T00:11:57.329Z","updated_at":"2026-10-22T00:11:57.329Z","addresses":[]}}
HTTP 200
```

#### Bind the buyer; retry is identical; rebind is refused

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"customerId": "cus_01M5GF6G89336KFXTB0Z9J3P72", "personId": "p2-person-1792627909349842000"}' http://127.0.0.1:9000/dev/interfacer/identity
```

```text
{"identity_link":{"id":"ifid_01M5GF6GMM8E7EVQB0RVJ5095K","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","person_id":"p2-person-1792627909349842000","created_at":"2026-10-22T00:11:57.460Z","updated_at":"2026-10-22T00:11:57.460Z","deleted_at":null}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"customerId": "cus_01M5GF6G89336KFXTB0Z9J3P72", "personId": "p2-person-1792627909349842000"}' http://127.0.0.1:9000/dev/interfacer/identity
```

```text
{"identity_link":{"id":"ifid_01M5GF6GMM8E7EVQB0RVJ5095K","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","person_id":"p2-person-1792627909349842000","created_at":"2026-10-22T00:11:57.460Z","updated_at":"2026-10-22T00:11:57.460Z","deleted_at":null}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{"customerId": "cus_01M5GF6G89336KFXTB0Z9J3P72", "personId": "different-person"}' http://127.0.0.1:9000/dev/interfacer/identity
```

```text
{"type":"not_allowed","message":"identity_rebind_forbidden"}
HTTP 400
```

#### Unbound cart, native calculated price and refusal

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"region_id": "reg_01M5GF6FQQ27E1S608N3BBGYEX", "sales_channel_id": "sc_01M5GF6FR8048MY8JK3X5SYPMY", "email": "p2-unbound-1792627909349842000@example.test", "shipping_address": {"first_name": "Local", "last_name": "Test", "address_1": "Teststrasse 1", "city": "Berlin", "postal_code": "10115", "country_code": "de"}}' 'http://127.0.0.1:9000/store/carts?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6GT0YX243EH5R8GYXAYE","customer_id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","currency_code":"eur","total":0,"items":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{}' 'http://127.0.0.1:9000/store/carts/cart_01M5GF6GT0YX243EH5R8GYXAYE/customer?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6GT0YX243EH5R8GYXAYE","customer_id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","currency_code":"eur","total":0,"items":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"variant_id": "variant_01M5GF6FVAHGE3PD3R2Y2E0CP0", "quantity": 1, "unit_price": 0.01}' http://127.0.0.1:9000/store/carts/cart_01M5GF6GT0YX243EH5R8GYXAYE/line-items
```

```text
{"type":"invalid_data","message":"Invalid request: Unrecognized fields: 'unit_price'"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"variant_id": "variant_01M5GF6FVAHGE3PD3R2Y2E0CP0", "quantity": 1, "metadata": {"interfacer_dpp_id": "forged-passport"}}' 'http://127.0.0.1:9000/store/carts/cart_01M5GF6GT0YX243EH5R8GYXAYE/line-items?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6GT0YX243EH5R8GYXAYE","customer_id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","currency_code":"eur","total":0,"items":[{"id":"cali_01M5GF6GZYNP0SSYAJ3VJGBVQ4","variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","unit_price":19.95,"metadata":{"interfacer_dpp_id":"forged-passport"}}]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"cart_id": "cart_01M5GF6GT0YX243EH5R8GYXAYE"}' http://127.0.0.1:9000/store/payment-collections
```

```text
{"payment_collection":{"id":"pay_col_01M5GF6H2ZJTFSJNF9MYC2XM6M","currency_code":"eur","amount":19.95,"payment_sessions":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"provider_id": "pp_system_default"}' http://127.0.0.1:9000/store/payment-collections/pay_col_01M5GF6H2ZJTFSJNF9MYC2XM6M/payment-sessions
```

```text
{"payment_collection":{"id":"pay_col_01M5GF6H2ZJTFSJNF9MYC2XM6M","currency_code":"eur","amount":19.95,"payment_sessions":[{"id":"payses_01M5GF6H47EEHHFH618XZRKTNS","currency_code":"eur","provider_id":"pp_system_default","data":{},"context":{"customer":{"id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","email":"p2-unbound-1792627909349842000@example.test","phone":null,"metadata":null,"addresses":[],"last_name":null,"first_name":"unbound","company_name":null,"account_holders":[]},"account_holder":{"id":"acchld_01M5GF6H3Z968MRJ21CM4ES54Q","data":{},"email":"p2-unbound-1792627909349842000@example.test","metadata":null,"created_at":"2026-10-22T00:11:57.951Z","deleted_at":null,"updated_at":"2026-10-22T00:11:57.951Z","external_id":"cus_01M5GF6GGGDD02GKA3MEBNW5VT","provider_id":"pp_system_default"}},"status":"pending","authorized_at":null,"payment_collection_id":"pay_col_01M5GF6H2ZJTFSJNF9MYC2XM6M","metadata":{},"raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:57.959Z","updated_at":"2026-10-22T00:11:57.959Z","deleted_at":null,"amount":19.95}]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/store/carts/cart_01M5GF6GT0YX243EH5R8GYXAYE/complete
```

```text
{"type":"not_allowed","message":"interfacer_bound_customer_required"}
HTTP 400
```

#### Bound cart, server price and pending payment session

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{"region_id": "reg_01M5GF6FQQ27E1S608N3BBGYEX", "sales_channel_id": "sc_01M5GF6FR8048MY8JK3X5SYPMY", "email": "p2-bound-1792627909349842000@example.test", "shipping_address": {"first_name": "Local", "last_name": "Test", "address_1": "Teststrasse 1", "city": "Berlin", "postal_code": "10115", "country_code": "de"}}' 'http://127.0.0.1:9000/store/carts?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6HCHRNX0TAZ6W0VXC8FF","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","currency_code":"eur","total":0,"items":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{}' 'http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/customer?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6HCHRNX0TAZ6W0VXC8FF","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","currency_code":"eur","total":0,"items":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{"variant_id": "variant_01M5GF6FVAHGE3PD3R2Y2E0CP0", "quantity": 1, "unit_price": 0.01}' http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/line-items
```

```text
{"type":"invalid_data","message":"Invalid request: Unrecognized fields: 'unit_price'"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{"variant_id": "variant_01M5GF6FVAHGE3PD3R2Y2E0CP0", "quantity": 1, "metadata": {"interfacer_dpp_id": "forged-passport"}}' 'http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/line-items?fields=id%2Ccustomer_id%2Ccurrency_code%2Ctotal%2Citems.id%2Citems.variant_id%2Citems.unit_price%2Citems.metadata'
```

```text
{"cart":{"id":"cart_01M5GF6HCHRNX0TAZ6W0VXC8FF","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","currency_code":"eur","total":0,"items":[{"id":"cali_01M5GF6HGWPG21512XZR31F72V","variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","unit_price":19.95,"metadata":{"interfacer_dpp_id":"forged-passport"}}]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{"cart_id": "cart_01M5GF6HCHRNX0TAZ6W0VXC8FF"}' http://127.0.0.1:9000/store/payment-collections
```

```text
{"payment_collection":{"id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","currency_code":"eur","amount":19.95,"payment_sessions":[]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -H 'Content-Type: application/json' -X POST --data '{"provider_id": "pp_system_default"}' http://127.0.0.1:9000/store/payment-collections/pay_col_01M5GF6HKB13QZW63VB1DC3J1F/payment-sessions
```

```text
{"payment_collection":{"id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","currency_code":"eur","amount":19.95,"payment_sessions":[{"id":"payses_01M5GF6HMEMRSHEJ41NYDBEFE9","currency_code":"eur","provider_id":"pp_system_default","data":{},"context":{"customer":{"id":"cus_01M5GF6G89336KFXTB0Z9J3P72","email":"p2-bound-1792627909349842000@example.test","phone":null,"metadata":null,"addresses":[],"last_name":null,"first_name":"bound","company_name":null,"account_holders":[]},"account_holder":{"id":"acchld_01M5GF6HM8CN7Z574R9KKJFX2W","data":{},"email":"p2-bound-1792627909349842000@example.test","metadata":null,"created_at":"2026-10-22T00:11:58.472Z","deleted_at":null,"updated_at":"2026-10-22T00:11:58.472Z","external_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","provider_id":"pp_system_default"}},"status":"pending","authorized_at":null,"payment_collection_id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","metadata":{},"raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.478Z","updated_at":"2026-10-22T00:11:58.478Z","deleted_at":null,"amount":19.95}]}}
HTTP 200
```

#### Anonymous/wrong-actor refusals and concurrent completion outcomes

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/complete
```

```text
{"message":"Unauthorized"}
HTTP 401
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/complete
```

```text
{"type":"not_allowed","message":"interfacer_cart_customer_mismatch"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -X POST 'http://127.0.0.1:9000/store/carts/cart_01M5GF6HCHRNX0TAZ6W0VXC8FF/complete?fields=%2Bcustomer_id%2C%2Bmetadata%2C%2Bitems.metadata%2C%2Bpayment_collections.payments.%2A%2C%2Bpayment_collections.payment_sessions.%2A'
```

```text
{"type":"order","order":{"id":"order_01M5GF6J0EYF4ARE5J6XJKG0AA","status":"pending","summary":{"paid_total":0,"raw_paid_total":{"value":"0","precision":20},"refunded_total":0,"accounting_total":19.95,"credit_line_total":0,"transaction_total":0,"pending_difference":19.95,"raw_refunded_total":{"value":"0","precision":20},"current_order_total":19.95,"original_order_total":19.95,"raw_accounting_total":{"value":"19.95","precision":20},"raw_credit_line_total":{"value":"0","precision":20},"raw_transaction_total":{"value":"0","precision":20},"raw_pending_difference":{"value":"19.95","precision":20},"raw_current_order_total":{"value":"19.95","precision":20},"raw_original_order_total":{"value":"19.95","precision":20}},"currency_code":"eur","display_id":2,"region_id":"reg_01M5GF6FQQ27E1S608N3BBGYEX","email":"p2-bound-1792627909349842000@example.test","total":19.95,"subtotal":19.95,"tax_total":0,"discount_total":0,"discount_subtotal":0,"discount_tax_total":0,"original_total":19.95,"original_subtotal":19.95,"original_tax_total":0,"item_total":19.95,"item_subtotal":19.95,"item_tax_total":0,"original_item_total":19.95,"original_item_subtotal":19.95,"original_item_tax_total":0,"shipping_total":0,"shipping_subtotal":0,"shipping_tax_total":0,"original_shipping_tax_total":0,"original_shipping_subtotal":0,"original_shipping_total":0,"credit_line_total":0,"credit_line_subtotal":0,"credit_line_tax_total":0,"created_at":"2026-10-22T00:11:58.862Z","updated_at":"2026-10-22T00:11:58.862Z","customer_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","metadata":{"interfacer_purchase":{"listings":[{"interfacer_dpp_id":"dpp-sample-0001-p2-1792627909349842000","interfacer_listing_id":"iflb_01M5GF6FW4373310729R5ZJT44","interfacer_resource_id":"01JTESTRESOURCE000000000001-p2-1792627909349842000"}],"buyer_person_id":"p2-person-1792627909349842000","identity_link_id":"ifid_01M5GF6GMM8E7EVQB0RVJ5095K"}},"items":[{"id":"ordli_01M5GF6J0E19746YY75K3CNVF0","title":"Recycled PETG desk organizer — sample","subtitle":"Default","thumbnail":null,"variant_id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","product_id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","product_title":"Recycled PETG desk organizer — sample","product_description":null,"product_subtitle":null,"product_type":null,"product_type_id":null,"product_collection":null,"product_handle":"interfacer-5594012079a3153ca9330d4b593def8fdcc2947e5a14f92f814f3248450568fe","variant_sku":null,"variant_barcode":null,"variant_title":"Default","variant_option_values":null,"requires_shipping":false,"is_giftcard":false,"is_discountable":true,"is_tax_inclusive":false,"is_custom_price":false,"metadata":{"interfacer_dpp_id":"dpp-sample-0001-p2-1792627909349842000","interfacer_listing_id":"iflb_01M5GF6FW4373310729R5ZJT44","interfacer_resource_id":"01JTESTRESOURCE000000000001-p2-1792627909349842000"},"raw_compare_at_unit_price":null,"raw_unit_price":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.863Z","updated_at":"2026-10-22T00:11:58.863Z","deleted_at":null,"tax_lines":[],"adjustments":[],"compare_at_unit_price":null,"unit_price":19.95,"quantity":1,"raw_quantity":{"value":"1","precision":20},"detail":{"id":"orditem_01M5GF6J0EER163SY3HEKX3E7R","version":1,"metadata":null,"order_id":"order_01M5GF6J0EYF4ARE5J6XJKG0AA","raw_unit_price":null,"raw_compare_at_unit_price":null,"raw_quantity":{"value":"1","precision":20},"raw_fulfilled_quantity":{"value":"0","precision":20},"raw_delivered_quantity":{"value":"0","precision":20},"raw_shipped_quantity":{"value":"0","precision":20},"raw_return_requested_quantity":{"value":"0","precision":20},"raw_return_received_quantity":{"value":"0","precision":20},"raw_return_dismissed_quantity":{"value":"0","precision":20},"raw_written_off_quantity":{"value":"0","precision":20},"created_at":"2026-10-22T00:11:58.863Z","updated_at":"2026-10-22T00:11:58.863Z","deleted_at":null,"item_id":"ordli_01M5GF6J0E19746YY75K3CNVF0","unit_price":null,"compare_at_unit_price":null,"quantity":1,"fulfilled_quantity":0,"delivered_quantity":0,"shipped_quantity":0,"return_requested_quantity":0,"return_received_quantity":0,"return_dismissed_quantity":0,"written_off_quantity":0},"subtotal":19.95,"total":19.95,"original_subtotal":19.95,"original_total":19.95,"discount_subtotal":0,"discount_tax_total":0,"discount_total":0,"tax_total":0,"original_tax_total":0,"refundable_total_per_unit":19.95,"refundable_total":19.95,"fulfilled_total":0,"shipped_total":0,"return_requested_total":0,"return_received_total":0,"return_dismissed_total":0,"write_off_total":0,"raw_subtotal":{"value":"19.95","precision":20},"raw_total":{"value":"19.95","precision":20},"raw_original_subtotal":{"value":"19.95","precision":20},"raw_original_total":{"value":"19.95","precision":20},"raw_discount_subtotal":{"value":"0","precision":20},"raw_discount_tax_total":{"value":"0","precision":20},"raw_discount_total":{"value":"0","precision":20},"raw_tax_total":{"value":"0","precision":20},"raw_original_tax_total":{"value":"0","precision":20},"raw_refundable_total_per_unit":{"value":"19.95","precision":20},"raw_refundable_total":{"value":"19.95","precision":20},"raw_fulfilled_total":{"value":"0","precision":20},"raw_shipped_total":{"value":"0","precision":20},"raw_return_requested_total":{"value":"0","precision":20},"raw_return_received_total":{"value":"0","precision":20},"raw_return_dismissed_total":{"value":"0","precision":20},"raw_write_off_total":{"value":"0","precision":20},"variant":{"id":"variant_01M5GF6FVAHGE3PD3R2Y2E0CP0","title":"Default","sku":null,"barcode":null,"ean":null,"upc":null,"allow_backorder":false,"manage_inventory":true,"hs_code":null,"origin_country":null,"mid_code":null,"material":null,"weight":null,"length":null,"height":null,"width":null,"metadata":null,"variant_rank":0,"product_id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","product":{"id":"prod_01M5GF6FTV41ZEW5KZ574FFNKM","title":"Recycled PETG desk organizer — sample","handle":"interfacer-5594012079a3153ca9330d4b593def8fdcc2947e5a14f92f814f3248450568fe","subtitle":null,"description":null,"is_giftcard":false,"status":"published","thumbnail":null,"weight":null,"length":null,"height":null,"width":null,"origin_country":null,"hs_code":null,"mid_code":null,"material":null,"discountable":true,"external_id":null,"metadata":{"interfacer_dpp_id":"dpp-sample-0001-p2-1792627909349842000","interfacer_intent_id":"ifpi_01M5GF6FTCBG2A3GQYQAPM41TA","interfacer_resource_id":"01JTESTRESOURCE000000000001-p2-1792627909349842000"},"type_id":null,"type":null,"collection_id":null,"collection":null,"created_at":"2026-10-22T00:11:56.636Z","updated_at":"2026-10-22T00:11:56.754Z","deleted_at":null},"created_at":"2026-10-22T00:11:56.650Z","updated_at":"2026-10-22T00:11:56.650Z","deleted_at":null}}],"credit_lines":[],"shipping_address":{"id":"ordaddr_01M5GF6J0EABP5F1PP0BXJQWAQ","customer_id":null,"company":null,"first_name":"Local","last_name":"Test","address_1":"Teststrasse 1","address_2":null,"city":"Berlin","country_code":"de","province":null,"postal_code":"10115","phone":null,"metadata":null,"created_at":"2026-10-22T00:11:58.225Z","updated_at":"2026-10-22T00:11:58.225Z","deleted_at":null},"shipping_methods":[],"payment_collections":[{"id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","currency_code":"eur","completed_at":null,"status":"authorized","metadata":null,"raw_amount":{"value":"19.95","precision":20},"raw_authorized_amount":{"value":"19.95","precision":20},"raw_captured_amount":{"value":"0","precision":20},"raw_refunded_amount":{"value":"0","precision":20},"created_at":"2026-10-22T00:11:58.443Z","updated_at":"2026-10-22T00:11:58.948Z","deleted_at":null,"payment_sessions":[{"id":"payses_01M5GF6HMEMRSHEJ41NYDBEFE9","currency_code":"eur","provider_id":"pp_system_default","data":{},"context":{"customer":{"id":"cus_01M5GF6G89336KFXTB0Z9J3P72","email":"p2-bound-1792627909349842000@example.test","phone":null,"metadata":null,"addresses":[],"last_name":null,"first_name":"bound","company_name":null,"account_holders":[]},"account_holder":{"id":"acchld_01M5GF6HM8CN7Z574R9KKJFX2W","data":{},"email":"p2-bound-1792627909349842000@example.test","metadata":null,"created_at":"2026-10-22T00:11:58.472Z","deleted_at":null,"updated_at":"2026-10-22T00:11:58.472Z","external_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","provider_id":"pp_system_default"}},"status":"authorized","authorized_at":"2026-10-22T00:11:58.931Z","payment_collection_id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","payment":{"id":"pay_01M5GF6J2Q8PMHNWB3F0EJ66JT","currency_code":"eur","provider_id":"pp_system_default","data":{},"metadata":null,"captured_at":null,"canceled_at":null,"payment_collection_id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.935Z","updated_at":"2026-10-22T00:11:58.935Z","deleted_at":null,"payment_session_id":"payses_01M5GF6HMEMRSHEJ41NYDBEFE9","amount":19.95},"metadata":{},"raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.478Z","updated_at":"2026-10-22T00:11:58.935Z","deleted_at":null,"amount":19.95}],"payments":[{"id":"pay_01M5GF6J2Q8PMHNWB3F0EJ66JT","currency_code":"eur","provider_id":"pp_system_default","data":{},"metadata":null,"captured_at":null,"canceled_at":null,"payment_collection_id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","payment_session":{"id":"payses_01M5GF6HMEMRSHEJ41NYDBEFE9","currency_code":"eur","provider_id":"pp_system_default","data":{},"context":{"customer":{"id":"cus_01M5GF6G89336KFXTB0Z9J3P72","email":"p2-bound-1792627909349842000@example.test","phone":null,"metadata":null,"addresses":[],"last_name":null,"first_name":"bound","company_name":null,"account_holders":[]},"account_holder":{"id":"acchld_01M5GF6HM8CN7Z574R9KKJFX2W","data":{},"email":"p2-bound-1792627909349842000@example.test","metadata":null,"created_at":"2026-10-22T00:11:58.472Z","deleted_at":null,"updated_at":"2026-10-22T00:11:58.472Z","external_id":"cus_01M5GF6G89336KFXTB0Z9J3P72","provider_id":"pp_system_default"}},"status":"authorized","authorized_at":"2026-10-22T00:11:58.931Z","payment_collection_id":"pay_col_01M5GF6HKB13QZW63VB1DC3J1F","metadata":{},"raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.478Z","updated_at":"2026-10-22T00:11:58.935Z","deleted_at":null,"amount":19.95},"raw_amount":{"value":"19.95","precision":20},"created_at":"2026-10-22T00:11:58.935Z","updated_at":"2026-10-22T00:11:58.935Z","deleted_at":null,"payment_session_id":"payses_01M5GF6HMEMRSHEJ41NYDBEFE9","amount":19.95}],"amount":19.95,"authorized_amount":19.95,"captured_amount":0,"refunded_amount":0}]}}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-bound.cookies -X POST 'http://127.0.0.1:9000/store/carts/cart_01M5GF6HNFD6YY6PR4ZT8VM2KE/complete?fields=%2Bcustomer_id%2C%2Bmetadata%2C%2Bitems.metadata%2C%2Bpayment_collections.payments.%2A%2C%2Bpayment_collections.payment_sessions.%2A'
```

```text
{"type":"not_allowed","message":"Not enough stock available for item iitem_01M5GF6G179WYHAC207PFACKV2 at location sloc_01M5GF6FRDZ3KZJSJXDMNY7GFF"}
HTTP 400
```

#### Re-seed after sale, sold-out add, disabled identity route

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -H 'Content-Type: application/json' -X POST --data '{}' http://127.0.0.1:9000/dev/interfacer/listings/iflb_01M5GF6FW4373310729R5ZJT44/checkout
```

```text
{"currency_code":"eur","store_id":"store_01M5GF6F08KSJ7CA44JHXGSS66","region_id":"reg_01M5GF6FQQ27E1S608N3BBGYEX","sales_channel_id":"sc_01M5GF6FR8048MY8JK3X5SYPMY","stock_location_id":"sloc_01M5GF6FRDZ3KZJSJXDMNY7GFF","publishable_key_id":"apk_01M5GF6FRKX131WV0Q69MWHG3S","publishable_key":"pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5","inventory_item_id":"iitem_01M5GF6G179WYHAC207PFACKV2","payment_provider_id":"pp_system_default"}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'x-publishable-api-key: pk_70065e0231fab1bd30fe14c8507a2ae86da5a76c99abc06b3144a30c4ce417d5' -b .tmp/p2-unbound.cookies -H 'Content-Type: application/json' -X POST --data '{"variant_id": "variant_01M5GF6FVAHGE3PD3R2Y2E0CP0", "quantity": 1}' http://127.0.0.1:9000/store/carts/cart_01M5GF6GT0YX243EH5R8GYXAYE/line-items
```

```text
{"code":"insufficient_inventory","type":"not_allowed","message":"Some variant does not have the required inventory"}
HTTP 400
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -X POST http://127.0.0.1:9000/dev/interfacer/identity
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```

### Actual assertions and regression results

```text
PASS real customer registration, emailpass login, session cookie, immutable one-to-one IdentityLink and dev CORS guards.
PASS UNBOUND customer refused before order/payment authorization/reservation; no order or stock writes.
PASS PURCHASE order=order_01M5GF6J0EYF4ARE5J6XJKG0AA: EUR 19.95 server price (client 0.01 rejected), canonical DPP/resource line metadata, manual payment authorized (not captured).
PASS NO DOUBLE SELL: two ready carts completed concurrently => one order, one inventory refusal; exactly one reservation, stocked=1 reserved=1; repeat complete returns same order; re-seed does not restock.
PASS disabled fixture mode: identity/checkout seed/preflight refused.
PASS direct completeCartWorkflow (fixture mode disabled) refuses UNBOUND; no order, authorization or cart completion; IdentityLink DB update/soft-delete blocked.
ALL P2 CHECKS PASSED; both server sessions stopped via per-PID signals.
PASS P2 finished; HTTP server and spike DB stopped (data retained).
```

The concurrent loser returned native stock error 400, not a second order.
Read-only SQL in the harness asserts the active order count increased by exactly
one, the item's `inventory_level` is `1|1` (stocked|reserved), and exactly one
active `reservation_item` exists. An authenticated Store order GET asserts the
persisted DPP/resource metadata; completion retry returns the same order ID.

Also executed against the existing default DB after adding P2 (all exit 0):

```text
npm test
ALL SPIKE CHECKS PASSED (fixture controller seam; not live PDP proof)
PASS live Medusa GET /health: 200 OK
PASS finished; HTTP server and spike DB stopped (data retained).

npm run test:http
PASS HTTP projection, listing, idempotency, denial, CORS and disabled-mode guards; both server groups stopped.

npm run test:p1
ALL P1 CHECKS PASSED; both server sessions stopped via per-PID signals.
PASS P1 finished; HTTP server and spike DB stopped (data retained).
```

P2 also passed repeatedly against the default DB. Final run log:
`.tmp/p2-final.log`. The new dev handlers' production/disabled/CORS guards are
included in `npm test` without storage access. No production-build or driven
browser test is claimed; the verified APIs are available for the P6 GUI.

## Authorization: explicit local stub, not cryptographic proof

`medusa/src/modules/interfacer/fixture-controller-check.ts` is the deliberately named **fixture controller seam**. Root `start`/`project`/`test`/`test:http` scripts explicitly enable `INTERFACER_AUTH_MODE=fixture-controller-stub`. It compares a locally asserted Person with the resource fixture's `primaryAccountable.id`. Only that controller is allowed; seller eligibility is NOT an additional gate.

This models a PDP-returned controller attestation; it does **not prove possession of a registered key**. Anyone with local shell/DB access can impersonate the fixture Person. It is not suitable for untrusted network clients or deployment. The **guarded local-dev HTTP endpoint above** exposes this same stub for GUI testing only; there is no header identity support or fake Zenroom signature format. P2 adds the separate local IdentityLink resolver described above; it is not cryptographic Person proof. Direct `medusa exec` without opt-in fails closed; fixture mode is also rejected under `NODE_ENV=production`.

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

P1 adds local seed pricing/publication and real Store API browsing. P2 adds local IdentityLink binding, one-unit stock allocation/reservation and a real native checkout/order with manual payment authorization, as documented above. No signed HTTP operation, durable message worker, live refresh, capture, fulfillment/delivery, ledger write or DPP/Zenflows mutation is implemented. P2 auth/cart/payment APIs are now end-to-end tested; see `docs/phase2-findings.md`. Admin build was intentionally not attempted. Older pinned dependencies emit deprecation warnings; this is a local spike, not a security-reviewed deployment.

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
