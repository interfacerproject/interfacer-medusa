// The buyer's signed capture step, right after the order is placed, over the
// native capturePaymentWorkflow. Test provider and Stripe builds: captured now.
// Stripe stock orders: only authorized here, captured at the signed delivery.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerScene, demoOrder, strictBody } from "../../../../storefront/dev"
import { AUTH_HEADER, authFromHeader } from "../../../../modules/interfacer/signed-envelope"
import { verifyCommerceOperation } from "../../../../modules/interfacer/zenflows-person"
import { paymentSettings } from "../../../../modules/interfacer/payments"
import { captureAtCheckout } from "../../../../modules/interfacer/settlement"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  const scene = await buyerScene(req), b = strictBody(req, ["orderId"])
  const order = await demoOrder(req, scene, b.orderId)
  await verifyCommerceOperation(authFromHeader(req.headers[AUTH_HEADER]), "commerce.order.dev.capture",
    { order_id: order.id }, scene.buyer_person_id)
  const captured = await captureAtCheckout(req.scope, order.id)
  const stripe = paymentSettings().provider === "stripe"
  res.json({ order_id: order.id, captured, provider: paymentSettings().provider,
    ...(captured ? {} : { capture_at: "delivery" }),
    label: stripe ? "Stripe payment on the seller's account; capture is financial only, no VF event"
      : "LOCAL manual/test payment; capture is financial only, no VF event" })
}
