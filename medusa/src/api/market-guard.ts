import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "./dev/interfacer/local-guard"
import { allowStorefront } from "../storefront/dev"
import { commerceMode, PROXY_HEADER, proxyKeyMatches } from "../modules/interfacer/deployment"

// The marketplace API lives under /market. Locally the same handlers keep their
// /dev aliases and the loopback-only guards. A pilot answers only /market/*,
// only to the GUI proxy (shared key); CORS is not involved, since browsers
// never reach Medusa. Signatures and bearer checks are unchanged either way.

function requestPath(req: MedusaRequest): string {
  return (req.originalUrl ?? req.url ?? "").split("?")[0]
}

function fromProxy(req: MedusaRequest, res: MedusaResponse): boolean {
  res.setHeader("Cache-Control", "no-store")
  if (!proxyKeyMatches(req.headers[PROXY_HEADER])) {
    res.status(403).json({ reason: "market_proxy_required" })
    return false
  }
  return true
}

export function allowMarketRequest(req: MedusaRequest, res: MedusaResponse): boolean {
  if (commerceMode() !== "pilot") return allowLocalRequest(req, res)
  if (!requestPath(req).startsWith("/market/")) {
    res.status(404).json({ reason: "not_found" })
    return false
  }
  return fromProxy(req, res)
}

// Scene, session, prepare, capture, seller console and the Zenflows relay.
export function allowMarketStorefront(req: MedusaRequest, res: MedusaResponse): boolean {
  if (commerceMode() !== "pilot") return allowStorefront(req, res)
  if (!allowMarketRequest(req, res)) return false
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "no-referrer")
  return true
}

// Native /store and customer /auth routes: in a pilot, the GUI proxy only.
// Admin login (/auth/user) stays reachable for operators over an SSH tunnel.
export function pilotProxyOnly(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (commerceMode() !== "pilot" || fromProxy(req, res)) next()
}
