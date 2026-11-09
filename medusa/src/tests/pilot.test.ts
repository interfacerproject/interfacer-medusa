import assert from "node:assert/strict"
import { test } from "node:test"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { canonicalOperation } from "../modules/interfacer/envelope-canonical"
import { verifySignedOperation } from "../modules/interfacer/signed-envelope"
import { consumeEnvelopeNonce, envelopeNoncesRequired, type NonceStore } from "../modules/interfacer/envelope-nonces"
import {
  commerceAudience, commerceMode, pilotConfigProblems, proxyKeyMatches,
} from "../modules/interfacer/deployment"

const PILOT = {
  INTERFACER_DEPLOYMENT: "pilot", NODE_ENV: "production",
  INTERFACER_ZENFLOWS_URL: "https://zenflows.example.org/api", INTERFACER_ZENFLOWS_SIGNED_WRITES: "true",
  INTERFACER_ZENFLOWS_SERVICE_USER: "medusa", INTERFACER_ZENFLOWS_SERVICE_SEED: "seed",
  INTERFACER_PROXY_KEY: "k".repeat(40), INTERFACER_COMMERCE_AUDIENCE: "interfacer-commerce:dpp-dev",
  JWT_SECRET: "j".repeat(40), COOKIE_SECRET: "c".repeat(40),
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v
  try { return run() } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v
  }
}
async function withEnvAsync(env: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v
  try { await run() } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v
  }
}

const person = "06GW434E8K9K8RQ30VN2GMX1HR"
const op = "catalog.build.list"
const params = { service_id: "s", design_id: "d" }
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
function envelopeAuth(extra: Record<string, unknown> = {}) {
  const envelope = { op, params, person_id: person, nonce: randomBytes(16).toString("hex"),
    issued_at: new Date().toISOString(), ...extra }
  return { envelope, signature: sign(null, Buffer.from(canonicalOperation(envelope)), privateKey).toString("base64") }
}

test("mode: pilot wins, local needs the fixture switch outside production, otherwise none", () => {
  assert.equal(commerceMode({ INTERFACER_DEPLOYMENT: "pilot" }), "pilot")
  assert.equal(commerceMode({ INTERFACER_AUTH_MODE: "signed-envelope-local", NODE_ENV: "development" }), "local")
  assert.equal(commerceMode({ INTERFACER_AUTH_MODE: "signed-envelope-local", NODE_ENV: "production" }), null)
  assert.equal(commerceMode({}), null)
})

test("pilot config: complete passes; each missing secret or fixture switch is named", () => {
  assert.deepEqual(pilotConfigProblems(PILOT), [])
  assert.deepEqual(pilotConfigProblems({}), [])
  assert.deepEqual(pilotConfigProblems({ INTERFACER_DEPLOYMENT: "staging" }), ["INTERFACER_DEPLOYMENT must be pilot or unset"])
  const broken = pilotConfigProblems({ ...PILOT, NODE_ENV: "development", INTERFACER_AUTH_MODE: "signed-envelope-local",
    INTERFACER_ZENFLOWS_ADMIN: "x", INTERFACER_PROXY_KEY: "short", INTERFACER_COMMERCE_AUDIENCE: "dpp-dev",
    INTERFACER_ZENFLOWS_SIGNED_WRITES: "false", JWT_SECRET: "supersecret" })
  for (const needle of ["NODE_ENV", "INTERFACER_AUTH_MODE", "INTERFACER_ZENFLOWS_ADMIN", "INTERFACER_PROXY_KEY",
    "INTERFACER_COMMERCE_AUDIENCE", "SIGNED_WRITES", "JWT_SECRET"])
    assert(broken.some(p => p.includes(needle)), needle)
})

test("proxy key: exact match only, never with a short configured key", () => {
  assert(proxyKeyMatches("k".repeat(40), PILOT))
  assert(!proxyKeyMatches("k".repeat(39), PILOT))
  assert(!proxyKeyMatches(undefined, PILOT))
  assert(!proxyKeyMatches(["k".repeat(40)], PILOT))
  assert(!proxyKeyMatches("short", { INTERFACER_PROXY_KEY: "short" }))
})

test("audience: a pilot requires its own; a local stack refuses any", () => {
  withEnv(PILOT, () => {
    assert.equal(commerceAudience(), "interfacer-commerce:dpp-dev")
    assert.equal(verifySignedOperation(envelopeAuth({ aud: "interfacer-commerce:dpp-dev" }), op, params, person, publicKey), person)
    for (const bad of [envelopeAuth(), envelopeAuth({ aud: "interfacer-commerce:other" })])
      assert.throws(() => verifySignedOperation(bad, op, params, person, publicKey), /authorization_denied/)
  })
  withEnv({ INTERFACER_DEPLOYMENT: undefined }, () => {
    assert.equal(verifySignedOperation(envelopeAuth(), op, params, person, publicKey), person)
    assert.throws(() => verifySignedOperation(envelopeAuth({ aud: "interfacer-commerce:dpp-dev" }), op, params, person, publicKey),
      /authorization_denied/)
  })
})

test("nonces: required in pilot or on opt-in; a second use and a store outage are refused", async () => {
  assert(envelopeNoncesRequired(PILOT))
  assert(envelopeNoncesRequired({ INTERFACER_ENVELOPE_NONCES: "durable" }))
  assert(!envelopeNoncesRequired({}))
  const seen = new Set<string>()
  const store: NonceStore = async (p, n) => !seen.has(p + n) && Boolean(seen.add(p + n))
  const auth = envelopeAuth()
  await withEnvAsync({ INTERFACER_DEPLOYMENT: undefined, INTERFACER_ENVELOPE_NONCES: "durable" }, async () => {
    await consumeEnvelopeNonce(auth, store)
    await assert.rejects(consumeEnvelopeNonce(auth, store), /authorization_replayed/)
    await consumeEnvelopeNonce(envelopeAuth(), store)
    await assert.rejects(consumeEnvelopeNonce(envelopeAuth(), async () => { throw new Error("db down") }),
      /authorization_unavailable/)
  })
  await withEnvAsync({ INTERFACER_DEPLOYMENT: undefined, INTERFACER_ENVELOPE_NONCES: undefined }, async () => {
    await consumeEnvelopeNonce(auth, store) // not required locally: no store call, no refusal
  })
})
