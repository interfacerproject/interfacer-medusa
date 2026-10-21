# Phase 0 + first spike
- Works: pinned Medusa 2.10.3, isolated Postgres 15.19, real HTTP health probe and fixture projection.
- One draft + one variant; DPP referenced only; immutable module-owned binding and source hashes.
- Tested: idempotent/concurrent retries, completed-workflow recovery, denials, conflicts and DB immutability.
- Stubbed: local CLI + guarded dev-HTTP controller attestation; no live PDP/registered-key proof, IdentityLink or signed HTTP route.
- GUI testing: `npm start` → http://localhost:9000/dev/interfacer/listings; `npm run test:http` passed (curl creation, GET, retry, denial, CORS, disabled-mode guards). Exact responses in TESTING.md; never deploy this fixture-auth surface.
- Deferred: partial-workflow repair, publication, inventory allocation, pricing, checkout and ledger writes.
- Handoff: TESTING.md and docs/phase0-findings.md; server and spike DB stopped, data retained.
- Single test command from this directory: `npm test` (passed).
