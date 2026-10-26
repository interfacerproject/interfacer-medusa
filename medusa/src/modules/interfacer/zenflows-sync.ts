// Durable milestone outbox executor. Pure: GraphQL transport and persistence are
// injected. One sync row advances process -> create -> transfer. Each step is
// marked inflight BEFORE sending and checkpointed after, so any ambiguous failure
// (lost response, timeout, local save failure, crash) is resolved by reading
// Zenflows for the row's marker, never by a blind replay.
import { randomBytes } from "node:crypto"
import { termsHash } from "./matching"

export type MilestonePayload = {
  target: string // Zenflows GraphQL URL the ids belong to
  action: "transfer" | "produce"
  provider: string
  receiver: string
  unit: string
  spec_name: "Product"
  quantity: number
  has_point_in_time: string
  resource_name: string
  resource_tracking_id: string
  note: string
}
export type SyncStep = "process" | "create" | "transfer"
export type SyncState = {
  id: string
  marker: string
  payload: MilestonePayload
  payload_hash: string
  status: "pending" | "done" | "blocked"
  process_id: string | null
  resource_id: string | null
  creation_event_id: string | null
  transfer_event_id: string | null
  inflight_step: SyncStep | null
  inflight_at: Date | null
  attempts: number
  next_attempt_at: Date
  last_error: string | null
}
export interface SyncStore {
  save(id: string, patch: Partial<SyncState>): Promise<void>
  // Marks the row done; the Medusa store also stamps the receipt in the same transaction.
  complete(id: string, patch: Partial<SyncState>): Promise<void>
}
// Throws ZenflowsRejected when Zenflows definitely did not write (GraphQL errors,
// HTTP 4xx: its Multi rolled back); any other error is treated as ambiguous.
export type Gql = (query: string, variables: unknown) => Promise<any>
export class ZenflowsRejected extends Error {}
class SyncBlocked extends Error {}

export const SETTLE_MS = 60_000
const PROCESS_SCAN_MARGIN_MS = 300_000
const MAX_PROCESS_PAGES = 50

export function newSyncMarker(): string {
  // Only [a-z0-9-]: a literal match for Zenflows' ILIKE %note% filter.
  return "ifzs-" + randomBytes(16).toString("hex")
}
export function milestonePayloadHash(p: MilestonePayload): string {
  return termsHash(p)
}
function tagOf(marker: string) { return "interfacer-sync=" + marker }

// Zenflows ids: 48-bit ms timestamp + 80 random bits, base32 (Crockford) over the
// 128 bits MSB-first, the last 3 bits shifted left by 2 (Zenflows.DB.ID). Pages
// are ordered by id, so this is a valid `after` cursor for "created since ms".
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export function zenflowsIdLowerBound(d: Date): string {
  const v = (BigInt(Math.max(0, d.getTime())) << 80n) << 2n
  let out = ""
  for (let i = 25; i >= 0; i--) out += ALPHABET[Number((v >> BigInt(i * 5)) & 31n)]
  return out
}

const SPECS = `{ resourceSpecifications(first: 50) { edges { node { id name } } } }`
const CREATE_PROCESS = `mutation($p: ProcessCreateParams!) { createProcess(process: $p) { process { id } } }`
const CREATE_RESOURCE = `mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) {
  createEconomicEvent(event: $e, newInventoriedResource: $r) { economicEvent { id resourceInventoriedAs { id } } }
}`
const TRANSFER = `mutation($e: EconomicEventCreateParams!) { createEconomicEvent(event: $e) { economicEvent { id } } }`
const BY_MARKER = `query($m: String!) { economicResources(first: 20, filter: { note: $m }) { edges { node {
  id note previous { id note action { id } provider { id } receiver { id } outputOf { id }
    resourceInventoriedAs { id } toResourceInventoriedAs { id } resourceQuantity { hasNumericalValue } }
} } } }`
const PROCESSES_AFTER = `query($after: ID, $first: Int) { processes(first: $first, after: $after) {
  edges { node { id note } } pageInfo { hasNextPage endCursor } } }`

export type AdvanceDeps = {
  gql: Gql
  store: SyncStore
  target: string // currently configured Zenflows URL
  now?: () => Date
  settleMs?: number
}

export function nextStep(s: SyncState): SyncStep | null {
  if (s.payload.action === "produce" && !s.process_id) return "process"
  if (!s.resource_id) return "create"
  if (!s.transfer_event_id) return "transfer"
  return null
}

export async function advanceSync(state: SyncState, deps: AdvanceDeps): Promise<SyncState> {
  const now = deps.now ?? (() => new Date())
  const settle = deps.settleMs ?? SETTLE_MS
  let s: SyncState = { ...state }
  const save = async (patch: Partial<SyncState>) => {
    await deps.store.save(s.id, patch)
    s = { ...s, ...patch }
  }
  const backoff = (e: unknown): Partial<SyncState> => ({
    attempts: s.attempts + 1,
    next_attempt_at: new Date(now().getTime() + Math.min(5_000 * 2 ** s.attempts, 600_000)),
    last_error: String((e as Error)?.message ?? e).slice(0, 500),
  })
  if (s.status !== "pending") return s
  if (milestonePayloadHash(s.payload) !== s.payload_hash) {
    await save({ status: "blocked", last_error: "zenflows_sync_payload_tampered" })
    return s
  }
  if (s.payload.target !== deps.target) {
    await save({ status: "blocked", last_error: "zenflows_sync_target_changed" })
    return s
  }
  for (;;) {
    if (s.inflight_step) {
      let found: Partial<SyncState> | null
      try { found = await reconcile(s, deps.gql) }
      catch (e) {
        if (e instanceof SyncBlocked) { await save({ status: "blocked", last_error: e.message }); return s }
        await save(backoff(e))
        return s
      }
      if (found) await save({ ...found, inflight_step: null, inflight_at: null, last_error: null })
      else if (now().getTime() - s.inflight_at!.getTime() < settle) {
        // The original request may still commit: wait, never send it twice.
        await save({ next_attempt_at: new Date(s.inflight_at!.getTime() + settle) })
        return s
      } else await save({ inflight_step: null, inflight_at: null })
      continue
    }
    const step = nextStep(s)
    if (!step) {
      const patch = { status: "done" as const, last_error: null }
      await deps.store.complete(s.id, patch)
      s = { ...s, ...patch }
      return s
    }
    let spec: string | undefined
    if (step === "create") {
      // Read before marking inflight: a failed lookup sends nothing.
      try {
        const specs = await deps.gql(SPECS, {})
        spec = specs.resourceSpecifications.edges.find((e: any) => e.node.name === s.payload.spec_name)?.node.id
        if (!spec) throw new Error("zenflows_product_spec_required")
      } catch (e) { await save(backoff(e)); return s }
    }
    await save({ inflight_step: step, inflight_at: now() })
    let patch: Partial<SyncState>
    try { patch = await send(s, step, deps.gql, spec) }
    catch (e) {
      // Definite rejection: nothing was written, the step may simply be sent again.
      await save({ ...(e instanceof ZenflowsRejected ? { inflight_step: null, inflight_at: null } : {}), ...backoff(e) })
      return s
    }
    await save({ ...patch, inflight_step: null, inflight_at: null, last_error: null })
  }
}

async function send(s: SyncState, step: SyncStep, gql: Gql, spec?: string): Promise<Partial<SyncState>> {
  const p = s.payload, tag = tagOf(s.marker)
  const quantity = { hasNumericalValue: p.quantity, hasUnit: p.unit }
  const note = `${p.note} ${tag}`
  if (step === "process") {
    const data = await gql(CREATE_PROCESS, { p: { name: p.resource_name, note,
      hasBeginning: p.has_point_in_time, hasEnd: p.has_point_in_time, finished: true } })
    const id = data?.createProcess?.process?.id
    if (typeof id !== "string") throw new Error("zenflows_process_missing")
    return { process_id: id }
  }
  if (step === "create") {
    const data = await gql(CREATE_RESOURCE, {
      e: { action: p.action === "produce" ? "produce" : "raise", provider: p.provider, receiver: p.provider,
        resourceConformsTo: spec, resourceQuantity: quantity, hasPointInTime: p.has_point_in_time, note,
        ...(p.action === "produce" ? { outputOf: s.process_id } : {}) },
      r: { name: p.resource_name, note: `interfacer-marketplace ${p.action} ${tag}`,
        trackingIdentifier: p.resource_tracking_id },
    })
    const event = data?.createEconomicEvent?.economicEvent
    if (typeof event?.id !== "string" || typeof event.resourceInventoriedAs?.id !== "string")
      throw new Error("zenflows_resource_missing")
    return { resource_id: event.resourceInventoriedAs.id, creation_event_id: event.id }
  }
  // The destination inherits the source note (and so the marker) in Zenflows.
  const data = await gql(TRANSFER, { e: { action: "transfer", provider: p.provider, receiver: p.receiver,
    resourceInventoriedAs: s.resource_id, resourceQuantity: quantity, hasPointInTime: p.has_point_in_time, note } })
  const id = data?.createEconomicEvent?.economicEvent?.id
  if (typeof id !== "string") throw new Error("zenflows_transfer_missing")
  return { transfer_event_id: id }
}

function single<T>(candidates: T[]): T | null {
  if (candidates.length > 1) throw new SyncBlocked("zenflows_reconcile_duplicate")
  return candidates[0] ?? null
}
function same(ok: boolean) { if (!ok) throw new SyncBlocked("zenflows_reconcile_mismatch") }

// Returns the checkpoint for the inflight step if Zenflows has it, null if absent.
async function reconcile(s: SyncState, gql: Gql): Promise<Partial<SyncState> | null> {
  const p = s.payload, tag = tagOf(s.marker)
  if (s.inflight_step === "process") {
    const matches: string[] = []
    let after: string | null = zenflowsIdLowerBound(new Date(s.inflight_at!.getTime() - PROCESS_SCAN_MARGIN_MS))
    for (let page = 0; ; page++) {
      if (page >= MAX_PROCESS_PAGES) throw new Error("zenflows_process_scan_exhausted")
      const data = await gql(PROCESSES_AFTER, { after, first: 100 })
      const conn = data?.processes
      for (const { node } of conn?.edges ?? []) if (String(node.note ?? "").includes(tag)) matches.push(node.id)
      if (!conn?.pageInfo?.hasNextPage) break
      after = conn.pageInfo.endCursor
    }
    const id = single(matches)
    return id ? { process_id: id } : null
  }
  const data = await gql(BY_MARKER, { m: tag })
  const seen = new Map<string, { resource: any; event: any }>()
  for (const { node } of data?.economicResources?.edges ?? [])
    for (const event of node.previous ?? []) if (String(event.note ?? "").includes(tag)) seen.set(event.id, { resource: node, event })
  const events = [...seen.values()]
  const qty = (e: any) => Number(e.resourceQuantity?.hasNumericalValue)
  if (s.inflight_step === "create") {
    const action = p.action === "produce" ? "produce" : "raise"
    const hit = single(events.filter(({ resource, event }) => ["raise", "produce"].includes(event.action?.id) &&
      event.resourceInventoriedAs?.id === resource.id))
    if (!hit) return null
    same(hit.event.action.id === action && hit.event.provider?.id === p.provider && qty(hit.event) === p.quantity &&
      (p.action !== "produce" || hit.event.outputOf?.id === s.process_id))
    return { resource_id: hit.resource.id, creation_event_id: hit.event.id }
  }
  const hit = single(events.filter(({ resource, event }) => event.action?.id === "transfer" &&
    event.toResourceInventoriedAs?.id === resource.id && event.resourceInventoriedAs?.id === s.resource_id))
  if (!hit) return null
  same(hit.event.provider?.id === p.provider && hit.event.receiver?.id === p.receiver && qty(hit.event) === p.quantity)
  return { transfer_event_id: hit.event.id }
}
