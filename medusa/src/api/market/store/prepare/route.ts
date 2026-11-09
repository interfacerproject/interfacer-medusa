// Resolves canonical operation facts; does not sign or accept a caller key.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerScene, demoSigningOperation } from "../../../../storefront/dev"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  res.json(await demoSigningOperation(req, await buyerScene(req)))
}
