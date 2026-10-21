import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { DEV_GUI_ORIGINS } from "../../../dev-origins"

// Medusa 2.10.3 only automatically applies configured CORS to /store, /admin,
// and /auth. This custom /dev namespace needs explicit CORS and preflight.
// CORS is NOT authentication: callers can assert any fixture controller.
export function allowLocalRequest(req: MedusaRequest, res: MedusaResponse): boolean {
  res.setHeader("Cache-Control", "no-store")
  res.vary("Origin")
  const origin = req.headers.origin
  if (origin && DEV_GUI_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  }
  if (process.env.INTERFACER_AUTH_MODE !== "fixture-controller-stub" ||
      process.env.NODE_ENV === "production") {
    res.status(403).json({ reason: "local_fixture_mode_required" })
    return false
  }
  if (origin && !DEV_GUI_ORIGINS.includes(origin)) {
    res.status(403).json({ reason: "dev_origin_denied" })
    return false
  }
  return true
}

