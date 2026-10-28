# P2 — Real actors: registered catalog, real listings, seller-signed milestones: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In live mode (`INTERFACER_ZENFLOWS_URL` set), every catalog entry, listing and milestone belongs to a real Zenflows agent who signed it with the key Zenflows has registered for them. Fixture keys and the dev signer are refused.

**Architecture:**
- A registry adapter reads Zenflows instance specs and resources. An actor policy decides which key may verify an operation.
- Catalog entries and live listings are created by signed owner operations, after Medusa re-reads the resource from Zenflows.
- Milestones are signed by the seller's own wallet through a seller console in the GUI.
- The outbox payload gains the provider from the binding or quote. Stock sales transfer the seller's real resource, with no stand-in raise.

**Tech Stack:** Medusa 2.10.3 module, node:test, Next.js GUI with the `@dyne/interfacer-client` SDK, Playwright live journeys.

**Spec:** `docs/superpowers/specs/2026-10-26-marketplace-hardening-design.md` (G2 + G3).

## Global Constraints

- Live mode is exactly `Boolean(process.env.INTERFACER_ZENFLOWS_URL)`. Standalone behaviour and the 9-suite harness stay unchanged.
- Schema versions (exact): `interfacer-build-requirements-v1`, `interfacer-fabrication-capabilities-v1`.
- The DPP reference is derived, never owner-asserted and never copied: `zenflows:traceDpp:<resource id>` (Zenflows' native `traceDpp` of that resource).
- Signed operations (exact):
  - `catalog.design.register` `{resource_id, document}`
  - `catalog.service.register` `{resource_id, document}`
  - `commerce.listing.live.create` `{resource_id}`
  - existing `commerce.listing.publish`, `commerce.listing.checkout.setup`, `commerce.order.deliver`, `commerce.order.produce`.
- Reasons (exact):
  - `fixture_identity_forbidden`
  - `dev_signer_disabled_live`
  - `catalog_owner_required`
  - `catalog_spec_mismatch`
  - `catalog_resource_missing`
  - `catalog_owner_changed`
  - `listing_resource_unavailable`
- Owners must be Persons in this phase. Organisation-owned resources are refused with `catalog_owner_required`; G4 adds org-admin acting.
- Receipts, catalog entries and live bindings are immutable rows (existing trigger pattern). A new document is a new revision.

## Review Focus

- A resource sold or transferred to someone else after registration: matching must exclude it with `catalog_owner_changed`, never quote it.
- The same owner registering an identical document twice: idempotent, with no second revision.
- A seller listing a resource whose accountable ≠ custodian, or with onhand 0: refused before any Medusa product exists.
- A buyer who is also the seller (self-purchase): refused, so a transfer to self cannot happen.
- A seller console request for another seller's order: refused with the same reason as an unknown order, so other sellers' order ids do not leak.

---

### Task 1: Registry adapter + actor policy

**Files:** Create `medusa/src/modules/interfacer/zenflows-registry.ts`. Modify `zenflows-person.ts`, `delivery.ts`, `production.ts`, `publish-listing.ts`, `checkout-setup.ts`, `api/dev/store/sign/route.ts`. Test `src/tests/zenflows-registry.test.ts`.

**Interfaces (produces):**
- `liveMode(): boolean`
- `readInstance(cfg?, fetchImpl?): Promise<{ specs: { design; service; product }: {id,name}; unitOne: string }>`
- `readResource(id, cfg?, fetchImpl?): Promise<ZenflowsResource | null>`, where `ZenflowsResource = { id; name; spec: {id,name}; accountable: string; custodian: string; onhand: number; accounting: number; unit: string }`
- `verifyCommerceOperation(auth, op, params, person)`. Live mode: registry key only, and a fixture keyring id is refused with `fixture_identity_forbidden`. Standalone: unchanged.
- All seller and owner verifications go through `verifyCommerceOperation`.

- [ ] Tests:
  - live mode refuses a fixture person even with a valid fixture signature;
  - standalone still accepts it;
  - `readResource` maps the GraphQL fields, and returns null when `economicResource` is null;
  - an `instanceVariables` failure throws.
- [ ] Implement; `npm run test:unit` + typecheck green.

### Task 2: Registered catalog

**Files:** Create `models/catalog-entry.ts`, `migrations/Migration20261026130000.ts` (table + immutable trigger), `catalog.ts`, `api/dev/interfacer/catalog/route.ts` (GET), `catalog/designs/route.ts`, `catalog/services/route.ts` (POST, signed). Modify `build-matching.ts` (live: catalog source + exclusions), `api/dev/interfacer/match`, `designs`, `services`. Test `src/tests/catalog.test.ts`.

**Interfaces:**
- `parseCatalogDocument(kind, document)`. Strict keys; a design's `requirements` go through `parseDesign`, a service's capabilities/prices/location through `parseService`.
- `catalogEntryToDesign(entry): DesignData`, with `id` = Zenflows resource id and `origin_dpp_id` = derived reference.
- `catalogEntryToService(entry): ServiceData`, with `provider_person_id` = owner.
- `registerCatalogEntry(container, kind, auth)`:
  1. verify the signer (Task 1);
  2. read the resource and require spec + `accountable === signer`;
  3. under the lock `interfacer-catalog:<resource>`, an identical hash returns the existing entry; otherwise insert `revision + 1`.
- `listLiveCatalog(integration, cfg)`: latest revision per resource, revalidated against Zenflows. Returns `{ designs, services, excluded: [{resource_id, kind, reason}] }`.

- [ ] Tests (pure):
  - unknown key / wrong schema version / missing prices are refused;
  - the mapping uses the resource id and the owner;
  - the derived DPP reference format.
- [ ] Implement; tests + typecheck green.

### Task 3: Live listings from real resources

**Files:** Create `live-listing.ts`, `api/dev/interfacer/listings/live/route.ts`, migration `Migration20261026130100.ts` (nullable `zenflows_unit_id` on `interfacer_listing_binding`). Modify `project-resource.ts` (extract the post-verification projection into `projectVerifiedResource`).

**Interfaces:** `createLiveListing(container, auth)`:
1. op `commerce.listing.live.create` `{resource_id}`, verified for `envelope.person_id`;
2. read the resource, require spec Product, `accountable === custodian === signer` and `onhand >= 1`;
3. passport `{ID: "zenflows:traceDpp:"+id, ProductID: id}`, `policy_version: "zenflows-registry-v1"`, `zenflows_unit_id` = the resource unit.

- [ ] Implement; typecheck. The live journey test covers it (Task 6).

### Task 4: Live milestones (provider from binding/quote, real-resource transfer)

**Files:** Modify `zenflows-sync.ts` (payload `source_resource_id?: string`: create skipped, transfer carries `newInventoriedResource.note` with the marker), `zenflows-outbox.ts` (`syncPayloadFor` takes `provider`, `unit`, `source_resource_id`), `delivery.ts`, `production.ts`, `zenflows-event.ts` (provider/unit env optional), plus tests in `zenflows-sync.test.ts`.

- [ ] Test: with a source resource, nothing is raised and exactly one transfer of that resource happens. The destination carries the marker; a lost response is reconciled.
- [ ] Implement. A live binding (`policy_version === "zenflows-registry-v1"`) uses the binding's seller, unit and source resource. A live quote uses the quote provider and `readInstance().unitOne`.

### Task 5: Seller session + console endpoints; demo surfaces off in live mode

**Files:** Modify `storefront/dev.ts`:
- `demoSigningOperation` → `signingOperation`: the buyer as before; for deliver/produce, the authenticated person must be the order's seller/provider, and then `person` = that seller.
- the scene in live mode: context only, plus the live listings.

Modify `api/dev/store/config/route.ts`, `scripts/dev-store.py` (live mode skips the fixture bootstrap and writes a context-only scene), `store-client.py`. Create `api/dev/store/seller/route.ts` (GET: the authenticated person's listings, catalog entries, sold orders, build orders, receipts + sync state).

- [ ] The seller and the buyer use the same `commerce.session.create` login. A self-purchase (buyer person === seller) is refused with `self_purchase_forbidden` at checkout preparation.

### Task 6: GUI — wallet roles, offer + sales pages, live catalog

**Files:**
- Modify `lib/market/wallet.ts` (`createMarketWallet`: buyer + seller/owner ops, signed only for `person === self`), `lib/market/client.ts` (live scene, `registerCatalog`, `createListing`, `publishListing`, `sellerDashboard`, milestone via wallet), `lib/market/types.ts`, `hooks/useMarketClient.ts`, `pages/market/index.tsx`, `pages/market/build.tsx`.
- Create `pages/market/offer.tsx` (my Zenflows Design / Service / Product resources via the SDK client, plus structured forms), `pages/market/sales.tsx` (seller console), `tests/market-sellers.spec.ts`.
- Tests: `tests/unit/market-wallet.test.ts`, `tests/unit/market-client.test.ts`.

- [ ] Unit:
  - the wallet signs seller ops only for self and refuses unknown ops;
  - the client never falls back to the dev signer in live mode.
- [ ] Live journey (`MARKET_LIVE_E2E=1`):
  1. create a seller Person plus Design, Service and Product resources in Zenflows, and a buyer Person;
  2. the seller registers the design and the service and lists the product (GUI forms);
  3. the buyer matches, buys the build and buys the stock;
  4. the seller marks produced/delivered in `/market/sales`;
  5. Zenflows shows provider = seller and receiver = buyer, a finished Process, and the stock destination owned by the buyer carved out of the seller's real resource.
- [ ] Commit both repos, push, update PRs and Beads `interfacer-gui-h0n`.
