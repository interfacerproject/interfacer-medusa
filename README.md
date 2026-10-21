# interfacer-medusa

First integration between the Interfacer project (ValueFlows/Zenflows + DPP)
and MedusaJS (headless commerce). Home for the integration spec, the local
Medusa v2 instance, and the Interfacer Commerce integration module.

- `docs/integration-spec.md` — the end-to-end integration specification
  (architecture, data model, design→services matching, phased plan).
  §16 records the first-spike decisions.

Phase 0 and a locally tested first spike are implemented with Medusa **2.10.3**.
Run `npm test` to project a sample resource + passport into a draft with one
variant and an immutable, idempotent module-owned mapping.

Authorization uses an explicit **local fixture controller stub**, not live
registered-key/PDP proof. Only the DPP ID reference is exposed, never passport
content. For GUI testing,
`npm start` enables the guarded loopback API at
`http://localhost:9000/dev/interfacer/listings`; `npm run test:http` verifies it
with curl. **Local testing only; never deploy.**

P1 adds idempotent EUR commerce seeding, guarded price/publication, and real
`GET /store/products` browsing with calculated price + DPP reference.
Run `npm run test:p1` for the full curl acceptance and automatic cleanup.
Manual: `npm run seed:commerce`, `npm run project`, then
`PRICE_EUR=19.95 npm run publish`.

- [TESTING.md](TESTING.md#p1--storefront--publish) — P1 commands, publishable keys, real responses and limits.
- [P1 findings](docs/phase1-findings.md) — verified 2.10.3 commerce APIs.
- [Phase 0 findings](docs/phase0-findings.md) — version gate and source evidence.
- [Status](docs/phase0-STATUS.md) — concise handoff.
