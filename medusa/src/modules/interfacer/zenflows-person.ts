import { createPublicKey, type KeyObject } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import { decodeBase58 } from "./base58"
import { resolveLocalPersonPublicKey } from "./local-person-key-resolver"
import { signatureDenied, verifySignedOperation } from "./signed-envelope"
import { zenflowsConfig, zenflowsTransport, type ZenflowsConfig } from "./zenflows-event"
import { pilotMode } from "./deployment"
import { consumeEnvelopeNonce } from "./envelope-nonces"

// stored: re-checking an authorization persisted when its request arrived (its
// nonce was consumed then). Every request-borne envelope is consumed once.
export type VerifyOptions = { stored?: boolean }

export type RegisteredPerson = { id: string; name: string; user: string; publicKey: KeyObject }

function registryConfig(): ZenflowsConfig {
  const cfg = zenflowsConfig()
  if (!cfg) throw new Error("zenflows_registry_not_configured")
  return cfg
}

// Through the shared transport: signed by Medusa's service Person when Zenflows
// authenticates calls. Any outage, error or mismatch throws (callers deny).
export async function readZenflowsPerson(
  id: string, cfg: ZenflowsConfig = registryConfig(), fetchImpl: typeof fetch = fetch,
): Promise<RegisteredPerson> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid_zenflows_person")
  let person: any
  try {
    person = (await zenflowsTransport(cfg, fetchImpl)(
      "query($id: ID!) { person(id: $id) { id name user eddsaPublicKey } }", { id }))?.person
  } catch { throw new Error("zenflows_registry_unavailable") }
  if (person?.id !== id || typeof person.eddsaPublicKey !== "string" || typeof person.user !== "string")
    throw new Error("zenflows_registered_key_required")
  // Keypairoom publishes base58, not base64. Accept canonical padded base64 as
  // well for registries which explicitly use that encoding; never guess raw PEM.
  const encoded = person.eddsaPublicKey
  const raw = /^[A-Za-z0-9+/]{43}=$/.test(encoded)
    ? Buffer.from(encoded, "base64") : Buffer.from(decodeBase58(encoded))
  if (raw.length !== 32 || (encoded.endsWith("=") && raw.toString("base64") !== encoded))
    throw new Error("zenflows_registered_key_required")
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki",
  })
  return { id, name: person.name, user: person.user, publicKey }
}

async function verifyZenflowsSignature(
  auth: unknown, op: string, params: unknown, person: string, cfg?: ZenflowsConfig, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const registered = await readZenflowsPerson(person, cfg, fetchImpl)
    return verifySignedOperation(auth, op, params, person, registered.publicKey)
  } catch { return signatureDenied() }
}

// Remote identities NEVER fall back to caller-supplied or fixture keys on a
// registry failure. Session creation always takes this path.
export async function verifyZenflowsOperation(
  auth: unknown, op: string, params: unknown, person: string,
  cfg?: ZenflowsConfig, fetchImpl: typeof fetch = fetch, opts: VerifyOptions = {},
): Promise<string> {
  const subject = await verifyZenflowsSignature(auth, op, params, person, cfg, fetchImpl)
  if (!opts.stored) await consumeEnvelopeNonce(auth)
  return subject
}

// Fixture actors remain supported ONLY for the standalone local demo. In live
// mode (a Zenflows URL is configured) every actor proves the key Zenflows has
// registered for them; a disposable fixture identity is refused outright.
// A pilot has no fixture keyring at all.
export async function verifyCommerceOperation(
  auth: unknown, op: string, params: unknown, person: string, opts: VerifyOptions = {},
): Promise<string> {
  let fixture: KeyObject | undefined
  if (!pilotMode()) try { fixture = resolveLocalPersonPublicKey(person) } catch { return signatureDenied() }
  if (fixture && process.env.INTERFACER_ZENFLOWS_URL)
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "fixture_identity_forbidden")
  let subject: string
  try {
    subject = fixture ? verifySignedOperation(auth, op, params, person, fixture)
      : await verifyZenflowsSignature(auth, op, params, person)
  } catch { return signatureDenied() }
  if (!opts.stored) await consumeEnvelopeNonce(auth)
  return subject
}
