# Local Zenflows marketplace bridge

Updated 2026-10-26 (P7 durable outbox). Earlier: 2026-10-23, Claude session
`cbf47518` / commit `e65e053`, pi session `01a16863`.
Work remains on `feat/zenflows-real-events`; no production/main changes.
Review snapshot: [bilingual field guide](review/README.md), backend PR #1 and GUI
PR #922; implementation pins `ef02bdb` / `9c503df`. The old Claude cloud artifact
is historical, not the maintained copy.

## What runs now

- **Stock:** seller-signed delivery → `raise` a per-listing EconomicResource →
  `transfer` to the order's buyer.
- **Build:** supplier-signed milestone → a finished ValueFlows **Process** →
  `produce` its output (provider = receiver = supplier, `outputOf` = Process) →
  `transfer` the output to the buyer. Quantity is the quoted lot quantity.
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
- A logged-in GUI buyer uses their **existing Interfacer browser wallet**, not
  the disclosed fixture customer. The immutable identity link supplies the live
  event receiver. Anonymous local demos retain the original fixture workflow.

Catalog/design/service inputs, merchant assertions and payments are still demo
fixtures. The live seller and unit are an explicit environment mapping. This is
not a production identity provider, remote PDP integration or supplier registry.

## Enable live events

Before `npm run dev:up`:

```bash
export INTERFACER_ZENFLOWS_URL=http://localhost:8000/api
export INTERFACER_ZENFLOWS_PROVIDER=<seller-agent-ULID>
export INTERFACER_ZENFLOWS_UNIT=<unit-ULID>
# Only for the anonymous fixture demo; verified buyers override this per order:
export INTERFACER_ZENFLOWS_RECEIVER=<demo-buyer-Person-ULID>
# Optional, if required by the local registry:
# export INTERFACER_ZENFLOWS_ADMIN=<server-only-admin-value>
npm run dev:up
```

`INTERFACER_ZENFLOWS_RESOURCE` is obsolete: each milestone creates its own
resource. No fixed receiver is needed for verified buyer sessions. An unset URL
keeps the standalone fixture demo working with local receipts only. A configured
write failure leaves **SYNC PENDING** (retried with backoff
`min(5 s · 2^attempts, 10 min)`), never a false LIVE badge. A milestone that
cannot be mapped (the anonymous fixture buyer without a configured receiver)
stays LOCAL ONLY, as before.

## Durable milestone outbox (P7)

Steps: build `process → create (produce, outputOf) → transfer`; stock
`create (raise) → transfer`.

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
`python3 scripts/p7-outbox-probe.py faults|restart-prepare|restart-verify`.

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
- This demo currently runs with **`GQL_AUTH_CALLS=false`, `AUTHZ_ENFORCE=false`**
  (and the local unchecked flag). Those are local test settings, not deployment
  advice. Enforced Zenflows writes still need the reviewed authorization/delegation
  transport; an admin environment variable alone does not implement that policy.

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

The match catalog is still seeded; seller identities still use the configured
single demo provider rather than a per-supplier registry. DPP ids remain references;
no successor passport or actual material/machine evidence is minted. A finished
Process records the signed demo assertion, not physical proof or measured duration.

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
