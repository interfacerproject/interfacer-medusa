import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../modules/interfacer/signed-envelope"
import { registerCatalogEntry } from "../../../../modules/interfacer/catalog"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
// Body = the signed params {resource_id, document}; the signer must be the
// Person accountable for that Zenflows design resource.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  const result = await registerCatalogEntry(req.scope, "design", req.body, authFromHeader(req.headers[AUTH_HEADER]))
  res.status(result.created ? 201 : 200).json(result)
}
