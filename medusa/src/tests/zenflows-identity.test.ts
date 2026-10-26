import assert from "node:assert/strict"
import { test } from "node:test"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { canonicalOperation } from "../modules/interfacer/envelope-canonical"
import { readZenflowsPerson, verifyZenflowsOperation } from "../modules/interfacer/zenflows-person"
import { BuyerChallenges } from "../modules/interfacer/buyer-challenges"

const person = "06GP97B63276AAAAAAAAAAAAAA"
const pair = generateKeyPairSync("ed25519")
const publicKey = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x
const cfg = { url: "http://zenflows.test/api" }
function proof(params: unknown, person_id = person, key = pair.privateKey) {
  const envelope = { op: "commerce.session.create", params, person_id,
    nonce: randomBytes(16).toString("hex"), issued_at: new Date().toISOString() }
  return { envelope, signature: sign(null, Buffer.from(canonicalOperation(envelope)), key).toString("base64") }
}
function registry(node: unknown, status = 200) {
  return (async () => new Response(JSON.stringify({ data: { person: node } }), { status })) as typeof fetch
}
const node = { id: person, name: "Buyer One", user: "buyerone", eddsaPublicKey: Buffer.from(publicKey, "base64url").toString("base64") }

test("registered Zenflows key verifies the bound operation without a request-supplied key", async () => {
  const params = { challenge: "challenge-one" }
  assert.equal(await verifyZenflowsOperation(proof(params), "commerce.session.create", params, person, cfg, registry(node)), person)
  await assert.rejects(verifyZenflowsOperation(proof(params), "commerce.session.create", { challenge: "different" }, person, cfg, registry(node)), /authorization_denied/)
  await assert.rejects(verifyZenflowsOperation(proof(params, person, generateKeyPairSync("ed25519").privateKey), "commerce.session.create", params, person, cfg, registry(node)), /authorization_denied/)
})

test("registry outage, wrong person, missing/malformed key and GraphQL errors fail closed", async () => {
  for (const fetchImpl of [registry(null), registry({ ...node, id: "other" }), registry({ ...node, eddsaPublicKey: "bad" }), registry(node, 503),
    (async () => new Response(JSON.stringify({ errors: [{ message: "denied" }] }))) as typeof fetch,
    (async () => { throw new Error("offline") }) as typeof fetch]) {
    await assert.rejects(readZenflowsPerson(person, cfg, fetchImpl))
    await assert.rejects(verifyZenflowsOperation(proof({}), "commerce.session.create", {}, person, cfg, fetchImpl), /authorization_denied/)
  }
})

test("challenge is bound to a person, expires, is consumed once and bounds memory", () => {
  let time = 1000
  const challenges = new BuyerChallenges(() => time, 100, 2)
  const challenge = challenges.issue(person)
  assert.throws(() => challenges.consume(challenge, "someone-else"), /buyer_challenge_invalid/)
  challenges.consume(challenge, person)
  assert.throws(() => challenges.consume(challenge, person), /buyer_challenge_invalid/)
  const old = challenges.issue(person)
  time += 101
  assert.throws(() => challenges.consume(old, person), /buyer_challenge_invalid/)
  challenges.issue(person); challenges.issue(person)
  assert.throws(() => challenges.issue(person), /buyer_challenge_capacity/)
  time += 101
  assert.ok(challenges.issue(person))
})
