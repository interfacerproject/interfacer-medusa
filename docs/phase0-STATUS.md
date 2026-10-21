# Phase 0 + first spike
- Works: pinned Medusa 2.10.3, isolated Postgres 15.19, real HTTP health probe and fixture projection.
- One draft + one variant; DPP referenced only; immutable module-owned binding and source hashes.
- Tested: idempotent/concurrent retries, completed-workflow recovery, denials, conflicts and DB immutability.
- Stubbed: CLI-only controller attestation; no live PDP/registered-key proof, IdentityLink or signed HTTP route.
- Deferred: partial-workflow repair, publication, inventory allocation, pricing, checkout and ledger writes.
- Handoff: TESTING.md and docs/phase0-findings.md; server and spike DB stopped, data retained.
- Single test command from this directory: `npm test` (passed).
