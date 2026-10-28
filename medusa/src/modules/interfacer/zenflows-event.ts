// Live local Zenflows configuration and GraphQL transport for the milestone
// outbox (zenflows-sync.ts owns the write sequence: stock raise -> transfer;
// build Process -> produce -> transfer). Live sellers, units and buyers come
// per order from bindings/quotes/identity links; the env provider/unit/receiver
// are only fallbacks for fixture data. Unconfigured = local receipt only.
import { ZenflowsRejected, type Gql } from "./zenflows-sync"
import { signZenflowsBody, zenflowsBody } from "./zenflows-signing"

export type ZenflowsConfig = {
  url: string
  provider?: string // fixture seller fallback only; live bindings/quotes supply per-order
  receiver?: string // legacy fixture buyer only; real sessions supply per-order
  unit?: string // fixture fallback; live listings carry the resource unit
  admin?: string
  // GQL_AUTH_CALLS=true: Medusa's own read-only Person signs every body it
  // sends. It never authorizes a write in a seller's name (see signedWrites).
  service?: { user: string; seed: string }
  // AUTHZ_ENFORCE=true: each outbox write is signed by its provider (relay).
  signedWrites?: boolean
}

export function zenflowsConfig(): ZenflowsConfig | null {
  const url = process.env.INTERFACER_ZENFLOWS_URL
  if (!url) return null
  const user = process.env.INTERFACER_ZENFLOWS_SERVICE_USER, seed = process.env.INTERFACER_ZENFLOWS_SERVICE_SEED
  if (Boolean(user) !== Boolean(seed)) throw new Error("zenflows_service_account_incomplete")
  return { url, provider: process.env.INTERFACER_ZENFLOWS_PROVIDER, unit: process.env.INTERFACER_ZENFLOWS_UNIT,
    receiver: process.env.INTERFACER_ZENFLOWS_RECEIVER, admin: process.env.INTERFACER_ZENFLOWS_ADMIN,
    ...(user && seed ? { service: { user, seed } } : {}),
    signedWrites: process.env.INTERFACER_ZENFLOWS_SIGNED_WRITES === "true" }
}

// Classifies failures for the outbox: GraphQL errors and HTTP 4xx mean Zenflows
// did not write (its transaction rolled back) -> ZenflowsRejected. Network
// errors, timeouts, 5xx and unreadable replies are ambiguous -> plain Error.
// The body is always zenflowsBody(): the exact bytes a signature covers.
export function zenflowsTransport(cfg: ZenflowsConfig, fetchImpl: typeof fetch = fetch): Gql {
  return async (query, variables, signed) => {
    const body = zenflowsBody(query, variables)
    const headers: Record<string, string> = { "content-type": "application/json" }
    // Zenflows ignores zenflows-user/-sign whenever zenflows-admin is present:
    // a signed call never carries the admin value.
    if (signed) Object.assign(headers, signed)
    else if (cfg.service) Object.assign(headers, { "zenflows-user": cfg.service.user,
      "zenflows-sign": signZenflowsBody(body, cfg.service.seed) })
    else if (cfg.admin) headers["zenflows-admin"] = cfg.admin
    const res = await fetchImpl(cfg.url, { method: "POST", headers, signal: AbortSignal.timeout(10_000), body })
    if (res.status >= 400 && res.status < 500) throw new ZenflowsRejected("zenflows_http_error: " + res.status)
    if (!res.ok) throw new Error("zenflows_http_error: " + res.status)
    const json: any = await res.json()
    if (json?.errors?.length) throw new ZenflowsRejected("zenflows_error: " + JSON.stringify(json.errors).slice(0, 400))
    if (!json?.data) throw new Error("zenflows_malformed_reply")
    return json.data
  }
}
