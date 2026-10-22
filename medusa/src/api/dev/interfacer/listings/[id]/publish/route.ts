// LOCAL TESTING ONLY: this merchant price seed is never a Store API write.
import { authFromHeader, AUTH_HEADER } from "../../../../../../modules/interfacer/signed-envelope"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../../../local-guard"
import { publishListing } from "../../../../../../modules/interfacer/publish-listing"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const body = req.body as { priceEUR?: unknown } | null
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "priceEUR")) {
    res.status(400).json({ reason: "invalid_body: expected only priceEUR" })
    return
  }
  try {
    res.json(await publishListing(req.scope, req.params.id, body.priceEUR, authFromHeader(req.headers[AUTH_HEADER])))
  } catch (error) {
    const reason = error instanceof Error ? error.message : ""
    const statuses: Record<string, number> = {
      invalid_price: 400, listing_not_found: 404, reconciliation_required: 409,
      local_fixture_mode_required: 403,
    }
    const status = statuses[reason.split(":")[0]]
    if (!status) throw error
    res.status(status).json({ reason })
  }
}
