// Body = the seller's signed params {order_id, case_id, refund_cents, note}.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../../../../modules/interfacer/signed-envelope"
import { confirmReturn } from "../../../../../../../modules/interfacer/aftersale"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.json({ case: await confirmReturn(req.scope, req.params.id, req.params.case, req.body,
    authFromHeader(req.headers[AUTH_HEADER])) })
}
