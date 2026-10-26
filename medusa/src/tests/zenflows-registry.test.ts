import assert from "node:assert/strict"
import { test } from "node:test"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalOperation } from "../modules/interfacer/envelope-canonical"
import { derivedDppReference, liveMode, readInstance, readResource } from "../modules/interfacer/zenflows-registry"
import { verifyCommerceOperation } from "../modules/interfacer/zenflows-person"

const cfg = { url: "http://zenflows.test/api" }
const id = "06GQJA64TH58GE0PK499R8K4C8"
const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
const node = { id, name: "Smoke design", conformsTo: { id: "spec-design", name: "Design" },
  primaryAccountable: { id: "06GQJA64CNQSFSSTJW8B4E8AK0", __typename: "Person" }, custodian: { id: "06GQJA64CNQSFSSTJW8B4E8AK0" },
  onhandQuantity: { hasNumericalValue: "1", hasUnit: { id: "unit-one" } },
  accountingQuantity: { hasNumericalValue: "1", hasUnit: { id: "unit-one" } } }

test("readResource maps Zenflows facts (string quantities) and returns null for a missing resource", async () => {
  assert.deepEqual(await readResource(id, cfg, reply({ data: { economicResource: node } })), {
    id, name: "Smoke design", spec: { id: "spec-design", name: "Design" },
    accountable: "06GQJA64CNQSFSSTJW8B4E8AK0", accountableType: "Person", custodian: "06GQJA64CNQSFSSTJW8B4E8AK0",
    onhand: 1, accounting: 1, unit: "unit-one" })
  assert.equal(await readResource(id, cfg, reply({ data: { economicResource: null },
    errors: [{ message: "not found", path: ["economicResource"] }] })), null)
})

test("readResource fails closed on outage, malformed replies and invalid ids", async () => {
  await assert.rejects(readResource(id, cfg, reply({}, 503)))
  await assert.rejects(readResource(id, cfg, reply({ errors: [{ message: "denied" }] })))
  await assert.rejects(readResource(id, cfg, reply({ data: { economicResource: { ...node, id: "06GOTHER00000000000000000A" } } })))
  await assert.rejects(readResource(id, cfg, reply({ data: { economicResource: { ...node, onhandQuantity: null } } })))
  await assert.rejects(readResource("not-an-id", cfg, reply({ data: { economicResource: node } })), /invalid_zenflows_resource/)
})

test("readInstance returns the Interfacer project specs and unitOne; incomplete instances throw", async () => {
  const v = { specs: { specProjectDesign: { id: "d", name: "Design" }, specProjectService: { id: "s", name: "Service" },
    specProjectProduct: { id: "p", name: "Product" } }, units: { unitOne: { id: "u" } } }
  assert.deepEqual(await readInstance(cfg, reply({ data: { instanceVariables: v } })),
    { specs: { design: { id: "d", name: "Design" }, service: { id: "s", name: "Service" }, product: { id: "p", name: "Product" } }, unitOne: "u" })
  await assert.rejects(readInstance(cfg, reply({ data: { instanceVariables: { ...v, units: {} } } })), /zenflows_instance_incomplete/)
})

test("DPP reference is derived from the resource, never asserted", () => {
  assert.equal(derivedDppReference(id), "zenflows:traceDpp:" + id)
})

test("live mode refuses fixture identities even with a valid fixture signature; standalone keeps them", async () => {
  const pair = generateKeyPairSync("ed25519")
  const dir = mkdtempSync(join(tmpdir(), "keyring-"))
  const keyring = join(dir, "public.json")
  writeFileSync(keyring, JSON.stringify({ "fixture-seller": pair.publicKey.export({ type: "spki", format: "pem" }) }))
  const params = { order_id: "order_one" }
  const envelope = { op: "commerce.order.deliver", params, person_id: "fixture-seller",
    nonce: randomBytes(16).toString("hex"), issued_at: new Date().toISOString() }
  const auth = { envelope, signature: sign(null, Buffer.from(canonicalOperation(envelope)), pair.privateKey).toString("base64") }
  const saved = { ...process.env }
  try {
    process.env.INTERFACER_KEYRING_PATH = keyring
    delete process.env.INTERFACER_ZENFLOWS_URL
    assert.equal(liveMode(), false)
    assert.equal(await verifyCommerceOperation(auth, "commerce.order.deliver", params, "fixture-seller"), "fixture-seller")
    process.env.INTERFACER_ZENFLOWS_URL = cfg.url
    assert.equal(liveMode(), true)
    await assert.rejects(verifyCommerceOperation(auth, "commerce.order.deliver", params, "fixture-seller"), /fixture_identity_forbidden/)
  } finally { process.env = saved }
})
