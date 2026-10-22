import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../../../local-guard"
import { produceBuild } from "../../../../../../modules/interfacer/production"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
    res.status(400).json({ reason: "invalid_body: production accepts only an empty object" })
    return
  }
  const result = await produceBuild(req.scope, req.params.id)
  res.status(result.created ? 201 : 200).json(result)
}
export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
