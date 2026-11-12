import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../../market-guard"
import { authFromHeader, AUTH_HEADER } from "../../../../modules/interfacer/signed-envelope"
import { createLiveListing } from "../../../../modules/interfacer/live-listing"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
// Body = the signed params {resource_id}. Every listed fact is re-read from
// Zenflows; the signer must be accountable for and custodian of the resource.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  const { created, product, binding } = await createLiveListing(req.scope, req.body, authFromHeader(req.headers[AUTH_HEADER]))
  res.status(created ? 201 : 200).json({ created, product_id: product.id, variant_id: binding.medusa_variant_id,
    status: product.status, binding })
}
