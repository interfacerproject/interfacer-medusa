import { authFromHeader, AUTH_HEADER } from "../../../modules/interfacer/signed-envelope"
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../market-guard"
import { acceptBuild } from "../../../modules/interfacer/build-purchase"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  const body = req.body as Record<string, unknown> | null
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== "cartId,quoteId" ||
      ![body.cartId, body.quoteId].every(v => typeof v === "string" && v.trim() && v.length <= 1000)) {
    res.status(400).json({ reason: "invalid_body: only cartId and quoteId accepted; no service/price overrides" })
    return
  }
  res.json(await acceptBuild(req.scope, body.cartId as string, body.quoteId as string, (req as AuthenticatedMedusaRequest).auth_context.actor_id, authFromHeader(req.headers[AUTH_HEADER])))
}
export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
