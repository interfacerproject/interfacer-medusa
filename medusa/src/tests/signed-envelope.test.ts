import assert from "node:assert/strict"
import { test } from "node:test"
import { createPublicKey, verify } from "node:crypto"
import { canonicalOperation } from "../modules/interfacer/envelope-canonical"
import { authFromHeader, verifySignedOperation } from "../modules/interfacer/signed-envelope"
import { fixtureControllerCheck } from "../modules/interfacer/fixture-controller-check"
import { signLocalOperation } from "../scripts/sign-local-operation"

const person = "01JTESTPERSON00000000000001"
const op = "commerce.listing.create"
const params = { resource: { name: "Unicode — café", a: [1, false, null] }, dpp: { ID: "demo" } }

test("Node Ed25519 verifies RFC 8032 test vector 1 and rejects a changed signature", () => {
  const publicBytes = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex")
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]), type: "spki", format: "der" })
  const sig = Buffer.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "hex")
  assert(verify(null, Buffer.alloc(0), key, sig))
  sig[0] ^= 1
  assert(!verify(null, Buffer.alloc(0), key, sig))
})

test("real CLI signature, canonical nested key order and Unicode round-trip", () => {
  const auth = signLocalOperation(op, params, person)
  assert.equal(verifySignedOperation(auth, op, { dpp: params.dpp, resource: params.resource }, person), person)
  assert.equal(canonicalOperation({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}')
  assert.equal(verifySignedOperation(authFromHeader(Buffer.from(JSON.stringify(auth)).toString("base64url")), op, params, person), person)
})

test("unsigned, forged, wrong-key, non-controller, unknown key and resolver outage fail closed", () => {
  const auth = signLocalOperation(op, params, person)
  for (const bad of [undefined, { ...auth, signature: Buffer.alloc(64).toString("base64") },
    signLocalOperation(op, params, person, "some-other-person"),
    signLocalOperation(op, params, "some-other-person"),
    signLocalOperation(op, params, "unregistered-person", person),
    { ...auth, signature: auth.signature + "=" }]) {
    assert.throws(() => verifySignedOperation(bad, op, params, person), /authorization_denied/)
  }
  // Unknown Person really is denied by resolver even when expected controller.
  assert.throws(() => verifySignedOperation(signLocalOperation(op, params, "unregistered-person", person), op, params, "unregistered-person"), /authorization_denied/)
  const original = process.env.INTERFACER_KEYRING_PATH
  process.env.INTERFACER_KEYRING_PATH = "../.tmp/does-not-exist-public-keyring.json"
  try { assert.throws(() => verifySignedOperation(auth, op, params, person), /authorization_denied/) }
  finally {
    if (original === undefined) delete process.env.INTERFACER_KEYRING_PATH
    else process.env.INTERFACER_KEYRING_PATH = original
  }
})

test("operation/params/shape/nonce/time binding; old plaintext factory cannot authorize", () => {
  const auth = signLocalOperation(op, params, person)
  for (const change of [{ op: "commerce.order.deliver" }, { params: { ...params, priceEUR: 0.01 } },
    { nonce: "short" }, { issued_at: new Date(Date.now() - 600_000).toISOString() },
    { issued_at: new Date(Date.now() + 600_000).toISOString() }, { issued_at: "bad" },
    { version: 2 }]) {
    assert.throws(() => verifySignedOperation({ ...auth, envelope: { ...auth.envelope, ...change } }, op, params, person), /authorization_denied/)
  }
  assert.throws(() => fixtureControllerCheck(person), /fixture_controller_removed/)
  for (const value of [undefined, NaN, Infinity, { a: undefined }]) assert.throws(() => canonicalOperation(value))
  for (const value of [undefined, "not valid!", ["e30"]]) assert.equal(authFromHeader(value), undefined)
  assert.deepEqual(authFromHeader("e30"), {})
})
