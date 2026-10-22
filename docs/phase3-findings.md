# P3 — Order → ValueFlows economic event (Medusa 2.10.3)

Verified with real Postgres, native workflows and curl: `npm run test:p3` passes
on the existing default DB and cold `interfacer_medusa_p3_acceptance` DB.
[Commands, actual output and HTTP evidence](../TESTING.md#p3--order--valueflows-event).
Exact dependency pins remain unchanged; Node 24.19.0 / npm 11.17.0.

## Trigger decision: guarded local delivery route, not a subscriber

`POST /dev/interfacer/orders/:id/deliver {}` calls `deliverOrder` in
`medusa/src/modules/interfacer/delivery.ts`. It performs **real native order
fulfillment and delivery**, re-reads persisted delivery evidence, then writes
the receipt. First receipt: 201 `{created:true,receipt}`; retry: 200 with the
same receipt. No write is attached to `order.placed` or `payment.captured`.
No invented completion event, direct core-table mutation, or fabricated delivery
metadata is used.

This is the explicitly permitted dev-route alternative: the local event bus has
no durable retry guarantee (P0). **No subscriber is installed.** An order marked
delivered through another Admin/internal path does not automatically write a
receipt; calling this guarded route afterward reconciles an already-delivered,
supported pickup order. Future production integration needs a durable
subscriber/outbox and real supplier authorization, not this fixture seam.

Both this POST/OPTIONS and `GET /dev/interfacer/receipts` (+ OPTIONS) use the
existing `allowLocalRequest` guard: fixture opt-in, production denial, no-store,
and exact GUI origins localhost:3104/3000. CORS is not authentication; anyone
reaching the local seam can assert delivery. Never expose it publicly. The
service entrypoint independently requires local commerce mode. Signed auth is P6.

## Installed APIs and events actually used

Paths below are under `medusa/node_modules/@medusajs/`.

| Step | Verified source / API |
| --- | --- |
| Provider | `fulfillment-manual/dist/services/manual-fulfillment.js`: identifier `manual`, `createFulfillment` returns local data/labels without remote calls. Registered in `medusa-config.ts` as `@medusajs/medusa/fulfillment-manual`, id `manual`, giving provider **manual_manual**. |
| Pickup setup | `types/dist/fulfillment/service.d.ts` + `mutations/*.d.ts`: Fulfillment module `list/createShippingProfiles`, `list/createFulfillmentSets`, `list/createServiceZones`, `list/createShippingOptions`. Named, advisory-locked setup reuses existing records. Service-zone filter is `{fulfillment_set:{id}}`, not `fulfillment_set_id`. Creates pickup set, zone, flat manual option with internal type/data. These are supported module writes, not SQL writes. |
| Pack/fulfill order | `core-flows/dist/order/workflows/create-fulfillment.js`: **createOrderFulfillmentWorkflow**, input `{order_id,location_id,shipping_option_id,items:[{id:orderLineId,quantity:1}],no_notification:true}`. Queries native reservations, creates and links fulfillment, registers order fulfillment, decrements stock and removes the consumed reservation. Emits **order.fulfillment_created**, payload `{order_id,fulfillment_id,no_notification}`. This event is NOT economic completion. |
| Deliver order | `core-flows/dist/order/workflows/mark-order-fulfillment-as-delivered.js`: **markOrderFulfillmentAsDeliveredWorkflow**, input `{orderId,fulfillmentId}` (camelCase). Calls `markFulfillmentAsDeliveredWorkflow`, registers order delivery quantities and emits **delivery.created**, payload `{id:fulfillmentId}`. `utils/dist/core-flows/events.js` defines `FulfillmentWorkflowEvents.DELIVERY_CREATED`. |
| Delivery validation | `core-flows/dist/fulfillment/workflows/mark-fulfillment-as-delivered.js`: rejects canceled/already-delivered fulfillment; persists `delivered_at`. Does **not** require a carrier shipment first. Route skips re-marking delivered state on retry. |
| Read evidence | Query graph `entity:"order"`, fields `items.*`, `items.detail.*`, `fulfillments.id/delivered_at/canceled_at/items.*`. Receipt requires native `delivered_at` and order line `detail.delivered_quantity === 1`. Authenticated Store order GET with additive `+fulfillments.*,+fulfillments.items.*,+items.detail.*` verifies this independently. |
| Capture-only negative test | `core-flows/dist/payment/workflows/capture-payment.*`: **capturePaymentWorkflow**, input `{payment_id}`. `verify-p3.ts capture` really captures the P2 manual payment, verifies `captured_at`, and asserts zero receipts before/after. No custom capture HTTP endpoint added. |

P2 is local collection (`requires_shipping:false`), not carrier shipping. Packing
still needs an explicit native shipping option/provider input in 2.10.3 even
for these lines, so P3 creates the internal manual pickup option. It does NOT
change the paid order's shipping methods, price, product shipping profile, or
inventory requirement. Stock goes from stocked/reserved **1/1 → 0/0** on native
fulfillment; delivery registers delivered quantity. No shipment is invented.

## Local receipt model and identity resolution

**LOCAL STAND-IN for a live Zenflows economic-event write — no live ledger call.**
`models/rea-receipt.ts` registers `ReaReceipt` with the integration's
`MedusaService`, table `interfacer_rea_receipt`. Fields: `action:"transfer"`,
`provider_id`, `receiver_id`, `resource_id`, `dpp_id`, `order_id`, `quantity`,
`has_point_in_time` (+ generated ID/timestamps). `delivery.ts` keeps the final
sink write explicit and swappable for a future idempotent remote adapter/outbox.
These are local normalized VF facts, not a claimed remote GraphQL response.

Provider/resource/DPP come only from the immutable ListingBinding resolved
using the persisted order line's variant (also checks product). Receiver comes
only from the customer's immutable IdentityLink. Client JSON, product/line
metadata and payment metadata do not supply those identities. Time is the
persisted fulfillment's `delivered_at`, not retry time; quantity is the order
line's quantity.

This P3 seam intentionally accepts **one resource line / one unit / local
collection** only. Multi-line/mixed-resource or shipping orders, missing
identity/binding, canceled orders, incompatible/multiple active fulfillments
fail closed rather than silently producing an incomplete singular receipt.
Broader orders require a different event/line model; P2 checkout itself has not
been globally narrowed by P3.

## Idempotency, migration and recovery limits

- Per-order Postgres advisory lock spans independent native workflow commits
  and the local sink. Concurrent delivery requests serialize across processes.
- Unique `order_id` index is a second DB safeguard. Receipt UPDATE, DELETE and
  soft-delete are rejected by the existing immutability trigger, so deleting a
  receipt cannot reopen the key. Positive quantity check added.
- Generated `Migration20261022002124.ts` creates the model/indexes;
  `Migration20261022002125.ts` adds immutability/quantity constraints. DML snapshot
  updated using the P2-documented Node 24 generation shim. Both migrations ran
  on existing and cold databases.
- Retry re-reads native fulfillment/delivery state. If delivery committed but
  the receipt did not, the next route call can write the missing receipt without
  delivering twice. Persisted receipt/time survive server restart (tested).
- This is **not** an atomic transaction with the fulfillment workflows, a durable
  event consumer, or a kill-at-every-instruction recovery proof. A process death
  inside an incomplete native workflow can still require reconciliation; no
  automatic exactly-once distributed/remote write guarantee is claimed.

## Verification and scope

`p3-probe.py` reuses `p2-probe.py.checks()` to really register/login/bind, project,
publish and buy one allocated resource. P2's race/authorization assertions still
run. It then checks no receipt on authorization **and actual capture**, four
concurrent deliveries (one 201, three 200), all receipt facts, native delivered
quantity, consumed stock/released reservation, repeated delivery and another
server restart. Disabled-mode HTTP checks and CLI unique/immutable-store tests
also pass. `npm test` covers production/CORS/preflight guards before storage.
Each server is stopped via `server-lifecycle.py` per-PID signals before the next
server/CLI boots; the shell EXIT trap stops only the labeled spike DB.

Also passed after implementation: `npm test` (invoked as `npm run test`),
`npm run test:http`, `npm run test:p1`, `npm run test:p2`. Logs:
`.tmp/p3-regression-*.log`, `.tmp/p3-verified.log`,
`.tmp/p3-cold-verified.log`, `.tmp/p3-cold-transcript.md`.
No server remains listening on 9000/19000; spike DB is stopped, data retained.
No git command, sibling inspection, live Zenflows/DPP call, signed identity
proof, carrier delivery, successor passport or driven browser test was performed.
No ledger DONE entry added: orchestrator verification is separate.
