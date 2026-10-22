import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../../../local-guard"
import { deliverOrder } from "../../../../../../modules/interfacer/delivery"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const result = await deliverOrder(req.scope, req.params.id)
  res.status(result.created ? 201 : 200).json(result)
}
