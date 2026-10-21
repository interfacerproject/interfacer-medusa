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

Authorization uses an explicit **CLI-only fixture controller stub**, not live
registered-key/PDP proof. No passport fields are published.

- [TESTING.md](TESTING.md) — cold-start, projection, observation, retry and limits.
- [Phase 0 findings](docs/phase0-findings.md) — version gate and source evidence.
- [Status](docs/phase0-STATUS.md) — concise handoff.
