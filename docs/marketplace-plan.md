# Interfacer × Medusa marketplace — autonomous build plan + loop ledger

**Goal (DONE definition):** a fully functional local marketplace, demoable in the
browser, where (a) Interfacer EconomicResources + their DPP are **stock
products** you can browse and **buy** (test payment) and completing the order
records a **ValueFlows economic event**; and (b) a **design** can be matched to a
compatible **service** and bought as a **build**, with a production milestone
recording a VF event. Auth on commerce writes is a **real EdDSA signed
envelope** (not the fixture stub). Everything runs locally; every phase is
verified by tests + HTTP + a driven browser click. No fakery; local stand-ins
are labeled and swappable for live Zenflows/DPP.

**Orchestration:** pi (`openai-codex/gpt-6.1-sol`) executes each phase from a
tight brief; the orchestrator (Claude) verifies on the running system, commits,
and advances. State lives here + in git; resume from the last `DONE` line.

## Decisions (orchestrator, authority delegated by the owner — §14.1)

- **Merchant of record:** one platform merchant; suppliers fulfill.
- **Who may sell:** proven resource controller (EdDSA-signed) **and** a seller-
  eligibility flag; default: the controller is eligible (flag auto-set on first
  listing). No separate KYC this build.
- **Guest purchases:** no — a bound customer (IdentityLink to an Interfacer
  Person) is required to check out an Interfacer-backed order.
- **Economically complete = delivery, not checkout:** the REA event fires when
  an order is marked **delivered/fulfilled** (admin/supplier action), never on
  payment capture alone.
- **Build payment:** fixed-price, paid upfront via Medusa's **manual/test**
  payment provider. No escrow, no milestone billing (out).
- **Royalties:** none implicit; designers are paid only via an explicit price
  line if present. (No royalty engine this build.)
- **Successor passport:** not minted this build; the order + REA event
  **reference** the origin DPP id. (Flagged for a later slice.)
- **Multi-supplier builds:** rejected; exactly one supplier per build order.
  Mixed-supplier carts rejected.
- **Returns/refund:** refund = financial only (test provider); physical-return
  fact is out of scope.
- **REA event sink:** a local `rea-receipts` store in the integration module,
  emitting the real ValueFlows event shape (provider/receiver/action/resource/
  quantity), triggered by the **real** Medusa order/fulfillment events. Clearly
  labeled a local stand-in for a live Zenflows economic-event write; swappable.
- **Identity:** Medusa customer ⇄ `IdentityLink` to an Interfacer Person id,
  bound at registration/checkout via a local resolver (no live Zenflows auth).
- **Auth:** commerce writes (`commerce.listing.create`, `commerce.order.*`)
  require a real EdDSA signature over the operation, verified with the same
  `verify_graphql`/EdDSA scheme as the rest of the tranche, against the actor's
  key; the key→Person resolution is a local resolver stand-in (labeled).

## Phases (each: pi builds → orchestrator verifies on the running system → commit → ledger)

- **P1 — Storefront + publish.** Give a listing a price in a currency + sales
  channel; publish it; a storefront route (Medusa store API or a minimal page)
  lists the published resource-backed products with their DPP reference.
  *Accept:* GET store products returns the published product with price + DPP
  metadata; visible in the browser.
- **P2 — Identity-bound checkout.** Customer register/login; IdentityLink to a
  Person; cart → add the listed variant → complete with the test payment
  provider → order placed. Server-controlled price (never client). Unbound
  customer cannot complete an Interfacer-backed checkout; stock can't be double-
  sold.
  *Accept:* a bound customer completes one purchase in the browser; order exists;
  an unbound attempt is refused.
- **P3 — Order → REA event.** On fulfillment/delivery, write a `rea-receipts`
  VF economic event (transfer) referencing the resource + DPP + buyer; idempotent
  per order; no event on mere payment.
  *Accept:* marking the order delivered produces exactly one REA receipt with the
  right provider/receiver/resource; re-trigger makes no duplicate.
- **P4 — Design → services matching.** A design (requirements) + services
  (capabilities) model; a deterministic matching that yields compatible services;
  a build **offer/quote** (fixed price) for a chosen service.
  *Accept:* a sample design matches the seeded compatible service(s) and not the
  incompatible one; a quote is formed with a price.
- **P5 — Build purchase + production trace.** Buy a build offer (test payment);
  one supplier; a production milestone (admin "produced"/"delivered") records a
  VF produce/transfer event referencing the design + service + origin DPP.
  *Accept:* a build order completes; the milestone writes the REA event; multi-
  supplier is rejected.
- **P6 — Real signed auth + hardening + end-to-end.** Replace the fixture-
  controller stub with real EdDSA signed-envelope verification on the commerce
  writes; a GUI/storefront surface stitching browse→buy→order→event and
  design→match→build; final full e2e verification driven in the browser; honest
  `docs/marketplace-STATUS.md`.
  *Accept:* a non-signed/forged write is refused; the full flow is demoable in the
  browser; all phase checks green.

## Ledger (append-only; DONE = verified by the orchestrator on the running system)

- Phase 0: DONE (pinned Medusa 2.10.3, spike projection, dev endpoint, GUI tester) — verified in-browser round-trip.
- Phase 1: DONE (storefront + publish) — verified: GET /store/products shows published product EUR 19.95 + resource/DPP refs; idempotent; fixture-disabled refused. (orchestrator ran npm run test:p1 -> ALL P1 CHECKS PASSED)
- Phase 2: DONE (identity-bound checkout) — verified: bound customer buys at server price EUR 19.95 (client 0.01 rejected), DPP line metadata, manual payment authorized; unbound refused; no double-sell. (orchestrator ran npm run test:p2 -> ALL P2 CHECKS PASSED)
- Phase 3: DONE (order -> ValueFlows event) — verified: delivery writes exactly one rea-receipt (transfer, provider/receiver/resource/DPP/order), idempotent across concurrency + restart, none on payment; immutable. (orchestrator ran npm run test:p3 -> ALL P3 CHECKS PASSED)
- Phase 4: DONE (design -> services matching) — verified: structured matching (compatible services priced quotes; rejections missing_material/tolerance/wrong_process/too_big); quotes persisted, hashed, immutable, restart-safe; 9 pure tests. (orchestrator ran npm run test:p4 -> ALL P4 CHECKS PASSED)
- Phase 5: DONE (build purchase + production trace) — verified: build order carries design/service/quote/origin-DPP; one-supplier/service-swap guard; production milestone writes one produce VF event (provider/receiver/design/service/DPP/hash, qty), idempotent (concurrency+restart); no event on payment alone. (orchestrator ran npm run test:p5 -> ALL P5 CHECKS PASSED)
- Phase 6a: DONE (real EdDSA signed-envelope auth) — verified: real Ed25519 on all 7 commerce ops; unsigned/forged/wrong-key/non-controller refused with no state change; prior stock+build flows pass signed; npm run sign helper. Limits (honest): key->Person = local resolver stand-in; no nonce-replay prevention yet. (orchestrator ran npm run test:p6a -> ALL P6a CHECKS PASSED)
