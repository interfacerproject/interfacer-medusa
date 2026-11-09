import { verify, type KeyObject } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import { canonicalOperation } from "./envelope-canonical"
import { resolveLocalPersonPublicKey } from "./local-person-key-resolver"
import { commerceAudience } from "./deployment"

export interface Resource { id: string; name: string; primaryAccountable: { id: string } }
export interface SignedOperation {
  // aud: the instance this operation is for. Required exactly when this Medusa
  // has an audience (pilot); absent otherwise, so envelopes never cross over.
  envelope: { op: string; params: unknown; person_id: string; nonce: string; issued_at: string; aud?: string }
  signature: string // exactly 64 Ed25519 signature bytes in canonical base64
}
export const AUTH_HEADER = "x-interfacer-auth"
export function signatureDenied(): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "authorization_denied")
}
// Header transports JSON as base64url, not as the signed bytes. Re-canonicalize
// the strictly shaped envelope and verify the actual operation, never a digest
// or controller supplied by the request. Resolver outages fail closed too.
export function authFromHeader(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) } catch { return undefined }
}
export function verifySignedOperation(auth: unknown, op: string, params: unknown, controller: string, registeredKey?: KeyObject): string {
  try {
    const a = auth as SignedOperation
    if (!a || Object.keys(a).sort().join(",") !== "envelope,signature") signatureDenied()
    const e = a.envelope
    const audience = commerceAudience()
    if (!e || Object.keys(e).sort().join(",") !== (audience ? "aud," : "") + "issued_at,nonce,op,params,person_id" ||
        (audience && e.aud !== audience) || e.op !== op || typeof e.person_id !== "string" || e.person_id !== controller ||
        typeof e.nonce !== "string" || !/^[0-9a-f]{32}$/.test(e.nonce) ||
        typeof e.issued_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.issued_at) ||
        !Number.isFinite(Date.parse(e.issued_at)) ||
        Math.abs(Date.now() - Date.parse(e.issued_at)) > 5 * 60_000 ||
        canonicalOperation(e.params) !== canonicalOperation(params) ||
        typeof a.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(a.signature)) signatureDenied()
    const signature = Buffer.from(a.signature, "base64")
    const key = registeredKey ?? resolveLocalPersonPublicKey(e.person_id)
    if (!key || signature.length !== 64 || signature.toString("base64") !== a.signature ||
        !verify(null, Buffer.from(canonicalOperation(e), "utf8"), key, signature)) signatureDenied()
    return e.person_id
  } catch { return signatureDenied() }
}

// Bind buyer authorization to the cart, resolved immutable purchase references,
// currency and actual priced lines. Editable cart metadata cannot manufacture it.
export function checkoutOperationParams(cart: { id: string; currency_code?: string; items?: {
  variant_id?: string | null; quantity: unknown; unit_price?: unknown
}[] }, purchase: unknown) {
  return { cart_id: cart.id, currency_code: cart.currency_code, purchase,
    items: (cart.items ?? []).map(i => ({ variant_id: i.variant_id,
      quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
      .sort((a, b) => String(a.variant_id) < String(b.variant_id) ? -1 : String(a.variant_id) > String(b.variant_id) ? 1 : 0) }
}
