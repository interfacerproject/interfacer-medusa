import assert from "node:assert/strict"
import { test } from "node:test"
import { writeZenflowsEvent, zenflowsConfig, type ZenflowsConfig } from "../modules/interfacer/zenflows-event"

const cfg: ZenflowsConfig = { url: "http://zenflows.test/api", provider: "seller", receiver: "legacy-demo-buyer", unit: "one" }
const input = { action: "produce" as const, quantity: 2, has_point_in_time: new Date("2026-10-23T12:00:00.000Z"),
  resource_name: "Custom part", resource_tracking_id: "design-one", receiver: "verified-buyer", note: "order-one" }
function zenflows() {
  const calls: any[] = []
  const f = (async (_url: any, init: any) => {
    const call = JSON.parse(init.body)
    calls.push(call)
    let data
    if (call.query.includes("resourceSpecifications")) data = { resourceSpecifications: { edges: [{ node: { id: "product-spec", name: "Product" } }] } }
    else if (call.query.includes("createProcess")) data = { createProcess: { process: { id: "process-one" } } }
    else data = { createEconomicEvent: { economicEvent: { id: call.variables.e.action + "-event", resourceInventoriedAs: { id: "resource-one" } } } }
    return new Response(JSON.stringify({ data }))
  }) as typeof fetch
  return { calls, f }
}

test("build creates a finished Process, produces its output to the provider, then transfers it to the verified buyer", async () => {
  const { calls, f } = zenflows()
  assert.equal(await writeZenflowsEvent(input, cfg, f), "transfer-event")
  const process = calls.find(c => c.query.includes("createProcess"))
  assert.equal(process.variables.p.finished, true)
  const events = calls.filter(c => c.variables.e).map(c => c.variables.e)
  assert.deepEqual(events.map(e => e.action), ["produce", "transfer"])
  assert.equal(events[0].outputOf, "process-one")
  assert.equal(events[0].provider, "seller")
  assert.equal(events[0].receiver, "seller")
  assert.equal(events[1].receiver, "verified-buyer")
  assert.equal(events[1].resourceInventoriedAs, "resource-one")
  assert.deepEqual(events[1].resourceQuantity, { hasNumericalValue: 2, hasUnit: "one" })
  assert.equal(calls.find(c => c.variables.r).variables.r.trackingIdentifier, "design-one")
})

test("stock still raises then transfers, without manufacturing a Process", async () => {
  const { calls, f } = zenflows()
  await writeZenflowsEvent({ ...input, action: "transfer", quantity: 1 }, cfg, f)
  assert.ok(!calls.some(c => c.query.includes("createProcess")))
  assert.deepEqual(calls.filter(c => c.variables.e).map(c => c.variables.e.action), ["raise", "transfer"])
})

test("standalone is a no-op; incomplete identities and invalid quantities never write", async () => {
  const { calls, f } = zenflows()
  assert.equal(await writeZenflowsEvent(input, null, f), null)
  for (const quantity of [0, -1, NaN, Infinity]) await assert.rejects(writeZenflowsEvent({ ...input, quantity }, cfg, f))
  await assert.rejects(writeZenflowsEvent({ ...input, receiver: undefined }, { ...cfg, receiver: undefined }, f))
  assert.equal(calls.length, 0)
})

test("HTTP/GraphQL failure aborts before transfer; no process-global spec cache leaks across registries", async () => {
  for (const f of [(async () => new Response('{"data":{}}', { status: 500 })),
    (async () => new Response('{"errors":[{"message":"denied"}]}'))] as typeof fetch[])
    await assert.rejects(writeZenflowsEvent(input, cfg, f))
  const a = zenflows(), b = zenflows()
  await writeZenflowsEvent(input, cfg, a.f)
  await writeZenflowsEvent(input, { ...cfg, url: "http://other/api" }, b.f)
  assert.ok(b.calls.some(c => c.query.includes("resourceSpecifications")))
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
