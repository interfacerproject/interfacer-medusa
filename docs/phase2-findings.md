# P2 — Identity-bound checkout (Medusa 2.10.3)

Implemented and runtime-verified with `npm run test:p2`, on the existing default
DB and a cold `interfacer_medusa_p2_acceptance` DB in the labeled spike container.
Exact pins are unchanged. No live Interfacer/DPP call or cryptographic identity
proof is claimed. [Commands and actual responses](../TESTING.md#p2--identity-bound-checkout).

## Binding and enforcement decisions

- `IdentityLink` is an integration-owned DML model, table
  `interfacer_identity_link`: unique `customer_id`, unique `person_id`, generated
  `ifid_` ID. One-to-one, immutable after creation; DB triggers reject updates,
  deletion and soft-deletion. No email matching or customer metadata is identity
  authority. Linking requires an existing registered customer (`has_account`).
- Trigger: **development-only** `POST /dev/interfacer/identity
  {customerId,personId}`. Same fixture opt-in, production denial, exact GUI origin
  allowlist and OPTIONS handling as P0/P1. Identical retry returns the same link;
  changing either end is refused. Arbitrary local Person IDs are a resolver
  stand-in, NOT verified Zenflows Persons or key ownership. Anyone reaching the
  local seam can assert them; never expose it publicly. Signed auth remains P6.
- Completion HTTP middleware uses `authenticate("customer", ["session","bearer"])`
  and checks the authenticated actor equals the cart's bound customer. All Store
  cart completion now requires customer authentication (even non-Interfacer carts).
  Merely giving a bound customer's email is not an authenticated purchase.
- `completeCartWorkflow.hooks.validate` independently resolves immutable listing
  bindings and IdentityLink; absent binding for a marked Interfacer projection,
  absent identity, invalid variant/quantity, disabled inventory/backorder or
  invalid reference evidence stops completion. Module/query errors propagate:
  there is no permissive fallback. The hook stays enabled with fixture mode off
  and protects internal workflow callers too. Unbound direct workflow execution
  is tested after stopping the HTTP servers, with fixture mode disabled.
- Before the native workflow takes its snapshot, middleware writes canonical
  `interfacer_resource_id`, `interfacer_dpp_id`, `interfacer_listing_id` into cart
  line metadata, plus `interfacer_purchase` (buyer Person, identity link, listing
  references) into cart metadata using Cart module service methods. The hook
  checks this evidence against the immutable bindings; client metadata is not
  authority. Native cart→order conversion carries both metadata levels over.
  A deliberately forged passport reference is overwritten and the order's
  persisted canonical references are asserted via Store GET.
- This is not a fulfillment, delivery, REA event, or payment capture. No receipt
  or successor passport is minted at checkout.

## APIs actually used and verified

Paths in this table are below `medusa/node_modules/@medusajs/`.

| Operation | Exact route/API and installed source |
| --- | --- |
| Register email/password identity | `POST /auth/customer/emailpass/register {email,password}` → `{token}`. `medusa/dist/api/auth/[actor_type]/[auth_provider]/register/route.js`. The token initially has no customer actor. |
| Create customer account | `POST /store/customers {email,first_name}` with registration Bearer token + publishable key → `{customer}`. `createCustomerAccountWorkflow`; associates auth identity with customer. `medusa/dist/api/store/customers/route.js`. |
| Login and session | `POST /auth/customer/emailpass {email,password}` → fresh actor-bound JWT, then `POST /auth/session` with that Bearer token → `{user}` and session cookie. Subsequent `GET /store/customers/me` succeeds with the cookie. `medusa/dist/api/auth/session/route.js`. Register→customer→login is necessary; the old JWT does not acquire an actor magically. |
| Create cart | `POST /store/carts {region_id,sales_channel_id,email,shipping_address}` with publishable key + session. Calls `createCartWorkflow`, ID `create-cart`. `medusa/dist/api/store/carts/route.js`. Price currency is EUR from seeded context. |
| Set customer | Authenticated `POST /store/carts/:id/customer {}` calls `transferCartCustomerWorkflow`, ID `transfer-cart-customer`; actor ID comes from auth, not client JSON. `medusa/dist/api/store/carts/[id]/customer/route.js`. |
| Add item | `POST /store/carts/:id/line-items {variant_id,quantity,metadata?}` calls `addToCartWorkflow`, ID `add-to-cart`. A supplied `unit_price:0.01` returned **400**, `Invalid request: Unrecognized fields: 'unit_price'`; valid retry without it calculated **19.95**. Despite the standalone Zod schema appearing non-strict, the runtime body transformer rejects the extra field. No custom endpoint forwards a client price. |
| Payment provider | Default built-in **`pp_system_default`**, `payment/dist/providers/system.js`, `SystemProviderService.identifier = "system"`. No external provider package, Stripe key, webhook or card form. `GET /store/payment-providers?region_id=...` confirms it is enabled. |
| Enable provider for region | `updateRegionsWorkflow(container).run({input:{selector:{id:regionId},update:{payment_providers:["pp_system_default"]}}})`. Region→provider is a module link: query `entity:"region", fields:["id","payment_providers.id"]`; **not** a Region service relation. Preserves existing providers. `core-flows/dist/region/workflows/update-regions.js`. |
| Payment collection | `POST /store/payment-collections {cart_id}` calls `createPaymentCollectionForCartWorkflow`; returns `{payment_collection:{id,...}}`. `medusa/dist/api/store/payment-collections/route.js`. Amount comes from cart, not client. |
| Payment session | `POST /store/payment-collections/:id/payment-sessions {provider_id:"pp_system_default"}` calls `createPaymentSessionsWorkflow`; returns pending session. `medusa/dist/api/store/payment-collections/[id]/payment-sessions/route.js`. |
| Authorize and place order | `POST /store/carts/:id/complete` invokes `completeCartWorkflow`, ID **`complete-cart`**, input `{id}`, context `{transactionId:cartId}`, `throwOnError:false`. Native `authorizePaymentSessionStep` invokes the built-in provider, whose `authorizePayment` returns `authorized`. Response `{type:"order",order}`. No separate invented Store authorize endpoint. `core-flows/dist/cart/workflows/complete-cart.js`. |
| Authorization evidence | `payment_collections.payment_sessions.*` has `status:"authorized"` and `authorized_at`; `payment_collections.payments.*` contains a real payment with provider and amount, `captured_at:null`. `authorized_at` belongs to the **session**, not Payment. |
| Read order | Authenticated `GET /store/orders/:id`. Use additive fields `+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*` to retain the default quantity/totals relations. Selecting only `items.quantity` without `items.detail` produced absent quantity and misleading computed total 0 in the initial probe; default fields correctly return quantity 1 and total 19.95. `medusa/dist/api/store/orders/query-config.js`, `order/dist/utils/transform-order.js`. |
| Metadata conversion | `core-flows/dist/cart/utils/prepare-line-item-data.js` copies item metadata; `complete-cart.js` copies cart metadata into order metadata. We use the public **validate** hook. The source contains internal `orderCreated`/`beforePaymentAuthorization` hooks but 2.10.3's public returned hook type only exports `validate`; no invented public hook API is used. |

## Inventory and local collection

Guarded merchant setup: `POST /dev/interfacer/listings/:id/checkout {}`, where
`:id` is the immutable listing ID. Setup is separate from publishing so P0/P1
projection/browse behavior remains unchanged. It:

1. Reuses P1 commerce context; enables the system payment provider.
2. Creates an inventory item with deterministic SKU `interfacer-<listing ID>`
   using `createInventoryItemsWorkflow`, input `{items:[{sku,title,
   requires_shipping:false}]}`; workflow ID `create-inventory-items-workflow`.
3. Creates its location level using `createInventoryLevelsWorkflow`, input
   `{inventory_levels:[{inventory_item_id,location_id,stocked_quantity:1}]}`;
   workflow ID `create-inventory-levels-workflow`.
4. Queries `product_variant_inventory_item`, then creates a native module link
   through `container.resolve(ContainerRegistrationKeys.LINK).create({
   [Modules.PRODUCT]:{variant_id}, [Modules.INVENTORY]:{inventory_item_id},
   data:{required_quantity:1}})` if absent.
5. Calls `updateProductVariantsWorkflow`, input
   `{product_variants:[{id,manage_inventory:true,allow_backorder:false}]}`.

The quantity is an explicit **one-unit local allocation**, not an authoritative
remote stock synchronization. Existing levels are NEVER reset/replenished by
setup. A retry after purchase leaves stocked=1, reserved=1, available=0.

This P2 fixture is **local collection/no carrier shipping**: the inventory item's
`requires_shipping:false` and the existing projection's lack of shipping profile
produce a non-shipping line. No shipping method/provider, shipment or collection
completion is fabricated. Native `validateShippingStep` permits it. Physical
fulfillment/delivery and the economic event remain P3; geographic shipping is
not implemented here. Taxes remain off as in P1.

Native `reserveInventoryStep` (`reserve-inventory-step`) reserves for the order's
line item, using the inventory item's required quantity and channel location.
`inventory.createReservationItems` checks availability and updates reservations;
compensation deletes reservations on workflow failure. **Postgres locking is now
the configured default**: module `@medusajs/medusa/locking`, provider
`@medusajs/medusa/locking-postgres`, id `postgres`, `is_default:true`.
Its `execute` uses `pg_advisory_xact_lock`; reservations are serialized by
inventory-item ID instead of relying on the old in-memory default. Native
locking migrations were exercised on the cold DB. The runtime race test uses
two ready carts in one server, not a multi-server/crash-durability benchmark.
Local event bus/workflow storage remain development-only.

## Verification and tooling

`test:p2` typechecks, migrates, boots two sequential loopback servers, seeds +
projects + publishes through reused P0/P1 paths, registers two real accounts,
binds one, and checks:
- session-authenticated purchase, server price, stored DPP/resource references,
  authorized manual payment and authenticated order GET;
- unbound refusal with no order/reservation, anonymous refusal, wrong actor refusal;
- two concurrently completed, already-populated carts → one order + one stock
  error; one active reservation, no second active order; completion retry returns
  the original order; re-seed does not restock; sold-out add fails;
- binding idempotency/uniqueness, CORS, disabled/production dev guards; direct
  workflow refusal without HTTP middleware; immutable IdentityLink DB triggers.

Per-PID signals via `scripts/server-lifecycle.py`, never killpg. Servers stop
before the CLI workflow assertion boots; the shell EXIT trap stops only the
labeled DB. Fresh fixtures are suffixed with a per-run ID; data is retained and
no sold stock is recycled. Repeated test runs intentionally add one new demo
order rather than resetting stock. `npm test`, `npm run test:http`,
`npm run test:p1` also passed after implementation.

Identity migration generation encountered Medusa's use of removed Node 24
`Dirent.path`. The opt-in `scripts/node24-dirent-compat.cjs` maps it to
`parentPath` only during generation, without changing dependencies:

```bash
# From medusa/; with the local DB/env enabled as in scripts/spike.sh
NODE_OPTIONS="--require=$PWD/../scripts/node24-dirent-compat.cjs" \
  ./node_modules/.bin/medusa db:generate interfacer
```

Generated migration `Migration20261021234058.ts` creates the identity table;
`Migration20261021234100.ts` adds immutability using the P0 trigger function.
Normal `npm run test:p2` migrations do not need the compatibility shim.

No browser automation/storefront UI, production build, live Person resolution,
registered-key proof, capture, delivery or REA write is claimed. The verified
surface is the real Store/auth HTTP API, usable by the later P6 GUI. No ledger
DONE entry was added; orchestrator verification remains separate.
