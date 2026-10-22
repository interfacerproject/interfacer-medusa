import { authenticate, defineMiddlewares } from "@medusajs/framework/http"
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import type { ICartModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { allowLocalRequest } from "./dev/interfacer/local-guard"
import { allowStorefront } from "../storefront/dev"
import { checkoutEvidence, refuse } from "../modules/interfacer/checkout-guard"

import { authFromHeader, AUTH_HEADER, checkoutOperationParams, verifySignedOperation } from "../modules/interfacer/signed-envelope"

async function prepareCheckout(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const carts = req.scope.resolve<ICartModuleService>(Modules.CART)
    const cart = await carts.retrieveCart(req.params.id, { relations: ["items"] })
    const evidence = await checkoutEvidence(req.scope, cart)
    if (evidence) {
      if ((req as AuthenticatedMedusaRequest).auth_context?.actor_id !== evidence.customerId) refuse("interfacer_cart_customer_mismatch")
      const auth = authFromHeader(req.headers[AUTH_HEADER])
      verifySignedOperation(auth, "commerce.order.authorize", checkoutOperationParams(cart, evidence.purchase), evidence.purchase.buyer_person_id)
      // Written before completeCartWorkflow takes its snapshot. Native cart->order
      // conversion copies line metadata and cart metadata in Medusa 2.10.3.
      if (!cart.completed_at) {
        await carts.updateLineItems(evidence.lines.map(({ item, metadata }) => ({
          id: item.id, metadata: { ...item.metadata, ...metadata },
        })))
        await carts.updateCarts(cart.id, {
          metadata: { ...cart.metadata, interfacer_purchase: evidence.purchase, interfacer_authorization: auth },
        })
      }
    }
    next()
  } catch (error) { next(error) }
}

export default defineMiddlewares({ routes: [{
  matcher: "/dev/store/(sign|capture)", method: "POST",
  middlewares: [(req, res, next) => { if (allowStorefront(req, res)) next() },
    authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/dev/interfacer/build-orders", method: "POST",
  middlewares: [(req, res, next) => { if (allowLocalRequest(req, res)) next() },
    authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/store/carts/:id/complete",
  method: "POST",
  // All marketplace completion requires a real customer session/bearer. Email
  // matching in native cart creation is NOT sufficient to impersonate a buyer.
  middlewares: [authenticate("customer", ["session", "bearer"]), prepareCheckout],
}] })
