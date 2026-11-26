// Body = {} signed as commerce.payouts.dashboard: a one-time link to the
// seller's own Stripe Express dashboard (bank account, payouts, tax forms).
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import { sellerDashboardLink } from "../../../../../modules/interfacer/settlement"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  res.json(await sellerDashboardLink(req.scope, req.body, authFromHeader(req.headers[AUTH_HEADER])))
}
