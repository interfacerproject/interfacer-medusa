# interfacer-medusa

First integration between the Interfacer project (ValueFlows/Zenflows + DPP)
and MedusaJS (headless commerce). Home for the integration spec, the local
Medusa v2 instance, and the Interfacer Commerce integration module.

**2026-10-23 — optional live local Zenflows bridge:** logged-in Interfacer buyers
prove their registered key and sign commerce writes with their browser wallet;
stock writes raise/transfer, builds write Process/produce/transfer. The GUI shows
the confirmed handover id with LIVE. Catalog/suppliers/payments remain fixtures.
See [current bridge protocol, setup and limits](docs/zenflows-bridge.md)
and the [maintained bilingual reviewers’ field guide](docs/review/README.md).
The local reviewer site includes it at http://127.0.0.1:3110/it/medusa.html.
`npm run test:unit` runs the service-independent matching/crypto/bridge tests.

- `docs/integration-spec.md` — the end-to-end integration specification
  (architecture, data model, design→services matching, phased plan).
  §16 records the first-spike decisions.

The P0–P6b **local marketplace** runs on Medusa **2.10.3**. With Docker,
Node 24 and Python 3 available:

```bash
npm run dev:up    # http://localhost:9000/dev/store (foreground)
npm run dev:down  # from another terminal, or Ctrl-C in the first
npm run test:all  # all nine harnesses, including real browser journeys
```

**LOCAL DEV — fixture/dev keys, not production.** Both stock delivery and build
production yield persisted ValueFlows receipts. With no live configuration the
REA sink and key→Person resolver remain labeled local stand-ins. [Final status and click paths](docs/marketplace-STATUS.md).
[Run, evidence, cleanup and limits](TESTING.md#p6b--storefront--end-to-end).
`npm test` alone still runs the original projection/immutability harness.

P6a authorization uses **real Ed25519 signed envelopes** on commerce writes.
Fixture Key → Person resolution remains a **LOCAL stand-in**; verified GUI
buyers use the live registry. Neither path is a live Zenflows authorization PDP.
Run `npm run test:p6a` for signed successes and unsigned/forged/wrong-key/
non-controller refusals across the stock and build flows.
[Current signing instructions and verified output](TESTING.md#p6a--real-signed-envelope-auth). Only the DPP ID reference is exposed, never passport
content. For GUI testing,
`npm start` enables the guarded loopback API at
`http://localhost:9000/dev/interfacer/listings`; `npm run test:http` verifies it
with curl. **Local testing only; never deploy.**

P1 adds idempotent EUR commerce seeding, guarded price/publication, and real
`GET /store/products` browsing with calculated price + DPP reference.
Run `npm run test:p1` for the full curl acceptance and automatic cleanup.
Manual: `npm run seed:commerce`, `npm run project`, then
`PRICE_EUR=19.95 npm run publish`.

P2 adds a local IdentityLink resolver, authenticated checkout, canonical DPP
order references, native one-unit inventory reservation and manual payment
authorization. Run `npm run test:p2` for the purchase + unbound-refusal +
concurrent no-double-sell test; it stops its servers and DB automatically.
Identity resolution remains development-only. P3/P5 add delivery/build production
and a local REA sink; P6a signs their actor operations too.

- [P2 testing](TESTING.md#p2--identity-bound-checkout) — exact calls, real responses, limits.
- [P2 findings](docs/phase2-findings.md) — verified auth/cart/payment/inventory APIs.
- [TESTING.md](TESTING.md#p1--storefront--publish) — P1 commands, publishable keys, real responses and limits.
- [P1 findings](docs/phase1-findings.md) — verified 2.10.3 commerce APIs.
- [Phase 0 findings](docs/phase0-findings.md) — version gate and source evidence.
- [Final status](docs/marketplace-STATUS.md) — real/local boundaries and browser journeys.
- [Historical Phase 0 status](docs/phase0-STATUS.md).

## Acknowledgements

### Funding

#### October 2021 – March 2023

This project was funded by the European Regional Development Fund (ERDF) as part of the INTERFACER project.

<img src="docs/assets/funding/logo_erdf2014.png" alt="EU ERDF Programme Logo" width="480">

#### January 2025 – December 2026

The further development of this project was supported as part of the "Fab City – Decentralized Digital Production for Urban Value Creation" project, funded by dtec.bw and supported by the European Union – NextGenerationEU.

<p>
  <img src="docs/assets/funding/dtec.bw_Logo_RGB_komplett.jpg" alt="dtec.bw logo" width="240">
  <img src="docs/assets/funding/nextgeneu_en.jpg" alt="Supported by the European Union – NextGenerationEU" width="360">
</p>
