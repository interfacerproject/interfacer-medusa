import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../market-guard"
import { setupCheckout } from "../../../../../modules/interfacer/checkout-setup"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.json(await setupCheckout(req.scope, req.params.id, authFromHeader(req.headers[AUTH_HEADER])))
}
