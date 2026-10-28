import assert from "node:assert/strict"
import { test } from "node:test"
import { zenflowsConfig, zenflowsTransport, type ZenflowsConfig } from "../modules/interfacer/zenflows-event"
import { assertSameSyncPayload, newSyncRow, syncPayloadFor, type MilestoneInput } from "../modules/interfacer/zenflows-outbox"
import { milestonePayloadHash, ZenflowsRejected } from "../modules/interfacer/zenflows-sync"

const cfg: ZenflowsConfig = { url: "http://zenflows.test/api", provider: "seller", receiver: "legacy-demo-buyer", unit: "one" }
const input: MilestoneInput = { action: "produce", quantity: 2, has_point_in_time: new Date("2026-10-23T12:00:00.000Z"),
  resource_name: "Custom part", resource_tracking_id: "design-one", receiver: "verified-buyer", note: "order-one" }
const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

test("transport: GraphQL errors and HTTP 4xx are definite rejections; 5xx, network and malformed replies are ambiguous", async () => {
  await assert.rejects(zenflowsTransport(cfg, reply({ errors: [{ message: "denied" }] }))("q", {}), ZenflowsRejected)
  await assert.rejects(zenflowsTransport(cfg, reply({ data: null }, 403))("q", {}), ZenflowsRejected)
  for (const f of [reply({ data: {} }, 502), reply({}),
    (async () => { throw new Error("socket hang up") }) as typeof fetch]) {
    await assert.rejects(zenflowsTransport(cfg, f)("q", {}), (e: Error) => !(e instanceof ZenflowsRejected))
  }
  assert.deepEqual(await zenflowsTransport(cfg, reply({ data: { ok: 1 } }))("q", {}), { ok: 1 })
})

test("transport sends the server-only admin value only when configured", async () => {
  const seen: Record<string, string>[] = []
  const f = (async (_u: unknown, init: any) => { seen.push(init.headers); return new Response('{"data":{}}') }) as typeof fetch
  await zenflowsTransport(cfg, f)("q", {})
  await zenflowsTransport({ ...cfg, admin: "secret" }, f)("q", {})
  assert.equal(seen[0]["zenflows-admin"], undefined)
  assert.equal(seen[1]["zenflows-admin"], "secret")
})

test("payload: per-order verified buyer wins over the legacy receiver; bound to the registry URL", () => {
  const p = syncPayloadFor(input, cfg)
  assert.equal(p.receiver, "verified-buyer")
  assert.equal(p.provider, "seller")
  assert.equal(p.target, cfg.url)
  assert.equal(p.has_point_in_time, "2026-10-23T12:00:00.000Z")
  assert.equal(syncPayloadFor({ ...input, receiver: undefined }, cfg).receiver, "legacy-demo-buyer")
})

test("payload: invalid quantities and missing agents never form a sync row; standalone forms none", () => {
  for (const quantity of [0, -1, NaN, Infinity]) assert.throws(() => syncPayloadFor({ ...input, quantity }, cfg))
  assert.throws(() => syncPayloadFor({ ...input, receiver: undefined }, { ...cfg, receiver: undefined }), /zenflows_agents_required/)
  assert.equal(newSyncRow("order-one", { ...input, receiver: undefined }, { ...cfg, receiver: undefined }), null)
  assert.equal(newSyncRow("order-one", input, null), null)
  const row = newSyncRow("order-one", input, cfg)!
  assert.equal(row.payload_hash, milestonePayloadHash(row.payload))
  assert.match(row.marker, /^ifzs-[0-9a-f]{32}$/)
})

test("same idempotency key, changed payload: refused as a conflict", () => {
  const row = newSyncRow("order-one", input, cfg)!
  assert.doesNotThrow(() => assertSameSyncPayload(row, syncPayloadFor(input, cfg)))
  for (const changed of [syncPayloadFor({ ...input, receiver: "someone-else" }, cfg),
    syncPayloadFor(input, { ...cfg, url: "http://other/api" }), syncPayloadFor({ ...input, quantity: 3 }, cfg)])
    assert.throws(() => assertSameSyncPayload(row, changed), /zenflows_sync_payload_conflict/)
})

test("legacy resource and receiver environment variables are not required for per-order buyers", () => {
  const saved = { ...process.env }
  try {
    process.env.INTERFACER_ZENFLOWS_URL = cfg.url
    process.env.INTERFACER_ZENFLOWS_PROVIDER = cfg.provider
    process.env.INTERFACER_ZENFLOWS_UNIT = cfg.unit
    delete process.env.INTERFACER_ZENFLOWS_RESOURCE
    delete process.env.INTERFACER_ZENFLOWS_RECEIVER
    assert.equal(zenflowsConfig()?.url, cfg.url)
  } finally { process.env = saved }
})
