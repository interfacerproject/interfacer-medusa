# Local Zenflows marketplace bridge

Updated 2026-10-26: P7 durable outbox, P8 real actors (no demo keys in live
mode), P9 enforced Zenflows authorization (seller-signed relay). Earlier:
2026-10-23, Claude session
`cbf47518` / commit `e65e053`, pi session `01a16863`.
Work remains on `feat/zenflows-real-events`; no production/main changes.
Review snapshot: [bilingual field guide](review/README.md), backend PR #1 and GUI
PR #922 (both pushed 2026-10-27); implementation pins `8018cb4` / `f76a53e`. The
shareable Claude artifact was refreshed on 2026-10-27; the versioned guide stays
the maintained copy.

## What runs now

Live mode = Medusa started with `INTERFACER_ZENFLOWS_URL`. In live mode every
actor is a real Zenflows Person who signs with the key Zenflows has registered
for them (their Interfacer wallet in the GUI). Fixture keys are refused with
`fixture_identity_forbidden`, `/dev/store/sign` with `dev_signer_disabled_live`,
and `/dev/store/config` discloses no demo login.

- **Catalog (P8):** a Design's structured requirements
  (`interfacer-build-requirements-v1`) and a Service's capabilities + fixed EUR
  prices + location (`interfacer-fabrication-capabilities-v1`) are registered by
  the Person accountable for that Zenflows resource. They sign
  `catalog.{design,service}.register` with `{resource_id, document}`.
  - Medusa re-reads the resource and requires the right Interfacer spec and
    `primaryAccountable = signer`.
  - It parses the document strictly (unknown keys refused) and stores an
    immutable revision.
  - Matching uses only registered entries, revalidated against Zenflows at match
    time. A vanished resource, a changed spec, or a resource whose owner no longer
    holds it is excluded with a reason and never quoted. Manufacturability is
    never inferred from tags.
  - The DPP reference is derived (`zenflows:traceDpp:<resource id>`), never
    asserted by the owner or copied.
- **Stock:**
  - The seller lists their own Product resource (`commerce.listing.live.create`
    `{resource_id}`; accountable = custodian = signer, onhand ≥ 1), then publishes
    and allocates it with their wallet.
  - Delivery is signed by that seller. It **transfers one unit of the seller's real
    resource** to the buyer; the destination carries the outbox marker. There is
    no stand-in raise.
  - Self-purchase is refused.
- **Build:**
  - The registered service owner is the quote provider and signs production.
  - A finished ValueFlows **Process** produces the output (provider = receiver =
    maker, `outputOf` = Process).
  - The output is then transferred to the buyer, in the quoted lot quantity.
- **Seller console:** `GET /dev/store/seller` (GUI `/market/sales`) returns only
  the authenticated Person's listings, registrations and sold orders with
  receipts and sync state.
  - `/dev/store/prepare` returns a deliver/produce operation only to that
    order's seller/provider. Every other person gets `seller_order_required`.
- **Standalone** (no URL): the original fixture catalog, disposable buyer and dev
  signer, with local receipts only. The 9-suite harness runs here.
- **Durable outbox (P7):** the immutable receipt and an `interfacer_zenflows_sync`
  row commit in **one transaction before any remote write**. The sync then runs
  inline, from the per-minute `interfacer-zenflows-sync` job or from
  `POST /dev/interfacer/zenflows-sync/:id/retry`. Every Process, event and
  resource note carries `interfacer-sync=<marker>`. A step is marked inflight
  before it is sent and checkpointed after; an ambiguous failure is reconciled by
  searching Zenflows for the marker, **never replayed blind** (details below).
- The receipt view exposes the **final handover/transfer event id** as
  `zenflows_event_id` and shows it in the GUI with **LIVE**. For outbox receipts
  it comes from the done sync row, because receipt rows are immutable (DB
  trigger). The receipt action `produce` describes the local production milestone;
  its event id is the subsequent transfer. The Process and produce ids are on the
  sync row (`process_id`, `creation_event_id`).
- A logged-in GUI buyer uses their **existing Interfacer browser wallet**. The
  immutable identity link supplies the live event receiver.

Payments are still manual test payments. This is not a production identity
provider or remote PDP integration.

## Enable live events

Before `npm run dev:up`:

```bash
export INTERFACER_ZENFLOWS_URL=http://localhost:8000/api
# Optional, if required by the local registry:
# export INTERFACER_ZENFLOWS_ADMIN=<server-only-admin-value>
npm run dev:up        # live: no fixture bootstrap; sellers list from the GUI
```

Sellers, buyers and units come per order from listings, quotes and identity
links. The produced lot uses the instance's `unitOne`. `INTERFACER_ZENFLOWS_PROVIDER`,
`_UNIT` and `_RECEIVER` are optional fallbacks only for pre-P8 fixture data.

`INTERFACER_ZENFLOWS_RESOURCE` is obsolete: each milestone creates its own
resource. No fixed receiver is needed for verified buyer sessions. An unset URL
keeps the standalone fixture demo working with local receipts only. A configured
write failure leaves **SYNC PENDING** (retried with backoff
`min(5 s · 2^attempts, 10 min)`), never a false LIVE badge. A milestone that
cannot be mapped (the anonymous fixture buyer without a configured receiver)
stays LOCAL ONLY, as before.

## Durable milestone outbox (P7)

Steps:
- build: `process → create (produce, outputOf) → transfer`;
- live stock: `transfer` of one unit of the seller's own resource, with the
  destination marked via `newInventoriedResource.note`;
- pre-P8 fixture stock: `create (raise) → transfer`.

| Failure | What the row does |
| --- | --- |
| GraphQL `errors` / HTTP 4xx | definite: Zenflows rolled back. Inflight cleared, step re-sent on retry |
| network, timeout, 5xx, unreadable reply, local save failing after the send | ambiguous: inflight kept. Next run **reconciles first** |
| reconcile finds exactly one marked object with matching provider/receiver/quantity/`outputOf` | checkpointed, no re-send |
| reconcile finds none, attempt < 60 s old | deferred: the original may still commit |
| reconcile finds none, attempt ≥ 60 s old | inflight cleared, step sent again |
| several marked objects / different facts | `blocked: zenflows_reconcile_duplicate` / `_mismatch`: operator decides |
| stored payload hash differs | `blocked: zenflows_sync_payload_tampered`, zero remote calls |
| configured Zenflows URL changed | `blocked: zenflows_sync_target_changed` |
| milestone retried with different facts for the same order | HTTP 409 `zenflows_sync_payload_conflict` |

Reconciliation reads:
- **create:** `economicResources(filter:{note: marker})`, then each resource's
  `previous` events.
- **transfer:** the destination inherits the source note.
- **process:** Zenflows ids start with a 48-bit ms timestamp. The executor pages
  `processes(after: <id lower bound of inflight_at − 5 min>)`.

Operator view: `GET /dev/interfacer/zenflows-sync` (marker, status, attempts,
last error, ids). Receipts created before P7 carry no marker. They stay LOCAL
ONLY and are deliberately not recovered, since recovering them could duplicate
events.

Live fault test tool: `scripts/zenflows-fault-proxy.cjs`, a loopback proxy in
front of Zenflows with modes `lose-response | late | down | reject`. Run
`dev:up` with `INTERFACER_ZENFLOWS_URL=http://127.0.0.1:8100/api`, then
`python3 scripts/p7-outbox-probe.py faults|restart-prepare|restart-verify`. The
probe uses real disposable Zenflows People (`scripts/zenflows-actor.cjs`,
`scripts/live_actors.py`) and no fixture keys.

Zenflows ids are **ULIDs**, not database UUIDs. Inspect via GraphQL:

```graphql
{
  agents(first: 20) { edges { node { id name } } }
  units(first: 10) { edges { node { id label } } }
}
```

The adapter requires the seeded `Product` ResourceSpecification. It deliberately
refuses an arbitrary fallback specification. Requests time out after 10 seconds;
HTTP/GraphQL failures abort the remaining write sequence.

### Compatible local stack

- Zenflows PR #84, worktree `zenflows-pr84`, GraphQL `http://localhost:8000/api`.
- SDK PR #7, built in `interfacer-client-wallet` and linked into the GUI.
- GUI `interfacer-gui-medusa`, `http://localhost:3002`.
- Medusa v2.10.3, `http://localhost:9000`.
- Local signup requires a valid **base64 `ROOM_SALT`** in Zenflows.
- Verified with Zenflows both unenforced and **enforced**
  (`GQL_AUTH_CALLS=true AUTHZ_ENFORCE=true AUTHZ_ALLOW_UNCHECKED=false`, same DB,
  `ROOM_SALT` and `ADMIN_KEY`). See "Enforced Zenflows authorization (P9)".

## Enforced Zenflows authorization (P9)

With enforcement on, Zenflows authenticates every call (`zenflows-user` +
`zenflows-sign` over the body) and authorizes each write against the signer. An
event needs a signer acting for its provider or receiver who controls the
Process and resources it touches. Medusa never holds a credential that can write
in a seller's name.

- **Reads:** registry keys, resources, instance, specs and reconciliation are
  signed by a dedicated read-only Medusa Person
  (`INTERFACER_ZENFLOWS_SERVICE_USER` + `INTERFACER_ZENFLOWS_SERVICE_SEED`,
  base58 keypairoom seed; local, kept in `.tmp`). A signed call never carries
  `zenflows-admin`: Zenflows ignores the signature whenever that header is
  present.
- **Writes** (`INTERFACER_ZENFLOWS_SIGNED_WRITES=true`): the outbox never sends an
  unsigned write. It stops at each step with
  `last_error = awaiting_seller_signature:<step>`. Then:
  1. The provider's browser calls `GET /dev/store/zenflows-sync/:id/next`. Only
     the Person who is the row's provider gets an answer (bearer): Medusa's
     exact body for the next write.
  2. The GUI checks the body (`lib/market/relay.ts`): one of the three
     marketplace mutation shapes, provider = me, a handover's receiver = the
     order's buyer.
  3. It signs with the SDK's `signGraphQLRequest` and posts
     `{step, body, signature}` to `POST .../sign`.
  4. Medusa recomputes the body and requires equality (`relay_body_mismatch`).
     It verifies the signature against the provider's **registered** key
     (`relay_signature_invalid`) and relays it once with the provider's registry
     username. Zenflows re-verifies and authorizes; the signature is not stored.
- Signed message: Zencode's `verify_graphql` removes spaces and "compacts ascii
  strings" (raw whitespace, escape sequences, non-ASCII). Medusa serializes every
  body with one function (`zenflowsBody`: one-line query, canonical JSON) and only
  signs or relays printable-ASCII bodies without `\`. For those the message is
  exactly the body without spaces, which was checked against the live zvmlet.
- **Recovery:** the scheduled job and retries still reconcile; writes wait for the
  seller. The GUI sales console signs the remaining steps right after a
  milestone, or on Retry.
- Live negative check: a transfer of the seller's resource signed by the buyer is
  refused by Zenflows itself (`forbidden`); the same body signed by the seller
  passes.

## Verified buyer protocol

1. GUI loads the fixture catalog configuration (publishable key, channel, region).
2. `GET /dev/store/session?person=<ULID>` issues a bounded, 60-second one-use
   challenge. It is bound to that Person, not to a caller-chosen public key.
3. The browser signs a P6a canonical envelope for `commerce.session.create` with
   `{challenge}` using its existing Zenroom Ed25519 seed. Keypairoom stores this
   seed/public key in **base58**. Browser WebCrypto and Node verify the same raw
   UTF-8 bytes, preserving spaces inside strings; the GraphQL signing contract
   is unsuitable because it removes spaces.
4. `POST /dev/store/session` consumes the challenge **before awaiting I/O** and
   fetches the Person's registered key from the configured Zenflows URL. Invalid
   proof, unknown Person, wrong key and registry outage deny authentication. There
   is no fallback to the fixture account and no private-key upload/enrollment.
5. Under a per-Person database advisory lock, the server creates/reuses a native
   Medusa customer + AuthIdentity and immutable `IdentityLink`. Only this verified
   flow stamps `zenflows_person_id`. It returns a one-hour native customer bearer;
   the browser keeps that token only in the client instance, not localStorage.
6. `POST /dev/store/prepare` resolves authoritative cart/order operation facts for
   that authenticated customer. Buyers sign checkout/build/capture themselves;
   the server still independently verifies their registry key at protected writes
   and in the native completion hook. No request can select a different receiver.
7. `/dev/store/sign` refuses real buyer signing. It retains only the explicitly
   disposable supplier milestone signatures for that buyer's own demo orders.

The GUI proxy preserves the boundary: non-production, loopback socket/Host,
same-origin requests, allowlisted paths/methods, no forwarded principal, no-store
responses. It forwards proofs, never private keys. Saved cart/order state is
namespaced by **run + native customer id + journey target**, so another account
cannot restore the previous buyer's journey from localStorage.

Migration `Migration20261023120000` adds nullable `zenflows_person_id`; older fixture
links remain unverified and are not upgraded from an unproven HTTP assertion.
Use the normal `medusa db:migrate` / `dev:up` setup. Never alter Medusa core tables
with SQL to enroll a customer.

## Evidence and commands

```bash
# Pure matching, envelope, registry/challenge and economic-event adapter tests:
npm run test:unit
npm --prefix medusa run typecheck

# In interfacer-gui-medusa:
npm run test:market
npm run check-types
MARKET_LIVE_E2E=1 MARKET_E2E=1 TEST_BASE_URL=http://localhost:3002 \
  ./node_modules/.bin/playwright test tests/market-identity.spec.ts tests/market.spec.ts \
  --project=chromium --workers=1
```

Verified 2026-10-23: **21 backend unit tests, 20 GUI unit tests, both TypeScript
checks, four Chromium journeys** (stock/build with both verified and demo buyers).
The live suite registers disposable test People with fresh keys, drives actual GUI
clicks, then queries Zenflows to prove the event receiver, `produce.outputOf` and
finished Process. It also verifies session-proof replay refusal, real-buyer signer
refusal, another account's order refusal, account-isolated persisted state and
stock milestone retry reusing the same receipt/event id.

Example verified build: order `order_01M5M7K0D4YYBMTTPXTD6V2FAK`, buyer
`06GPGYBV46E5SGA67HVW5JTVH8`, produce `06GPGYC3YHCAYB6GDJ9MSBBC7G`, Process
`06GPGYC3X50B68VJHCD9BRA3KR`, handover `06GPGYC40P0P3A45S070MB9BV4`.
Desktop/mobile Chromium captures (1440/390px) are under GUI `test-results/`.
The historical **`npm run test:all` is also green, 9/9 suites**. Its stale guard
assertion was aligned with the existing origin-less top-level navigation policy;
foreign Origins remain refused, and session/prepare handlers now share the guard
matrix. After verification the original bridge environment was restored and a
fresh demo run was left serving **three available stock units**, retaining data.
The live tests create retained local test data and consume finite stock; they never
silently replenish it. A new explicit `dev:up` run publishes fresh synthetic units,
retaining older orders/resources/receipts.

## Explicit limits

Catalog owners and sellers must be Persons. Resources owned by an Organisation
are refused with `catalog_owner_required` until org-admin acting is wired in.
Catalog documents are owner assertions about capability and price, validated for
shape, not verified physically. DPP references point at Zenflows' `traceDpp`; no
successor passport or material/machine evidence is minted. A finished Process
records the maker's signed assertion, not physical proof or measured duration.

The P7 outbox gives at-most-once remote objects plus eventual completion under
lost responses, failed steps, local failures and restarts. It relies on these
explicit assumptions:
- Nothing else writes Zenflows objects carrying an `ifzs` marker.
- A GraphQL error means a rollback.
- No request can still commit 60 s after it was sent (the client timeout is
  10 s).
- The Medusa and Zenflows clocks are within 5 min of each other. That holds
  locally: same host.

Blocked rows need an operator; there is no resolution UI beyond the status. This
is still not a cross-system transaction: a Zenflows object can exist minutes
before its row is checkpointed. General commerce envelopes retain the inherited ±5-minute acceptance
window without durable nonce revocation/audience enforcement; only session
challenges are one-use, in-memory and single-process. Registry changes are checked
at each buyer write; this is not full service/PDP authorization or bearer revocation.
An interrupted initial enrollment can leave an unused native customer, not a usable
unverified account. Keep every fixture endpoint local.
