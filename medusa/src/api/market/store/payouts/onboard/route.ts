// Body = the signed params {country, terms_version, fee_bps, fee_fixed_cents}:
// the seller accepts the commission in force and gets a Stripe onboarding link.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import { onboardSeller } from "../../../../../modules/interfacer/settlement"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  res.json(await onboardSeller(req.scope, req.body, authFromHeader(req.headers[AUTH_HEADER])))
}
