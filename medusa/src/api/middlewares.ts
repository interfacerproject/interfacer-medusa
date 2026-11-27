import { verifyCommerceOperation } from "../modules/interfacer/zenflows-person"
import { authenticate, defineMiddlewares } from "@medusajs/framework/http"
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import type { ICartModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { allowLocalRequest } from "./dev/interfacer/local-guard"
import { allowStorefront } from "../storefront/dev"
import { checkoutEvidence, refuse } from "../modules/interfacer/checkout-guard"
import { allowMarketRequest, allowMarketStorefront, pilotProxyOnly } from "./market-guard"
import { checkoutSettlement, evidenceSeller, verifyStripePayment } from "../modules/interfacer/settlement"
import { STRIPE_PROVIDER_ID } from "../modules/interfacer/payments"

import { authFromHeader, AUTH_HEADER, checkoutOperationParams } from "../modules/interfacer/signed-envelope"

async function prepareCheckout(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const carts = req.scope.resolve<ICartModuleService>(Modules.CART)
    const cart = await carts.retrieveCart(req.params.id, { relations: ["items"] })
    const evidence = await checkoutEvidence(req.scope, cart)
    if (evidence) {
      if ((req as AuthenticatedMedusaRequest).auth_context?.actor_id !== evidence.customerId) refuse("interfacer_cart_customer_mismatch")
      const auth = authFromHeader(req.headers[AUTH_HEADER])
      await verifyCommerceOperation(auth, "commerce.order.authorize", checkoutOperationParams(cart, evidence.purchase), evidence.purchase.buyer_person_id)
      // Real payments: the seller must be able to receive the money, under the
      // commission terms they signed. Frozen on the order from here on.
      const settlement = await checkoutSettlement(req.scope, evidenceSeller(evidence as any))
      // On Stripe: authorized, on this seller's account, for this total and fee.
      if (!cart.completed_at) await verifyStripePayment(req.scope, cart.id, settlement)
      // Written before completeCartWorkflow takes its snapshot. Native cart->order
      // conversion copies line metadata and cart metadata in Medusa 2.10.3.
      if (!cart.completed_at) {
        await carts.updateLineItems(evidence.lines.map(({ item, metadata }) => ({
          id: item.id, metadata: { ...item.metadata, ...metadata },
        })))
        await carts.updateCarts(cart.id, {
          metadata: { ...cart.metadata, interfacer_purchase: evidence.purchase, interfacer_authorization: auth,
            ...(settlement ? { interfacer_settlement: settlement } : {}) },
        })
      }
    }
    next()
  } catch (error) { next(error) }
}

// Stripe sessions carry the seller's account and the commission: only the
// marketplace route (/market/store/payment) may create them, never a client.
function nativeStripeSessionRefused(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if ((req.body as { provider_id?: unknown } | undefined)?.provider_id === STRIPE_PROVIDER_ID)
    return void res.status(400).json({ type: "not_allowed", message: "use_market_payment_route" })
  next()
}

type Guard = (req: MedusaRequest, res: MedusaResponse) => boolean
const guarded = (allow: Guard) => (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
  if (allow(req, res)) next()
}
const storefront = guarded(allowMarketStorefront)

export default defineMiddlewares({ routes: [{
  // A pilot is reached only through the GUI proxy, native routes included.
  matcher: "/store/*", middlewares: [pilotProxyOnly],
}, {
  matcher: "/auth/customer/*", middlewares: [pilotProxyOnly],
}, {
  // Stripe webhooks reach a pilot through the GUI's raw-body relay only.
  matcher: "/hooks/*", middlewares: [pilotProxyOnly],
}, {
  matcher: "/store/payment-collections/:id/payment-sessions", method: "POST",
  middlewares: [nativeStripeSessionRefused],
}, {
  matcher: "/market/store/payment", method: "POST",
  middlewares: [storefront, authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/market/store/payouts", method: "GET",
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/orders/:id/aftersale", method: "GET",
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/store/(capture|prepare)", method: "POST",
  middlewares: [storefront, authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/market/store/zenflows-sync/:id/(next|sign)", method: ["GET", "POST"],
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/store/seller", method: "GET",
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/receipts", method: "GET",
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/zenflows-sync/:id/retry", method: "POST",
  middlewares: [storefront, authenticate("customer", ["bearer"])],
}, {
  matcher: "/market/build-orders", method: "POST",
  middlewares: [guarded(allowMarketRequest), authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/dev/store/(sign|capture|prepare)", method: "POST",
  middlewares: [guarded(allowStorefront),
    authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/dev/store/zenflows-sync/:id/(next|sign)", method: ["GET", "POST"],
  middlewares: [guarded(allowStorefront),
    authenticate("customer", ["bearer"])],
}, {
  matcher: "/dev/store/seller", method: "GET",
  middlewares: [guarded(allowStorefront),
    authenticate("customer", ["bearer"])],
}, {
  matcher: "/dev/interfacer/build-orders", method: "POST",
  middlewares: [guarded(allowLocalRequest),
    authenticate("customer", ["session", "bearer"])],
}, {
  matcher: "/store/carts/:id/complete",
  method: "POST",
  // All marketplace completion requires a real customer session/bearer. Email
  // matching in native cart creation is NOT sufficient to impersonate a buyer.
  middlewares: [authenticate("customer", ["session", "bearer"]), prepareCheckout],
}] })
