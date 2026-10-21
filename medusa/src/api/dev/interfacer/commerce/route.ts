// LOCAL TESTING ONLY. Explicit opt-in fixture mode; never deploy.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../local-guard"
import { seedCommerce } from "../../../../modules/interfacer/commerce-context"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.json(await seedCommerce(req.scope))
}
