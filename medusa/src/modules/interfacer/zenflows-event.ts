// Live local Zenflows configuration and GraphQL transport for the milestone
// outbox (zenflows-sync.ts owns the write sequence: stock raise -> transfer;
// build Process -> produce -> transfer). Live sellers, units and buyers come
// per order from bindings/quotes/identity links; the env provider/unit/receiver
// are only fallbacks for fixture data. Unconfigured = local receipt only.
import { ZenflowsRejected, type Gql } from "./zenflows-sync"

export type ZenflowsConfig = {
  url: string
  provider?: string // fixture seller fallback only; live bindings/quotes supply per-order
  receiver?: string // legacy fixture buyer only; real sessions supply per-order
  unit?: string // fixture fallback; live listings carry the resource unit
  admin?: string
}

export function zenflowsConfig(): ZenflowsConfig | null {
  const url = process.env.INTERFACER_ZENFLOWS_URL
  if (!url) return null
  return { url, provider: process.env.INTERFACER_ZENFLOWS_PROVIDER, unit: process.env.INTERFACER_ZENFLOWS_UNIT,
    receiver: process.env.INTERFACER_ZENFLOWS_RECEIVER, admin: process.env.INTERFACER_ZENFLOWS_ADMIN }
}

// Classifies failures for the outbox: GraphQL errors and HTTP 4xx mean Zenflows
// did not write (its transaction rolled back) -> ZenflowsRejected. Network
// errors, timeouts, 5xx and unreadable replies are ambiguous -> plain Error.
export function zenflowsTransport(cfg: ZenflowsConfig, fetchImpl: typeof fetch = fetch): Gql {
  return async (query, variables) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (cfg.admin) headers["zenflows-admin"] = cfg.admin
    const res = await fetchImpl(cfg.url, { method: "POST", headers, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ query, variables }) })
    if (res.status >= 400 && res.status < 500) throw new ZenflowsRejected("zenflows_http_error: " + res.status)
    if (!res.ok) throw new Error("zenflows_http_error: " + res.status)
    const json: any = await res.json()
    if (json?.errors?.length) throw new ZenflowsRejected("zenflows_error: " + JSON.stringify(json.errors).slice(0, 400))
    if (!json?.data) throw new Error("zenflows_malformed_reply")
    return json.data
  }
}
