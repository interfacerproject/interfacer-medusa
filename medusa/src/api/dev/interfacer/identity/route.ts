// Explicitly enabled local resolver only; CORS is not authentication.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../local-guard"
import { bindIdentity } from "../../../../modules/interfacer/identity"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const body = req.body as { customerId?: unknown; personId?: unknown } | undefined
  res.json({ identity_link: await bindIdentity(req.scope, body?.customerId, body?.personId) })
}
