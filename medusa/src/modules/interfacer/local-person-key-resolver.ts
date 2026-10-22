// LOCAL STAND-IN for the Zenflows registered-key/Person registry, NOT a PDP.
// No request may supply its own verification key or enroll a key over HTTP.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createPublicKey, type KeyObject } from "node:crypto"

export function resolveLocalPersonPublicKey(personId: string): KeyObject | undefined {
  const path = process.env.INTERFACER_KEYRING_PATH || resolve(__dirname, "../../../../docs/fixtures/auth-public-keyring.json")
  const keyring = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>
  if (!Object.prototype.hasOwnProperty.call(keyring, personId)) return undefined
  const key = createPublicKey(keyring[personId])
  if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid_registered_key")
  return key
}
