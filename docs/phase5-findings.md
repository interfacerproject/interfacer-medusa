# P5 — Build purchase + production trace

Verified against real Medusa **2.10.3**, Postgres and curl. `npm run test:p5`
passes; P0–P4 regression commands pass. No live Zenflows/DPP write, signed
supplier proof or driven browser is claimed. [Run/output](../TESTING.md#p5--build-purchase--production-trace).

## Commerce decision: native product per immutable quote

Chosen to reuse P1/P2's native product → cart → manual-payment → order path.
`BuildOffer` binds one P4 quote to one published product/variant, each uniquely
indexed. A cart quantity of **1** buys the **entire quoted lot**: the organizer
quote is EUR 19 for **2 produced pieces**, not EUR 19 per piece. Product price is
the persisted quote's integer cents / 100 (Medusa uses major currency units).

This is made-to-order: `manage_inventory:false`, no synthetic stock allocation,
reservation or capacity claim. P2 stock guards remain unchanged for stock
listings. Product is non-discountable; checkout verifies currency, price,
adjustments/taxes, no shipping methods and the exact quote total. No shipping,
discount, royalty or extra price line is inferred.

`BuildAcceptance` fixes cart/customer/quote before the line is added.
It is immutable and unique per cart, independently of editable cart metadata.
The native Medusa order **is the build order**; no parallel order/payment system.
Both order metadata `interfacer_purchase.build` and line metadata
`interfacer_build` record:

- `design_id`, `service_id`, `service_provider_person_id`;
- `quote_id`, `quote_hash`, `origin_dpp_id`, quoted `quantity`;
- order-level `buyer_person_id`, `identity_link_id`, `acceptance_id`.

All identities/references/prices resolve from immutable module records, not
client price/provider/service assertions or the current mutable service row.
Quote reads recompute P4's complete snapshot and verify all persisted terms/hash.
Old valid quotes remain acceptable; no expiry/capacity reservation or remote
supplier commitment is modeled. Missing origin DPP is refused for P5, although
P4 can still match designs with a null origin reference.

## Entry points and enforcement

- **POST /dev/interfacer/build-orders** `{cartId,quoteId}`: accept and add
  one server-priced quoted-lot line to an empty, customer-bound EUR seed cart.
  Requires real Medusa session/Bearer customer authentication, matching cart
  customer and P2 IdentityLink. Returns `{acceptance,offer,build,price_eur}`.
  Identical retry reuses the same acceptance/product/line. Another quote for
  that cart is refused; extra service/provider/quantity/price fields are 400.
- Native P2 Store payment collection/session/completion routes are reused.
  Completion authorizes `pp_system_default`; native capture is a separate
  **upfront financial action**. P5 tests really capture both payments using
  `capturePaymentWorkflow`, never a fabricated capture endpoint.
- Always-on `checkoutEvidence` + the existing `completeCartWorkflow.validate`
  hook require a matching acceptance, one line, one variant, one quoted lot,
  bound identity and canonical references. Missing acceptance/mapping fails
  closed. A mixed-supplier cart, replacement service variant, edited canonical
  service metadata, changed quantity or price cannot complete.
  Generic Store line mutation itself remains available; refusal is at the
  authoritative completion boundary, before an order/payment authorization.
- **POST /dev/interfacer/build-orders/:id/produce** `{}`: **native order ID**.
  Explicit local admin/supplier assertion that production occurred.
  Requires a non-canceled, linked native build order, canonical order/line
  evidence and an actually **captured** upfront manual payment matching price.
  Authorization without capture is refused. No native delivery/fulfillment is
  fabricated: this is the allowed explicit production-milestone alternative.
- OPTIONS supported. Shared fixture opt-in/production denial/no-store/exact GUI
  origins apply. Acceptance additionally authenticates the customer. Dev CORS
  now permits Authorization for Bearer-based GUI calls (not cookie credentials).
  **Production remains a local fixture admin/supplier seam, not actual supplier
  authorization. Anyone reaching it can assert production.** Never expose
  publicly; signed actor authorization remains P6.

## Local production receipt and idempotency

P3's **LOCAL STAND-IN** `interfacer_rea_receipt` sink now permits `produce`
as well as `transfer`. New nullable fields preserve existing P3 transfer rows.
Production receipt: provider = quote's service-provider Person, receiver =
buyer's immutable IdentityLink Person; `resource_id = design_id`,
`service_id`, `origin_dpp_id = dpp_id`, quote ID/hash, native order ID,
**quote quantity** and milestone time. This is normalized local VF data,
not a claimed remote GraphQL response or physical-machine proof.

The receipt insert **is the durable local milestone**. No receipt on placement,
authorization or capture. No successor passport is minted: only the origin
DPP ID is referenced. A per-order Postgres advisory lock serializes production;
P3's unique order index and immutable-store trigger remain the second DB guard.
Concurrent calls yield one 201, then 200 with the same receipt ID/time. Persisted
facts survive restart. There is no distributed exactly-once or remote outbox
claim; a lost insert response is recovered by retry, not by another payment hook.

Generated `Migration20261022005015.ts` creates offer/acceptance tables and
extends receipt fields/action. `Migration20261022005016.ts` adds immutable
offer/acceptance triggers and required production-reference consistency checks.
Generated snapshot updated via the P2 Node-24 compatibility shim. All changes
are integration-owned tables; core commerce writes use supported APIs only.

## Verified APIs, tests and isolation

Installed sources under `medusa/node_modules/@medusajs/`:
`core-flows/dist/product/workflows/create-products.js` (native priced product
and sales-channel links), `cart/workflows/add-to-cart.js` and
`complete-cart.js` (server-priced line; validate hook; metadata conversion),
`payment/workflows/capture-payment.js` (actual manual capture).
P5 also runtime-verifies query graph `cart.order.id` against acceptance and
`order.items.detail.*` for native quantities/totals. No invented order hook.

`scripts/p5-probe.py` reuses P4 matching and P2's real curl/register/session/
IdentityLink/payment machinery. It asserts a two-piece build purchase, exact
stored references and EUR 19 total, one-supplier/service-swap/price/quantity/
unbound/wrong-actor refusals, no receipt on authorization or real capture,
one correct event under four concurrent milestones, retry + restart stability,
and a separate captured build with **no milestone and no event**.
CLI checks immutable offers/acceptances/receipts, unique sink, fixture-disabled
internal-action denial and native workflow evidence/price-bypass refusal.
Production/disabled/CORS guards are covered before storage by `npm test`.

All tests ran only in a **newly created** container
`interfacer-medusa-p5-verified-db`, host **127.0.0.1:55435**, database
`interfacer_medusa`, starting cold and rerunning with retained state.
Original spike and sibling containers were not started/stopped/modified.
Harness supports `INTERFACER_DB_CONTAINER` / `INTERFACER_DB_PORT`; existing
defaults are unchanged, and SQL probes use the selected owned container.
Only labeled containers are lifecycle-managed. Full commands are in TESTING.md.

Logs: `.tmp/p5-final.log`, `.tmp/p5-transcript.md`,
`.tmp/p5-regression-{test,test-http,test-p1,test-p2,test-p3,test-p4}.log`.
Four sequential HTTP sessions stop via existing **per-PID** signals; CLI runs
with HTTP stopped; EXIT stops the owned DB, retaining data. No git command,
sibling access, live ledger call or ledger DONE entry was made.
