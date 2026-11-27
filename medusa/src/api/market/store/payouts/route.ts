// The signed-in seller's own Stripe account (live status) and the commission
// terms in force and signed. Reads only.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerScene } from "../../../../storefront/dev"
import { sellerPaymentsOverview } from "../../../../modules/interfacer/settlement"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const person = (await buyerScene(req)).buyer_person_id
  res.json(await sellerPaymentsOverview(req.scope, person))
}
