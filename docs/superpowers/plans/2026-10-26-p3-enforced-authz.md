# P3 — Enforced Zenflows authorization (seller-signed relay): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The marketplace works against a Zenflows running `GQL_AUTH_CALLS=true`, `AUTHZ_ENFORCE=true`, `AUTHZ_ALLOW_UNCHECKED=false`. Every economic write is signed by the seller/maker it names as provider. Medusa never holds a credential that can write in a seller's name.

**Architecture:**
- **Reads** (registry keys, resources, instance, reconciliation) go through a dedicated Medusa service Person, which signs read bodies.
- **Writes:** when `INTERFACER_ZENFLOWS_SIGNED_WRITES=true`, the outbox executor never sends a write unsigned. It stops at each write step with `awaiting_seller_signature:<step>`. The seller's browser fetches Medusa's exact body for that step, checks it, signs it with the existing Zenflows request signer and posts the signature back.
- Medusa verifies that signature itself against the provider's registered key, relays body + signature to Zenflows once, and checkpoints. The signature is never stored.

**Tech Stack:** Medusa module + routes, node:crypto Ed25519, `@dyne/interfacer-client` `signGraphQLRequest` in the GUI, Zenflows PR #84 authz.

**Spec:** `docs/superpowers/specs/2026-10-26-marketplace-hardening-design.md` (G4).

## Global Constraints

- Zenflows signed-call canonical message: the body with `' '` removed, plus Zencode's "compact ascii strings". Medusa only builds and accepts bodies that are single-line printable ASCII without `\`, for which the message is exactly `body.replace(/ /g, "")`. This was verified against the local zvmlet `verify_graphql` (2026-10-26).
- Headers: `zenflows-user` is the provider's username **read from the registry**, never taken from the client; `zenflows-sign` is base64 Ed25519.
- Service account env: `INTERFACER_ZENFLOWS_SERVICE_USER`, `INTERFACER_ZENFLOWS_SERVICE_SEED` (base58 32-byte seed, keypairoom encoding). Local only, kept in `.tmp`.
- Relay endpoints:
  - `GET /dev/store/zenflows-sync/:id/next` → `{step, body}` | `{status}`;
  - `POST /dev/store/zenflows-sync/:id/sign` `{step, body, signature}`.
  - Both need the bearer of the Person who is the row's provider; anyone else gets `seller_order_required`.
- No Zenflows server change.

## Review Focus

- A body tampered between `next` and `sign` (or built for another step): refused before any send.
- A valid signature from the wrong person (buyer, outsider): refused by Medusa before relaying; Zenflows would refuse it too.
- Network loss after a relayed write: reconciliation (service reads) must find it. The same signature is never reused.
- A seller who never returns: the row stays pending, `awaiting_seller_signature`, visible in their console. The job only reconciles.
- Zenflows auth calls on but the service account missing: Medusa reads fail closed with a clear reason, not a silent local-only receipt.

---

### Task 1: Zenflows request signing primitives + signed transport

**Files:** Create `medusa/src/modules/interfacer/zenflows-signing.ts`. Modify `zenflows-event.ts` (service account in config; transport signs every body when configured, takes optional per-call headers), `zenflows-person.ts` (registry read through the transport, also returning `user`), `zenflows-registry.ts`. Test: `src/tests/zenflows-signing.test.ts`.

**Interfaces:**
- `zenflowsSignedMessage(body: string): string` (throws `zenflows_body_not_canonical`)
- `signZenflowsBody(body, seedBase58): string`
- `verifyZenflowsBody(body, signature, publicKey: KeyObject): boolean`
- `ZenflowsConfig.service?: { user: string; seed: string }`
- `Gql(query, variables, headers?)`

- [ ] Tests:
  - message rules (spaces removed; newline, backslash and non-ASCII refused);
  - sign/verify round trip;
  - transport adds `zenflows-user`/`zenflows-sign` over the exact sent body, and per-call headers override them.
- [ ] Live check: a body signed by this code is accepted by the real zvmlet `verify_graphql` (probe, Task 4).

### Task 2: Executor stops at unsigned writes; relay applies a one-shot signature

**Files:** Modify `zenflows-sync.ts` (export `writeBody(state, step, spec)`; `AdvanceDeps.signatureFor?(step, body) => headers | null`), `zenflows-outbox.ts` (`nextWrite`, `relaySignature`), tests in `zenflows-sync.test.ts`.

- [ ] Tests:
  - with signed writes and no signature: nothing sent, `last_error = awaiting_seller_signature:create`, status pending;
  - with the matching signature: that one step is sent with those headers, then it stops again before the transfer;
  - a signature for another body: not sent.
- [ ] Implement. Reconciliation of an inflight step still runs before anything else.

### Task 3: Relay endpoints + GUI signing loop

**Files:**
- Create `api/dev/store/zenflows-sync/[id]/next/route.ts` and `api/dev/store/zenflows-sync/[id]/sign/route.ts`. Modify `api/middlewares.ts` (bearer).
- GUI: `lib/market/client.ts` (`signSyncSteps(orderId, syncId, signBody)`), `lib/market/relay.ts` (allowed mutation shapes + checks), `pages/market/sales.tsx` (signing loop after a milestone, plus a "Sign pending Zenflows steps" button), `tests/unit/market-relay.test.ts`.

- [ ] GUI unit tests: the relay check accepts only the three mutation shapes. Provider = me; a transfer's receiver = the order's buyer; no other variables; anything else is refused.
- [ ] Implement with `signGraphQLRequest(body, client.store)` from the SDK.

### Task 4: Live enforced stack

- [ ] Restart local Zenflows (`zenflows-pr84`, `mix run --no-halt`) with `GQL_AUTH_CALLS=true AUTHZ_ENFORCE=true AUTHZ_ALLOW_UNCHECKED=false`, keeping the same DB, `ROOM_SALT` and `ADMIN_KEY`.
- [ ] Create the Medusa service Person (admin key). Start Medusa with `INTERFACER_ZENFLOWS_SIGNED_WRITES=true` + service env.
- [ ] Probes:
  - `scripts/zenflows-actor.cjs` signs its own Zenflows calls (createPerson with the admin key; raise signed by the owner);
  - P8 acts as the seller's browser for the relay;
  - P7 faults rerun.
- [ ] GUI: `market-sellers.spec.ts` under enforcement. Also smoke-test normal GUI login and project pages.
- [ ] Negative live: an unsigned write and a buyer-signed transfer are both refused by Zenflows itself (`authz deny` / authentication error).
- [ ] Commit, docs, PR descriptions, Beads.
