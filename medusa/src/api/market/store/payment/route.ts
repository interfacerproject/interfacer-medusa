// Body = {cartId}. The buyer's Stripe payment session: a PaymentIntent on the
// seller's own account with Interfacer's commission as application fee, both
// computed by the server. Returns what Stripe.js needs to confirm it.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerScene, strictBody } from "../../../../storefront/dev"
import { createMarketPaymentSession } from "../../../../modules/interfacer/settlement"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const scene = await buyerScene(req), b = strictBody(req, ["cartId"])
  res.json(await createMarketPaymentSession(req.scope, b.cartId, scene.customer_id))
}
