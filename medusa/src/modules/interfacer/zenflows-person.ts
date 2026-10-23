import { createPublicKey, type KeyObject } from "node:crypto"
import { decodeBase58 } from "./base58"
import { resolveLocalPersonPublicKey } from "./local-person-key-resolver"
import { signatureDenied, verifySignedOperation } from "./signed-envelope"

type RegistryConfig = { url: string; admin?: string }
export type RegisteredPerson = { id: string; name: string; publicKey: KeyObject }

function registryConfig(): RegistryConfig {
  const url = process.env.INTERFACER_ZENFLOWS_URL
  if (!url) throw new Error("zenflows_registry_not_configured")
  return { url, admin: process.env.INTERFACER_ZENFLOWS_ADMIN }
}

export async function readZenflowsPerson(
  id: string, cfg: RegistryConfig = registryConfig(), fetchImpl: typeof fetch = fetch,
): Promise<RegisteredPerson> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid_zenflows_person")
  const res = await fetchImpl(cfg.url, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...(cfg.admin ? { "zenflows-admin": cfg.admin } : {}) },
    body: JSON.stringify({ query: "query($id: ID!) { person(id: $id) { id name eddsaPublicKey } }", variables: { id } }),
  })
  if (!res.ok) throw new Error("zenflows_registry_unavailable")
  const json = await res.json() as any
  const person = json.data?.person
  if (json.errors?.length || person?.id !== id || typeof person.eddsaPublicKey !== "string")
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
  return { id, name: person.name, publicKey }
}

// Remote identities NEVER fall back to caller-supplied or fixture keys on a
// registry failure. Session creation always takes this path.
export async function verifyZenflowsOperation(
  auth: unknown, op: string, params: unknown, person: string,
  cfg?: RegistryConfig, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const registered = await readZenflowsPerson(person, cfg, fetchImpl)
    return verifySignedOperation(auth, op, params, person, registered.publicKey)
  } catch { return signatureDenied() }
}

// Fixture actors remain explicitly supported for the standalone local demo.
// A trusted local registry entry is not an HTTP enrollment mechanism.
export async function verifyCommerceOperation(auth: unknown, op: string, params: unknown, person: string): Promise<string> {
  try {
    const fixture = resolveLocalPersonPublicKey(person)
    if (fixture) return verifySignedOperation(auth, op, params, person, fixture)
    return await verifyZenflowsOperation(auth, op, params, person)
  } catch { return signatureDenied() }
}
