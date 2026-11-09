import assert from "node:assert/strict"
import { test } from "node:test"
import { generateKeyPairSync } from "node:crypto"
import { signZenflowsBody, verifyZenflowsBody, zenflowsBody, zenflowsSignedMessage } from "../modules/interfacer/zenflows-signing"
import { zenflowsTransport } from "../modules/interfacer/zenflows-event"
import { buildWrite } from "../modules/interfacer/zenflows-sync"

function base58(bytes: Uint8Array): string {
  const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", d: number[] = []
  for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] * 256; d[i] = c % 58; c = Math.floor(c / 58) } while (c) { d.push(c % 58); c = Math.floor(c / 58) } }
  let l = ""; for (const b of bytes) { if (b !== 0) break; l += "1" }
  return l + d.reverse().map(x => a[x]).join("")
}
const pair = generateKeyPairSync("ed25519")
const seed = base58(Buffer.from((pair.privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url"))

test("signed message = canonical body without spaces; non-canonical bodies are refused, not guessed", () => {
  assert.equal(zenflowsSignedMessage('{"query":"{ units { id } }"}'), '{"query":"{units{id}}"}')
  for (const bad of ['{"query":"{\n units }"}', '{"query":"{\\n units }"}', '{"q":"café"}', '{"q":"tab\there"}', ""])
    assert.throws(() => zenflowsSignedMessage(bad), /zenflows_body_not_canonical/, JSON.stringify(bad))
})

test("zenflowsBody collapses multi-line queries to one canonical line", () => {
  const body = zenflowsBody(`mutation($e: X!) {\n  createEconomicEvent(event: $e) {\n    economicEvent { id }\n  }\n}`, { e: { note: "a b" } })
  assert.equal(body, '{"query":"mutation($e: X!) { createEconomicEvent(event: $e) { economicEvent { id } } }","variables":{"e":{"note":"a b"}}}')
  assert.doesNotThrow(() => zenflowsSignedMessage(body))
})

test("Ed25519 over the signed message verifies with the person's key; any change fails", () => {
  const body = zenflowsBody("{ units { id } }", { id: "06GQJA64TH58GE0PK499R8K4C8" })
  const signature = signZenflowsBody(body, seed)
  assert.equal(verifyZenflowsBody(body, signature, pair.publicKey), true)
  // Spaces are not signed (Zenflows strips them too); anything else is.
  assert.equal(verifyZenflowsBody(body.replace("units", "un its"), signature, pair.publicKey), true)
  assert.equal(verifyZenflowsBody(body.replace("units", "unitz"), signature, pair.publicKey), false)
  assert.equal(verifyZenflowsBody(body, signature, generateKeyPairSync("ed25519").publicKey), false)
  assert.equal(verifyZenflowsBody(body, "not-a-signature", pair.publicKey), false)
})

test("transport signs every body as the service account; a relayed per-call signature replaces it", async () => {
  const seen: { body: string; headers: Record<string, string> }[] = []
  const f = (async (_u: unknown, init: any) => { seen.push({ body: init.body, headers: init.headers })
    return new Response('{"data":{"ok":true}}') }) as typeof fetch
  const gql = zenflowsTransport({ url: "http://zf/api", service: { user: "medusa-service", seed } }, f)
  await gql("query($id: ID!) {\n  person(id: $id) { id }\n}", { id: "06GQJA64TH58GE0PK499R8K4C8" })
  assert.equal(seen[0].headers["zenflows-user"], "medusa-service")
  assert.equal(seen[0].body, zenflowsBody("query($id: ID!) { person(id: $id) { id } }", { id: "06GQJA64TH58GE0PK499R8K4C8" }))
  assert.equal(verifyZenflowsBody(seen[0].body, seen[0].headers["zenflows-sign"], pair.publicKey), true)
  await gql("{ units { id } }", {}, { "zenflows-user": "seller", "zenflows-sign": "relayed" })
  assert.equal(seen[1].headers["zenflows-user"], "seller")
  assert.equal(seen[1].headers["zenflows-sign"], "relayed")
  await zenflowsTransport({ url: "http://zf/api" }, f)("{ units { id } }", {})
  assert.equal(seen[2].headers["zenflows-sign"], undefined)
  // Zenflows ignores signatures when the admin header is present: never both.
  await zenflowsTransport({ url: "http://zf/api", admin: "A", service: { user: "medusa-service", seed } }, f)("{ units { id } }", {})
  assert.equal(seen[3].headers["zenflows-admin"], undefined)
  assert.ok(seen[3].headers["zenflows-sign"])
})

// Shared vector with interfacer-gui lib/market/relay.ts RELAY_QUERIES: the GUI
// refuses to sign any other write shape, so a change here must change both.
test("outbox write queries are pinned to the GUI relay allowlist", async () => {
  const base: any = { id: "x", marker: "ifzs-0", process_id: "pr", resource_id: "rs", payload: { target: "t", action: "produce",
    provider: "p", receiver: "r", unit: "u", spec_name: "Product", quantity: 1, has_point_in_time: "2026-01-01T00:00:00.000Z",
    resource_name: "n", resource_tracking_id: "t", note: "n" } }
  const gql: any = async () => ({ resourceSpecifications: { edges: [{ node: { id: "s", name: "Product" } }] } })
  const q = async (s: any, step: any) => JSON.parse(zenflowsBody((await buildWrite(s, step, gql)).query, {})).query
  assert.equal(await q(base, "process"), "mutation($p: ProcessCreateParams!) { createProcess(process: $p) { process { id } } }")
  assert.equal(await q(base, "create"), "mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) { createEconomicEvent(event: $e, newInventoriedResource: $r) { economicEvent { id resourceInventoriedAs { id } } } }")
  assert.equal(await q(base, "transfer"), "mutation($e: EconomicEventCreateParams!) { createEconomicEvent(event: $e) { economicEvent { id } } }")
  assert.equal(await q({ ...base, payload: { ...base.payload, source_resource_id: "src" } }, "transfer"),
    "mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) { createEconomicEvent(event: $e, newInventoriedResource: $r) { economicEvent { id } } }")
})
