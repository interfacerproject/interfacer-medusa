// Explicit new DEV route over the REAL native capturePaymentWorkflow.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { capturePaymentWorkflow } from "@medusajs/medusa/core-flows"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerScene, demoOrder, strictBody } from "../../../../storefront/dev"
import { AUTH_HEADER, authFromHeader } from "../../../../modules/interfacer/signed-envelope"
import { verifyCommerceOperation } from "../../../../modules/interfacer/zenflows-person"
import { refuse } from "../../../../modules/interfacer/checkout-guard"
import type InterfacerService from "../../../../modules/interfacer/service"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  const scene = await buyerScene(req), b = strictBody(req, ["orderId"])
  const order = await demoOrder(req, scene, b.orderId)
  await verifyCommerceOperation(authFromHeader(req.headers[AUTH_HEADER]), "commerce.order.dev.capture",
    { order_id: order.id }, scene.buyer_person_id)
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  await integration.withProjectionLock("interfacer-dev-capture:" + order.id, async () => {
    const payments = order.payment_collections?.flatMap((c: { payments: { id: string; provider_id: string; captured_at?: string; canceled_at?: string }[] }) => c.payments ?? []) ?? []
    if (payments.length !== 1 || payments[0].provider_id !== "pp_system_default" || payments[0].canceled_at)
      refuse("demo_manual_payment_required")
    // The workflow itself handles an already captured payment idempotently.
    await capturePaymentWorkflow(req.scope).run({ input: { payment_id: payments[0].id } })
  })
  res.json({ order_id: order.id, captured: true, label: "LOCAL manual/test payment; capture is financial only, no VF event" })
}
