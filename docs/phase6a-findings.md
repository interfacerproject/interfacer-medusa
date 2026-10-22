# P6a — Real EdDSA signed-envelope auth

**Verified locally with real Node Ed25519, Medusa 2.10.3, Postgres and curl.**
This replaces P0–P5's plaintext controller/mode-only commerce authorization.
It is **not a live Zenflows registry/PDP integration** and does not complete
P6's GUI/browser/hardening tranche. No sibling repositories or git were used.

## Cryptography and transport

- Implementation: Node built-in **`node:crypto` Ed25519**, tested Node
  **24.19.0**, OpenSSL **3.5.7**. No new npm crypto dependency or lockfile change.
  `crypto.sign(null, bytes, privateKey)` and
  `crypto.verify(null, bytes, registeredPublicKey, signature)` perform real
  EdDSA; no boolean stub, injected allow decision, or plaintext fallback.
- `envelope-canonical.ts` is shared by signing CLI and verifier. The complete
  envelope is serialized as UTF-8 JSON with recursively sorted object keys
  (ECMAScript UTF-16 lexicographic order), JSON.stringify string/finite-number
  encoding, preserved array order, and no whitespace/newline. Non-JSON values
  are refused. This is the explicit local v1 canonicalization contract, not
  a claim of RFC 8785 compliance or verified Zenroom wire compatibility.
- Signed envelope has **exactly** `{op,params,person_id,nonce,issued_at}`.
  Nonce: 16 random bytes encoded as 32 lowercase hex characters. `issued_at`:
  UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, within ±5 minutes of verification time.
- Signature: 64 raw Ed25519 bytes, canonical standard base64 (88 characters).
  Wrapper: `{envelope,signature}` with no extra fields.
  HTTP carries `X-Interfacer-Auth: BASE64URL(JSON(wrapper))`, unpadded. Transport
  JSON need not have canonical key order: the verifier canonicalizes the
  envelope, compares it to server-derived expected op/params, then verifies.
  Body fields remain as in P0–P5. `actingPersonId` is ignored by the server;
  changing it cannot grant authority. Dev preflights permit the new header.
- Missing/bad signature, unknown key, wrong signing key, wrong controller,
  op/parameter/shape mismatch, expired/far-future time or resolver failure deny.
  Listing route returns 403; other protected routes use Medusa's native
  `NOT_ALLOWED` mapping (400). Neither creates protected side effects.
- **Replay limit:** nonce format/randomness and time window are checked, but no
  durable used-nonce registry exists. Identical valid envelopes may be retried
  within five minutes; existing immutable/idempotent business guards still
  apply. No single-use, cross-instance audience or distributed replay guarantee
  is claimed. Re-sign after expiry, including order-completion retries.

## Operation and controller binding

All these service entrypoints verify before their first protected write,
including idempotent retries. HTTP cannot inject an authorization callback.

| Operation | Exact signed params | Required registered Person |
| --- | --- | --- |
| `commerce.listing.create` | `{resource,dpp}` (entire supplied JSON documents) | `resource.primaryAccountable.id` |
| `commerce.listing.publish` | `{listing_id,priceEUR}` | immutable ListingBinding `seller_agent_id` |
| `commerce.listing.checkout.setup` | `{listing_id}` | same binding's seller |
| `commerce.order.authorize` | `{cart_id,currency_code,purchase,items}` | buyer from customer's immutable IdentityLink |
| `commerce.order.deliver` | `{order_id}` | seller resolved from native order line → immutable listing |
| `commerce.order.build.purchase` | `{cart_id,quote_id}` | buyer from authenticated cart/customer + IdentityLink |
| `commerce.order.produce` | `{order_id}` | provider from order offer → immutable quote |

Checkout `purchase` is exactly `checkoutEvidence(...).purchase` (P2/P5's
canonical buyer/link/listing or acceptance/build references). `items` contains
`{variant_id,quantity,unit_price}` for every actual cart line, sorted by variant
ID. Quantities/prices are numeric; currency is from the cart. Thus a signature
for another cart, price, quantity or chosen quote is not a checkout grant.
Customer session/Bearer authentication and cart-customer equality still apply.

Middleware verifies before stamping cart/line metadata, stores the signed
wrapper as `cart.metadata.interfacer_authorization`, and the **always-on native
`completeCartWorkflow.validate` hook re-verifies it** against the actual cart
snapshot and immutable evidence. Editable metadata alone is not authority, even
for internal workflow calls with local mode disabled. Signature evidence carries
into native order metadata; no private key does. Native price/inventory/build
single-supplier/payment/economic-event guards remain intact.

New bindings record `policy_version:local-ed25519-envelope-v1` and
`permission_epoch:local-keyring-v1`. Old immutable bindings retain historical
policy evidence; they are not modified or exempted from current verification.
No migration was needed. The retired `fixture-controller-check.ts` factory now
always throws, and the old `fixture-controller-stub` mode no longer enables dev
routes. There is no plaintext escape flag.

## What is local / not proven

`local-person-key-resolver.ts::resolveLocalPersonPublicKey` is the deliberately
named **LOCAL STAND-IN** seam for future Zenflows registered-key resolution.
It reads a server-selected JSON map Person ID → Ed25519 SPKI PEM public key;
requests cannot choose verification keys or enroll keys. Malformed/missing
registry files fail closed. Root scripts explicitly select
`INTERFACER_AUTH_MODE=signed-envelope-local` and a local keyring file; production
is still refused. The signature is real; enrollment/identity/controller facts
are not remote authority.

`docs/fixtures/auth-public-keyring.json` seeds the sample seller, two P4 service
providers and a second Person for denial tests. **Disposable, publicly checked-in
LOCAL DEMO private keys** are separately in `auth-private-keyring.json`; server
verification never reads that file. Do not deploy them or treat them as secrets.
`scripts/sign.cjs` copies keys to `.tmp/auth-{public,private}-keyring.json` and can
explicitly `--seed-person PERSON` for per-run buyer identities using actual
`generateKeyPairSync('ed25519')`. That is trusted local test enrollment, not a
network auth bypass. Tests enroll buyers before using the existing local
IdentityLink route; SQL in the signing harness only reads canonical facts.

Creation still receives synthetic resource/controller/DPP documents, rather than
loading authoritative remote resource ownership. IdentityLink enrollment,
commerce/matching seeds and quote matching remain explicit loopback-only local
setup seams; they do not grant a protected operation without its actor key.
Seller eligibility defaults to controller eligibility (no KYC/extra gate), as in
the plan's decision. The REA sink remains the P3/P5 local stand-in.

The tranche's **sign canonical operation / verify with actor's registered key**
pattern is implemented, but no live `verify_graphql`, Zenroom adapter, Zenflows
PDP call, revocation epoch, delegation, audience isolation or browser test was
executed/claimed. The earlier integration spec's fuller production envelope is
not silently presented as implemented. Those remain future integration and
hardening work.

## Actual verification and isolation

All requested commands exited **0** against a newly created owned container
`interfacer-medusa-p6a-verified-db`, `postgres:15-alpine`, loopback **55436**, DB
`interfacer_medusa`. Earlier containers were not started/stopped/modified.
Initial `npm test` applied all migrations cold; subsequent runs retained state.
A standalone `npm run test:p6a` also passed on the fresh database
`interfacer_medusa_p6a_cold` in that same owned container; output is retained in
`.tmp/p6a-cold.log`, and the last P6a HTTP transcript is from that cold run.
[Exact commands and selected output](../TESTING.md#p6a--real-signed-envelope-auth).

- `npm test`, `test:http`, `test:p1`, `test:p2`, `test:p3`, `test:p4`, `test:p5`
  all run protected operations using actual signatures, including CLI projection
  and publish and the raw concurrent HTTP completion/delivery/produce paths.
- `test:p6a`: four crypto/contract tests including **RFC 8032 vector 1**, a
  changed-signature refusal, CLI/canonical/Unicode round trip, unknown key,
  resolver outage, operation/params/time/shape checks and retired-stub denial.
- Real curl: **all seven operations** test unsigned, forged 64-byte signature,
  wrong-key (controller claimed but another private key signs), and a valid
  signature from a registered non-controller. Before/after SQL compares both
  row counts and hashes of every stored field in 17 relevant native/integration
  tables, not just HTTP status. Additional listing op/params/time/nonce/unknown
  field/unknown Person refusals pass. Correctly signed operations succeed.
- P6a reuses P2's actual stock purchase/race/delivery and P5's quote acceptance,
  native order/manual payment capture, production concurrency and restart.
  No event on payment alone; exactly one transfer/produce fact on the milestone.
- P5 additionally tests an internal native completion with canonical editable
  metadata but **no signature**; the always-on hook refuses it.

Artifacts: `.tmp/p6a-regression-{test,test-http,test-p1,test-p2,test-p3,test-p4,test-p5,test-p6a}.log`,
`.tmp/p6a-transcript.md` and `.tmp/p6a-*-server.log`/`p6a-server.log`.
Transcripts contain disposable sessions and signed requests; keep local.
Servers stop through the existing **per-PID signals** before CLI stages and on
failure. EXIT stops only the created DB; data is retained. No running server or
ledger DONE entry is left behind. P6 UI/end-to-end browser verification is not
part of P6a.
