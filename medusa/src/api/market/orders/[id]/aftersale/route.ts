// The order's after-sale state for its buyer or its seller (nobody else):
// cases, refunds, what they may do now; the seller also sees the payout.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../../market-guard"
import { buyerScene } from "../../../../../storefront/dev"
import { aftersaleView } from "../../../../../modules/interfacer/aftersale"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const person = (await buyerScene(req)).buyer_person_id
  res.json(await aftersaleView(req.scope, req.params.id, person))
}
