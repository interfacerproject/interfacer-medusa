# Phase 0: compatibility gate

## Baseline and topology

- Exact pin: **Medusa 2.10.3** (`@medusajs/{cli,framework,medusa}`); `medusa/package-lock.json` locks transitive dependencies. Node tested: **24.19.0**, npm **11.17.0**.
- Non-interactive minimal scaffold in `medusa/`. `create-medusa-app@2.10.3` was inspected, NOT executed: its `src/utils/clone-repo.ts` unconditionally runs `git clone`; `medusa-project-creator.ts` also prompts for Next.js. Direct scaffolding avoids violating the no-git constraint. No admin/storefront build or seed.
- Isolated container **interfacer-medusa-spike-db**, image `postgres:15-alpine` (observed PostgreSQL **15.19**, local image ID `sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b`), host port **127.0.0.1:55432**, database **interfacer_medusa**, local-only user/password **medusa/medusa_local**. URL: `postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa`. Data stays in this container; removing it destroys the demo DB. Existing containers were listed, not changed.
- Admin UI disabled; local event bus, in-memory workflow engine/locking defaults. These are development-only, not production guarantees. Integration concurrency uses its own Postgres advisory lock, not default in-memory locking.
- Initial `npm run db:migrate` succeeded. Brief `medusa develop --host 127.0.0.1 --port 19000 --no-types` probe returned **GET /health → 200 OK**, then the complete process group was stopped.
- No `docs/fixtures/` existed on initial inspection. Minimal synthetic resource/DPP fixtures were added here; no real inventory or passport claims are made.
- Interfacer commit compatibility: **BLOCKED**. Sibling inspection and git are forbidden. The spec's prior repository findings are not a live verification. No live Interfacer requests made; commerce PDP actions/envelope support are not assumed available.

## §3.2 verification table

All paths below are relative to `medusa/node_modules/`. VERIFIED/source means inspected in the installed **2.10.3** package, not a completed checkout/payment test. Only the first spike's product path is runtime-tested below.

| Gate | Result | Exact API/event and installed source |
|---|---|---|
| Product/variant creation and metadata | VERIFIED/source | `createProductsWorkflow(container).run({input:{products:[...]}})`, workflow ID `create-products`; invokes `createProductVariantsWorkflow`, requires options; `ProductStatus.DRAFT`. `@medusajs/core-flows/dist/product/workflows/create-products.js`; `@medusajs/product/dist/models/{product,product-variant}.js` both define `metadata: model.json().nullable()`. |
| Customer authentication/session | VERIFIED/source | `POST /auth/customer/emailpass`, `POST /auth/customer/emailpass/register` use actor/provider routing; `POST /auth/session` stores bearer auth context, `DELETE /auth/session` destroys session. `authenticate("customer", ["session", "bearer"])` for `/store/customers/me*`. Sources: `@medusajs/medusa/dist/api/auth/[actor_type]/[auth_provider]/{route.js,register/route.js}`, `api/auth/{middlewares.js,session/route.js}`, `api/store/customers/middlewares.js`. Does NOT establish an Interfacer Person. |
| Custom module links | VERIFIED/source + exported keys | `Module`, `MedusaService`, `model.define`, `defineLink`; `@medusajs/utils/dist/modules-sdk/define-link.js` verifies linkable keys. Runtime inspection of default module exports confirmed `ProductModule.linkable.product`, `.productVariant`, `CustomerModule.linkable.customer`, `OrderModule.linkable.order`. Custom link-table migration/CRUD not exercised; spike stores IDs in its own model instead. |
| Cart validation/completion | VERIFIED/source | `addToCartWorkflow.hooks.validate`, `.setPricingContext`; `createCartWorkflow.hooks.validate`; `completeCartWorkflow.hooks.validate`, `.beforePaymentAuthorization`, `.orderCreated`. Sources: `@medusajs/core-flows/dist/cart/workflows/{add-to-cart,create-carts,complete-cart}.js`. |
| Server-controlled pricing | VERIFIED/source | Store `StoreAddCartLineItem` accepts variant ID, quantity, metadata, not `unit_price`: `@medusajs/medusa/dist/api/store/carts/validators.js`. `addToCartWorkflow` calculates variant prices server-side; its INTERNAL input can override `unit_price` / `isCustomPrice`. `@medusajs/core-flows/dist/cart/workflows/add-to-cart.js`. Never pass untrusted prices to that workflow. No prices in this draft spike. |
| Inventory reservations | VERIFIED/source | `reserveInventoryStep`, ID `reserve-inventory-step`, calls `inventoryService.createReservationItems` under `locking.execute`; compensation calls `deleteReservationItems`. `@medusajs/core-flows/dist/cart/steps/reserve-inventory.js`. No stock allocation is inferred for the spike. |
| Order events | VERIFIED/source | `OrderWorkflowEvents.PLACED = order.placed`, `CANCELED = order.canceled`, `FULFILLMENT_CREATED = order.fulfillment_created`, `FULFILLMENT_CANCELED = order.fulfillment_canceled`. `@medusajs/utils/dist/core-flows/events.js`; emission sites in `@medusajs/core-flows/dist/order/workflows/{cancel-order,create-fulfillment,cancel-order-fulfillment}.js`; placement in `@medusajs/core-flows/dist/cart/workflows/complete-cart.js`. No assumed `order.completed` subscription. |
| Payment/refund events | VERIFIED/source | `PaymentEvents.CAPTURED = payment.captured`, `REFUNDED = payment.refunded`, defined in `@medusajs/utils/dist/core-flows/events.js`; payment workflow emission sites under `@medusajs/core-flows/dist/payment/workflows/`. Refund is not physical return. |
| Fulfillment events | VERIFIED/source | `FulfillmentEvents.SHIPMENT_CREATED = shipment.created`, `DELIVERY_CREATED = delivery.created`, model `FULFILLMENT_CREATED = fulfillment.created`; `@medusajs/utils/dist/fulfillment/events.js`. Order-specific workflow events above are distinct. |
| Subscriber retries/delivery | VERIFIED/source (negative guarantee) | `@medusajs/event-bus-local/dist/services/event-bus-local.js`: Node EventEmitter, grouped events in Map; subscriber exceptions logged, NO retry or durable delivery. Redis implementation `@medusajs/event-bus-redis/dist/services/event-bus-redis.js` defaults `attempts: 1`, supports configured retries; not enabled/tested. Neither implies atomic bridge writes or exactly-once delivery. |
| Custom integration execution | VERIFIED/source | `Module(...)` registered through `defineConfig({modules:[...]})`; `medusa exec ./src/scripts/project.ts` gets `{container,args}` after module loading. `@medusajs/medusa/dist/commands/exec.js`. Chosen instead of an HTTP write route: no unauthenticated fixture principal on the network. |

## Local-dev HTTP follow-up

The historical Phase-0 choice below was CLI-only. The follow-up adds a guarded local GUI affordance, **not production authorization**:
- File routing verified in installed 2.10.3 `@medusajs/framework/dist/http/routes-loader.js`: scans `route.ts`, exports GET/POST/OPTIONS; request scope resolves the existing module.
- CORS behavior verified in `http/router.js`: automatic configured CORS is limited to /store, /admin, /auth. The /dev route explicitly handles preflight and uses the same GUI origins configured in `medusa-config.ts`; no invented `devCors` config key.
- Real curl on /dev/interfacer/listings verified creation (201), joined GET (200), retry (200, same IDs), wrong controller (403, no writes), invalid DPP parent (400), conflict (409), both GUI preflights (204) and disabled fixture mode (403 on GET/POST/OPTIONS).
- `npm test` still passes, including direct production guard tests. Exact HTTP commands/responses and lifecycle in TESTING.md. Both HTTP server groups and the labeled DB were stopped.

## Scope of the first spike

Module-owned immutable ListingBinding + source hashes, passport ID reference only, a draft with one variant. Fixture-only controller attestation is a deliberately named seam, explicitly enabled for local CLI execution and forbidden in production. It is NOT registered-key proof, a live PDP, an IdentityLink, or a signed HTTP envelope. No new Zenflows action, replay registry, customer binding, payment, publication, or ledger write is claimed. A live signed integration remains BLOCKED pending compatible services and policy changes.

## Implemented slice and runtime results

Implementation:
- `medusa/src/modules/interfacer/index.ts` registers `Module("interfacer", ...)`; config loads it.
- `models/listing-binding.ts` and `service.ts`: integration-owned DML models/services and cross-process Postgres advisory lock.
- `migrations/Migration20261021194633.ts`: framework-generated tables/indexes.
- `migrations/Migration20261021194700.ts`: module-table-only triggers reject UPDATE/DELETE, including soft deletion.
- `project-resource.ts`: validate parent, authorize controller, persist immutable intent, run `createProductsWorkflow`, persist immutable binding. Canonical JSON SHA-256 covers each entire source document; passport document fields are never copied.
- `fixture-controller-check.ts`: explicit opt-in CLI stub, denied in production.
- `medusa/src/scripts/{project,inspect,verify}.ts`: projection, native module reads, executable acceptance cases.
- `scripts/{spike.sh,probe.py}`: reproducible lifecycle, isolated DB, real HTTP probe, cleanup.

Executed successfully:
1. Non-interactive install, `npm ci` from the repository lockfile, TypeScript check, native module migrations.
2. Initial projection in `interfacer_medusa`: **one draft, one variant, one listing binding**.
3. Cold-DB acceptance in a separately created `interfacer_medusa_acceptance`: `DATABASE_URL=postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa_acceptance bash scripts/spike.sh test` returned 0. Simulated exception after completed product workflow, before mapping insertion; four concurrent retries recovered that product, not duplicates.
4. Final default **`npm test` returned 0**. It verified controller denial, forged subject claim denial, DPP-parent mismatch, simulated authority outage, unknown obligations, opt-in requirement, production guard, stable hashes, changed-source conflicts, concurrent retries, product-reference tampering detection, and DB-trigger immutability.
5. `npm run project` retry returned `created: false`; `npm run inspect` read the real product and binding. Read-only SQL join returned exactly one row in the default DB.
6. `INTERFACER_FIXTURE_PERSON=some-other-person npm run project` returned **1**, `authorization_denied`.
7. Real server probes returned **HTTP 200 OK**. Each server process group was terminated; spike DB stopped, data retained. No unrelated containers altered.

Observed default DB IDs (new checkouts generate different IDs):
- Product: `prod_01M5G01XZ8CP1GXVF9JKPG0NHT`
- Variant: `variant_01M5G01XZVGXS6NX3BY8B4GJFC`
- Binding: `iflb_01M5G01Y16E92FQERFDG2P9044`
- Resource hash: `14f13f26aaaee047c5e865a3c173b0d8bb9683b756f98396e17237eb2f28292f`
- Passport hash: `5cc90733600d7be0e2dbd480d848639c17560a61ec0ad010b5b381a27ff49d7a`

Limits: simulated lost-response recovery is not a kill-at-every-instruction test. Partial native workflow output raises `reconciliation_required`. No Redis durability, live Interfacer identity/PDP verification, HTTP signature/replay implementation, admin UI build, or checkout/payment integration was tested or claimed. Exact dependency pinning is reproducibility, not a security audit.
