# Marketplace hardening: outbox, real catalog, real sellers, enforced Zenflows authz

Date: 2026-10-26. Continues pi session `01a16863` (Medusa `70e9b03`, GUI `a857775`).
Branches: `interfacer-medusa` `feat/zenflows-real-events` (PR #1) and
`interfacer-gui` `feat/medusa-marketplace-gui` (PR #922). No main changes, no merges.

The user asked to "proceed with everything" pi proposed: Beads `interfacer-gui-nhn`
(outbox), `interfacer-gui-h0n` (real catalog), then active authorization and real
seller identities without demo keys. They opted out of a question round, so every
"how" below is the builder's call unless it restates a Beads/earlier decision.

## Why

The demo works, but it is not yet an integration you can trust:

1. A milestone writes up to three Zenflows objects (Process, produce/raise, transfer)
   and then a local receipt. A lost response, a failed transfer or a failed local
   insert leaves a half-written ledger that is never repaired. Retrying blindly
   would duplicate economic events.
2. Designs, services, capabilities and prices are synthetic seeds.
3. Sellers and suppliers are fixture keys signed by a dev signer. The live event
   provider is one environment variable.
4. Zenflows runs with `GQL_AUTH_CALLS=false` and `AUTHZ_ENFORCE=false`. Medusa
   writes as an unauthenticated/admin caller, which the enforced policy denies.

## Goals

- **G1 Outbox (nhn).** Every live milestone is durable, recoverable after errors and
  restarts, and produces each remote object at most once. Ambiguous writes are
  reconciled by reading Zenflows, never by a blind replay. Covered: lost response,
  failed transfer, local DB failure, restart, changed payload under the same
  idempotency key.
- **G2 Real catalog (h0n).** Match designs and services are real Zenflows resources,
  registered explicitly by the agent accountable for them, with strictly validated,
  versioned requirements/capabilities. Manufacturability is never inferred from tags.
  DPP content is never exposed or copied, only a reference id.
- **G3 Real sellers.** In live mode, listing, publish, deliver and produce operations
  are signed by the real seller's wallet, verified against the key Zenflows has
  registered for them. Fixture keys and the dev signer are refused in live mode.
  The event provider comes from the binding, not from the environment. Stock sales
  transfer the seller's real resource instead of raising a stand-in.
- **G4 Enforced authz.** With Zenflows `GQL_AUTH_CALLS=true` and `AUTHZ_ENFORCE=true`,
  marketplace writes happen as the seller. The seller's browser signs each exact
  Zenflows request body. Medusa only relays signed bodies and cannot act for a seller
  on its own. Medusa's own read-only Zenflows account is used for reconciliation and
  registry reads.

## Non-goals and anti-goals

- No production deployment, no merge, no main-branch change in GUI or Zenflows.
- No Zenflows server changes unless strictly unavoidable. The existing signed-call
  contract (`zenflows-user` + `zenflows-sign` over the raw body) already proves the
  user, so none are planned.
- **Anti-goal:** an "exactly-once" claim that rests on a check that can race or lose
  state. A step that cannot be proven absent is deferred or blocked, never re-sent.
- **Anti-goal:** a server-held seller private key, or a Medusa credential that can
  write events in a seller's name.
- **Anti-goal:** breaking the standalone fixture harness (`npm run test:all`, 9
  suites). Fixtures stay valid only when no Zenflows URL is configured.
- Not in scope: payments, returns, quote expiry, DPP minting, remote capacity.

## Design

### G1 — Durable milestone outbox

- New module table `interfacer_zenflows_sync`, one row per order (unique `order_id`,
  unique `receipt_id`, unique random `marker` `ifzs-<32 hex>`). The row stores the
  immutable milestone payload (target URL, action, provider, receiver, unit, spec
  name, quantity, time, names, tracking id, optional source resource) and its
  SHA-256 `payload_hash`.
- **Local first:** receipt and sync row are inserted in **one DB transaction**
  before any remote write. A failed insert therefore never leaves remote objects.
  The receipt's `zenflows_event_id` starts null and is set once, in the same
  transaction that marks the sync `done`.
- **Marker on every remote object:** the Process note, event notes and the created
  resource's note carry the marker. A `transfer` destination inherits the source note.
  The Zenflows `economicResources(filter:{note})` filter is an `ILIKE %v%` match. The
  marker uses only `[a-z0-9-]`, so it is a literal match.
- **Checkpoint protocol per step** (`process` → `create` → `transfer`): persist
  `inflight_step` + `inflight_at` *before* sending, then persist the returned id and
  clear `inflight_step`.
  - A definite rejection (GraphQL `errors`, HTTP 4xx) clears the inflight step.
    Zenflows' `Multi` rolled the write back.
  - An ambiguous failure (network, timeout, 5xx, malformed reply, a local save
    failing after the send) keeps it.
- **Reconciliation before any re-send** of an inflight step:
  - `create`: resources with the marker whose `previous` holds the raise/produce
    event for that same resource.
  - `transfer`: resources with the marker whose `previous` holds a transfer from the
    checkpointed resource.
  - `process`: Zenflows ids are time-ordered (48-bit ms prefix). A scan of
    `processes(after: <id lower bound of inflight_at − 5 min>)` for the marker is
    bounded.
  - Results:
    - one match: checkpoint it, after checking provider, receiver, quantity and
      `outputOf`.
    - several matches: `blocked: zenflows_reconcile_duplicate`.
    - a field mismatch: `blocked: zenflows_reconcile_mismatch`.
    - none, while the original attempt could still be in flight (settle window
      60 s): defer.
    - none, after the window: clear the inflight step and send again.
- **Changed payload under the same key:**
  - The stored hash is re-checked before every advance. A mismatch means
    `blocked: zenflows_sync_payload_tampered`, with zero remote calls.
  - A milestone retry recomputes the payload from immutable receipt facts. A
    different hash means HTTP 409 `zenflows_sync_payload_conflict`.
  - A changed configured Zenflows URL means `blocked: zenflows_sync_target_changed`.
- **Recovery:**
  - A per-row advisory lock serialises executors.
  - A Medusa scheduled job (every minute) advances due rows, which covers restarts.
  - The milestone call advances inline, so the happy path is still LIVE immediately.
  - Backoff is `min(5 s · 2^attempts, 10 min)`.
- Receipts created before the outbox existed stay `legacy_local_only`. They carry no
  marker, so recovering them could duplicate events.
- API/GUI: receipts carry `zenflows_sync { status, attempts, last_error, ids }`. The
  GUI shows LIVE, SYNC PENDING (with the last error), SYNC BLOCKED (with the reason),
  or LOCAL ONLY.

### G2 — Registered catalog

- `interfacer_catalog_entry`:
  - one per (Zenflows resource id, kind ∈ {design, service}).
  - stores the owner agent id (the resource's `primaryAccountable` at registration),
    the registered resource spec name, a `schema_version`
    (`interfacer-build-requirements-v1` / `interfacer-fabrication-capabilities-v1`),
    the validated document and its hash, an optional `origin_dpp_id` reference
    (design only), and `revision`.
- Registration is a signed operation (`catalog.design.register` /
  `catalog.service.register`):
  - The signer is verified against their Zenflows-registered key.
  - Medusa reads the resource from Zenflows. It requires that it exists, conforms
    to the expected Interfacer spec (Design / Service project specs), and has
    `primaryAccountable == signer`. An organisation is accepted when the signer is
    its admin; that comes in G4 and is not supported before then.
  - The document is parsed with the same strict parsers as `matching.ts`. Unknown
    keys are rejected.
- Re-registration with a new document creates a new `revision`. Existing quotes keep
  their immutable snapshot.
- Matching uses only registered entries:
  - At match time each entry is revalidated against Zenflows: the resource still
    exists and the same agent is still accountable. Otherwise the entry is excluded
    with a reason: `catalog_owner_changed` / `catalog_resource_missing`.
  - `provider_person_id` of a quote is the service's registered owner.
- Synthetic seeds remain only for the standalone harness (no Zenflows URL).
- GUI: `/market/offer` lets a logged-in user pick one of their own Design or Service
  projects (from Zenflows), fill the structured form, sign and register.
  `/market/build` lists registered designs.

### G3 — Real sellers

- In live mode (`INTERFACER_ZENFLOWS_URL` set):
  - `verifyCommerceOperation` and seller milestone checks use only the Zenflows
    registry key. A fixture keyring hit is refused with `fixture_identity_forbidden`.
  - `/dev/store/sign` returns 403.
- Stock listings from real resources:
  - The seller signs `commerce.listing.create` with `{resource_id, dpp_id?}`.
  - Medusa reads the resource from Zenflows (accountable == custodian == signer,
    positive onhand) and snapshots its hash.
  - Delivery `transfer`s that resource (quantity 1) to the buyer, with a marker on
    the destination (`newInventoriedResource.note`). No raise.
- Build milestone: `provider` = the quote's registered service owner.
- GUI seller console `/market/sales`:
  - lists the seller's listings and orders, and pending/blocked syncs;
  - "Mark delivered" / "Mark produced" are signed with the seller's own wallet.
  - The wallet allowlist gains seller operations, signed only when
    `operation.person === self`.

### G4 — Enforced Zenflows authz (seller-signed relay)

- Sync rows gain `transport: "service" | "seller-signed"`. With
  `INTERFACER_ZENFLOWS_SIGNED_WRITES=true` every write step needs a seller signature:
  - `GET /dev/interfacer/zenflows-sync/:id/next` returns the exact GraphQL body for
    the next step. It is built only by Medusa from the stored payload.
  - The seller's GUI parses the body. It checks the mutation is one of the three
    allowed shapes, that provider is self and that the receiver/quantity match the
    order. Then it signs with the existing Zenflows request signer and posts
    `{step, body_hash, signature}`.
  - Medusa verifies that the signature covers its own body hash. It sends the body
    with `zenflows-user` (the seller's username from Zenflows) and `zenflows-sign`,
    then checkpoints.
  - Signatures are never stored after use.
- Reads (registry, spec, reconciliation) use a dedicated Medusa Zenflows Person
  ("Interfacer marketplace service") whose key stays server-side and never writes.
- Recovery when signed writes are needed: the background job only reconciles. The
  seller console resumes pending rows the next time the seller opens it.

## Constraints

- Medusa 2.10.3, Node 24, Postgres. Module tables only, via migrations. Never touch
  Medusa core tables with SQL.
- Tests: `node:test` + ts-node (`npm run test:unit`). The GUI uses its own unit runner
  plus Playwright live journeys.
- Commit per phase with `--no-verify` in the GUI worktree (broken husky hook), after
  running the checks manually. Push the feature branches and update the draft PRs.
- Beads, the PR descriptions and the reviewer guide (`docs/review`) track the work.

## Left to the builder

File layout inside the module, exact GraphQL selections, GUI copy and styling
(follow the existing market components), and the scheduled-job name.
