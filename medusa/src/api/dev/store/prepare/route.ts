// Resolves canonical operation facts; does not sign or accept a caller key.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, buyerScene, demoSigningOperation } from "../../../../storefront/dev"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  res.json(await demoSigningOperation(req, await buyerScene(req)))
}
