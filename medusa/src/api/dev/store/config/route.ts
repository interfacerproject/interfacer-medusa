import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, demo } from "../../../../storefront/dev"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  // Deliberately public disposable demo login, NOT an Admin/production credential.
  res.json(demo())
}
