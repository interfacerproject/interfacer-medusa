// Body = the buyer's signed params {order_id, kind, reason}.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import { openCase } from "../../../../../modules/interfacer/aftersale"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(201).json({ case: await openCase(req.scope, req.params.id, req.body, authFromHeader(req.headers[AUTH_HEADER])) })
}
