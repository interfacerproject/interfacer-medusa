import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, publicScene } from "../../../../storefront/dev"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  // Standalone: the deliberately public disposable demo login, NOT an Admin or
  // production credential. Live: commerce context and live listings only.
  res.json(await publicScene(req))
}
