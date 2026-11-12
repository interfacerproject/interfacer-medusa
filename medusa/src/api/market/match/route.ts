import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { matchDesign } from "../../../modules/interfacer/build-matching"
import { allowMarketRequest } from "../../market-guard"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  const body = req.body as Record<string, unknown> | null
  if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.designId !== "string" || !body.designId.trim() || body.designId.length > 1000) {
    res.status(400).json({ reason: "invalid_body: only a nonempty designId is accepted" })
    return
  }
  res.json(await matchDesign(req.scope, body.designId))
}
export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
