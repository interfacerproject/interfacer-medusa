// Medusa glue for the durable Zenflows milestone outbox (zenflows-sync.ts).
// Receipt + sync row commit together first; the executor then runs inline,
// from the scheduled job (restart recovery) or from an explicit retry, always
// under a per-row advisory lock.
import { MedusaError } from "@medusajs/framework/utils"
import type InterfacerService from "./service"
import { zenflowsConfig, zenflowsTransport, type ZenflowsConfig } from "./zenflows-event"
import {
  advanceSync, milestonePayloadHash, newSyncMarker,
  type MilestonePayload, type SyncState, type SyncStore,
} from "./zenflows-sync"

export type MilestoneInput = {
  action: "transfer" | "produce"
  quantity: number
  has_point_in_time: Date
  note: string
  resource_name: string
  resource_tracking_id: string
  receiver?: string
  provider?: string
  unit?: string
  // Live stock: transfer one unit of the seller's own Zenflows resource instead
  // of raising a stand-in; the destination is marked instead of the source.
  source_resource_id?: string
}

// Deterministic from immutable receipt facts + the configured registry mapping:
// a retry of the same milestone must hash identically.
export function syncPayloadFor(input: MilestoneInput, cfg: ZenflowsConfig): MilestonePayload {
  const provider = input.provider ?? cfg.provider
  const receiver = input.receiver ?? cfg.receiver
  const unit = input.unit ?? cfg.unit
  if (!provider || !receiver) throw new Error("zenflows_agents_required")
  if (!unit) throw new Error("zenflows_unit_required")
  if (provider === receiver) throw new Error("zenflows_self_transfer_forbidden")
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("zenflows_positive_quantity_required")
  return { target: cfg.url, action: input.action, provider, receiver, unit, spec_name: "Product",
    quantity: input.quantity, has_point_in_time: input.has_point_in_time.toISOString(),
    resource_name: input.resource_name, resource_tracking_id: input.resource_tracking_id, note: input.note,
    ...(input.source_resource_id ? { source_resource_id: input.source_resource_id } : {}) }
}

export function assertSameSyncPayload(existing: { payload_hash: string }, candidate: MilestonePayload) {
  if (existing.payload_hash !== milestonePayloadHash(candidate))
    throw new MedusaError(MedusaError.Types.CONFLICT, "zenflows_sync_payload_conflict")
}

type SyncRow = Awaited<ReturnType<InterfacerService["retrieveZenflowsSync"]>>
function toState(row: SyncRow): SyncState {
  return { ...(row as any), payload: row.payload as unknown as MilestonePayload,
    inflight_at: row.inflight_at ? new Date(row.inflight_at as any) : null,
    next_attempt_at: new Date(row.next_attempt_at as any) }
}
function medusaStore(integration: InterfacerService): SyncStore {
  return {
    save: async (id, patch) => { await integration.updateZenflowsSyncs({ id, ...patch } as any) },
    // Receipts are immutable (DB trigger): the live handover id stays on the sync
    // row and is exposed on the receipt view by withSync().
    complete: async (id, patch) => {
      const row = await integration.retrieveZenflowsSync(id)
      if (!row.transfer_event_id) throw new Error("zenflows_sync_incomplete")
      await integration.updateZenflowsSyncs({ id, ...patch } as any)
    },
  }
}

// Creates the receipt and, when Zenflows is configured, its pending sync row in
// one transaction. An unmappable milestone (e.g. the anonymous fixture buyer
// without a configured receiver) stays a local-only receipt, as before.
export function newSyncRow(orderId: string, input: MilestoneInput, cfg: ZenflowsConfig | null) {
  if (!cfg) return null
  let payload: MilestonePayload
  try { payload = syncPayloadFor(input, cfg) }
  catch (e) {
    console.warn("[interfacer] milestone not mappable to Zenflows; local receipt only:", (e as Error).message)
    return null
  }
  return { order_id: orderId, marker: newSyncMarker(), payload, payload_hash: milestonePayloadHash(payload),
    status: "pending" as const, attempts: 0, next_attempt_at: new Date() }
}
export async function enqueueMilestone(
  integration: InterfacerService, receipt: Record<string, unknown> & { order_id: string }, input: MilestoneInput,
  cfg: ZenflowsConfig | null = zenflowsConfig(),
) {
  return integration.createReceiptWithSync({ ...receipt, zenflows_event_id: null } as any,
    newSyncRow(receipt.order_id, input, cfg))
}

export async function runZenflowsSync(
  integration: InterfacerService, id: string, cfg: ZenflowsConfig | null = zenflowsConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<SyncState> {
  return integration.withProjectionLock("interfacer-zenflows-sync:" + id, async () => {
    const state = toState(await integration.retrieveZenflowsSync(id))
    // Unconfigured now: leave pending rows untouched rather than guessing a registry.
    if (state.status !== "pending" || !cfg) return state
    return advanceSync(state, { gql: zenflowsTransport(cfg, fetchImpl), store: medusaStore(integration), target: cfg.url })
  })
}

// Never fails the caller's milestone: the row stays durable and the job retries.
export async function runZenflowsSyncSafely(integration: InterfacerService, id: string) {
  try { return await runZenflowsSync(integration, id) }
  catch (e) {
    console.warn("[interfacer] zenflows sync deferred:", id, (e as Error).message)
    return toState(await integration.retrieveZenflowsSync(id))
  }
}

// The milestone retry path: same order, same facts, else a 409 conflict.
export async function resumeMilestone(integration: InterfacerService, receipt: { id: string; order_id: string },
  input: MilestoneInput, cfg: ZenflowsConfig | null = zenflowsConfig()) {
  const [sync] = await integration.listZenflowsSyncs({ order_id: receipt.order_id })
  if (!sync) return { receipt } // standalone, or a legacy pre-outbox local-only receipt
  if (cfg) {
    let candidate: MilestonePayload
    // A retry need not re-read the instance unit (Zenflows may be down): the
    // stored unit is the one this milestone was enqueued with.
    try { candidate = syncPayloadFor({ ...input, unit: input.unit ?? (sync.payload as MilestonePayload).unit }, cfg) }
    catch { throw new MedusaError(MedusaError.Types.CONFLICT, "zenflows_sync_payload_conflict") }
    assertSameSyncPayload(sync, candidate)
  }
  const state = await runZenflowsSyncSafely(integration, sync.id)
  return { receipt: withSync(await integration.retrieveReaReceipt(receipt.id), state) }
}

// Live receipts carry their sync state, and a done sync supplies the handover id
// (the immutable receipt row is never updated). Standalone receipts keep their
// exact historical shape: the P3/P5 harnesses compare responses for equality.
export function withSync<T extends { zenflows_event_id?: string | null }>(receipt: T, sync: Partial<SyncState> | null | undefined) {
  if (!sync) return receipt
  return { ...receipt, zenflows_event_id: receipt.zenflows_event_id ??
    (sync.status === "done" ? sync.transfer_event_id ?? null : null), zenflows_sync: syncView(sync) }
}

export async function runDueZenflowsSyncs(integration: InterfacerService, limit = 20): Promise<number> {
  const cfg = zenflowsConfig()
  if (!cfg) return 0
  const due = await integration.listZenflowsSyncs({ status: "pending", next_attempt_at: { $lte: new Date() } } as any,
    { take: limit, order: { next_attempt_at: "ASC" } })
  for (const row of due) {
    try { await runZenflowsSync(integration, row.id, cfg) }
    catch (e) { console.warn("[interfacer] zenflows sync retry failed:", row.id, (e as Error).message) }
  }
  return due.length
}

export function syncView(sync: Partial<SyncState> | null | undefined) {
  if (!sync) return null
  const { status, attempts, last_error, process_id, resource_id, creation_event_id, transfer_event_id,
    inflight_step, next_attempt_at } = sync
  return { id: (sync as { id?: string }).id, status, attempts, last_error, process_id, resource_id,
    creation_event_id, transfer_event_id, inflight_step, next_attempt_at }
}
