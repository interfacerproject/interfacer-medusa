# P1 — Durable Zenflows milestone outbox: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live marketplace milestone is persisted locally first, then synced to Zenflows step by step. Each step is checkpointed and reconciled by marker, so no lost response, failed step, local failure or restart can duplicate or lose a remote object.

**Architecture:** A pure executor (`zenflows-sync.ts`) advances one sync row through `process → create → transfer` against an injected GraphQL function and store. Medusa glue (`zenflows-outbox.ts`) creates receipt + sync in one transaction, runs the executor under an advisory lock, and exposes a scheduled job and status/retry routes. The GUI renders the sync state.

**Tech Stack:** Medusa 2.10.3 module (MikroORM models, manual migration), node:test + ts-node, Next.js GUI.

**Spec:** `docs/superpowers/specs/2026-10-26-marketplace-hardening-design.md` (section G1).

## Global Constraints

- Marker format `ifzs-` + 32 lowercase hex; every remote note contains `interfacer-sync=<marker>`.
- Settle window 60 000 ms; backoff `min(5000 · 2^attempts, 600000)` ms; process scan lower bound `inflight_at − 300000` ms.
- Reasons (exact strings): `zenflows_reconcile_duplicate`, `zenflows_reconcile_mismatch`, `zenflows_sync_payload_tampered`, `zenflows_sync_target_changed`, `zenflows_sync_payload_conflict`.
- Never SQL-write Medusa core tables; module tables via migration only.
- Standalone (no `INTERFACER_ZENFLOWS_URL`) behaviour unchanged: no sync row, local receipt only.

## Review Focus

- A response lost *after* Zenflows committed, then an immediate retry inside the settle window: must defer, not re-send.
- Two `ifzs` matches for one step (e.g. an earlier manual replay): must block, never pick one.
- Zenflows reachable again after hours of pending rows: the job must drain them without a thundering herd (backoff honoured, one row per lock).
- Medusa restarted with a different `INTERFACER_ZENFLOWS_URL`: old rows must block, not write ids from another registry.
- Receipt list for receipts created before this change: must show LOCAL ONLY, never PENDING forever.

---

### Task 1: Pure executor with reconciliation

**Files:**
- Create: `medusa/src/modules/interfacer/zenflows-sync.ts`
- Test: `medusa/src/tests/zenflows-sync.test.ts` (with an in-memory fake Zenflows + store in the test file)

**Interfaces:**
- Produces:
  - `type MilestonePayload = { target: string; action: "transfer"|"produce"; provider: string; receiver: string; unit: string; spec_name: "Product"; quantity: number; has_point_in_time: string; resource_name: string; resource_tracking_id: string; note: string }`
  - `type SyncState = { id; marker; payload: MilestonePayload; payload_hash; status: "pending"|"done"|"blocked"; process_id|resource_id|creation_event_id|transfer_event_id: string|null; inflight_step: "process"|"create"|"transfer"|null; inflight_at: Date|null; attempts: number; next_attempt_at: Date; last_error: string|null }`
  - `interface SyncStore { save(id: string, patch: Partial<SyncState>): Promise<void>; complete(id: string, patch: Partial<SyncState>): Promise<void> }`
  - `type Gql = (query: string, variables: unknown) => Promise<any>` — throws `ZenflowsRejected` (definite) or any other error (ambiguous).
  - `advanceSync(state, { gql, store, target, now?, settleMs? }): Promise<SyncState>`
  - `milestonePayloadHash(p: MilestonePayload): string`, `newSyncMarker(): string`, `zenflowsIdLowerBound(d: Date): string`, `class ZenflowsRejected extends Error`.

- [ ] Step 1: write tests:
  - happy build: Process → produce → transfer, `done`, all ids set, marker on every note;
  - happy stock: raise → transfer, no Process;
  - lost response on process/create/transfer: deferred within settle, reconciled after it, exactly one object each;
  - definite rejection of transfer: retried, exactly one transfer;
  - local save failing after the remote commit, then a restart from persisted state: no duplicate;
  - tampered payload: blocked, zero calls;
  - target changed: blocked;
  - two marker matches: blocked duplicate;
  - quantity mismatch: blocked mismatch;
  - id lower bound brackets a real Zenflows id (`06GPGYC3X50B68VJHCD9BRA3KR`).
- [ ] Step 2: run `npm run test:unit`; it is expected to fail (module missing).
- [ ] Step 3: implement. Before sending a step, save `inflight_step`/`inflight_at`. After the send, save the id and clear the inflight step.
  - `ZenflowsRejected` clears the inflight step and backs off.
  - Any other failure keeps the inflight step and backs off.
  - If the step is inflight on entry, reconcile first.
- [ ] Step 4: run `npm run test:unit`; it is expected to pass.

### Task 2: Model, migration, transactional service methods, Medusa glue

**Files:**
- Create: `medusa/src/modules/interfacer/models/zenflows-sync.ts`, `migrations/Migration20261026120000.ts`, `medusa/src/modules/interfacer/zenflows-outbox.ts`
- Modify: `service.ts` (register model, `createReceiptWithSync`, `completeZenflowsSync`), `zenflows-event.ts` (gql transport + payload builder replace the direct writer), `delivery.ts`, `production.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `enqueueMilestone(integration, receipt: ReaReceiptInput, input: MilestoneInput): Promise<{ receipt; sync | null }>` — sync is null when standalone.
  - `runZenflowsSync(integration, syncId): Promise<SyncState>`
  - `runDueZenflowsSyncs(integration, limit = 20): Promise<number>`
  - `syncPayloadFor(receipt, input, cfg): MilestonePayload`; same-order retry with a different hash throws `zenflows_sync_payload_conflict`.

- [ ] Step 1: add a test that `syncPayloadFor` is deterministic from receipt facts and that a conflicting payload is detected (`assertSameSyncPayload`).
- [ ] Step 2: implement the model, migration, service transaction (`@InjectTransactionManager` + `@MedusaContext`) and glue. Delivery/production call `enqueueMilestone` and then run inline. A retry for an existing receipt runs its sync (or reports `legacy_local_only`).
- [ ] Step 3: `npm run test:unit` and `npm --prefix medusa run typecheck` are expected to be green.

### Task 3: Recovery job, status and retry routes

**Files:**
- Create: `medusa/src/jobs/interfacer-zenflows-sync.ts` (schedule `* * * * *`), `medusa/src/api/dev/interfacer/zenflows-sync/route.ts` (GET list), `.../zenflows-sync/[id]/retry/route.ts` (POST)
- Modify: `api/dev/interfacer/receipts/route.ts` (attach `zenflows_sync` per receipt: `{status, attempts, last_error, process_id, resource_id, creation_event_id, transfer_event_id}`, or `{status:"legacy_local_only"}`; null when standalone)

- [ ] Step 1: implement. The job is a no-op when standalone. Routes use `allowLocalRequest`.
- [ ] Step 2: typecheck.

### Task 4: GUI sync status

**Files:**
- Modify: `interfacer-gui-medusa/lib/market/types.ts` (`ZenflowsSync` type on `Receipt`), `components/market/ReceiptView.tsx`, `lib/market/client.ts` (`retrySync(id)`)
- Test: `tests/unit/market-client.test.ts` (retry call path)

- [ ] Step 1: render the states:
  - LIVE: event id.
  - SYNC PENDING: attempts, last error, Retry button.
  - SYNC BLOCKED: reason.
  - LOCAL ONLY: legacy, or no Zenflows URL configured.
- [ ] Step 2: `npm run test:market` and `npm run check-types` are expected to be green.

### Task 5: Live fault verification against real Zenflows

**Files:**
- Create: `scripts/zenflows-fault-proxy.cjs`. A loopback HTTP proxy in front of Zenflows. Control endpoint `POST /__fault {"mode":"lose-response"|"reject"|"down"|"pass","match":"createProcess|raise|produce|transfer","times":n}`. "lose-response" forwards the request, waits for the upstream response, then destroys the client socket.
- Modify: `docs/zenflows-bridge.md` (outbox section and evidence), `TESTING.md` (P7 outbox evidence)

- [ ] Step 1: restart Medusa dev with `INTERFACER_ZENFLOWS_URL` pointing at the proxy.
- [ ] Step 2: for each fault (lose-response on raise, on transfer and on createProcess; reject transfer; down + restart), drive a milestone. Check SYNC PENDING, then wait for or trigger recovery, then check LIVE. Query Zenflows and assert exactly one marker resource (source), one destination and one Process.
- [ ] Step 3: re-run the four GUI journeys and `npm run test:all` (9/9).
- [ ] Step 4: commit both repos, push, update PR #1 / #922 and Beads `interfacer-gui-nhn`.
