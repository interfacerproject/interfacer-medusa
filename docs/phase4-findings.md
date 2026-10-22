# P4 — Design → compatible services matching (Medusa 2.10.3)

Verified: `npm run test:p4` passes against the existing default database and a
cold `interfacer_medusa_p4_acceptance` database. Node 24.19.0 / npm 11.17.0;
dependency pins unchanged. [Run instructions/output](../TESTING.md#p4--design--services-matching)
and [verbatim curl evidence](phase4-http-evidence.md).

## Structured data, not tags

The integration module now registers **Design**, **Service**, **BuildQuote**.
Design requirements and service capabilities are JSONB **structured objects**,
validated by strict runtime parsers in `matching.ts` on seeding, reads, matching,
and quote formation. They are not free tags or an inferred manufacturability
promise. Missing/unknown constraint keys, non-finite/nonpositive dimensions and
tolerances, empty/duplicate identifier lists, and non-integer quantities fail
closed rather than being ignored.

- Design: ID, name, nullable origin DPP reference; requirements:
  `process: string[]`, `materials: string[]`, `max_dimensions_mm:{x,y,z}`,
  `tolerance_mm`, `quantity` (integer 1..1,000,000).
- Service: ID, name, provider Person reference; capabilities:
  `processes: string[]`, `materials: string[]`, `build_volume_mm:{x,y,z}`,
  `min_tolerance_mm`; structured location `{country_code,city}`.
  Price API fields are `base_price_eur`, `per_unit_price_eur`.
  Service prices are stored as **integer cents**, never PostgreSQL real floats.
  Location is descriptive, not a shipping/geographic matching constraint.

All source examples in `matching-fixtures.ts` are explicitly **SYNTHETIC**:
two designs and six services, imaginary local providers/locations/prices. The
origin DPP is a synthetic reference only; no passport is loaded or minted.
No external manufacturing capability, capacity, certification or pricing data
was obtained or invented as real.

## Pure matching and fixed price

`matching.ts` has no Medusa/database/network dependency:
`matchServices(design,services)`, `rejectionReasons`, `fixedPrice`,
`formBuildQuote`, parsers and local canonical SHA-256 helpers.

Every required process and every material must be present (case-sensitive exact
identifier equality). Each x/y/z dimension must fit its corresponding build
volume axis; no rotation/nesting inference. Service minimum achievable tolerance
must be <= requested tolerance. Equal bounds match. All failures are returned
in fixed process/material/x/y/z/tolerance order with concrete required/available
values. Match ranking is ascending **total price for the design quantity**, then
lexicographic service ID (no locale-dependent ordering). Rejected services sort
by ID. Reversing service input order produces the same result.

EUR total = base + per-unit × quantity, calculated with integer cents. Unit/base
amounts must be nonnegative, <= EUR 1,000,000, at most two decimal places;
quote total must be > 0 and <= EUR 1,000,000. No discounts, tax, shipping, royalty,
escrow or extra inferred charges. Quantity affects price; no unmodeled throughput
or lead-time guarantee is implied.

## Immutable quote boundary for P5

`formBuildQuote` refuses incompatible pairs and deeply freezes detached terms.
Snapshot version `interfacer-fixed-build-v1` captures complete selected design
requirements, service capabilities, provider, location, origin DPP, price
breakdown, quantity and EUR total. A local key-sorted canonical JSON SHA-256
covers the snapshot; it is **not** a signature or a Zenroom envelope.

`build-matching.ts` stores each compatible pair's quote through generated module
CRUD, returning its generated `ifquote_...` ID. Unique `quote_hash` plus a
Postgres advisory lock serializes concurrent formation. Identical terms reuse
the same row/ID, including after restart. Stored row/snapshot integrity is checked
before reuse. Database triggers reject quote UPDATE, DELETE and soft-delete;
positive quantity/total and hash-format constraints apply. Later service edits
produce a different snapshot/hash/quote, leaving the old quote retrievable by ID.
Reverting the price reuses the original quote. This is runtime-tested.

P5 can reference the chosen match's **quote ID**, resolve `retrieveBuildQuote`
from this module, and use the persisted single supplier, quantity and price,
rather than mutable service rows or client prices. P4 deliberately creates **no
Medusa product/cart/payment/order/production event** for a design. P5 must add
purchase authorization, quote acceptance/lifecycle and any stale-offer policy;
there is no capacity reservation, expiry or supplier commitment in this dev seam.

Migration `Migration20261022003457.ts` and the DML snapshot cover the three
models; the generated initial price fields were changed to integer cents before
first application. A second `db:generate interfacer` confirmed **no model
changes**. `Migration20261022003458.ts` adds quote immutability and checks using
the existing module trigger. Both ran on existing and cold databases. No core
commerce tables are SQL-written by this implementation.

## Dev entry points and seed

- `npm run seed:matching`: typecheck/migrate and idempotent guarded CLI seed;
  retained fixture changes raise a seed conflict, not a silent overwrite.
- `GET /dev/interfacer/designs` → `{designs:[...]}`.
- `GET /dev/interfacer/services` → `{services:[...]}`.
- `POST /dev/interfacer/match {"designId":"ifdes_p4_organizer"}`
  → `{matches:[{service,quote}],rejected:[{service,reason}]}`, HTTP 200.
  Forms quotes for all compatible candidates; the caller chooses one by ID.
  Additional price/service/quantity fields are rejected (400), not forwarded.
  Unknown design is 404. GET does not seed/write. Reads paginate through all
  records instead of silently matching only the framework's first page.
- OPTIONS on all three routes; existing fixture opt-in, production denial,
  no-store and exact GUI origins localhost:3104/3000 shared unchanged.
  Internal seed/match entrypoints independently require local commerce mode.

**CORS is not authorization.** Anyone reaching this dev seam can form local
fixture quotes. Do not expose publicly. Real signed authorization remains P6.

## Verified results and cleanup

Nine pure tests cover each rejection reason, all three axes, equality,
multi-process/material coverage, price/quantity validation, deterministic ranking
including ties, incompatible quote refusal, canonical hashing, detached/deeply
immutable snapshots, and hashes changing with supplier/origin/quantity/price.

Real curl verifies seeded designs/services, organizer matches **EUR 19/36**,
panel matches **EUR 28** only, reasoned rejections, four concurrent retries,
one row per hash, repeat/restart persistence, CORS/preflights, disabled mode,
malformed/price-override/unknown-design no-write refusals. Read-only SQL checks
order/payment/receipt counts unchanged. CLI tests seed idempotency, direct-call
guard, hash uniqueness, DB mutation refusals, service price change/new quote,
and original quote restoration. Handler tests cover production denial before
any storage resolution.

Also passed: `npm run test`, `npm run test:http`, `npm run test:p1`,
`npm run test:p2`, `npm run test:p3`. Logs:
`.tmp/p4-verified.log`, `.tmp/p4-cold-verified.log`,
`.tmp/p4-regression-{test,test-http,test-p1,test-p2,test-p3}.log`.
HTTP evidence retained in `.tmp/p4-{cold-,}transcript.md` plus the checked-in
excerpt linked above.

Every temporary HTTP session stops via existing **per-PID signals**; the shell
EXIT trap stops only the labeled spike DB and retains data. Ports 9000/19000
were checked clear and DB status was `exited`. No git command, sibling access,
live Interfacer/Zenflows/DPP call, driven browser, P5 purchase or signed identity
proof was performed. No ledger DONE entry added; orchestrator verification is
separate.
