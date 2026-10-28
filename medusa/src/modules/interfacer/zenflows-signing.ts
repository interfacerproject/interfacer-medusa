// Zenflows signed-call primitives (GQL_AUTH_CALLS=true). Zenflows verifies
// `zenflows-sign` with the Zencode verify_graphql contract, which strips spaces
// and "compacts ascii strings" (drops raw whitespace and escape sequences, and
// rewrites non-ASCII) before checking the Ed25519 signature. Medusa only ever
// builds or relays single-line printable-ASCII bodies without backslashes, for
// which that message is exactly the body without spaces (verified live against
// zvmlet verify_graphql, 2026-10-26). Anything else is refused, not guessed.
import { createPrivateKey, sign, verify, type KeyObject } from "node:crypto"
import { decodeBase58 } from "./base58"

const CANONICAL = /^[\x20-\x5b\x5d-\x7e]*$/ // printable ASCII and space, no backslash

export function zenflowsSignedMessage(body: string): string {
  if (typeof body !== "string" || !body.length || body.length > 100_000 || !CANONICAL.test(body))
    throw new Error("zenflows_body_not_canonical")
  return body.replace(/ /g, "")
}

function seedKey(seedBase58: string): KeyObject {
  const seed = Buffer.from(decodeBase58(seedBase58))
  if (seed.length !== 32) throw new Error("zenflows_service_seed_invalid")
  try {
    return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8" })
  } finally { seed.fill(0) }
}

export function signZenflowsBody(body: string, seedBase58: string): string {
  return sign(null, Buffer.from(zenflowsSignedMessage(body), "utf8"), seedKey(seedBase58)).toString("base64")
}

export function verifyZenflowsBody(body: string, signature: unknown, publicKey: KeyObject): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false
  try {
    return verify(null, Buffer.from(zenflowsSignedMessage(body), "utf8"), publicKey, Buffer.from(signature, "base64"))
  } catch { return false }
}

// The ONE serializer for every body Medusa sends or relays: GraphQL whitespace
// is insignificant outside string literals (our queries have none), so queries
// collapse to one line and the JSON stays canonical for signing.
export function zenflowsBody(query: string, variables: unknown): string {
  return JSON.stringify({ query: query.replace(/\s+/g, " ").trim(), variables })
}
