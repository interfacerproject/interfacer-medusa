import assert from "node:assert/strict"
import { test } from "node:test"
import {
  advanceSync, milestonePayloadHash, newSyncMarker, zenflowsIdLowerBound, ZenflowsRejected,
  type MilestonePayload, type SyncState, type SyncStore,
} from "../modules/interfacer/zenflows-sync"

// In-memory Zenflows: the subset of createProcess / createEconomicEvent /
// economicResources(filter:{note}) / processes(after) semantics the outbox relies
// on, including transfer destinations inheriting the source note and the
// `previous` rule of EconomicResource.Query.previous/1.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function zid(ms: number, counter: number): string {
  const v = ((BigInt(ms) << 80n) | BigInt(counter)) << 2n
  let out = ""
  for (let i = 25; i >= 0; i--) out += ALPHABET[Number((v >> BigInt(i * 5)) & 31n)]
  return out
}
function idMs(id: string): number {
  let v = 0n
  for (const ch of id) v = (v << 5n) | BigInt(ALPHABET.indexOf(ch))
  return Number((v >> 2n) >> 80n)
}

type Fault = { match: string; mode: "lose" | "drop" | "reject" | "late"; times: number }
class FakeZenflows {
  clock = Date.parse("2026-10-26T10:00:00.000Z")
  counter = 0
  processes: any[] = []
  resources: any[] = []
  events: any[] = []
  faults: Fault[] = []
  late: (() => void)[] = []
  calls: string[] = []
  id() { return zid(this.clock, ++this.counter) }
  fault(match: string, mode: Fault["mode"], times = 1) { this.faults.push({ match, mode, times }) }
  count(kind: string) {
    if (kind === "process") return this.processes.length
    return this.events.filter(e => e.action === kind).length
  }
  previous(id: string) {
    return this.events.filter(e => (e.outputOf && e.resourceInventoriedAs === id) ||
      e.toResourceInventoriedAs === id || (["raise", "lower"].includes(e.action) && e.resourceInventoriedAs === id))
  }
  gql = async (query: string, variables: any): Promise<any> => {
    const kind = query.includes("createProcess") ? "createProcess"
      : query.includes("createEconomicEvent") ? variables.e.action
      : query.includes("economicResources") ? "economicResources"
      : query.includes("processes") ? "processes" : "resourceSpecifications"
    this.calls.push(kind)
    const fault = this.faults.find(f => f.match === kind && f.times > 0)
    if (fault) fault.times--
    if (fault?.mode === "reject") throw new ZenflowsRejected("zenflows_error: denied")
    if (fault?.mode === "drop") throw new Error("connect ECONNREFUSED")
    if (fault?.mode === "late") {
      this.late.push(() => { this.apply(kind, variables) })
      throw new Error("The operation was aborted due to timeout")
    }
    const data = this.apply(kind, variables)
    if (fault?.mode === "lose") throw new Error("socket hang up")
    return data
  }
  apply(kind: string, v: any): any {
    const node = (r: any) => ({ id: r.id, note: r.note, primaryAccountable: { id: r.primaryAccountable },
      previous: this.previous(r.id).map(e => ({ id: e.id, note: e.note, action: { id: e.action },
        provider: { id: e.provider }, receiver: { id: e.receiver },
        outputOf: e.outputOf ? { id: e.outputOf } : null,
        resourceInventoriedAs: e.resourceInventoriedAs ? { id: e.resourceInventoriedAs } : null,
        toResourceInventoriedAs: e.toResourceInventoriedAs ? { id: e.toResourceInventoriedAs } : null,
        resourceQuantity: { hasNumericalValue: e.quantity } })) })
    switch (kind) {
      case "resourceSpecifications":
        return { resourceSpecifications: { edges: [{ node: { id: "spec-product", name: "Product" } }] } }
      case "createProcess": {
        const p = { id: this.id(), ...v.p }
        this.processes.push(p)
        return { createProcess: { process: { id: p.id } } }
      }
      case "raise": case "produce": {
        const r = { id: this.id(), ...v.r, primaryAccountable: v.e.provider }
        this.resources.push(r)
        const e = { id: this.id(), action: v.e.action, provider: v.e.provider, receiver: v.e.receiver, note: v.e.note,
          outputOf: v.e.outputOf ?? null, resourceInventoriedAs: r.id, quantity: v.e.resourceQuantity.hasNumericalValue }
        this.events.push(e)
        return { createEconomicEvent: { economicEvent: { id: e.id, resourceInventoriedAs: { id: r.id } } } }
      }
      case "transfer": {
        const src = this.resources.find(r => r.id === v.e.resourceInventoriedAs)
        if (!src || src.primaryAccountable !== v.e.provider) throw new ZenflowsRejected("zenflows_error: accountability")
        const dest = { id: this.id(), name: src.name, note: src.note, primaryAccountable: v.e.receiver }
        this.resources.push(dest)
        const e = { id: this.id(), action: "transfer", provider: v.e.provider, receiver: v.e.receiver, note: v.e.note,
          resourceInventoriedAs: src.id, toResourceInventoriedAs: dest.id, quantity: v.e.resourceQuantity.hasNumericalValue }
        this.events.push(e)
        return { createEconomicEvent: { economicEvent: { id: e.id } } }
      }
      case "economicResources": {
        const m = String(v.m).toLowerCase()
        return { economicResources: { edges: this.resources
          .filter(r => String(r.note ?? "").toLowerCase().includes(m)).map(r => ({ node: node(r) })) } }
      }
      case "processes": {
        const sorted = [...this.processes].sort((a, b) => a.id < b.id ? -1 : 1).filter(p => !v.after || p.id > v.after)
        const page = sorted.slice(0, v.first ?? 100)
        return { processes: { edges: page.map(p => ({ node: { id: p.id, note: p.note } })),
          pageInfo: { hasNextPage: sorted.length > page.length, endCursor: page.at(-1)?.id ?? null } } }
      }
    }
  }
}

class MemoryStore implements SyncStore {
  rows = new Map<string, SyncState>()
  completed: string[] = []
  failWhen: ((patch: Partial<SyncState>) => boolean) | null = null
  constructor(state: SyncState) { this.rows.set(state.id, structuredClone(state)) }
  load(id: string) { return structuredClone(this.rows.get(id)!) }
  async save(id: string, patch: Partial<SyncState>) {
    if (this.failWhen?.(patch)) { this.failWhen = null; throw new Error("local database unavailable") }
    this.rows.set(id, { ...this.rows.get(id)!, ...structuredClone(patch) })
  }
  async complete(id: string, patch: Partial<SyncState>) {
    await this.save(id, patch)
    this.completed.push(id)
  }
}

const TARGET = "http://zenflows.test/api"
function payload(action: "transfer" | "produce" = "produce"): MilestonePayload {
  return { target: TARGET, action, provider: "06GSELLER0000000000000000A", receiver: "06GBUYER00000000000000000A",
    unit: "unit-one", spec_name: "Product", quantity: action === "produce" ? 2 : 1,
    has_point_in_time: "2026-10-26T09:59:00.000Z", resource_name: "Interfacer build design-one",
    resource_tracking_id: "design-one", note: "interfacer-marketplace " + action + " order=order_one" }
}
function fresh(p = payload()): SyncState {
  return { id: "ifzs_one", marker: newSyncMarker(), payload: p, payload_hash: milestonePayloadHash(p), status: "pending",
    process_id: null, resource_id: null, creation_event_id: null, transfer_event_id: null,
    inflight_step: null, inflight_at: null, attempts: 0, next_attempt_at: new Date(0), last_error: null }
}
function harness(state = fresh()) {
  const zf = new FakeZenflows(), store = new MemoryStore(state)
  const run = (offsetMs = 0) => advanceSync(store.load(state.id), {
    gql: zf.gql, store, target: TARGET, now: () => new Date(zf.clock + offsetMs), settleMs: 60_000 })
  return { zf, store, run, tag: "interfacer-sync=" + state.marker }
}

test("build: finished Process, produce to the provider, transfer to the buyer; every remote note carries the marker", async () => {
  const { zf, store, run, tag } = harness()
  const done = await run()
  assert.equal(done.status, "done")
  assert.deepEqual([zf.count("process"), zf.count("produce"), zf.count("transfer")], [1, 1, 1])
  assert.ok(zf.processes[0].note.includes(tag) && zf.processes[0].finished === true)
  assert.ok(zf.events.every(e => e.note.includes(tag)))
  assert.ok(zf.resources.every(r => r.note.includes(tag)))
  const produce = zf.events.find(e => e.action === "produce")
  assert.equal(produce.outputOf, done.process_id)
  assert.equal(produce.receiver, payload().provider)
  assert.equal(zf.events.find(e => e.action === "transfer").receiver, payload().receiver)
  assert.equal(done.transfer_event_id, zf.events.find(e => e.action === "transfer").id)
  assert.deepEqual(store.completed, ["ifzs_one"])
  assert.equal(store.load("ifzs_one").inflight_step, null)
})

test("stock: raise then transfer, no Process", async () => {
  const { zf, run } = harness(fresh(payload("transfer")))
  assert.equal((await run()).status, "done")
  assert.deepEqual([zf.count("process"), zf.count("raise"), zf.count("transfer")], [0, 1, 1])
})

for (const step of ["createProcess", "produce", "transfer"]) {
  test(`lost response after ${step} committed: reconciled by marker, never re-sent`, async () => {
    const { zf, run } = harness()
    zf.fault(step, "lose")
    const first = await run()
    assert.equal(first.status, "pending")
    assert.ok(first.inflight_step)
    assert.equal(first.attempts, 1)
    const done = await run(1_000) // inside the settle window: found, so no wait needed
    assert.equal(done.status, "done")
    assert.deepEqual([zf.count("process"), zf.count("produce"), zf.count("transfer")], [1, 1, 1])
  })
}

test("ambiguous failure with nothing committed: defers inside the settle window, re-sends once after it", async () => {
  const { zf, run } = harness(fresh(payload("transfer")))
  zf.fault("raise", "drop")
  await run()
  const deferred = await run(10_000)
  assert.equal(deferred.status, "pending")
  assert.equal(deferred.inflight_step, "create")
  assert.equal(zf.calls.filter(c => c === "raise").length, 1, "no second send inside the window")
  assert.equal((await run(61_000)).status, "done")
  assert.deepEqual([zf.count("raise"), zf.count("transfer")], [1, 1])
})

test("a request that commits late (after our timeout) is found, not duplicated", async () => {
  const { zf, run } = harness(fresh(payload("transfer")))
  zf.fault("raise", "late")
  await run()
  await run(5_000)
  zf.late.forEach(commit => commit())
  assert.equal((await run(61_000)).status, "done")
  assert.deepEqual([zf.count("raise"), zf.count("transfer")], [1, 1])
})

test("definite rejection of the transfer: cleared, retried, exactly one transfer", async () => {
  const { zf, run } = harness()
  zf.fault("transfer", "reject")
  const failed = await run()
  assert.equal(failed.status, "pending")
  assert.equal(failed.inflight_step, null)
  assert.ok(failed.transfer_event_id === null && failed.resource_id)
  assert.match(String(failed.last_error), /denied/)
  assert.ok(failed.next_attempt_at.getTime() > zf.clock)
  assert.equal((await run(10_000)).status, "done")
  assert.deepEqual([zf.count("process"), zf.count("produce"), zf.count("transfer")], [1, 1, 1])
})

test("local database fails right after a remote commit; a restarted executor reconciles without duplicates", async () => {
  const { zf, store, run } = harness()
  store.failWhen = patch => typeof patch.transfer_event_id === "string"
  await assert.rejects(run(), /local database unavailable/)
  assert.equal(store.load("ifzs_one").inflight_step, "transfer")
  const done = await run(120_000) // fresh executor, state reloaded from the store
  assert.equal(done.status, "done")
  assert.deepEqual([zf.count("process"), zf.count("produce"), zf.count("transfer")], [1, 1, 1])
  assert.equal(done.transfer_event_id, zf.events.find(e => e.action === "transfer").id)
})

test("tampered payload or changed target blocks with zero remote calls", async () => {
  const tampered = fresh()
  tampered.payload = { ...tampered.payload, receiver: "06GATTACKER000000000000000" }
  const a = harness(tampered)
  const blocked = await a.run()
  assert.equal(blocked.status, "blocked")
  assert.equal(blocked.last_error, "zenflows_sync_payload_tampered")
  assert.equal(a.zf.calls.length, 0)
  const moved = fresh({ ...payload(), target: "http://another-registry/api" })
  const b = harness(moved)
  assert.equal((await b.run()).last_error, "zenflows_sync_target_changed")
  assert.equal(b.zf.calls.length, 0)
})

test("two remote objects with the same marker block instead of picking one", async () => {
  const { zf, run } = harness(fresh(payload("transfer")))
  zf.fault("raise", "lose")
  await run()
  // Someone replayed the same body by hand:
  const replay = zf.events.find(e => e.action === "raise")
  const r = zf.resources.find(x => x.id === replay.resourceInventoriedAs)
  zf.apply("raise", { e: { action: "raise", provider: replay.provider, receiver: replay.receiver, note: replay.note,
    resourceQuantity: { hasNumericalValue: 1 } }, r: { name: r.name, note: r.note } })
  const blocked = await run(1_000)
  assert.equal(blocked.status, "blocked")
  assert.equal(blocked.last_error, "zenflows_reconcile_duplicate")
  assert.equal(zf.count("transfer"), 0)
})

test("a marker match with different facts blocks as a mismatch", async () => {
  const { zf, run } = harness(fresh(payload("transfer")))
  zf.fault("raise", "lose")
  await run()
  zf.events.find(e => e.action === "raise").quantity = 7
  const blocked = await run(1_000)
  assert.equal(blocked.last_error, "zenflows_reconcile_mismatch")
  assert.equal(zf.count("transfer"), 0)
})

test("Zenflows id lower bound brackets a real Zenflows Process id", () => {
  const id = "06GPGYC3X50B68VJHCD9BRA3KR"
  const ms = idMs(id)
  assert.equal(new Date(ms).toISOString().slice(0, 10), "2026-10-23")
  assert.ok(zenflowsIdLowerBound(new Date(ms)) <= id)
  assert.ok(zenflowsIdLowerBound(new Date(ms + 1)) > id)
  assert.equal(zenflowsIdLowerBound(new Date(ms)).length, 26)
})

test("markers are literal for an ILIKE filter and payload hashes are order-independent", () => {
  assert.match(newSyncMarker(), /^ifzs-[0-9a-f]{32}$/)
  const p = payload()
  const reordered = Object.fromEntries(Object.entries(p).reverse()) as MilestonePayload
  assert.equal(milestonePayloadHash(reordered), milestonePayloadHash(p))
  assert.notEqual(milestonePayloadHash({ ...p, quantity: 3 }), milestonePayloadHash(p))
})
