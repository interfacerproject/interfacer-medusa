import { authenticate, defineMiddlewares } from "@medusajs/framework/http"
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import type { ICartModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { checkoutEvidence, refuse } from "../modules/interfacer/checkout-guard"

async function prepareCheckout(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const carts = req.scope.resolve<ICartModuleService>(Modules.CART)
    const cart = await carts.retrieveCart(req.params.id, { relations: ["items"] })
    const evidence = await checkoutEvidence(req.scope, cart)
    if (evidence) {
      if ((req as AuthenticatedMedusaRequest).auth_context?.actor_id !== evidence.customerId) refuse("interfacer_cart_customer_mismatch")
      // Written before completeCartWorkflow takes its snapshot. Native cart->order
      // conversion copies line metadata and cart metadata in Medusa 2.10.3.
      if (!cart.completed_at) {
        await carts.updateLineItems(evidence.lines.map(({ item, metadata }) => ({
          id: item.id, metadata: { ...item.metadata, ...metadata },
        })))
        await carts.updateCarts(cart.id, {
          metadata: { ...cart.metadata, interfacer_purchase: evidence.purchase },
        })
      }
    }
    next()
  } catch (error) { next(error) }
}

export default defineMiddlewares({ routes: [{
  matcher: "/store/carts/:id/complete",
  method: "POST",
  // All marketplace completion requires a real customer session/bearer. Email
  // matching in native cart creation is NOT sufficient to impersonate a buyer.
  middlewares: [authenticate("customer", ["session", "bearer"]), prepareCheckout],
}] })
