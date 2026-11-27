// Body = the seller's signed params {order_id, amount_cents, reason}.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import { refundOrder } from "../../../../../modules/interfacer/aftersale"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(201).json({ refund: await refundOrder(req.scope, req.params.id, req.body, authFromHeader(req.headers[AUTH_HEADER])) })
}
